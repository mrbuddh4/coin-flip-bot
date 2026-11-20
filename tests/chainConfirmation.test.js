jest.mock('../src/config', () => ({ evm: { rpcUrl: 'http://127.0.0.1:1' }, database: {} }));
const EVMHandler = require('../src/blockchain/evmHandler');
const { BlockchainManager } = require('../src/blockchain/manager');

describe('on-chain confirmation', () => {
  test('inclusion block counts as the first confirmation', async () => {
    const handler = Object.create(EVMHandler.prototype);
    handler.provider = {
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 12 }),
      getBlockNumber: async () => 12,
    };
    expect(await handler.checkTransactionStatus('test')).toMatchObject({ status: 'confirmed', confirmations: 1 });
  });
  test('a reverted transaction cannot confirm a deposit regardless of depth', async () => {
    const manager = Object.create(BlockchainManager.prototype);
    manager.evmHandler = { checkTransactionStatus: async () => ({ status: 'failed', confirmations: 100 }) };
    expect(await manager.checkTransactionConfirmation('EVM', 'test')).toMatchObject({ confirmed: false, status: 'failed' });
  });
  test('a successful transaction must meet the requested depth', async () => {
    const manager = Object.create(BlockchainManager.prototype);
    manager.evmHandler = { checkTransactionStatus: async () => ({ status: 'confirmed', confirmations: 1 }) };
    expect((await manager.checkTransactionConfirmation('EVM', 'test', 2)).confirmed).toBe(false);
    expect((await manager.checkTransactionConfirmation('EVM', 'test', 1)).confirmed).toBe(true);
  });
  test('direct transfer methods fail before using a provider in recovery mode', async () => {
    const previous = process.env.BOT_MODE;
    process.env.BOT_MODE = 'recovery';
    try {
      const handler = Object.create(EVMHandler.prototype);
      await expect(handler.transferNative('dummy', 'dummy', '1')).rejects.toThrow('Funds disabled');
      await expect(handler.transferToken('dummy', 'dummy', 'dummy', '1', 18)).rejects.toThrow('Funds disabled');
    } finally {
      if (previous === undefined) delete process.env.BOT_MODE; else process.env.BOT_MODE = previous;
    }
  });
});
