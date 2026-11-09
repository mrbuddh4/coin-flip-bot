const model = {
  name: 'CoinFlip', getTableName: () => 'CoinFlips',
  rawAttributes: { id: { field: 'id' }, status: { field: 'status' } },
  belongsTo: jest.fn(),
};
const fakeDB = {
  authenticate: jest.fn().mockResolvedValue(), sync: jest.fn().mockResolvedValue(),
  close: jest.fn().mockResolvedValue(),
  getQueryInterface: () => ({ describeTable: jest.fn(async () => ({ id: {}, status: {} })) }),
};
jest.mock('sequelize', () => ({ Sequelize: jest.fn() }));
jest.mock('../src/database/connection', () => ({ createSequelize: jest.fn() }));
jest.mock('../src/database/models', () => jest.fn());

const { createSequelize } = require('../src/database/connection');
const defineModels = require('../src/database/models');
const { initDB, getDB } = require('../src/database');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DB_SCHEMA_MODE;
  createSequelize.mockReturnValue(fakeDB);
  defineModels.mockReturnValue({ CoinFlip: model, User: model, Transaction: model, BotSession: model });
});
afterEach(() => delete process.env.DB_SCHEMA_MODE);

test('default startup checks the existing tables without a schema sync', async () => {
  await initDB();
  expect(fakeDB.authenticate).toHaveBeenCalled();
  expect(fakeDB.sync).not.toHaveBeenCalled();
  expect(getDB().sequelize).toBe(fakeDB);
});
test('missing columns stop startup and close the database', async () => {
  defineModels.mockReturnValue({ CoinFlip: { ...model, rawAttributes: { unknown: { field: 'unknown' } } }, User: model, Transaction: model, BotSession: model });
  await expect(initDB()).rejects.toThrow('missing columns unknown');
  expect(fakeDB.close).toHaveBeenCalled();
  expect(() => getDB()).toThrow('not initialized');
});
test('schema alteration requires an explicit setting', async () => {
  process.env.DB_SCHEMA_MODE = 'alter';
  await initDB();
  expect(fakeDB.sync).toHaveBeenCalledWith({ alter: true });
});
test('invalid schema mode cannot mutate the schema', async () => {
  process.env.DB_SCHEMA_MODE = 'aletr';
  await expect(initDB()).rejects.toThrow('DB_SCHEMA_MODE');
  expect(fakeDB.sync).not.toHaveBeenCalled();
});
