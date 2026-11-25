const { randomBytes } = require('node:crypto');
const { escape } = require('./interface');
function holderHandler(fees) {
  return async (req, res) => {
    if (!req.url.startsWith('/holder/')) return false;
    const match = /^\/holder\/([0-9a-f]{32})$/.exec(req.url);
    const nonce = randomBytes(16).toString('hex');
    const finish = (status, content, json = false) => {
      res.writeHead(status, {
        'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      }); res.end(json ? JSON.stringify(content) : content); return true;
    };
    if (!match || !['GET', 'POST'].includes(req.method)) return finish(404, 'Registration link unavailable.');
    const c = await fees.getChallenge(match[1]);
    if (!c) return finish(410, 'This link expired or has already been used. Open Profit Share in Telegram for a new link.');
    if (req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return finish(415, { error: 'JSON required' }, true);
      let body = '';
      for await (const chunk of req) { body += chunk.toString(); if (body.length > 2048) return finish(413, { error: 'Request too large' }, true); }
      try {
        const input = JSON.parse(body);
        await fees.verify(c.id, input.signature);
        return finish(200, { ok: true }, true);
      } catch (_) { return finish(400, { error: 'Signature invalid, address already linked, or request expired. Return to Telegram to try again.' }, true); }
    }
    const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
    return finish(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLIP holder rewards</title>
<style>body{font:17px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem;background:#101722;color:#eef2fa}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;padding:1rem;border-radius:10px}textarea{width:100%;box-sizing:border-box}</style>
<h1>Link FLIP holder rewards</h1><p>Open this page in the browser inside your EVM wallet app. Use the Paxeer wallet holding your FLIP. Signing registers this exact Solana reward address, with no transaction, spending approval or network fee.</p>
<pre>${escape(c.message)}</pre><button id="sign">Connect wallet and sign</button>
<p>Or sign the exact message above elsewhere and paste the signature:</p><textarea id="signature" rows="4" maxlength="132"></textarea><button id="submit">Verify signature</button><p id="status" role="status"></p>
<script nonce="${nonce}">
const evm=${json(c.evm)}, message=${json(c.message)}, status=document.getElementById('status');
async function submit(signature){const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signature})});const result=await r.json();if(!result.ok)throw Error(result.error);status.textContent='Verified. Return to Telegram and open Profit Share. Your registered reward destination stays fixed until you sign a new link.';document.getElementById('sign').disabled=true;document.getElementById('submit').disabled=true;}
document.getElementById('sign').onclick=async()=>{try{if(!window.ethereum)throw Error('Open this link in the browser inside your EVM wallet app, or use the pasted-signature option.');const accounts=await window.ethereum.request({method:'eth_requestAccounts'});if(!accounts[0]||accounts[0].toLowerCase()!==evm)throw Error('Switch to the holding wallet shown above.');const hex='0x'+Array.from(new TextEncoder().encode(message),x=>x.toString(16).padStart(2,'0')).join('');const signature=await window.ethereum.request({method:'personal_sign',params:[hex,evm]});await submit(signature);}catch(e){status.textContent=e.message||'Registration failed. Try again from Telegram.';}};
document.getElementById('submit').onclick=async()=>{try{await submit(document.getElementById('signature').value.trim());}catch(e){status.textContent=e.message||'Verification failed.';}};
</script></html>`);
  };
}
module.exports = { holderHandler };
