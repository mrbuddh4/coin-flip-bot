// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana pending-payment diagnostics on real PostgreSQL', () => {
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
  async function joined() {
    const g = await service.create(input);
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    return g.id;
  }
  test('pending refund exposes an actionable reserve failure without signing or broadcasting', async () => {
    const g = await service.create(input);
    await service.deposit({ id: g.id, userId: '1', signature: 'blocked-refund' });
    await service.cancel({ id: g.id, userId: '1', chatId: input.chatId });
    chain.assertSolvent.mockRejectedValue(new Error('Token treasury does not cover all recorded liabilities'));
    await service.work();
    const payments = await store.payments(g.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'PENDING', signature: null });
    expect(payments[0].lastError).toContain('TREASURY_TOKEN_SHORTFALL at reserve-check');
    expect(chain.buildPayment).not.toHaveBeenCalled();
    expect(chain.broadcast).not.toHaveBeenCalled();
    const handlers = {};
    require('../src/solana/telegram').registerSolanaCommands({ command: (name, handler) => { handlers[name] = handler; } }, service);
    const ctx = { from: { id: 1 }, chat: { id: 1, type: 'private' }, message: { text: `/solstatus ${g.id}` }, reply: jest.fn() };
    await handlers.solstatus(ctx);
    expect(ctx.reply.mock.calls[0][0]).toContain('TREASURY_TOKEN_SHORTFALL at reserve-check');
  });
  test('payment rate limiting pauses the batch while expiry still runs, then resumes original queued payments', async () => {
    const id = await joined();
    await service.deposit({ id, userId: '1', signature: 'first-refund' });
    chain.verifyDeposit.mockResolvedValueOnce(50000000n);
    await service.deposit({ id, userId: '2', signature: 'second-refund' });
    await service.cancel({ id, userId: '1', chatId: input.chatId });
    chain.assertSolvent.mockRejectedValueOnce(new Error('429 Too Many Requests https://rpc.example/private-secret'));
    await service.work();
    expect(chain.assertSolvent).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).not.toHaveBeenCalled();
    const rows = await store.payments(id);
    expect(rows).toHaveLength(2);
    expect(rows.every(p => p.status === 'PENDING' && !p.signature)).toBe(true);
    expect(rows.find(p => p.lastError).lastError).toContain('RPC_RATE_LIMIT');
    expect(JSON.stringify(rows)).not.toContain('private-secret');
    const expiry = jest.spyOn(service, 'expire');
    await service.work();
    expect(expiry).toHaveBeenCalledTimes(1);
    expect(chain.assertSolvent).toHaveBeenCalledTimes(1);
    now += 5000;
    await service.work();
    expect(chain.buildPayment).toHaveBeenCalledTimes(2);
    expect(chain.broadcast).toHaveBeenCalledTimes(2);
    expect(service.paymentRateFailures).toBe(0);
    expect((await store.payments(id))).toHaveLength(2);
  });

});
