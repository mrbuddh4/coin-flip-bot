// A one-time, owner-authorized return. The digest selects exactly one public
// receipt, without adding a Telegram identity or a configurable withdrawal.
const { createHash } = require('node:crypto');
const { PublicKey } = require('@solana/web3.js');
const { SID_MINT } = require('./featured');
const { directTransferAuthority, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = require('./token');

const treasury = '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY';
const digest = 'cb12b102dd423bc24a5fdbcf178032e17b459c5e4e53d01959cdbd734d325835';
const slot = 472723306, blockTime = 1795389732, amount = '6900000000';
const caseId = 'refund-case:wrong-chain-sid-2026-11-22';
const account = getAssociatedTokenAddressSync(new PublicKey(SID_MINT), new PublicKey(treasury), TOKEN_2022_PROGRAM_ID);
const digestOf = signature => createHash('sha256').update(signature).digest('hex');

class RefundNeedsReview extends Error {}

async function prior(db) {
  const { rows } = await db.query(`SELECT o.status,o.payment FROM "SolOutbox" o
    JOIN "SolDeposits" d ON d."gameId"=o."gameId" AND o.id='refund:' || d.signature
    WHERE o."gameId"=$1 AND d.amount=$2`, [caseId, amount]);
  if (rows.length === 1 && rows[0].payment.amount === amount && rows[0].payment.mint === SID_MINT &&
      rows[0].payment.sourceWallet === treasury && rows[0].payment.kind === 'refund' &&
      digestOf(rows[0].payment.id.slice('refund:'.length)) === digest) return rows[0].status;
  if (rows.length) throw new RefundNeedsReview('case-ledger-mismatch');
  return null;
}

async function exactHistory(connection, commitment) {
  const rows = await connection.getSignaturesForAddress(account, { limit: 100 }, commitment);
  const hit = rows.find(r => r.slot === slot && !r.err && digestOf(r.signature) === digest);
  if (!hit) throw new Error('original receipt not available from RPC');
  if (rows.some(r => r.slot >= slot && r.signature !== hit.signature && !r.err)) throw new RefundNeedsReview('newer-successful-token-account-activity');
  return hit.signature;
}

async function verify(chain) {
  await chain.validate();
  const { connection } = chain;
  const signature = await exactHistory(connection, 'finalized');
  const transaction = await connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!transaction) throw new Error('finalized transaction unavailable');
  const transfer = transaction.transaction.message.instructions.find(i => i.parsed?.type === 'transferChecked');
  const sender = directTransferAuthority(transfer?.parsed?.info || {});
  if (!sender || sender === treasury || transaction.slot !== slot || transaction.blockTime !== blockTime ||
      String(await chain.verifyDeposit({ signature, sender, mint: SID_MINT, transaction, allowNoMemo: true })) !== amount) {
    throw new RefundNeedsReview('deposit-proof-mismatch');
  }
  // Confirmed history can already show a manual return which has not
  // finalized. Any successful later activity forces manual reconciliation.
  if (await exactHistory(connection, 'confirmed') !== signature ||
      (await connection.getTokenAccountBalance(account, 'confirmed')).value?.amount !== amount ||
      await exactHistory(connection, 'confirmed') !== signature) throw new RefundNeedsReview('token-balance-or-history-changed');
  return { sender, signature };
}

async function recoverWrongChainSid({ store, chain }) {
  if (chain.address !== treasury || chain.env?.SOLANA_CLUSTER !== 'mainnet-beta') return 'WRONG_TREASURY';
  const known = await prior(store.pool);
  if (known) return known;
  const { sender, signature } = await verify(chain);
  const input = { sender, mint: SID_MINT, amount, at: blockTime * 1000 };
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [caseId]);
    const existing = await prior(client);
    if (existing) { await client.query('COMMIT'); return existing; }
    if ((await store.refundCandidates(input, client)).length ||
        (await store.liabilities(client)).some(p => p.mint === SID_MINT && BigInt(p.amount) > 0n)) throw new RefundNeedsReview('conflicting-sid-request-or-liability');
    const anchor = { id: caseId, status: 'REFUND_ONLY', depositAddress: treasury, cluster: 'mainnet-beta',
      token: { address: SID_MINT, symbol: 'SID', decimals: 6 } };
    await client.query('INSERT INTO "SolGames" (id,state) VALUES ($1,$2)', [caseId, JSON.stringify(anchor)]);
    const receipt = await client.query(`INSERT INTO "SolDeposits" (signature,"gameId","userId",amount)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING signature`, [signature, caseId, 'refund-case', amount]);
    if (receipt.rowCount !== 1) throw new RefundNeedsReview('deposit-already-recorded');
    const payment = { id: 'refund:' + signature, gameId: caseId, kind: 'refund', mint: SID_MINT,
      recipient: sender, sourceWallet: treasury, amount };
    await client.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3)', [payment.id, caseId, JSON.stringify(payment)]);
    await client.query('COMMIT');
    return 'PENDING';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function recoveryTick(service, now = Date.now) {
  let next = 0, done = false;
  return async () => {
    if (done || now() < next) return;
    next = Infinity;
    try {
      const status = await recoverWrongChainSid(service);
      done = true;
      if (status !== 'WRONG_TREASURY') console.log('SID_ONE_TIME_RETURN: ' + status);
    } catch (error) {
      done = error instanceof RefundNeedsReview;
      next = now() + 60000;
      console.error('SID_ONE_TIME_RETURN: ' + (done ? 'REVIEW_REQUIRED (' + error.message + ')' : 'RETRY'));
    }
  };
}
module.exports = { recoverWrongChainSid, recoveryTick, RefundNeedsReview };
