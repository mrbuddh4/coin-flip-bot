const { main, formatFailure } = require('../scripts/deploy-prepare');

describe('phone-friendly Railway pre-deploy initialization', () => {
  const env = { SOLANA_INIT_FRESH: 'true', BOT_CHAIN: 'solana', SOLANA_CLUSTER: 'devnet', DATABASE_URL: 'postgresql://unused/test', SOLANA_RPC_URL: 'https://api.devnet.solana.com' };
  let deps;
  beforeEach(() => { deps = { verifyDevnet: jest.fn().mockResolvedValue(), initialize: jest.fn().mockResolvedValue() }; });
  test('default recovery deployment never touches RPC or database', async () => {
    expect(await main({}, deps)).toEqual({ initialized: false });
    expect(deps.verifyDevnet).not.toHaveBeenCalled(); expect(deps.initialize).not.toHaveBeenCalled();
  });
  test('configuration mistakes cannot initialize a database', async () => {
    for (const change of [{ BOT_CHAIN: 'evm' }, { SOLANA_CLUSTER: 'mainnet-beta' }, { DATABASE_URL: '' }, { SOLANA_RPC_URL: '' }]) {
      await expect(main({ ...env, ...change }, deps)).rejects.toThrow('explicit Solana devnet');
    }
    expect(deps.verifyDevnet).not.toHaveBeenCalled(); expect(deps.initialize).not.toHaveBeenCalled();
  });
  test('wrong-chain or unavailable RPC stops before database access', async () => {
    deps.verifyDevnet.mockRejectedValue(new Error('RPC is not Solana devnet'));
    await expect(main(env, deps)).rejects.toThrow('not Solana devnet');
    expect(deps.initialize).not.toHaveBeenCalled();
  });
  test('verified devnet runs the explicit fresh-only initializer', async () => {
    expect(await main(env, deps)).toEqual({ initialized: true });
    expect(deps.initialize).toHaveBeenCalledWith(env);
    expect(deps.verifyDevnet.mock.invocationCallOrder[0]).toBeLessThan(deps.initialize.mock.invocationCallOrder[0]);
  });
  test('existing database refusal fails deployment instead of resetting it', async () => {
    deps.initialize.mockRejectedValue(new Error('Database is not empty'));
    await expect(main(env, deps)).rejects.toThrow('not empty');
    expect(deps.initialize).toHaveBeenCalledTimes(1);
  });
  test('diagnostics name incorrect settings without showing their values', async () => {
    const secret = 'private-setting-must-never-appear';
    try { await main({ ...env, BOT_CHAIN: secret, SOLANA_CLUSTER: secret }, deps); }
    catch (error) {
      const text = formatFailure(error);
      expect(text).toContain('SETUP_CONFIG');
      expect(text).toContain('BOT_CHAIN, SOLANA_CLUSTER');
      expect(text).not.toContain(secret);
    }
    expect(deps.initialize).not.toHaveBeenCalled();
  });
  test('RPC failures identify the stage without leaking provider errors', async () => {
    const secret = 'https://private:password@rpc.invalid/token';
    deps.verifyDevnet.mockRejectedValue(new Error(secret));
    await main(env, deps).catch(error => {
      expect(formatFailure(error)).toContain('SETUP_RPC_CONNECTION');
      expect(formatFailure(error)).not.toContain(secret);
    });
    expect(deps.initialize).not.toHaveBeenCalled();
  });
  test.each([
    ['ENOTFOUND', 'SETUP_DB_DNS'], ['28P01', 'SETUP_DB_AUTH'],
    ['ECONNREFUSED', 'SETUP_DB_CONNECTION'], ['unknown-secret-code', 'SETUP_DB_INITIALIZATION'],
  ])('database diagnostics classify %s without printing connection details', async (code, category) => {
    const secret = 'postgresql://user:secret@private/db';
    deps.initialize.mockRejectedValue(Object.assign(new Error(secret), { code }));
    await main(env, deps).catch(error => {
      expect(formatFailure(error)).toContain(category);
      expect(formatFailure(error)).not.toContain(secret);
      expect(formatFailure(error)).not.toContain('unknown-secret-code');
    });
  });
  test('existing tables and wrong network have distinct fixed diagnostics', () => {
    expect(formatFailure({ initStage: 'database', message: 'Database is not empty' })).toContain('SETUP_DB_NOT_EMPTY');
    expect(formatFailure({ initStage: 'rpc', message: 'RPC is not Solana devnet' })).toContain('SETUP_RPC_NETWORK');
  });
  // Full public RPC responses, independent of the production constant. The old
  // truncated devnet hash must fail, just like another cluster's genesis.
  test.each([
    ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', true],
    ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1', false],
    ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', false],
    ['4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', false],
  ])('checks actual RPC genesis response %s before initialization', async (genesis, allowed) => {
    const server = require('node:http').createServer(async (request, response) => {
      let body = ''; for await (const part of request) body += part;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: genesis }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const initialize = jest.fn().mockResolvedValue();
    try {
      const result = main({ ...env, SOLANA_RPC_URL: `http://127.0.0.1:${server.address().port}` }, { initialize });
      if (allowed) { await expect(result).resolves.toEqual({ initialized: true }); expect(initialize).toHaveBeenCalledTimes(1); }
      else { await expect(result).rejects.toThrow('not Solana devnet'); expect(initialize).not.toHaveBeenCalled(); }
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

describe('separate empty mainnet database setup never enables funds', () => {
  const env = { SOLANA_INIT_MAINNET_FRESH: 'true', SOLANA_INIT_FRESH: 'false', BOT_CHAIN: 'solana', SOLANA_CLUSTER: 'mainnet-beta', BOT_MODE: 'recovery', LIVE_FUNDS_ENABLED: 'false', DATABASE_URL: 'postgresql://unused/mainnet', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', SOLANA_WALLET_ADDRESS: '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY' };
  test('runs genesis verification before the empty-only initializer', async () => {
    const deps = { verifyMainnet: jest.fn().mockResolvedValue(), initialize: jest.fn().mockResolvedValue() };
    await expect(main(env, deps)).resolves.toEqual({ initialized: true, mainnet: true });
    expect(deps.verifyMainnet.mock.invocationCallOrder[0]).toBeLessThan(deps.initialize.mock.invocationCallOrder[0]);
  });
  test.each([{ BOT_MODE: 'live' }, { LIVE_FUNDS_ENABLED: 'true' }, { SOLANA_CLUSTER: 'devnet' }, { SOLANA_INIT_FRESH: 'true' }])('rejects unsafe initialization settings %s before any RPC or database', async change => {
    const deps = { verifyMainnet: jest.fn(), initialize: jest.fn() };
    await expect(main({ ...env, ...change }, deps)).rejects.toThrow('explicit recovery');
    expect(deps.verifyMainnet).not.toHaveBeenCalled(); expect(deps.initialize).not.toHaveBeenCalled();
  });
  test('wrong mainnet genesis and occupied database cannot be overridden', async () => {
    const initialize = jest.fn();
    await expect(main(env, { verifyMainnet: async () => { throw new Error('wrong network'); }, initialize })).rejects.toThrow('wrong network');
    expect(initialize).not.toHaveBeenCalled();
    await expect(main(env, { verifyMainnet: async () => {}, initialize: async () => { throw new Error('Database is not empty'); } })).rejects.toThrow('not empty');
  });
});
