const { SID_MINT } = require('./featured');
const { SID: RH_SID } = require('../robinhood/chain');
const { DepositValidationError } = require('./errors');
const { fromUnits } = require('./amounts');

const ASSETS = {
  solana: { mint: SID_MINT, decimals: 6, name: 'Solana' },
  robinhood: { mint: RH_SID, decimals: 18, name: 'Robinhood Chain' },
};
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS "SolWrongChainActivation" (id int PRIMARY KEY CHECK(id=1), "activeSince" bigint NOT NULL);
  INSERT INTO "SolWrongChainActivation" (id, "activeSince")
    VALUES (1, floor(extract(epoch FROM clock_timestamp()))::bigint * 1000 + 1000) ON CONFLICT DO NOTHING;
`;

function requestMatches(game, player, role, amount, at, source, target) {
  const start = role === 'creator' ? game.createdAt : player?.joinedAt;
  const end = Math.min(player?.depositExpiresAt ?? game.expiresAt, player?.depositWindowClosedAt ?? Infinity);
  const wager = BigInt(game.wager ?? 0);
  return Boolean(player?.wallet && Number.isSafeInteger(start) && Number.isSafeInteger(end) && at >= start && at < end &&
    wager > 0n && BigInt(amount) * 10n ** BigInt(target.decimals) === wager * 10n ** BigInt(source.decimals));
}

class WrongChainRefunds {
  constructor(sourceService, targetService, sourceKey) {
    this.service = sourceService;
    this.targetService = targetService;
    this.sourceKey = sourceKey;
    this.targetKey = sourceKey === 'solana' ? 'robinhood' : 'solana';
    this.source = ASSETS[sourceKey];
    this.target = ASSETS[this.targetKey];
    // Only startup-selected schemas; never interpolate user input.
    this.schema = sourceKey === 'solana' ? 'coinflip_robinhood' : 'public';
  }

  async windows(db, sender, at) {
    // Look for the same Telegram user in both ledgers, with the actual
    // sending wallet registered on the chain that received the transfer.
    return (await db.query(`
      SELECT p.data->>'wallet' AS address, g.state, v.role, v.player
      FROM ${this.schema}."SolGames" g
      CROSS JOIN LATERAL (VALUES ('creator',g.state->'creator'),('challenger',g.state->'challenger')) v(role,player)
      JOIN "SolProfiles" p ON p."userId"=v.player->>'userId'
      CROSS JOIN "SolWrongChainActivation" a
      WHERE a.id=1 AND g.state->'token'->>'address'=$1
        AND g.state->'token'->>'decimals'=$2 AND g.state->>'depositAddress'=$3
        AND (v.player->>'depositExpiresAt')::bigint >= GREATEST($4,a."activeSince")
        AND v.player->>'wallet' IS NOT NULL AND p.data->>'wallet' IS NOT NULL
        AND p.data->>'wallet'<>$5 AND ($6::text IS NULL OR p.data->>'wallet'=$6)
        AND NOT EXISTS (SELECT 1 FROM "SolProfiles" other
          WHERE other."userId"<>p."userId" AND other.data->>'wallet'=p.data->>'wallet')
      ORDER BY (g.state->>'createdAt')::bigint DESC`,
    [this.target.mint, String(this.target.decimals), this.targetService.chain.address, at, this.service.chain.address, sender])).rows;
  }

  async requests(now = Date.now()) {
    // Bound replay around recent game windows, including games that expired
    // during a restart or while the receipt waited for chain confirmation.
    const rows = await this.windows(this.service.store.pool, null, now - 24 * 60 * 60000);
    const requests = new Map();
    for (const { address, role, player, state } of rows) {
      const start = role === 'creator' ? state.createdAt : player.joinedAt;
      if (!Number.isSafeInteger(start)) continue;
      const open = state.status === 'OPEN' && !player.deposit && now < player.depositExpiresAt;
      const existing = requests.get(address);
      requests.set(address, { address, replayFrom: Math.min(existing?.replayFrom ?? Infinity, start), open: open || existing?.open || false });
    }
    return [...requests.values()];
  }

  async match(db, { sender, amount, at }) {
    const active = (await db.query('SELECT "activeSince" FROM "SolWrongChainActivation" WHERE id=1')).rows[0];
    if (!active || at < Number(active.activeSince)) return null;
    const rows = await this.windows(db, sender, at);
    const matches = rows.filter(({ state, player, role }) => requestMatches(state, player, role, amount, at, this.source, this.target));
    return matches.length === 1 ? matches[0] : null;
  }

  async recover({ sender, mint, signature, amount, transaction }) {
    const at = transaction?.blockTime * 1000;
    if (mint !== this.source.mint || !Number.isSafeInteger(at) || at > Date.now() || !/^[1-9]\d*$/.test(String(amount))) return false;
    const { store, chain } = this.service;
    const input = { sender, mint, amount, at };
    if (!await this.match(store.pool, input)) return false;
    // Normal or nearby same-chain requests keep their existing recovery path.
    if ((await store.refundCandidates(input)).length) return false;
    let proved;
    try { proved = await chain.verifyDeposit({ signature, sender, mint, transaction, allowNoMemo: true }); }
    catch (error) { if (error instanceof DepositValidationError) return false; throw error; }
    if (proved !== BigInt(amount)) return false;

    const db = await store.pool.connect();
    try {
      await db.query('BEGIN');
      const match = await this.match(db, input);
      if (!match || (await store.refundCandidates(input, db)).length) {
        await db.query('COMMIT');
        return false;
      }
      const userId = match.player.userId, gameId = 'wrong-chain:' + signature;
      const anchor = { id: gameId, status: 'REFUND_ONLY', depositAddress: chain.address, token: {
        address: mint, decimals: this.source.decimals, symbol: 'SID',
      } };
      await db.query('INSERT INTO "SolGames" (id,state) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gameId, JSON.stringify(anchor)]);
      const receipt = await db.query(`INSERT INTO "SolDeposits" (signature,"gameId","userId",amount)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING signature`, [signature, gameId, userId, String(amount)]);
      if (receipt.rowCount !== 1) {
        await db.query('ROLLBACK');
        return false;
      }
      const payment = { id: 'refund:' + signature, gameId, kind: 'refund', recipient: sender, sourceWallet: chain.address,
        mint, amount: String(amount), wrongChain: { userId, gameId: match.state.id, signature } };
      await db.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3)', [payment.id, gameId, JSON.stringify(payment)]);
      await db.query('COMMIT');
      return true;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async notify(telegram) {
    if (this.notifying) return;
    this.notifying = true;
    try {
      const { pool } = this.service.store;
      const { rows } = await pool.query(`SELECT id, payment, status, signed->>'signature' AS signature FROM "SolOutbox"
        WHERE payment ? 'wrongChain' AND NOT (payment->'wrongChain' ? 'notifiedAt')
        AND COALESCE((payment->'wrongChain'->>'noticeRetryAfter')::timestamptz, '-infinity') <= now()
        ORDER BY "createdAt" LIMIT 10`);
      for (const row of rows) {
        const { userId, gameId } = row.payment.wrongChain;
        try {
          const game = await this.targetService.store.get(gameId);
          const player = [game.creator, game.challenger].find(p => p?.userId === userId);
          const open = game.status === 'OPEN' && player && !player.deposit && Date.now() < (player.depositExpiresAt ?? game.expiresAt);
          const refund = row.status === 'CONFIRMED' ? 'The refund was confirmed.' : row.status === 'REVIEW' ?
            'The refund needs review.' : 'A refund to the sending wallet is queued.';
          const amount = fromUnits(row.payment.amount, this.source.decimals);
          const link = row.status === 'CONFIRMED' && row.signature ? '\n' + (this.sourceKey === 'solana' ?
            'https://explorer.solana.com/tx/' + row.signature : this.service.chain.explorer(row.signature)) : '';
          await telegram.sendMessage(userId, `Your ${amount} SID arrived on ${this.source.name}. ${refund}${link}\n` +
            (open ? `Open the original deposit card and send on ${this.target.name} using the address shown there.` :
              `This deposit request is closed. Use ${this.target.name} for a new flip on that chain.`));
          await pool.query(`UPDATE "SolOutbox" SET payment=jsonb_set(payment,'{wrongChain,notifiedAt}',to_jsonb(now())) WHERE id=$1`, [row.id]);
        } catch (_) {
          await pool.query(`UPDATE "SolOutbox" SET payment=jsonb_set(payment,'{wrongChain,noticeRetryAfter}',to_jsonb(now() + interval '5 minutes')) WHERE id=$1`, [row.id]);
          console.error('WRONG_CHAIN_NOTICE_RETRY: refund retained.');
        }
      }
    } finally { this.notifying = false; }
  }
}

module.exports = { WrongChainRefunds, SCHEMA, requestMatches };
