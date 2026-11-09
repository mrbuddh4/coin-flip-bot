const { Pool } = require('pg');
const { connectionOptions } = require('../database/connection');
const config = require('../config');
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
    await this.pool.query('INSERT INTO "SolGames" (id, state) VALUES ($1, $2)', [game.id, JSON.stringify(game)]);
    return game;
  }
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
          await client.query('INSERT INTO "SolOutbox" (id, "gameId", payment) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [payment.id, id, JSON.stringify(payment)]);
        },
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
    return (await this.pool.query('SELECT * FROM "SolOutbox" WHERE status IN (\'PENDING\',\'SIGNED\') ORDER BY "createdAt", id LIMIT 20')).rows;
  }
  async saveSigned(id, signed) {
    const result = await this.pool.query('UPDATE "SolOutbox" SET signed=$2, status=\'SIGNED\', "lastError"=NULL WHERE id=$1 AND status=\'PENDING\' AND signed IS NULL', [id, JSON.stringify(signed)]);
    if (result.rowCount !== 1) throw new Error('Payment already signed; do not replace it');
  }
  async paymentState(id, status, error = null) {
    await this.pool.query('UPDATE "SolOutbox" SET status=$2, "lastError"=$3 WHERE id=$1', [id, status, error]);
  }
  async payments(gameId) {
    return (await this.pool.query('SELECT id, status, signed->>\'signature\' AS signature FROM "SolOutbox" WHERE "gameId"=$1 ORDER BY id', [gameId])).rows;
  }
  async saveToken(userId, token) {
    await this.pool.query('INSERT INTO "SolTokens" ("userId",mint,metadata) VALUES ($1,$2,$3) ON CONFLICT ("userId",mint) DO UPDATE SET metadata=EXCLUDED.metadata', [userId, token.address, JSON.stringify(token)]);
  }
  async tokens(userId) {
    return (await this.pool.query('SELECT metadata FROM "SolTokens" WHERE "userId"=$1 ORDER BY mint', [userId])).rows.map(r => r.metadata);
  }
}
module.exports = { SolanaStore };
