const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { reconcileExternalRefund, verifyReturn, refundFailure } = require('../src/solana/refundReconciliation');
const spl = require('../src/solana/token');
const treasury = Keypair.fromSeed(Buffer.alloc(32, 51)).publicKey.toBase58();
const recipient = Keypair.fromSeed(Buffer.alloc(32, 52)).publicKey.toBase58();
const token = { address: Keypair.fromSeed(Buffer.alloc(32, 53)).publicKey.toBase58(), program: spl.TOKEN_2022_PROGRAM_ID.toBase58(), decimals: 6, symbol: 'TEST' };
const depositSignature = bs58.encode(Buffer.alloc(64, 54));
const returnSignature = bs58.encode(Buffer.alloc(64, 55));
const proof = { returnSignature, treasury, recipient, depositTime: 1 };
function transfer(amount = '15215140000') {
  const source = spl.getAssociatedTokenAddressSync(new PublicKey(token.address), new PublicKey(treasury), spl.TOKEN_2022_PROGRAM_ID).toBase58();
  const target = spl.getAssociatedTokenAddressSync(new PublicKey(token.address), new PublicKey(recipient), spl.TOKEN_2022_PROGRAM_ID).toBase58();
  const b = (index, owner, value) => ({ accountIndex: index, owner, mint: token.address, uiTokenAmount: { amount: String(value), decimals: 6 } });
  return {
    blockTime: 2,
    transaction: { signatures: [returnSignature], message: {
      accountKeys: [{ pubkey: new PublicKey(treasury), signer: true }, { pubkey: new PublicKey(source), signer: false }, { pubkey: new PublicKey(target), signer: false }],
      instructions: [{ programId: spl.TOKEN_2022_PROGRAM_ID, parsed: { type: 'transferChecked', info: { source, destination: target, mint: token.address, multisigAuthority: treasury, signers: [treasury], tokenAmount: { amount, decimals: 6 } } } }],
    } },
    meta: { err: null, innerInstructions: [], preTokenBalances: [b(1, treasury, 20000000000n), b(2, recipient, 100n)], postTokenBalances: [b(1, treasury, 20000000000n - BigInt(amount)), b(2, recipient, 100n + BigInt(amount))] },
  };
}
describe('manual token return proof', () => {
  test('diagnostics expose only a known stage and safe reason, never raw private endpoints', () => {
    const error = Object.assign(new Error('429 https://rpc.example/private-key'), { reconciliationStage: 'deposit-fetch' });
    expect(refundFailure(error)).toMatchObject({ stage: 'deposit-fetch', code: 'RPC_RATE_LIMIT' });
    expect(JSON.stringify(refundFailure(error))).not.toMatch(/rpc\.example|private-key/);
    error.reconciliationStage = 'https://private-stage';
    expect(refundFailure(error).stage).toBe('prepare');
  });
  test('accepts the exact direct self-signed Token-2022 transfer and amount', () => {
    expect(verifyReturn(transfer(), proof, token)).toBe(15215140000n);
  });
  test.each([
    ['failed', t => { t.meta.err = { InstructionError: [0, 'error'] }; }],
    ['wrong signature', t => { t.transaction.signatures = ['other']; }],
    ['wrong signer', t => { t.transaction.message.accountKeys[0].signer = false; }],
    ['earlier transfer', t => { t.blockTime = 0; }],
    ['unavailable time', t => { t.blockTime = null; }],
    ['inner transfer', t => { t.meta.innerInstructions = [{ instructions: [{}] }]; }],
    ['bot memo', t => { t.transaction.message.instructions.push({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), parsed: 'coinflip:other' }); }],
    ['wrong mint', t => { t.transaction.message.instructions[0].parsed.info.mint = treasury; }],
    ['wrong token program', t => { t.transaction.message.instructions[0].programId = spl.TOKEN_PROGRAM_ID; }],
    ['wrong destination', t => { t.transaction.message.instructions[0].parsed.info.destination = treasury; }],
    ['wrong source', t => { t.transaction.message.instructions[0].parsed.info.source = recipient; }],
    ['wrong owner', t => { t.meta.postTokenBalances[1].owner = treasury; }],
    ['wrong balance delta', t => { t.meta.postTokenBalances[1].uiTokenAmount.amount = '1'; }],
    ['wrong decimals', t => { t.transaction.message.instructions[0].parsed.info.tokenAmount.decimals = 9; }],
  ])('rejects %s', (_, edit) => {
    const tx = transfer(); edit(tx);
    expect(() => verifyReturn(tx, proof, token)).toThrow();
  });
});
const url = process.env.SOLANA_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('manual refund reconciliation on real PostgreSQL', () => {
  let admin, pool, store, service, chain, schema, game, now;
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Use a disposable local PostgreSQL server only');
    admin = new Pool({ connectionString: url }); schema = `refund_test_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(pool); await store.prepareInterface();
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolExternalRefunds", "SolOutbox", "SolDeposits", "SolGames", "SolTokens" CASCADE');
    now = 1000;
    chain = { address: treasury, env: { SOLANA_CLUSTER: 'devnet', ADMIN_IDS: '1' }, tokenInfo: jest.fn(async () => token), validate: jest.fn(async () => {}), verifyDeposit: jest.fn(async () => 15215141456n), connection: {
      getParsedTransaction: jest.fn(async sig => sig === returnSignature ? transfer() : { blockTime: 1 }), getBlockHeight: jest.fn(async () => 10),
    }, assertSolvent: jest.fn(async () => {}), buildPayment: jest.fn(async p => ({ signature: `new-${p.id}`, lastValidBlockHeight: 100, raw: 'bytes' })), broadcast: jest.fn(async () => {}), paymentStatus: jest.fn(async () => 'unknown') };
    service = new SolanaService({ store, chain, now: () => now });
    game = await service.create({ userId: '1', chatId: '-1', wallet: recipient, mint: token.address, amount: '69' });
    await service.deposit({ id: game.id, userId: '1', signature: depositSignature });
    await service.cancel({ id: game.id, userId: '1', chatId: '-1' });
  });
  const input = { depositSignature, returnSignature, adminId: '1' };
  test('preview is read only; exact partial return leaves 0.001456 pending and never sends funds', async () => {
    const result = await reconcileExternalRefund(service, input);
    expect(result).toMatchObject({ returnedAmount: '15215140000', remainingAmount: '1456' });
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '15215141456' }]);
    expect((await pool.query('SELECT * FROM "SolExternalRefunds"')).rowCount).toBe(0);
    expect(chain.buildPayment).not.toHaveBeenCalled(); expect(chain.broadcast).not.toHaveBeenCalled();
  });
  test('records external allocations atomically, preserves originals, then signs only the residual', async () => {
    const result = await reconcileExternalRefund(service, { ...input, commit: true });
    expect(result.recorded).toBe(true);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '1456' }]);
    const payments = await store.payments(game.id);
    expect(payments.find(p => p.status === 'PENDING').payment).toMatchObject({ amount: '1456', originalAmount: '69000000' });
    expect(payments.find(p => p.status === 'CONFIRMED').signature).toBe(returnSignature);
    expect(result.allocations.map(a => a.before.amount).sort()).toEqual(['15146141456', '69000000']);
    expect(chain.buildPayment).not.toHaveBeenCalled(); expect(chain.broadcast).not.toHaveBeenCalled();
    await service.work();
    expect(chain.buildPayment).toHaveBeenCalledTimes(1);
    expect(chain.buildPayment.mock.calls[0][0].amount).toBe('1456');
  });
  test('repeat after worker signs the residual is idempotent and cannot release it twice', async () => {
    await reconcileExternalRefund(service, { ...input, commit: true }); await service.work();
    const again = await reconcileExternalRefund(service, { ...input, commit: true });
    expect(again.alreadyRecorded).toBe(true);
    expect((await pool.query('SELECT * FROM "SolExternalRefunds"')).rowCount).toBe(1);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '1456' }]);
  });
  test('reproduces the reported total and unlocks the new 69-token refund while retaining the unresolved burn', async () => {
    const current = await service.create({ userId: '2', chatId: '-2', wallet: Keypair.fromSeed(Buffer.alloc(32, 62)).publicKey.toBase58(), mint: token.address, amount: '69' });
    chain.verifyDeposit.mockResolvedValueOnce(69000000n);
    await service.deposit({ id: current.id, userId: '2', signature: bs58.encode(Buffer.alloc(64, 63)) });
    await service.cancel({ id: current.id, userId: '2', chatId: '-2' });
    await pool.query('INSERT INTO "SolOutbox" (id,"gameId",payment,status,signed) VALUES ($1,$2,$3,$4,$5)', ['burn:unresolved', game.id, JSON.stringify({ mint: token.address, amount: '42069000', kind: 'burn', sourceWallet: treasury }), 'REVIEW', JSON.stringify({ signature: 'unknown-burn' })]);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '15326210456' }]);
    chain.assertSolvent.mockImplementation(async liabilities => {
      if (BigInt(liabilities[0].amount) > 111070456n) throw new Error('Token treasury does not cover all recorded liabilities');
    });
    await service.work(); expect(chain.buildPayment).not.toHaveBeenCalled();
    await reconcileExternalRefund(service, { ...input, commit: true });
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '111070456' }]);
    await service.work();
    expect(chain.buildPayment.mock.calls.map(c => c[0].amount).sort()).toEqual(['1456', '69000000']);
    expect((await pool.query('SELECT status FROM "SolOutbox" WHERE id=\'burn:unresolved\'')).rows[0].status).toBe('REVIEW');
  });
  test('a complete manual return confirms both components without creating a replacement', async () => {
    chain.connection.getParsedTransaction.mockImplementation(async sig => sig === returnSignature ? transfer('15215141456') : { blockTime: 1 });
    const result = await reconcileExternalRefund(service, { ...input, commit: true });
    expect(result.remainingAmount).toBe('0');
    expect((await store.payments(game.id)).every(p => p.status === 'CONFIRMED' && p.signature === returnSignature)).toBe(true);
    expect(await store.pendingPayments()).toEqual([]);
    expect(chain.buildPayment).not.toHaveBeenCalled();
  });
  test('one manual signature cannot be applied to another receipt', async () => {
    await reconcileExternalRefund(service, { ...input, commit: true });
    await expect(reconcileExternalRefund(service, { ...input, depositSignature: bs58.encode(Buffer.alloc(64, 59)), commit: true })).rejects.toThrow('already reconciled');
  });
  test.each(['SIGNED', 'REVIEW', 'CONFIRMED'])('refuses %s original payments rather than risking a duplicate', async status => {
    await pool.query('UPDATE "SolOutbox" SET status=$1,signed=$2 WHERE id=$3', [status, JSON.stringify({ signature: 'existing' }), `refund:${depositSignature}`]);
    await expect(reconcileExternalRefund(service, { ...input, commit: true })).rejects.toThrow('unsigned');
    expect((await pool.query('SELECT * FROM "SolExternalRefunds"')).rowCount).toBe(0);
  });
  test('refuses a return signature that belongs to any already recorded bot payment', async () => {
    await pool.query('INSERT INTO "SolOutbox" (id,"gameId",payment,status,signed) VALUES ($1,$2,$3,$4,$5)', ['unrelated', game.id, JSON.stringify({ mint: token.address, amount: '100', kind: 'burn' }), 'CONFIRMED', JSON.stringify({ signature: returnSignature })]);
    await expect(reconcileExternalRefund(service, { ...input, commit: true })).rejects.toThrow('already belongs');
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '15215141456' }]);
  });
  test('does not race an active worker or a concurrent repair', async () => {
    service.workerRunning = true;
    await expect(reconcileExternalRefund(service, { ...input, commit: true })).rejects.toThrow('busy');
    expect(service.workerRunning).toBe(true); service.workerRunning = false;
    const results = await Promise.allSettled([reconcileExternalRefund(service, { ...input, commit: true }), reconcileExternalRefund(service, { ...input, commit: true })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(service.workerRunning).toBe(false);
  });
  test('rolls back every allocation if the immutable evidence insert fails', async () => {
    await pool.query(`ALTER TABLE "SolExternalRefunds" ADD CONSTRAINT fail_evidence CHECK (false)`);
    try { await expect(reconcileExternalRefund(service, { ...input, commit: true })).rejects.toThrow(); }
    finally { await pool.query('ALTER TABLE "SolExternalRefunds" DROP CONSTRAINT fail_evidence'); }
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '15215141456' }]);
    expect((await store.payments(game.id)).every(p => p.status === 'PENDING' && !p.signature)).toBe(true);
  });
  test('a larger return cannot erase unrelated liabilities', async () => {
    chain.connection.getParsedTransaction.mockImplementation(async sig => sig === returnSignature ? transfer('15215141457') : { blockTime: 1 });
    await expect(reconcileExternalRefund(service, { ...input, commit: true })).rejects.toThrow('exceeds');
  });
  test('failed proof or RPC leaves records unchanged and releases the worker exclusion', async () => {
    chain.connection.getParsedTransaction.mockRejectedValue(new Error('429 private endpoint'));
    await expect(reconcileExternalRefund(service, { ...input, commit: true })).rejects.toThrow();
    expect(service.workerRunning).toBe(false);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '15215141456' }]);
  });
  test('private admin is required; group admins and other users cannot reconcile', async () => {
    const handlers = {};
    require('../src/solana/telegram').registerSolanaCommands({ command: (n, h) => { handlers[n] = h; } }, service);
    for (const [id, type] of [[2, 'private'], [1, 'supergroup']]) {
      const ctx = { from: { id }, chat: { type }, message: { text: `/solrefundsync ${depositSignature} ${returnSignature} CONFIRM` }, reply: jest.fn() };
      await handlers.solrefundsync(ctx); expect(ctx.reply).toHaveBeenCalledWith('Private administrator command.');
    }
    expect(chain.connection.getParsedTransaction).not.toHaveBeenCalled();
  });
  test('admin command identifies the failing public lookup without exposing a private RPC URL or changing records', async () => {
    chain.connection.getParsedTransaction.mockRejectedValue(new Error('429 https://rpc.example/private-key'));
    const handlers = {};
    require('../src/solana/telegram').registerSolanaCommands({ command: (n, h) => { handlers[n] = h; } }, service);
    const ctx = { from: { id: 1 }, chat: { type: 'private' }, message: { text: `/solrefundsync ${depositSignature} ${returnSignature} CONFIRM` }, reply: jest.fn() };
    await handlers.solrefundsync(ctx);
    const text = ctx.reply.mock.calls[0][0];
    expect(text).toContain('RPC_RATE_LIMIT at deposit-fetch');
    expect(text).not.toMatch(/rpc\.example|private-key/);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '15215141456' }]);
    expect((await pool.query('SELECT * FROM "SolExternalRefunds"')).rowCount).toBe(0);
    expect(service.workerRunning).toBe(false);
  });
});
