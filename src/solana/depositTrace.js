const bs58 = require('bs58').default;
const { SystemProgram } = require('@solana/web3.js');
const { noMemoCandidates } = require('./depositMatch');
const time = value => Number.isSafeInteger(value) ? new Date(value).toISOString() : 'unknown';
// Read-only diagnostics. Never imports a receipt, changes a game or signs a
// payment, and never reveals another participant's wallet or user identity.
async function traceDeposit(service, userId, input) {
  const signature = String(input || '').trim().replace(/^https:\/\/(?:explorer\.solana\.com|solscan\.io)\/tx\//, '').split('?')[0];
  try { if (bs58.decode(signature).length !== 64) throw new Error(); }
  catch (_) { return 'Use /depositcheck followed by the public transaction signature or Solana Explorer/Solscan transaction link.'; }
  const transaction = await service.chain.connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!transaction?.meta) return 'The finalized transaction is unavailable from this RPC. No payment or game was changed.';
  if (transaction.meta.err) return 'This transaction failed on chain. No successful deposit was received.';
  const transfers = transaction.transaction.message.instructions.filter(i => ['transfer', 'transferChecked'].includes(i.parsed?.type));
  if (transfers.length !== 1) return 'This transfer layout needs review. Automatic matching requires one direct transfer. No game was changed.';
  const transfer = transfers[0], info = transfer.parsed.info;
  const native = transfer.programId.equals(SystemProgram.programId);
  const sender = native ? info.source : info.authority;
  const mint = native ? 'NATIVE' : info.mint;
  const amount = String(native ? info.lamports : info.tokenAmount?.amount);
  const at = Number.isSafeInteger(transaction.blockTime) ? transaction.blockTime * 1000 : NaN;
  const games = await service.store.history(userId);
  const related = games.filter(g => g.token.address === mint && g.wager === amount).slice(0, 3);
  const matches = Number.isSafeInteger(transaction.blockTime) ? await service.store.noMemoCandidates({ sender, mint, amount, at }) : [];
  const receipt = (await service.store.pool.query('SELECT "gameId","userId" FROM "SolDeposits" WHERE signature=$1', [signature])).rows[0];
  const lines = ['Deposit diagnostic (read only)', `Chain time: ${time(at)}`, `Exact plain-transfer matches: ${matches.length}`, `Receipt: ${receipt ? 'already recorded' : 'not recorded'}`];
  if (!related.length) lines.push('No saved game for your account has this exact asset and amount.');
  for (const g of related) {
    const p = service.member(g, userId), challenger = p.userId === g.challenger?.userId;
    const start = challenger ? p.joinedAt : g.createdAt, end = p.depositExpiresAt ?? g.expiresAt;
    let proof = 'not checked: sending wallet differs';
    if (p.wallet === sender) {
      try { await service.chain.verifyDeposit({ signature, sender, mint, memo: p.memo, transaction, allowNoMemo: true }); proof = 'valid direct deposit'; }
      catch (error) {
        const { DepositValidationError } = require('./errors');
        proof = error instanceof DepositValidationError ? error.message : 'RPC verification unavailable';
      }
    }
    lines.push('', `Game ${g.id}: ${g.status} (${challenger ? 'challenger' : 'creator'})`,
      `Sending wallet matches: ${p.wallet === sender ? 'yes' : 'NO'}`,
      `Payment window: ${time(start)} to ${time(end)}`,
      `Inside window: ${noMemoCandidates([g], { sender, mint, amount, at }).length ? 'yes' : 'NO'}`,
      `Check requested: ${g.ui?.depositChecks?.[String(userId)] ? 'yes' : 'no'}`, `Proof: ${proof}`);
    const refunds = (await service.store.payments(g.id)).filter(r => r.id === `refund:${signature}`);
    for (const r of refunds) lines.push(`This refund: ${r.status}${r.signature ? '\n' + r.signature : ''}`);
  }
  return lines.join('\n');
}
module.exports = { traceDeposit };
