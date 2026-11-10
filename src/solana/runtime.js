const { Telegraf } = require('telegraf');
const { SolanaChain } = require('./chain');
const { SolanaStore } = require('./store');
const { SolanaService } = require('./service');
const { registerSolanaCommands } = require('./telegram');
const { acquireInstanceLock } = require('../utils/instanceLock');
const { assertLiveFunds } = require('../utils/recoveryMode');
const { startHealthServer } = require('../utils/healthServer');
const { DepositScanner } = require('./scanner');
const { SolanaInterface } = require('./interface');
const { paymentHandler } = require('./paymentPage');
const { network } = require('./network');
function assertLaunchReady(env = process.env) {
  // The original holder/burn economics have not yet been implemented on Solana.
  // Keep this review build runnable on devnet while that implementation is completed.
  if (network(env).realFunds) throw new Error('MAINNET_FEES_PENDING: The confirmed Solana holder distribution and burn must be implemented before this build can accept mainnet wagers.');
}
async function main() {
  assertLiveFunds();
  assertLaunchReady();
  if (!process.env.SOLANA_WALLET_ADDRESS) throw new Error('Set SOLANA_WALLET_ADDRESS to the owner-selected shared wallet');
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.DATABASE_URL) throw new Error('Solana runtime requires TELEGRAM_BOT_TOKEN and DATABASE_URL');
  const chain = new SolanaChain();
  const genesis = await chain.validate();
  const release = await acquireInstanceLock();
  const store = new SolanaStore();
  let timer, server, bot;
  let stopping = false;
  let pollingStarted = false;
  let cycleRunning = false;
  let scanner;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (bot && pollingStarted) { try { bot.stop('shutdown'); } catch (_) {} }
    // Keep the DB lock until the worker finishes its current signed transaction operation.
    while (cycleRunning || scanner?.running || service?.workerRunning) await new Promise(resolve => setTimeout(resolve, 50));
    if (server) await new Promise(resolve => server.close(resolve));
    await store.pool.end();
    await release();
  };
  let service;
  try {
    await store.verifySchema();
    await store.bindNetwork(genesis, chain.address);
    await store.prepareInterface();
    service = new SolanaService({ store, chain });
    scanner = new DepositScanner(service);
    bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    const info = await bot.telegram.getWebhookInfo();
    if (info.url) throw new Error('Bot has an existing webhook; stop and review before switching to polling');
    bot.botInfo = await bot.telegram.getMe();
    registerSolanaCommands(bot, service, { includeStart: false, allowLegacyGames: false });
    const ui = new SolanaInterface(bot, service, scanner);
    ui.register();
    bot.catch(() => console.error('Solana command failed; check private configuration and ledger.'));
    const cycle = async () => {
      if (cycleRunning || stopping) return;
      cycleRunning = true;
      try { await scanner.tick(); await service.work(); await ui.render(); }
      finally { cycleRunning = false; }
    };
    await cycle();
    timer = setInterval(() => cycle().catch(() => console.error('Solana worker check failed; ledger retained.')), 5000);
    const polling = bot.launch({ dropPendingUpdates: false }, () => { pollingStarted = true; });
    polling.catch(async () => { await shutdown(); process.exitCode = 1; });
    server = await startHealthServer({
      status: () => ({ ready: pollingStarted && !stopping, mode: `solana-${process.env.SOLANA_CLUSTER}`, realFundsEnabled: network().realFunds }),
      handle: paymentHandler(service),
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) { await shutdown(); throw error; }
}
module.exports = { main, assertLaunchReady };
