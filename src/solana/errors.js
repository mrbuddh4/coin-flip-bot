// Only deterministic transaction/layout failures may be advanced past by the
// scanner. RPC/database failures must leave the finalized range replayable.
class DepositValidationError extends Error {}
class UnsupportedTokenError extends DepositValidationError {}
module.exports = { DepositValidationError, UnsupportedTokenError };
