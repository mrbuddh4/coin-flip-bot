const http = require('node:http');

async function startHealthServer({ port = process.env.PORT || 3000, host = '0.0.0.0', status, handle } = {}) {
  const server = http.createServer((req, res) => { void (async () => {
    if (handle && await handle(req, res)) return;
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404); res.end(); return;
    }
    const state = status();
    res.writeHead(state.ready ? 200 : 503, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(state));
  })().catch(() => {
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Temporarily unavailable. Try again.');
  }); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  return server;
}

module.exports = { startHealthServer };
