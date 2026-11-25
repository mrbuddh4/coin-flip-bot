const { DailyAudit } = require('../src/solana/dailyAudit');
const DAY = 86400000;

function fixture() {
  let now = Date.parse('2026-11-25T17:00:00Z');
  const done = new Map();
  const store = { pool: { query: jest.fn(async (sql, [day, id] = []) => {
    if (sql.startsWith('SELECT recipient')) return { rows: [...(done.get(day) || [])].map(recipient => ({ recipient })) };
    if (sql.startsWith('INSERT')) {
      if (!done.has(day)) done.set(day, new Set());
      done.get(day).add(id);
      return {};
    }
    return { rows: [] };
  }) } };
  const sol = { name: 'Solana', store: { pool: { query: jest.fn(async () => ({ rows: [] })) } }, chain: {} };
  const rh = { name: 'Robinhood', store: { pool: { query: jest.fn(async () => ({ rows: [] })) } },
    chain: { chainId: 4663, explorer: hash => 'https://robinhoodchain.blockscout.com/tx/' + hash } };
  const telegram = { sendMessage: jest.fn() };
  const boot = () => new DailyAudit({ store, telegram, sources: [sol, rh], adminIds: '12, 12, -100', now: () => now });
  return { boot, telegram, sol, rh, advance: ms => { now += ms; } };
}

test('clean audit stays silent; one private alert combines both ledgers and survives restart without repeating', async () => {
  const { boot, telegram, sol, rh, advance } = fixture();
  const instance = boot();
  await instance.tick();
  await boot().tick();
  expect(telegram.sendMessage).not.toHaveBeenCalled();
  advance(DAY);
  sol.store.pool.query.mockResolvedValueOnce({ rows: [{ kind: 'payment', ref: 'prize:example', detail: 'SIGNED' }] });
  rh.store.pool.query.mockResolvedValueOnce({ rows: [{ kind: 'deposit', ref: '0xexample' }] });
  await instance.tick();
  await boot().tick();
  expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  expect(telegram.sendMessage).toHaveBeenCalledWith('12', expect.stringContaining('Solana: SIGNED payment prize:example'), expect.anything());
  expect(telegram.sendMessage.mock.calls[0][1]).toContain('https://robinhoodchain.blockscout.com/tx/0xexample');
});

test('a failed alert retries and a ledger failure is surfaced without leaking its error', async () => {
  const { boot, telegram, rh, advance } = fixture();
  rh.store.pool.query.mockRejectedValue(new Error('postgres://private'));
  telegram.sendMessage.mockRejectedValueOnce(new Error('Telegram unavailable'));
  const instance = boot();
  await expect(instance.tick()).rejects.toThrow('Telegram unavailable');
  advance(5 * 60000);
  await instance.tick();
  expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  expect(telegram.sendMessage.mock.calls[1][1]).toContain('Robinhood: audit could not read the ledger.');
  expect(telegram.sendMessage.mock.calls[1][1]).not.toContain('postgres://');
});
