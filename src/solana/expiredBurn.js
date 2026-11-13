const { createHash } = require('node:crypto');
const { Transaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const spl = require('./token');
const { MEMO } = require('./chain');
const { paymentFailure } = require('./errors');
const { assertLiveFunds } = require('../utils/recoveryMode');

const SCHEMA = `CREATE TABLE IF NOT EXISTS "SolExpiredBurnRepairs" (
  id text PRIMARY KEY, "adminId" text NOT NULL, original jsonb NOT NULL,
  evidence jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);`;
class BurnRecoveryError extends Error {}
const reject = message => { throw new BurnRecoveryError(message); };
// Bound read-only dependencies even when an RPC/transport never settles.
async function boundedRead(operation, milliseconds = 30000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, fail) => {
      timer = setTimeout(() => fail(new BurnRecoveryError('Historical verification timed out waiting for a response. No replacement was queued.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = row => digest({ payment: row.payment, signed: row.signed, status: row.status, lastError: row.lastError });

// Only the exact, single-signer SPL burn built by this application is eligible.
// No payout, transfer, native SOL, changed wallet or partially decoded bytes.
function decodeBurn(row, game, address) {
  if (row.status !== 'REVIEW' || !row.lastError?.startsWith('Blockhash expired without finalized proof;') ||
      row.id !== `burn:${game.id}` || game.status !== 'SETTLED' ||
      row.payment.id !== row.id || row.payment.gameId !== game.id || row.gameId !== game.id ||
      row.payment.kind !== 'burn' || row.payment.sourceWallet !== address || game.depositAddress !== address ||
      row.payment.recipient || row.payment.mint === 'NATIVE' || row.payment.mint !== game.token.address ||
      row.payment.amount !== game.fees?.burn || !/^[1-9]\d*$/.test(row.payment.amount) ||
      !Number.isSafeInteger(row.signed?.lastValidBlockHeight) || row.signed.lastValidBlockHeight < 151) reject('This is not an eligible expired token burn.');
  let tx;
  try { tx = Transaction.from(Buffer.from(row.signed.raw, 'base64')); }
  catch (_) { reject('The original signed transaction cannot be decoded.'); }
  if (tx.signatures.length !== 1 || !tx.verifySignatures() || tx.feePayer?.toBase58() !== address ||
      bs58.encode(tx.signature) !== row.signed.signature || tx.instructions.length !== 2) reject('The original burn signature or instruction set does not match.');
  const [burn, memo] = tx.instructions;
  const program = new PublicKey(game.token.program);
  const source = spl.getAssociatedTokenAddressSync(new PublicKey(game.token.address), new PublicKey(address), program);
  const expected = spl.createBurnCheckedInstruction(source, new PublicKey(game.token.address), new PublicKey(address), BigInt(row.payment.amount), game.token.decimals, program);
  if (![spl.TOKEN_PROGRAM_ID.toBase58(), spl.TOKEN_2022_PROGRAM_ID.toBase58()].includes(program.toBase58()) ||
      !burn.programId.equals(expected.programId) || !burn.data.equals(expected.data) || burn.keys.length !== 3 ||
      burn.keys.some((k, i) => !k.pubkey.equals(expected.keys[i].pubkey)) ||
      !memo.programId.equals(MEMO) || memo.keys.length || memo.data.toString() !== `coinflip:payout:${row.id}`) reject('The signed bytes do not contain the exact recorded burn.');
  return { blockhash: tx.recentBlockhash, signature: row.signed.signature, lastValid: row.signed.lastValidBlockHeight };
}

// Negative signature lookups alone are NOT a non-execution proof. Read every
// finalized block in the signed blockhash's complete 151-block validity window.
// Header continuity and the original blockhash bind that window to the bytes.
// An unavailable/pruned/skipped response, RPC error or missing signature list
// leaves the obligation and original signed transaction completely unchanged.
async function proveExpiredBurn(connection, signed, anchorSignature, progress = async () => {}) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let checked = 0;
  await progress(0, 151, 'Locating the original finalized validity window.');
  const request = async (method, ...args) => {
    for (let attempt = 0; ; attempt++) {
      if (Date.now() > deadline) reject('Historical verification timed out. No payment records changed.');
      try { return await boundedRead(() => connection[method](...args), Math.min(30000, Math.max(1, deadline - Date.now()))); }
      catch (error) {
        if (attempt >= 4 || !/429|too many requests/i.test(String(error?.message))) throw error;
        await progress(checked, 151, `Historical RPC rate limited; retrying in ${5 * 2 ** attempt} seconds.`);
        await new Promise(resolve => setTimeout(resolve, Math.min(5000 * 2 ** attempt, Math.max(1, deadline - Date.now()))));
      }
    }
  };
  const endHeight = signed.lastValid, startHeight = endHeight - 150;
  const finalizedHeight = await request('getBlockHeight', 'finalized');
  if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight <= endHeight ||
      (await request('isBlockhashValid', signed.blockhash, { commitment: 'finalized' })).value !== false) reject('The original blockhash is not proven expired at finality.');
  const anchor = await request('getParsedTransaction', anchorSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!anchor || anchor.meta?.err !== null || !Number.isSafeInteger(anchor.slot) || !anchor.transaction.signatures.includes(anchorSignature)) reject('A confirmed payment from this same game is needed as a historical anchor.');
  const slots = await request('getBlocks', Math.max(0, anchor.slot - 2048), anchor.slot + 2048, 'finalized');
  if (!Array.isArray(slots) || !slots.length || slots.some((s, i) => !Number.isSafeInteger(s) || (i && s <= slots[i - 1]))) reject('Historical block coverage is incomplete.');
  const headers = new Map();
  const header = async slot => {
    if (!headers.has(slot)) headers.set(slot, await request('getBlock', slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false }));
    const block = headers.get(slot);
    if (!block || !Number.isSafeInteger(block.blockHeight)) reject('Historical block headers are unavailable.');
    return block;
  };
  const find = async height => {
    let low = 0, high = slots.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), block = await header(slots[middle]);
      if (block.blockHeight === height) return middle;
      if (block.blockHeight < height) low = middle + 1; else high = middle - 1;
    }
    reject('The complete validity window is outside available historical blocks.');
  };
  const first = await find(startHeight), last = await find(endHeight);
  if (last - first !== 150) reject('The historical validity window has missing blocks.');
  const blocks = [];
  for (let index = first; index <= last; index++) {
    const slot = slots[index];
    const b = await request('getBlockSignatures', slot, 'finalized');
    const previous = blocks.at(-1);
    if (!b || (b.blockHeight != null && b.blockHeight !== startHeight + index - first) || !Array.isArray(b.signatures) ||
        typeof b.blockhash !== 'string' || (index === first && b.blockhash !== signed.blockhash) ||
        (index === last && b.blockhash !== (await header(slot)).blockhash) ||
        (previous && (b.parentSlot !== previous.slot || b.previousBlockhash !== previous.blockhash))) reject('The finalized block chain or signature lists are incomplete.');
    if (b.signatures.includes(signed.signature)) reject('The original transaction appears in finalized history. No replacement is allowed; inspect its original receipt.');
    blocks.push({ slot, height: startHeight + index - first, blockhash: b.blockhash, parentSlot: b.parentSlot, previousBlockhash: b.previousBlockhash, signaturesHash: digest(b.signatures), signatureCount: b.signatures.length });
    checked = blocks.length;
    if (checked % 5 === 0 || checked === 151) await progress(checked, 151);
  }
  const status = (await request('getSignatureStatuses', [signed.signature], { searchTransactionHistory: true })).value?.[0];
  const transaction = await request('getParsedTransaction', signed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (status !== null || transaction !== null) reject('The original transaction has a receipt or an inconclusive lookup. No replacement is allowed.');
  return { method: 'complete-finalized-validity-window-v1', originalSignature: signed.signature, originalBlockhash: signed.blockhash, firstHeight: startHeight, lastHeight: endHeight, finalizedHeight, anchorSignature, blocks, checkedAt: new Date().toISOString() };
}

const RECOVERY_STAGES = ['prepare', 'read-audit', 'read-payment', 'read-game', 'decode-original', 'network', 'read-anchor', 'history-proof', 'funds-gate', 'worker-exclusion', 'reserve-check', 'database-connect', 'database-begin', 'database-lock', 'audit-write', 'queue-reset', 'database-commit'];
function burnRecoveryFailure(error) {
  const stage = RECOVERY_STAGES.includes(error?.burnRecoveryStage) ? error.burnRecoveryStage : 'prepare';
  const classified = paymentFailure(error);
  const reasons = {
    RPC_RATE_LIMIT: 'The RPC provider throttled this check. Retry after the limit clears.',
    RPC_TIMEOUT: 'A response timed out before this check could finish.',
    PAYMENT_CHECK_FAILED: 'This check failed without an allowlisted cause. Inspect private hosting diagnostics.',
  };
  return { stage, code: classified.code, reason: reasons[classified.code] || classified.reason,
    outcomeUnknown: stage === 'database-commit' || error?.burnRollbackUnverified === true };
}
async function recoverExpiredBurn(service, { gameId, adminId, commit = false, progress }) {
  let stage = 'prepare';
  try {
    if (!(service.chain.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).includes(String(adminId))) reject('Private administrator command.');
    if (typeof gameId !== 'string' || !/^[0-9a-f-]{36}$/.test(gameId)) reject('Use the complete game ID.');
    const id = `burn:${gameId}`, pool = service.store.pool;
    await boundedRead(() => pool.query(SCHEMA));
    stage = 'read-audit';
    const old = (await boundedRead(() => pool.query('SELECT * FROM "SolExpiredBurnRepairs" WHERE id=$1', [id]))).rows[0];
    if (old) return { alreadyRecorded: true, id, amount: old.original.payment.amount };
    stage = 'read-payment';
    const row = (await boundedRead(() => pool.query('SELECT * FROM "SolOutbox" WHERE id=$1', [id]))).rows[0];
    stage = 'read-game';
    const game = await boundedRead(() => service.store.get(gameId));
    if (!row || game.cluster !== service.chain.env.SOLANA_CLUSTER) reject('The recorded burn or network does not match.');
    stage = 'decode-original';
    const signed = decodeBurn(row, game, service.chain.address);
    stage = 'network';
    await boundedRead(() => service.chain.validate());
    const print = fingerprint(row);
    let proof = service.expiredBurnProof;
    if (!proof || proof.id !== id || proof.fingerprint !== print) {
      stage = 'read-anchor';
      const anchors = (await boundedRead(() => pool.query('SELECT signed->>\'signature\' AS signature FROM "SolOutbox" WHERE "gameId"=$1 AND status=\'CONFIRMED\' AND signed IS NOT NULL ORDER BY "createdAt" LIMIT 1', [gameId]))).rows;
      if (!anchors[0]?.signature) reject('No confirmed same-game payment is available to anchor this repair.');
      stage = 'history-proof';
      const evidence = await proveExpiredBurn(service.chain.connection, signed, anchors[0].signature, progress);
      proof = { id, fingerprint: print, evidence };
      service.expiredBurnProof = proof;
    }
    if (!commit) return { id, amount: row.payment.amount, token: game.token, originalSignature: signed.signature, preview: true, evidence: proof.evidence };
    stage = 'funds-gate';
    assertLiveFunds(service.chain.env);
    stage = 'worker-exclusion';
    if (service.workerRunning) reject('The payment worker is busy. No records changed; retry confirmation in a few seconds.');
    service.workerRunning = true;
    let client;
    try {
      // Expiry and finality are irreversible, but recheck network and reserve
      // coverage immediately before the narrowly scoped queue mutation.
      stage = 'network';
      await boundedRead(() => service.chain.validate());
      stage = 'reserve-check';
      if (progress) await progress(151, 151, 'History verified; checking treasury coverage before queuing.');
      await boundedRead(async () => service.chain.assertSolvent(await service.store.liabilities()));
      stage = 'database-connect';
      client = await pool.connect();
      stage = 'database-begin';
      await client.query('BEGIN');
      stage = 'database-lock';
      const current = (await client.query('SELECT * FROM "SolOutbox" WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current || fingerprint(current) !== print) reject('The original payment changed during verification. No repair was applied.');
      stage = 'audit-write';
      await client.query('INSERT INTO "SolExpiredBurnRepairs" (id,"adminId",original,evidence) VALUES ($1,$2,$3,$4)', [id, String(adminId), JSON.stringify(row), JSON.stringify(proof.evidence)]);
      stage = 'queue-reset';
      await client.query('UPDATE "SolOutbox" SET status=\'PENDING\',signed=NULL,"lastError"=NULL WHERE id=$1', [id]);
      stage = 'database-commit';
      await client.query('COMMIT');
      service.expiredBurnProof = null;
      return { id, amount: row.payment.amount, recorded: true, originalSignature: signed.signature };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); }
        catch (_) { error.burnRollbackUnverified = true; }
      }
      throw error;
    } finally {
      if (client) client.release();
      service.workerRunning = false;
    }
  } catch (error) {
    error.burnRecoveryStage = stage;
    throw error;
  }
}
module.exports = { recoverExpiredBurn, proveExpiredBurn, decodeBurn, BurnRecoveryError, boundedRead, burnRecoveryFailure };
