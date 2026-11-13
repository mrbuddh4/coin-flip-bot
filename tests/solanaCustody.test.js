const { Keypair, PublicKey } = require('@solana/web3.js');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { SolanaFees } = require('../src/solana/fees');
const { SolanaInterface } = require('../src/solana/interface');
const { holderWallet } = require('../src/solana/custody');
const token = require('../src/solana/token');
const key = n => Keypair.fromSeed(Buffer.alloc(32, n)).publicKey.toBase58();
const treasury = key(41), vault = key(42), alice = key(43), bob = key(44), mint = key(45), mint2022 = key(46);

test('separate custody requires a distinct, on-curve public wallet and deferred rewards, no new key', () => {
  expect(holderWallet({})).toBeNull();
  expect(holderWallet({ SOLANA_HOLDER_WALLET_ADDRESS: vault, SOLANA_WALLET_ADDRESS: treasury })).toBe(vault);
  expect(() => holderWallet({ SOLANA_HOLDER_WALLET_ADDRESS: treasury, SOLANA_WALLET_ADDRESS: treasury })).toThrow('differ');
  expect(() => holderWallet({ SOLANA_HOLDER_WALLET_ADDRESS: 'invalid' })).toThrow();
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('test')], token.TOKEN_PROGRAM_ID);
  expect(() => holderWallet({ SOLANA_HOLDER_WALLET_ADDRESS: pda.toBase58() })).toThrow('on-curve');
  expect(() => holderWallet({ SOLANA_HOLDER_WALLET_ADDRESS: vault, SOLANA_HOLDER_REWARDS: 'paxeer' })).toThrow('deferred');
});

const url = process.env.SOLANA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('separate holder custody on real PostgreSQL', () => {
  let admin, pool, store, chain, service, fees, schema;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Disposable local DB only');
    admin = new Pool({ connectionString: url }); schema = `custody_test_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(pool); await store.prepareInterface();
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolHolderCustody", "SolHolderReserves", "SolFeeCycles", "SolFeePools", "SolFeeAccruals", "SolHolderChallenges", "SolHolderLinks", "SolOutbox", "SolDeposits", "SolGames"');
    chain = {
      address: treasury, env: { SOLANA_CLUSTER: 'mainnet-beta' },
      tokenInfo: jest.fn(async address => address === 'SOL' || address === 'NATIVE' ? { address: 'NATIVE', decimals: 9, symbol: 'SOL' } : { address, decimals: 6, symbol: 'TEST', program: (address === mint2022 ? token.TOKEN_2022_PROGRAM_ID : token.TOKEN_PROGRAM_ID).toBase58() }),
      verifyDeposit: jest.fn(async ({ mint: address }) => address === 'NATIVE' ? 1000000000n : 1000000n),
      validate: jest.fn(async () => 'mainnet'), assertSolvent: jest.fn(async () => {}),
      buildPayment: jest.fn(async p => ({ signature: `signature-${p.id}`, raw: `signed-${p.id}`, lastValidBlockHeight: 100 })),
      paymentStatus: jest.fn(async () => 'unknown'), broadcast: jest.fn(async () => {}),
      connection: { getBlockHeight: jest.fn(async () => 50) },
    };
    fees = new SolanaFees({ store, chain });
    service = new SolanaService({ store, chain, coin: () => 0 }); service.feeService = fees;
  });
  async function settle(asset = 'SOL', amount = '1') {
    const g = await service.create({ userId: '1', chatId: '-1', wallet: alice, mint: asset, amount });
    await service.join({ id: g.id, userId: '2', chatId: '-1', wallet: bob });
    const a = { id: g.id, userId: '1', signature: `${g.id}:a` }, b = { id: g.id, userId: '2', signature: `${g.id}:b` };
    await Promise.all([service.deposit(a), service.deposit(b), service.deposit(a), service.deposit(b)]);
    return g.id;
  }
  const outbox = async () => (await pool.query('SELECT * FROM "SolOutbox" ORDER BY id')).rows;
  test.each(['SOL', mint, mint2022])('duplicate concurrent deposits queue exactly one 5%% vault transfer for %s', async asset => {
    await store.bindHolderWallet(vault);
    const id = await settle(asset);
    const payments = await outbox(), reserve = payments.find(p => p.payment.kind === 'holder-reserve');
    const wager = asset === 'SOL' ? 1000000000n : 1000000n;
    expect(payments.map(p => p.payment.kind).sort()).toEqual(['burn', 'holder-reserve', 'prize']);
    expect(payments.reduce((n, p) => n + BigInt(p.payment.amount), 0n)).toBe(wager * 2n);
    expect(reserve.payment).toMatchObject({ id: `holder-reserve:${id}`, recipient: vault, sourceWallet: treasury, amount: (wager / 10n).toString() });
    if (asset !== 'SOL') expect(reserve.payment.token.program).toBe((asset === mint2022 ? token.TOKEN_2022_PROGRAM_ID : token.TOKEN_PROGRAM_ID).toBase58());
    expect((await pool.query('SELECT * FROM "SolFeeAccruals"')).rowCount).toBe(1);
    expect((await pool.query('SELECT * FROM "SolFeePools"')).rowCount).toBe(0);
    expect((await store.holderCustody()).reserves).toEqual([]);
    expect(await store.liabilities()).toEqual([{ mint: asset === 'SOL' ? 'NATIVE' : asset, amount: (wager * 2n).toString() }]);
    expect(await store.payments(id)).toHaveLength(3);
    await fees.tick(); expect((await outbox()).some(p => p.payment.kind === 'holder')).toBe(false);
  });
  test('finalized confirmation atomically moves liability location and concurrent rechecks never double-credit', async () => {
    await store.bindHolderWallet(vault); const id = await settle();
    await store.saveSigned(`holder-reserve:${id}`, { signature: 'original', raw: 'bytes', lastValidBlockHeight: 1 });
    chain.paymentStatus.mockResolvedValue('finalized');
    await Promise.all([service.recheckPayment(`holder-reserve:${id}`), service.recheckPayment(`holder-reserve:${id}`)]);
    const restarted = new SolanaStore(pool);
    await restarted.paymentState(`holder-reserve:${id}`, 'CONFIRMED');
    await restarted.paymentState(`holder-reserve:${id}`, 'REVIEW');
    const custody = await restarted.holderCustody();
    expect(custody.wallet).toBe(vault);
    expect(custody.reserves).toMatchObject([{ mint: 'NATIVE', wallet: vault, amount: '100000000' }]);
    expect(custody.transfers[0].status).toBe('CONFIRMED');
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '1900000000' }]);
    expect(chain.buildPayment).not.toHaveBeenCalled(); expect(chain.broadcast).not.toHaveBeenCalled();
  });
  test('large SPL reserve amounts survive PostgreSQL JSON output without floating-point rounding', async () => {
    await store.bindHolderWallet(vault);
    chain.verifyDeposit.mockResolvedValue(90071992547409931n);
    const id = await settle(mint, '90071992547.409931');
    await store.paymentState(`holder-reserve:${id}`, 'CONFIRMED');
    expect((await store.holderCustody()).reserves[0].amount).toBe('9007199254740993');
    expect(await store.liabilities()).toEqual([{ mint, amount: (90071992547409931n * 2n - 9007199254740993n).toString() }]);
  });
  test.each(['expired', 'failed'])('unknown/retried and %s reserve transfers keep exact bytes and remain treasury obligations', async outcome => {
    await store.bindHolderWallet(vault); const id = await settle();
    await service.work();
    const restarted = new SolanaService({ store: new SolanaStore(pool), chain });
    await restarted.work();
    expect(chain.buildPayment.mock.calls.filter(([p]) => p.kind === 'holder-reserve')).toHaveLength(1);
    const signature = `signature-holder-reserve:${id}`;
    const sends = chain.broadcast.mock.calls.filter(([p]) => p.signature === signature);
    expect(sends).toHaveLength(2); expect(sends[0][0]).toEqual(sends[1][0]);
    if (outcome === 'expired') chain.connection.getBlockHeight.mockResolvedValue(101);
    else chain.paymentStatus.mockImplementation(async sig => sig === signature ? 'failed' : 'unknown');
    await restarted.work();
    expect((await outbox()).find(p => p.id === `holder-reserve:${id}`).status).toBe('REVIEW');
    expect((await store.holderCustody()).reserves).toEqual([]);
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '2000000000' }]);
    chain.paymentStatus.mockResolvedValue('finalized');
    await restarted.recheckPayment(`holder-reserve:${id}`);
    expect((await store.holderCustody()).reserves[0].amount).toBe('100000000');
    expect(chain.buildPayment.mock.calls.filter(([p]) => p.kind === 'holder-reserve')).toHaveLength(1);
  });
  test('existing unallocated fees sweep once across concurrent workers, without replaying prizes or burns', async () => {
    const id = await settle();
    const before = await store.liabilities();
    await store.bindHolderWallet(vault);
    await Promise.all([store.queueHolderReserves(treasury), new SolanaStore(pool).queueHolderReserves(treasury)]);
    const payments = await outbox();
    expect(payments).toHaveLength(3);
    expect(payments.filter(p => p.payment.kind === 'holder-reserve')).toMatchObject([{ payment: { gameId: id, amount: '100000000', recipient: vault } }]);
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('0');
    expect(await store.liabilities()).toEqual(before);
    expect((await store.holderCustody()).reserves).toEqual([]);
  });
  test('aggregate legacy pools larger than u64 split without losing units', async () => {
    await settle(); const max = 18446744073709551615n;
    await pool.query('UPDATE "SolFeePools" SET amount=$1', [(max + 17n).toString()]);
    await store.bindHolderWallet(vault);
    await store.queueHolderReserves(treasury); await store.queueHolderReserves(treasury); await store.queueHolderReserves(treasury);
    const payments = (await outbox()).filter(p => p.payment.kind === 'holder-reserve');
    expect(payments).toHaveLength(2);
    expect(payments.map(p => p.payment.amount).sort()).toEqual(['17', max.toString()].sort());
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('0');
  });
  test('a wrong-wallet retained pool rolls back the entire sweep with no lost or duplicate reserves', async () => {
    await settle(); await settle(mint);
    await pool.query('UPDATE "SolFeePools" SET "sourceWallet"=$1 WHERE mint=$2', [bob, mint]);
    await store.bindHolderWallet(vault);
    const before = await store.liabilities();
    await expect(store.queueHolderReserves(treasury)).rejects.toThrow('another treasury');
    expect((await outbox()).filter(p => p.payment.kind === 'holder-reserve')).toHaveLength(0);
    expect(await store.liabilities()).toEqual(before);
  });
  test('allocated legacy holder payments retain their original source and recipient', async () => {
    const id = await settle();
    await pool.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3)', ['old-holder', id, JSON.stringify({ id: 'old-holder', gameId: id, kind: 'holder', mint: 'NATIVE', amount: '20000000', sourceWallet: treasury, recipient: alice })]);
    await pool.query('UPDATE "SolFeePools" SET amount=amount-20000000');
    await store.bindHolderWallet(vault); await store.queueHolderReserves(treasury);
    const payments = await outbox();
    expect(payments.find(p => p.id === 'old-holder').payment).toMatchObject({ sourceWallet: treasury, recipient: alice, amount: '20000000' });
    expect(payments.find(p => p.payment.kind === 'holder-reserve').payment.amount).toBe('80000000');
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '2000000000' }]);
  });
  test('recorded custody cannot be removed or redirected by changing configuration', async () => {
    await store.bindHolderWallet(vault); await settle();
    await expect(store.bindHolderWallet(null)).rejects.toThrow('removing or changing');
    await expect(store.bindHolderWallet(alice)).rejects.toThrow('removing or changing');
    await new SolanaStore(pool).bindHolderWallet(vault);
    expect((await store.holderCustody()).wallet).toBe(vault);
    fees.mode = 'paxeer';
    await expect(fees.distribute()).rejects.toThrow('distributions deferred');
  });
  test('reserve bookkeeping failure rolls back confirmation and preserves the treasury obligation', async () => {
    await store.bindHolderWallet(vault); const id = await settle();
    await pool.query('INSERT INTO "SolHolderReserves" (mint,wallet,token,amount) VALUES ($1,$2,$3,$4)', ['NATIVE', bob, JSON.stringify({ address: 'NATIVE', decimals: 9 }), '1']);
    await expect(store.paymentState(`holder-reserve:${id}`, 'CONFIRMED')).rejects.toThrow('conflict');
    expect((await outbox()).find(p => p.id === `holder-reserve:${id}`).status).toBe('PENDING');
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '2000000000' }]);
    expect((await store.holderCustody()).reserves[0].amount).toBe('1');
  });
  test('insufficient treasury coverage cannot sign a reserve transfer or consume player funds', async () => {
    await store.bindHolderWallet(vault); await settle();
    chain.assertSolvent.mockRejectedValue(new Error('shortfall'));
    await service.work();
    expect(chain.buildPayment).not.toHaveBeenCalled(); expect(chain.broadcast).not.toHaveBeenCalled();
    expect((await outbox()).every(p => p.status === 'PENDING')).toBe(true);
    expect((await store.holderCustody()).reserves).toEqual([]);
  });
  test('retained-pool reconciliation failure cannot starve already-signed transfers', async () => {
    const id = await settle();
    await store.saveSigned(`prize:${id}`, { signature: 'existing-prize', raw: 'original', lastValidBlockHeight: 100 });
    await pool.query('UPDATE "SolFeePools" SET "sourceWallet"=$1', [bob]);
    await store.bindHolderWallet(vault);
    chain.paymentStatus.mockResolvedValue('finalized');
    await service.work();
    expect((await outbox()).find(p => p.id === `prize:${id}`).status).toBe('CONFIRMED');
    expect(service.custodyError).toContain('remain reserved');
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('100000000');
  });
  test('fee menu separates pending custody from finalized reserves and never calls a transfer a holder payout', async () => {
    await store.bindHolderWallet(vault); const id = await settle();
    const ui = new SolanaInterface({ telegram: {} }, service, {}), ctx = { from: { id: 1 }, reply: jest.fn() };
    await ui.fees(ctx);
    expect(ctx.reply.mock.calls[0][0]).toContain(vault);
    expect(ctx.reply.mock.calls[0][0]).toContain('not a payout to holders');
    expect(ctx.reply.mock.calls[0][0]).toContain('No confirmed transfers yet.');
    expect(ctx.reply.mock.calls[0][0]).toContain('PENDING');
    expect(JSON.stringify(ctx.reply.mock.calls[0][1])).not.toContain('s:holder');
    await store.paymentState(`holder-reserve:${id}`, 'CONFIRMED');
    await ui.fees(ctx);
    expect(ctx.reply.mock.calls[1][0]).toContain('0.1 SOL');
    expect(ctx.reply.mock.calls[1][0]).toContain('CONFIRMED');
    expect(ctx.reply.mock.calls[1][0]).toContain('distributions are deferred');
  });
});
