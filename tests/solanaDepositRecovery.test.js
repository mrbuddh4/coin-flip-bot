// Optional integration suite, run against a disposable local PostgreSQL server only.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Solana deposit recovery on real PostgreSQL', () => {
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
  function nativeScannerReceipt(sender, at, byte = 41, amount = 100000000, destination = chain.address) {
    const { PublicKey, SystemProgram } = require('@solana/web3.js');
    const signature = require('bs58').default.encode(Buffer.alloc(64, byte));
    const transaction = { blockTime: at, meta: { err: null, innerInstructions: [] }, transaction: {
      signatures: [signature], message: {
        accountKeys: [{ pubkey: new PublicKey(sender), signer: true }],
        instructions: [{ programId: SystemProgram.programId, parsed: { type: 'transfer', info: { source: sender, destination, lamports: amount } } }],
      },
    } };
    // Exercise the production cryptographic-layout verifier, not the suite's
    // usual mocked deposit amount. Network reads and broadcasts remain offline.
    const { SolanaChain } = require('../src/solana/chain');
    chain.verifyDeposit = SolanaChain.prototype.verifyDeposit.bind(chain);
    chain.connection.getSignaturesForAddress = jest.fn(async key => key.toBase58() === sender ? [{ signature, blockTime: at }] : []);
    chain.connection.getParsedTransaction = jest.fn().mockResolvedValue(transaction);
    return { signature, transaction };
  }
  test('real scanner and ledger confirm a challenger transfer then settle exactly once', async () => {
    const { DepositScanner } = require('../src/solana/scanner');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'creator-funded' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    const { signature } = nativeScannerReceipt(walletB, 2);
    await new DepositScanner(service).confirm(g.id, '2');
    await new DepositScanner(service).confirm(g.id, '2');
    const result = await store.get(g.id);
    expect(result.status).toBe('SETTLED');
    expect(result.challenger.deposit.signature).toBe(signature);
    expect(service.coin).toHaveBeenCalledTimes(1);
  });
  test.each(['inside', 'late', 'clock-margin'])('skipped %s-window challenger receipt is recovered after expiry and restart, refunded once, never flips', async timing => {
    const { DepositScanner } = require('../src/solana/scanner');
    now = Date.now();
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'creator-funded' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    const joined = await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    // Transfer landed after the request's deadline and an old scanner already
    // advanced beyond it. A routine incremental read cannot recover this.
    const at = timing === 'late' ? Math.ceil(joined.challenger.depositExpiresAt / 1000) + 1 : Math.floor(joined.challenger.joinedAt / 1000) + (timing === 'clock-margin' ? -1 : 2);
    const { signature } = nativeScannerReceipt(walletB, at);
    await store.setCursor(walletB, signature);
    const rawRead = chain.connection.getSignaturesForAddress;
    rawRead.mockImplementation(async (key, options) => key.toBase58() === walletB && !options.until ? [{ signature, blockTime: at }] : []);
    now = joined.challenger.depositExpiresAt + 50000;
    await service.expire();
    await new DepositScanner(service).tick();
    await new DepositScanner(service).tick();
    const result = await store.get(g.id);
    expect(result.status).toBe('CANCELLED');
    expect(result.challenger.deposit).toBeUndefined();
    expect(service.coin).not.toHaveBeenCalled();
    const payments = await store.payments(g.id);
    expect(payments.filter(p => p.payment.kind === 'refund')).toHaveLength(2);
    expect(payments.find(p => p.id === `refund:${signature}`).payment).toMatchObject({ recipient: walletB, amount: '100000000' });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM "SolDeposits" WHERE signature=$1', [signature])).rows[0].n).toBe(1);
    await service.work();
    expect(chain.broadcast).toHaveBeenCalledTimes(2);
  });
  test('ambiguous plain receipts wait for all requests to close, then refund without assigning a wager', async () => {
    const { DepositScanner } = require('../src/solana/scanner');
    const a = await service.create(input), b = await service.create({ ...input, chatId: '-200' });
    const { signature } = nativeScannerReceipt(walletA, 2);
    const scanner = new DepositScanner(service);
    await scanner.scan(walletA);
    expect((await pool.query('SELECT * FROM "SolDeposits"')).rowCount).toBe(0);
    await service.cancel({ id: a.id, userId: '1', chatId: '-100' });
    await scanner.confirm(b.id, '1');
    expect((await pool.query('SELECT * FROM "SolDeposits"')).rowCount).toBe(0);
    await service.cancel({ id: b.id, userId: '1', chatId: '-200' });
    await Promise.all([scanner.confirm(a.id, '1'), new DepositScanner(service).confirm(b.id, '1')]);
    expect((await pool.query('SELECT * FROM "SolOutbox" WHERE id=$1', [`refund:${signature}`])).rowCount).toBe(1);
    expect((await store.get(a.id)).creator.deposit).toBeUndefined();
    expect((await store.get(b.id)).creator.deposit).toBeUndefined();
    expect(service.coin).not.toHaveBeenCalled();
  });
  test('read-only diagnostic identifies a challenger timestamp outside its exact acceptance window without moving funds', async () => {
    const { traceDeposit } = require('../src/solana/depositTrace');
    const g = await service.create({ ...input, interfaceVersion: 2 });
    await service.deposit({ id: g.id, userId: '1', signature: 'creator-funded' });
    await store.mutate(g.id, game => { game.ui.publishRequested = true; });
    now = 100500;
    await service.join({ id: g.id, userId: '2', wallet: walletB, chatId: input.chatId });
    const { signature } = nativeScannerReceipt(walletB, 100);
    const result = await traceDeposit(service, '2', 'https://solscan.io/tx/' + signature);
    expect(result).toContain('(challenger)');
    expect(result).toContain('Exact plain-transfer matches: 0');
    expect(result).toContain('Inside window: NO');
    expect(result).toContain('Proof: valid direct deposit');
    expect(result).not.toContain(walletA);
    expect((await store.get(g.id)).status).toBe('OPEN');
    expect(await store.payments(g.id)).toHaveLength(0);
    expect(chain.broadcast).not.toHaveBeenCalled();
    expect(await traceDeposit(service, '2', 'bad')).toContain('public transaction signature');
  });
  test('refund recovery rejects wrong recipient and cannot refund an already consumed game payment', async () => {
    const g = await service.create(input);
    const bad = nativeScannerReceipt(walletA, 2, 42, 100000000, walletB);
    await service.cancel({ id: g.id, userId: '1', chatId: '-100' });
    await expect(service.recoverUnmatchedDeposit({ sender: walletA, mint: 'NATIVE', amount: '100000000', ...bad })).rejects.toThrow('recipient');
    expect(await store.payments(g.id)).toHaveLength(0);
    const receipt = nativeScannerReceipt(walletA, 2, 43);
    await service.deposit({ id: g.id, userId: '1', signature: receipt.signature, transaction: receipt.transaction, noMemo: true });
    await service.recoverUnmatchedDeposit({ sender: walletA, mint: 'NATIVE', amount: '100000000', ...receipt });
    expect(await store.payments(g.id)).toHaveLength(1);
  });
});
