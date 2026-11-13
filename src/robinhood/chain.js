const { ethers } = require('ethers');
const { assertLiveFunds } = require('../utils/recoveryMode');
const { DepositValidationError, UnsupportedTokenError } = require('../solana/errors');
const CHAIN_ID = 4663;
const SID = '0x99f2f175df58e31d8f8368f11e2e2c7f8dbdc3f8';
const DEAD = '0x000000000000000000000000000000000000dead';
const MAXIMUM = (1n << 256n) - 1n;
const ERC20 = new ethers.Interface([
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const HASH = /^0x[0-9a-f]{64}$/i;
function normalizeAddress(value) {
  const address = ethers.getAddress(value).toLowerCase();
  if ([ethers.ZeroAddress, DEAD].includes(address)) throw new Error('Use a personal EVM wallet address');
  return address;
}
function holderWallet(env) {
  if (!env.ROBINHOOD_HOLDER_WALLET_ADDRESS) return null;
  const address = normalizeAddress(env.ROBINHOOD_HOLDER_WALLET_ADDRESS);
  if (address === normalizeAddress(env.ROBINHOOD_WALLET_ADDRESS)) throw new Error('Holder wallet must differ from treasury');
  return address;
}
class RobinhoodChain {
  constructor({ env = process.env, provider, signer, nextNonce } = {}) {
    this.env = env;
    const request = new ethers.FetchRequest(env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com');
    request.timeout = 15000;
    this.provider = provider || new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
    this.signer = signer || new ethers.Wallet(env.ROBINHOOD_PRIVATE_KEY || '');
    this.address = normalizeAddress(this.signer.address);
    this.nextNonce = nextNonce;
    this.chainId = CHAIN_ID; this.cluster = 'robinhood-mainnet'; this.maximumAmount = MAXIMUM;
    this.label = 'Robinhood Chain mainnet (4663)'; this.nativeSymbol = 'ETH'; this.key = 'robinhood';
    this.expiredPaymentReason = 'Nonce consumed without finalized proof of the original hash; reconcile before any replacement';
    this.confirmationMode = env.ROBINHOOD_CONFIRMATION_MODE || 'finalized';
    if (!['finalized', 'l2'].includes(this.confirmationMode)) throw new Error('ROBINHOOD_CONFIRMATION_MODE must be finalized or l2');
    this.confirmationBlocks = Number(env.ROBINHOOD_CONFIRMATION_BLOCKS || 20);
    if (!Number.isSafeInteger(this.confirmationBlocks) || this.confirmationBlocks < 20 || this.confirmationBlocks > 10000) throw new Error('ROBINHOOD_CONFIRMATION_BLOCKS must be 20 to 10000');
    this.realFunds = true; this.depositWindowMs = (this.confirmationMode === 'l2' ? 3 : 30) * 60 * 1000;
    this.label += this.confirmationMode === 'l2' ? ` · L2 confirmed (${this.confirmationBlocks} blocks)` : ' · Ethereum finalized';
  }
  normalizeAddress(value) { return normalizeAddress(value); }
  async rpc(method, params) {
    // Never print raw provider errors: private RPC URLs can contain API keys.
    return this.provider.send(method, params);
  }
  async validate() {
    await this.assertHealthy?.();
    if (BigInt(await this.rpc('eth_chainId', [])) !== BigInt(CHAIN_ID)) throw new Error('RPC does not match configured Robinhood chain');
    if (normalizeAddress(this.env.ROBINHOOD_WALLET_ADDRESS) !== this.address) throw new Error('Robinhood signing and deposit wallet mismatch');
    return `eip155:${CHAIN_ID}`;
  }
  async finalized() {
    let tag = 'finalized';
    if (this.confirmationMode === 'l2') {
      const head = await this.rpc('eth_getBlockByNumber', ['latest', false]);
      if (!head || !/^0x[0-9a-f]+$/i.test(head.number) || BigInt(head.number) < BigInt(this.confirmationBlocks)) throw new Error('Robinhood L2 head unavailable');
      tag = ethers.toQuantity(BigInt(head.number) - BigInt(this.confirmationBlocks));
    }
    const b = await this.rpc('eth_getBlockByNumber', [tag, false]);
    if (!b || !HASH.test(b.hash) || !/^0x[0-9a-f]+$/i.test(b.number) || !/^0x[0-9a-f]+$/i.test(b.timestamp)) throw new Error('Finalized Robinhood block unavailable');
    return b;
  }
  async call(address, method, args = [], tag = 'finalized') {
    const raw = await this.rpc('eth_call', [{ to: address, data: ERC20.encodeFunctionData(method, args) }, tag]);
    return ERC20.decodeFunctionResult(method, raw)[0];
  }
  async tokenInfo(input) {
    await this.validate();
    if (input === 'NATIVE' || input === 'ETH') return { address: 'NATIVE', symbol: 'ETH', decimals: 18, chainId: CHAIN_ID, maximumAmount: MAXIMUM.toString() };
    const address = normalizeAddress(input);
    const tag = (await this.finalized()).number;
    if (!/^0x[0-9a-f]{2,}$/i.test(await this.rpc('eth_getCode', [address, tag]))) throw new UnsupportedTokenError('No ERC-20 contract on Robinhood at that address');
    let decimals, supply;
    try { decimals = Number(await this.call(address, 'decimals', [], tag)); supply = await this.call(address, 'totalSupply', [], tag); }
    catch (_) { throw new UnsupportedTokenError('Contract does not expose standard ERC-20 metadata'); }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || supply <= 0n) throw new UnsupportedTokenError('ERC-20 decimals or supply unsupported');
    let symbol = `${address.slice(0, 6)}…${address.slice(-4)}`;
    try { const raw = await this.call(address, 'symbol', [], tag); if (/^[A-Za-z0-9$._ -]{1,20}$/.test(raw)) symbol = raw; } catch (_) {}
    if (address === SID) { if (decimals !== 18) throw new UnsupportedTokenError('SID decimals changed'); symbol = 'SID'; }
    return { address, symbol, decimals, chainId: CHAIN_ID, program: 'ERC20', maximumAmount: MAXIMUM.toString() };
  }
  tokensForUser(saved) {
    const defaults = [{ address: 'NATIVE', symbol: 'ETH', decimals: 18 }, { address: SID, symbol: 'SID', decimals: 18 }].map(t => ({ ...t, chainId: CHAIN_ID, featured: true }));
    return [...defaults, ...saved.filter(t => t.chainId === CHAIN_ID && !defaults.some(d => d.address === t.address))];
  }
  explorer(hash) { if (!HASH.test(hash)) throw new Error('Invalid transaction hash'); return `https://robinhoodchain.blockscout.com/tx/${hash}`; }
  async receiptProof(hash) {
    if (!HASH.test(hash)) throw new DepositValidationError('Invalid transaction hash');
    await this.validate();
    const [tx, receipt, final] = await Promise.all([this.rpc('eth_getTransactionByHash', [hash]), this.rpc('eth_getTransactionReceipt', [hash]), this.finalized()]);
    if (!tx || !receipt || receipt.blockNumber == null || BigInt(receipt.blockNumber) > BigInt(final.number)) throw new Error('Transaction is not finalized or history unavailable');
    if (tx.hash?.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash?.toLowerCase() !== hash.toLowerCase() || tx.blockHash !== receipt.blockHash) throw new Error('RPC transaction/receipt mismatch');
    const block = await this.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!block || block.hash !== receipt.blockHash || !block.transactions?.some(t => (typeof t === 'string' ? t : t.hash)?.toLowerCase() === hash.toLowerCase())) throw new Error('Canonical receipt proof unavailable');
    if (BigInt(receipt.status) !== 1n) throw new DepositValidationError('Transaction failed');
    return { tx, receipt, block, blockTime: Number(BigInt(block.timestamp)) };
  }
  async verifyDeposit({ signature, sender, mint, transaction }) {
    // Re-read canonical finality even when the scanner supplied a decoded hint.
    const proof = await this.receiptProof(signature), { tx, receipt } = proof;
    if (normalizeAddress(tx.from) !== normalizeAddress(sender) || BigInt(tx.chainId) !== BigInt(CHAIN_ID)) throw new DepositValidationError('Wrong sending wallet or chain');
    if (transaction && (transaction.blockTime !== proof.blockTime || transaction.hash?.toLowerCase() !== signature.toLowerCase())) throw new Error('Scanner proof changed; retry');
    if (mint === 'NATIVE') {
      if (tx.to?.toLowerCase() !== this.address || (tx.input || '0x') !== '0x' || receipt.logs?.length || BigInt(tx.value) <= 0n) throw new DepositValidationError('Use a direct native ETH transfer on Robinhood');
      await this.recordProof?.(signature.toLowerCase(), proof.block);
      return BigInt(tx.value);
    }
    mint = normalizeAddress(mint);
    if (tx.to?.toLowerCase() !== mint || BigInt(tx.value) !== 0n) throw new DepositValidationError('Wrong ERC-20 contract');
    let transfer;
    try { transfer = ERC20.parseTransaction({ data: tx.input, value: tx.value }); } catch (_) {}
    if (transfer?.name !== 'transfer' || transfer.args[0].toLowerCase() !== this.address || transfer.args[1] <= 0n || ERC20.encodeFunctionData('transfer', [this.address, transfer.args[1]]).toLowerCase() !== tx.input.toLowerCase()) throw new DepositValidationError('Use a direct ERC-20 transfer to the treasury');
    // Reject taxed/split/forwarded transfers rather than crediting an amount the treasury did not receive.
    const logs = receipt.logs || [];
    let event;
    try { if (logs.length === 1 && logs[0].address.toLowerCase() === mint) event = ERC20.parseLog(logs[0]); } catch (_) {}
    if (event?.name !== 'Transfer' || event.args[0].toLowerCase() !== sender.toLowerCase() || event.args[1].toLowerCase() !== this.address || event.args[2] !== transfer.args[1]) throw new DepositValidationError('Unsupported fee-on-transfer or nonstandard receipt; manual review required');
    await this.recordProof?.(signature.toLowerCase(), proof.block);
    return event.args[2];
  }
  async balance(mint, address = this.address) {
    const tag = (await this.finalized()).number;
    return mint === 'NATIVE' ? BigInt(await this.rpc('eth_getBalance', [address, tag])) : this.call(mint, 'balanceOf', [address], tag);
  }
  async assertSolvent(liabilities) {
    await this.validate();
    await this.checkHistory?.();
    const reserve = ethers.parseEther(this.env.ROBINHOOD_GAS_RESERVE_ETH || '0.001');
    if (reserve < 0n) throw new Error('Invalid gas reserve');
    const native = BigInt(liabilities.find(l => l.mint === 'NATIVE')?.amount || 0);
    if (await this.balance('NATIVE') < native + reserve + (await this.signedGas?.() || 0n)) throw new Error('TREASURY_ETH_SHORTFALL');
    for (const l of liabilities.filter(l => l.mint !== 'NATIVE' && BigInt(l.amount) > 0n)) if (await this.balance(l.mint) < BigInt(l.amount)) throw new Error('Token treasury does not cover all recorded liabilities');
  }
  async buildPayment(payment) {
    assertLiveFunds(this.env); await this.validate();
    const value = BigInt(payment.amount);
    if (value <= 0n || value > MAXIMUM || payment.sourceWallet !== this.address) throw new Error('Invalid payment amount or treasury');
    const recipient = payment.kind === 'burn' ? DEAD : normalizeAddress(payment.recipient);
    if (recipient === this.address || (payment.kind === 'burn' && payment.recipient)) throw new Error('Invalid payment recipient');
    const request = { from: this.address, to: payment.mint === 'NATIVE' ? recipient : normalizeAddress(payment.mint), value: ethers.toQuantity(payment.mint === 'NATIVE' ? value : 0n), data: payment.mint === 'NATIVE' ? '0x' : ERC20.encodeFunctionData('transfer', [recipient, value]) };
    if (payment.mint !== 'NATIVE') {
      const result = await this.rpc('eth_call', [request, 'latest']);
      if (result !== '0x' && ERC20.decodeFunctionResult('transfer', result)[0] !== true) throw new UnsupportedTokenError('ERC-20 transfer returned false');
    }
    const gasLimit = (BigInt(await this.rpc('eth_estimateGas', [request])) * 120n + 99n) / 100n;
    const gasPrice = BigInt(await this.rpc('eth_gasPrice', []));
    if (gasPrice <= 0n || gasLimit <= 0n) throw new Error('Gas estimate unavailable');
    const nonce = this.nextNonce ? await this.nextNonce() : Number(BigInt(await this.rpc('eth_getTransactionCount', [this.address, 'pending'])));
    const cost = gasPrice * gasLimit;
    const liabilities = await this.liabilities?.() || [];
    const owed = BigInt(liabilities.find(l => l.mint === 'NATIVE')?.amount || 0);
    if (await this.balance('NATIVE') < owed + cost + (await this.signedGas?.() || 0n) + ethers.parseEther(this.env.ROBINHOOD_GAS_RESERVE_ETH || '0.001')) throw new Error('TREASURY_ETH_SHORTFALL');
    const raw = await this.signer.signTransaction({ to: request.to, value: BigInt(request.value), data: request.data, chainId: CHAIN_ID, nonce, gasLimit, gasPrice, type: 0 });
    return { raw, signature: ethers.keccak256(raw), nonce, gasCost: cost.toString(), chainId: CHAIN_ID };
  }
  async paymentStatus(hash) {
    try { const proof = await this.receiptProof(hash); await this.recordProof?.(hash.toLowerCase(), proof.block); return 'finalized'; }
    catch (error) { if (error instanceof DepositValidationError && error.message === 'Transaction failed') return 'failed';
      // Missing history and RPC failures propagate; absence is never replacement authority.
      const receipt = await this.rpc('eth_getTransactionReceipt', [hash]);
      if (receipt) throw error;
      await this.validate(); return 'unknown';
    }
  }
  async paymentExpired(signed) {
    // EVM transactions do not expire like Solana blockhashes. A consumed nonce
    // with no proof of our exact hash is REVIEW, never automatic replacement.
    return BigInt(await this.rpc('eth_getTransactionCount', [this.address, this.confirmationMode === 'l2' ? 'latest' : 'finalized'])) > BigInt(signed.nonce);
  }
  async broadcast(signed) {
    assertLiveFunds(this.env); await this.validate();
    const tx = ethers.Transaction.from(signed.raw);
    if (tx.hash !== signed.signature || tx.from?.toLowerCase() !== this.address || tx.chainId !== BigInt(CHAIN_ID) || tx.nonce !== signed.nonce) throw new Error('Saved payment signature mismatch');
    const hash = await this.rpc('eth_sendRawTransaction', [signed.raw]);
    if (hash.toLowerCase() !== signed.signature.toLowerCase()) throw new Error('Unexpected payment hash');
  }
  async assertHolderReserveCoverage(wallet, reserves) {
    await this.validate(); wallet = normalizeAddress(wallet);
    for (const r of reserves) if (await this.balance(r.mint, wallet) < BigInt(r.amount)) throw new Error('Holder wallet reserve shortfall');
  }
}
module.exports = { RobinhoodChain, normalizeAddress, holderWallet, CHAIN_ID, SID, DEAD, MAXIMUM, ERC20 };
