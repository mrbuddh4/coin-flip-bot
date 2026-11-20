const { SolanaPrices, decimalPrice } = require('../solana/prices');
// No Solana fallback for an identically named SID. Missing quotes stay unranked.
class RobinhoodPrices extends SolanaPrices {
  async get(assets) {
    const requested = [...new Set(assets)];
    const missing = requested.filter(m => (this.cache.get(m)?.until || 0) <= this.now());
    for (const mint of missing) {
      let quote = null;
      try {
        const chain = mint === 'NATIVE' ? 'ethereum' : 'robinhood';
        const token = mint === 'NATIVE' ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : mint;
        const pairs = await this.json(`https://api.dexscreener.com/tokens/v1/${chain}/${token}`);
        const markets = Array.isArray(pairs) ? pairs.filter(p => p.chainId === chain && p.baseToken?.address?.toLowerCase() === token && decimalPrice(p.priceUsd) && Number(p.liquidity?.usd) > 0).sort((a,b) => Number(b.liquidity.usd) - Number(a.liquidity.usd)) : [];
        if (markets.length) quote = { ...decimalPrice(markets[0].priceUsd), at: this.now(), source: 'DEX Screener' };
      } catch (_) {}
      this.cache.set(mint, { quote, until: this.now() + (quote ? 60000 : 15000) });
    }
    return new Map(requested.flatMap(m => { const v = this.cache.get(m); return v?.quote && v.until > this.now() ? [[m, v.quote]] : []; }));
  }
}
module.exports = { RobinhoodPrices };
