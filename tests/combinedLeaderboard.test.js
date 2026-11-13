const { SolanaInterface } = require('../src/solana/interface');
const { decimalPrice } = require('../src/solana/prices');
const alice = { userId: '1', name: 'Alice' }, bob = { userId: '2', name: 'Bob' };
function game(id, winnerId, mint = 'SID', decimals = 6, amount = 100n, extra = {}) {
  const unit = 10n ** BigInt(decimals);
  return { id, status: 'SETTLED', creator: alice, challenger: bob, winnerId,
    token: { address: mint, symbol: mint, decimals }, wager: String(amount * unit),
    prize: String(amount * unit * 18n / 10n), ...extra };
}
function source(key, results, paid, prices, live = true) {
  const store = { allResults: jest.fn(async () => results), confirmedPrizeGameIds: jest.fn(async () => new Set(paid)) };
  const ui = new SolanaInterface({ telegram: {} }, { store, chain: { key, realFunds: live, env: { SOLANA_CLUSTER: live ? 'mainnet-beta' : 'devnet' } } }, {});
  ui.prices = { get: jest.fn(async () => new Map(Object.entries(prices).map(([mint, price]) => [mint, decimalPrice(price)]))) };
  ui.reply = jest.fn(); return ui;
}
function combine(...sources) { for (const ui of sources) ui.reportingSources = sources; }
test('both selected networks combine per-user counts and net USD with chain-specific SID and native prices', async () => {
  const sol = source('solana', [game('sid-sol', '1'), game('native-sol', '1', 'NATIVE', 9, 1n)], ['sid-sol', 'native-sol'], { SID: '1', NATIVE: '100' });
  const rh = source('robinhood', [game('sid-rh', '2', 'SID', 18), game('native-rh', '2', 'NATIVE', 18, 1n)], ['sid-rh', 'native-rh'], { SID: '2', NATIVE: '2000' });
  combine(sol, rh);
  await sol.leaderboard({}); await rh.leaderboard({});
  const text = sol.reply.mock.calls[0][1];
  expect(text).toBe(rh.reply.mock.calls[0][1]);
  expect(text).toContain('Solana + Robinhood combined');
  expect(text).toContain('1. <a href="tg://user?id=2">Bob</a>: 2 wins, 2 losses\nFlips: 4\nNet P/L: ≈+$1,560.00');
  expect(text).toContain('Alice</a>: 2 wins, 2 losses\nFlips: 4\nNet P/L: ≈-$2,040.00');
  expect(sol.prices.get).toHaveBeenCalledWith(['SID', 'NATIVE']); expect(rh.prices.get).toHaveBeenCalledWith(['SID', 'NATIVE']);
  await sol.stats({ from: { id: 1 } }); await rh.stats({ from: { id: 1 } });
  const stats = sol.reply.mock.calls[1][1]; expect(stats).toBe(rh.reply.mock.calls[1][1]);
  expect(stats).toContain('Flips: 4\nWins: 2\nLosses: 2\nNet P/L: ≈-$2,040.00');
  expect(stats).toContain('Solana: SID'); expect(stats).toContain('Robinhood: SID');
});
test('same game ID never shares payout confirmation across chains; cancelled and unrevealed games are excluded', async () => {
  const sol = source('solana', [game('same', '1'), game('cancel', '1', 'SID', 6, 100n, { status: 'CANCELLED' })], ['same', 'cancel'], { SID: '1' });
  const rh = source('robinhood', [game('same', '1', 'SID', 18), game('hidden', '1', 'SID', 18, 100n, { interfaceVersion: 2, ui: {} })], [], { SID: '2' });
  combine(sol, rh); await rh.leaderboard({});
  expect(rh.reply.mock.calls[0][1]).toContain('Alice</a>: 2 wins, 0 losses\nFlips: 2\nNet P/L: ≈-$120.00 · prize pending');
  await sol.stats({ from: { id: 1 } });
  expect(sol.reply.mock.calls[0][1]).toContain('Flips: 2\nWins: 2\nLosses: 0\nNet P/L: ≈-$120.00 · prize pending');
});
test('missing prices on either chain make combined P/L incomplete; test coins never enter live totals', async () => {
  const sol = source('solana', [game('a', '1')], ['a'], { SID: '1' });
  const rh = source('robinhood', [game('b', '1', 'SID', 18)], ['b'], {});
  const dev = source('devnet', [game('c', '1')], ['c'], { SID: '999999' }, false);
  combine(sol, rh, dev); await sol.leaderboard({});
  expect(sol.reply.mock.calls[0][1]).toContain('Unranked <a href="tg://user?id=1">Alice</a>: 2 wins, 0 losses\nFlips: 2\nKnown net subtotal: ≈+$80.00 (unpriced tokens; unranked)');
  expect(dev.store.allResults).not.toHaveBeenCalled(); expect(dev.prices.get).not.toHaveBeenCalled();
  await rh.stats({ from: { id: 1 } }); expect(rh.reply.mock.calls[0][1]).toContain('Known net subtotal: ≈+$80.00');
});
test('no-history personal stats shows zero and does not fetch quotes', async () => {
  const sol = source('solana', [], [], {}); await sol.stats({ from: { id: 99 } });
  expect(sol.reply.mock.calls[0][1]).toContain('Flips: 0\nWins: 0\nLosses: 0\nNet P/L: ≈$0.00');
  expect(sol.prices.get).not.toHaveBeenCalled();
});
