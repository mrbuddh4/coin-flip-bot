const { Telegraf } = require('telegraf');
const { SolanaChain } = require('./chain');
const { SolanaStore } = require('./store');
const { SolanaService } = require('./service');
const { registerSolanaCommands } = require('./telegram');
const { acquireInstanceLock } = require('../utils/instanceLock');
const { assertLiveFunds } = require('../utils/recoveryMode');
const { startHealthServer } = require('../utils/healthServer');
async function main() {
  assertLiveFunds();
  if (!process.env.SOLANA_WALLET_ADDRESS) throw new Error('Set SOLANA_WALLET_ADDRESS to the owner-selected shared wallet');
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.DATABASE_URL) throw new Error('Solana pilot requires a separate test Telegram bot and fresh DATABASE_URL');
  const chain = new SolanaChain();
  await chain.validate();
  const release = await acquireInstanceLock();
  const store = new SolanaStore();
  let timer, server, bot;
  let stopping = false;
  let pollingStarted = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (bot && pollingStarted) { try { bot.stop('shutdown'); } catch (_) {} }
    // Keep the DB lock until the worker finishes its current signed transaction operation.
    while (service?.workerRunning) await new Promise(resolve => setTimeout(resolve, 50));
    if (server) await new Promise(resolve => server.close(resolve));
    await store.pool.end();
    await release();
  };
  let service;
  try {
    await store.verifySchema();
    service = new SolanaService({ store, chain });
    bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    const info = await bot.telegram.getWebhookInfo();
    if (info.url) throw new Error('Test bot has an existing webhook; stop and review before switching to polling');
    registerSolanaCommands(bot, service);
    bot.catch(() => console.error('Solana command failed; check private configuration and ledger.'));
    await service.work();
    timer = setInterval(() => service.work().catch(() => console.error('Solana worker check failed.')), 5000);
    const polling = bot.launch({ dropPendingUpdates: false }, () => { pollingStarted = true; });
    polling.catch(async () => { await shutdown(); process.exitCode = 1; });
    server = await startHealthServer({ status: () => ({ ready: pollingStarted && !stopping, mode: 'solana-devnet', realFundsEnabled: false }) });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) { await shutdown(); throw error; }
}
module.exports = { main };
