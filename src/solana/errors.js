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
module.exports = { DepositValidationError, UnsupportedTokenError, ChallengeBusyError, ChallengeTakenError };
