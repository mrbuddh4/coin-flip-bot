// Financial settlement is durable immediately; Telegram reveals it only after the flip presentation.
function resultVisible(game) { return !game.interfaceVersion || Boolean(game.ui?.resultAnnounced || game.ui?.terminal); }
module.exports = { resultVisible };
