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
  constructor(service) { this.service = service; this.running = false; this.offset = 0; this.recoveryOffset = 0; this.replayed = new Map(); }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // A skipped receipt may already be behind the regular scan cursor. Replay
      // persisted recent request windows periodically, including expired games,
      // so repair/restart needs no second button tap. Bound work and rotate.
      const requests = await this.service.store.depositRecoveryRequests?.() || [];
      for (let i = 0; i < Math.min(2, requests.length); i++) {
        const request = requests[this.recoveryOffset++ % requests.length];
        const now = Date.now();
        if (now - (this.replayed.get(request.address) || 0) < 30000) continue;
        try {
          await this.scan(request.address, { replayFrom: request.replayFrom });
          this.replayed.set(request.address, now);
        } catch (_) { console.error('DEPOSIT_RECOVERY_RETRY: historical receipt range retained.'); }
      }
      const addresses = await this.service.store.watchedAddresses();
      // Round robin keeps one busy address from starving another. A cursor only
      // advances after its whole finalized range is processed successfully.
      for (let i = 0; i < Math.min(5, addresses.length); i++) {
        const address = addresses[this.offset++ % addresses.length];
        try { await this.scan(address); }
        catch (_) { console.error('DEPOSIT_SCAN_RETRY: finalized range retained for another scan.'); }
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
  async scan(address, { replayFrom } = {}) {
    const { store, chain } = this.service;
    const replay = Number.isSafeInteger(replayFrom);
    const cursor = replay ? null : await store.cursor(address);
    const firstTime = replay ? replayFrom : await store.firstGameTime(address);
    const signatures = [];
    let before, failed;
    for (;;) {
      let page;
      try {
        page = await chain.connection.getSignaturesForAddress(new PublicKey(address), { limit: 100, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) }, 'finalized');
      } catch (error) {
        console.error(`DEPOSIT_RANGE_RETRY: ${retryCode(error)}; cursor retained.`);
        failed = error;
        break;
      }
      signatures.push(...page.filter(p => !p.err && (p.blockTime == null || p.blockTime * 1000 >= firstTime - 60000)));
      if (!page.length || page.length < 100 || (!cursor && page.some(p => p.blockTime != null && p.blockTime * 1000 < firstTime - 60000))) break;
      before = page[page.length - 1].signature;
    }
    // Prioritize current payments and isolate each lookup. One unavailable old
    // transaction must not starve a newer valid deposit. Keep the old cursor if
    // any page or receipt failed, so isolation never discards unresolved proof.
    for (const entry of signatures) {
      try {
        // Unsupported versions remain in a durable review queue. The ordinary
        // cursor may pass them only after that record commits successfully.
        if (await store.scanReview?.(entry.signature)) continue;
        await this.process(address, entry);
      }
      catch (error) {
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
    if (failed) throw failed;
    if (!replay && signatures.length) await store.setCursor(address, signatures[0].signature);
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
