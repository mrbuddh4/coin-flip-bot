// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana durable ledger on real PostgreSQL', () => {
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
    await pool.query('TRUNCATE "SolOutbox", "SolDeposits", "SolGames", "SolTokens", "SolProfiles", "SolSessions", "SolDrafts", "SolScanCursors", "SolDepositReviews", "SolFeeAccruals", "SolFeePools", "SolFeeCycles", "SolHolderLinks", "SolHolderChallenges", "SolMediaCache"');
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
  test('concurrent repeats consume one deposit and settle once, with exact balanced fees', async () => {
    const id = await joined();
    await Promise.all(Array.from({ length: 5 }, () => service.deposit({ id, userId: '1', signature: 'a' })));
    await Promise.all(Array.from({ length: 5 }, () => service.deposit({ id, userId: '2', signature: 'b' })));
    const g = await store.get(id);
    expect(g.status).toBe('SETTLED'); expect(g.prize).toBe('180000000');
    expect(g.fees).toMatchObject({ holder: '10000000', burn: '10000000' });
    expect(service.coin).toHaveBeenCalledTimes(1);
    expect(await store.payments(id)).toHaveLength(2);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM "SolDeposits"')).rows[0].count).toBe(2);
  });
  test('same transaction cannot fund a second game', async () => {
    const a = await service.create(input); const b = await service.create(input);
    await service.deposit({ id: a.id, userId: '1', signature: 'shared-proof' });
    const result = await service.deposit({ id: b.id, userId: '1', signature: 'shared-proof' });
    expect(result.creator.deposit).toBeUndefined();
  });
  test('underpayment and overpayment refund full amount and never mark funded', async () => {
    const g = await service.create(input);
    for (const [sig, amount] of [['under', 99999999n], ['over', 100000001n]]) {
      chain.verifyDeposit.mockResolvedValueOnce(amount);
      const result = await service.deposit({ id: g.id, userId: '1', signature: sig });
      expect(result.creator.deposit).toBeUndefined();
    }
    const rows = (await pool.query('SELECT payment FROM "SolOutbox" ORDER BY id')).rows;
    expect(rows.map(r => r.payment.amount).sort()).toEqual(['100000001', '99999999']);
    expect(rows.every(r => r.payment.recipient === walletA)).toBe(true);
  });
  test('simultaneous join admits one challenger', async () => {
    const g = await service.create(input);
    const results = await Promise.allSettled([
      service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId }),
      service.join({ id: g.id, userId: '3', wallet: walletB, chatId: input.chatId }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  test('cancel versus final deposit creates either one prize or two refunds, never both', async () => {
    const id = await joined();
    await service.deposit({ id, userId: '1', signature: 'a' });
    await Promise.allSettled([
      service.cancel({ id, userId: '1', chatId: input.chatId }),
      service.deposit({ id, userId: '2', signature: 'b' }),
    ]);
    const g = await store.get(id); const payments = await store.payments(id);
    if (g.status === 'CANCELLED') expect(payments).toHaveLength(2);
    else { expect(g.status).toBe('SETTLED'); expect(payments).toHaveLength(2); }
  });
  test('expiry survives restart and late deposits are fully refunded', async () => {
    const g = await service.create(input);
    await service.deposit({ id: g.id, userId: '1', signature: 'a' });
    now += 16 * 60 * 1000;
    const restarted = new SolanaService({ store, chain, now: () => now });
    await restarted.expire();
    await restarted.deposit({ id: g.id, userId: '1', signature: 'late' });
    expect((await store.get(g.id)).status).toBe('CANCELLED');
    expect(await store.payments(g.id)).toHaveLength(2);
    await restarted.expire();
    expect(await store.payments(g.id)).toHaveLength(2);
  });
  test('signed bytes are persisted before send; timeout and process restart never resign payout', async () => {
    const id = await funded();
    chain.broadcast.mockImplementationOnce(async payment => {
      const row = (await pool.query('SELECT * FROM "SolOutbox" WHERE signed->>\'signature\'=$1', [payment.signature])).rows[0];
      expect(row.status).toBe('SIGNED'); expect(row.signed).toEqual(payment);
      throw new Error('RPC response lost after send');
    });
    await service.work();
    const restarted = new SolanaService({ store, chain });
    await restarted.work();
    expect(chain.buildPayment).toHaveBeenCalledTimes(2);
    expect(chain.broadcast).toHaveBeenCalledTimes(4);
    expect(chain.broadcast.mock.calls[0][0]).toEqual(chain.broadcast.mock.calls[2][0]);
    chain.paymentStatus.mockResolvedValue('finalized');
    await restarted.work();
    expect((await store.payments(id))[0].status).toBe('CONFIRMED');
  });
  test('expired blockhash requires review instead of generating a replacement', async () => {
    const id = await funded();
    await service.work();
    chain.connection.getBlockHeight.mockResolvedValue(101);
    await service.work(); await service.work();
    expect((await store.payments(id))[0].status).toBe('REVIEW');
    expect(chain.buildPayment).toHaveBeenCalledTimes(2); expect(chain.broadcast).toHaveBeenCalledTimes(2);
  });
  test('on-chain failed payment goes to review and is not automatically retried', async () => {
    const id = await funded();
    chain.paymentStatus.mockResolvedValue('failed');
    await service.work(); await service.work();
    expect((await store.payments(id))[0].status).toBe('REVIEW');
    expect(chain.broadcast).not.toHaveBeenCalled();
  });
  test('duplicate extra deposit is refunded once; settled outcome never redrawn', async () => {
    const id = await funded();
    await service.deposit({ id, userId: '1', signature: 'extra' });
    await service.deposit({ id, userId: '1', signature: 'extra' });
    expect(await store.payments(id)).toHaveLength(3); expect(service.coin).toHaveBeenCalledTimes(1);
  });
  test('custom tokens persist exact case-sensitive mint independently of labels', async () => {
    await store.saveToken('1', { address: walletA, symbol: 'CUSTOM', decimals: 6 });
    expect(await store.tokens('1')).toEqual([{ address: walletA, symbol: 'CUSTOM', decimals: 6 }]);
  });
  test('UI games require creator funding before accept, then snapshot receiving wallets and timeouts', async () => {
    const receive = Keypair.fromSeed(Buffer.alloc(32, 11)).publicKey.toBase58();
    const g = await service.create({ ...input, receiveWallet: receive, interfaceVersion: 1 });
    expect(g.expiresAt - now).toBe(180000);
    await expect(service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId })).rejects.toThrow('not funded');
    await service.deposit({ id: g.id, userId: '1', signature: 'creator' });
    expect((await store.get(g.id)).expiresAt - now).toBe(240000);
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    expect((await store.get(g.id)).expiresAt - now).toBe(180000);
    await store.updateProfile('1', { receiveWallet: walletB });
    await service.deposit({ id: g.id, userId: '2', signature: 'challenger' });
    expect((await pool.query('SELECT payment FROM "SolOutbox" WHERE payment->>\'kind\'<>\'burn\'')).rows[0].payment.recipient).toBe(receive);
  });
  test('UI concurrent creation admits only one game per group and duplicate draft is idempotent', async () => {
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => service.create({ ...input, interfaceVersion: 1 })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const g = results.find(r => r.status === 'fulfilled').value;
    const retried = await service.create({ ...input, interfaceVersion: 1, gameId: g.id });
    expect(retried.creator.payToken).toBe(g.creator.payToken);
    expect(retried.id).toBe(g.id);
  });
  test('wrong supported token refunds the actual asset, preserving the intended wager', async () => {
    const g = await service.create(input);
    await service.deposit({ id: g.id, userId: '1', signature: 'wrong-mint', detectedMint: walletB });
    expect((await store.get(g.id)).creator.deposit).toBeUndefined();
    expect((await pool.query('SELECT payment FROM "SolOutbox" WHERE payment->>\'kind\'<>\'burn\'')).rows[0].payment).toMatchObject({ mint: walletB, amount: '100000000', recipient: walletA });
  });
  test('network identity cannot relabel occupied devnet records or change the signing wallet', async () => {
    const { DEVNET_GENESIS } = require('../src/solana/chain');
    const { NETWORKS } = require('../src/solana/network');
    await service.create(input);
    await expect(store.bindNetwork(NETWORKS['mainnet-beta'].genesis, chain.address)).rejects.toThrow('LEDGER_NETWORK');
    await store.bindNetwork(DEVNET_GENESIS, chain.address);
    await expect(store.bindNetwork(DEVNET_GENESIS, walletA)).rejects.toThrow('LEDGER_NETWORK');
    await expect(store.bindNetwork(NETWORKS['mainnet-beta'].genesis, chain.address)).rejects.toThrow('LEDGER_NETWORK');
    expect((await store.history('1')).length).toBe(1);
  });
  test('empty ledger can bind a deliberate mainnet identity without resetting anything', async () => {
    const { NETWORKS } = require('../src/solana/network');
    await store.bindNetwork(NETWORKS['mainnet-beta'].genesis, chain.address);
    const { rows } = await pool.query('SELECT genesis,wallet FROM "SolNetwork"');
    expect(rows[0]).toEqual({ genesis: NETWORKS['mainnet-beta'].genesis, wallet: chain.address });
  });
  test('profiles, drafts, sessions and scan progress persist and drafts remain user-owned', async () => {
    await store.updateProfile('1', { wallet: walletA });
    await store.updateProfile('1', { receiveWallet: walletB });
    expect(await store.profile('1')).toMatchObject({ wallet: walletA, receiveWallet: walletB });
    await store.setSession('1', { kind: 'create' });
    expect(await new SolanaStore(pool).session('1')).toEqual({ kind: 'create' });
    await store.draft('owned', '1', '-100');
    await expect(store.draft('owned', '2')).rejects.toThrow('belongs');
    await store.setCursor(walletA, 'cursor');
    expect(await new SolanaStore(pool).cursor(walletA)).toBe('cursor');
    await pool.query('UPDATE "SolSessions" SET "expiresAt"=now()-interval \'1 second\'');
    expect(await store.session('1')).toBeNull();
  });
  test('the shared bot wallet cannot be a player source or receiving wallet', async () => {
    await expect(service.create({ ...input, wallet: chain.address })).rejects.toThrow('player wallet');
    await expect(service.create({ ...input, receiveWallet: chain.address })).rejects.toThrow('player wallet');
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
  test('restored group/private buttons complete a SID game with saved wallets, automatic proof, animation and finalized payout', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const { SID_MINT } = require('../src/solana/featured');
    const { TOKEN_2022_PROGRAM_ID } = require('../src/solana/token');
    const bot = fakeBot(), scanner = { tick: jest.fn() };
    chain.env.SOLANA_CLUSTER = 'mainnet-beta'; // Offline UI test, no mainnet runtime or transaction.
    chain.tokenInfo.mockImplementation(async mint => mint === SID_MINT
      ? { address: mint, decimals: 6, symbol: 'SID', program: TOKEN_2022_PROGRAM_ID.toBase58() }
      : { address: 'NATIVE', decimals: 9, symbol: 'SOL' });
    const ui = new SolanaInterface(bot, service, scanner, { PUBLIC_BASE_URL: 'https://bot.example' });
    ui.videoDuration = 1000; ui.register();
    const group = context('1', '/flip', 'supergroup');
    await bot.handlers.flip(group);
    const url = group.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].url;
    const creator = context('1', '/start ' + url.split('?start=')[1]);
    await bot.handlers.start(creator);
    expect((await store.session('1')).field).toBe('wallet');
    await bot.handlers.text(context('1', walletA));
    expect((await store.session('1')).field).toBe('receiveWallet');
    await callback(bot, '1', 's:wallet:same');
    const select = await store.session('1');
    expect(select.tokens.map(t => t.symbol)).toEqual(['SOL', 'SID']);
    await callback(bot, '1', `s:token:1:${select.nonce}`);
    await bot.handlers.text(context('1', '100'));
    const [game] = await store.groupGames();
    expect(game.token.address).toBe(SID_MINT);
    expect(game.creator.receiveWallet).toBe(walletA);
    expect(game.wager).toBe('100000000');
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    const stale = await callback(bot, '1', `s:token:1:${select.nonce}`);
    expect((await store.profile('1')).privateScreen.text).toContain('could not be completed');
    await service.deposit({ id: game.id, userId: '1', signature: 'sid-creator' });
    await ui.render();
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    await callback(bot, '1', 's:check:' + game.id);
    expect(bot.telegram.sendMessage.mock.calls[0][1]).toContain('&lt;Alice&gt;');
    expect(bot.telegram.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].url).toContain('soljoin_');
    await store.updateProfile('2', { wallet: walletB, receiveWallet: walletB });
    await bot.handlers.start(context('2', '/start soljoin_' + game.id));
    const join = await store.session('2');
    expect(join.kind).toBe('join');
    const accepted = await callback(bot, '2', `s:accept:${join.nonce}`);
    expect((await store.profile('2')).privateScreen.text).toContain('Game memo');
    expect((await store.profile('2')).privateScreen.rows.flat().find(b => b.url).url).toContain('/pay/');
    expect((await store.profile('2')).privateScreen.rows.flat().find(b => b.copy_text?.text === game.depositAddress)).toBeDefined();
    scanner.tick.mockImplementationOnce(() => service.deposit({ id: game.id, userId: '2', signature: 'sid-challenger' }));
    await callback(bot, '2', 's:check:' + game.id);
    expect((await store.get(game.id)).status).toBe('SETTLED');
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    const flipping = bot.telegram.editMessageText.mock.calls.filter(c => String(c[0]) === '-100').at(-1)[3];
    expect(flipping).toContain('Flipping the coin'); expect(flipping).not.toContain('Winner:');
    chain.paymentStatus.mockResolvedValue('finalized');
    await service.work(); now += 1251; await ui.render();
    const result = bot.telegram.sendPhoto.mock.calls.at(-1)[2].caption;
    expect(result).toContain('Winner:'); expect(result).toContain('CONFIRMED'); expect(result).not.toContain('?cluster=devnet');
    const restarted = new SolanaInterface(bot, new SolanaService({ store, chain, now: () => now }), scanner);
    await restarted.render();
    expect(bot.telegram.sendVideo).toHaveBeenCalledTimes(1);
    expect((await store.get(game.id)).ui.terminal).toBe(true);
  });
  test('plain transfers require a unique historical request and consume a signature once', async () => {
    const g = await service.create({ ...input, interfaceVersion: 2 });
    const transaction = { blockTime: 2 };
    await service.deposit({ id: g.id, userId: '1', signature: 'plain-creator', transaction, noMemo: true });
    await service.deposit({ id: g.id, userId: '1', signature: 'plain-creator', transaction, noMemo: true });
    expect((await store.get(g.id)).creator.deposit.signature).toBe('plain-creator');
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM "SolDeposits"')).rows[0].n).toBe(1);
    expect(await store.payments(g.id)).toHaveLength(0);
    await expect(service.join({ id: g.id, userId: '2', wallet: walletB, chatId: '-100' })).rejects.toThrow('confirmed');
  });
  test('overlapping requests cannot claim a memo-free receipt, including when one request is cancelled', async () => {
    const a = await service.create(input), b = await service.create({ ...input, chatId: '-200' });
    await service.cancel({ id: b.id, userId: '1', chatId: '-200' });
    await expect(service.deposit({ id: a.id, userId: '1', signature: 'ambiguous', transaction: { blockTime: 2 }, noMemo: true })).rejects.toThrow('uniquely');
    expect((await store.get(a.id)).creator.deposit).toBeUndefined();
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM "SolDeposits"')).rows[0].n).toBe(0);
  });
  test('expired unique plain transfer is reconciled as one full refund, never a renewed wager', async () => {
    const g = await service.create({ ...input, interfaceVersion: 2 });
    now += 10 * 60 * 1000;
    await service.expire();
    const receipt = { id: g.id, userId: '1', signature: 'expired-plain', transaction: { blockTime: 2 }, noMemo: true };
    await service.deposit(receipt); await service.deposit(receipt);
    expect((await store.get(g.id)).status).toBe('CANCELLED');
    const rows = (await pool.query('SELECT payment FROM "SolOutbox"')).rows;
    expect(rows).toHaveLength(1); expect(rows[0].payment).toMatchObject({ kind: 'refund', amount: '100000000', recipient: walletA });
  });
  test('confirm cannot publish an unfunded challenge and strangers cannot trigger its checks', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const game = await service.create({ ...input, interfaceVersion: 2 });
    const bot = fakeBot(), scanner = { confirm: jest.fn() }, ui = new SolanaInterface(bot, service, scanner); ui.register();
    await callback(bot, '3', 's:check:' + game.id);
    expect(scanner.confirm).not.toHaveBeenCalled();
    const pending = await callback(bot, '1', 's:check:' + game.id);
    expect((await store.profile('1')).privateScreen.text).toContain('has not been matched');
    expect((await store.get(game.id)).ui.publishRequested).toBeUndefined();
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    await service.deposit({ id: game.id, userId: '1', signature: 'funded' });
    await callback(bot, '1', 's:check:' + game.id);
    await callback(bot, '1', 's:check:' + game.id);
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect((await store.get(game.id)).ui.publishRequested).toBe(true);
    await new SolanaInterface(bot, service, scanner).render();
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
  });
  test('private token menu rejects forwarded/stale selections, removes custom favorites and preserves SID', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const { SID_MINT } = require('../src/solana/featured');
    chain.env.SOLANA_CLUSTER = 'mainnet-beta';
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    await store.saveToken('1', { address: walletA, symbol: 'CUSTOM', decimals: 6 });
    await callback(bot, '1', 's:tokens');
    const state = await store.session('1');
    const other = await callback(bot, '2', `s:remove:2:${state.nonce}`);
    expect((await store.profile('2')).privateScreen.text).toContain('could not be completed');
    expect(await store.tokens('1')).toHaveLength(1);
    await callback(bot, '1', `s:remove:2:${state.nonce}`);
    expect(await store.tokens('1')).toHaveLength(0);
    const newer = await store.session('1');
    expect(newer.tokens[1].address).toBe(SID_MINT);
    await callback(bot, '1', `s:remove:1:${newer.nonce}`);
    expect((await store.session('1')).tokens[1].address).toBe(SID_MINT);
  });
  test('deleted group card is replaced, while ambiguous Telegram failures never cause an immediate duplicate', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const g = await service.create({ ...input, interfaceVersion: 1 });
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {});
    await ui.render();
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    await service.deposit({ id: g.id, userId: '1', signature: 'creator' });
    await ui.render();
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    await store.mutate(g.id, current => { current.creator.name = 'Updated creator'; });
    bot.telegram.editMessageText.mockRejectedValueOnce({ response: { description: 'Bad Request: message to edit not found' } });
    await ui.render();
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    bot.telegram.editMessageText.mockRejectedValueOnce(new Error('Connection lost'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await ui.render(); } finally { log.mockRestore(); }
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('custom-token favorites can be added through the menu, survive restart and be selected for a flip', async () => {
    const { SolanaInterface } = require('../src/solana/interface');
    const bot = fakeBot(), ui = new SolanaInterface(bot, service, {}); ui.register();
    chain.tokenInfo.mockImplementation(async mint => {
      if (mint !== walletB) throw new Error('Unsupported mint');
      return { address: mint, symbol: 'CUSTOM', decimals: 6 };
    });
    await callback(bot, '1', 's:tokens');
    const state = await store.session('1');
    await callback(bot, '1', `s:custom:${state.nonce}`);
    await bot.handlers.text(context('1', walletB));
    const restarted = new SolanaStore(pool);
    expect(await restarted.tokens('1')).toEqual([{ address: walletB, symbol: 'CUSTOM', decimals: 6 }]);
    expect(await restarted.tokens('2')).toEqual([]);
    await store.updateProfile('1', { wallet: walletA, receiveWallet: walletA });
    const group = context('1', '/flip', 'supergroup');
    await bot.handlers.flip(group);
    const url = group.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].url;
    await bot.handlers.start(context('1', '/start ' + url.split('?start=')[1]));
    const selection = await store.session('1');
    const index = selection.tokens.findIndex(t => t.address === walletB);
    expect(index).toBeGreaterThan(0);
    await callback(bot, '1', `s:token:${index}:${selection.nonce}`);
    await bot.handlers.text(context('1', '12.345678'));
    const [game] = await store.groupGames();
    expect(game.token.address).toBe(walletB); expect(game.wager).toBe('12345678');
    const extra = new SolanaInterface(fakeBot(), service, {});
    await extra.selectTokens(context('1'));
    const again = await store.session('1');
    expect(again.tokens.filter(t => t.address === walletB)).toHaveLength(1);
  });
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
    const { PaymentNotifications } = require('../src/solana/notifications');
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
    const notifier = new PaymentNotifications(store, bot.telegram); await notifier.tick();
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
    for (let n = 0; n < 5; n++) await notifier.tick();
    expect(bot.telegram.sendMessage.mock.calls.some(c => c[1].includes('Winner payout'))).toBe(true);
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
    await store.saveMedia('coinflip-video:TestCoinFlipBot', { fileId: 'stale' });
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

});
