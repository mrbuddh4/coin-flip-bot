const { paymentHandler } = require('../src/solana/paymentPage');
const { startHealthServer } = require('../src/utils/healthServer');
const { assertLaunchReady } = require('../src/solana/runtime');
const { SID_MINT } = require('../src/solana/featured');
const { Keypair } = require('@solana/web3.js');
const wallet = Keypair.fromSeed(Buffer.alloc(32, 4)).publicKey.toBase58();
const id = '00000000-0000-4000-8000-000000000001', payToken = 'ab'.repeat(16);
let server, game, service, base;
beforeEach(async () => {
  game = { id, status: 'OPEN', expiresAt: 2000, depositAddress: wallet, token: { address: SID_MINT, decimals: 6, symbol: '<SID>' }, wager: '1000000',
    creator: { wallet, memo: `coinflip:${id}:creator`, payToken } };
  service = { store: { get: jest.fn().mockResolvedValue(game) }, now: () => 1000, chain: { env: { SOLANA_CLUSTER: 'mainnet-beta' } } };
  server = await startHealthServer({ port: 0, host: '127.0.0.1', status: () => ({ ready: true }), handle: paymentHandler(service) });
  base = `http://127.0.0.1:${server.address().port}/pay/${id}/creator/${payToken}`;
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); });
test('mobile payment link includes exact amount/mint/memo, correct network and no injected HTML', async () => {
  const response = await fetch(base), html = await response.text();
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(html).toContain('Solana mainnet'); expect(html).toContain('&lt;SID&gt;'); expect(html).not.toContain('<SID>');
  expect(html).toContain(`spl-token=${SID_MINT}`); expect(html).toContain('amount=1');
  expect(html).toContain(`memo=coinflip%3A${id}%3Acreator`);
  expect(html).not.toContain('<script');
});
test.each(['CANCELLED', 'SETTLED', 'FUNDED', 'EXPIRED'])('closed/already funded/expired request (%s) refuses to open a transfer', async state => {
  if (state === 'FUNDED') game.creator.deposit = {};
  else if (state === 'EXPIRED') game.expiresAt = 500;
  else game.status = state;
  const response = await fetch(base); expect(response.status).toBe(410);
  expect(await response.text()).not.toContain('solana:');
});
test('unknown links and missing player cannot expose payment data', async () => {
  expect((await fetch(base.replace(payToken, 'cd'.repeat(16)))).status).toBe(404);
  expect((await fetch(base.replace('/creator/', '/challenger/'))).status).toBe(404);
  expect((await fetch(base, { method: 'POST' })).status).toBe(404);
});
test('temporary database failure returns a private generic failure, preserving health route', async () => {
  service.store.get.mockRejectedValue(new Error('private database credentials'));
  const response = await fetch(base); expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('credentials');
  expect((await fetch(base.split('/pay/')[0] + '/health')).status).toBe(200);
});
test('the review build keeps mainnet wagering closed while fee parity remains incomplete', () => {
  expect(() => assertLaunchReady({ SOLANA_CLUSTER: 'mainnet-beta' })).toThrow('MAINNET_FEES_PENDING');
  expect(() => assertLaunchReady({ SOLANA_CLUSTER: 'devnet' })).not.toThrow();
});
