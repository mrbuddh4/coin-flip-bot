jest.mock('node:crypto', () => {
  const real = jest.requireActual('node:crypto');
  return { ...real, createHash: kind => {
    const h = real.createHash(kind);
    return { update: value => value === 'test-deposit-proof' ?
      { digest: () => 'cb12b102dd423bc24a5fdbcf178032e17b459c5e4e53d01959cdbd734d325835' } : h.update(value) };
  } };
});
const { Pool } = require('pg');
const { readFileSync } = require('node:fs');
const { SolanaStore } = require('../src/solana/store');
const { SID_MINT } = require('../src/solana/featured');
const { recoverWrongChainSid } = require('../src/solana/returnWrongChainSid');

const url = process.env.SOLANA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('One-time registered wrong-chain SID return on disposable PostgreSQL', () => {
  const schema = 'one_return_' + process.pid;
  const signature = 'test-deposit-proof', sender = 'original-sender', amount = '6900000000', slot = 472723306;
  const address = '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY';
  let admin, db, store, chain;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Use disposable localhost PostgreSQL');
    admin = new Pool({ connectionString: url });
    await admin.query('CREATE SCHEMA ' + schema);
    db = new Pool({ connectionString: url, options: '-c search_path=' + schema });
    await db.query(readFileSync(require.resolve('../src/solana/schema.sql'), 'utf8'));
    store = new SolanaStore(db);
    await store.prepareInterface();
  });
  afterAll(async () => {
    if (db) await db.end();
    if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); }
  });
  beforeEach(async () => {
    await db.query('TRUNCATE "SolGames","SolDeposits","SolOutbox" CASCADE');
    chain = { address, env: { SOLANA_CLUSTER: 'mainnet-beta' }, validate: jest.fn(),
      verifyDeposit: jest.fn().mockResolvedValue(BigInt(amount)), connection: {
        getSignaturesForAddress: jest.fn().mockResolvedValue([{ signature, slot, err: null }]),
        getParsedTransaction: jest.fn().mockResolvedValue({ slot, blockTime: 1795389732,
          transaction: { message: { instructions: [{ parsed: { type: 'transferChecked', info: { authority: sender } } }] } } }),
        getTokenAccountBalance: jest.fn().mockResolvedValue({ value: { amount } }),
      } };
  });

  test('queues exactly once, even with concurrent recovery and a restart', async () => {
    await expect(Promise.all([recoverWrongChainSid({ chain, store }), recoverWrongChainSid({ chain, store })])).resolves.toEqual(['PENDING','PENDING']);
    const [p, ...rest] = await store.pendingPayments();
    expect(rest).toEqual([]);
    expect(p.payment).toMatchObject({ id: 'refund:' + signature, recipient: sender, amount, mint: SID_MINT, sourceWallet: address });
    expect(await store.liabilities()).toEqual([{ mint: SID_MINT, amount }]);
    expect(await store.unfinished()).toEqual([]);
    await store.paymentState(p.id, 'CONFIRMED');
    chain.connection.getSignaturesForAddress.mockClear();
    await expect(recoverWrongChainSid({ store: new SolanaStore(db), chain })).resolves.toBe('CONFIRMED');
    expect(chain.connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  test('does not queue if a later confirmed transfer could already be a manual return', async () => {
    chain.connection.getSignaturesForAddress.mockImplementation(async (_, __, commitment) => [
      { signature, slot, err: null },
      ...(commitment === 'confirmed' ? [{ signature: 'potential-manual-return', slot: slot + 1, err: null }] : []),
    ]);
    await expect(recoverWrongChainSid({ store, chain })).rejects.toThrow('newer-successful-token-account-activity');
    expect(await store.pendingPayments()).toEqual([]);
    expect(await store.hasDeposit(signature)).toBe(false);
  });

  test('does not queue if the treasury no longer holds the specified token balance', async () => {
    chain.connection.getTokenAccountBalance.mockResolvedValue({ value: { amount: '1' } });
    await expect(recoverWrongChainSid({ store, chain })).rejects.toThrow('token-balance-or-history-changed');
    expect(await store.pendingPayments()).toEqual([]);
  });
});
