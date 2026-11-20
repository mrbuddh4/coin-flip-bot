require('dotenv').config();
const { getMode, assertLiveFunds } = require('./utils/recoveryMode');
const { startHealthServer } = require('./utils/healthServer');
const { startupStep, formatStartupFailure } = require('./utils/startupDiagnostics');

async function main() {
  if (getMode() === 'live') {
    assertLiveFunds();
    if (['solana', 'multi'].includes(process.env.BOT_CHAIN)) {
      const runtime = await startupStep('dependencies', () => require('./solana/runtime'));
      await runtime.main();
    }
    else if (!process.env.BOT_CHAIN || process.env.BOT_CHAIN === 'evm') await require('./index').main();
    else throw new Error('BOT_CHAIN must be evm, solana or multi');
    return;
  }
  // No imports of the game, wallet, database models or Telegram poller here.
  // An old database cannot trigger payments or schema changes in recovery mode.
  const server = await startHealthServer({
    status: () => ({ ready: true, mode: 'recovery', liveFundsEnabled: false }),
  });
  console.log(`Recovery service listening on port ${server.address().port}. Telegram and payments are stopped.`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) main().catch(error => {
  console.error(formatStartupFailure(error));
  process.exitCode = 1;
});
module.exports = { main };
