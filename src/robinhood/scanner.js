const { ethers } = require('ethers');
const { ERC20 } = require('./chain');
const { DepositValidationError } = require('../solana/errors');
const TRANSFER = ERC20.getEvent('Transfer').topicHash;
class RobinhoodScanner {
  constructor(service) { this.service = service; this.running = false; this.nextTry = 0; }
  async confirm() { return this.tick(); }
  async start() {
    const { store, chain } = this.service;
    if (await store.scanState()) return;
    // Persist before accepting any new game. Restart never skips old deposits.
    if ((await store.watchedAddresses()).length) throw new Error('Robinhood scanner baseline missing for existing games; reconcile history');
    const b = await chain.finalized();
    await store.saveScanState(BigInt(b.number), b.hash);
  }
  async tick() {
    if (this.running || Date.now() < this.nextTry) return;
    this.running = true;
    try {
      const { chain, store } = this.service;
      await chain.validate();
      await store.assertHealthy();
      await chain.checkHistory?.();
      const cursor = await store.scanState();
      if (!cursor) throw new Error('Robinhood scanner not initialized');
      const old = await chain.rpc('eth_getBlockByNumber', [ethers.toQuantity(BigInt(cursor.block)), false]);
      if (!old) throw new Error('Scanner history unavailable; cursor retained');
      if (old.hash !== cursor.hash) { await store.freeze('Scanner confirmation block changed'); throw new Error('Scanner cursor mismatch; reconcile history'); }
      const confirmedHead = await chain.finalized();
      const end = BigInt(confirmedHead.number), from = BigInt(cursor.block) + 1n;
      if (from > end) return;
      const watched = new Set(await store.watchedAddresses());
      // Empty ledger can advance without history reads; active games cannot.
      if (!watched.size) { await store.saveScanState(end, confirmedHead.hash); return; }
      const native = (await store.pool.query(`SELECT 1 FROM "SolGames" WHERE state->'token'->>'address'='NATIVE' LIMIT 1`)).rowCount > 0;
      const upper = from + (native ? 79n : 999n) < end ? from + (native ? 79n : 999n) : end;
      const logs = await chain.rpc('eth_getLogs', [{ fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(upper), topics: [TRANSFER, null, ethers.zeroPadValue(chain.address, 32)] }]);
      const byBlock = new Map();
      for (const log of logs) {
        if (log.removed || BigInt(log.blockNumber) < from || BigInt(log.blockNumber) > upper) throw new Error('Log range proof mismatch');
        const key = BigInt(log.blockNumber).toString();
        if (!byBlock.has(key)) byBlock.set(key, []);
        byBlock.get(key).push(log);
      }
      const deadline = Date.now() + 18000;
      for (let height = from; height <= upper; height++) {
        if (Date.now() >= deadline) break;
        let block;
        if (native || byBlock.has(height.toString()) || height === upper) block = await chain.rpc('eth_getBlockByNumber', [ethers.toQuantity(height), native]);
        if (block && BigInt(block.number) !== height) throw new Error('Block range mismatch');
        for (const log of byBlock.get(height.toString()) || []) {
          if (log.blockHash !== block?.hash) throw new Error('Log/block hash mismatch');
          let event; try { event = ERC20.parseLog(log); } catch (_) { continue; }
          const sender = event.args[0].toLowerCase();
          if (!watched.has(sender)) continue;
          await this.process(sender, log.transactionHash.toLowerCase(), log.address.toLowerCase(), event.args[2], block);
        }
        if (native) {
          if (!block || !Array.isArray(block.transactions)) throw new Error('Full native block unavailable');
          for (const tx of block.transactions) {
            if (typeof tx !== 'object') throw new Error('Native block omitted transaction bodies');
            if (tx.to?.toLowerCase() === chain.address && watched.has(tx.from?.toLowerCase()) && BigInt(tx.value) > 0n) await this.process(tx.from.toLowerCase(), tx.hash.toLowerCase(), 'NATIVE', BigInt(tx.value), block);
          }
        }
        // Persist only after EVERY relevant receipt in this range was handled.
        // Sparse ERC-20 ranges can skip empty blocks after the complete log query.
        if (block) await store.saveScanState(height, block.hash);
      }
      this.nextTry = 0;
    } catch (_) {
      this.nextTry = Date.now() + 15000;
      console.error('ROBINHOOD_SCAN_RETRY: finalized cursor retained; deposits not discarded.');
    } finally { this.running = false; }
  }
  async process(sender, signature, mint, amount, block) {
    const { service } = this, { store } = service;
    if (await store.hasDeposit(signature)) return;
    const transaction = { hash: signature, blockTime: Number(BigInt(block.timestamp)) };
    const input = { sender, mint, amount: amount.toString(), at: transaction.blockTime * 1000 };
    const candidates = await store.noMemoCandidates(input);
    try {
      if (candidates.length !== 1) {
        if (await service.recoverUnmatchedDeposit({ ...input, signature, transaction })) return;
        if (candidates.length) await store.reviewDeposit(signature, candidates[0].gameId, 'Ambiguous Robinhood transfer; no game credited');
        return;
      }
      await service.deposit({ id: candidates[0].gameId, userId: candidates[0].userId, signature, detectedMint: mint, transaction, noMemo: true });
    } catch (error) {
      if (!(error instanceof DepositValidationError)) throw error;
      if (candidates.length) await store.reviewDeposit(signature, candidates[0].gameId, error.message);
    }
  }
}
module.exports = { RobinhoodScanner };
