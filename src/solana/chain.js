const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const spl = require('./token');
const bs58 = require('bs58').default;
const { assertLiveFunds } = require('../utils/recoveryMode');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
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
    this.connection = connection || new Connection(env.SOLANA_RPC_URL, { commitment: 'finalized', confirmTransactionInitialTimeout: 30000 });
    this.signer = signer || loadSigner(env.SOLANA_PRIVATE_KEY || '');
    this.address = this.signer.publicKey.toBase58();
  }
  async validate() {
    const genesis = await this.connection.getGenesisHash();
    // The restored game is initially an isolated devnet pilot. A config typo cannot select mainnet.
    if (genesis !== DEVNET_GENESIS || this.env.SOLANA_CLUSTER !== 'devnet') throw new Error('Solana pilot requires verified devnet RPC and SOLANA_CLUSTER=devnet');
    if (this.env.SOLANA_WALLET_ADDRESS && this.env.SOLANA_WALLET_ADDRESS !== this.address) throw new Error('Solana signing and deposit wallet mismatch');
    return genesis;
  }
  async tokenInfo(mint) {
    if (mint === 'SOL' || mint === 'NATIVE') return { address: 'NATIVE', symbol: 'SOL', decimals: 9 };
    const address = new PublicKey(mint);
    const account = await this.connection.getAccountInfo(address, 'finalized');
    if (!account || !account.owner.equals(spl.TOKEN_PROGRAM_ID)) throw new Error('Only standard SPL tokens supported; Token-2022, transfer fees and hooks are not supported');
    const info = await spl.getMint(this.connection, address, 'finalized', spl.TOKEN_PROGRAM_ID);
    if (!info.isInitialized || info.decimals > 18) throw new Error('Unsupported token mint');
    // Symbols are labels, never token identity. Use exact case-sensitive mint for identity.
    return { address: address.toBase58(), symbol: `${mint.slice(0, 5)}…${mint.slice(-4)}`, decimals: info.decimals };
  }
  async verifyDeposit({ signature, sender, mint, memo }) {
    if (typeof signature !== 'string' || bs58.decode(signature).length !== 64) throw new Error('Invalid transaction signature');
    publicKey(sender);
    const tx = await this.connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta || tx.meta.err) throw new Error('Deposit not successful and finalized yet');
    if (!tx.transaction.signatures.includes(signature)) throw new Error('Transaction signature mismatch');
    const message = tx.transaction.message;
    if (!message.accountKeys.some(k => k.pubkey.toBase58() === sender && k.signer)) throw new Error('Registered sending wallet did not sign this deposit');
    // Only simple, direct top-level wallet transfers. No balance-delta heuristics, swaps or CPI guesses.
    const memos = message.instructions.filter(i => i.programId.equals(MEMO));
    if (memos.length !== 1 || memos[0].parsed !== memo) throw new Error('Deposit requires the exact game memo');
    const transfers = message.instructions.filter(i => ['transfer', 'transferChecked'].includes(i.parsed?.type));
    if (transfers.length !== 1 || tx.meta.innerInstructions?.some(i => i.instructions.some(inner => ['transfer', 'transferChecked'].includes(inner.parsed?.type)))) throw new Error('Use one direct transfer with no program-invoked transfers');
    const instruction = transfers[0];
    const info = instruction.parsed.info;
    if (mint === 'NATIVE') {
      if (!instruction.programId.equals(SystemProgram.programId) || info.source !== sender || info.destination !== this.address) throw new Error('Wrong SOL sender, recipient or program');
      if (!Number.isSafeInteger(info.lamports) || info.lamports <= 0) throw new Error('Unsupported SOL transfer amount');
      return BigInt(info.lamports);
    }
    if (!instruction.programId.equals(spl.TOKEN_PROGRAM_ID) || instruction.parsed.type !== 'transferChecked' || info.mint !== mint || info.authority !== sender) throw new Error('Use a standard SPL transferChecked for the exact mint');
    const expectedATA = spl.getAssociatedTokenAddressSync(new PublicKey(mint), this.signer.publicKey).toBase58();
    if (info.destination !== expectedATA) throw new Error('Wrong token recipient');
    const sourceIndex = message.accountKeys.findIndex(k => k.pubkey.toBase58() === info.source);
    const source = tx.meta.preTokenBalances?.find(b => b.accountIndex === sourceIndex);
    const destinationIndex = message.accountKeys.findIndex(k => k.pubkey.toBase58() === info.destination);
    const destination = tx.meta.postTokenBalances?.find(b => b.accountIndex === destinationIndex);
    if (source?.owner !== sender || source?.mint !== mint || destination?.owner !== this.address || destination?.mint !== mint) throw new Error('Token-account owner or mint mismatch');
    const amount = info.tokenAmount?.amount;
    if (!/^\d+$/.test(amount || '') || BigInt(amount) <= 0n) throw new Error('Invalid token amount');
    return BigInt(amount);
  }
  async buildPayment({ id, mint, recipient, amount }) {
    assertLiveFunds(this.env);
    await this.validate();
    const to = publicKey(recipient);
    const value = BigInt(amount);
    if (value <= 0n || value > 18446744073709551615n) throw new Error('Invalid payout');
    const tx = new Transaction();
    if (mint === 'NATIVE') {
      tx.add(SystemProgram.transfer({ fromPubkey: this.signer.publicKey, toPubkey: to, lamports: value }));
    } else {
      const info = await this.tokenInfo(mint);
      const mintKey = new PublicKey(mint);
      const source = spl.getAssociatedTokenAddressSync(mintKey, this.signer.publicKey);
      const target = spl.getAssociatedTokenAddressSync(mintKey, to);
      tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, target, to, mintKey));
      tx.add(spl.createTransferCheckedInstruction(source, mintKey, target, this.signer.publicKey, value, info.decimals));
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
    const reserve = 10000000n; // 0.01 devnet SOL; includes allowance for one new ATA.
    if (BigInt(balance) < (mint === 'NATIVE' ? value : 0n) + BigInt(fee) + reserve) throw new Error('Fund the bot fee reserve; full payout retained as pending');
    return { raw: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature), lastValidBlockHeight };
  }
  async broadcast(payment) {
    assertLiveFunds(this.env);
    await this.validate();
    // Rebroadcast only the original signed bytes. Never build a replacement on an ambiguous response.
    const result = await this.connection.sendRawTransaction(Buffer.from(payment.raw, 'base64'), { skipPreflight: false, maxRetries: 0, preflightCommitment: 'finalized' });
    if (result !== payment.signature) throw new Error('RPC returned an unexpected signature');
  }
  async paymentStatus(signature) {
    const result = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!result) return 'unknown';
    if (result.err) return 'failed';
    return result.confirmationStatus === 'finalized' ? 'finalized' : 'pending';
  }
}
module.exports = { SolanaChain, publicKey, loadSigner, DEVNET_GENESIS, MEMO };
