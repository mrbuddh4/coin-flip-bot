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
  async scan(address) {
    const { store, chain } = this.service;
    const cursor = await store.cursor(address);
    const firstTime = await store.firstGameTime(address);
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
    if (signatures.length) await store.setCursor(address, signatures[0].signature);
  }
}
module.exports = { DepositScanner };
