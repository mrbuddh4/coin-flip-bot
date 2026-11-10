// Exercise the real startup wiring, using simulated Telegram/Solana I/O only.
// No credentials, funds or external RPC requests are used by this test.
jest.mock('../src/solana/chain', () => ({ SolanaChain: jest.fn() }));
jest.mock('../src/solana/store', () => ({ SolanaStore: jest.fn() }));
jest.mock('../src/solana/service', () => ({ SolanaService: jest.fn() }));
jest.mock('../src/solana/scanner', () => ({ DepositScanner: jest.fn() }));
jest.mock('../src/solana/interface', () => ({ SolanaInterface: jest.fn() }));
jest.mock('../src/solana/telegram', () => ({ registerSolanaCommands: jest.fn() }));
jest.mock('../src/utils/instanceLock', () => ({ acquireInstanceLock: jest.fn() }));
jest.mock('../src/utils/healthServer', () => ({ startHealthServer: jest.fn() }));
jest.mock('telegraf', () => ({ Telegraf: jest.fn() }));
const { main } = require('../src/solana/runtime');
const { SolanaChain } = require('../src/solana/chain');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { DepositScanner } = require('../src/solana/scanner');
const { SolanaInterface } = require('../src/solana/interface');
const { acquireInstanceLock } = require('../src/utils/instanceLock');
const { startHealthServer } = require('../src/utils/healthServer');
const { Telegraf } = require('telegraf');
const { FlipSnapshotSource } = require('../src/solana/fees');
test('real mainnet startup wiring starts the Solana-only bot with no Paxeer source, timer or verification page', async () => {
  const originalEnv = process.env;
  process.env = { ...originalEnv, BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true', BOT_CHAIN: 'solana', SOLANA_CLUSTER: 'mainnet-beta', SOLANA_WALLET_ADDRESS: 'test-treasury', TELEGRAM_BOT_TOKEN: 'offline-test-only', DATABASE_URL: 'offline-unused' };
  delete process.env.SOLANA_HOLDER_REWARDS; delete process.env.FLIP_HOLDER_RPC_URL;
  const chain = { address: 'test-treasury', env: process.env, validate: jest.fn(async () => 'mainnet-genesis') };
  const store = { pool: { end: jest.fn(async () => {}) }, verifySchema: jest.fn(async () => {}), bindNetwork: jest.fn(async () => {}), prepareInterface: jest.fn(async () => {}), allResults: jest.fn(async () => []) };
  const service = { store, chain, work: jest.fn(async () => {}), workerRunning: false };
  const scanner = { tick: jest.fn(async () => {}), running: false };
  const ui = { register: jest.fn(), render: jest.fn(async () => {}) };
  const bot = { telegram: { getWebhookInfo: jest.fn(async () => ({ url: '' })), getMe: jest.fn(async () => ({ id: 1 })) }, catch: jest.fn(), launch: jest.fn(async (_options, ready) => ready()), stop: jest.fn() };
  SolanaChain.mockImplementation(() => chain); SolanaStore.mockImplementation(() => store); SolanaService.mockImplementation(() => service);
  DepositScanner.mockImplementation(() => scanner); SolanaInterface.mockImplementation(() => ui); Telegraf.mockImplementation(() => bot);
  const release = jest.fn(async () => {}); acquireInstanceLock.mockResolvedValue(release);
  startHealthServer.mockResolvedValue({ close: cb => cb() });
  const handlers = {};
  const once = jest.spyOn(process, 'once').mockImplementation((event, fn) => { handlers[event] = fn; return process; });
  const snapshot = jest.spyOn(FlipSnapshotSource.prototype, 'snapshot').mockRejectedValue(new Error('Paxeer offline'));
  try {
    await main();
    expect(snapshot).not.toHaveBeenCalled(); expect(bot.launch).toHaveBeenCalledTimes(1);
    expect(service.feeService.mode).toBe('deferred'); expect(service.feeService.source).toBeNull();
    expect(service.work).toHaveBeenCalledTimes(1); expect(scanner.tick).toHaveBeenCalledTimes(1);
    const options = startHealthServer.mock.calls[0][0];
    expect(options.status()).toMatchObject({ ready: true, mode: 'solana-mainnet-beta', holderRewards: 'deferred' });
    expect(await options.handle({ url: '/holder/' + 'ab'.repeat(16) }, {})).toBe(false);
    await handlers.SIGTERM();
    expect(store.pool.end).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  } finally {
    if (handlers.SIGTERM) await handlers.SIGTERM();
    once.mockRestore(); snapshot.mockRestore(); process.env = originalEnv;
  }
});
