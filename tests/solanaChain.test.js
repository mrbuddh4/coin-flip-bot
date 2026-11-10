const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { SolanaChain, DEVNET_GENESIS, MEMO, loadSigner } = require('../src/solana/chain');
const token = require('../src/solana/token');
const { toUnits, fromUnits, splitPool } = require('../src/solana/amounts');
const signer = Keypair.fromSeed(Buffer.alloc(32, 1));
const sender = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey.toBase58();
const mint = Keypair.fromSeed(Buffer.alloc(32, 3)).publicKey.toBase58();
const signature = bs58.encode(Buffer.alloc(64, 4));
const env = { SOLANA_CLUSTER: 'devnet', BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true' };
function fixture(native = true) {
  const target = token.getAssociatedTokenAddressSync(new PublicKey(mint), signer.publicKey).toBase58();
  const source = token.getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(sender)).toBase58();
  return { meta: { err: null, innerInstructions: [], preTokenBalances: [{ accountIndex: 1, owner: sender, mint }], postTokenBalances: [{ accountIndex: 2, owner: signer.publicKey.toBase58(), mint }] },
    transaction: { signatures: [signature], message: { accountKeys: [
      { pubkey: new PublicKey(sender), signer: true }, { pubkey: new PublicKey(source), signer: false }, { pubkey: new PublicKey(target), signer: false },
    ], instructions: [ { programId: MEMO, parsed: 'game-memo' }, native ?
      { programId: SystemProgram.programId, parsed: { type: 'transfer', info: { source: sender, destination: signer.publicKey.toBase58(), lamports: 1000000001 } } } :
      { programId: token.TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: { source, destination: target, mint, authority: sender, tokenAmount: { amount: '123456789012345678', decimals: 6 } } } },
    ] } } };
}
function setup(tx = fixture(), customEnv = env) {
  const connection = {
    getGenesisHash: jest.fn().mockResolvedValue(DEVNET_GENESIS),
    getParsedTransaction: jest.fn().mockResolvedValue(tx),
    getSignatureStatuses: jest.fn().mockResolvedValue({ value: [{ err: null, confirmationStatus: 'finalized' }] }),
    getLatestBlockhash: jest.fn().mockResolvedValue({ blockhash: bs58.encode(Buffer.alloc(32, 5)), lastValidBlockHeight: 123 }),
    getFeeForMessage: jest.fn().mockResolvedValue({ value: 5000 }),
    getBalance: jest.fn().mockResolvedValue(5000000000),
    sendRawTransaction: jest.fn(async raw => bs58.encode(Transaction.from(raw).signature)),
  };
  return { chain: new SolanaChain({ connection, signer, env: customEnv }), connection };
}
test('amounts preserve a single lamport and large SPL values exactly', () => {
  expect(toUnits('1.000000001', 9)).toBe(1000000001n);
  expect(toUnits('123456789012.345678', 6)).toBe(123456789012345678n);
  expect(fromUnits(1000000001n, 9)).toBe('1.000000001');
  for (const amount of ['1e3', '-1', '0', '1.0000000001', '1xyz', 'NaN']) expect(() => toUnits(amount, 9)).toThrow();
  for (const wager of [1n, 99n, 1000000001n]) { const s = splitPool(wager); expect(s.prize + s.holderFee + s.burnFee).toBe(wager * 2n); }
});
test('owner provided shared address is a valid on-curve public key', () => {
  expect(PublicKey.isOnCurve(new PublicKey('6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY').toBytes())).toBe(true);
});
test('accepts exact finalized SOL transfer with signed source and memo', async () => {
  const { chain, connection } = setup();
  expect(await chain.verifyDeposit({ signature, sender, mint: 'NATIVE', memo: 'game-memo' })).toBe(1000000001n);
  expect(connection.getParsedTransaction).toHaveBeenCalledWith(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
});
test('accepts exact large standard SPL amount without float conversion', async () => {
  expect(await setup(fixture(false)).chain.verifyDeposit({ signature, sender, mint, memo: 'game-memo' })).toBe(123456789012345678n);
});
test.each(['recipient', 'sender', 'unsigned', 'memo', 'failed', 'inner', 'multiple', 'unsafe', 'signature'])('rejects invalid SOL proof: %s', async kind => {
  const tx = fixture(); const info = tx.transaction.message.instructions[1].parsed.info;
  if (kind === 'recipient') info.destination = sender;
  if (kind === 'sender') info.source = signer.publicKey.toBase58();
  if (kind === 'unsigned') tx.transaction.message.accountKeys[0].signer = false;
  if (kind === 'memo') tx.transaction.message.instructions[0].parsed = 'wrong';
  if (kind === 'failed') tx.meta.err = { failure: true };
  if (kind === 'inner') tx.meta.innerInstructions = [{ instructions: [{ parsed: { type: 'transfer' } }] }];
  if (kind === 'multiple') tx.transaction.message.instructions.push(tx.transaction.message.instructions[1]);
  if (kind === 'unsafe') info.lamports = Number.MAX_SAFE_INTEGER + 1;
  if (kind === 'signature') tx.transaction.signatures = [];
  await expect(setup(tx).chain.verifyDeposit({ signature, sender, mint: 'NATIVE', memo: 'game-memo' })).rejects.toThrow();
});
test.each(['mint', 'owner', 'ata', 'program', 'authority'])('rejects invalid SPL proof: %s', async kind => {
  const tx = fixture(false); const ins = tx.transaction.message.instructions[1];
  if (kind === 'mint') ins.parsed.info.mint = sender;
  if (kind === 'owner') tx.meta.preTokenBalances[0].owner = signer.publicKey.toBase58();
  if (kind === 'ata') ins.parsed.info.destination = sender;
  if (kind === 'program') ins.programId = SystemProgram.programId;
  if (kind === 'authority') ins.parsed.info.authority = signer.publicKey.toBase58();
  await expect(setup(tx).chain.verifyDeposit({ signature, sender, mint, memo: 'game-memo' })).rejects.toThrow();
});
test('pilot rejects mainnet and mismatched signing wallet', async () => {
  const a = setup(); a.connection.getGenesisHash.mockResolvedValue('mainnet');
  await expect(a.chain.validate()).rejects.toThrow('devnet');
  const b = setup(undefined, { ...env, SOLANA_WALLET_ADDRESS: sender });
  await expect(b.chain.validate()).rejects.toThrow('mismatch');
});
test.each([
  ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', true],
  ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1', false],
  ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', false],
  ['4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', false],
])('runtime verifies full cluster genesis %s independently of its constant', async (genesis, allowed) => {
  const { chain, connection } = setup();
  connection.getGenesisHash.mockResolvedValue(genesis);
  if (allowed) await expect(chain.validate()).resolves.toBe(genesis);
  else await expect(chain.validate()).rejects.toThrow('devnet');
});
test('never signs or broadcasts in recovery mode', async () => {
  const { chain, connection } = setup(undefined, {});
  await expect(chain.buildPayment({ id: 'a', mint: 'NATIVE', recipient: sender, amount: '1' })).rejects.toThrow('Funds disabled');
  await expect(chain.broadcast({ raw: '' })).rejects.toThrow('Funds disabled');
  expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});
test('signed payouts serialize exact value, memo, signature and never broadcast while building', async () => {
  const { chain, connection } = setup();
  const signed = await chain.buildPayment({ id: 'prize:abc', mint: 'NATIVE', recipient: sender, amount: '123456789' });
  const tx = Transaction.from(Buffer.from(signed.raw, 'base64'));
  expect(tx.verifySignatures()).toBe(true);
  expect(tx.instructions[0].data.readBigUInt64LE(4)).toBe(123456789n);
  expect(tx.instructions[1].data.toString()).toBe('coinflip:payout:prize:abc');
  expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  await chain.broadcast(signed); await chain.broadcast(signed);
  expect(connection.sendRawTransaction.mock.calls[0][0]).toEqual(connection.sendRawTransaction.mock.calls[1][0]);
});
test('insufficient fee reserve fails without reducing a payout', async () => {
  const { chain, connection } = setup(); connection.getBalance.mockResolvedValue(1);
  await expect(chain.buildPayment({ id: 'x', mint: 'NATIVE', recipient: sender, amount: '123' })).rejects.toThrow('reserve');
});
test('failed and unfinalized payments never count as confirmed', async () => {
  const { chain, connection } = setup();
  for (const [status, result] of [[null, 'unknown'], [{ err: 'failed' }, 'failed'], [{ err: null, confirmationStatus: 'confirmed' }, 'pending']]) {
    connection.getSignatureStatuses.mockResolvedValue({ value: [status] });
    expect(await chain.paymentStatus(signature)).toBe(result);
  }
});
test('invalid secret errors contain no secret value', () => {
  expect(() => loadSigner('private-garbage')).toThrow('Invalid SOLANA_PRIVATE_KEY');
});
test('SPL addresses, instruction bytes and account flags match independent SPL 0.4.14 vectors', () => {
  const v = require('./fixtures/spl-instructions.json');
  const key = x => new PublicKey(x);
  const encode = i => ({ programId: i.programId.toBase58(), keys: i.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })), data: i.data.toString('hex') });
  expect(token.getAssociatedTokenAddressSync(key(v.mint), key(v.payer)).toBase58()).toBe(v.source);
  expect(token.getAssociatedTokenAddressSync(key(v.mint), key(v.to)).toBase58()).toBe(v.target);
  expect(encode(token.createAssociatedTokenAccountIdempotentInstruction(key(v.payer), key(v.target), key(v.to), key(v.mint)))).toEqual(v.create);
  expect(encode(token.createTransferCheckedInstruction(key(v.source), key(v.mint), key(v.target), key(v.payer), 123456789n, 6))).toEqual(v.transfer);
});
test('resolves custom mint decimals and rejects Token-2022 owners', async () => {
  const { chain, connection } = setup();
  const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;
  connection.getAccountInfo = jest.fn().mockResolvedValue({ owner: token.TOKEN_PROGRAM_ID, data });
  expect(await chain.tokenInfo(mint)).toMatchObject({ address: mint, decimals: 6 });
  connection.getAccountInfo.mockResolvedValue({ owner: SystemProgram.programId, data });
  await expect(chain.tokenInfo(mint)).rejects.toThrow('standard SPL');
});
test('custom SPL payout creates the canonical ATA and signs a checked transfer with exact units', async () => {
  const { chain, connection } = setup();
  const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;
  connection.getAccountInfo = jest.fn().mockResolvedValue({ owner: token.TOKEN_PROGRAM_ID, data });
  const signed = await chain.buildPayment({ id: 'custom', mint, recipient: sender, amount: '123456789012345678' });
  const tx = Transaction.from(Buffer.from(signed.raw, 'base64'));
  expect(tx.verifySignatures()).toBe(true);
  expect(tx.instructions[1].programId.equals(token.TOKEN_PROGRAM_ID)).toBe(true);
  expect(tx.instructions[1].data.readBigUInt64LE(1)).toBe(123456789012345678n);
  expect(tx.instructions[1].data[9]).toBe(6);
  expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});
