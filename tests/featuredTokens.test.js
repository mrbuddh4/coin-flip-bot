const { PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const spl = require('../src/solana/token');
const { SolanaChain, DEVNET_GENESIS, MEMO } = require('../src/solana/chain');
const { tokensForUser, SID_MINT, displayToken } = require('../src/solana/featured');
const v = require('./fixtures/sid-token2022.json');
const key = value => new PublicKey(value);
const encode = instruction => ({ programId: instruction.programId.toBase58(), keys: instruction.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })), data: instruction.data.toString('hex') });
const account = () => ({ owner: spl.TOKEN_2022_PROGRAM_ID, data: Buffer.from(v.mintData, 'base64') });
test('every mainnet user gets SOL and exact SID without saving favorites; no ticker-based deduplication', () => {
  for (const saved of [[], [{ address: SID_MINT, symbol: 'wrong', decimals: 0 }], [{ address: 'other-case-sensitive-mint', symbol: 'SID', decimals: 9 }]]) {
    const tokens = tokensForUser(saved, 'mainnet-beta');
    expect(tokens.filter(t => t.address === SID_MINT)).toEqual([expect.objectContaining({ symbol: 'SID', decimals: 6, featured: true })]);
    expect(tokens[0].address).toBe('NATIVE');
  }
  expect(tokensForUser([{ address: 'other', symbol: 'SID' }], 'mainnet-beta')).toHaveLength(3);
  expect(tokensForUser([], 'devnet').some(t => t.address === SID_MINT)).toBe(false);
  expect(displayToken({ address: 'copycat', symbol: 'OTHER' }, 'mainnet-beta').symbol).toBe('OTHER');
});
test('real SID Token-2022 mint resolves six decimals and descriptive extensions', async () => {
  const connection = { getAccountInfo: jest.fn(async () => account()) };
  const info = await spl.getMint(connection, key(v.mint), 'finalized', spl.TOKEN_2022_PROGRAM_ID);
  expect(info).toMatchObject({ decimals: 6, program: spl.TOKEN_2022_PROGRAM_ID.toBase58(), extensions: [18, 19] });
  const chain = new SolanaChain({ connection, signer: Keypair.fromSeed(Buffer.alloc(32, 1)), env: { SOLANA_CLUSTER: 'mainnet-beta' } });
  expect(await chain.tokenInfo(SID_MINT)).toMatchObject({ address: SID_MINT, symbol: 'SID', decimals: 6 });
});
test('Token-2022 ATA addresses and signed transfer instructions match independent SDK vectors', () => {
  const program = spl.TOKEN_2022_PROGRAM_ID;
  expect(spl.getAssociatedTokenAddressSync(key(v.mint), key(v.payer), program).toBase58()).toBe(v.source);
  expect(spl.getAssociatedTokenAddressSync(key(v.mint), key(v.owner), program).toBase58()).toBe(v.target);
  expect(encode(spl.createAssociatedTokenAccountIdempotentInstruction(key(v.payer), key(v.target), key(v.owner), key(v.mint), program))).toEqual(v.create);
  expect(encode(spl.createTransferCheckedInstruction(key(v.source), key(v.mint), key(v.target), key(v.payer), 123456789n, 6, program))).toEqual(v.transfer);
  expect(spl.getAssociatedTokenAddressSync(key(v.mint), key(v.payer)).toBase58()).not.toBe(v.source);
});
test.each([1, 3, 4, 6, 9, 10, 12, 14, 25, 26, 28, 99])('rejects transfer-changing or unknown Token-2022 extension %s', async type => {
  const a = account(); a.data.writeUInt16LE(type, 166);
  await expect(spl.getMint({ getAccountInfo: async () => a }, key(v.mint), 'finalized', spl.TOKEN_2022_PROGRAM_ID)).rejects.toThrow('Unsupported');
});
test.each(['length', 'type', 'duplicate'])('rejects malformed extended mint: %s', async kind => {
  const a = account();
  if (kind === 'length') a.data.writeUInt16LE(65535, 168);
  if (kind === 'type') a.data[165] = 2;
  if (kind === 'duplicate') a.data.writeUInt16LE(18, 234);
  await expect(spl.getMint({ getAccountInfo: async () => a }, key(v.mint), 'finalized', spl.TOKEN_2022_PROGRAM_ID)).rejects.toThrow();
});
test('SID payouts use Token-2022 for both recipient ATA creation and checked transfer', async () => {
  const signer = Keypair.fromSeed(Buffer.alloc(32, 1));
  const connection = {
    getGenesisHash: async () => DEVNET_GENESIS, getAccountInfo: async () => account(),
    getLatestBlockhash: async () => ({ blockhash: key(v.mint).toBase58(), lastValidBlockHeight: 123 }),
    getFeeForMessage: async () => ({ value: 5000 }), getBalance: async () => 1000000000,
  };
  // Simulate an identical mint on devnet to exercise signing without enabling mainnet.
  const chain = new SolanaChain({ connection, signer, env: { SOLANA_CLUSTER: 'devnet', BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true' } });
  const payment = await chain.buildPayment({ id: 'sid', mint: SID_MINT, recipient: v.owner, amount: '123456789' });
  const tx = Transaction.from(Buffer.from(payment.raw, 'base64'));
  expect(tx.verifySignatures()).toBe(true);
  expect(tx.instructions[0].keys[5].pubkey.equals(spl.TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect(tx.instructions[1].programId.equals(spl.TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect(tx.instructions[1].data.readBigUInt64LE(1)).toBe(123456789n);
});
