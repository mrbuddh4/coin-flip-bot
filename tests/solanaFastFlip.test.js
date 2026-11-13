// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Fast Solana flip presentation on real PostgreSQL', () => {
  let admin, pool, store, service, chain, schema;
  let now;
  const walletA = Keypair.fromSeed(Buffer.alloc(32, 6)).publicKey.toBase58();
  const walletB = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
  const input = { userId: '1', chatId: '-100', wallet: walletA, mint: 'SOL', amount: '0.1' };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url });
    schema = `sol_fast_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(pool);
    await store.verifySchema();
    await store.prepareInterface();
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolOutbox", "SolDeposits", "SolGames", "SolTokens", "SolProfiles", "SolSessions", "SolDrafts", "SolScanCursors", "SolDepositReviews", "SolFeeAccruals", "SolFeePools", "SolFeeCycles", "SolHolderLinks", "SolHolderChallenges", "SolMediaCache", "SolNotificationDeliveries"');
    await pool.query('DROP TABLE IF EXISTS \"SolNetwork\"');
    now = 1000;
    chain = {
      address: Keypair.fromSeed(Buffer.alloc(32, 10)).publicKey.toBase58(),
      env: { SOLANA_CLUSTER: 'devnet' },
      tokenInfo: jest.fn().mockResolvedValue({ address: 'NATIVE', symbol: 'SOL', decimals: 9 }),
      verifyDeposit: jest.fn().mockResolvedValue(100000000n),
      assertSolvent: jest.fn().mockResolvedValue(),
      buildPayment: jest.fn(async payment => ({ signature: `signed-${payment.id}`, raw: 'same-bytes', lastValidBlockHeight: 100 })),
      broadcast: jest.fn().mockResolvedValue(), paymentStatus: jest.fn().mockResolvedValue('unknown'),
      connection: { getBlockHeight: jest.fn().mockResolvedValue(10) },
    };
    service = new SolanaService({ store, chain, now: () => now, coin: jest.fn(() => 0) });
  });
  function fakeBot() {
    let messageId = 0;
    const handlers = {};
    const bot = { handlers, start: fn => { handlers.start = fn; }, command: (name, fn) => { handlers[name] = fn; },
      action: (_, fn) => { handlers.action = fn; }, on: (_, fn) => { handlers.text = fn; },
      telegram: { getMe: jest.fn().mockResolvedValue({ username: 'TestCoinFlipBot' }),
        sendMessage: jest.fn(async () => ({ message_id: ++messageId })), editMessageText: jest.fn().mockResolvedValue({}), editMessageReplyMarkup: jest.fn().mockResolvedValue({}), editMessageCaption: jest.fn().mockResolvedValue({}), deleteMessage: jest.fn().mockResolvedValue({}), sendPhoto: jest.fn(async () => ({ message_id: ++messageId, photo: [{ file_id: 'cached-photo' }] })), sendVideo: jest.fn(async () => ({ message_id: ++messageId, video: { file_id: 'cached-video' } })) } };
    return bot;
  }

  test('fresh fast clip ignores the older cached long video and reveals only after three seconds of acknowledged playback', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'fast-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    await service.deposit({ id: g.id, userId: '2', signature: 'fast-challenger' });
    await store.saveMedia('coinflip-video:TestCoinFlipBot', { fileId: 'old-long-clip', durationMs: 11000 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    await ui.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledWith('-100', { source: path.join(__dirname, '../assets/coinflip-fast.mp4') }, expect.anything());
    expect((await store.get(g.id)).ui.revealAt).toBe(now + 3250);
    expect(await store.media('coinflip-fast-v1-video:TestCoinFlipBot')).toMatchObject({ durationMs: 3000 });
    expect(bot.telegram.sendPhoto).not.toHaveBeenCalled();
    now += 3249; await ui.render(); expect(bot.telegram.sendPhoto).not.toHaveBeenCalled();
    now += 1; await ui.render();
    expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(bot.telegram.sendPhoto.mock.calls[0][2].caption).toContain('Winner:');
    expect(bot.telegram.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(bot.telegram.sendPhoto.mock.invocationCallOrder[0]);
    // Settlement is the same durable economic result, with the same pool split.
    expect((await store.get(g.id)).prize).toBe('180000000');
    expect((await store.payments(g.id)).map(p => p.payment.amount)).toContain('180000000');
  });
});

test('packaged fast video really lasts three seconds and is small enough for a quick upload', () => {
  const bytes = fs.readFileSync(path.join(__dirname, '../assets/coinflip-fast.mp4'));
  const mvhd = bytes.indexOf(Buffer.from('mvhd'));
  expect(mvhd).toBeGreaterThan(0); expect(bytes[mvhd + 4]).toBe(0);
  const timescale = bytes.readUInt32BE(mvhd + 16), duration = bytes.readUInt32BE(mvhd + 20);
  expect(duration / timescale).toBeCloseTo(3, 2);
  expect(bytes.length).toBeLessThan(100000);
});
