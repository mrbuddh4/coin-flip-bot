// A plain transfer can fund a game only when its finalized on-chain timestamp,
// exact asset and signing wallet identify one historical request.
// Include closed/funded requests: ignoring them would let a receipt be stolen
// by a newer overlapping game. Missing timestamps never authorize a match.
function noMemoCandidates(games, { sender, mint, amount, at, maximum = 18446744073709551615n }) {
  if (!Number.isSafeInteger(at) || at < 0 || !/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n || BigInt(amount) > BigInt(maximum)) return [];
  const result = [];
  for (const game of games) {
    if (game.token.address !== mint) continue;
    for (const role of ['creator', 'challenger']) {
      const p = game[role];
      const start = role === 'creator' ? game.createdAt : p?.joinedAt;
      const end = p?.depositExpiresAt ?? game.expiresAt;
      if (p?.wallet !== sender || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || at < start || at >= end) continue;
      result.push({ gameId: game.id, userId: p.userId });
    }
  }
  return result;
}
// Recovery never funds a wager. Once every nearby request has closed, a
// verified, unconsumed direct transfer can only go back to its signing wallet.
// Refunds use the ACTUAL positive amount, including under/overpayments. This
// relaxed amount lookup must never be used to credit or resize a wager.
// Include a bounded clock/window margin for wallet sends that land just outside
// the request. An open competing request blocks recovery, even if already funded.
function refundCandidates(games, { sender, mint, amount, at, maximum = 18446744073709551615n }) {
  if (!Number.isSafeInteger(at) || at < 0 || !/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n || BigInt(amount) > BigInt(maximum)) return [];
  const result = [];
  for (const game of games) {
    if (game.token.address !== mint) continue;
    for (const role of ['creator', 'challenger']) {
      const p = game[role];
      const start = role === 'creator' ? game.createdAt : p?.joinedAt;
      const end = p?.depositExpiresAt ?? game.expiresAt;
      if (p?.wallet !== sender || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || at < start - 60000 || at >= end + 15 * 60000) continue;
      result.push({ gameId: game.id, userId: p.userId, status: game.status, expiresAt: game.expiresAt });
    }
  }
  return result;
}
module.exports = { noMemoCandidates, refundCandidates };
