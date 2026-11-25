const { SolanaPrices, decimalPrice, valueAssets, compareValues, formatEstimate, WRAPPED_SOL } = require('../src/solana/prices');
const estimate = (assets, quotes) => formatEstimate(valueAssets(assets, quotes));
const A = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';
const B = '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY';
const reply = data => ({ ok: true, json: async () => data });
function market(mint, priceUsd, usd, extra = {}) { return { chainId: 'solana', baseToken: { address: mint }, priceUsd, liquidity: { usd }, ...extra }; }
test('selects the deepest Solana base-token market, never a matching symbol, quote token or other chain', async () => {
  const fetcher = jest.fn().mockResolvedValue(reply([
    market(A, '0.005', 400), market(A, '0.004', 900), market(A, '99', 99999, { chainId: 'ethereum' }),
    market(B, '5000', 999999, { quoteToken: { address: A } }), market(A, 'NaN', 99999), market(A, '9', 0),
  ]));
  const quotes = await new SolanaPrices({ fetcher, now: () => 1000 }).get([A]);
  expect(quotes.get(A)).toMatchObject({ units: 4n, scale: 1000n, source: 'DEX Screener', at: 1000 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('native SOL uses wrapped SOL market pricing; cache and concurrent requests avoid repeated queries', async () => {
  let now = 1000;
  const fetcher = jest.fn().mockResolvedValue(reply([market(WRAPPED_SOL, '83.43', 9000)]));
  const prices = new SolanaPrices({ fetcher, now: () => now });
  const [a, b] = await Promise.all([prices.get(['NATIVE']), prices.get(['NATIVE'])]);
  expect(a.get('NATIVE')).toEqual(b.get('NATIVE'));
  expect(fetcher.mock.calls[0][0]).toContain(WRAPPED_SOL);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await prices.get(['NATIVE']); expect(fetcher).toHaveBeenCalledTimes(1);
  now += 60001;
  await prices.get(['NATIVE']); expect(fetcher).toHaveBeenCalledTimes(2);
});
test('missing or failed DEX quotes fall back by exact mint; unavailable assets remain absent', async () => {
  const fetcher = jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(reply({ data: { attributes: { token_prices: { [A]: '0.0047', [B]: '0' } } } }));
  const quotes = await new SolanaPrices({ fetcher }).get([A, B]);
  expect(quotes.get(A)).toMatchObject({ source: 'GeckoTerminal', units: 47n, scale: 10000n });
  expect(quotes.has(B)).toBe(false);
  expect(fetcher.mock.calls[1][0]).toContain('/simple/networks/solana/token_price/');
});
test('expired quotes are not silently reused after API failures and failure results are briefly cached', async () => {
  let now = 1000;
  const fetcher = jest.fn().mockResolvedValueOnce(reply([market(A, '1', 1000)])).mockRejectedValue(new Error('offline'));
  const prices = new SolanaPrices({ fetcher, now: () => now });
  expect((await prices.get([A])).has(A)).toBe(true);
  now += 60001;
  expect((await prices.get([A])).has(A)).toBe(false);
  expect((await prices.get([A])).has(A)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true);
});
test('batching requests at most 30 mints and ignores malformed metadata', async () => {
  const mints = Array.from({ length: 31 }, (_, i) => 'A'.repeat(31) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[i]);
  const fetcher = jest.fn(async url => reply(url.split('/').at(-1).split(',').map(m => market(m, '1', 100))));
  const quotes = await new SolanaPrices({ fetcher }).get([...mints, ...mints, 'bad/path']);
  expect(quotes.size).toBe(31); expect(fetcher).toHaveBeenCalledTimes(2);
});
test.each(['0', '-1', 'NaN', 'Infinity', 'bad', '1e999', '9'.repeat(129), null, 2])('invalid price %p is unavailable', value => {
  expect(decimalPrice(value)).toBeNull();
});
test('mixed-asset USD subtotal uses token decimals, preserves u64 precision and labels incomplete totals', () => {
  const prizes = new Map([[A, { amount: 18000000000n, decimals: 6 }], ['NATIVE', { amount: 1800000000n, decimals: 9 }]]);
  const quotes = new Map([[A, decimalPrice('0.004768')], ['NATIVE', decimalPrice('83.43')]]);
  expect(estimate(prizes, quotes)).toBe('Net P/L: ≈+$236.00');
  quotes.delete(A); expect(estimate(prizes, quotes)).toBe('Known net subtotal: ≈+$150.17 (unpriced tokens; unranked)');
  quotes.clear(); expect(estimate(prizes, quotes)).toBe('Net P/L: USD unavailable');
  expect(estimate(new Map(), quotes)).toBe('Net P/L: ≈$0.00');
  expect(estimate(new Map([[A, { amount: 18446744073709551615n, decimals: 0 }]]), new Map([[A, decimalPrice('0.01')]]))).toBe('Net P/L: ≈+$184,467,440,737,095,516.15');
  expect(estimate(new Map([[A, { amount: 1n, decimals: 0 }]]), new Map([[A, decimalPrice('1e-5')]]))).toBe('Net P/L: ≈+<$0.01');
});

test('very small positive quotes display below one cent instead of a false zero', () => {
  expect(estimate(new Map([[A, { amount: 1n, decimals: 18 }]]), new Map([[A, decimalPrice('1e-20')]]))).toBe('Net P/L: ≈+<$0.01');
});

test('signed mixed-asset profit rounds losses correctly and compares exact values before display rounding', () => {
  const quotes = new Map([[A, decimalPrice('0.004768')], ['NATIVE', decimalPrice('83.43')]]);
  expect(estimate(new Map([[A, { amount: -18000000000n, decimals: 6 }], ['NATIVE', { amount: -1800000000n, decimals: 9 }]]), quotes)).toBe('Net P/L: ≈-$236.00');
  const small = valueAssets(new Map([[A, { amount: -1n, decimals: 6 }]]), quotes);
  expect(formatEstimate(small)).toBe('Net P/L: ≈-<$0.01');
  const high = valueAssets(new Map([[A, { amount: 2n, decimals: 6 }]]), quotes);
  const low = valueAssets(new Map([[A, { amount: 1n, decimals: 6 }]]), quotes);
  expect(formatEstimate(high)).toBe(formatEstimate(low));
  expect(compareValues(high, low)).toBe(1);
  expect(compareValues(low, high)).toBe(-1);
  expect(compareValues(low, low)).toBe(0);
  expect(estimate(new Map([[A, { amount: 0n, decimals: 6 }]]), new Map())).toBe('Net P/L: ≈$0.00');
});
