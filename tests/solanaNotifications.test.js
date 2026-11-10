const { Pool } = require('pg');
const { Keypair } = require('@solana/web3.js');
const fs = require('node:fs');
const path = require('node:path');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { PaymentNotifications, noticeText } = require('../src/solana/notifications');
const { toUnits } = require('../src/solana/amounts');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const wallet = n => Keypair.fromSeed(Buffer.alloc(32, n)).publicKey.toBase58();
test('phone decimal input accepts .01 exactly and preserves precision/range checks', () => {
  expect(toUnits('.01', 9)).toBe(10000000n);
  expect(toUnits('0.01', 9)).toBe(10000000n);
  for (const text of ['.', '-.01', '1e-2', '.0000000001', '0']) expect(() => toUnits(text, 9)).toThrow();
});
test('wrong-asset refunds never use the game token decimals or pretend queued means confirmed', () => {
  const row = { game: { id: 'g', cluster: 'mainnet-beta', token: { address: 'NATIVE', symbol: 'SOL', decimals: 9 }, creator: {} }, event: { kind: 'refund', amount: '1234', mint: wallet(4), sourceWallet: wallet(2), recipient: wallet(3), status: 'SIGNED', signature: 'sig' } };
  const text = noticeText(row);
  expect(text).toContain('1234 atomic units'); expect(text).not.toContain('0.000001234 SOL');
  expect(text).toContain('not payment confirmation'); expect(text).toContain('/tx/sig'); expect(text).not.toContain('?cluster=devnet');
});
integration('automatic financial notices on real PostgreSQL', () => {
  let admin, pool, store, service, chain, schema, telegram, notifier, now;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url }); schema = `notices_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(pool); await store.prepareInterface();
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolOutbox", "SolDeposits", "SolGames", "SolNotificationDeliveries", "SolFeePools", "SolFeeAccruals", "SolHolderCustody", "SolHolderReserves"');
    now = 1000;
    chain = { address: wallet(9), env: { SOLANA_CLUSTER: 'mainnet-beta' }, tokenInfo: jest.fn().mockResolvedValue({ address: 'NATIVE', symbol: 'SOL', decimals: 9 }), verifyDeposit: jest.fn().mockResolvedValue(10000000n) };
    service = new SolanaService({ store, chain, now: () => now, coin: () => 0 });
    telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 42 }) };
    notifier = new PaymentNotifications(store, telegram);
  });
  const create = () => service.create({ userId: '1', chatId: '-100', wallet: wallet(1), mint: 'SOL', amount: '.01', interfaceVersion: 2, name: '<Alice>' });
  async function drain(n = 8) { for (let i = 0; i < n; i++) await notifier.tick(); }
  test('finalized deposit pushes to DM and original group without status/refresh or a published card', async () => {
    const game = await create();
    await notifier.tick(); expect(telegram.sendMessage).not.toHaveBeenCalled();
    await service.deposit({ id: game.id, userId: '1', signature: 'deposit-1' });
    await notifier.tick();
    expect(telegram.sendMessage.mock.calls.map(c => c[0]).sort()).toEqual(['-100', '1']);
    const text = telegram.sendMessage.mock.calls[0][1];
    expect(text).toContain('Deposit finalized'); expect(text).toContain('0.01 SOL'); expect(text).toContain('&lt;Alice&gt;'); expect(text).toContain('/tx/deposit-1');
    expect((await store.get(game.id)).ui.messageId).toBeUndefined();
    await service.deposit({ id: game.id, userId: '1', signature: 'deposit-1' });
    await new PaymentNotifications(store, telegram).tick(); expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });
  test('expired late refund is announced through SIGNED and CONFIRMED even when the old card is terminal', async () => {
    const game = await create(); now += 1000000;
    await service.deposit({ id: game.id, userId: '1', signature: 'late' });
    await store.mutate(game.id, g => { g.ui.terminal = true; });
    await drain(); expect(telegram.sendMessage.mock.calls.some(c => c[1].includes('full refund'))).toBe(true);
    await store.saveSigned('refund:late', { signature: 'refund-proof', raw: 'must-stay-private' });
    await drain();
    let group = telegram.sendMessage.mock.calls.filter(c => c[0] === '-100');
    expect(group.at(-1)[1]).toContain('awaiting finalized'); expect(group.at(-1)[1]).not.toContain('must-stay-private');
    await store.paymentState('refund:late', 'CONFIRMED'); await drain();
    group = telegram.sendMessage.mock.calls.filter(c => c[0] === '-100');
    expect(group.at(-1)[1]).toContain('Refund'); expect(group.at(-1)[1]).toContain('Finalized on-chain.'); expect(group.at(-1)[1]).toContain('/tx/refund-proof');
    const count = telegram.sendMessage.mock.calls.length;
    await new PaymentNotifications(store, telegram).tick(); expect(telegram.sendMessage).toHaveBeenCalledTimes(count);
    expect((await store.payments(game.id))[0].status).toBe('CONFIRMED');
  });
  test('blocked DM does not suppress group delivery, success is durable and failures back off', async () => {
    const game = await create(); await service.deposit({ id: game.id, userId: '1', signature: 'deposit' });
    telegram.sendMessage.mockImplementation(async chat => { if (chat === '1') throw new Error('Blocked'); return { message_id: 7 }; });
    await notifier.tick(); await notifier.tick();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT "chatId","deliveredAt",attempts FROM "SolNotificationDeliveries" ORDER BY "chatId"')).rows).toEqual(expect.arrayContaining([{ chatId: '-100', deliveredAt: expect.any(Date), attempts: 1 }, { chatId: '1', deliveredAt: null, attempts: 1 }]));
    telegram.sendMessage.mockResolvedValue({ message_id: 8 });
    await pool.query('UPDATE "SolNotificationDeliveries" SET "retryAt"=now()'); await notifier.tick();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(3);
  });
  test('all settled-game payment types go to both players and group, without premature confirmation', async () => {
    const game = await create(); await store.bindHolderWallet(wallet(8));
    await service.deposit({ id: game.id, userId: '1', signature: 'a' });
    await store.mutate(game.id, g => { g.ui.publishRequested = true; });
    await service.join({ id: game.id, userId: '2', wallet: wallet(2), chatId: '-100' });
    await service.deposit({ id: game.id, userId: '2', signature: 'b' });
    await drain();
    expect(telegram.sendMessage.mock.calls.some(c => c[1].includes('Winner payout'))).toBe(false);
    await store.mutate(game.id, g => { g.ui.resultAnnounced = true; });
    await drain();
    for (const chat of ['-100', '1', '2']) {
      const texts = telegram.sendMessage.mock.calls.filter(c => c[0] === chat).map(c => c[1]);
      expect(texts.some(t => t.includes('Winner payout') && t.includes('0.018 SOL'))).toBe(true);
      expect(texts.some(t => t.includes('Burn allocation') && t.includes('1nc1nerator'))).toBe(true);
      expect(texts.some(t => t.includes('Holder reserve transfer') && t.includes(wallet(8)) && t.includes('remain deferred'))).toBe(true);
      expect(texts.some(t => t.includes('Winner payout') && t.includes('Finalized on-chain.'))).toBe(false);
    }
    const rows = (await pool.query('SELECT id,payment FROM "SolOutbox"')).rows;
    for (const row of rows) { await store.saveSigned(row.id, { signature: 'proof-' + row.id }); await store.paymentState(row.id, 'CONFIRMED'); }
    await drain();
    for (const row of rows) expect(telegram.sendMessage.mock.calls.filter(c => c[1].includes('/tx/' + encodeURIComponent('proof-' + row.id)) && c[1].includes('Finalized on-chain.'))).toHaveLength(3);
  });
  test('notifications never create, sign, resend or change payments, and pending/review remain explicit', async () => {
    const game = await create(); now += 1000000;
    await service.deposit({ id: game.id, userId: '1', signature: 'd' }); await store.saveSigned('refund:d', { signature: 'unknown-signature', raw: 'secret' }); await store.paymentState('refund:d', 'REVIEW');
    const before = (await pool.query('SELECT * FROM "SolOutbox"')).rows;
    await drain();
    expect((await pool.query('SELECT * FROM "SolOutbox"')).rows).toEqual(before);
    expect(telegram.sendMessage.mock.calls.some(c => c[1].includes('Needs reconciliation'))).toBe(true);
    expect(telegram.sendMessage.mock.calls.every(c => !c[1].includes('secret'))).toBe(true);
  });
  test('Telegram retry_after delays the failed target and stops the current burst', async () => {
    const game = await create(); await service.deposit({ id: game.id, userId: '1', signature: 'd' });
    telegram.sendMessage.mockRejectedValueOnce({ response: { parameters: { retry_after: 90 } } });
    await notifier.tick(); expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const row = (await pool.query('SELECT EXTRACT(EPOCH FROM ("retryAt"-now()))::int AS seconds FROM "SolNotificationDeliveries"')).rows[0];
    expect(row.seconds).toBeGreaterThan(85);
  });
});
