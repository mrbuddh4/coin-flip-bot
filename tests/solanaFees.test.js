const { ethers } = require('ethers');
const { Keypair, Transaction, PublicKey } = require('@solana/web3.js');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { SolanaFees, FlipSnapshotSource, FLIP, exclusions, holderRewardsMode } = require('../src/solana/fees');
const { holderHandler } = require('../src/solana/holderPage');
const token = require('../src/solana/token');
const holder = new ethers.Wallet('0x' + '19'.repeat(32)); // Deterministic test key only.
const solA = Keypair.fromSeed(Buffer.alloc(32, 21)).publicKey.toBase58();
const solB = Keypair.fromSeed(Buffer.alloc(32, 22)).publicKey.toBase58();
const treasury = Keypair.fromSeed(Buffer.alloc(32, 23)).publicKey.toBase58();
const contract = new ethers.Interface(['function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
function sourceFixture() {
  const blockHash = '0x' + 'ab'.repeat(32), calls = [];
  const fetcher = jest.fn(async (_url, options) => {
    const q = JSON.parse(options.body); calls.push(q);
    let result;
    if (q.method === 'eth_chainId') result = '0x7d';
    if (q.method === 'eth_getBlockByNumber') result = { number: '0x64', hash: blockHash };
    if (q.method === 'eth_getCode') result = '0x60006000';
    if (q.method === 'eth_call') {
      const call = contract.parseTransaction(q.params[0]);
      const value = call.name === 'totalSupply' ? 1000n : call.args[0].toLowerCase() === holder.address.toLowerCase() ? 200n : 0n;
      result = contract.encodeFunctionResult(call.name, [value]);
    }
    return { ok: true, json: async () => ({ result }) };
  });
  return { source: new FlipSnapshotSource({ FLIP_HOLDER_RPC_URL: 'https://public.invalid/rpc' }, fetcher), fetcher, calls, blockHash };
}
test('FLIP snapshots pin chain 125, finalized block hash, every exclusion and global effective supply', async () => {
  const { source, calls, blockHash } = sourceFixture();
  const result = await source.snapshot([{ evm: holder.address.toLowerCase() }]);
  expect(result).toMatchObject({ chainId: 125, contract: FLIP.toLowerCase(), supply: '1000', balances: { [holder.address.toLowerCase()]: '200' } });
  for (const c of calls.filter(c => ['eth_call', 'eth_getCode'].includes(c.method))) expect(c.params[1]).toEqual({ blockHash, requireCanonical: true });
  expect(calls.filter(c => c.method === 'eth_call')).toHaveLength(exclusions({}).length + 2);
});
test.each(['chain', 'finality', 'contract', 'exclusion'])('untrustworthy holder source (%s) fails without partial balance assumptions', async kind => {
  const { source } = sourceFixture(); const real = source.rpc.bind(source);
  source.rpc = async (method, params) => {
    if (kind === 'chain' && method === 'eth_chainId') return '0x1';
    if (kind === 'finality' && method === 'eth_getBlockByNumber') return null;
    if (kind === 'contract' && method === 'eth_getCode') return '0x';
    if (kind === 'exclusion' && method === 'eth_call' && params[0].data.startsWith('0x70a08231')) throw new Error('balance read unavailable');
    return real(method, params);
  };
  await expect(source.snapshot([{ evm: holder.address.toLowerCase() }])).rejects.toThrow();
});
test('burnChecked uses the SDK-defined opcode 15, little-endian u64, decimals and writable mint', () => {
  // Independent published SDK definition: @solana/spl-token 0.4.14,
  // lib/cjs/instructions/burnChecked.js and types.js. No SDK runtime dependency.
  const source = new PublicKey(solA), mint = new PublicKey(solB), owner = new PublicKey(treasury);
  for (const program of [token.TOKEN_PROGRAM_ID, token.TOKEN_2022_PROGRAM_ID]) {
    const ix = token.createBurnCheckedInstruction(source, mint, owner, 123456789n, 6, program);
    expect(ix.data.toString('hex')).toBe('0f15cd5b070000000006');
    expect(ix.programId).toEqual(program);
    expect(ix.keys).toEqual([{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }]);
  }
});
test('Solana-only rewards default to deferred and never touch a Paxeer source, registry or distribution', async () => {
  const source = { snapshot: jest.fn(async () => { throw new Error('Paxeer must not be contacted'); }) };
  const store = { pool: { connect: jest.fn(), query: jest.fn() } };
  const fees = new SolanaFees({ store, chain: { address: treasury, env: { SOLANA_CLUSTER: 'mainnet-beta' } }, source });
  expect(holderRewardsMode({})).toBe('deferred'); expect(fees.source).toBeNull();
  await fees.tick(); await fees.distribute();
  await expect(fees.challenge('1', holder.address, solA)).rejects.toThrow('deferred');
  await expect(fees.verify('old-link', 'old-signature')).rejects.toThrow('deferred');
  expect(await fees.getChallenge('old-link')).toBeNull(); expect(await fees.link('1')).toBeNull();
  expect(source.snapshot).not.toHaveBeenCalled(); expect(store.pool.connect).not.toHaveBeenCalled(); expect(store.pool.query).not.toHaveBeenCalled();
  expect(() => holderRewardsMode({ SOLANA_HOLDER_REWARDS: 'mistyped' })).toThrow('SOLANA_HOLDER_REWARDS');
});
const url = process.env.SOLANA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('fees, proof and distribution on real PostgreSQL', () => {
  let admin, pool, store, fees, chain, service, schema, now;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Disposable local DB only');
    admin = new Pool({ connectionString: url }); schema = `fee_test_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(pool); await store.prepareInterface();
  });
  afterAll(async () => { if (pool) await pool.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  beforeEach(async () => {
    await pool.query('TRUNCATE "SolFeeCycles", "SolFeePools", "SolFeeAccruals", "SolHolderChallenges", "SolHolderLinks", "SolOutbox", "SolDeposits", "SolGames"');
    now = Date.parse('2026-11-10T01:00:00Z');
    chain = { address: treasury, env: { SOLANA_CLUSTER: 'devnet' }, tokenInfo: jest.fn(async mint => ({ address: mint === 'SOL' ? 'NATIVE' : mint, decimals: 9, symbol: 'SOL' })), verifyDeposit: jest.fn(async () => 100000000n) };
    const source = { env: {}, snapshot: jest.fn(async links => ({ supply: '1000', balances: Object.fromEntries(links.map(l => [l.evm, '200'])), chainId: 125, blockHash: 'verified-test-snapshot' })) };
    fees = new SolanaFees({ store, chain, source, mode: 'paxeer', now: () => now });
    service = new SolanaService({ store, chain, now: () => now, coin: () => 0 });
    service.feeService = fees;
  });
  async function settle(mint = 'SOL', prefix = '') {
    const g = await service.create({ userId: '1', chatId: '-1', wallet: solA, mint, amount: '0.1' });
    await service.join({ id: g.id, userId: '2', chatId: '-1', wallet: solB });
    await service.deposit({ id: g.id, userId: '1', signature: prefix + 'a' });
    await service.deposit({ id: g.id, userId: '2', signature: prefix + 'b' });
    return g.id;
  }
  async function register(userId = '1', wallet = holder, recipient = solA) {
    const c = await fees.challenge(userId, wallet.address, recipient);
    await fees.verify(c.id, await wallet.signMessage(c.message));
    return c;
  }
  test('settlement atomically balances prize, holder pool and burn, idempotent on replay/backfill', async () => {
    const id = await settle();
    const g = await store.get(id);
    expect(g.fees).toEqual({ holder: '10000000', burn: '10000000', status: 'ACCRUED' });
    await service.deposit({ id, userId: '2', signature: 'b' }); await fees.backfill();
    const rows = (await pool.query('SELECT payment FROM "SolOutbox" ORDER BY id')).rows;
    expect(rows.map(r => r.payment.kind)).toEqual(['burn', 'prize']);
    expect(rows[0].payment.recipient).toBeUndefined();
    expect(rows.reduce((n, r) => n + BigInt(r.payment.amount), 0n)).toBe(190000000n);
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('10000000');
  });
  test('fee failure rolls back final deposit and result together', async () => {
    const id = await settle();
    await pool.query('UPDATE "SolFeePools" SET "sourceWallet"=$1', [solB]);
    const second = await service.create({ userId: '1', chatId: '-1', wallet: solA, mint: 'SOL', amount: '0.1' });
    await service.join({ id: second.id, userId: '2', chatId: '-1', wallet: solB });
    await service.deposit({ id: second.id, userId: '1', signature: 'c' });
    await expect(service.deposit({ id: second.id, userId: '2', signature: 'd' })).rejects.toThrow('conflict');
    expect((await store.get(second.id)).status).toBe('OPEN');
    expect((await pool.query('SELECT 1 FROM "SolDeposits" WHERE signature=\'d\'')).rowCount).toBe(0);
    expect(await store.payments(second.id)).toHaveLength(0);
    expect(await store.payments(id)).toHaveLength(2);
  });
  test('holder ownership proof binds user/network/treasury/destination and cannot be replayed or registered twice', async () => {
    const c = await fees.challenge('1', holder.address, solA);
    expect(c.message).toContain(treasury); expect(c.message).toContain(solA); expect(c.message).toContain('Telegram user: 1');
    await expect(fees.verify(c.id, await holder.signMessage(c.message.replace(solA, solB)))).rejects.toThrow();
    const signature = await holder.signMessage(c.message);
    await fees.verify(c.id, signature);
    await expect(fees.verify(c.id, signature)).rejects.toThrow();
    const duplicate = await fees.challenge('2', holder.address, solB);
    await expect(fees.verify(duplicate.id, await holder.signMessage(duplicate.message))).rejects.toThrow();
    expect(await fees.link('1')).toMatchObject({ evm: holder.address.toLowerCase(), recipient: solA });
    expect(await fees.link('2')).toBeUndefined();
  });
  test('stale/replaced and expired registration challenges cannot change a reward recipient', async () => {
    const a = await fees.challenge('1', holder.address, solA);
    const b = await fees.challenge('1', holder.address, solB);
    await expect(fees.verify(a.id, await holder.signMessage(a.message))).rejects.toThrow();
    now += 11 * 60 * 1000;
    await expect(fees.verify(b.id, await holder.signMessage(b.message))).rejects.toThrow();
    expect(await fees.link('1')).toBeUndefined();
  });
  test('daily concurrent distributions debit only registered global share and retain remainder', async () => {
    await settle(); await register();
    await Promise.all([fees.distribute(), fees.distribute()]);
    const payouts = (await pool.query('SELECT * FROM "SolOutbox" WHERE payment->>\'kind\'=\'holder\'')).rows;
    expect(payouts).toHaveLength(1); expect(payouts[0].payment.amount).toBe('2000000'); expect(payouts[0].payment.recipient).toBe(solA);
    expect(payouts[0].status).toBe('PENDING');
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('8000000');
    await fees.distribute(); expect((await pool.query('SELECT * FROM "SolFeeCycles"')).rowCount).toBe(1);
    now += 86400000; await fees.distribute();
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('6400000');
  });
  test('RPC failure and failed allocation preserve all pools, cycle and outbox; restart retries', async () => {
    await settle(); await register();
    fees.source.snapshot.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(fees.distribute()).rejects.toThrow();
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('10000000');
    expect((await pool.query('SELECT * FROM "SolFeeCycles"')).rowCount).toBe(0);
    const restarted = new SolanaFees({ store, chain, source: fees.source, mode: 'paxeer', now: () => now }); await restarted.distribute();
    expect((await pool.query('SELECT * FROM "SolFeeCycles"')).rowCount).toBe(1);
  });
  test('all mint allocations roll back together on invalid supply and keep dust in the pool', async () => {
    await settle(); await register();
    fees.source.snapshot.mockResolvedValueOnce({ supply: '10', balances: { [holder.address.toLowerCase()]: '11' } });
    await expect(fees.distribute()).rejects.toThrow('Invalid holder');
    fees.source.snapshot.mockResolvedValueOnce({ supply: '10000000', balances: { [holder.address.toLowerCase()]: '1' } });
    await fees.distribute();
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('10000000');
    expect((await pool.query('SELECT * FROM "SolOutbox" WHERE payment->>\'kind\'=\'holder\'')).rowCount).toBe(0);
  });
  test('a wallet menu change cannot redirect verified rewards; a fresh signature can', async () => {
    await settle(); await register(); await store.updateProfile('1', { receiveWallet: solB });
    await fees.distribute();
    expect((await pool.query('SELECT payment FROM "SolOutbox" WHERE payment->>\'kind\'=\'holder\'')).rows[0].payment.recipient).toBe(solA);
    await register('1', holder, solB); now += 86400000; await fees.distribute();
    expect((await pool.query('SELECT payment FROM "SolOutbox" WHERE payment->>\'kind\'=\'holder\' ORDER BY payment->>\'cycle\' DESC')).rows[0].payment.recipient).toBe(solB);
  });
  test('retained devnet fees migrate once, without replaying the prize', async () => {
    const id = await settle();
    await pool.query('DELETE FROM "SolFeeAccruals"'); await pool.query('DELETE FROM "SolFeePools"');
    await pool.query('DELETE FROM "SolOutbox" WHERE payment->>\'kind\'=\'burn\'');
    await store.mutate(id, async g => { g.fees.status = 'RETAINED_NOT_DISTRIBUTED'; });
    await fees.backfill(); await fees.backfill();
    expect(await store.payments(id)).toHaveLength(2);
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('10000000');
  });
  test('liabilities stay balanced across settlement, allocation and confirmation, including unallocated fees', async () => {
    const g = await service.create({ userId: '1', chatId: '-1', wallet: solA, mint: 'SOL', amount: '0.1' });
    await service.deposit({ id: g.id, userId: '1', signature: 'a' });
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '100000000' }]);
    await service.join({ id: g.id, userId: '2', chatId: '-1', wallet: solB });
    await service.deposit({ id: g.id, userId: '2', signature: 'b' });
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '200000000' }]);
    await register(); await fees.distribute();
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '200000000' }]);
    await store.paymentState(`burn:${g.id}`, 'CONFIRMED');
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '190000000' }]);
    // Holder rows use a game FK solely as an accounting anchor, not a game-specific payment.
    expect(await store.payments(g.id)).toHaveLength(2);
  });
  test('review reconciliation reads only original signatures, never resends, and confirmed status cannot regress', async () => {
    const id = await settle();
    const signed = { signature: 'original', raw: 'original-bytes', lastValidBlockHeight: 1 };
    await store.saveSigned(`burn:${id}`, signed); await store.paymentState(`burn:${id}`, 'REVIEW');
    chain.validate = jest.fn(async () => 'matching-network');
    chain.paymentStatus = jest.fn(async () => 'unknown');
    expect((await service.recheckPayment(`burn:${id}`)).status).toBe('REVIEW');
    chain.paymentStatus.mockResolvedValue('failed');
    expect((await service.recheckPayment(`burn:${id}`)).status).toBe('REVIEW');
    chain.paymentStatus.mockResolvedValue('finalized');
    expect((await service.recheckPayment(`burn:${id}`)).status).toBe('CONFIRMED');
    await store.paymentState(`burn:${id}`, 'SIGNED');
    expect((await store.payments(id)).find(p => p.id === `burn:${id}`).status).toBe('CONFIRMED');
    expect(chain.paymentStatus).toHaveBeenCalledWith('original');
  });
  test('Solana-only mainnet game reserves 5% without Paxeer; the UI offers no inactive registration', async () => {
    chain.env.SOLANA_CLUSTER = 'mainnet-beta';
    const unavailable = { snapshot: jest.fn(async () => { throw new Error('Paxeer unavailable'); }) };
    const deferred = new SolanaFees({ store, chain, source: unavailable, now: () => now });
    service.feeService = deferred;
    const id = await settle(); await deferred.tick(); await deferred.distribute();
    expect(unavailable.snapshot).not.toHaveBeenCalled();
    expect(await store.payments(id)).toHaveLength(2);
    expect((await pool.query('SELECT amount FROM "SolFeePools"')).rows[0].amount).toBe('10000000');
    expect((await pool.query('SELECT 1 FROM "SolOutbox" WHERE payment->>\'kind\'=\'holder\'')).rowCount).toBe(0);
    expect(await store.liabilities()).toEqual([{ mint: 'NATIVE', amount: '200000000' }]);
    const { SolanaInterface } = require('../src/solana/interface');
    const ui = new SolanaInterface({ telegram: {} }, service, {});
    const ctx = { from: { id: 1 }, reply: jest.fn() };
    await ui.fees(ctx);
    const [message, options] = ctx.reply.mock.calls[0];
    expect(message).toContain('reserved in the original Solana asset');
    expect(message).toContain('distributions are deferred');
    expect(JSON.stringify(options)).not.toContain('s:holder');
    await ui.holder(ctx); expect(ctx.reply).toHaveBeenCalledTimes(2);
  });
  test('real HTTP wallet page exposes exact sign-only proof and verifies it, no private key requested', async () => {
    const c = await fees.challenge('1', holder.address, solA);
    const handler = holderHandler(fees);
    const server = require('node:http').createServer((req, res) => handler(req, res).catch(() => { res.writeHead(503); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/holder/${c.id}`;
    try {
      const page = await fetch(url); const html = await page.text();
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(html).toContain('personal_sign'); expect(html).toContain(solA);
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature: await holder.signMessage(c.message) }) });
      expect(await response.json()).toEqual({ ok: true });
      expect((await fetch(url)).status).toBe(410);
      expect(await fees.link('1')).toMatchObject({ recipient: solA });
    } finally { await new Promise(r => server.close(r)); }
  });
});
