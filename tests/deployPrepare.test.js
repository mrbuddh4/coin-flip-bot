const { main } = require('../scripts/deploy-prepare');

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
  test.each([['EtWTRABZaYq6iMfeYKouRu166VU2xqa1', true], ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', false]])('checks actual RPC genesis response %s before initialization', async (genesis, allowed) => {
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
