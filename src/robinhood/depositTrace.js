const { ethers } = require('ethers');
const HASH = /^0x[0-9a-f]{64}$/i;
function transactionHash(value) {
  const hash = String(value || '').trim().replace(/^https:\/\/robinhoodchain\.blockscout\.com\/tx\//i, '').split(/[?#]/)[0];
  if (!HASH.test(hash)) throw new Error('Invalid Robinhood transaction hash');
  return hash.toLowerCase();
}
async function readDeposit(service, value) {
  const signature = transactionHash(value), { chain } = service;
  const proof = await chain.receiptProof(signature);
  const sender = chain.normalizeAddress(proof.tx.from);
  const mint = proof.tx.to?.toLowerCase() === chain.address ? 'NATIVE' : chain.normalizeAddress(proof.tx.to);
  const transaction = { hash: signature, blockTime: proof.blockTime };
  // A diagnostic must not persist canonical proofs or consume any receipt.
  const amount = await chain.verifyDeposit({ signature, sender, mint, transaction, recordProof: false });
  return { signature, sender, mint, amount: amount.toString(), at: proof.blockTime * 1000, transaction, block: proof.block };
}
const time = value => Number.isSafeInteger(value) ? new Date(value).toISOString() : 'unknown';
async function traceRobinhoodDeposit(service, value) {
  const d = await readDeposit(service, value), { store } = service;
  const receipt = (await store.pool.query('SELECT "gameId" FROM "SolDeposits" WHERE signature=$1', [d.signature])).rows[0];
  const matches = await store.noMemoCandidates(d), recovery = await store.refundCandidates(d);
  const nearby = new Set([...matches, ...recovery].map(c => c.gameId));
  const { rows } = await store.pool.query(`SELECT state FROM "SolGames" WHERE state->'token'->>'address'=$1 AND
    (state->'creator'->>'wallet'=$2 OR state->'challenger'->>'wallet'=$2 OR state->>'wager'=$3)
    ORDER BY (state->'creator'->>'wallet'=$2 OR state->'challenger'->>'wallet'=$2) DESC NULLS LAST, "createdAt" DESC LIMIT 10`, [d.mint, d.sender, d.amount]);
  const games = rows.map(r => r.state).sort((a, b) => Number(nearby.has(b.id)) - Number(nearby.has(a.id)) || b.createdAt - a.createdAt).slice(0, 3);
  const cursor = await store.scanState();
  const lines = ['Robinhood deposit diagnostic (read only)', `Chain time: ${time(d.at)}`, `Sender: ${d.sender}`, `Asset: ${d.mint}`,
    `Received (atomic): ${d.amount}`, 'Proof: valid direct deposit', `Receipt: ${receipt ? 'recorded in ' + receipt.gameId : 'NOT RECORDED'}`,
    `In-window matches: ${matches.length}`, `Nearby refund requests: ${recovery.length}`,
    `Scan cursor: ${cursor?.block ?? 'missing'}; deposit block: ${BigInt(d.block.number)}`];
  if (service.depositScanStatus?.code) lines.push(`Scanner last failure: ${service.depositScanStatus.code} at ${service.depositScanStatus.stage}`);
  if (!games.length) lines.push('No saved request matches this sender or amount for this asset.');
  for (const g of games) {
    lines.push('', `Game ${g.id}: ${g.status}`);
    for (const [role, p] of [['creator', g.creator], ['challenger', g.challenger]]) {
      if (!p) continue;
      const start = role === 'creator' ? g.createdAt : p.joinedAt, end = p.depositExpiresAt ?? g.expiresAt;
      lines.push(`${role}: sender ${p.wallet === d.sender ? 'MATCHES' : 'DIFFERS'}`, `Registered sending wallet: ${p.wallet}`,
        `Window: ${time(start)} to ${time(end)}`, `Inside window: ${d.at >= start && d.at < end ? 'yes' : 'NO'}`,
        `Wager: ${ethers.formatUnits(g.wager, g.token.decimals)} ${g.token.symbol}`, `Received: ${ethers.formatUnits(d.amount, g.token.decimals)} ${g.token.symbol}`);
      if (Number.isSafeInteger(p.depositWindowClosedAt)) lines.push(`Funded-request cutoff: ${time(Math.min(end, p.depositWindowClosedAt))}`);
    }
    for (const p of (await store.payments(g.id)).filter(p => p.id === `refund:${d.signature}` || p.id === `refund-excess:${d.signature}`)) {
      lines.push(`Refund: ${p.status}${p.signature ? '\n' + service.chain.explorer(p.signature) : ''}`);
      if (p.lastError) lines.push('Saved refund diagnostic: ' + String(p.lastError).slice(0, 200));
    }
  }
  lines.push('', 'No records changed and no transaction sent.');
  return lines.join('\n');
}
async function recoverRobinhoodDeposit(service, value) {
  const d = await readDeposit(service, value), { store } = service;
  const receipt = (await store.pool.query('SELECT "gameId" FROM "SolDeposits" WHERE signature=$1', [d.signature])).rows[0];
  if (receipt) return `Deposit already recorded in game ${receipt.gameId}. No second refund was queued. Use /rhstatus ${receipt.gameId}.`;
  const candidates = await store.refundCandidates(d);
  if (!candidates.length) return 'No nearby saved request matches the actual sender and asset. No refund was queued; review the deposit diagnostic.';
  if (candidates.some(c => c.status === 'OPEN' && service.now() < c.expiresAt)) return 'A matching request remains open. No refund was queued; finish or cancel that request first.';
  // Shared recovery re-verifies the canonical receipt and locks/rechecks the
  // historical requests before uniquely consuming this signature. The normal
  // outbox worker alone signs and sends; repeat commands cannot pay twice.
  const recovered = await service.recoverUnmatchedDeposit(d);
  if (!recovered) return 'Request matching changed. No refund was queued; run the read-only diagnostic again.';
  const saved = (await store.pool.query('SELECT "gameId" FROM "SolDeposits" WHERE signature=$1', [d.signature])).rows[0];
  if (!saved) return 'Request matching changed before recording. No refund was queued; run the diagnostic again.';
  return `Deposit recorded for full refund to its verified sending wallet. Normal payment checks still apply.\nUse /rhstatus ${saved.gameId} to verify the refund transaction.`;
}
module.exports = { transactionHash, readDeposit, traceRobinhoodDeposit, recoverRobinhoodDeposit };
