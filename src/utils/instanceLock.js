const { Client } = require('pg');
const { connectionOptions } = require('../database/connection');

async function acquireInstanceLock({
  client = new Client({ ...connectionOptions(), connectionTimeoutMillis: 10000 }),
  onLost = () => process.exit(1),
} = {}) {
  // Advisory locks belong to a session. Never return this connection to a pool.
  let closed = false;
  client.on('error', () => { if (!closed) onLost(); });
  client.on('end', () => { if (!closed) onLost(); });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [42424242]);
    if (!rows[0]?.acquired) throw new Error('Another bot instance holds the database lock');
  } catch (error) {
    closed = true;
    await client.end().catch(() => {});
    throw error;
  }
  return async () => {
    closed = true;
    // Closing this dedicated session releases its lock, including on SIGKILL.
    await client.end();
  };
}

module.exports = { acquireInstanceLock };
