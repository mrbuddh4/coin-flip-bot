const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { SolanaStore } = require('../solana/store');
const { MAXIMUM } = require('./chain');
const SCHEMA = 'coinflip_robinhood';
function createPool(url = process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}`, max: 5, connectionTimeoutMillis: 10000 });
  pool.coinflipMaximum = MAXIMUM;
  pool.on('connect', client => { client.coinflipMaximum = MAXIMUM; });
  return pool;
}
async function initialize(admin) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [42424246]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET LOCAL search_path=${SCHEMA}`);
    // Isolated additive tables. No Solana/Paxeer records are migrated or reset.
    const sql = fs.readFileSync(path.join(__dirname, '../solana/schema.sql'), 'utf8').replace('numeric(20,0)', 'numeric(78,0)');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
class RobinhoodStore extends SolanaStore {
  async prepareInterface() {
    await super.prepareInterface();
    await this.pool.query('ALTER TABLE "SolFeeAccruals" ALTER COLUMN holder TYPE numeric(78,0), ALTER COLUMN burn TYPE numeric(78,0)');
    await this.pool.query('CREATE TABLE IF NOT EXISTS "RhProofs" (signature text PRIMARY KEY, block bigint NOT NULL, hash text NOT NULL, finalized boolean NOT NULL DEFAULT false)');
    await this.pool.query('CREATE TABLE IF NOT EXISTS "RhSafety" (id integer PRIMARY KEY CHECK(id=1), reason text NOT NULL)');
    await this.pool.query('CREATE TABLE IF NOT EXISTS "RhScanState" (id integer PRIMARY KEY CHECK(id=1), block bigint NOT NULL, hash text NOT NULL)');
  }
  async freeze(reason) { await this.pool.query('INSERT INTO "RhSafety" (id,reason) VALUES (1,$1) ON CONFLICT(id) DO NOTHING', [reason]); }
  async assertHealthy() { if ((await this.pool.query('SELECT 1 FROM "RhSafety" WHERE id=1')).rowCount) throw new Error('ROBINHOOD_HISTORY_REVIEW: confirmed history changed; reconcile before payments'); }
  async recordProof(signature, block) {
    const inserted = await this.pool.query('INSERT INTO "RhProofs" (signature,block,hash) VALUES ($1,$2,$3) ON CONFLICT(signature) DO UPDATE SET signature=EXCLUDED.signature WHERE "RhProofs".hash=EXCLUDED.hash AND "RhProofs".block=EXCLUDED.block RETURNING signature', [signature, BigInt(block.number).toString(), block.hash]);
    if (!inserted.rowCount) { await this.freeze('Previously confirmed transaction moved to another block'); throw new Error('ROBINHOOD_HISTORY_REVIEW'); }
  }
  async setInvitePeer(id, peer) { await this.pool.query('CREATE TABLE IF NOT EXISTS "RhInvites" (id text PRIMARY KEY, peer text NOT NULL)'); await this.pool.query('INSERT INTO "RhInvites" (id,peer) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, peer]); }
  async invitePeer(id) { return (await this.pool.query('SELECT peer FROM "RhInvites" WHERE id=$1', [id])).rows[0]?.peer; }
  async scanState() { return (await this.pool.query('SELECT block::text,hash FROM "RhScanState" WHERE id=1')).rows[0]; }
  async saveScanState(block, hash) { await this.pool.query('INSERT INTO "RhScanState" (id,block,hash) VALUES (1,$1,$2) ON CONFLICT(id) DO UPDATE SET block=EXCLUDED.block,hash=EXCLUDED.hash', [String(block), hash]); }
}
module.exports = { RobinhoodStore, createPool, initialize, SCHEMA };
