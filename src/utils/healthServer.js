const http = require('node:http');

async function startHealthServer({ port = process.env.PORT || 3000, host = '0.0.0.0', status } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404); res.end(); return;
    }
    const state = status();
    res.writeHead(state.ready ? 200 : 503, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(state));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  return server;
}

module.exports = { startHealthServer };
