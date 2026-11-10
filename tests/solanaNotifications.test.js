const { compactPayments } = require('../src/solana/paymentView');
const { ObsoleteNoticeCleanup } = require('../src/solana/notifications');
const { toUnits } = require('../src/solana/amounts');
const game = { status: 'SETTLED', token: { address: 'NATIVE', symbol: 'SOL', decimals: 9 }, creator: { userId: '1', name: '<Alice>', wallet: 'alice-wallet' }, fees: { holder: '10000000' } };
const explorer = sig => 'https://explorer.solana.com/tx/' + sig;
test('phone decimal input accepts .01 exactly and preserves precision/range checks', () => {
  expect(toUnits('.01', 9)).toBe(10000000n);
  for (const text of ['.', '-.01', '1e-2', '.0000000001', '0']) expect(() => toUnits(text, 9)).toThrow();
});
test('winner proof is a compact row of labeled links, with no visible transaction hashes or wallet dumps', () => {
  const payments = ['prize','burn','holder-reserve'].map(kind => ({ id: kind + ':g', status: 'CONFIRMED', signature: 'longsignature-' + kind, payment: { kind } }));
  const text = compactPayments(game, payments, explorer);
  expect(text).toContain('>Prize ✓</a> · <a'); expect(text).toContain('>Burn ✓</a>'); expect(text).toContain('>Holder fee ✓</a>');
  expect(text).not.toContain('From:'); expect(text).not.toContain('Mint:');
  expect(text.replace(/<[^>]*>/g, '')).toBe('Prize ✓ · Burn ✓ · Holder fee ✓');
});
test('pending and uncertain transactions are never labeled paid; a retained holder pool has no invented tx', () => {
  const text = compactPayments(game, [{ id: 'prize:g', status: 'SIGNED', signature: 'sig' }, { id: 'burn:g', status: 'REVIEW', signature: 'burn-sig' }], explorer);
  expect(text).toContain('Prize pending'); expect(text).toContain('Burn needs review'); expect(text).toContain('Holder fee: reserved'); expect(text).not.toContain('✓');
});
test('refunds identify the player and amount while wrong-asset refunds never use SOL decimals', () => {
  const p = { id: 'refund:deposit', status: 'CONFIRMED', signature: 'refund-proof', payment: { kind: 'refund', mint: 'NATIVE', amount: '100000000', recipient: 'alice-wallet' } };
  let text = compactPayments({ ...game, status: 'CANCELLED' }, [p], explorer);
  expect(text).toContain('Refund to &lt;Alice&gt;: 0.1 SOL ✓'); expect(text).toContain('/tx/refund-proof');
  p.payment.mint = 'other-mint'; p.payment.amount = '1234'; text = compactPayments({ ...game, status: 'CANCELLED' }, [p], explorer);
  expect(text).toContain('1234 atomic units'); expect(text).not.toContain('SOL');
});
test('cleanup removes only recorded obsolete notices and cannot send messages or alter financial rows', async () => {
  const rows = [{ eventId: 'deposit:a', chatId: '-100', messageId: '42' }];
  const store = { pool: { query: jest.fn().mockResolvedValueOnce({ rows }).mockResolvedValue({ rows: [] }) } };
  const telegram = { deleteMessage: jest.fn().mockResolvedValue({}), sendMessage: jest.fn() };
  await new ObsoleteNoticeCleanup(store, telegram).tick();
  expect(telegram.deleteMessage).toHaveBeenCalledWith('-100', 42); expect(telegram.sendMessage).not.toHaveBeenCalled();
  expect(store.pool.query.mock.calls[1][1]).toEqual(['deposit:a', '-100', 'REMOVED']);
  expect(store.pool.query.mock.calls.every(([sql]) => !/SolOutbox|SolDeposits|SolGames/.test(sql))).toBe(true);
});
test('cleanup respects Telegram retry delays and does not claim an undeletable old message was removed', async () => {
  const row = { eventId: 'deposit:a', chatId: '-100', messageId: 42 };
  const store = { pool: { query: jest.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValue({ rows: [] }) } };
  const telegram = { deleteMessage: jest.fn().mockRejectedValue({ response: { parameters: { retry_after: 90 } } }) };
  await new ObsoleteNoticeCleanup(store, telegram).tick(); expect(store.pool.query.mock.calls[1][1]).toEqual(['deposit:a', '-100', 90]);
  store.pool.query.mockResolvedValueOnce({ rows: [row] }); telegram.deleteMessage.mockRejectedValue({ response: { error_code: 403 } });
  await new ObsoleteNoticeCleanup(store, telegram).tick(); expect(store.pool.query.mock.calls.at(-1)[1]).toEqual(['deposit:a', '-100', 'UNDELETABLE']);
});
