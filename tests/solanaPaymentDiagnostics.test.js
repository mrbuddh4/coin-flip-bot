const { paymentFailure, UnsupportedTokenError } = require('../src/solana/errors');
test.each([
  [new Error('429 Too Many Requests https://rpc.example/private-key'), 'RPC_RATE_LIMIT'],
  [Object.assign(new Error('throttled'), { code: 429 }), 'RPC_RATE_LIMIT'],
  [new Error('fetch timed out with private endpoint'), 'RPC_TIMEOUT'],
  [new Error('Treasury does not cover all liabilities plus the SOL reserve'), 'TREASURY_SOL_SHORTFALL'],
  [new Error('Token treasury does not cover all recorded liabilities'), 'TREASURY_TOKEN_SHORTFALL'],
  [new Error('Fund the bot fee reserve; full payout retained as pending'), 'FEE_RESERVE_SHORTFALL'],
  [new Error('Funds disabled. Recovery mode does not accept wagers or send transactions.'), 'FUNDS_DISABLED'],
  [new Error('RPC does not match configured Solana Mainnet; no transactions allowed'), 'RPC_NETWORK_MISMATCH'],
  [new UnsupportedTokenError('private details'), 'UNSUPPORTED_TOKEN'],
  [new Error('unexpected failure https://rpc.example/private-key'), 'PAYMENT_CHECK_FAILED'],
])('payment diagnostic returns only allowlisted text for %s', (error, code) => {
  const result = paymentFailure(error);
  expect(result.code).toBe(code);
  expect(result.reason).toBeTruthy();
  expect(JSON.stringify(result)).not.toMatch(/private-key|rpc\.example|private details/);
});
