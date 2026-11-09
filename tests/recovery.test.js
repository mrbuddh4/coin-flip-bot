const { EventEmitter } = require('node:events');
const { createSequelize, connectionOptions } = require('../src/database/connection');
const { getMode, assertLiveFunds } = require('../src/utils/recoveryMode');
const { startHealthServer } = require('../src/utils/healthServer');
const { acquireInstanceLock } = require('../src/utils/instanceLock');
const { inspectDatabase, inspectTelegram, run } = require('../scripts/preflight');

describe('database configuration', () => {
  test('DATABASE_URL takes priority over localhost defaults', () => {
    const Constructor = jest.fn();
    const db = { url: 'postgres://test:fake@host/db', host: 'localhost', logging: false };
    createSequelize(Constructor, db);
    expect(Constructor.mock.calls[0][0]).toBe(db.url);
    expect(Constructor.mock.calls[0][1].host).toBeUndefined();
    expect(connectionOptions(db)).toEqual({ connectionString: db.url });
  });
  test('individual PostgreSQL fields remain supported', () => {
    const Constructor = jest.fn();
    const db = { host: 'db', port: 5432, username: 'tester', password: 'fake', database: 'game' };
    createSequelize(Constructor, db);
    expect(Constructor.mock.calls[0][0]).toMatchObject({ host: 'db', username: 'tester', database: 'game' });
    expect(connectionOptions(db)).toMatchObject({ host: 'db', user: 'tester' });
  });
});

describe('funds gates', () => {
  test('defaults to recovery', () => expect(getMode({})).toBe('recovery'));
  test.each([{}, { BOT_MODE: 'recovery', LIVE_FUNDS_ENABLED: 'true' }, { BOT_MODE: 'live' },
    { BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'false' }])('refuses payments for %j', env => {
    expect(() => assertLiveFunds(env)).toThrow('Funds disabled');
  });
  test('requires both explicit live settings', () => {
    expect(() => assertLiveFunds({ BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true' })).not.toThrow();
  });
  test('rejects misspelled modes', () => expect(() => getMode({ BOT_MODE: 'liv' })).toThrow());
});

describe('HTTP health', () => {
  let server;
  afterEach(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
  test('uses readiness status and exposes only the supplied state', async () => {
    let ready = false;
    server = await startHealthServer({ port: 0, host: '127.0.0.1', status: () => ({ ready, mode: 'recovery' }) });
    const url = `http://127.0.0.1:${server.address().port}`;
    expect((await fetch(url + '/health')).status).toBe(503);
    ready = true;
    const response = await fetch(url + '/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, mode: 'recovery' });
    expect((await fetch(url + '/other')).status).toBe(404);
    expect((await fetch(url + '/health', { method: 'POST' })).status).toBe(404);
  });
});

function lockClient(acquired = true) {
  const client = new EventEmitter();
  client.connect = jest.fn().mockResolvedValue();
  client.query = jest.fn().mockResolvedValue({ rows: [{ acquired }] });
  client.end = jest.fn(async () => { client.emit('end'); });
  return client;
}

describe('single instance ownership', () => {
  test('holds the dedicated session until explicit release', async () => {
    const client = lockClient(); const onLost = jest.fn();
    const release = await acquireInstanceLock({ client, onLost });
    expect(client.end).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS acquired', [42424242]);
    await release();
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });
  test('another owner prevents startup and closes the rejected session', async () => {
    const client = lockClient(false);
    await expect(acquireInstanceLock({ client, onLost: jest.fn() })).rejects.toThrow('Another bot');
    expect(client.end).toHaveBeenCalledTimes(1);
  });
  test('losing the owning session invokes the fatal handler', async () => {
    const client = lockClient(); const onLost = jest.fn();
    const release = await acquireInstanceLock({ client, onLost });
    client.emit('end');
    expect(onLost).toHaveBeenCalled();
    await release();
  });
});

describe('read-only diagnostics', () => {
  test('opens a read-only snapshot, reads aggregates, and never initializes models', async () => {
    const queries = [];
    const client = { connect: jest.fn(), end: jest.fn().mockResolvedValue(), query: jest.fn(async sql => {
      queries.push(sql);
      if (sql.includes('information_schema')) return { rows: [{ table_name: 'CoinFlips' }] };
      if (sql.includes('GROUP BY')) return { rows: [{ status: 'COMPLETED', count: '2' }] };
      if (sql.includes('claimedByWinner')) return { rows: [{ count: '1' }] };
      return { rows: [] };
    }) };
    expect(await inspectDatabase(client)).toMatchObject({ readOnly: true, unclaimedCompleted: '1' });
    expect(queries[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries.every(sql => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)/.test(sql))).toBe(true);
    expect(client.end).toHaveBeenCalled();
  });
  test('closes the connection and rolls back if a schema query fails', async () => {
    const client = { connect: jest.fn(), end: jest.fn().mockResolvedValue(), query: jest.fn(async sql => {
      if (sql.includes('information_schema')) throw new Error('missing access');
      return { rows: [] };
    }) };
    await expect(inspectDatabase(client)).rejects.toThrow('missing access');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.end).toHaveBeenCalled();
  });
  test('Telegram checks do not poll, send, or modify webhooks, and redact webhook URL', async () => {
    const fetchFn = jest.fn(async url => ({ ok: true, json: async () => ({ ok: true,
      result: url.endsWith('getMe') ? { username: 'TestBot' } : { url: 'https://private.example/secret', pending_update_count: 2 },
    }) }));
    const result = await inspectTelegram('dummy-token', fetchFn);
    expect(result).toEqual({ status: 'ok', username: 'TestBot', webhookConfigured: true, pendingUpdates: 2 });
    expect(fetchFn.mock.calls.map(([url]) => url.split('/').pop())).toEqual(['getMe', 'getWebhookInfo']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  test('no credentials means no connectivity claims', async () => {
    const report = await run({});
    expect(report.liveReadiness).toBe('NOT_ESTABLISHED');
    for (const key of ['database', 'telegram', 'chain']) expect(report[key].status).toBe('not-configured');
  });
});
