// Read-only display quotes. Never used for wagers, balances, fees or payouts.
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
function decimalPrice(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,2}))?$/i.exec(value);
  if (!m) return null;
  let units = BigInt(m[1] + (m[2] || ''));
  if (units <= 0n) return null;
  const exponent = Number(m[3] || 0) - (m[2]?.length || 0);
  if (Math.abs(exponent) > 100) return null;
  return exponent >= 0 ? { units: units * 10n ** BigInt(exponent), scale: 1n } : { units, scale: 10n ** BigInt(-exponent) };
}
class SolanaPrices {
  constructor({ fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
    Object.assign(this, { fetcher, now }); this.cache = new Map(); this.inflight = new Map();
  }
  async json(url) {
    const response = await this.fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'CoinFlipBot/1.0' }, signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error('Price source unavailable');
    return response.json();
  }
  async batch(mints) {
    const quotes = new Map();
    try {
      const pairs = await this.json(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`);
      if (Array.isArray(pairs)) for (const mint of mints) {
        const markets = pairs.filter(p => p.chainId === 'solana' && p.baseToken?.address === mint && decimalPrice(p.priceUsd) && Number(p.liquidity?.usd) > 0)
          .sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd));
        if (markets.length) quotes.set(mint, { ...decimalPrice(markets[0].priceUsd), source: 'DEX Screener', at: this.now() });
      }
    } catch (_) { /* Missing quotes are retried with the independent source. */ }
    const missing = mints.filter(m => !quotes.has(m));
    if (missing.length) try {
      const body = await this.json(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${missing.join(',')}`);
      const values = body?.data?.attributes?.token_prices || {};
      for (const mint of missing) {
        const price = decimalPrice(values[mint]);
        if (price) quotes.set(mint, { ...price, source: 'GeckoTerminal', at: this.now() });
      }
    } catch (_) { /* No quote is displayed as unavailable, never as zero. */ }
    for (const mint of mints) this.cache.set(mint, { quote: quotes.get(mint) || null, until: this.now() + (quotes.has(mint) ? 60000 : 15000) });
  }
  async get(mints) {
    const requested = [...new Set(mints)];
    const canonical = mint => mint === 'NATIVE' ? WRAPPED_SOL : mint;
    const valid = [...new Set(requested.map(canonical).filter(m => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))];
    const pending = valid.filter(m => (this.cache.get(m)?.until || 0) <= this.now());
    const waits = [];
    for (let i = 0; i < pending.length; i += 30) {
      const batch = pending.slice(i, i + 30), key = batch.slice().sort().join(',');
      if (!this.inflight.has(key)) this.inflight.set(key, this.batch(batch).finally(() => this.inflight.delete(key)));
      waits.push(this.inflight.get(key));
    }
    await Promise.all(waits);
    return new Map(requested.flatMap(mint => {
      const entry = this.cache.get(canonical(mint));
      return entry?.quote && entry.until > this.now() ? [[mint, entry.quote]] : [];
    }));
  }
}
// Add signed token balances as exact rational USD values. Stakes, quotes and
// ordering never pass through floating point or rounded display cents.
function valueAssets(assets, quotes) {
  let units = 0n, scale = 1n, missing = 0, priced = 0;
  for (const [mint, asset] of assets) {
    if (asset.amount === 0n) continue;
    const quote = quotes.get(mint);
    if (!quote || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) { missing++; continue; }
    const divisor = 10n ** BigInt(asset.decimals) * quote.scale;
    if (divisor > scale) { units *= divisor / scale; scale = divisor; }
    units += asset.amount * quote.units * (scale / divisor);
    priced++;
  }
  return { units, scale, missing, priced };
}
function compareValues(a, b) {
  const left = a.units * b.scale, right = b.units * a.scale;
  return left < right ? -1 : left > right ? 1 : 0;
}
function formatEstimate(value) {
  if (value.missing && !value.priced) return 'Net P/L: USD unavailable';
  const absolute = value.units < 0n ? -value.units : value.units;
  const cents = (absolute * 100n + value.scale / 2n) / value.scale;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = absolute > 0n && cents === 0n ? '<$0.01' : `$${dollars}.${(cents % 100n).toString().padStart(2, '0')}`;
  const sign = value.units < 0n ? '-' : value.units > 0n ? '+' : '';
  return `${value.missing ? 'Known net subtotal' : 'Net P/L'}: ≈${sign}${amount}${value.missing ? ' (unpriced tokens; unranked)' : ''}`;
}
module.exports = { SolanaPrices, decimalPrice, valueAssets, compareValues, formatEstimate, WRAPPED_SOL };
