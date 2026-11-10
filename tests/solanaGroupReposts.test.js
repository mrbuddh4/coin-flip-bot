// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana group reposts on real PostgreSQL', () => {
  let admin, pool, store, service, chain, schema;
  let now;
  const walletA = Keypair.fromSeed(Buffer.alloc(32, 6)).publicKey.toBase58();
  const walletB = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
  const input = { userId: '1', chatId: '-100', wallet: walletA, mint: 'SOL', amount: '0.1' };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url });
    schema = `sol_reposts_${Date.now()}`;
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
  async function openGroupCard(env = {}) {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}, env);
    await service.deposit({ id: g.id, userId: '1', signature: 'repost-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await ui.render();
    return { g: await store.get(g.id), bot, ui };
  }
  test('waiting challenge moves every 60 seconds, keeps the same deadline and persists cadence after restart', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const { g, bot, ui } = await openGroupCard({ SOLANA_CHALLENGE_VIDEO: 'challenge-clip' });
    now += 59999; await ui.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    now += 1; await ui.render();
    let current = await store.get(g.id);
    expect(current.ui.messageId).not.toBe(g.ui.messageId);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', g.ui.messageId);
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
    expect(bot.telegram.sendVideo.mock.calls[1][2].reply_markup.inline_keyboard[0][0].url).toContain('soljoin_' + g.id);
    expect(current.expiresAt).toBe(g.expiresAt);
    expect(current.creator.deposit).toEqual(g.creator.deposit);
    const secondId = current.ui.messageId;
    const restarted = new SolanaInterface(bot, service, {}, { SOLANA_CHALLENGE_VIDEO: 'challenge-clip' });
    now += 59999; await restarted.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
    now += 1; await restarted.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(3);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', secondId);
    now = g.expiresAt; await restarted.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(3);
    await service.expire(); await restarted.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(4);
    expect(bot.telegram.sendVideo.mock.calls[3][2].caption).toContain('Challenge expired.');
    expect((await store.get(g.id)).status).toBe('CANCELLED');
    expect((await store.payments(g.id))[0].payment.amount).toBe('100000000');
  });
  test('acceptance stops scheduled reposts and removes the group button', async () => {
    const { g, bot, ui } = await openGroupCard();
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    now += 60000; await ui.render(); now += 60000; await ui.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    expect(bot.telegram.editMessageCaption).toHaveBeenLastCalledWith('-100', g.ui.messageId, undefined,
      expect.stringContaining('Waiting for challenger deposit'), expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
  });
  test('failed repost retains the card; deletion follows a saved replacement acknowledgement', async () => {
    const { g, bot, ui } = await openGroupCard(); now += 60000;
    bot.telegram.sendVideo.mockRejectedValueOnce(new Error('Telegram unavailable'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await ui.render(); } finally { log.mockRestore(); }
    expect((await store.get(g.id)).ui.messageId).toBe(g.ui.messageId);
    expect(bot.telegram.deleteMessage).not.toHaveBeenCalledWith('-100', g.ui.messageId);
    bot.telegram.deleteMessage.mockImplementation(async (chat, id) => {
      if (id === g.ui.messageId) expect((await store.get(g.id)).ui.messageId).not.toBe(id);
      return {};
    });
    await ui.render();
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', g.ui.messageId);
    expect((await store.get(g.id)).expiresAt).toBe(g.expiresAt);
  });
  test('acceptance during repost upload removes the new button and repairs the caption next pass', async () => {
    const { g, bot, ui } = await openGroupCard(); now += 60000;
    let acknowledge;
    bot.telegram.sendVideo.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const rendering = ui.render();
    for (let attempt = 0; !acknowledge && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(acknowledge).toEqual(expect.any(Function));
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    acknowledge({ message_id: 321, video: { file_id: 'challenge' } }); await rendering;
    expect(bot.telegram.editMessageReplyMarkup).toHaveBeenCalledWith('-100', 321, undefined, { inline_keyboard: [] });
    expect((await store.get(g.id)).ui.renderKey).toBeNull();
    await ui.render();
    expect(bot.telegram.editMessageCaption).toHaveBeenCalledWith('-100', 321, undefined,
      expect.stringContaining('Waiting for challenger deposit'), expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
  });
  test('expiry cleanup retries after refund confirmation and restart without reposting the expiry notice', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const { g, bot, ui } = await openGroupCard();
    now = g.expiresAt + 1; await service.expire();
    await store.saveSigned('refund:repost-creator', { signature: 'cleanup-refund' });
    await store.paymentState('refund:repost-creator', 'CONFIRMED');
    bot.telegram.deleteMessage.mockRejectedValueOnce(new Error('Transient deletion failure'));
    await ui.render();
    const expiry = await store.get(g.id);
    expect(expiry.ui.terminal).toBe(false); expect(expiry.ui.retiredMessageIds).toEqual([g.ui.messageId]);
    const restarted = new SolanaInterface(bot, service, {}); await restarted.render();
    expect((await store.get(g.id)).ui).toMatchObject({ terminal: true, retiredMessageIds: [] });
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
  });
  test('text-only challenge and expiry also move to new messages', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    ui.challengeVideo = () => null; ui.expiryVideo = () => null;
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'text-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; }); await ui.render();
    const firstId = (await store.get(g.id)).ui.messageId;
    now += 60000; await ui.render(); expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', firstId);
    const secondId = (await store.get(g.id)).ui.messageId;
    now = (await store.get(g.id)).expiresAt; await service.expire(); await ui.render(); await ui.render();
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(3);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', secondId);
    expect(bot.telegram.sendVideo).not.toHaveBeenCalled();
  });
  test('an existing waiting card starts a safe one-minute cadence after upgrading', async () => {
    const { g, bot, ui } = await openGroupCard();
    await store.mutate(g.id, game => { delete game.ui.groupPostedAt; });
    now += 60000; await ui.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    now += 60000; await ui.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
  });
  test('concurrent render calls produce a single scheduled repost', async () => {
    const { g, bot, ui } = await openGroupCard(); now += 60000;
    await Promise.all([ui.render(), ui.render(), ui.render()]);
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
    expect((await store.get(g.id)).ui.retiredMessageIds).toEqual([]);
  });

});
