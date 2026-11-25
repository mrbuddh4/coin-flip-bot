const { fromUnits } = require('./amounts');
function retained(player) { return BigInt(player.funding?.amount ?? player.deposit?.amount ?? '0'); }
function remaining(game, player) { const value = BigInt(game.wager) - retained(player); return value > 0n ? value : 0n; }
function progress(game, player) {
  const format = value => `${fromUnits(value, game.token.decimals)} ${game.token.symbol}`;
  const deadline = new Date(player.depositExpiresAt ?? game.expiresAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  return `Received: ${format(retained(player))}\nRemaining: ${format(remaining(game, player))}\nPayment deadline: ${deadline}\nSend token units, not a dollar value. Excess is refunded automatically. If time runs out, the game is cancelled and all retained deposits are refunded.`;
}
module.exports = { retained, remaining, progress };
