// Only deterministic transaction/layout failures may be advanced past by the
// scanner. RPC/database failures must leave the finalized range replayable.
class DepositValidationError extends Error {}
class UnsupportedTokenError extends DepositValidationError {}
class ChallengeBusyError extends Error {
  constructor() { super('This group already has an active challenge. Finish the current flip before starting another.'); }
}
class ChallengeTakenError extends Error {
  constructor() { super('Someone has already accepted this challenge. Only that player can deposit for it.'); }
}
// Only allowlisted explanations may reach logs or user-facing status. RPC
// errors can contain credential-bearing URLs, so never copy their raw text.
function paymentFailure(error) {
  const text = String(error?.message || '');
  if (Number(error?.code) === 429 || /429|too many requests|rate.?limit/i.test(text)) return { code: 'RPC_RATE_LIMIT', reason: 'RPC provider throttled requests; automatic retry is delayed.' };
  if (/timeout|timed out|abort/i.test(text)) return { code: 'RPC_TIMEOUT', reason: 'RPC request timed out; payment remains queued.' };
  if (/Treasury does not cover all liabilities plus the SOL reserve/.test(text)) return { code: 'TREASURY_SOL_SHORTFALL', reason: 'Treasury SOL is below recorded obligations plus the 0.01 SOL reserve.' };
  if (/Token treasury does not cover all recorded liabilities/.test(text)) return { code: 'TREASURY_TOKEN_SHORTFALL', reason: 'A treasury token balance is below its recorded obligations.' };
  if (/Fund the bot fee reserve/.test(text)) return { code: 'FEE_RESERVE_SHORTFALL', reason: 'Treasury SOL cannot cover this payment, fees and the reserve.' };
  if (/Funds disabled/.test(text)) return { code: 'FUNDS_DISABLED', reason: 'Live fund transfers are disabled in hosting configuration.' };
  if (/RPC does not match configured/.test(text)) return { code: 'RPC_NETWORK_MISMATCH', reason: 'RPC network differs from the configured network.' };
  if (/signing and deposit wallet mismatch/.test(text)) return { code: 'SIGNER_MISMATCH', reason: 'Configured signing wallet differs from the deposit wallet.' };
  if (error instanceof UnsupportedTokenError) return { code: 'UNSUPPORTED_TOKEN', reason: 'Token configuration requires review before payment.' };
  if (/^[0-9A-Z]{5}$/.test(String(error?.code || ''))) return { code: `DATABASE_${error.code}`, reason: 'Database operation failed; saved payment records are retained.' };
  return { code: 'PAYMENT_CHECK_FAILED', reason: 'Payment preparation or RPC check failed; private hosting logs need review.' };
}
module.exports = { DepositValidationError, UnsupportedTokenError, ChallengeBusyError, ChallengeTakenError, paymentFailure };
