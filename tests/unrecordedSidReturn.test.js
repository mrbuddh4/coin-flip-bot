const { recoverWrongChainSid, recoveryTick, unrecordedSidNov25 } = require('../src/solana/returnWrongChainSid');
const { SID_MINT } = require('../src/solana/featured');
const signature = '49P2XBKVf8ZhHtbeghS7cC6hDFVC3J8epTPPvBJrYVQh5JeEhUX5c9QLxSCEp2ne3B4mfb1UdN4NXLeULy3QMKPr';
const sender = 'fixture-original-sender';
const treasury = '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY';
const slot = 473595922, blockTime = 1795577358;
const deposit = { signature, slot, err: null };
const amount = '1001000000';
function fixture() {
  const client = { query: jest.fn(async sql => sql.includes('SELECT o.status') ? { rows: [] } : { rowCount: 1 }), release: jest.fn() };
  const store = {
    pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn(async () => client) },
    refundCandidates: jest.fn(async () => []), liabilities: jest.fn(async () => []),
  };
  const connection = {
    getSignaturesForAddress: jest.fn(async () => [deposit]),
    getTokenAccountBalance: jest.fn(async () => ({ context: { slot: slot + 10 }, value: { amount: '1001081598' } })),
    getParsedTransaction: jest.fn(async () => ({ slot, blockTime, transaction: { message: { instructions: [
      { parsed: { type: 'transferChecked', info: { multisigAuthority: sender, signers: [sender] } } },
    ] } } })),
  };
  const chain = { address: treasury, env: { SOLANA_CLUSTER: 'mainnet-beta' }, validate: jest.fn(), verifyDeposit: jest.fn(async () => BigInt(amount)), connection };
  return { store, chain, client };
}

test('queues only the exact transfer amount to its verified sender and keeps the prior token balance', async () => {
  const { store, chain, client } = fixture();
  await expect(recoverWrongChainSid({ store, chain }, unrecordedSidNov25)).resolves.toBe('PENDING');
  expect(chain.verifyDeposit.mock.calls[0][0]).toMatchObject({ sender, signature, mint: SID_MINT, allowNoMemo: true });
  expect(chain.connection.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  expect(chain.connection.getSignaturesForAddress).toHaveBeenCalledWith(expect.anything(),
    { limit: 100, minContextSlot: slot + 10 }, 'confirmed');
  const call = client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO "SolOutbox"'));
  expect(JSON.parse(call[1][2])).toMatchObject({ id: 'refund:' + signature, recipient: sender, amount, mint: SID_MINT, sourceWallet: treasury, kind: 'refund' });
  expect(client.query).toHaveBeenLastCalledWith('COMMIT');
});

test('history throttling reports the failed stage without leaking the endpoint or opening a write transaction', async () => {
  const { store, chain } = fixture();
  chain.connection.getSignaturesForAddress.mockRejectedValueOnce(new Error('429 at https://private.example/secret'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await recoveryTick({ store, chain }, () => 0, unrecordedSidNov25)();
    expect(log).toHaveBeenCalledWith('SID_ONE_TIME_RETURN_NOV25: RETRY stage=treasury-history-confirmed reason=RPC_RATE_LIMIT');
    expect(store.pool.connect).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test('refuses to queue if confirmed treasury history shows a possible manual return', async () => {
  const { store, chain } = fixture();
  chain.connection.getSignaturesForAddress.mockImplementation(async (_addr, _opts, commitment) =>
    commitment === 'confirmed' ? [{ signature: 'possible-return', slot: slot + 1, err: null }, deposit] : [deposit]);
  await expect(recoverWrongChainSid({ store, chain }, unrecordedSidNov25)).rejects.toThrow('newer-successful-token-account-activity');
  expect(store.pool.connect).not.toHaveBeenCalled();
});

test('already-recorded receipt prevents a second payment', async () => {
  const { store, chain, client } = fixture();
  client.query.mockImplementation(async sql => sql.includes('SELECT o.status') ? { rows: [] } :
    { rowCount: sql.includes('INSERT INTO "SolDeposits"') ? 0 : 1 });
  await expect(recoverWrongChainSid({ store, chain }, unrecordedSidNov25)).rejects.toThrow('deposit-already-recorded');
  expect(client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "SolOutbox"'))).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
