require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
async function main(env = process.env) {
  const mainnet = env.SOLANA_INIT_MAINNET_FRESH === 'true';
  if ((!mainnet && env.SOLANA_INIT_FRESH !== 'true') || !env.DATABASE_URL) throw new Error('Use explicit fresh initialization only for a new empty database');
  if (mainnet && (env.BOT_MODE !== 'recovery' || env.LIVE_FUNDS_ENABLED !== 'false' || env.SOLANA_CLUSTER !== 'mainnet-beta' || env.SOLANA_INIT_FRESH === 'true')) throw new Error('Mainnet initialization requires recovery mode with funds disabled');
  const client = new Client({ connectionString: env.DATABASE_URL });
  try {
    await client.connect();
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (rows.length) throw new Error('Database is not empty. Do not initialize or migrate an existing financial database with this command.');
    await client.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    await client.query('COMMIT');
    console.log(mainnet ? 'Fresh Solana mainnet schema created. Remove SOLANA_INIT_MAINNET_FRESH; keep recovery mode until launch checks pass.' : 'Fresh Solana pilot schema created. Remove SOLANA_INIT_FRESH from the environment.');
  } finally { await client.end(); }
}
if (require.main === module) main().catch(() => { console.error('Fresh database initialization failed; existing tables were not changed.'); process.exitCode = 1; });
module.exports = { main };
