const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const spl = require('./token');
const bs58 = require('bs58').default;
const { displayToken } = require('./featured');
const { network } = require('./network');
const { DepositValidationError, UnsupportedTokenError } = require('./errors');
const { assertLiveFunds } = require('../utils/recoveryMode');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');
function publicKey(address) {
  const key = new PublicKey(address);
  if (key.toBase58() !== address || !PublicKey.isOnCurve(key.toBytes())) throw new Error('Use an on-curve Solana wallet address');
  return key;
}
function loadSigner(secret) {
  try {
    const bytes = secret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim());
    if (bytes.length !== 64) throw new Error();
    return Keypair.fromSecretKey(bytes);
  } catch (_) { throw new Error('Invalid SOLANA_PRIVATE_KEY; enter a 64-byte JSON array or base58 key privately'); }
}
class SolanaChain {
  constructor({ connection, signer, env = process.env } = {}) {
    this.env = env;
    this.connection = connection || new Connection(env.SOLANA_RPC_URL, { commitment: 'finalized', confirmTransactionInitialTimeout: 30000, disableRetryOnRateLimit: true, fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) });
    this.signer = signer || loadSigner(env.SOLANA_PRIVATE_KEY || '');
    this.address = this.signer.publicKey.toBase58();
  }
  async validate() {
    const genesis = await this.connection.getGenesisHash();
    const expected = network(this.env);
    if (genesis !== expected.genesis) throw new Error(`RPC does not match configured ${expected.label}; no transactions allowed`);
    if (this.env.SOLANA_WALLET_ADDRESS && this.env.SOLANA_WALLET_ADDRESS !== this.address) throw new Error('Solana signing and deposit wallet mismatch');
    return genesis;
  }
  async tokenInfo(mint) {
    if (mint === 'SOL' || mint === 'NATIVE') return { address: 'NATIVE', symbol: 'SOL', decimals: 9 };
    const address = new PublicKey(mint);
    const account = await this.connection.getAccountInfo(address, 'finalized');
    if (!account || ![spl.TOKEN_PROGRAM_ID.toBase58(), spl.TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.owner.toBase58())) throw new UnsupportedTokenError('Only standard SPL and supported Token-2022 mints are supported');
    const info = spl.parseMint(account, account.owner);
    if (!info.isInitialized || info.decimals > 18) throw new UnsupportedTokenError('Unsupported token mint');
    // Symbols are labels, never token identity. Use exact case-sensitive mint for identity.
    return displayToken({ address: address.toBase58(), symbol: `${mint.slice(0, 5)}…${mint.slice(-4)}`, decimals: info.decimals, program: info.program, extensions: info.extensions }, this.env.SOLANA_CLUSTER);
  }
  async verifyDeposit({ signature, sender, mint, memo, transaction, allowNoMemo = false }) {
    let validSignature = false;
    try { validSignature = typeof signature === 'string' && bs58.decode(signature).length === 64; } catch (_) {}
    if (!validSignature) throw new DepositValidationError('Invalid transaction signature');
    publicKey(sender);
    const tx = transaction || await this.connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta) throw new Error('Deposit not finalized or unavailable; retry');
    if (tx.meta.err) throw new DepositValidationError('Deposit transaction failed');
    if (!tx.transaction.signatures.includes(signature)) throw new DepositValidationError('Transaction signature mismatch');
    const message = tx.transaction.message;
    if (!message.accountKeys.some(k => k.pubkey.toBase58() === sender && k.signer)) throw new DepositValidationError('Registered sending wallet did not sign this deposit');
    // Only simple, direct top-level wallet transfers. No balance-delta heuristics, swaps or CPI guesses.
    const memos = message.instructions.filter(i => i.programId.equals(MEMO));
    if (!(allowNoMemo && memos.length === 0) && (memos.length !== 1 || memos[0].parsed !== memo)) throw new DepositValidationError('Deposit requires the exact game memo or a unique plain-transfer match');
    const transfers = message.instructions.filter(i => ['transfer', 'transferChecked'].includes(i.parsed?.type));
    if (transfers.length !== 1 || tx.meta.innerInstructions?.some(i => i.instructions.some(inner => ['transfer', 'transferChecked'].includes(inner.parsed?.type)))) throw new DepositValidationError('Use one direct transfer with no program-invoked transfers');
    const instruction = transfers[0];
    const info = instruction.parsed.info;
    if (mint === 'NATIVE') {
      if (!instruction.programId.equals(SystemProgram.programId) || info.source !== sender || info.destination !== this.address) throw new DepositValidationError('Wrong SOL sender, recipient or program');
      if (!Number.isSafeInteger(info.lamports) || info.lamports <= 0) throw new DepositValidationError('Unsupported SOL transfer amount');
      return BigInt(info.lamports);
    }
    if (![spl.TOKEN_PROGRAM_ID.toBase58(), spl.TOKEN_2022_PROGRAM_ID.toBase58()].includes(instruction.programId.toBase58()) || instruction.parsed.type !== 'transferChecked' || info.mint !== mint || info.authority !== sender) throw new DepositValidationError('Use a supported SPL transferChecked for the exact mint');
    if (instruction.programId.equals(spl.TOKEN_2022_PROGRAM_ID)) {
      const token = await this.tokenInfo(mint);
      if (token.program !== instruction.programId.toBase58()) throw new DepositValidationError('Token program mismatch');
    }
    const expectedATA = spl.getAssociatedTokenAddressSync(new PublicKey(mint), this.signer.publicKey, instruction.programId).toBase58();
    if (info.destination !== expectedATA) throw new DepositValidationError('Wrong token recipient');
    const sourceIndex = message.accountKeys.findIndex(k => k.pubkey.toBase58() === info.source);
    const source = tx.meta.preTokenBalances?.find(b => b.accountIndex === sourceIndex);
    const destinationIndex = message.accountKeys.findIndex(k => k.pubkey.toBase58() === info.destination);
    const destination = tx.meta.postTokenBalances?.find(b => b.accountIndex === destinationIndex);
    if (source?.owner !== sender || source?.mint !== mint || destination?.owner !== this.address || destination?.mint !== mint) throw new DepositValidationError('Token-account owner or mint mismatch');
    const amount = info.tokenAmount?.amount;
    if (!/^\d+$/.test(amount || '') || BigInt(amount) <= 0n) throw new DepositValidationError('Invalid token amount');
    return BigInt(amount);
  }
  async buildPayment({ id, mint, recipient, amount, kind }) {
    assertLiveFunds(this.env);
    await this.validate();
    const burning = kind === 'burn';
    if (burning && recipient) throw new Error('Burn instructions must not specify a recipient');
    const to = burning ? INCINERATOR : publicKey(recipient);
    const value = BigInt(amount);
    if (value <= 0n || value > 18446744073709551615n) throw new Error('Invalid payout');
    const tx = new Transaction();
    if (mint === 'NATIVE') {
      tx.add(SystemProgram.transfer({ fromPubkey: this.signer.publicKey, toPubkey: to, lamports: value }));
    } else {
      const info = await this.tokenInfo(mint);
      const mintKey = new PublicKey(mint);
      const program = new PublicKey(info.program);
      const source = spl.getAssociatedTokenAddressSync(mintKey, this.signer.publicKey, program);
      if (burning) {
        tx.add(spl.createBurnCheckedInstruction(source, mintKey, this.signer.publicKey, value, info.decimals, program));
      } else {
        const target = spl.getAssociatedTokenAddressSync(mintKey, to, program);
        tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, target, to, mintKey, program));
        tx.add(spl.createTransferCheckedInstruction(source, mintKey, target, this.signer.publicKey, value, info.decimals, program));
      }
    }
    tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`coinflip:payout:${id}`) }));
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.signer.publicKey;
    tx.sign(this.signer);
    const fee = (await this.connection.getFeeForMessage(tx.compileMessage(), 'finalized')).value;
    if (fee === null) throw new Error('Cannot estimate transaction fee');
    const balance = await this.connection.getBalance(this.signer.publicKey, 'finalized');
    // A small independently funded SOL reserve pays fees and token-account rent. Never reduce the payout.
    const reserve = 10000000n; // 0.01 SOL; includes allowance for one new ATA.
    if (BigInt(balance) < (mint === 'NATIVE' ? value : 0n) + BigInt(fee) + reserve) throw new Error('Fund the bot fee reserve; full payout retained as pending');
    return { raw: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature), lastValidBlockHeight };
  }
  async assertSolvent(liabilities) {
    await this.validate();
    const requiredSOL = BigInt(liabilities.find(p => p.mint === 'NATIVE')?.amount || '0') + 10000000n;
    const balance = await this.connection.getBalance(this.signer.publicKey, 'finalized');
    if (!Number.isSafeInteger(balance) || BigInt(balance) < requiredSOL) throw new Error('Treasury does not cover all liabilities plus the SOL reserve');
    for (const p of liabilities.filter(p => p.mint !== 'NATIVE' && BigInt(p.amount) > 0n)) {
      const info = await this.tokenInfo(p.mint);
      const ata = spl.getAssociatedTokenAddressSync(new PublicKey(p.mint), this.signer.publicKey, new PublicKey(info.program));
      const held = (await this.connection.getTokenAccountBalance(ata, 'finalized')).value.amount;
      if (!/^\d+$/.test(held) || BigInt(held) < BigInt(p.amount)) throw new Error('Token treasury does not cover all recorded liabilities');
    }
  }
  async broadcast(payment) {
    assertLiveFunds(this.env);
    await this.validate();
    // Rebroadcast only the original signed bytes. Never build a replacement on an ambiguous response.
    const result = await this.connection.sendRawTransaction(Buffer.from(payment.raw, 'base64'), { skipPreflight: false, maxRetries: 0, preflightCommitment: 'finalized' });
    if (result !== payment.signature) throw new Error('RPC returned an unexpected signature');
  }
  async assertHolderReserveCoverage(wallet, reserves) {
    await this.validate();
    const owner = publicKey(wallet);
    for (const p of reserves) {
      const amount = BigInt(p.amount);
      if (amount <= 0n) continue;
      let held;
      if (p.mint === 'NATIVE') {
        const balance = await this.connection.getBalance(owner, 'finalized');
        if (!Number.isSafeInteger(balance)) throw new Error('Holder SOL balance unavailable');
        held = BigInt(balance);
      } else {
        const info = await this.tokenInfo(p.mint);
        const ata = spl.getAssociatedTokenAddressSync(new PublicKey(p.mint), owner, new PublicKey(info.program));
        const balance = (await this.connection.getTokenAccountBalance(ata, 'finalized')).value.amount;
        if (!/^\d+$/.test(balance)) throw new Error('Holder token balance unavailable');
        held = BigInt(balance);
      }
      if (held < amount) throw new Error('Holder wallet does not cover its recorded reserves');
    }
  }
  async paymentStatus(signature) {
    await this.validate();
    const result = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!result) return 'unknown';
    if (result.err) return 'failed';
    return result.confirmationStatus === 'finalized' ? 'finalized' : 'pending';
  }
}
module.exports = { SolanaChain, publicKey, loadSigner, DEVNET_GENESIS, MEMO, INCINERATOR };
