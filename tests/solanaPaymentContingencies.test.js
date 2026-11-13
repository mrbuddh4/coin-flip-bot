// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana partial payments and excess refunds', () => {
  let admin, pool, store, service, chain, schema;
  let now;
  const walletA = Keypair.fromSeed(Buffer.alloc(32, 6)).publicKey.toBase58();
  const walletB = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
  const input = { userId: '1', chatId: '-100', wallet: walletA, mint: 'SOL', amount: '0.1' };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url });
    schema = `sol_payment_test_${Date.now()}`;
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
  async function joined() {
    const g = await service.create(input);
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    return g.id;
  }
  async function funded() {
    const id = await joined();
    await service.deposit({ id, userId: '1', signature: 'creator-deposit' });
    await service.deposit({ id, userId: '2', signature: 'challenger-deposit' });
    return id;
  }
  function fakeBot() {
    let messageId = 0;
    const handlers = {};
    const bot = { handlers, start: fn => { handlers.start = fn; }, command: (name, fn) => { handlers[name] = fn; },
      action: (_, fn) => { handlers.action = fn; }, on: (_, fn) => { handlers.text = fn; },
      telegram: { getMe: jest.fn().mockResolvedValue({ username: 'TestCoinFlipBot' }),
        sendMessage: jest.fn(async () => ({ message_id: ++messageId })), editMessageText: jest.fn().mockResolvedValue({}), editMessageReplyMarkup: jest.fn().mockResolvedValue({}), editMessageCaption: jest.fn().mockResolvedValue({}), deleteMessage: jest.fn().mockResolvedValue({}), sendPhoto: jest.fn(async () => ({ message_id: ++messageId, photo: [{ file_id: 'cached-photo' }] })), sendVideo: jest.fn(async () => ({ message_id: ++messageId, video: { file_id: 'cached-video' } })) } };
    return bot;
  }
  function context(userId, text = '', type = 'private') {
    return { from: { id: Number(userId), first_name: userId === '1' ? '<Alice>' : 'Bob' },
      chat: { id: type === 'private' ? Number(userId) : -100, type }, message: { text },
      reply: jest.fn().mockResolvedValue({ message_id: 100 }), answerCbQuery: jest.fn().mockResolvedValue() };
  }
  async function callback(bot, userId, data) {
    const ctx = context(userId); ctx.callbackQuery = { data };
    await bot.handlers.action(ctx); return ctx;
  }
  test('partial payment survives restart, keeps original deadline and expires with full refund', async () => {
    const g = await service.create({ ...input, interfaceVersion: 2 });
    chain.verifyDeposit.mockResolvedValueOnce(40000000n);
    await service.deposit({ id: g.id, userId: '1', signature: 'part-a' });
    now += 60000;
    chain.verifyDeposit.mockResolvedValueOnce(10000000n);
    const restarted = new SolanaService({ store, chain, now: () => now });
    const partial = await restarted.deposit({ id: g.id, userId: '1', signature: 'part-b' });
    expect(partial.expiresAt).toBe(g.expiresAt);
    expect(partial.creator.depositExpiresAt).toBe(g.creator.depositExpiresAt);
    now = g.expiresAt;
    await restarted.expire();
    chain.verifyDeposit.mockResolvedValueOnce(50000000n);
    await restarted.deposit({ id: g.id, userId: '1', signature: 'too-late' });
    expect((await store.get(g.id)).status).toBe('CANCELLED');
    expect((await store.payments(g.id)).map(p => p.payment.amount).sort()).toEqual(['10000000', '40000000', '50000000']);
    expect(service.coin).not.toHaveBeenCalled();
  });
  test('concurrent topups and duplicates settle exact wagers once and preserve excess', async () => {
    const id = await joined();
    chain.verifyDeposit.mockImplementation(async ({ signature }) => signature === 'part' ? 60000000n : signature === 'finish' ? 50000000n : 100000000n);
    await Promise.all(['part', 'part', 'finish', 'finish'].map(signature => service.deposit({ id, userId: '1', signature })));
    await service.deposit({ id, userId: '2', signature: 'opponent' });
    expect((await store.get(id))).toMatchObject({ status: 'SETTLED', wager: '100000000', prize: '180000000' });
    expect(service.coin).toHaveBeenCalledTimes(1);
    expect((await store.payments(id)).filter(p => p.payment.kind === 'refund').map(p => p.payment.amount)).toEqual(['10000000']);
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '210000000' }]);
  });
  test('challenger partial deposit updates the same checking card with exact remainder and auto settles on topup', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, { confirm: jest.fn() }); ui.register();
    await callback(bot, '2', 's:check:' + g.id);
    const before = (await store.profile('2')).privateScreen.messageId;
    chain.verifyDeposit.mockResolvedValueOnce(40000000n);
    await service.deposit({ id: g.id, userId: '2', signature: 'partial' });
    await ui.refreshPrivateScreens();
    const screen = (await store.profile('2')).privateScreen;
    expect(screen.messageId).toBe(before);
    expect(screen.text).toContain('Received: 0.04 SOL');
    expect(screen.text).toContain('Remaining: 0.06 SOL');
    expect(screen.text).toContain('Payment deadline:');
    expect(screen.text).toContain('not a dollar value');
    await callback(bot, '2', 's:deposit:' + g.id);
    const details = (await store.profile('2')).privateScreen;
    expect(details.rows.flat().find(b => b.text === '📋 Copy Exact Amount').copy_text.text).toBe('0.06');
    expect(details.text).toContain('amount=0.06');
    chain.verifyDeposit.mockResolvedValueOnce(60000000n);
    await service.deposit({ id: g.id, userId: '2', signature: 'topup' });
    expect((await store.get(g.id)).status).toBe('SETTLED');
    expect(service.coin).toHaveBeenCalledTimes(1);
  });
  test('overpay then cancel returns exactly the original transfer with distinct durable refund components', async () => {
    const g = await service.create(input);
    chain.verifyDeposit.mockResolvedValueOnce(500000000n);
    await service.deposit({ id: g.id, userId: '1', signature: 'overpaid' });
    await service.cancel({ id: g.id, userId: '1', chatId: input.chatId });
    const payments = await store.payments(g.id);
    expect(payments.map(p => p.id).sort()).toEqual(['refund-excess:overpaid', 'refund:overpaid']);
    expect(payments.map(p => p.payment.amount).sort()).toEqual(['100000000', '400000000']);
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '500000000' }]);
  });
  test('partial topup racing cancellation refunds every unit once and never draws', async () => {
    const g = await service.create(input);
    chain.verifyDeposit.mockResolvedValueOnce(40000000n);
    await service.deposit({ id: g.id, userId: '1', signature: 'partial' });
    chain.verifyDeposit.mockResolvedValue(60000000n);
    await Promise.all([service.deposit({ id: g.id, userId: '1', signature: 'last' }), service.cancel({ id: g.id, userId: '1', chatId: input.chatId })]);
    expect((await store.get(g.id)).status).toBe('CANCELLED');
    expect((await store.payments(g.id)).map(p => p.payment.amount).sort()).toEqual(['40000000', '60000000']);
    expect(service.coin).not.toHaveBeenCalled();
  });
  test('legacy single-receipt funding remains reserved and refundable without migration', async () => {
    const g = await service.create(input);
    await store.mutate(g.id, game => { game.creator.deposit = { signature: 'legacy', amount: game.wager }; });
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '100000000' }]);
    await service.cancel({ id: g.id, userId: '1', chatId: input.chatId });
    expect((await store.payments(g.id))[0]).toMatchObject({ id: 'refund:legacy', payment: { amount: '100000000', recipient: walletA } });
  });
});
