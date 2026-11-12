const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { Keypair, PublicKey, Transaction, TransactionInstruction, Connection } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const spl = require('../src/solana/token');
const { MEMO } = require('../src/solana/chain');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { recoverExpiredBurn, decodeBurn, proveExpiredBurn } = require('../src/solana/expiredBurn');
const signer = Keypair.fromSeed(Buffer.alloc(32, 81));
const treasury = signer.publicKey.toBase58();
const mint = Keypair.fromSeed(Buffer.alloc(32, 82)).publicKey;
const token = { address: mint.toBase58(), program: spl.TOKEN_2022_PROGRAM_ID.toBase58(), decimals: 6, symbol: 'TEST' };
const firstHash = Keypair.fromSeed(Buffer.alloc(32, 83)).publicKey.toBase58();
const gameId = '5e09d25f-52df-444c-80ef-12edf7dac3e2';
const id = `burn:${gameId}`;
const anchorSignature = bs58.encode(Buffer.alloc(64, 84));
function fixture() {
  const game = { id: gameId, cluster: 'mainnet-beta', status: 'SETTLED', depositAddress: treasury, token, fees: { burn: '42069000' } };
  const source = spl.getAssociatedTokenAddressSync(mint, signer.publicKey, spl.TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: firstHash });
  tx.add(spl.createBurnCheckedInstruction(source, mint, signer.publicKey, 42069000n, 6, spl.TOKEN_2022_PROGRAM_ID));
  tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`coinflip:payout:${id}`) }));
  tx.sign(signer);
  const row = { id, gameId, payment: { id, gameId, kind: 'burn', mint: token.address, sourceWallet: treasury, amount: '42069000' },
    signed: { signature: bs58.encode(tx.signature), raw: tx.serialize().toString('base64'), lastValidBlockHeight: 350 }, status: 'REVIEW', lastError: 'Blockhash expired without finalized proof; reconcile exact signature before any replacement' };
  return { game, row };
}
function rpc() {
  // Sparse slots, but contiguous produced block heights. No timestamp-based
  // window guesses and no assumption that one slot equals one block.
  const slot = h => h * 2 + 100;
  const hash = h => h === 200 ? firstHash : `hash-${h}`;
  const c = {
    getBlockHeight: jest.fn(async () => 500),
    isBlockhashValid: jest.fn(async () => ({ value: false })),
    getParsedTransaction: jest.fn(async sig => sig === anchorSignature ? { slot: slot(210), meta: { err: null }, transaction: { signatures: [anchorSignature] } } : null),
    getSignatureStatuses: jest.fn(async () => ({ value: [null] })),
    getBlocks: jest.fn(async () => Array.from({ length: 401 }, (_, i) => slot(i + 100))),
    getBlock: jest.fn(async (s, options) => {
      const h = (s - 100) / 2;
      return { blockHeight: h, blockhash: hash(h), parentSlot: slot(h - 1), previousBlockhash: hash(h - 1), ...(options.transactionDetails === 'signatures' ? { signatures: [`unrelated-${h}`] } : {}) };
    }),
  };
  c.getBlockSignatures = jest.fn(async s => c.getBlock(s, { transactionDetails: 'signatures' }));
  return c;
}
describe('exact expired burn evidence', () => {
  test('real web3 RPC decoding supports the signature-only block response', async () => {
    const mock = rpc();
    const connection = new Connection('http://localhost:8899', { fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      let result;
      if (request.method === 'getBlock') {
        const [s, config] = request.params;
        const h = (s - 100) / 2;
        result = { ...await mock.getBlock(s, config), blockTime: 1700000000 + h };
        if (config.transactionDetails === 'signatures') delete result.blockHeight;
      } else if (request.method === 'isBlockhashValid') result = { context: { slot: 1200 }, value: false };
      else if (request.method === 'getSignatureStatuses') result = { context: { slot: 1200 }, value: [null] };
      else if (request.method === 'getTransaction') {
        if (request.params[0] === anchorSignature) {
          // The real SDK parses a legacy transaction object, not just a slot.
          result = { slot: 520, meta: null };
        } else result = null;
      } else result = await mock[request.method](...request.params);
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) };
    } });
    // Anchor tx decoding is exercised elsewhere against real chain receipts;
    // keep this fixture focused on SDK block/signature response decoding.
    connection.getParsedTransaction = mock.getParsedTransaction;
    const { row, game } = fixture();
    const result = await proveExpiredBurn(connection, decodeBurn(row, game, treasury), anchorSignature);
    expect(result.blocks).toHaveLength(151);
    expect(result.blocks[150].height).toBe(350);
  });
  test('verifies signed Token-2022 bytes and all 151 finalized blocks with skipped slots', async () => {
    const { game, row } = fixture();
    const signed = decodeBurn(row, game, treasury), connection = rpc();
    const evidence = await proveExpiredBurn(connection, signed, anchorSignature);
    expect(evidence).toMatchObject({ firstHeight: 200, lastHeight: 350, originalSignature: row.signed.signature });
    expect(evidence.blocks).toHaveLength(151);
    expect(connection.getBlock.mock.calls.filter(([, options]) => options.transactionDetails === 'signatures')).toHaveLength(151);
  });
  test.each([
    ['different amount', f => { f.row.payment.amount = '1'; }],
    ['different treasury', f => { f.row.payment.sourceWallet = token.address; }],
    ['recipient', f => { f.row.payment.recipient = treasury; }],
    ['wrong kind', f => { f.row.payment.kind = 'prize'; }],
    ['wrong original signature', f => { f.row.signed.signature = anchorSignature; }],
    ['not an expired review', f => { f.row.lastError = 'another problem'; }],
    ['unsettled game', f => { f.game.status = 'OPEN'; }],
    ['invalid bytes', f => { f.row.signed.raw = 'invalid'; }],
  ])('refuses %s', (_, edit) => {
    const f = fixture(); edit(f); expect(() => decodeBurn(f.row, f.game, treasury)).toThrow();
  });
  test.each([
    ['not expired', c => c.isBlockhashValid.mockResolvedValue({ value: true })],
    ['not past expiry at finality', c => c.getBlockHeight.mockResolvedValue(350)],
    ['anchor unavailable', c => c.getParsedTransaction.mockResolvedValue(null)],
    ['missing produced block', c => c.getBlocks.mockImplementation(async () => Array.from({ length: 400 }, (_, i) => (i + 100 + (i >= 150 ? 1 : 0)) * 2 + 100))],
    ['pruned signatures', c => { const original = c.getBlock.getMockImplementation(); c.getBlock.mockImplementation(async (s, o) => o.transactionDetails === 'signatures' ? null : original(s, o)); }],
    ['wrong blockhash', c => { const original = c.getBlock.getMockImplementation(); c.getBlock.mockImplementation(async (s, o) => ({ ...await original(s, o), ...(s === 500 && o.transactionDetails === 'signatures' ? { blockhash: 'wrong' } : {}) })); }],
    ['broken parent chain', c => { const original = c.getBlock.getMockImplementation(); c.getBlock.mockImplementation(async (s, o) => ({ ...await original(s, o), ...(s === 510 ? { parentSlot: 1 } : {}) })); }],
    ['original appears in a block', c => { const original = c.getBlock.getMockImplementation(); c.getBlock.mockImplementation(async (s, o) => ({ ...await original(s, o), ...(s === 510 ? { signatures: [fixture().row.signed.signature] } : {}) })); }],
    ['inconsistent status lookup', c => c.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: 'finalized', err: null }] })],
    ['inconclusive empty status response', c => c.getSignatureStatuses.mockResolvedValue({ value: [] })],
    ['RPC failure', c => c.getBlock.mockRejectedValue(new Error('historical RPC unavailable'))],
  ])('fails closed on %s', async (_, edit) => {
    const f = fixture(), c = rpc(); edit(c);
    await expect(proveExpiredBurn(c, decodeBurn(f.row, f.game, treasury), anchorSignature)).rejects.toThrow();
  });
});
const url = process.env.SOLANA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('expired burn recovery on real PostgreSQL', () => {
  let admin, pool, store, service, schema;
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL only');
    admin = new Pool({ connectionString: url }); schema = `burn_repair_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(pool); await store.prepareInterface();
  });
  afterAll(async () => { if (pool) await pool.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolOutbox", "SolGames" CASCADE');
    await pool.query('DROP TABLE IF EXISTS "SolExpiredBurnRepairs"');
    const { row, game } = fixture();
    await pool.query('INSERT INTO "SolGames" (id,state) VALUES ($1,$2)', [gameId, game]);
    await pool.query('INSERT INTO "SolOutbox" (id,"gameId",payment,signed,status,"lastError") VALUES ($1,$2,$3,$4,$5,$6)', [id, gameId, row.payment, row.signed, row.status, row.lastError]);
    await pool.query('INSERT INTO "SolOutbox" (id,"gameId",payment,signed,status) VALUES ($1,$2,$3,$4,\'CONFIRMED\')', [`prize:${gameId}`, gameId, { kind: 'prize', amount: '757242000', mint: token.address }, { signature: anchorSignature }]);
    service = { store, workerRunning: false, chain: { address: treasury, env: { SOLANA_CLUSTER: 'mainnet-beta', ADMIN_IDS: '1', BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true' }, validate: jest.fn(async () => {}), assertSolvent: jest.fn(async () => {}), connection: rpc() } };
  });
  const input = { gameId, adminId: '1' };
  test('preview never changes payment, releases liabilities, or creates an audit repair', async () => {
    const before = (await pool.query('SELECT * FROM "SolOutbox" ORDER BY id')).rows;
    const result = await recoverExpiredBurn(service, input);
    expect(result.preview).toBe(true);
    expect((await pool.query('SELECT * FROM "SolOutbox" ORDER BY id')).rows).toEqual(before);
    expect((await pool.query('SELECT * FROM "SolExpiredBurnRepairs"')).rowCount).toBe(0);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '42069000' }]);
  });
  test('queues only the original burn once, archives signed bytes, and preserves total liabilities', async () => {
    await recoverExpiredBurn(service, input);
    const result = await recoverExpiredBurn(service, { ...input, commit: true });
    expect(result.recorded).toBe(true);
    const rows = (await pool.query('SELECT * FROM "SolOutbox" ORDER BY id')).rows;
    expect(rows.find(r => r.id === id)).toMatchObject({ status: 'PENDING', signed: null });
    expect(rows.find(r => r.id.startsWith('prize:'))).toMatchObject({ status: 'CONFIRMED', signed: { signature: anchorSignature } });
    const audit = (await pool.query('SELECT * FROM "SolExpiredBurnRepairs"')).rows[0];
    expect(audit.original.signed).toEqual(fixture().row.signed);
    expect(audit.evidence.blocks).toHaveLength(151);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '42069000' }]);
    expect((await recoverExpiredBurn(service, { ...input, commit: true })).alreadyRecorded).toBe(true);
    expect((await pool.query('SELECT * FROM "SolExpiredBurnRepairs"')).rowCount).toBe(1);
    expect(service.workerRunning).toBe(false);
  });
  test('concurrent confirmations cannot queue two replacements', async () => {
    await recoverExpiredBurn(service, input);
    const results = await Promise.allSettled([recoverExpiredBurn(service, { ...input, commit: true }), recoverExpiredBurn(service, { ...input, commit: true })]);
    expect(results.filter(r => r.status === 'fulfilled' && r.value.recorded)).toHaveLength(1);
    expect((await pool.query('SELECT * FROM "SolExpiredBurnRepairs"')).rowCount).toBe(1);
  });
  test('the actual payment worker signs only the repaired burn and releases its reserve only after finality', async () => {
    await recoverExpiredBurn(service, { ...input, commit: true });
    const chain = service.chain;
    chain.buildPayment = jest.fn(async () => ({ signature: 'replacement-burn', raw: 'replacement-bytes', lastValidBlockHeight: 1000 }));
    chain.paymentStatus = jest.fn(async () => 'unknown');
    chain.broadcast = jest.fn(async () => {});
    const worker = new SolanaService({ store, chain });
    await worker.work();
    expect(chain.buildPayment).toHaveBeenCalledTimes(1);
    expect(chain.buildPayment.mock.calls[0][0]).toMatchObject({ kind: 'burn', amount: '42069000', id });
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    expect(await store.liabilities()).toEqual([{ mint: token.address, amount: '42069000' }]);
    chain.paymentStatus.mockResolvedValue('finalized');
    await worker.work();
    expect(chain.buildPayment).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    expect(await store.liabilities()).toEqual([]);
    expect((await store.payments(gameId)).find(r => r.id === id)).toMatchObject({ status: 'CONFIRMED', signature: 'replacement-burn' });
  });
  test('an RPC failure or unknown history never clears the original signed payment', async () => {
    service.chain.connection.getBlock.mockRejectedValue(new Error('historical RPC unavailable'));
    await expect(recoverExpiredBurn(service, { ...input, commit: true })).rejects.toThrow();
    expect((await pool.query('SELECT * FROM "SolOutbox" WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'REVIEW', signed: fixture().row.signed });
  });
  test('an evidence write failure rolls back the queue reset and frees worker exclusion', async () => {
    await recoverExpiredBurn(service, input);
    await pool.query('ALTER TABLE "SolExpiredBurnRepairs" ADD CONSTRAINT reject_repair CHECK (false)');
    await expect(recoverExpiredBurn(service, { ...input, commit: true })).rejects.toThrow();
    expect((await pool.query('SELECT status,signed FROM "SolOutbox" WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'REVIEW', signed: fixture().row.signed });
    expect(service.workerRunning).toBe(false);
  });
  test('fails closed when funds gate is off or treasury coverage fails', async () => {
    await recoverExpiredBurn(service, input);
    service.chain.env.LIVE_FUNDS_ENABLED = 'false';
    await expect(recoverExpiredBurn(service, { ...input, commit: true })).rejects.toThrow('Funds disabled');
    service.chain.env.LIVE_FUNDS_ENABLED = 'true';
    service.chain.assertSolvent.mockRejectedValue(new Error('shortfall'));
    await expect(recoverExpiredBurn(service, { ...input, commit: true })).rejects.toThrow('shortfall');
    expect(service.workerRunning).toBe(false);
    expect((await pool.query('SELECT status FROM "SolOutbox" WHERE id=$1', [id])).rows[0].status).toBe('REVIEW');
  });
  test('requires the private owner administrator, not a group admin or another user', async () => {
    await expect(recoverExpiredBurn(service, { ...input, adminId: '2' })).rejects.toThrow('administrator');
    const handlers = {};
    require('../src/solana/telegram').registerSolanaCommands({ command: (name, h) => { handlers[name] = h; } }, service);
    for (const [userId, type] of [[2, 'private'], [1, 'supergroup']]) {
      const ctx = { from: { id: userId }, chat: { type }, message: { text: `/solburnrecover ${gameId} CONFIRM` }, reply: jest.fn() };
      await handlers.solburnrecover(ctx); expect(ctx.reply).toHaveBeenCalledWith('Private administrator command.');
    }
    expect(service.chain.connection.getBlock).not.toHaveBeenCalled();
  });
  test('private preview returns polling immediately and edits one progress card with the human token amount', async () => {
    const handlers = {};
    require('../src/solana/telegram').registerSolanaCommands({ command: (name, h) => { handlers[name] = h; } }, service);
    const ctx = { from: { id: 1 }, chat: { type: 'private', id: 1 }, message: { text: `/solburnrecover ${gameId}` }, reply: jest.fn(async () => ({ message_id: 7 })), telegram: { editMessageText: jest.fn(async () => {}) } };
    await handlers.solburnrecover(ctx);
    expect(service.expiredBurnJob).toBeTruthy();
    expect(service.workerRunning).toBe(false);
    await service.expiredBurnJob;
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.telegram.editMessageText.mock.calls.at(-1)[3]).toContain('Burn: 42.069 TEST');
    expect((await pool.query('SELECT status FROM "SolOutbox" WHERE id=$1', [id])).rows[0].status).toBe('REVIEW');
    expect(service.expiredBurnJob).toBe(null);
  });
  test('background RPC errors retain the original and never expose endpoint credentials', async () => {
    const handlers = {};
    require('../src/solana/telegram').registerSolanaCommands({ command: (name, h) => { handlers[name] = h; } }, service);
    service.chain.connection.getBlock.mockRejectedValue(new Error('https://rpc.example/secret-key forbidden'));
    const ctx = { from: { id: 1 }, chat: { type: 'private', id: 1 }, message: { text: `/solburnrecover ${gameId}` }, reply: jest.fn(async () => ({ message_id: 7 })), telegram: { editMessageText: jest.fn(async () => {}) } };
    await handlers.solburnrecover(ctx); await service.expiredBurnJob;
    const message = ctx.telegram.editMessageText.mock.calls.at(-1)[3];
    expect(message).toContain('No replacement was queued'); expect(message).not.toMatch(/rpc\.example|secret-key/);
    expect((await pool.query('SELECT status FROM "SolOutbox" WHERE id=$1', [id])).rows[0].status).toBe('REVIEW');
  });
});
