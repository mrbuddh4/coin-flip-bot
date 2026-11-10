const { PublicKey, SystemProgram } = require('@solana/web3.js');
const { MEMO } = require('./chain');
const { DepositValidationError } = require('./errors');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('./token');
class DepositScanner {
  constructor(service) { this.service = service; this.running = false; this.offset = 0; }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
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
    let before;
    for (;;) {
      const page = await chain.connection.getSignaturesForAddress(new PublicKey(address), { limit: 100, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) }, 'finalized');
      signatures.push(...page.filter(p => !p.err && (p.blockTime == null || p.blockTime * 1000 >= firstTime - 60000)));
      if (!page.length || page.length < 100 || (!cursor && page.some(p => p.blockTime != null && p.blockTime * 1000 < firstTime - 60000))) break;
      before = page[page.length - 1].signature;
    }
    for (const entry of [...signatures].reverse()) {
      const transaction = await chain.connection.getParsedTransaction(entry.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (!transaction) throw new Error('Finalized transaction unavailable; retain cursor');
      if (transaction.meta?.err) continue;
      const instructions = transaction.transaction.message.instructions;
      const memos = instructions.filter(i => i.programId.equals(MEMO));
      if (memos.length === 0) {
        await this.plainTransfer(address, entry.signature, transaction);
        continue;
      }
      if (memos.length !== 1 || typeof memos[0].parsed !== 'string') continue;
      const match = /^coinflip:([0-9a-f-]{36}):(creator|challenger)$/.exec(memos[0].parsed);
      if (!match) continue;
      let game;
      try { game = await store.get(match[1]); } catch (error) { if (error.message === 'Unknown Solana game') continue; throw error; }
      const player = game[match[2]];
      if (!player || player.wallet !== address) continue;
      const transfers = instructions.filter(i => ['transfer', 'transferChecked'].includes(i.parsed?.type));
      const transfer = transfers[0];
      const info = transfer?.parsed?.info;
      const program = transfer?.programId?.toBase58();
      let mint;
      if (transfer?.programId.equals(SystemProgram.programId)) mint = 'NATIVE';
      else if ([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program)) mint = info?.mint;
      if (transfers.length !== 1 || !mint) {
        await store.reviewDeposit(entry.signature, game.id, 'Unsupported transfer layout; reconcile on chain.');
        continue;
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
    if (!replay && signatures.length) await store.setCursor(address, signatures[0].signature);
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
