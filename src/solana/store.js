const { Pool } = require('pg');
const { ChallengeBusyError } = require('./errors');
// Keep the group's slot until the previous result is shown and its video is
// cleaned up. Economic settlement alone must not allow overlapping flips.
const ACTIVE_GROUP = `state->>'chatId'=$1 AND (state->>'status'='OPEN' OR
  (state->>'status'='SETTLED' AND state ? 'interfaceVersion' AND
   (COALESCE(state->'ui'->>'resultAnnounced','false')<>'true' AND COALESCE(state->'ui'->>'terminal','false')<>'true'
    OR COALESCE(state->'ui'->>'videoCleanupPending','false')='true'))) `;
const { connectionOptions } = require('../database/connection');
const config = require('../config');
const { accrueFees, SCHEMA: FEE_SCHEMA } = require('./fees');
const custody = require('./custody');
const { noMemoCandidates, refundCandidates } = require('./depositMatch');
const { SCHEMA: NOTIFICATION_SCHEMA } = require('./notifications');
async function findNoMemoCandidates(client, input, matcher = noMemoCandidates) {
  // Only refund lookup may ignore wager size. Funding keeps exact amount SQL
  // and the strict historical matcher, independently of refund recovery.
  const refundsOnly = matcher === refundCandidates;
  const { rows } = await client.query(`SELECT state FROM "SolGames" WHERE state->'token'->>'address'=$1 ${refundsOnly ? '' : "AND state->>'wager'=$3"} AND (state->'creator'->>'wallet'=$2 OR state->'challenger'->>'wallet'=$2)`, refundsOnly ? [input.mint, input.sender] : [input.mint, input.sender, String(input.amount)]);
  return matcher(rows.map(r => r.state), input);
}
class SolanaStore {
  constructor(pool = new Pool(connectionOptions(config.database))) { this.pool = pool; }
  async verifySchema() {
    // Explicit column checks, with no CREATE/ALTER on runtime startup.
    await this.pool.query('SELECT id, state FROM "SolGames" LIMIT 0');
    await this.pool.query('SELECT signature, "gameId", "userId", amount FROM "SolDeposits" LIMIT 0');
    await this.pool.query('SELECT id, "gameId", payment, status, signed, "lastError" FROM "SolOutbox" LIMIT 0');
    await this.pool.query('SELECT "userId", mint, metadata FROM "SolTokens" LIMIT 0');
  }
  async create(game) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (game.interfaceVersion) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sol-group:${game.chatId}`]);
        const existing = await client.query(`SELECT id FROM "SolGames" WHERE ${ACTIVE_GROUP} AND id<>$2`, [game.chatId, game.id]);
        if (existing.rowCount) throw new ChallengeBusyError();
      }
      await client.query('INSERT INTO "SolGames" (id, state) VALUES ($1, $2) ON CONFLICT DO NOTHING', [game.id, JSON.stringify(game)]);
      const result = await client.query('SELECT state FROM "SolGames" WHERE id=$1', [game.id]);
      if (result.rows[0].state.creator.userId !== game.creator.userId) throw new Error('Game identity conflict');
      await client.query('COMMIT');
      return result.rows[0].state;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async activeGroup(chatId) {
    const { rows } = await this.pool.query(`SELECT state FROM "SolGames" WHERE ${ACTIVE_GROUP} ORDER BY "createdAt" LIMIT 1`, [String(chatId)]);
    return rows[0]?.state || null;
  }
  async noMemoCandidates(input) { return findNoMemoCandidates(this.pool, input); }
  async refundCandidates(input) { return findNoMemoCandidates(this.pool, input, refundCandidates); }
  async get(id) {
    const { rows } = await this.pool.query('SELECT state FROM "SolGames" WHERE id=$1', [id]);
    if (!rows.length) throw new Error('Unknown Solana game');
    return rows[0].state;
  }
  async mutate(id, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT state FROM "SolGames" WHERE id=$1 FOR UPDATE', [id]);
      if (!rows.length) throw new Error('Unknown Solana game');
      const game = rows[0].state;
      const transaction = {
        consume: async (signature, userId, amount) => {
          const result = await client.query('INSERT INTO "SolDeposits" (signature, "gameId", "userId", amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING signature', [signature, id, userId, amount]);
          return result.rowCount === 1;
        },
        enqueue: async payment => {
          if (game.interfaceVersion) { game.ui ||= {}; game.ui.terminal = false; }
          await client.query('INSERT INTO "SolOutbox" (id, "gameId", payment) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [payment.id, id, JSON.stringify(payment)]);
        },
        accrueFees: (game, split) => accrueFees(client, game, split),
        noMemoCandidates: input => findNoMemoCandidates(client, input),
        refundCandidates: input => findNoMemoCandidates(client, input, refundCandidates),
      };
      await fn(game, transaction);
      await client.query('UPDATE "SolGames" SET state=$2 WHERE id=$1', [id, JSON.stringify(game)]);
      await client.query('COMMIT');
      return game;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async unfinished() {
    return (await this.pool.query('SELECT id, state FROM "SolGames" WHERE state->>\'status\' = \'OPEN\'')).rows;
  }
  async pendingPayments() {
    return (await this.pool.query('SELECT * FROM "SolOutbox" WHERE status IN (\'PENDING\',\'SIGNED\') ORDER BY (signed IS NOT NULL) DESC, "createdAt", id LIMIT 20')).rows;
  }
  async liabilities() {
    // One statement gives one MVCC snapshot while deposits/results move between
    // open games, pools and the outbox in concurrent transactions.
    const { rows } = await this.pool.query(`SELECT mint,SUM(amount)::text AS amount FROM (
      SELECT payment->>'mint' AS mint,(payment->>'amount')::numeric AS amount FROM "SolOutbox" WHERE status<>'CONFIRMED'
      UNION ALL SELECT mint,amount FROM "SolFeePools"
      UNION ALL SELECT state->'token'->>'address',(state->'creator'->'deposit'->>'amount')::numeric FROM "SolGames" WHERE state->>'status'='OPEN' AND state->'creator' ? 'deposit'
      UNION ALL SELECT state->'token'->>'address',(state->'challenger'->'deposit'->>'amount')::numeric FROM "SolGames" WHERE state->>'status'='OPEN' AND state->'challenger' ? 'deposit'
    ) obligations GROUP BY mint ORDER BY mint`);
    return rows;
  }
  async saveSigned(id, signed) {
    const result = await this.pool.query('UPDATE "SolOutbox" SET signed=$2, status=\'SIGNED\', "lastError"=NULL WHERE id=$1 AND status=\'PENDING\' AND signed IS NULL', [id, JSON.stringify(signed)]);
    if (result.rowCount !== 1) throw new Error('Payment already signed; do not replace it');
  }
  async paymentState(id, status, error = null) {
    if (status === 'CONFIRMED') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('UPDATE "SolOutbox" SET status=\'CONFIRMED\', "lastError"=NULL WHERE id=$1 AND status<>\'CONFIRMED\' RETURNING payment', [id]);
        if (result.rowCount) await custody.confirmReserve(client, result.rows[0].payment);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      return;
    }
    await this.pool.query('UPDATE "SolOutbox" SET status=$2, "lastError"=$3 WHERE id=$1 AND (status<>\'CONFIRMED\' OR $2=\'CONFIRMED\')', [id, status, error]);
  }
  async bindHolderWallet(wallet) { await custody.bindHolderWallet(this.pool, wallet); }
  async queueHolderReserves(treasury) { await custody.queueRetainedPools(this.pool, treasury); }
  async holderCustody() { return custody.custodyState(this.pool); }
  async payments(gameId) {
    return (await this.pool.query('SELECT id, status, payment, signed->>\'signature\' AS signature FROM "SolOutbox" WHERE "gameId"=$1 AND payment->>\'kind\'<>\'holder\' ORDER BY id', [gameId])).rows;
  }
  async saveToken(userId, token) {
    await this.pool.query('INSERT INTO "SolTokens" ("userId",mint,metadata) VALUES ($1,$2,$3) ON CONFLICT ("userId",mint) DO UPDATE SET metadata=EXCLUDED.metadata', [userId, token.address, JSON.stringify(token)]);
  }
  async tokens(userId) {
    return (await this.pool.query('SELECT metadata FROM "SolTokens" WHERE "userId"=$1 ORDER BY mint', [userId])).rows.map(r => r.metadata);
  }
  async prepareInterface() {
    // Additive UI, scanner and fee tables. No existing financial rows are reset.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "SolMediaCache" (id text PRIMARY KEY, data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS "SolProfiles" ("userId" text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS "SolSessions" ("userId" text PRIMARY KEY, data jsonb NOT NULL, "expiresAt" timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS "SolDrafts" (id text PRIMARY KEY, "userId" text NOT NULL, "chatId" text NOT NULL, "expiresAt" timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS "SolScanCursors" (address text PRIMARY KEY, signature text NOT NULL);
      CREATE TABLE IF NOT EXISTS "SolDepositReviews" (signature text PRIMARY KEY, "gameId" text NOT NULL, reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS "SolScanReviews" (signature text PRIMARY KEY, address text NOT NULL, reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
    `);
    await this.pool.query('ALTER TABLE "SolDrafts" ADD COLUMN IF NOT EXISTS "messageId" bigint');
    await this.pool.query(FEE_SCHEMA);
    await this.pool.query(NOTIFICATION_SCHEMA);
  }
  async media(id) { return (await this.pool.query('SELECT data FROM "SolMediaCache" WHERE id=$1', [id])).rows[0]?.data; }
  async saveMedia(id, data) { await this.pool.query('INSERT INTO "SolMediaCache" (id,data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [id, JSON.stringify(data)]); }
  async profile(userId) {
    const { rows } = await this.pool.query('SELECT data FROM "SolProfiles" WHERE "userId"=$1', [String(userId)]);
    return rows[0]?.data || {};
  }
  async updateProfile(userId, fields) {
    await this.pool.query('INSERT INTO "SolProfiles" ("userId",data) VALUES ($1,$2) ON CONFLICT ("userId") DO UPDATE SET data="SolProfiles".data || EXCLUDED.data', [String(userId), JSON.stringify(fields)]);
  }
  async session(userId) {
    const { rows } = await this.pool.query('SELECT data FROM "SolSessions" WHERE "userId"=$1 AND "expiresAt">now()', [String(userId)]);
    return rows[0]?.data || null;
  }
  async setSession(userId, data) {
    await this.pool.query('INSERT INTO "SolSessions" ("userId",data,"expiresAt") VALUES ($1,$2,now()+interval \'15 minutes\') ON CONFLICT ("userId") DO UPDATE SET data=EXCLUDED.data, "expiresAt"=EXCLUDED."expiresAt"', [String(userId), JSON.stringify(data)]);
  }
  async clearSession(userId) { await this.pool.query('DELETE FROM "SolSessions" WHERE "userId"=$1', [String(userId)]); }
  async draft(id, userId, chatId) {
    if (chatId) await this.pool.query('INSERT INTO "SolDrafts" (id,"userId","chatId","expiresAt") VALUES ($1,$2,$3,now()+interval \'5 minutes\')', [id, String(userId), String(chatId)]);
    const { rows } = await this.pool.query('SELECT * FROM "SolDrafts" WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()', [id, String(userId)]);
    if (!rows.length) throw new Error('This start button expired or belongs to another player');
    return rows[0];
  }
  async draftMessage(id, messageId) { await this.pool.query('UPDATE "SolDrafts" SET "messageId"=$2 WHERE id=$1', [id, messageId]); }
  async usedDraftCards() {
    return (await this.pool.query(`SELECT d.* FROM "SolDrafts" d WHERE d."messageId" IS NOT NULL AND
      (d."expiresAt"<now() OR EXISTS(SELECT 1 FROM "SolSessions" s WHERE s.data->>'draftId'=d.id OR s.data->'resume'->>'draftId'=d.id)
      OR EXISTS(SELECT 1 FROM "SolGames" g WHERE g.id=d.id)) LIMIT 20`)).rows;
  }
  async gameScreens() { return (await this.pool.query(`SELECT "userId" FROM "SolProfiles" WHERE data->'privateScreen'->>'gameId' IS NOT NULL`)).rows; }
  async removeToken(userId, mint) { await this.pool.query('DELETE FROM "SolTokens" WHERE "userId"=$1 AND mint=$2', [String(userId), mint]); }
  async history(userId, limit = 100) {
    const { rows } = await this.pool.query('SELECT state FROM "SolGames" WHERE state->\'creator\'->>\'userId\'=$1 OR state->\'challenger\'->>\'userId\'=$1 ORDER BY "createdAt" DESC LIMIT $2', [String(userId), limit]);
    return rows.map(r => r.state);
  }
  async groupGames() { return (await this.pool.query('SELECT state FROM "SolGames" WHERE state ? \'interfaceVersion\' AND (COALESCE(state->\'ui\'->>\'terminal\',\'false\')<>\'true\' OR COALESCE(state->\'ui\'->>\'compactVersion\',\'0\')<>\'1\') ORDER BY "createdAt"')).rows.map(r => r.state); }
  async allResults() { return (await this.pool.query('SELECT state FROM "SolGames" WHERE state->>\'status\'=\'SETTLED\'')).rows.map(r => r.state); }
  async watchedAddresses() {
    return (await this.pool.query('SELECT DISTINCT state->\'creator\'->>\'wallet\' AS address FROM "SolGames" UNION SELECT DISTINCT state->\'challenger\'->>\'wallet\' AS address FROM "SolGames" WHERE state->\'challenger\' IS NOT NULL')).rows.map(r => r.address).filter(Boolean);
  }
  async depositRecoveryRequests() {
    // Persisted requests, rather than UI state, also recover skipped receipts
    // after navigating away or deploying a scanner fix. Recent terminal games
    // stay eligible, including cards previously marked fully delivered.
    const { rows } = await this.pool.query(`SELECT state FROM "SolGames" WHERE state->>'status'='OPEN' OR (state->>'expiresAt')::bigint >= $1 ORDER BY (state->>'createdAt')::bigint DESC`, [Date.now() - 24 * 60 * 60000]);
    const requests = new Map();
    for (const { state: g } of rows) for (const p of [g.creator, g.challenger]) {
      if (!p?.wallet) continue;
      requests.set(p.wallet, Math.min(requests.get(p.wallet) ?? Infinity, g.createdAt));
    }
    return [...requests].map(([address, replayFrom]) => ({ address, replayFrom }));
  }
  async cursor(address) { return (await this.pool.query('SELECT signature FROM "SolScanCursors" WHERE address=$1', [address])).rows[0]?.signature; }
  async setCursor(address, signature) { await this.pool.query('INSERT INTO "SolScanCursors" (address,signature) VALUES ($1,$2) ON CONFLICT (address) DO UPDATE SET signature=EXCLUDED.signature', [address, signature]); }
  async firstGameTime(address) {
    return Number((await this.pool.query('SELECT MIN((state->>\'createdAt\')::bigint) AS time FROM "SolGames" WHERE state->\'creator\'->>\'wallet\'=$1 OR state->\'challenger\'->>\'wallet\'=$1', [address])).rows[0]?.time || Date.now());
  }
  async reviewDeposit(signature, gameId, reason) { await this.pool.query('INSERT INTO "SolDepositReviews" (signature,"gameId",reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [signature, gameId, reason]); }
  async scanReview(signature) { return (await this.pool.query('SELECT signature,address,reason FROM "SolScanReviews" WHERE signature=$1', [signature])).rows[0]; }
  async reviewScan(signature, address, reason) { await this.pool.query('INSERT INTO "SolScanReviews" (signature,address,reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [signature, address, reason]); }
  async bindNetwork(genesis, wallet) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [42424243]);
      await client.query('CREATE TABLE IF NOT EXISTS "SolNetwork" (id integer PRIMARY KEY CHECK (id=1), genesis text NOT NULL, wallet text NOT NULL)');
      const { rows } = await client.query('SELECT genesis,wallet FROM "SolNetwork" WHERE id=1 FOR UPDATE');
      const occupied = (await client.query('SELECT (EXISTS(SELECT 1 FROM "SolGames") OR EXISTS(SELECT 1 FROM "SolTokens")) AS occupied')).rows[0].occupied;
      if (rows[0] && (rows[0].genesis !== genesis || rows[0].wallet !== wallet) && occupied) throw new Error('LEDGER_NETWORK: Existing records belong to another network or wallet; use a separate database.');
      if (!rows[0] && occupied) {
        // Every pre-binding released Solana build was devnet-only. Never
        // relabel those records as mainnet or move their signing identity.
        const { DEVNET_GENESIS } = require('./chain');
        const wrongWallet = (await client.query('SELECT 1 FROM "SolGames" WHERE state->>\'depositAddress\'<>$1 LIMIT 1', [wallet])).rowCount;
        if (genesis !== DEVNET_GENESIS || wrongWallet) throw new Error('LEDGER_NETWORK: Unbound existing devnet records need separate mainnet storage.');
      }
      await client.query('INSERT INTO "SolNetwork" (id,genesis,wallet) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET genesis=EXCLUDED.genesis,wallet=EXCLUDED.wallet', [genesis, wallet]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
module.exports = { SolanaStore };
