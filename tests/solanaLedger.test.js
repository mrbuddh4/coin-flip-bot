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
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolOutbox", "SolDeposits", "SolGames", "SolTokens"');
    now = 1000;
    chain = {
      address: walletA,
      tokenInfo: jest.fn().mockResolvedValue({ address: 'NATIVE', symbol: 'SOL', decimals: 9 }),
      verifyDeposit: jest.fn().mockResolvedValue(100000000n),
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
    expect(await store.payments(id)).toHaveLength(1);
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
    else { expect(g.status).toBe('SETTLED'); expect(payments).toHaveLength(1); }
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
      const row = (await pool.query('SELECT * FROM "SolOutbox" WHERE "gameId"=$1', [id])).rows[0];
      expect(row.status).toBe('SIGNED'); expect(row.signed).toEqual(payment);
      throw new Error('RPC response lost after send');
    });
    await service.work();
    const restarted = new SolanaService({ store, chain });
    await restarted.work();
    expect(chain.buildPayment).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).toHaveBeenCalledTimes(2);
    expect(chain.broadcast.mock.calls[0][0]).toEqual(chain.broadcast.mock.calls[1][0]);
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
    expect(chain.buildPayment).toHaveBeenCalledTimes(1); expect(chain.broadcast).toHaveBeenCalledTimes(1);
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
    expect(await store.payments(id)).toHaveLength(2); expect(service.coin).toHaveBeenCalledTimes(1);
  });
  test('custom tokens persist exact case-sensitive mint independently of labels', async () => {
    await store.saveToken('1', { address: walletA, symbol: 'CUSTOM', decimals: 6 });
    expect(await store.tokens('1')).toEqual([{ address: walletA, symbol: 'CUSTOM', decimals: 6 }]);
  });
});
