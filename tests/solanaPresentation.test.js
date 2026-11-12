// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana presentation on real PostgreSQL', () => {
  let admin, pool, store, service, chain, schema;
  let now;
  const walletA = Keypair.fromSeed(Buffer.alloc(32, 6)).publicKey.toBase58();
  const walletB = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
  const input = { userId: '1', chatId: '-100', wallet: walletA, mint: 'SOL', amount: '0.1' };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url });
    schema = `sol_presentation_${Date.now()}`;
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
  async function presentationGame() {
    const game = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: game.id, userId: '1', signature: 'creator:' + game.id });
    await store.mutate(game.id, g => { g.ui.publishRequested = true; });
    await service.join({ id: game.id, userId: '2', wallet: walletB, chatId: '-100' });
    await service.deposit({ id: game.id, userId: '2', signature: 'challenger:' + game.id });
    return game;
  }
  test('slow video upload cannot reveal a winner through group, private status, statistics or automatic notices', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const game = await presentationGame();
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.videoDuration = 1000;
    let finishUpload, signalUpload;
    const uploadStarted = new Promise(resolve => { signalUpload = resolve; });
    bot.telegram.sendVideo.mockImplementationOnce(() => new Promise(resolve => { finishUpload = resolve; signalUpload(); }));
    const rendering = ui.render();
    await uploadStarted;
    expect(finishUpload).toBeDefined(); now += 120000;
    const ctx = context('1'); await ui.status(ctx, game.id);
    expect((await store.profile('1')).privateScreen.text).toContain('FLIPPING'); expect((await store.profile('1')).privateScreen.text).not.toContain('Winner:');
    const stats = context('1'); await ui.stats(stats); expect((await store.profile('1')).privateScreen.text).toContain('Flips: 0');
    const board = context('1'); await ui.leaderboard(board); expect((await store.profile('1')).privateScreen.text).toContain('No completed flips yet');
    expect(bot.telegram.sendMessage.mock.calls.some(c => c[1].includes('Winner payout'))).toBe(false);
    const restarted = new SolanaInterface(bot, service, {}); restarted.videoDuration = 1000;
    await restarted.render(); expect(bot.telegram.sendPhoto).not.toHaveBeenCalled(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    finishUpload({ message_id: 77, video: { file_id: 'saved-video' } }); await rendering;
    expect((await store.get(game.id)).ui.revealAt).toBe(now + 1250);
    await restarted.render(); expect(bot.telegram.sendPhoto).not.toHaveBeenCalled();
    now += 1251; await restarted.render();
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', 77);
    expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(bot.telegram.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(bot.telegram.sendPhoto.mock.invocationCallOrder[0]);
    expect(bot.telegram.sendPhoto.mock.calls[0][2].caption).toContain('Winner:');
    expect(bot.telegram.sendMessage.mock.calls.some(c => c[1].includes('Winner payout'))).toBe(false);
    expect(bot.telegram.sendPhoto.mock.calls[0][2].caption).toContain('Prize pending');
  });
  test('video ID and cleanup survive restart; the next flip uses cached video instead of another upload', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const game = await presentationGame();
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.videoDuration = 1000;
    await ui.render(); const playing = await store.get(game.id);
    expect(playing.ui.videoMessageId).toBeDefined(); expect(playing.ui.resultAnnounced).toBeUndefined();
    now += 1251; const restarted = new SolanaInterface(bot, service, {}); await restarted.render();
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', playing.ui.videoMessageId);
    expect((await store.get(game.id)).ui.resultAnnounced).toBe(true);
    await restarted.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1); expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    await presentationGame(); await restarted.render();
    expect(bot.telegram.sendVideo).toHaveBeenLastCalledWith('-100', 'cached-video', expect.any(Object));
  });
  test('a failed video cleanup retries without replaying animation or duplicating the result', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const game = await presentationGame(); const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.videoDuration = 1000;
    await ui.render(); const videoId = (await store.get(game.id)).ui.videoMessageId;
    bot.telegram.deleteMessage.mockRejectedValueOnce(new Error('temporary failure'));
    now += 1251; await ui.render();
    expect((await store.get(game.id)).ui.videoCleanupPending).toBe(true);
    await ui.render();
    expect((await store.get(game.id)).ui.videoDeleted).toBe(true);
    expect(bot.telegram.deleteMessage.mock.calls.filter(c => c[1] === videoId)).toHaveLength(2);
    expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
  });
  test('an explicitly rejected cached file is refreshed, while network ambiguity never triggers a second upload', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    await presentationGame(); const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.videoDuration = 1000;
    await store.saveMedia('coinflip-fast-v1-video:TestCoinFlipBot', { fileId: 'stale' });
    bot.telegram.sendVideo.mockRejectedValueOnce({ response: { error_code: 400 } });
    await ui.render(); expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
    expect(bot.telegram.sendVideo.mock.calls[0][1]).toBe('stale'); expect(bot.telegram.sendVideo.mock.calls[1][1]).toHaveProperty('source');
    now += 1251; await ui.render(); await presentationGame();
    bot.telegram.sendVideo.mockRejectedValueOnce(new Error('ambiguous timeout'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await ui.render(); } finally { log.mockRestore(); }
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(3);
  });
  test('phone amount entry accepts .01 and invalid amounts preserve the prompt', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    await store.updateProfile('1', { wallet: walletA, receiveWallet: walletA });
    const group = context('1', '/flip', 'supergroup');
    await bot.handlers.flip(group);
    const url = group.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].url;
    await bot.handlers.start(context('1', '/start ' + url.split('?start=')[1]));
    const state = await store.session('1');
    await callback(bot, '1', `s:token:0:${state.nonce}`);
    const invalid = context('1', '.'); await bot.handlers.text(invalid);
    expect((await store.profile('1')).privateScreen.text).toContain('Enter a positive amount');
    expect((await store.session('1')).step).toBe('amount');
    const entry = context('1', '.01'); await bot.handlers.text(entry);
    const [game] = await store.groupGames();
    expect(game.wager).toBe('10000000');
    expect((await store.profile('1')).privateScreen.text).toContain('Copy the deposit address');
    expect(await store.session('1')).toBeNull();
  });
  test('invalid custom mints never become favorites and paginated menus preserve exact selections', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    chain.tokenInfo.mockRejectedValue(new Error('Unsupported mint'));
    await callback(bot, '1', 's:tokens');
    let state = await store.session('1');
    await callback(bot, '1', `s:custom:${state.nonce}`);
    await bot.handlers.text(context('1', 'invalid-mint'));
    expect(await store.tokens('1')).toEqual([]);
    for (let n = 0; n < 25; n++) await store.saveToken('1', { address: String(n).padStart(2, '0'), symbol: `TEST${n}`, decimals: 6 });
    const first = await callback(bot, '1', 's:tokens');
    const rows = (await store.profile('1')).privateScreen.rows;
    expect(rows.filter(r => r.some(b => b.callback_data.startsWith('s:token:')))).toHaveLength(20);
    state = await store.session('1');
    const second = await callback(bot, '1', `s:page:1:${state.nonce}`);
    const nextRows = (await store.profile('1')).privateScreen.rows;
    expect(nextRows[0][0].callback_data).toMatch(/^s:token:20:/);
    expect((await store.session('1')).page).toBe(1);
  });

  test('real registered navigation edits one card, retires used group setup, and ignores a repeated callback', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    const first = context('1', '/start'); first.message.message_id = 50;
    await bot.handlers.start(first);
    const home = (await store.profile('1')).privateScreen;
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(1, 50);
    const pressed = context('1'); pressed.callbackQuery = { data: home.rows[0][0].callback_data, message: { message_id: home.messageId } };
    await bot.handlers.action(pressed);
    const wallets = (await store.profile('1')).privateScreen;
    expect(wallets.text).toContain('Your Solana Wallets');
    expect(pressed.reply).not.toHaveBeenCalled();
    const duplicate = context('1'); duplicate.callbackQuery = { data: home.rows[0][0].callback_data, message: { message_id: home.messageId } };
    await bot.handlers.action(duplicate);
    expect((await store.profile('1')).privateScreen.revision).toBe(wallets.revision);
    expect(duplicate.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('screen has changed'));
    const group = context('1', '/flip', 'supergroup'); await bot.handlers.flip(group);
    const url = group.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].url;
    const draftId = url.split('solcreate_')[1];
    // Another player cannot consume or remove the creator's setup card.
    await bot.handlers.start(context('2', '/start solcreate_' + draftId));
    expect((await store.draft(draftId, '1')).messageId).not.toBeNull();
    await bot.handlers.start(context('1', '/start solcreate_' + draftId));
    expect((await store.draft(draftId, '1')).messageId).toBeNull();
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', 100);
  });
  test('wallet input is consumed, active games resume, and cancellation needs explicit confirmation', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    await callback(bot, '1', 's:wallet:wallet');
    const entry = context('1', walletA); entry.message.message_id = 51; await bot.handlers.text(entry);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(1, 51);
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await ui.home(context('1'));
    expect((await store.profile('1')).privateScreen.rows.flat().find(b => b.callback_data.startsWith('s:status:' + g.id))).toBeDefined();
    await callback(bot, '1', 's:cancel:' + g.id);
    expect((await store.get(g.id)).status).toBe('OPEN');
    expect((await store.profile('1')).privateScreen.text).toContain('Cancel this challenge?');
    await callback(bot, '1', 's:cancelok:' + g.id);
    expect((await store.get(g.id)).status).toBe('CANCELLED');
  });
  test('worker updates the active deposit screen automatically without replacing Home or leaking an unrevealed winner', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await ui.depositMessage(context('1'), g);
    await service.deposit({ id: g.id, userId: '1', signature: 'auto-deposit' });
    await ui.refreshPrivateScreens();
    expect((await store.profile('1')).privateScreen.text).toContain('Creator funded: true');
    expect((await store.profile('1')).privateScreen.rows.flat().some(b => b.text === 'Post Funded Challenge')).toBe(true);
    const count = bot.telegram.editMessageText.mock.calls.length;
    await ui.refreshPrivateScreens(); expect(bot.telegram.editMessageText).toHaveBeenCalledTimes(count);
    await ui.home(context('1'));
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: '-100' });
    await ui.status(context('2'), g.id);
    await service.deposit({ id: g.id, userId: '2', signature: 'auto-challenger' });
    await ui.refreshPrivateScreens();
    expect((await store.profile('1')).privateScreen.text).toContain('Dashboard');
    expect((await store.profile('2')).privateScreen.text).toContain('FLIPPING');
    expect((await store.profile('2')).privateScreen.text).not.toContain('Winner:');
  });

  test('winner card contains short prize, burn and holder links and edits as transactions finalize', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    await store.bindHolderWallet(Keypair.fromSeed(Buffer.alloc(32, 21)).publicKey.toBase58());
    const g = await presentationGame(), bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.videoDuration = 1;
    await ui.render(); now += 252; await ui.render();
    const initial = bot.telegram.sendPhoto.mock.calls[0][2].caption;
    expect(initial).toContain('Prize pending'); expect(initial).toContain('Burn pending'); expect(initial).toContain('Holder fee pending');
    const payments = await store.payments(g.id);
    for (const p of payments) { await store.saveSigned(p.id, { signature: 'proof-' + p.id }); await store.paymentState(p.id, 'CONFIRMED'); }
    await ui.render();
    const final = bot.telegram.editMessageCaption.mock.calls.at(-1)[3];
    for (const label of ['Prize', 'Burn', 'Holder fee']) expect(final).toContain('>' + label + ' ✓</a>');
    expect(final.replace(/<[^>]*>/g, '')).not.toContain('https://');
    expect((await store.get(g.id)).ui.terminal).toBe(true);
  });
  test('cancelled card gets refund proofs automatically, including a late deposit after terminal status', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 }), bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    await service.deposit({ id: g.id, userId: '1', signature: 'refund-deposit' });
    await service.cancel({ id: g.id, userId: '1', chatId: '-100' });
    await ui.render();
    expect(bot.telegram.sendMessage.mock.calls[0][1]).toContain('Refund to 1: 0.1 SOL pending');
    await store.saveSigned('refund:refund-deposit', { signature: 'refund-tx' }); await store.paymentState('refund:refund-deposit', 'CONFIRMED');
    await ui.render();
    expect(bot.telegram.editMessageText.mock.calls.at(-1)[3]).toContain('>Refund to 1: 0.1 SOL ✓</a>');
    expect((await store.get(g.id)).ui.terminal).toBe(true);
    await service.deposit({ id: g.id, userId: '1', signature: 'late-extra-deposit' });
    expect((await store.get(g.id)).ui.terminal).toBe(false);
    await ui.render();
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.telegram.editMessageText.mock.calls.at(-1)[3]).toContain('Refund to 1: 0.1 SOL pending');
    await store.saveSigned('refund:late-extra-deposit', { signature: 'late-refund-tx' }); await store.paymentState('refund:late-extra-deposit', 'CONFIRMED');
    await ui.render(); expect(bot.telegram.editMessageText.mock.calls.at(-1)[3]).toContain('/tx/late-refund-tx');
  });
  test('upgrade cleanup keeps notice delivery history and financial facts while removing only obsolete message IDs', async () => {
    const { ObsoleteNoticeCleanup } = require('../src/solana/notifications');
    const g = await service.create(input); await service.deposit({ id: g.id, userId: '1', signature: 'old-receipt' });
    await pool.query('INSERT INTO "SolNotificationDeliveries" ("eventId","chatId","messageId","deliveredAt") VALUES ($1,$2,$3,now())', ['deposit:old-receipt', '-100', 800]);
    const telegram = { deleteMessage: jest.fn().mockResolvedValue({}), sendMessage: jest.fn() };
    const before = await store.get(g.id); await new ObsoleteNoticeCleanup(store, telegram).tick();
    expect(telegram.deleteMessage).toHaveBeenCalledWith('-100', 800); expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(await store.get(g.id)).toEqual(before);
    const row = (await pool.query('SELECT "messageId","cleanupState" FROM "SolNotificationDeliveries" WHERE "eventId"=$1', ['deposit:old-receipt'])).rows[0];
    expect(row).toEqual({ messageId: '800', cleanupState: 'REMOVED' });
  });

  test('independent connections race for one group slot, while other groups remain independent', async () => {
    const services = Array.from({ length: 12 }, () => new SolanaService({ store: new SolanaStore(pool), chain, now: () => now }));
    const races = await Promise.allSettled(services.map((s, i) => s.create({ ...input, userId: String(i + 10), interfaceVersion: 2 })));
    expect(races.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(races.filter(r => r.status === 'rejected').every(r => r.reason.message.includes('active challenge'))).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM "SolGames"')).rows[0].n).toBe(1);
    await expect(service.create({ ...input, chatId: '-200', interfaceVersion: 2 })).resolves.toHaveProperty('chatId', '-200');
  });
  test('group slot survives settlement and restart, releasing only after reveal and video cleanup', async () => {
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'slot-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    await service.deposit({ id: g.id, userId: '2', signature: 'slot-challenger' });
    const restarted = new SolanaService({ store: new SolanaStore(pool), chain, now: () => now });
    expect((await store.get(g.id)).status).toBe('SETTLED');
    await expect(restarted.create({ ...input, interfaceVersion: 2 })).rejects.toThrow('active challenge');
    await store.mutate(g.id, game => { game.ui.resultAnnounced = true; game.ui.videoCleanupPending = true; });
    await expect(restarted.create({ ...input, interfaceVersion: 2 })).rejects.toThrow('active challenge');
    await store.mutate(g.id, game => { game.ui.videoCleanupPending = false; });
    // Financial finality continues on the old result card without blocking a new flip.
    expect((await store.payments(g.id)).some(p => p.status === 'PENDING')).toBe(true);
    await expect(restarted.create({ ...input, interfaceVersion: 2 })).resolves.toHaveProperty('status', 'OPEN');
  });
  test('cancellation and expiry release the group slot without altering refunds', async () => {
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'slot-refund' });
    await service.cancel({ id: g.id, userId: '1', chatId: input.chatId });
    const next = await service.create({ ...input, interfaceVersion: 2 });
    now = next.expiresAt + 1; await service.expire();
    await expect(service.create({ ...input, interfaceVersion: 2 })).resolves.toHaveProperty('status', 'OPEN');
    expect(await store.payments(g.id)).toHaveLength(1);
    expect((await store.payments(g.id))[0].payment.kind).toBe('refund');
  });
  test('twenty simultaneous accepts reserve exactly one challenger and expose no loser deposit instruction', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'accept-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    const users = Array.from({ length: 20 }, (_, i) => ({ userId: String(i + 20), wallet: Keypair.fromSeed(Buffer.alloc(32, i + 30)).publicKey.toBase58() }));
    const results = await Promise.allSettled(users.map(player => new SolanaService({ store: new SolanaStore(pool), chain, now: () => now }).join({ ...player, id: g.id, chatId: input.chatId })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.message.includes('already accepted'))).toBe(true);
    const winner = users[results.findIndex(r => r.status === 'fulfilled')];
    const loser = users.find(u => u.userId !== winner.userId);
    const saved = await store.get(g.id);
    expect(saved.challenger.userId).toBe(winner.userId);
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    await bot.handlers.start(context(loser.userId, '/start soljoin_' + g.id));
    const screen = (await store.profile(loser.userId)).privateScreen;
    expect(screen.text).toContain('already accepted');
    expect(screen.text).not.toContain(g.depositAddress);
    expect(screen.rows.flat().some(b => b.copy_text)).toBe(false);
    expect((await store.get(g.id)).challenger).toEqual(saved.challenger);
  });
  test('busy group /flip explains the active game without creating a draft', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    const ctx = context('2', '/flip', 'supergroup'); await bot.handlers.flip(ctx);
    expect(ctx.reply.mock.calls[0][0]).toContain('active challenge');
    expect((await pool.query('SELECT count(*)::int AS n FROM "SolDrafts"')).rows[0].n).toBe(0);
  });

  test('challenge video carries Accept, edits its caption on accept, and is retired for the result', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}, { SOLANA_CHALLENGE_VIDEO: 'challenge-clip-file-id' });
    ui.videoDuration = 1000;
    await service.deposit({ id: g.id, userId: '1', signature: 'video-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await ui.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledWith('-100', 'challenge-clip-file-id', expect.objectContaining({
      caption: expect.stringContaining('Awaiting a challenger'),
      reply_markup: { inline_keyboard: [[expect.objectContaining({ text: 'Accept Challenge' })]] },
    }));
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    const cardId = (await store.get(g.id)).ui.messageId;
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    await ui.render();
    expect(bot.telegram.editMessageCaption).toHaveBeenCalledWith('-100', cardId, undefined, expect.stringContaining('Waiting for challenger deposit'), expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
    expect(bot.telegram.editMessageText).not.toHaveBeenCalled();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    await service.deposit({ id: g.id, userId: '2', signature: 'video-challenger' });
    await ui.render(); // Actual flip video is separate from the challenge teaser.
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
    now += 1251; await ui.render();
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', cardId);
    expect((await store.get(g.id)).ui.messageIsVideo).toBe(false);
    expect((await store.get(g.id)).ui.resultAnnounced).toBe(true);
    expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);
  });
  test('a cancelled challenge video remains one card with automatically updated refund proof', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}, { SOLANA_CHALLENGE_VIDEO: 'challenge-clip' });
    await service.deposit({ id: g.id, userId: '1', signature: 'cancel-video-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; }); await ui.render();
    await service.cancel({ id: g.id, userId: '1', chatId: input.chatId }); await ui.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    expect(bot.telegram.editMessageCaption.mock.calls.at(-1)[3]).toContain('Refund to 1: 0.1 SOL pending');
    expect(bot.telegram.editMessageCaption.mock.calls.at(-1)[4].reply_markup.inline_keyboard).toEqual([]);
    expect((await store.get(g.id)).cancelReason).toBe('CANCELLED');
    expect((await store.get(g.id)).ui.expiryVideoApplied).toBeUndefined();
  });

  test('expiry posts a fresh video, deletes the old challenge and keeps refund proofs after restart', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    bot.telegram.editMessageMedia = jest.fn().mockResolvedValue({});
    await service.deposit({ id: g.id, userId: '1', signature: 'expiry-creator' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await ui.render(); const cardId = (await store.get(g.id)).ui.messageId;
    now = (await store.get(g.id)).expiresAt + 1; await service.expire(); await ui.render();
    expect(bot.telegram.sendVideo).toHaveBeenLastCalledWith('-100', { source: path.join(__dirname, '../assets/expired.mp4') }, expect.objectContaining({
      caption: expect.stringContaining('Challenge expired.'), reply_markup: { inline_keyboard: [] },
    }));
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', cardId);
    const expiryId = (await store.get(g.id)).ui.messageId;
    expect(expiryId).not.toBe(cardId);
    expect((await store.get(g.id)).cancelReason).toBe('EXPIRED');
    expect((await store.get(g.id)).ui).toMatchObject({ messageId: expiryId, messageIsVideo: true, expiryVideoApplied: true, expiryAnnounced: true });
    await store.saveSigned('refund:expiry-creator', { signature: 'expiry-refund-tx' });
    await store.paymentState('refund:expiry-creator', 'CONFIRMED');
    const restarted = new SolanaInterface(bot, new SolanaService({ store, chain, now: () => now }), {});
    await restarted.render(); await restarted.render();
    expect(bot.telegram.editMessageCaption.mock.calls.at(-1)[3]).toContain('/tx/expiry-refund-tx');
    expect(bot.telegram.editMessageMedia).not.toHaveBeenCalled();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(2);
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
  });
  test('failed expiry send preserves the old card, then retires it after a successful retry', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    await service.deposit({ id: g.id, userId: '1', signature: 'expiry-retry' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; }); await ui.render();
    const cardId = (await store.get(g.id)).ui.messageId;
    now = (await store.get(g.id)).expiresAt + 1; await service.expire();
    bot.telegram.sendVideo.mockRejectedValueOnce(new Error('Connection lost'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await ui.render(); } finally { log.mockRestore(); }
    expect((await store.get(g.id)).ui.expiryAnnounced).toBeUndefined();
    expect((await store.get(g.id)).ui.messageId).toBe(cardId);
    expect(bot.telegram.deleteMessage).not.toHaveBeenCalledWith('-100', cardId);
    await ui.render(); await ui.render();
    expect((await store.get(g.id)).ui).toMatchObject({ expiryAnnounced: true, expiryVideoApplied: true });
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith('-100', cardId);
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(3);
  });
  test('a late expiry deposit produces a single expiry card and full refund while unfunded drafts stay quiet', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    now = (await store.get(g.id)).expiresAt + 1; await service.expire(); await ui.render();
    expect(bot.telegram.sendVideo).not.toHaveBeenCalled();
    await service.deposit({ id: g.id, userId: '1', signature: 'late-expiry-video' });
    await ui.render(); await ui.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    expect(bot.telegram.sendVideo.mock.calls[0][2].caption).toContain('Challenge expired.');
    expect(bot.telegram.sendVideo.mock.calls[0][2].caption).toContain('Refund to 1: 0.1 SOL pending');
    expect((await store.payments(g.id))[0].payment).toMatchObject({ kind: 'refund', amount: '100000000' });
  });


});
