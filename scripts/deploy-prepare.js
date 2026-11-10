require('dotenv').config();

// Railway's pre-deploy step lets phone-only owners initialize an empty test DB
// without a shell. Default deployment never connects to a database or a wallet.
async function main(env = process.env, dependencies = {}) {
  const mainnet = env.SOLANA_INIT_MAINNET_FRESH === 'true';
  if (env.SOLANA_INIT_FRESH !== 'true' && !mainnet) return { initialized: false };
  if (mainnet) return initializeMainnet(env, dependencies);
  const invalidSettings = [];
  if (env.BOT_CHAIN !== 'solana') invalidSettings.push('BOT_CHAIN');
  if (env.SOLANA_CLUSTER !== 'devnet') invalidSettings.push('SOLANA_CLUSTER');
  if (!env.DATABASE_URL) invalidSettings.push('DATABASE_URL');
  if (!env.SOLANA_RPC_URL) invalidSettings.push('SOLANA_RPC_URL');
  if (invalidSettings.length) {
    const error = new Error('Fresh initialization requires explicit Solana devnet settings and DATABASE_URL');
    error.initStage = 'configuration';
    error.invalidSettings = invalidSettings;
    throw error;
  }
  const verifyDevnet = dependencies.verifyDevnet || (async () => {
    const { Connection } = require('@solana/web3.js');
    const { DEVNET_GENESIS } = require('../src/solana/chain');
    const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'finalized', fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(20000) }), disableRetryOnRateLimit: true });
    if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('RPC is not Solana devnet');
  });
  try { await verifyDevnet(); }
  catch (error) { error.initStage = 'rpc'; throw error; }
  try {
    const initialize = dependencies.initialize || require('./solana-init').main;
    await initialize(env);
  } catch (error) { error.initStage = 'database'; throw error; }
  return { initialized: true };
}

async function initializeMainnet(env, dependencies) {
  const invalidSettings = [];
  for (const [key, expected] of Object.entries({ BOT_CHAIN: 'solana', SOLANA_CLUSTER: 'mainnet-beta', BOT_MODE: 'recovery', LIVE_FUNDS_ENABLED: 'false' })) if (env[key] !== expected) invalidSettings.push(key);
  if (env.SOLANA_INIT_FRESH === 'true') invalidSettings.push('SOLANA_INIT_FRESH');
  for (const key of ['DATABASE_URL', 'SOLANA_RPC_URL', 'SOLANA_WALLET_ADDRESS']) if (!env[key]) invalidSettings.push(key);
  if (invalidSettings.length) throw Object.assign(new Error('Mainnet initialization requires a separate empty database and explicit recovery settings'), { initStage: 'mainnet-configuration', invalidSettings });
  try {
    const verify = dependencies.verifyMainnet || (async () => {
      const { Connection } = require('@solana/web3.js');
      const { publicKey } = require('../src/solana/chain');
      const { network } = require('../src/solana/network');
      publicKey(env.SOLANA_WALLET_ADDRESS);
      const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'finalized', fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }), disableRetryOnRateLimit: true });
      if (await connection.getGenesisHash() !== network(env).genesis) throw new Error('RPC is not Solana mainnet');
    });
    await verify();
  } catch (e) { e.initStage = 'mainnet-rpc'; throw e; }
  try { await (dependencies.initialize || require('./solana-init').main)(env); }
  catch (e) { e.initStage = 'database'; throw e; }
  return { initialized: true, mainnet: true };
}

// Never print raw errors, URLs, connection strings or stack traces: providers
// can include credentials in them. Only fixed categories and variable NAMES.
function formatFailure(error) {
  if (error.initStage === 'mainnet-configuration') return 'SETUP_MAINNET_CONFIG: Fresh mainnet setup requires BOT_CHAIN=solana, SOLANA_CLUSTER=mainnet-beta, BOT_MODE=recovery, LIVE_FUNDS_ENABLED=false, SOLANA_INIT_FRESH=false and a new empty DATABASE_URL, SOLANA_RPC_URL and public SOLANA_WALLET_ADDRESS. No funds are enabled.';
  if (error.initStage === 'mainnet-rpc') return 'SETUP_MAINNET_RPC: Could not verify the mainnet RPC and public wallet. No database initialization attempted.';
  if (error.initStage === 'configuration') {
    const names = (error.invalidSettings || []).filter(name => ['BOT_CHAIN', 'SOLANA_CLUSTER', 'DATABASE_URL', 'SOLANA_RPC_URL'].includes(name));
    return `SETUP_CONFIG: Check these missing/incorrect variables: ${names.join(', ')}. BOT_CHAIN must be solana and SOLANA_CLUSTER must be devnet.`;
  }
  if (error.initStage === 'rpc') {
    return error.message === 'RPC is not Solana devnet'
      ? 'SETUP_RPC_NETWORK: The RPC is not Solana devnet. No database setup was attempted.'
      : 'SETUP_RPC_CONNECTION: Could not verify Solana devnet. Check SOLANA_RPC_URL and RPC connectivity. No database setup was attempted.';
  }
  if (error.initStage === 'database') {
    if ((error.message || '').startsWith('Database is not empty')) return 'SETUP_DB_NOT_EMPTY: Database already contains tables. Existing data was not reset. Check the intended test database before disabling SOLANA_INIT_FRESH.';
    const categories = {
      ENOTFOUND: 'SETUP_DB_DNS: Database hostname could not be resolved. Check the Postgres DATABASE_URL reference.',
      EAI_AGAIN: 'SETUP_DB_DNS: Database hostname lookup temporarily failed. Check private networking.',
      ECONNREFUSED: 'SETUP_DB_CONNECTION: Database connection was refused. Check that Postgres is running and DATABASE_URL references it.',
      ETIMEDOUT: 'SETUP_DB_CONNECTION: Database connection timed out. Check Postgres and private networking.',
      '28P01': 'SETUP_DB_AUTH: Postgres rejected authentication. Use the current Postgres DATABASE_URL reference.',
      '3D000': 'SETUP_DB_NAME: The selected database does not exist. Check the Postgres DATABASE_URL reference.',
      '42501': 'SETUP_DB_PERMISSION: Database user lacks permission to create the pilot tables.',
    };
    return Object.hasOwn(categories, error.code) ? categories[error.code] : 'SETUP_DB_INITIALIZATION: Database connection or schema creation failed. Check DATABASE_URL and the Postgres service logs. Raw error details are suppressed to protect credentials.';
  }
  return 'SETUP_UNKNOWN: Initialization failed before a diagnostic stage was identified. Raw error details are suppressed to protect credentials.';
}
if (require.main === module) main().then(result => {
  console.log(result.mainnet ? 'Fresh mainnet schema initialized with recovery mode required. Set SOLANA_INIT_MAINNET_FRESH=false before the next deployment.' : result.initialized ? 'Fresh devnet database initialized. Set SOLANA_INIT_FRESH=false before the next deployment.' : 'No fresh database initialization requested.');
}).catch(error => {
  console.error(formatFailure(error));
  process.exitCode = 1;
});
module.exports = { main, formatFailure };
