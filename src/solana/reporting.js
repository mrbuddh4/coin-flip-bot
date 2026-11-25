// Read-only, chain-qualified reporting across the enabled live ledgers.
const { resultVisible } = require('./presentation');
const { valueAssets } = require('./prices');
const live = ui => Boolean(ui.service.chain.realFunds || ui.service.chain.env?.SOLANA_CLUSTER === 'mainnet-beta');
async function playerReport(ui, userId) {
  const mainnet = live(ui);
  // Test coins must never enter live counts, valuations or rankings.
  const sources = (ui.reportingSources || [ui]).filter(source => live(source) === mainnet);
  const ranks = new Map(), quotes = new Map();
  for (const source of sources) {
    const key = source.service.chain.key || 'solana';
    const label = key === 'robinhood' ? 'Robinhood' : 'Solana';
    const results = (await source.store.allResults()).filter(g => g.status === 'SETTLED' && resultVisible(g) &&
      (!userId || [g.creator.userId, g.challenger?.userId].some(id => String(id) === userId)));
    const paid = await source.store.confirmedPrizeGameIds();
    const mints = new Set();
    for (const game of results) for (const player of [game.creator, game.challenger]) {
      const id = String(player.userId);
      if (userId && id !== userId) continue;
      const r = ranks.get(id) || { ...player, userId: id, wins: 0, losses: 0, net: new Map(), assets: new Map(), pending: false };
      const assetKey = `${key}:${game.token.address}`;
      const asset = r.net.get(assetKey) || { amount: 0n, decimals: game.token.decimals };
      const totals = r.assets.get(assetKey) || { token: game.token, label, wagered: 0n, allocated: 0n };
      asset.amount -= BigInt(game.wager);
      totals.wagered += BigInt(game.wager);
      if (String(game.winnerId) === id) {
        r.wins++;
        totals.allocated += BigInt(game.prize);
        // Paid IDs are looked up within this ledger, even if IDs collide.
        if (paid.has(game.id)) asset.amount += BigInt(game.prize);
        else r.pending = true;
      } else r.losses++;
      r.net.set(assetKey, asset); r.assets.set(assetKey, totals); ranks.set(id, r);
    }
    for (const r of ranks.values()) for (const [assetKey, asset] of r.net) {
      if (assetKey.startsWith(key + ':') && asset.amount !== 0n) mints.add(assetKey.slice(key.length + 1));
    }
    // Fetch using original chain addresses, then namespace quotes like balances.
    // Missing prices remain unpriced, never silently valued at zero.
    if (mainnet && mints.size) {
      const prices = await source.prices.get([...mints]);
      for (const [mint, quote] of prices) quotes.set(`${key}:${mint}`, quote);
    }
  }
  const users = [...ranks.values()];
  for (const r of users) r.value = valueAssets(r.net, quotes);
  return { users, mainnet, combined: sources.length > 1 };
}
module.exports = { playerReport };
