require('dotenv').config();

// Railway's pre-deploy step lets phone-only owners initialize an empty test DB
// without a shell. Default deployment never connects to a database or a wallet.
async function main(env = process.env, dependencies = {}) {
  if (env.SOLANA_INIT_FRESH !== 'true') return { initialized: false };
  if (env.BOT_CHAIN !== 'solana' || env.SOLANA_CLUSTER !== 'devnet' || !env.DATABASE_URL || !env.SOLANA_RPC_URL) {
    throw new Error('Fresh initialization requires explicit Solana devnet settings and DATABASE_URL');
  }
  const verifyDevnet = dependencies.verifyDevnet || (async () => {
    const { Connection } = require('@solana/web3.js');
    const { DEVNET_GENESIS } = require('../src/solana/chain');
    const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'finalized', fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(20000) }), disableRetryOnRateLimit: true });
    if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('RPC is not Solana devnet');
  });
  await verifyDevnet();
  const initialize = dependencies.initialize || require('./solana-init').main;
  await initialize(env);
  return { initialized: true };
}
if (require.main === module) main().then(result => {
  console.log(result.initialized ? 'Fresh devnet database initialized. Set SOLANA_INIT_FRESH=false before the next deployment.' : 'No fresh database initialization requested.');
}).catch(() => {
  console.error('Pre-deploy initialization stopped. Check devnet settings and use only an empty test database. Existing data was not reset.');
  process.exitCode = 1;
});
module.exports = { main };
