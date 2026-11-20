const { PublicKey, SystemProgram } = require('@solana/web3.js');
const { MEMO } = require('./chain');
const { DepositValidationError } = require('./errors');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('./token');
function retryCode(error) {
  const message = String(error?.message || '');
  if (error?.code === -32015 || /transaction version .*not supported/i.test(message)) return 'RPC_UNSUPPORTED_VERSION';
  if (/429|too many requests|rate.?limit/i.test(message)) return 'RPC_RATE_LIMIT';
  if (/timeout|timed out|abort/i.test(message)) return 'RPC_TIMEOUT';
  if (/^[0-9A-Z]{5}$/.test(String(error?.code || ''))) return `DATABASE_${error.code}`;
  return 'LOOKUP_OR_LEDGER_FAILURE';
}
class DepositScanner {
  constructor(service) { this.service = service; this.running = false; this.offset = 0; this.activeOffset = 0; this.recoveryOffset = 0; this.replayed = new Map(); this.nextScanAt = 0; this.rateFailures = 0; }
  async tick() {
    if (this.running || Date.now() < this.nextScanAt) return;
    this.running = true;
    try {
      // Check current payment windows before old wallets and historical replay.
      // Replaying only their live window also recovers a cursor skipped earlier.
      const active = await this.service.store.activeDepositRequests?.() || [];
      for (let i = 0; i < Math.min(2, active.length); i++) {
        const request = active[this.activeOffset++ % active.length];
        try { await this.scan(request.address, { replayFrom: request.replayFrom }); }
        catch (_) { console.error('DEPOSIT_ACTIVE_RETRY: current payment window retained.'); }
        if (Date.now() < this.nextScanAt) return;
      }
      const activeAddresses = new Set(active.map(r => r.address));
      const addresses = (await this.service.store.watchedAddresses()).filter(a => !activeAddresses.has(a));
      // One historical wallet per tick avoids a burst against the RPC provider.
      if (addresses.length) {
        const address = addresses[this.offset++ % addresses.length];
        try { await this.scan(address); }
        catch (_) { console.error('DEPOSIT_SCAN_RETRY: finalized range retained for another scan.'); }
        if (Date.now() < this.nextScanAt) return;
      }
      const requests = (await this.service.store.depositRecoveryRequests?.() || [])
        .filter(r => !activeAddresses.has(r.address));
      // Recent closed requests still recover missed deposits/refunds, but never
      // replay the same wallet's entire day of history every five seconds.
      for (let i = 0; i < Math.min(2, requests.length); i++) {
        const request = requests[this.recoveryOffset++ % requests.length];
        const now = Date.now();
        if (now - (this.replayed.get(request.address) || 0) < 60000) continue;
        this.replayed.set(request.address, now);
        try { await this.scan(request.address, { replayFrom: request.replayFrom }); }
        catch (_) { console.error('DEPOSIT_RECOVERY_RETRY: historical receipt range retained.'); }
        if (Date.now() < this.nextScanAt) return;
      }
    } finally { this.running = false; }
  }
  async confirm(id, userId) {
    const game = await this.service.store.get(id);
    const player = this.service.member(game, userId);
    // Explicit confirmation replays the request window even when the routine
    // scanner previously skipped a memo-free transaction. Global receipt
    // uniqueness still prevents double credit and duplicate refunds.
    await this.scan(player.wallet, { replayFrom: game.createdAt });
  }
  async scan(address, options = {}) {
    if (Date.now() < this.nextScanAt) throw new Error('RPC scan cooldown active; receipt retained');
    try {
      await this.scanRange(address, options);
      this.rateFailures = 0;
    } catch (error) {
      if (retryCode(error) === 'RPC_RATE_LIMIT') {
        const delay = Math.min(60000, 5000 * 2 ** Math.min(this.rateFailures++, 4));
        this.nextScanAt = Math.max(this.nextScanAt, Date.now() + delay);
        console.error(`DEPOSIT_RPC_BACKOFF: ${delay}ms; no further history requests during cooldown.`);
      }
      throw error;
    }
  }
  async scanRange(address, { replayFrom } = {}) {
    const { store, chain } = this.service;
    const replay = Number.isSafeInteger(replayFrom);
    const cursor = replay ? null : await store.cursor(address);
    const firstTime = replay ? replayFrom : await store.firstGameTime(address);
    let before, failed, newest;
    for (;;) {
      let page;
      try {
        page = await chain.connection.getSignaturesForAddress(new PublicKey(address), { limit: 100, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) }, 'finalized');
      } catch (error) {
        console.error(`DEPOSIT_RANGE_RETRY: ${retryCode(error)}; cursor retained.`);
        throw error;
      }
      const signatures = page.filter(p => !p.err && (p.blockTime == null || p.blockTime * 1000 >= firstTime - 60000));
      newest ||= signatures[0]?.signature;
      // Process the newest page before asking for older history. A slow or
      // unavailable second page must not postpone the payment already fetched.
      for (const entry of signatures) {
        try {
          if (await store.hasDeposit?.(entry.signature)) continue;
          if (await store.scanReview?.(entry.signature)) continue;
          await this.process(address, entry);
        } catch (error) {
          if (retryCode(error) === 'RPC_RATE_LIMIT') {
            console.error(`DEPOSIT_RECEIPT_RETRY: RPC_RATE_LIMIT; signature=${entry.signature}; cursor retained.`);
            throw error; // Stop the burst immediately, not after every receipt.
          }
          if (retryCode(error) === 'RPC_UNSUPPORTED_VERSION' && store.reviewScan) {
            try {
              await store.reviewScan(entry.signature, address, 'Unsupported transaction version; client supports legacy/v0 only. No deposit credited.');
              console.error(`DEPOSIT_VERSION_REVIEW: signature=${entry.signature}; saved for review, other receipts continue.`);
            } catch (reviewError) {
              failed ||= reviewError;
              console.error(`DEPOSIT_REVIEW_SAVE_RETRY: ${retryCode(reviewError)}; cursor retained.`);
            }
            continue;
          }
          console.error(`DEPOSIT_RECEIPT_RETRY: ${retryCode(error)}; signature=${entry.signature}; cursor retained.`);
          failed ||= error;
        }
      }
      if (!page.length || page.length < 100 || (!cursor && page.some(p => p.blockTime != null && p.blockTime * 1000 < firstTime - 60000))) break;
      before = page[page.length - 1].signature;
    }
    if (failed) throw failed;
    if (!replay && newest) await store.setCursor(address, newest);
  }
  async process(address, entry) {
    const { store, chain } = this.service;
    const transaction = await chain.connection.getParsedTransaction(entry.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!transaction) throw new Error('Finalized transaction unavailable; retain cursor');
    if (transaction.meta?.err) return;
    const instructions = transaction.transaction.message.instructions;
    const memos = instructions.filter(i => i.programId.equals(MEMO));
    if (memos.length === 0) {
      await this.plainTransfer(address, entry.signature, transaction);
      return;
    }
    if (memos.length !== 1 || typeof memos[0].parsed !== 'string') return;
    const match = /^coinflip:([0-9a-f-]{36}):(creator|challenger)$/.exec(memos[0].parsed);
    if (!match) return;
    let game;
    try { game = await store.get(match[1]); } catch (error) { if (error.message === 'Unknown Solana game') return; throw error; }
    const player = game[match[2]];
    if (!player || player.wallet !== address) return;
    const transfers = instructions.filter(i => ['transfer', 'transferChecked'].includes(i.parsed?.type));
    const transfer = transfers[0];
    const info = transfer?.parsed?.info;
    const program = transfer?.programId?.toBase58();
    let mint;
    if (transfer?.programId.equals(SystemProgram.programId)) mint = 'NATIVE';
    else if ([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program)) mint = info?.mint;
    if (transfers.length !== 1 || !mint) {
      await store.reviewDeposit(entry.signature, game.id, 'Unsupported transfer layout; reconcile on chain.');
      return;
    }
    // Structural validation is repeated by verifyDeposit, including sender,
    // signature, program, recipient ATA, exact memo, owner and positive units.
    // Permanent rejected transfers are retained for review. RPC/DB failures
    // keep the cursor so the range is replayed rather than losing a receipt.
    try {
      await this.service.deposit({ id: game.id, userId: player.userId, signature: entry.signature, detectedMint: mint, transaction });
    } catch (error) {
      if (!(error instanceof DepositValidationError)) throw error;
      await store.reviewDeposit(entry.signature, game.id, error.message);
    }
  }
  async plainTransfer(address, signature, transaction) {
    const instructions = transaction.transaction.message.instructions;
    const transfers = instructions.filter(i => ['transfer', 'transferChecked'].includes(i.parsed?.type));
    if (transfers.length !== 1 || !Number.isSafeInteger(transaction.blockTime)) return;
    const transfer = transfers[0], info = transfer.parsed.info;
    const native = transfer.programId.equals(SystemProgram.programId);
    const mint = native ? 'NATIVE' : info.mint;
    const amount = native ? info.lamports : info.tokenAmount?.amount;
    if (!mint || (native ? !Number.isSafeInteger(amount) : !/^\d+$/.test(amount || ''))) return;
    if (native && info.source !== address) return;
    const { store } = this.service;
    const matches = await store.noMemoCandidates({ sender: address, mint, amount: String(amount), at: transaction.blockTime * 1000 });
    if (matches.length !== 1) {
      // Proof verification still checks recipient, program, signature, sender
      // and token ownership. No candidate selection can credit a wager here.
      if (this.service.recoverUnmatchedDeposit) {
        try {
          if (await this.service.recoverUnmatchedDeposit({ sender: address, signature, mint, amount: String(amount), transaction })) return;
        } catch (error) {
          if (!(error instanceof DepositValidationError)) throw error;
          if (matches.length) await store.reviewDeposit(signature, matches[0].gameId, error.message);
          return;
        }
      }
      if (matches.length) await store.reviewDeposit(signature, matches[0].gameId, 'Ambiguous plain transfer; no game was credited.');
      return;
    }
    try {
      await this.service.deposit({ id: matches[0].gameId, userId: matches[0].userId, signature, detectedMint: mint, transaction, noMemo: true });
    } catch (error) {
      if (!(error instanceof DepositValidationError)) throw error;
      await store.reviewDeposit(signature, matches[0].gameId, error.message);
    }
  }
}
module.exports = { DepositScanner };
