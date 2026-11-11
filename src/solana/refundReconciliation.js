const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const spl = require('./token');

const SCHEMA = `CREATE TABLE IF NOT EXISTS "SolExternalRefunds" (
  signature text PRIMARY KEY,
  "depositSignature" text NOT NULL UNIQUE,
  "adminId" text NOT NULL,
  evidence jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);`;
class RefundReconciliationError extends Error {}
const reject = message => { throw new RefundReconciliationError(message); };
function signature(value) {
  try { if (typeof value === 'string' && bs58.decode(value).length === 64) return; } catch (_) {}
  reject('Use a complete transaction signature.');
}
const key = value => value?.toBase58?.() || value;

// This repair accepts one finalized, plain token return only. Swaps, CPI,
// arbitrary instructions, bot-memo transfers and balance heuristics are refused.
function verifyReturn(tx, proof, token) {
  if (!tx?.meta || tx.meta.err || !Number.isSafeInteger(tx.blockTime) || tx.blockTime < proof.depositTime ||
      !tx.transaction.signatures.includes(proof.returnSignature)) reject('The return has no matching successful finalized proof.');
  const message = tx.transaction.message;
  if (!message.accountKeys.some(k => key(k.pubkey) === proof.treasury && k.signer)) reject('The treasury did not sign the return.');
  if (tx.meta.innerInstructions?.some(i => i.instructions.length)) reject('Program-invoked returns require separate review.');
  const transfers = message.instructions.filter(i => key(i.programId) !== 'ComputeBudget111111111111111111111111111111');
  if (transfers.length !== 1) reject('Use a plain manual token return with no other instructions or memo.');
  const instruction = transfers[0], info = instruction.parsed?.info;
  if (instruction.parsed?.type !== 'transferChecked' || key(instruction.programId) !== token.program ||
      info.mint !== token.address || spl.directTransferAuthority(info) !== proof.treasury ||
      info.tokenAmount?.decimals !== token.decimals || !/^[1-9]\d*$/.test(info.tokenAmount?.amount || '')) reject('The return token, program, authority or amount does not match.');
  const program = new PublicKey(token.program), mint = new PublicKey(token.address);
  const source = spl.getAssociatedTokenAddressSync(mint, new PublicKey(proof.treasury), program).toBase58();
  const target = spl.getAssociatedTokenAddressSync(mint, new PublicKey(proof.recipient), program).toBase58();
  if (info.source !== source || info.destination !== target) reject('The return must go from the treasury to the original sender’s token account.');
  const amount = BigInt(info.tokenAmount.amount);
  for (const [address, owner, delta] of [[source, proof.treasury, -amount], [target, proof.recipient, amount]]) {
    const index = message.accountKeys.findIndex(k => key(k.pubkey) === address);
    const before = tx.meta.preTokenBalances?.find(b => b.accountIndex === index);
    const after = tx.meta.postTokenBalances?.find(b => b.accountIndex === index);
    if (index < 0 || !before || !after || before.owner !== owner || after.owner !== owner ||
        before.mint !== token.address || after.mint !== token.address ||
        BigInt(after.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount) !== delta) reject('The exact token movement is not verified.');
  }
  return amount;
}

async function context(client, depositSignature, lock = false) {
  const receipt = (await client.query(`SELECT d.*,g.state FROM "SolDeposits" d JOIN "SolGames" g ON g.id=d."gameId" WHERE d.signature=$1${lock ? ' FOR UPDATE OF d,g' : ''}`, [depositSignature])).rows[0];
  if (!receipt || receipt.state.status !== 'CANCELLED') reject('This repair requires a recorded deposit in a cancelled game.');
  const member = [receipt.state.creator, receipt.state.challenger].find(p => p?.userId === receipt.userId);
  if (!member) reject('The original deposit owner is not recorded.');
  const rows = (await client.query(`SELECT * FROM "SolOutbox" WHERE "gameId"=$1 AND id=ANY($2::text[]) ORDER BY CASE WHEN id LIKE 'refund-excess:%' THEN 0 ELSE 1 END,id${lock ? ' FOR UPDATE' : ''}`,
    [receipt.gameId, [`refund:${depositSignature}`, `refund-excess:${depositSignature}`]])).rows;
  if (!rows.length || rows.some(r => r.status !== 'PENDING' || r.signed || r.payment.kind !== 'refund' ||
      r.payment.recipient !== member.wallet || r.payment.sourceWallet !== receipt.state.depositAddress ||
      r.payment.mint !== rows[0].payment.mint || !/^[1-9]\d*$/.test(r.payment.amount))) reject('Refunds must be unsigned and pending for the original sender and same token. Signed or already paid refunds require separate review.');
  if (rows.reduce((sum, r) => sum + BigInt(r.payment.amount), 0n) !== BigInt(receipt.amount)) reject('The pending refund components do not equal the original deposit.');
  return { receipt, member, rows };
}

async function reconcileExternalRefund(service, { depositSignature, returnSignature, adminId, commit = false }) {
  signature(depositSignature); signature(returnSignature);
  if (depositSignature === returnSignature) reject('The deposit and return must be different transactions.');
  // The runtime owns a single DB instance lock. Share its worker exclusion so
  // a previously fetched unsigned payment cannot be signed while being repaired.
  if (service.workerRunning) reject('The payment worker is busy. Retry this command in a few seconds.');
  service.workerRunning = true;
  let client;
  try {
    const existing = (await service.store.pool.query('SELECT "depositSignature",evidence FROM "SolExternalRefunds" WHERE signature=$1 OR "depositSignature"=$2', [returnSignature, depositSignature])).rows;
    if (existing.length) {
      if (existing.length !== 1 || existing[0].depositSignature !== depositSignature || existing[0].evidence.returnSignature !== returnSignature) reject('This deposit or return was already reconciled with another proof.');
      return { ...existing[0].evidence, alreadyRecorded: true };
    }
    const original = await context(service.store.pool, depositSignature);
    const { receipt, member, rows } = original;
    const mint = rows[0].payment.mint;
    if (receipt.state.depositAddress !== service.chain.address || mint === 'NATIVE') reject('This repair supports token refunds from the current treasury only.');
    await service.chain.validate();
    const token = await service.chain.tokenInfo(mint);
    const depositTx = await service.chain.connection.getParsedTransaction(depositSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    const originalAmount = await service.chain.verifyDeposit({ signature: depositSignature, sender: member.wallet, mint, memo: member.memo, transaction: depositTx, allowNoMemo: true });
    if (!Number.isSafeInteger(depositTx?.blockTime) || originalAmount !== BigInt(receipt.amount)) reject('The original deposit proof does not match its receipt.');
    const proof = { depositSignature, returnSignature, treasury: service.chain.address, recipient: member.wallet, mint, depositTime: depositTx.blockTime };
    const returnTx = await service.chain.connection.getParsedTransaction(returnSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    const returned = verifyReturn(returnTx, proof, token);
    if (returned > originalAmount) reject('The return exceeds this deposit’s pending refunds.');
    const result = { ...proof, gameId: receipt.gameId, originalAmount: originalAmount.toString(), returnedAmount: returned.toString(), remainingAmount: (originalAmount - returned).toString(), token, returnTime: returnTx.blockTime };
    if (!commit) return result;
    client = await service.store.pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`external-refund:${returnSignature}`]);
    const current = await context(client, depositSignature, true);
    if (JSON.stringify(current.rows.map(r => r.payment)) !== JSON.stringify(rows.map(r => r.payment))) reject('The refund records changed. Preview again before confirming.');
    const used = await client.query('SELECT id FROM "SolOutbox" WHERE signed->>\'signature\'=$1', [returnSignature]);
    if (used.rowCount) reject('This signature already belongs to a recorded bot payment.');
    let unallocated = returned;
    const allocations = [];
    for (const row of current.rows) {
      const amount = BigInt(row.payment.amount), paid = unallocated < amount ? unallocated : amount;
      if (paid === 0n) continue;
      unallocated -= paid;
      const remaining = amount - paid;
      const payment = { ...row.payment, originalAmount: row.payment.amount, externalRefunds: [{ signature: returnSignature, amount: paid.toString() }], ...(remaining ? { amount: remaining.toString() } : {}) };
      const status = remaining ? 'PENDING' : 'CONFIRMED';
      const signed = remaining ? null : { signature: returnSignature, external: true };
      const update = await client.query('UPDATE "SolOutbox" SET payment=$2,status=$3,signed=$4,"lastError"=NULL WHERE id=$1 AND status=\'PENDING\' AND signed IS NULL', [row.id, JSON.stringify(payment), status, signed && JSON.stringify(signed)]);
      if (update.rowCount !== 1) reject('A refund changed while being reconciled. Nothing was applied.');
      allocations.push({ id: row.id, paid: paid.toString(), remaining: remaining.toString(), before: row.payment, after: payment });
    }
    if (unallocated !== 0n) reject('The return cannot be allocated exactly.');
    const evidence = { ...result, allocations, adminId: String(adminId), verifiedAt: new Date().toISOString() };
    await client.query('INSERT INTO "SolExternalRefunds" (signature,"depositSignature","adminId",evidence) VALUES ($1,$2,$3,$4)', [returnSignature, depositSignature, String(adminId), JSON.stringify(evidence)]);
    await client.query('COMMIT');
    return { ...evidence, recorded: true };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
    service.workerRunning = false;
  }
}
module.exports = { SCHEMA, verifyReturn, reconcileExternalRefund, RefundReconciliationError };
