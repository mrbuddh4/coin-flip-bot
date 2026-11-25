const { Pool } = require('pg');
const { readFileSync } = require('node:fs');
const { SolanaStore } = require('../src/solana/store');
const { DepositScanner } = require('../src/solana/scanner');
const { RobinhoodScanner } = require('../src/robinhood/scanner');
const { WrongChainRefunds, SCHEMA } = require('../src/solana/wrongChain');
const { TOKEN_2022_PROGRAM_ID } = require('../src/solana/token');
const { SID_MINT } = require('../src/solana/featured');
const { SID } = require('../src/robinhood/chain');

const url = process.env.SOLANA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Wrong-chain SID recovery on disposable PostgreSQL', () => {
  const schemas = ['wrong_sol_' + process.pid, 'wrong_rh_' + process.pid], dbs = [];
  const mints = [SID_MINT, SID], decimals = [6, 18], treasuries = ['sol-treasury', 'rh-treasury'];
  const senders = ['sol-sender', 'rh-sender'], user = '1234';
  const at = Math.floor(Date.now() / 1000) * 1000 - 2000;
  const units = (index, amount = 6900) => BigInt(amount) * 10n ** BigInt(decimals[index]);
  let admin, services, recovery;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Use disposable localhost PostgreSQL');
    admin = new Pool({ connectionString: url });
    for (const schema of schemas) {
      await admin.query('CREATE SCHEMA ' + schema);
      const db = new Pool({ connectionString: url, options: '-c search_path=' + schema });
      dbs.push(db);
      await db.query(readFileSync(require.resolve('../src/solana/schema.sql'), 'utf8').replace('numeric(20,0)', 'numeric(78,0)'));
    }
    services = dbs.map((db, i) => ({ store: new SolanaStore(db), recoverUnmatchedDeposit: async () => false,
      chain: { address: treasuries[i], verifyDeposit: jest.fn(async () => units(i)), explorer: hash => 'https://example.test/' + hash } }));
    for (const s of services) { await s.store.prepareInterface(); await s.store.pool.query(SCHEMA); }
    recovery = services.map((s, i) => {
      const w = new WrongChainRefunds(s, services[1 - i], i ? 'robinhood' : 'solana');
      w.schema = schemas[1 - i]; s.wrongChain = w; return w;
    });
  });
  afterAll(async () => {
    for (const db of dbs) await db.end();
    if (admin) { for (const schema of schemas) await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); }
  });
  beforeEach(async () => {
    for (let i = 0; i < 2; i++) {
      const db = dbs[i];
      await db.query('TRUNCATE "SolGames", "SolDeposits", "SolOutbox", "SolProfiles" CASCADE');
      await db.query('UPDATE "SolWrongChainActivation" SET "activeSince"=$1', [at - 1000]);
      await services[i].store.updateProfile(user, { wallet: senders[i] });
      services[i].chain.verifyDeposit.mockClear();
    }
  });

  const game = (i, id = 'requested', extra = {}) => ({
    id, createdAt: at - 10000, expiresAt: at + 120000, status: 'OPEN', depositAddress: treasuries[i], wager: String(units(i)),
    token: { address: mints[i], decimals: decimals[i], symbol: 'SID' },
    creator: { userId: user, wallet: senders[i], depositExpiresAt: at + 120000 }, ...extra,
  });

  async function scan(i, id) {
    if (i === 0) {
      const tx = { blockTime: at / 1000, transaction: { message: { instructions: [{ programId: TOKEN_2022_PROGRAM_ID,
        parsed: { type: 'transferChecked', info: { mint: mints[i], tokenAmount: { amount: String(units(i)) } } } }] } } };
      await new DepositScanner(services[i]).plainTransfer(senders[i], id, tx);
    } else {
      await new RobinhoodScanner(services[i]).process(senders[i], id, mints[i], units(i), { timestamp: at / 1000 });
    }
  }

  test.each([0, 1])('source %s: scan, return on source, and preserve requested wager on concurrent replay', async i => {
    const target = services[1 - i].store, source = services[i].store;
    const request = await target.create(game(1 - i));
    expect(await recovery[i].requests()).toEqual([{ address: senders[i], replayFrom: request.createdAt, open: true }]);
    await Promise.all([scan(i, 'tx'), scan(i, 'tx')]);
    const payments = await source.pendingPayments();
    expect(payments).toHaveLength(1);
    expect(payments[0].payment).toMatchObject({ id: 'refund:tx', mint: mints[i], amount: String(units(i)),
      recipient: senders[i], sourceWallet: treasuries[i], wrongChain: { userId: user, gameId: request.id } });
    expect(await source.liabilities()).toContainEqual({ mint: mints[i], amount: String(units(i)) });
    expect(await target.get(request.id)).toEqual(request);
    const telegram = { sendMessage: jest.fn().mockResolvedValue({}) };
    await recovery[i].notify(telegram);
    await recovery[i].notify(telegram);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(user, expect.stringContaining(i ? 'send on Solana' : 'send on Robinhood Chain'));
  });

  test('a uniquely matching request can be refunded after expiry, but the player is told to start a new flip', async () => {
    await services[1].store.create(game(1, 'expired', { status: 'CANCELLED', expiresAt: at + 1000,
      creator: { ...game(1).creator, depositExpiresAt: at + 1000, depositWindowClosedAt: at + 1000 } }));
    await scan(0, 'expired-tx');
    const telegram = { sendMessage: jest.fn().mockResolvedValue({}) };
    await recovery[0].notify(telegram);
    expect(telegram.sendMessage).toHaveBeenCalledWith(user, expect.stringContaining('This deposit request is closed.'));
  });

  test('rejects ambiguous requests, shared source wallets, and pre-activation receipts', async () => {
    const source = services[0].store, target = services[1].store;
    await target.create(game(1));
    await source.pool.query('UPDATE "SolWrongChainActivation" SET "activeSince"=$1', [at + 1000]);
    await scan(0, 'historical');
    await source.pool.query('UPDATE "SolWrongChainActivation" SET "activeSince"=$1', [at - 1000]);
    await source.updateProfile('5678', { wallet: senders[0] });
    await scan(0, 'shared');
    await source.updateProfile('5678', { wallet: 'another' });
    await target.create(game(1, 'overlap'));
    await scan(0, 'ambiguous');
    expect(await source.pendingPayments()).toEqual([]);
    expect(services[0].chain.verifyDeposit).not.toHaveBeenCalled();
  });

  test('rejects unrelated amounts and lets a matching local request take precedence', async () => {
    const source = services[0].store;
    await services[1].store.create(game(1));
    expect(await recovery[0].recover({ sender: senders[0], mint: mints[0], signature: 'other', amount: String(units(0, 4000)),
      transaction: { blockTime: at / 1000 } })).toBe(false);
    services[0].deposit = jest.fn();
    await source.create(game(0, 'local'));
    await scan(0, 'local-tx');
    expect(services[0].deposit).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }));
    expect(await source.pendingPayments()).toEqual([]);
  });
});
