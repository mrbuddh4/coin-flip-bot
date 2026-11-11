const { SolanaInterface } = require('../src/solana/interface');
const { decimalPrice } = require('../src/solana/prices');
const A = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';
const alice = { userId: '1', name: '<Alice>' }, bob = { userId: '2', name: 'Bob' };
function game(id, winnerId, mint = A, prize = '180000000', decimals = 6, extra = {}) {
  return { id, status: 'SETTLED', creator: alice, challenger: bob, winnerId, token: { address: mint, symbol: 'SAME', decimals }, wager: mint === 'NATIVE' ? '500000000' : '100000000', prize, ...extra };
}
function setup(results, ids, cluster = 'mainnet-beta') {
  const store = { allResults: jest.fn().mockResolvedValue(results), confirmedPrizeGameIds: jest.fn().mockResolvedValue(new Set(ids)) };
  const ui = new SolanaInterface({ telegram: {} }, { store, chain: { env: { SOLANA_CLUSTER: cluster } } }, {});
  ui.reply = jest.fn(); ui.prices = { get: jest.fn().mockResolvedValue(new Map([[A, decimalPrice('1')], ['NATIVE', decimalPrice('100')]])) };
  return ui;
}
test('net P/L subtracts every completed stake, excludes pending prizes and hides unrevealed results', async () => {
  const ui = setup([game('a', '1'), game('b', '2', 'NATIVE', '900000000', 9), game('c', '1', A, '999000000'), game('hidden', '2', A, '500000000000', 6, { interfaceVersion: 2, ui: {} })], ['a', 'b', 'hidden']);
  await ui.leaderboard({}); const text = ui.reply.mock.calls[0][1];
  expect(text).toContain('1. <a href="tg://user?id=1">&lt;Alice&gt;</a>: 2 wins, 1 losses\nNet P/L: ≈-$70.00 · prize pending');
  expect(text).toContain('2. <a href="tg://user?id=2">Bob</a>: 1 wins, 2 losses\nNet P/L: ≈-$160.00');
  expect(text).toContain('paid prizes minus all stakes in completed flips, including winning stakes');
  expect(text).toContain('Ranked by estimated net USD profit (highest first)');
  expect(text).toContain('Pending prizes are excluded until paid');
  expect(text).not.toContain('999.00'); expect(text).not.toContain('500,000');
});
test('same-name custom tokens remain distinct and missing prices show incomplete totals', async () => {
  const ui = setup([game('a', '1'), game('b', '1', 'unpriced-mint')], ['a', 'b']);
  await ui.leaderboard({});
  expect(ui.prices.get).toHaveBeenCalledWith([A, 'unpriced-mint']);
  expect(ui.reply.mock.calls[0][1]).toContain('Known net subtotal: ≈+$80.00 (unpriced tokens; unranked)');
  expect(ui.reply.mock.calls[0][1]).toContain('Unranked <a');
});
test('devnet never assigns real USD to test coins or fetches prices', async () => {
  const ui = setup([game('a', '1')], ['a'], 'devnet');
  await ui.leaderboard({});
  expect(ui.prices.get).not.toHaveBeenCalled();
  expect(ui.reply.mock.calls[0][1]).toContain('Test coins: no USD value');
  expect(ui.reply.mock.calls[0][1]).not.toContain('$');
});
test('empty board requires no price requests and loss ranking remains available', async () => {
  const ui = setup([], []); await ui.leaderboard({});
  expect(ui.reply.mock.calls[0][1]).toContain('No completed flips yet.'); expect(ui.prices.get).not.toHaveBeenCalled();
  const wall = setup([game('a', '1'), game('b', '1')], ['a', 'b']); await wall.leaderboard({}, true);
  expect(wall.reply.mock.calls[0][1]).toContain('Ranked by estimated net USD profit (lowest first).\n\n1. <a href="tg://user?id=2">Bob</a>');
});

test('one win at a larger value outranks more small wins; losses can make net totals negative', async () => {
  const rich = { userId: '3', name: 'Rich' }, other = { userId: '4', name: 'Other' };
  const ui = setup([game('a', '1', A, '1800000', 6, { wager: '1000000' }), game('b', '1', A, '1800000', 6, { wager: '1000000' }), game('big', '3', A, '90000000', 6, { wager: '50000000', creator: rich, challenger: other })], ['a','b','big']);
  await ui.leaderboard({}); const text = ui.reply.mock.calls[0][1];
  expect(text).toContain('1. <a href="tg://user?id=3">Rich</a>: 1 wins, 0 losses\nNet P/L: ≈+$40.00');
  expect(text).toContain('2. <a href="tg://user?id=1">&lt;Alice&gt;</a>: 2 wins, 0 losses\nNet P/L: ≈+$1.60');
  expect(text).toContain('Net P/L: ≈-$2.00');
});
test('USD ranking evaluates all players before the top-ten cutoff', async () => {
  const results = Array.from({ length: 12 }, (_, i) => game('low' + i, 'low' + i, A, '1800000', 6, { wager: '1000000', creator: { userId: 'low' + i, name: 'Low' + i }, challenger: bob }));
  results.push(game('high', 'high', A, '180000000000', 6, { wager: '100000000000', creator: { userId: 'high', name: 'High' }, challenger: bob }));
  const ui = setup(results, results.map(g => g.id));
  await ui.leaderboard({});
  expect(ui.reply.mock.calls[0][1]).toContain('1. <a href="tg://user?id=high">High</a>');
});
test('unpriced negative exposure cannot outrank complete totals and refunded/open games never affect profit', async () => {
  const ui = setup([game('known', '1'), game('missing-loss', '2', 'unpriced'), game('complete', '3', A, '180000000', 6, { creator: { userId: '3', name: 'Complete' }, challenger: { userId: '4', name: 'Other' } }), game('open', '1', A, '999999999999', 6, { status: 'OPEN' }), game('refund', '1', A, '999999999999', 6, { status: 'CANCELLED' })], ['known', 'complete', 'open', 'refund']);
  await ui.leaderboard({}); const text = ui.reply.mock.calls[0][1];
  expect(text).toContain('1. <a href="tg://user?id=3">Complete</a>');
  expect(text).toContain('2. <a href="tg://user?id=4">Other</a>');
  expect(text.indexOf('Unranked')).toBeGreaterThan(text.indexOf('Net P/L: ≈-$100.00'));
  expect(text).toContain('Unranked <a href="tg://user?id=1">&lt;Alice&gt;</a>: 1 wins, 1 losses');
  expect(text).toContain('Known net subtotal: ≈+$80.00 (unpriced tokens; unranked)');
  expect(text).not.toContain('999,999');
});
test('an exact break-even user remains ranked when the token price is unavailable', async () => {
  const ui = setup([game('win', '1', A, '200000000'), game('loss', '2')], ['win', 'loss']);
  ui.prices.get.mockResolvedValue(new Map());
  await ui.leaderboard({}); const text = ui.reply.mock.calls[0][1];
  expect(text).toContain('1. <a href="tg://user?id=1">&lt;Alice&gt;</a>: 1 wins, 1 losses\nNet P/L: ≈$0.00');
});

const integration = process.env.SOLANA_TEST_DATABASE_URL ? describe : describe.skip;
integration('paid leaderboard source on disposable PostgreSQL', () => {
  const { Pool } = require('pg');
  const { SolanaStore } = require('../src/solana/store');
  let admin, pool, schema;
  beforeAll(async () => {
    const url = process.env.SOLANA_TEST_DATABASE_URL;
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Disposable local database only');
    admin = new Pool({ connectionString: url });
    schema = `leaderboard_usd_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/solana/schema.sql'), 'utf8'));
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  test('only canonical confirmed prize payments count, excluding refunds, fees and pending or uncertain payouts', async () => {
    for (const [id, status, kind, prefix] of [['paid', 'CONFIRMED', 'prize', 'prize'], ['pending', 'PENDING', 'prize', 'prize'], ['signed', 'SIGNED', 'prize', 'prize'], ['uncertain', 'REVIEW', 'prize', 'prize'], ['refund', 'CONFIRMED', 'refund', 'refund'], ['burn', 'CONFIRMED', 'burn', 'burn'], ['extra', 'CONFIRMED', 'prize', 'other']]) {
      await pool.query('INSERT INTO "SolGames" (id,state) VALUES ($1,$2)', [id, JSON.stringify(game(id, '1'))]);
      await pool.query('INSERT INTO "SolOutbox" (id,"gameId",status,payment) VALUES ($1,$2,$3,$4)', [`${prefix}:${id}`, id, status, JSON.stringify({ kind, amount: '180000000' })]);
    }
    const store = new SolanaStore(pool);
    expect(await store.confirmedPrizeGameIds()).toEqual(new Set(['paid']));
    await pool.query('UPDATE "SolOutbox" SET status=\'CONFIRMED\' WHERE id=\'prize:signed\'');
    expect(await store.confirmedPrizeGameIds()).toEqual(new Set(['paid', 'signed']));
  });
});
