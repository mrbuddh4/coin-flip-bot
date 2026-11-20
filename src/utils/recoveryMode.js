function getMode(env = process.env) {
  const mode = env.BOT_MODE || 'recovery';
  if (!['recovery', 'live'].includes(mode)) throw new Error('BOT_MODE must be recovery or live');
  return mode;
}

function assertLiveFunds(env = process.env) {
  if (getMode(env) !== 'live' || env.LIVE_FUNDS_ENABLED !== 'true') {
    throw new Error('Funds disabled. Recovery mode does not accept wagers or send transactions.');
  }
}

module.exports = { getMode, assertLiveFunds };
