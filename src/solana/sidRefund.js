// One incident, two verified Solana mainnet receipts. No general withdrawal command.
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('./token');

const treasury = '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY';
const recipient = 'F1eVTsGDhcQBXaWPa4UMzDw9KdDRX9RkVsHq7VJcisP7';
const mint = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';
const deposits = [
  { signature: '3f7aQUAkjVDgvvnkNHkJ5wmBUErMRhFzxLJM4H2dCJZjWvZdBxjEjM9x2q7h8d9jJBj2SpKTSoT8o9q6GgAomXmr', amount: '10000000000', time: 1795138946 },
  { signature: '386kV8qnkkJdXZnzFy1xCcyYq5eAV3BhWc73e5GVPBstmmbuiZeaJFQQYwo44xCYWB9ohMqZ4kgUt9tsYtUoUJo1', amount: '25000000000', time: 1795139205 },
];
const paymentId = proof => 'refund:' + proof.signature;
const caseId = 'refund-case:sid-2026-11-20';
const commitLock = 'solana-refund-case:' + caseId;
class RefundBlocked extends Error {}

async function recorded(db) {
  const { rows } = await db.query(`SELECT d.signature AS deposit, d."gameId", d.amount::text AS credited,
    o.payment, o.status, o.signed->>'signature' AS signature, o."lastError"
    FROM "SolDeposits" d LEFT JOIN "SolOutbox" o ON o.id='refund:' || d.signature AND o."gameId"=d."gameId"
    WHERE d.signature=ANY($1::text[])`, [deposits.map(d => d.signature)]);
  if (!rows.length) return null;
  if (rows.length !== deposits.length || deposits.some(d => !rows.some(r =>
    r.deposit === d.signature && r.gameId === caseId && r.credited === d.amount &&
    r.payment?.id === paymentId(d) && r.payment.kind === 'refund' &&
    r.payment.mint === mint && r.payment.amount === d.amount &&
    r.payment.sourceWallet === treasury && r.payment.recipient === recipient))) {
    throw new RefundBlocked('At least one deposit is already in the ledger. No new refund was queued. Review its existing receipt first.');
  }
  return rows;
}

async function verify(chain) {
  await chain.validate();
  const { connection } = chain;
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(treasury), TOKEN_2022_PROGRAM_ID);
  const history = await connection.getSignaturesForAddress(ata, { limit: 100 }, 'finalized');
  // Require both deposits and complete history between the first one and now.
  // Fail closed if any other successful transaction touched this account in that
  // interval. This prevents refunding on top of an unrecorded manual return.
  if (history.length === 100 && !(history[99]?.blockTime < deposits[0].time)) throw new RefundBlocked('Treasury history is too long to verify safely. No refund queued.');
  const known = new Set(deposits.map(d => d.signature));
  if (history.some(r => !r.err && !known.has(r.signature) && (r.blockTime == null || r.blockTime >= deposits[0].time))) {
    throw new RefundBlocked('Another successful treasury SID transaction needs review before this refund can be queued.');
  }
  const balance = await connection.getTokenAccountBalance(ata, 'finalized');
  if (balance?.value?.amount !== '35000000000') throw new RefundBlocked('Treasury SID balance changed. Review before returning these deposits.');
  for (const d of deposits) {
    if (!history.some(r => r.signature === d.signature && !r.err)) throw new RefundBlocked('Treasury history is incomplete. No refund queued.');
    const transaction = await connection.getParsedTransaction(d.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (transaction?.blockTime !== d.time || String(await chain.verifyDeposit({ signature: d.signature, sender: recipient, mint, transaction, allowNoMemo: true })) !== d.amount) {
      throw new RefundBlocked('Finalized deposit proof did not match the expected transfer. No refund queued.');
    }
  }
}

async function recoverSidRefund(service, adminId, confirm = false) {
  const { chain, store } = service;
  if (chain.address !== treasury || chain.env.SOLANA_CLUSTER !== 'mainnet-beta') throw new RefundBlocked('This command is only for the original Solana mainnet treasury.');
  const existing = await recorded(store.pool);
  if (existing) return { rows: existing };
  await verify(chain);
  for (const d of deposits) {
    const input = { sender: recipient, mint, amount: d.amount, at: d.time * 1000 };
    if ((await store.noMemoCandidates(input)).length || (await store.refundCandidates(input)).length) {
      throw new RefundBlocked('A nearby SID payment request needs review. No unassigned refund was queued.');
    }
  }
  if (!confirm) return { preview: true };

  const db = await store.pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [commitLock]);
    const prior = await recorded(db);
    if (prior) { await db.query('COMMIT'); return { rows: prior }; }
    const anchor = { id: caseId, status: 'REFUND_ONLY', depositAddress: treasury, cluster: 'mainnet-beta',
      token: { address: mint, symbol: 'SID', decimals: 6 }, adminId: String(adminId) };
    // The existing ledger requires a game FK. This internal anchor has no
    // participants or interface, cannot settle, and is excluded from game history.
    await db.query('INSERT INTO "SolGames" (id,state) VALUES ($1,$2)', [caseId, JSON.stringify(anchor)]);
    for (const d of deposits) {
      // The signature PK is shared with the normal scanner: if a scan records
      // either deposit concurrently, this entire batch rolls back.
      const inserted = await db.query('INSERT INTO "SolDeposits" (signature,"gameId","userId",amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [d.signature, caseId, 'refund-case', d.amount]);
      if (inserted.rowCount !== 1) throw new RefundBlocked('The scanner recorded a receipt during recovery. No new refunds were queued.');
      const payment = { id: paymentId(d), gameId: caseId, mint, recipient, amount: d.amount, kind: 'refund', sourceWallet: treasury };
      await db.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3)', [payment.id, caseId, JSON.stringify(payment)]);
    }
    const rows = await recorded(db);
    await db.query('COMMIT');
    return { rows };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
module.exports = { recoverSidRefund, RefundBlocked, deposits, recipient };
