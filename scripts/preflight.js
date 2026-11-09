require('dotenv').config();
const { Client } = require('pg');
const { ethers } = require('ethers');
const { getMode } = require('../src/utils/recoveryMode');

async function inspectDatabase(client) {
  let connected = false;
  try {
    await client.connect(); connected = true;
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const { rows: tables } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = new Set(tables.map(row => row.table_name));
    const result = { status: 'ok', readOnly: true, tables: [...names].sort() };
    if (names.has('CoinFlips')) {
      result.games = (await client.query(
        'SELECT status, COUNT(*)::text AS count FROM "CoinFlips" GROUP BY status ORDER BY status'
      )).rows;
      result.unclaimedCompleted = (await client.query(
        'SELECT COUNT(*)::text AS count FROM "CoinFlips" WHERE status = \'COMPLETED\' AND "claimedByWinner" = false'
      )).rows[0].count;
    }
    if (names.has('PendingRefunds')) result.refunds = (await client.query(
      'SELECT status, COUNT(*)::text AS count FROM "PendingRefunds" GROUP BY status ORDER BY status'
    )).rows;
    if (names.has('ProfitSharePools')) result.feePools = (await client.query(
      'SELECT network, "tokenAddress", "tokenSymbol", "pendingAmount"::text, "lastDistributedAt" FROM "ProfitSharePools"'
    )).rows;
    return result;
  } finally {
    if (connected) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

async function inspectTelegram(token, fetchFn = fetch) {
  const result = {};
  for (const method of ['getMe', 'getWebhookInfo']) {
    // These calls do not send messages, poll updates, or modify the webhook.
    const response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error('Telegram credential or network check failed');
    if (method === 'getMe') result.username = body.result.username;
    else {
      result.webhookConfigured = Boolean(body.result.url);
      result.pendingUpdates = body.result.pending_update_count;
    }
  }
  return { status: 'ok', ...result };
}

async function run(env = process.env) {
  const report = {
    checkedAt: new Date().toISOString(), mode: getMode(env),
    liveReadiness: 'NOT_ESTABLISHED',
    note: 'Read-only diagnostics. This is not a funds reconciliation or approval to resume wagering.',
    database: { status: 'not-configured' },
    telegram: { status: 'not-configured' },
    chain: { status: 'not-configured' },
  };
  if (env.DATABASE_URL || env.DB_HOST) {
    try {
      const options = env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
        host: env.DB_HOST, port: Number(env.DB_PORT || 5432),
        user: env.DB_USER || 'postgres', password: env.DB_PASSWORD,
        database: env.DB_NAME || 'coin_flip_bot',
      };
      report.database = await inspectDatabase(new Client({
        ...options, connectionTimeoutMillis: 10000,
      }));
    } catch (_) { report.database = { status: 'failed', detail: 'Check connectivity, credentials, TLS and existing table layout privately.' }; }
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    try { report.telegram = await inspectTelegram(env.TELEGRAM_BOT_TOKEN); }
    catch (_) { report.telegram = { status: 'failed' }; }
  }
  if (env.EVM_RPC_URL) {
    let provider;
    try {
      const request = new ethers.FetchRequest(env.EVM_RPC_URL);
      request.timeout = 10000;
      provider = new ethers.JsonRpcProvider(request);
      const network = await provider.getNetwork();
      const block = await provider.getBlockNumber();
      const expected = env.EVM_CHAIN_ID ? BigInt(env.EVM_CHAIN_ID) : null;
      report.chain = {
        status: expected === null ? 'expected-chain-required' : expected === network.chainId ? 'ok' : 'wrong-chain',
        chainId: network.chainId.toString(), block,
      };
      const key = env.EVM_BOT_PRIVATE_KEY || env.EVM_PRIVATE_KEY;
      if (key) {
        const address = new ethers.Wallet(key).address;
        report.chain.botWalletMatches = !env.EVM_BOT_WALLET_ADDRESS ||
          ethers.getAddress(env.EVM_BOT_WALLET_ADDRESS) === address;
      }
      if (env.EVM_DEV_PRIVATE_KEY && env.EVM_DEV_WALLET) {
        report.chain.devWalletMatches = new ethers.Wallet(env.EVM_DEV_PRIVATE_KEY).address ===
          ethers.getAddress(env.EVM_DEV_WALLET);
      }
    } catch (_) { report.chain = { status: 'failed', detail: 'Check RPC, chain ID and wallet configuration privately.' }; }
    finally { if (provider) provider.destroy(); }
  }
  return report;
}

if (require.main === module) run().then(report => {
  console.log(JSON.stringify(report, null, 2));
  // An unconfigured preflight must not be mistaken for successful recovery.
  const ok = ['database', 'telegram', 'chain'].every(key => report[key].status === 'ok') &&
    report.chain.botWalletMatches !== false && report.chain.devWalletMatches !== false;
  if (!ok) process.exitCode = 1;
}).catch(() => { console.error('Preflight failed; verify private environment configuration.'); process.exitCode = 1; });

module.exports = { inspectDatabase, inspectTelegram, run };
