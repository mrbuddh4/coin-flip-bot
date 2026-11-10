const { timingSafeEqual } = require('node:crypto');
const { escape, paymentURI, networkName } = require('./interface');
const { fromUnits } = require('./amounts');
function paymentHandler(service) {
  return async (req, res) => {
    if (!req.url.startsWith('/pay/')) return false;
    const match = /^\/pay\/([0-9a-f-]{36})\/(creator|challenger)\/([0-9a-f]{32})$/.exec(req.url);
    const headers = {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const finish = (status, content) => { res.writeHead(status, headers); res.end(content); return true; };
    if (req.method !== 'GET' || !match) return finish(404, 'Payment link unavailable.');
    let game;
    try { game = await service.store.get(match[1]); }
    catch (error) { if (error.message === 'Unknown Solana game') return finish(404, 'Payment link unavailable.'); throw error; }
    const player = game[match[2]];
    if (!player?.payToken || player.payToken.length !== 32 || !timingSafeEqual(Buffer.from(player.payToken), Buffer.from(match[3]))) return finish(404, 'Payment link unavailable.');
    if (game.status !== 'OPEN' || player.deposit || service.now() >= game.expiresAt) return finish(410, 'This deposit request has closed or is already funded. Return to the bot for game status.');
    const amount = fromUnits(game.wager, game.token.decimals), uri = paymentURI(game, player);
    return finish(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coin Flip deposit</title>
<style>body{font:17px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem;background:#101722;color:#eef2fa}code,textarea{overflow-wrap:anywhere}textarea{width:100%;box-sizing:border-box;font-size:14px}a{display:block;background:#b4f5cf;color:#10241a;padding:1rem;border-radius:12px;text-align:center;text-decoration:none}small{color:#bac7da}</style>
<h1>Coin Flip deposit</h1><p><b>${escape(networkName(service.chain))}</b></p>
<p>Send exactly <b>${escape(amount)} ${escape(game.token.symbol)}</b> from your registered wallet:</p><p><code>${escape(player.wallet)}</code></p>
<p>Recipient:</p><p><code>${escape(game.depositAddress)}</code></p><p>Mint:</p><p><code>${escape(game.token.address)}</code></p>
<p>Game memo:</p><p><code>${escape(player.memo)}</code></p>
<p><a href="${escape(uri)}">Open in a Solana Pay compatible wallet</a></p>
<p>Check your wallet's network, amount, recipient and memo before sending. A plain transfer can be matched only when its sender, exact asset, exact amount and on-chain time identify one request. Include the memo when requests overlap. This link cannot authorize a transfer.</p>
<p>Payment request (press and hold to copy):</p><textarea readonly rows="6">${escape(uri)}</textarea>
<p><small>Return to Telegram after sending. Tap Confirm Deposit in Telegram. The bot waits for finalized confirmation before posting your funded challenge. A closed request cannot stop a transfer you already authorized in your wallet.</small></p></html>`);
  };
}
module.exports = { paymentHandler };
