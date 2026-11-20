// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana group-to-DM handoff on real PostgreSQL', () => {
  let admin, pool, store, service, chain, schema;
  let now;
  const walletA = Keypair.fromSeed(Buffer.alloc(32, 6)).publicKey.toBase58();
  const walletB = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
  const input = { userId: '1', chatId: '-100', wallet: walletA, mint: 'SOL', amount: '0.1' };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url });
    schema = `sol_test_${Date.now()}`;
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
  function context(userId, text = '', type = 'private') {
    return { from: { id: Number(userId), first_name: userId === '1' ? '<Alice>' : 'Bob' },
      chat: { id: type === 'private' ? Number(userId) : -100, type }, message: { text },
      reply: jest.fn().mockResolvedValue({ message_id: 100 }), answerCbQuery: jest.fn().mockResolvedValue() };
  }
  async function callback(bot, userId, data) {
    const ctx = context(userId); ctx.callbackQuery = { data };
    await bot.handlers.action(ctx); return ctx;
  }
  test('group create and accept links open a visible fresh DM card, then edit that same card', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, { tick: jest.fn() }); ui.register();
    await store.updateProfile('1', { wallet: walletA, receiveWallet: walletA });
    await bot.handlers.start(context('1', '/start'));
    const group = context('1', '/flip', 'supergroup'); await bot.handlers.flip(group);
    const url = group.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].url;
    const entry = context('1', '/start ' + url.split('?start=')[1]);
    entry.reply.mockResolvedValue({ message_id: 201 });
    await bot.handlers.start(entry);
    expect(entry.reply).toHaveBeenCalledWith(expect.stringContaining('Select a Token'), expect.anything());
    expect((await store.profile('1')).privateScreen.messageId).toBe(201);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(1, 100);
    const session = await store.session('1');
    await callback(bot, '1', 's:token:0:' + session.nonce);
    expect(bot.telegram.editMessageText).toHaveBeenCalledWith(1, 201, undefined, expect.stringContaining('Wager Amount'), expect.anything());
    await bot.handlers.text(context('1', '0.1'));
    const game = (await store.history('1'))[0];
    await service.deposit({ id: game.id, userId: '1', signature: 'fresh-create' });
    await callback(bot, '1', 's:check:' + game.id);
    await store.updateProfile('2', { wallet: walletB, receiveWallet: walletB });
    await bot.handlers.start(context('2', '/start'));
    const join = context('2', '/start soljoin_' + game.id);
    join.reply.mockResolvedValue({ message_id: 202 });
    await bot.handlers.start(join);
    expect(join.reply).toHaveBeenCalledWith(expect.stringContaining('Review Challenge'), expect.anything());
    expect((await store.profile('2')).privateScreen.messageId).toBe(202);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(2, 100);
    expect((await store.get(game.id)).challenger).toBeNull();
  });
});
