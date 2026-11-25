const { spawnSync } = require('node:child_process');
const { startupStep, formatStartupFailure } = require('../src/utils/startupDiagnostics');

test('failed operations retain their safe stage and original cause without printing it', async () => {
  const cause = Object.assign(new Error('https://rpc.example/PRIVATE-RPC-KEY'), { code: 'ECONNREFUSED' });
  let failure;
  try { await startupStep('database-lock', () => { throw cause; }); } catch (error) { failure = error; }
  expect(failure.cause).toBe(cause);
  expect(formatStartupFailure(failure)).toMatch(/^STARTUP_DB_REFUSED:/);
  expect(formatStartupFailure(failure)).not.toContain('PRIVATE-RPC-KEY');
});
test.each([
  ['rpc', {}, 'STARTUP_RPC:'],
  ['telegram', { response: { error_code: 401, description: 'SECRET' } }, 'STARTUP_TELEGRAM_TOKEN:'],
  ['polling', { response: { error_code: 409, description: 'SECRET' } }, 'STARTUP_TELEGRAM_CONFLICT:'],
  ['database-schema', { code: '42P01' }, 'STARTUP_DB_TABLE:'],
  ['holder-custody', { code: '42501' }, 'STARTUP_DB_PERMISSION:'],
  ['health', { code: 'EADDRINUSE' }, 'STARTUP_HEALTH:'],
  ['attacker-SECRET', { code: 'SECRET' }, 'STARTUP_UNKNOWN:'],
])('reports actionable fixed diagnostics for %s without provider details', (startupStage, fields, prefix) => {
  const error = { startupStage, cause: Object.assign(new Error('SECRET https://user:password@host/bot-token'), fields) };
  const text = formatStartupFailure(error);
  expect(text.startsWith(prefix)).toBe(true);
  expect(text).not.toMatch(/SECRET|password|bot-token/);
});
test.each([
  ['Another bot instance holds the database lock', 'STARTUP_INSTANCE_LOCK:'],
  ['Solana signing and deposit wallet mismatch', 'STARTUP_SIGNER_MISMATCH:'],
  ['RPC does not match configured Solana mainnet; no transactions allowed', 'STARTUP_RPC_NETWORK:'],
  ['Funds disabled. Recovery mode does not accept wagers or send transactions.', 'STARTUP_FUNDS_GATE:'],
  ['Solana runtime requires TELEGRAM_BOT_TOKEN and DATABASE_URL', 'STARTUP_REQUIRED_VARIABLES:'],
])('keeps known configuration failures specific: %s', (message, prefix) => {
  expect(formatStartupFailure(new Error(message)).startsWith(prefix)).toBe(true);
});
test('successful startup steps preserve the result', async () => {
  await expect(startupStep('rpc', () => Promise.resolve('verified'))).resolves.toBe('verified');
});
test('real npm entrypoint reports an invalid signer safely before any network access', () => {
  const env = { ...process.env, BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true', BOT_CHAIN: 'solana', SOLANA_CLUSTER: 'mainnet-beta', SOLANA_HOLDER_REWARDS: 'deferred', SOLANA_HOLDER_WALLET_ADDRESS: '', SOLANA_WALLET_ADDRESS: '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY', TELEGRAM_BOT_TOKEN: 'SECRET-TELEGRAM', DATABASE_URL: 'postgres://user:SECRET-DATABASE@127.0.0.1/db', SOLANA_RPC_URL: 'https://rpc.example/SECRET-RPC', SOLANA_PRIVATE_KEY: 'SECRET-INVALID-KEY' };
  const result = spawnSync(process.execPath, ['src/runtime.js'], { cwd: require('node:path').join(__dirname, '..'), env, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('STARTUP_SIGNER_FORMAT:');
  expect(result.stdout + result.stderr).not.toContain('SECRET-');
});
