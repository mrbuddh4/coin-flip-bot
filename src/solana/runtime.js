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
const { SolanaFees, holderRewardsMode } = require('./fees');
const { holderHandler } = require('./holderPage');
const { holderWallet } = require('./custody');
const { ObsoleteNoticeCleanup } = require('./notifications');
const { startupStep, formatStartupFailure } = require('../utils/startupDiagnostics');
function assertLaunchReady(env = process.env) {
  const rewards = holderRewardsMode(env);
  holderWallet(env);
  if (network(env).realFunds && rewards === 'paxeer' && !/^https:\/\//.test(env.FLIP_HOLDER_RPC_URL || '')) throw new Error('MAINNET_HOLDER_RPC: Paxeer rewards were explicitly selected; set a working HTTPS FLIP_HOLDER_RPC_URL or use deferred rewards.');
}
async function main() {
  await startupStep('configuration', () => { assertLiveFunds(); assertLaunchReady(); });
  if (!process.env.SOLANA_WALLET_ADDRESS) throw new Error('Set SOLANA_WALLET_ADDRESS to the owner-selected shared wallet');
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.DATABASE_URL) throw new Error('Solana runtime requires TELEGRAM_BOT_TOKEN and DATABASE_URL');
  const chain = await startupStep('signer', () => new SolanaChain());
  const genesis = await startupStep('rpc', () => chain.validate());
  const release = await startupStep('database-lock', () => acquireInstanceLock());
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
    await startupStep('database-schema', () => store.verifySchema());
    await startupStep('database-network', () => store.bindNetwork(genesis, chain.address));
    await startupStep('database-interface', () => store.prepareInterface());
    await startupStep('holder-custody', () => store.bindHolderWallet(holderWallet()));
    service = await startupStep('service', () => new SolanaService({ store, chain }));
    fees = new SolanaFees({ store, chain, mode: holderRewardsMode() });
    // Solana-only mode reserves holder fees and performs no Paxeer requests.
    // The optional future Paxeer mode must verify its source before launch.
    if (network().realFunds && fees.mode === 'paxeer') {
      try { await fees.source.snapshot([]); }
      catch (_) { throw new Error('MAINNET_FLIP_SOURCE: Cannot verify the original FLIP contract, supply and finalized holder source.'); }
    }
    await startupStep('fee-backfill', () => fees.backfill());
    service.feeService = fees;
    scanner = new DepositScanner(service);
    bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    const info = await startupStep('telegram', () => bot.telegram.getWebhookInfo());
    if (info.url) throw new Error('Bot has an existing webhook; stop and review before switching to polling');
    bot.botInfo = await startupStep('telegram', () => bot.telegram.getMe());
    registerSolanaCommands(bot, service, { includeStart: false, allowLegacyGames: false });
    const ui = new SolanaInterface(bot, service, scanner);
    const noticeCleanup = new ObsoleteNoticeCleanup(store, bot.telegram);
    ui.register();
    bot.catch(() => console.error('Solana command failed; check private configuration and ledger.'));
    const cycle = async () => {
      if (cycleRunning || stopping) return;
      cycleRunning = true;
      try { await scanner.tick(); await service.work(); await ui.render(); await ui.refreshPrivateScreens(); }
      finally {
        // Removing obsolete verbose notices must never affect payments or polling.
        try { await noticeCleanup.tick(); }
        catch (_) { console.error('OBSOLETE_NOTICE_CLEANUP_RETRY: financial records retained.'); }
        cycleRunning = false;
      }
    };
    await startupStep('worker', () => cycle());
    timer = setInterval(() => cycle().catch(() => console.error('Solana worker check failed; ledger retained.')), 5000);
    const rewardTick = () => { if (!stopping) fees.tick().catch(() => console.error('Holder fee check failed; allocations retained.')); };
    if (fees.mode === 'paxeer') {
      rewardTick();
      feeTimer = setInterval(rewardTick, 60000);
    }
    const polling = bot.launch({ dropPendingUpdates: false }, () => { pollingStarted = true; });
    polling.catch(async error => {
      console.error(formatStartupFailure({ startupStage: 'polling', cause: error }));
      await shutdown(); process.exitCode = 1;
    });
    const pay = paymentHandler(service), holder = holderHandler(fees);
    server = await startupStep('health', () => startHealthServer({
      status: () => ({ ready: pollingStarted && !stopping, mode: `solana-${process.env.SOLANA_CLUSTER}`, realFundsEnabled: network().realFunds, holderRewards: fees.mode }),
      handle: async (req, res) => await pay(req, res) || (fees.mode === 'paxeer' && await holder(req, res)),
    }));
    console.log('Solana startup checks passed; Telegram polling requested.');
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) { await shutdown().catch(() => {}); throw error; }
}
module.exports = { main, assertLaunchReady };
