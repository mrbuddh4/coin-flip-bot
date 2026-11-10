// A plain transfer can fund a game only when its finalized on-chain timestamp,
// exact asset/amount and signing wallet identify one historical request.
// Include closed/funded requests: ignoring them would let a receipt be stolen
// by a newer overlapping game. Missing timestamps never authorize a match.
function noMemoCandidates(games, { sender, mint, amount, at }) {
  if (!Number.isSafeInteger(at) || at < 0) return [];
  const result = [];
  for (const game of games) {
    if (game.token.address !== mint || game.wager !== String(amount)) continue;
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
module.exports = { noMemoCandidates };
