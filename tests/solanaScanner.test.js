const { Keypair, SystemProgram } = require('@solana/web3.js');
const { MEMO } = require('../src/solana/chain');
const { DepositScanner } = require('../src/solana/scanner');
const { DepositValidationError } = require('../src/solana/errors');
const wallet = Keypair.fromSeed(Buffer.alloc(32, 15)).publicKey.toBase58();
const id = '00000000-0000-4000-8000-000000000001';
function setup() {
  const game = { id, creator: { userId: '1', wallet } };
  const store = { cursor: jest.fn(), firstGameTime: jest.fn().mockResolvedValue(100000),
    get: jest.fn().mockResolvedValue(game), setCursor: jest.fn(), reviewDeposit: jest.fn(),
    watchedAddresses: jest.fn().mockResolvedValue([wallet]) };
  const tx = { meta: {}, transaction: { message: { instructions: [
    { programId: MEMO, parsed: `coinflip:${id}:creator` },
    { programId: SystemProgram.programId, parsed: { type: 'transfer', info: {} } },
  ] } } };
  const connection = { getSignaturesForAddress: jest.fn().mockResolvedValue([{ signature: 'a', blockTime: 101 }]),
    getParsedTransaction: jest.fn().mockResolvedValue(tx) };
  const service = { store, chain: { connection }, deposit: jest.fn() };
  return { scanner: new DepositScanner(service), service, store, connection, tx };
}
test('automatically submits finalized direct deposits with exact game/player and transaction', async () => {
  const { scanner, service, store, connection, tx } = setup();
  await scanner.scan(wallet);
  expect(connection.getParsedTransaction).toHaveBeenCalledWith('a', { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  expect(service.deposit).toHaveBeenCalledWith({ id, userId: '1', signature: 'a', detectedMint: 'NATIVE', transaction: tx });
  expect(store.setCursor).toHaveBeenCalledWith(wallet, 'a');
});
test('pagination prioritizes newest receipts, retaining old cursor until the full range completes', async () => {
  const { scanner, service, store, connection } = setup();
  store.cursor.mockResolvedValue('old');
  const page = Array.from({ length: 100 }, (_, i) => ({ signature: `p${i}`, blockTime: 101 }));
  connection.getSignaturesForAddress.mockResolvedValueOnce(page).mockResolvedValueOnce([{ signature: 'older', blockTime: 101 }]);
  await scanner.scan(wallet);
  expect(connection.getSignaturesForAddress.mock.calls[1][1]).toEqual({ limit: 100, before: 'p99', until: 'old' });
  expect(service.deposit.mock.calls[0][0].signature).toBe('p0');
  expect(service.deposit.mock.calls.at(-1)[0].signature).toBe('older');
  expect(store.setCursor).toHaveBeenCalledTimes(1);
  expect(store.setCursor).toHaveBeenCalledWith(wallet, 'p0');
});
test('a permanent rejected transfer is recorded for review and cannot block later deposits', async () => {
  const { scanner, service, store, connection } = setup();
  connection.getSignaturesForAddress.mockResolvedValue([{ signature: 'new' }, { signature: 'bad' }]);
  service.deposit.mockImplementation(async ({ signature }) => { if (signature === 'bad') throw new DepositValidationError('Wrong token recipient'); });
  await scanner.scan(wallet);
  expect(store.reviewDeposit).toHaveBeenCalledWith('bad', id, 'Wrong token recipient');
  expect(service.deposit).toHaveBeenCalledTimes(2);
  expect(store.setCursor).toHaveBeenCalledWith(wallet, 'new');
});
test.each(['RPC timeout', 'database disconnected'])('transient %s retains cursor and replays range after restart', async message => {
  const { scanner, service, store } = setup();
  service.deposit.mockRejectedValueOnce(new Error(message));
  await expect(scanner.scan(wallet)).rejects.toThrow(message);
  expect(store.setCursor).not.toHaveBeenCalled();
  await new DepositScanner(service).scan(wallet);
  expect(service.deposit).toHaveBeenCalledTimes(2);
  expect(store.setCursor).toHaveBeenCalledWith(wallet, 'a');
});
test('an unavailable finalized transaction retains cursor rather than dropping a receipt', async () => {
  const { scanner, store, connection } = setup();
  connection.getParsedTransaction.mockResolvedValue(null);
  await expect(scanner.scan(wallet)).rejects.toThrow('unavailable');
  expect(store.setCursor).not.toHaveBeenCalled();
});
test('failed, unrelated and wrong-sender transfers cannot fund games', async () => {
  const { scanner, service, store, connection } = setup();
  connection.getSignaturesForAddress.mockResolvedValue([{ signature: 'ok' }, { signature: 'failed', err: {} }]);
  store.get.mockResolvedValue({ creator: { wallet: Keypair.generate().publicKey.toBase58() } });
  await scanner.scan(wallet);
  expect(service.deposit).not.toHaveBeenCalled();
  expect(connection.getParsedTransaction).toHaveBeenCalledTimes(1);
});
test('unsupported transfer layouts are retained for review without consuming the game deposit', async () => {
  const { scanner, service, store, tx } = setup();
  tx.transaction.message.instructions.push(tx.transaction.message.instructions[1]);
  await scanner.scan(wallet);
  expect(store.reviewDeposit).toHaveBeenCalledWith('a', id, expect.stringContaining('Unsupported'));
  expect(service.deposit).not.toHaveBeenCalled();
  expect(store.setCursor).toHaveBeenCalled();
});

test('plain finalized transfers use unique historical matching and retain the full proof', async () => {
  const { scanner, service, store, tx } = setup();
  tx.blockTime = 101;
  tx.transaction.message.instructions.shift();
  tx.transaction.message.instructions[0].parsed.info = { source: wallet, lamports: 100000000 };
  store.noMemoCandidates = jest.fn().mockResolvedValue([{ gameId: id, userId: '1' }]);
  await scanner.scan(wallet);
  expect(store.noMemoCandidates).toHaveBeenCalledWith({ sender: wallet, mint: 'NATIVE', amount: '100000000', at: 101000 });
  expect(service.deposit).toHaveBeenCalledWith(expect.objectContaining({ id, userId: '1', noMemo: true, transaction: tx }));
});
test('ambiguous memo-free transfers are retained for review without credit', async () => {
  const { scanner, service, store, tx } = setup();
  tx.blockTime = 101; tx.transaction.message.instructions.shift();
  tx.transaction.message.instructions[0].parsed.info = { source: wallet, lamports: 100000000 };
  store.noMemoCandidates = jest.fn().mockResolvedValue([{ gameId: id, userId: '1' }, { gameId: 'other', userId: '2' }]);
  await scanner.scan(wallet);
  expect(service.deposit).not.toHaveBeenCalled();
  expect(store.reviewDeposit).toHaveBeenCalledWith('a', id, expect.stringContaining('Ambiguous'));
});
test('explicit confirmation replays past a skipped cursor without changing the routine cursor', async () => {
  const { scanner, service, store, connection } = setup();
  store.get.mockResolvedValue({ id, createdAt: 100000, creator: { userId: '1', wallet } });
  service.member = (g, userId) => { if (userId !== '1') throw new Error('Not a player'); return g.creator; };
  store.cursor.mockResolvedValue('already-skipped');
  await scanner.confirm(id, '1');
  expect(connection.getSignaturesForAddress.mock.calls[0][1]).not.toHaveProperty('until');
  expect(store.setCursor).not.toHaveBeenCalled();
  await expect(scanner.confirm(id, '2')).rejects.toThrow('Not a player');
});

test('automatic recovery replays recent requests once per throttle period, without changing incremental cursors', async () => {
  const { scanner, store, connection } = setup();
  store.depositRecoveryRequests = jest.fn().mockResolvedValue([{ address: wallet, replayFrom: 100000 }]);
  store.cursor.mockResolvedValue('already-skipped');
  await scanner.tick();
  await scanner.tick();
  expect(connection.getSignaturesForAddress.mock.calls.filter(([, options]) => !options.until)).toHaveLength(1);
  expect(connection.getSignaturesForAddress.mock.calls.filter(([, options]) => options.until === 'already-skipped')).toHaveLength(2);
});

test('unsupported version-1 history entries cannot starve a valid newer deposit and are saved before advancing', async () => {
  const { scanner, service, store, connection, tx } = setup();
  const saved = new Map();
  store.scanReview = jest.fn(async signature => saved.get(signature));
  store.reviewScan = jest.fn(async (signature, address, reason) => saved.set(signature, { address, reason }));
  connection.getSignaturesForAddress.mockResolvedValue([{ signature: 'new-deposit', blockTime: 101 }, { signature: 'version-1-b', blockTime: 100 }, { signature: 'version-1-a', blockTime: 100 }]);
  connection.getParsedTransaction.mockImplementation(async signature => {
    if (signature.startsWith('version-1')) throw Object.assign(new Error('Transaction version (1) is not supported by the requesting client.'), { code: -32015 });
    return tx;
  });
  await scanner.scan(wallet);
  expect(service.deposit).toHaveBeenCalledWith(expect.objectContaining({ signature: 'new-deposit' }));
  expect(store.reviewScan).toHaveBeenCalledTimes(2);
  expect(store.setCursor).toHaveBeenCalledWith(wallet, 'new-deposit');
  connection.getParsedTransaction.mockClear();
  await scanner.scan(wallet);
  expect(connection.getParsedTransaction.mock.calls.every(([signature]) => signature === 'new-deposit')).toBe(true);
});
test('a failed older lookup does not block a newer receipt and still retains the cursor for retry', async () => {
  const { scanner, service, store, connection, tx } = setup();
  connection.getSignaturesForAddress.mockResolvedValue([{ signature: 'new', blockTime: 101 }, { signature: 'older', blockTime: 100 }]);
  connection.getParsedTransaction.mockImplementation(async signature => { if (signature === 'older') throw new Error('RPC timeout'); return tx; });
  await expect(scanner.scan(wallet)).rejects.toThrow('RPC timeout');
  expect(service.deposit).toHaveBeenCalledWith(expect.objectContaining({ signature: 'new' }));
  expect(store.setCursor).not.toHaveBeenCalled();
});
test('a later page failure does not discard receipts fetched on the first page', async () => {
  const { scanner, service, store, connection } = setup();
  connection.getSignaturesForAddress.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ signature: `page-${i}`, blockTime: 101 }))).mockRejectedValueOnce(new Error('RPC pagination failed'));
  await expect(scanner.scan(wallet)).rejects.toThrow('RPC pagination failed');
  expect(service.deposit).toHaveBeenCalledTimes(100);
  expect(store.setCursor).not.toHaveBeenCalled();
});
test('failed unsupported-version review persistence retains the cursor while other receipts continue', async () => {
  const { scanner, service, store, connection, tx } = setup();
  store.reviewScan = jest.fn().mockRejectedValue(new Error('database disconnected'));
  connection.getSignaturesForAddress.mockResolvedValue([{ signature: 'unsupported', blockTime: 101 }, { signature: 'valid', blockTime: 100 }]);
  connection.getParsedTransaction.mockImplementation(async signature => { if (signature === 'unsupported') throw Object.assign(new Error('unsupported version'), { code: -32015 }); return tx; });
  await expect(scanner.scan(wallet)).rejects.toThrow('database disconnected');
  expect(service.deposit).toHaveBeenCalledWith(expect.objectContaining({ signature: 'valid' }));
  expect(store.setCursor).not.toHaveBeenCalled();
});


test('a provider rate limit stops the burst and exponentially backs off without losing the cursor', async () => {
  const { scanner, store, connection } = setup();
  const clock = jest.spyOn(Date, 'now');
  let now = 1000000;
  clock.mockImplementation(() => now);
  connection.getSignaturesForAddress.mockRejectedValue(new Error('429 Too Many Requests'));
  try {
    await scanner.tick();
    expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(scanner.nextScanAt).toBe(now + 5000);
    await scanner.tick();
    expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    now += 5000;
    await scanner.tick();
    expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(scanner.nextScanAt).toBe(now + 10000);
    expect(store.setCursor).not.toHaveBeenCalled();
    now += 10000;
    connection.getSignaturesForAddress.mockResolvedValue([]);
    await scanner.tick();
    expect(scanner.rateFailures).toBe(0);
  } finally { clock.mockRestore(); }
});

test('a rate limit looking up one receipt does not hammer the remaining receipts', async () => {
  const { scanner, store, connection } = setup();
  connection.getSignaturesForAddress.mockResolvedValue([{ signature: 'first' }, { signature: 'second' }]);
  connection.getParsedTransaction.mockRejectedValue(new Error('429 Too Many Requests'));
  await expect(scanner.scan(wallet)).rejects.toThrow('429');
  expect(connection.getParsedTransaction).toHaveBeenCalledTimes(1);
  expect(store.setCursor).not.toHaveBeenCalled();
});

test('current payment windows are processed before historical wallets and historical replays', async () => {
  const { scanner, store } = setup();
  store.activeDepositRequests = jest.fn().mockResolvedValue([{ address: wallet, replayFrom: 200000 }]);
  store.watchedAddresses.mockResolvedValue([wallet, 'historical']);
  store.depositRecoveryRequests = jest.fn().mockResolvedValue([{ address: wallet, replayFrom: 100000 }, { address: 'historical', replayFrom: 100000 }]);
  scanner.scan = jest.fn();
  await scanner.tick();
  expect(scanner.scan.mock.calls).toEqual([[wallet, { replayFrom: 200000 }], ['historical'], ['historical', { replayFrom: 100000 }]]);
});

test('a committed receipt is not fetched or reverified during historical replay', async () => {
  const { scanner, service, store, connection } = setup();
  store.hasDeposit = jest.fn().mockResolvedValue(true);
  await scanner.scan(wallet, { replayFrom: 100000 });
  expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  expect(service.deposit).not.toHaveBeenCalled();
  expect(store.setCursor).not.toHaveBeenCalled();
});

test('the newest deposit is processed before a blocked next history page returns', async () => {
  const { scanner, service, store, connection } = setup();
  const page = Array.from({ length: 100 }, (_, i) => ({ signature: `p${i}`, blockTime: 101 }));
  let release;
  connection.getSignaturesForAddress.mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const scanning = scanner.scan(wallet);
  // Wait for the scanner to request page two, which remains deliberately stuck.
  while (!release) await new Promise(resolve => setImmediate(resolve));
  expect(service.deposit).toHaveBeenCalledWith(expect.objectContaining({ signature: 'p0' }));
  expect(store.setCursor).not.toHaveBeenCalled();
  release([]);
  await scanning;
  expect(store.setCursor).toHaveBeenCalledWith(wallet, 'p0');
});
