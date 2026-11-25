// Only fixed text leaves this module. Provider errors may contain private URLs,
// bot tokens, connection strings or signed transaction bytes.
async function startupStep(stage, operation) {
  try { return await operation(); }
  catch (cause) {
    const error = new Error('Startup step failed', { cause });
    error.startupStage = stage;
    throw error;
  }
}
const STAGES = Object.freeze({
  configuration: 'STARTUP_CONFIG: Check BOT_MODE, LIVE_FUNDS_ENABLED, BOT_CHAIN, SOLANA_CLUSTER, SOLANA_HOLDER_REWARDS and the public wallet settings.',
  dependencies: 'STARTUP_DEPENDENCIES: Runtime dependencies could not load. Check the source revision and build logs.',
  signer: 'STARTUP_SIGNER: Check SOLANA_RPC_URL and the treasury SOLANA_PRIVATE_KEY privately in Railway.',
  rpc: 'STARTUP_RPC: Could not verify the Solana RPC network and matching treasury wallet. Check SOLANA_RPC_URL, SOLANA_CLUSTER and SOLANA_WALLET_ADDRESS.',
  'database-lock': 'STARTUP_DB_CONNECTION: Could not acquire the single-instance database lock. Check DATABASE_URL and that Postgres is online.',
  'database-schema': 'STARTUP_DB_SCHEMA: Could not verify the existing Solana tables. Check the mainnet DATABASE_URL reference. Do not reset or reinitialize the database.',
  'database-network': 'STARTUP_DB_NETWORK: Could not bind the ledger to the configured network and treasury. Check the intended mainnet database reference.',
  'database-interface': 'STARTUP_DB_TABLES: Could not prepare the additive menu and fee tables. Check database permissions and the deployed source revision.',
  'holder-custody': 'STARTUP_HOLDER_CUSTODY: Could not bind the separate holder wallet. Check SOLANA_HOLDER_WALLET_ADDRESS against the wallet already recorded in the ledger.',
  'service': 'STARTUP_SERVICE: Could not construct the Solana game service.',
  'holder-source': 'STARTUP_HOLDER_SOURCE: The optional legacy holder source could not be verified. Solana-only deployments should use SOLANA_HOLDER_REWARDS=deferred.',
  'fee-backfill': 'STARTUP_FEE_LEDGER: Could not reconcile historical fee records. Existing records are retained.',
  telegram: 'STARTUP_TELEGRAM: Could not verify the bot with Telegram. Check TELEGRAM_BOT_TOKEN privately and Telegram connectivity.',
  'telegram-interface': 'STARTUP_TELEGRAM_INTERFACE: Could not register the Solana menus and commands.',
  'worker': 'STARTUP_WORKER: The first deposit, payment or menu refresh failed. Existing ledger records are retained.',
  polling: 'STARTUP_TELEGRAM_POLLING: Telegram polling stopped. Check the token, connectivity and whether another deployment is using this same bot.',
  health: 'STARTUP_HEALTH: Could not open the health server. Check PORT and the service start command.',
});
const EXACT = new Map([
  ['BOT_MODE must be recovery or live', 'STARTUP_BOT_MODE: BOT_MODE must be exactly recovery or live.'],
  ['Funds disabled. Recovery mode does not accept wagers or send transactions.', 'STARTUP_FUNDS_GATE: Live startup requires BOT_MODE=live and LIVE_FUNDS_ENABLED=true.'],
  ['BOT_CHAIN must be evm or solana', 'STARTUP_CHAIN: Set BOT_CHAIN=solana for this deployment.'],
  ['SOLANA_CLUSTER must be devnet or mainnet-beta', 'STARTUP_CLUSTER: Set SOLANA_CLUSTER=mainnet-beta for the mainnet database.'],
  ['SOLANA_HOLDER_REWARDS must be deferred or paxeer', 'STARTUP_REWARDS_MODE: Set SOLANA_HOLDER_REWARDS=deferred for Solana-only operation.'],
  ['Holder rewards wallet must differ from the game treasury', 'STARTUP_HOLDER_ADDRESS: The holder wallet must differ from SOLANA_WALLET_ADDRESS.'],
  ['Separate holder custody currently requires deferred distributions', 'STARTUP_HOLDER_MODE: Separate holder custody requires SOLANA_HOLDER_REWARDS=deferred.'],
  ['Use an on-curve Solana wallet address', 'STARTUP_WALLET_ADDRESS: Check the public Solana wallet address format.'],
  ['Set SOLANA_WALLET_ADDRESS to the owner-selected shared wallet', 'STARTUP_TREASURY_MISSING: Set SOLANA_WALLET_ADDRESS to the selected public treasury address.'],
  ['Solana runtime requires TELEGRAM_BOT_TOKEN and DATABASE_URL', 'STARTUP_REQUIRED_VARIABLES: TELEGRAM_BOT_TOKEN or DATABASE_URL is missing or resolves empty. Use the Railway database reference picker.'],
  ['Invalid SOLANA_PRIVATE_KEY; enter a 64-byte JSON array or base58 key privately', 'STARTUP_SIGNER_FORMAT: SOLANA_PRIVATE_KEY must be the treasury 64-byte JSON array or base58 secret key, entered privately in Railway.'],
  ['Solana signing and deposit wallet mismatch', 'STARTUP_SIGNER_MISMATCH: SOLANA_PRIVATE_KEY does not match SOLANA_WALLET_ADDRESS. Check the treasury key privately.'],
  ['RPC does not match configured Solana mainnet; no transactions allowed', 'STARTUP_RPC_NETWORK: The RPC is not mainnet. Check SOLANA_RPC_URL and SOLANA_CLUSTER.'],
  ['RPC does not match configured Solana devnet; no transactions allowed', 'STARTUP_RPC_NETWORK: The RPC is not devnet. Check SOLANA_RPC_URL and SOLANA_CLUSTER.'],
  ['Another bot instance holds the database lock', 'STARTUP_INSTANCE_LOCK: Another deployment owns this database. Stop the previous bot deployment, then retry with one replica.'],
  ['Bot has an existing webhook; stop and review before switching to polling', 'STARTUP_TELEGRAM_WEBHOOK: This bot has an existing webhook. Review its current owner before switching it to polling. The webhook was not deleted.'],
  ['HOLDER_CUSTODY: Keep the recorded SOLANA_HOLDER_WALLET_ADDRESS; removing or changing it requires reconciliation.', 'STARTUP_HOLDER_CHANGED: Keep the holder wallet already recorded in this database. A wallet change requires reconciliation.'],
]);
const DB_CODES = Object.freeze({
  ENOTFOUND: 'STARTUP_DB_DNS: Postgres hostname could not resolve. Check DATABASE_URL and private networking.',
  EAI_AGAIN: 'STARTUP_DB_DNS: Postgres hostname lookup temporarily failed.',
  ECONNREFUSED: 'STARTUP_DB_REFUSED: Postgres refused the connection. Check that the referenced service is online.',
  ETIMEDOUT: 'STARTUP_DB_TIMEOUT: Postgres connection timed out. Check DATABASE_URL and networking.',
  '28P01': 'STARTUP_DB_AUTH: Postgres rejected authentication. Use its current DATABASE_URL reference.',
  '3D000': 'STARTUP_DB_NAME: The referenced Postgres database does not exist.',
  '42P01': 'STARTUP_DB_TABLE: A required table is missing. Check the correct mainnet database reference. Do not reset the database.',
  '42703': 'STARTUP_DB_COLUMN: The database schema differs from the deployed source. Review the schema without resetting records.',
  '42501': 'STARTUP_DB_PERMISSION: Postgres denied a required operation. Check the database role permissions.',
});
function formatStartupFailure(error) {
  const stage = error?.startupStage;
  const cause = Object.hasOwn(STAGES, stage) ? (error.cause || error) : error;
  if (EXACT.has(cause?.message)) return EXACT.get(cause.message);
  if (stage?.startsWith('database-') || stage === 'holder-custody' || stage === 'fee-backfill') {
    if (Object.hasOwn(DB_CODES, cause?.code)) return DB_CODES[cause.code];
  }
  if (stage === 'telegram' || stage === 'polling') {
    const code = cause?.response?.error_code;
    if (code === 401 || code === 404) return 'STARTUP_TELEGRAM_TOKEN: Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN privately.';
    if (code === 409) return 'STARTUP_TELEGRAM_CONFLICT: Another process or webhook is using this Telegram bot. Stop the other poller before retrying.';
  }
  if (Object.hasOwn(STAGES, stage)) return STAGES[stage];
  return 'STARTUP_UNKNOWN: Startup failed outside an identified diagnostic stage. Raw errors are suppressed to protect credentials.';
}
module.exports = { startupStep, formatStartupFailure };
