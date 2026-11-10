require('dotenv').config();
const { getMode, assertLiveFunds } = require('./utils/recoveryMode');
const { startHealthServer } = require('./utils/healthServer');

async function main() {
  if (getMode() === 'live') {
    assertLiveFunds();
    if (process.env.BOT_CHAIN === 'solana') await require('./solana/runtime').main();
    else if (!process.env.BOT_CHAIN || process.env.BOT_CHAIN === 'evm') await require('./index').main();
    else throw new Error('BOT_CHAIN must be evm or solana');
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
  console.error(error.message?.startsWith('MAINNET_HOLDER_RPC:')
    ? 'MAINNET_HOLDER_RPC: Set a working HTTPS Paxeer FLIP_HOLDER_RPC_URL in private Variables. Mainnet wagering has not started.'
    : error.message?.startsWith('MAINNET_FLIP_SOURCE:')
      ? 'MAINNET_FLIP_SOURCE: The configured Paxeer source cannot verify the original FLIP contract and supply. Mainnet wagering has not started.'
      : 'Startup failed. Check BOT_MODE, funds gate, port and private hosting logs.');
  process.exitCode = 1;
});
module.exports = { main };
