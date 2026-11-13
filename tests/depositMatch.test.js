const { noMemoCandidates } = require('../src/solana/depositMatch');
const game = { id: 'g', createdAt: 1000, expiresAt: 5000, token: { address: 'NATIVE' }, wager: '100', creator: { userId: '1', wallet: 'alice', depositExpiresAt: 4000 }, challenger: { userId: '2', wallet: 'bob', joinedAt: 2000, depositExpiresAt: 4500 } };
const request = { sender: 'alice', mint: 'NATIVE', amount: '100', at: 3000 };
test('matches exact historical sender, asset and frozen payment window', () => {
  expect(noMemoCandidates([game], request)).toEqual([{ gameId: 'g', userId: '1' }]);
  expect(noMemoCandidates([{ ...game, status: 'CANCELLED' }], request)).toHaveLength(1);
});
test.each([{ sender: 'mallory' }, { mint: 'OTHER' }, { amount: '0' }, { amount: '-1' }, { amount: '1.5' }, { amount: '18446744073709551616' }, { at: 999 }, { at: 4000 }, { at: NaN }, { at: null }])('rejects mismatched or missing proof fields %j', override => {
  expect(noMemoCandidates([game], { ...request, ...override })).toEqual([]);
});
test('a challenger receipt cannot predate joining, and legacy missing join time is refused', () => {
  expect(noMemoCandidates([game], { ...request, sender: 'bob', at: 1000 })).toEqual([]);
  expect(noMemoCandidates([game], { ...request, sender: 'bob', at: 2000 })).toHaveLength(1);
  expect(noMemoCandidates([{ ...game, challenger: { ...game.challenger, joinedAt: undefined } }], { ...request, sender: 'bob' })).toEqual([]);
});
test('closed and already funded overlaps remain candidates rather than authorizing a different game', () => {
  expect(noMemoCandidates([game, { ...game, id: 'other', status: 'SETTLED', creator: { ...game.creator, deposit: {} } }], request)).toHaveLength(2);
});

const { refundCandidates } = require('../src/solana/depositMatch');
test('refund-only matching allows bounded late and clock-margin sends without authorizing funding', () => {
  const atEnd = { ...request, at: 4000 };
  expect(noMemoCandidates([game], atEnd)).toHaveLength(0);
  expect(refundCandidates([game], atEnd)).toEqual([expect.objectContaining({ gameId: 'g', userId: '1' })]);
  expect(refundCandidates([game], { ...request, at: 4000 + 15 * 60000 })).toHaveLength(0);
  expect(refundCandidates([game], { ...request, at: NaN })).toHaveLength(0);
  expect(refundCandidates([game], { ...request, sender: 'mallory' })).toHaveLength(0);
  expect(refundCandidates([game], { ...request, amount: '99' })).toHaveLength(1);
  expect(refundCandidates([game], { ...request, amount: '101' })).toHaveLength(1);
  for (const amount of ['0', '-1', '1.5', 'invalid', '18446744073709551616']) expect(refundCandidates([game], { ...request, amount })).toHaveLength(0);
  expect(refundCandidates([game], { ...request, mint: 'OTHER' })).toHaveLength(0);
});

test('different amounts can top up one request, but overlapping different wagers are ambiguous', () => {
  expect(noMemoCandidates([game], { ...request, amount: '99' })).toHaveLength(1);
  expect(noMemoCandidates([game, { ...game, id: 'other', wager: '200' }], request)).toHaveLength(2);
});

test('a verified funded cutoff closes unused timeout but preserves same-second ambiguity and original refund window',()=>{
  const completed={...game,creator:{...game.creator,deposit:{signature:'old'},depositWindowClosedAt:3000}};
  const next={...game,id:'next',createdAt:2500};
  expect(noMemoCandidates([completed,next],{...request,at:2999})).toHaveLength(2);
  expect(noMemoCandidates([completed,next],{...request,at:3000})).toEqual([{gameId:'next',userId:'1'}]);
  expect(refundCandidates([completed,next],{...request,at:3500})).toHaveLength(2);
  const partial={...game,creator:{...game.creator,funding:{amount:'1',receipts:[]}}};
  expect(noMemoCandidates([partial,next],{...request,at:3500})).toHaveLength(2);
});
