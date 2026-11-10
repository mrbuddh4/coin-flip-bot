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
const { SolanaFees, FlipSnapshotSource } = require('./fees');
const { holderHandler } = require('./holderPage');
function assertLaunchReady(env = process.env) {
  if (network(env).realFunds && !/^https:\/\//.test(env.FLIP_HOLDER_RPC_URL || '')) throw new Error('MAINNET_HOLDER_RPC: Set a working HTTPS Paxeer FLIP_HOLDER_RPC_URL before accepting mainnet wagers.');
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
  let timer, feeTimer, fees, server, bot;
  let stopping = false;
  let pollingStarted = false;
  let cycleRunning = false;
  let scanner;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(feeTimer);
    if (bot && pollingStarted) { try { bot.stop('shutdown'); } catch (_) {} }
    // Keep the DB lock until the worker finishes its current signed transaction operation.
    while (cycleRunning || scanner?.running || service?.workerRunning || fees?.running) await new Promise(resolve => setTimeout(resolve, 50));
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
    const source = new FlipSnapshotSource();
    // Verify supply/finality even with no registrations; do not launch mainnet
    // with a reward program that cannot read its underlying FLIP contract.
    if (network().realFunds) {
      try { await source.snapshot([]); }
      catch (_) { throw new Error('MAINNET_FLIP_SOURCE: Cannot verify the original FLIP contract, supply and finalized holder source.'); }
    }
    fees = new SolanaFees({ store, chain, source });
    await fees.backfill();
    service.feeService = fees;
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
    const rewardTick = () => { if (!stopping) fees.tick().catch(() => console.error('Holder fee check failed; allocations retained.')); };
    rewardTick();
    feeTimer = setInterval(rewardTick, 60000);
    const polling = bot.launch({ dropPendingUpdates: false }, () => { pollingStarted = true; });
    polling.catch(async () => { await shutdown(); process.exitCode = 1; });
    const pay = paymentHandler(service), holder = holderHandler(fees);
    server = await startHealthServer({
      status: () => ({ ready: pollingStarted && !stopping, mode: `solana-${process.env.SOLANA_CLUSTER}`, realFundsEnabled: network().realFunds }),
      handle: async (req, res) => await pay(req, res) || await holder(req, res),
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) { await shutdown(); throw error; }
}
module.exports = { main, assertLaunchReady };
