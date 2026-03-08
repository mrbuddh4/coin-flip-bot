# Testing Guide

## Unit Testing

### Setup

```bash
npm install --save-dev jest @testing-library/jest-dom
```

**jest.config.js:**
```javascript
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  collectCoverageFrom: ['src/**/*.js'],
};
```

### Example Tests

**tests/utils/helpers.test.js:**
```javascript
const helpers = require('../../src/utils/helpers');

describe('Helpers', () => {
  describe('performCoinFlip', () => {
    it('should return 0 or 1', () => {
      const result = helpers.performCoinFlip();
      expect([0, 1]).toContain(result);
    });

    it('should be random', () => {
      const results = new Set();
      for (let i = 0; i < 100; i++) {
        results.add(helpers.performCoinFlip());
      }
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe('formatTokenAmount', () => {
    it('should format correctly', () => {
      const result = helpers.formatTokenAmount('1000000000000000000', 18);
      expect(result).toBe('1.000000000000000000');
    });

    it('should handle different decimals', () => {
      const result = helpers.formatTokenAmount('1000000', 6);
      expect(result).toBe('1.000000');
    });
  });

  describe('isValidNumber', () => {
    it('should validate positive numbers', () => {
      expect(helpers.isValidNumber('10')).toBe(true);
      expect(helpers.isValidNumber('10.5')).toBe(true);
    });

    it('should reject invalid numbers', () => {
      expect(helpers.isValidNumber('abc')).toBe(false);
      expect(helpers.isValidNumber('-5')).toBe(false);
      expect(helpers.isValidNumber('0')).toBe(false);
    });
  });
});
```

**tests/blockchain/evmHandler.test.js:**
```javascript
const EVMHandler = require('../../src/blockchain/evmHandler');
const { ethers } = require('ethers');

describe('EVMHandler', () => {
  let handler;

  beforeAll(() => {
    handler = new EVMHandler();
  });

  describe('generateWallet', () => {
    it('should generate valid wallet', async () => {
      const wallet = await handler.generateWallet();
      
      expect(wallet).toHaveProperty('address');
      expect(wallet).toHaveProperty('privateKey');
      expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('isValidAddress', () => {
    it('should validate EVM addresses', () => {
      const validAddr = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      expect(handler.isValidAddress(validAddr)).toBe(true);
      
      expect(handler.isValidAddress('invalid')).toBe(false);
    });
  });
});
```

## Integration Testing

### Test Scenarios

1. **Flip Creation Flow**
   - User initiates flip
   - Bot generates wallet
   - Validates deposit
   - Confirms in group

2. **Dual Deposit Flow**
   - Creator deposits
   - Challenger accepts and deposits
   - Both confirm
   - Execution proceeds

3. **Payout Flow**
   - Coin flip executed
   - Winner selected
   - Winner confirms address
   - Tokens transferred

### Manual Testing Checklist

```
Setup Phase:
- [ ] Bot responds to /start in group
- [ ] Bot shows token selection buttons
- [ ] Bot DMs user when button clicked
- [ ] Bot asks for wager amount

Wager Phase:
- [ ] Valid amounts accepted
- [ ] Invalid amounts rejected
- [ ] Wallet address generated
- [ ] Wallet address shown correctly

Deposit Phase:
- [ ] Deposit timeout works (180 sec)
- [ ] Confirmed message works
- [ ] Deposit verification works
- [ ] Failed deposits handled

Challenge Phase:
- [ ] Accept button works
- [ ] Challenger gets DM
- [ ] Challenger sees wallet address
- [ ] Challenger can confirm

Execution Phase:
- [ ] Both deposits confirmed
- [ ] Coin flip executes
- [ ] Winner announced in group
- [ ] Claim button appears

Payout Phase:
- [ ] Winner can claim
- [ ] Address validation works
- [ ] Payout executes
- [ ] Winner receives tokens

Edge Cases:
- [ ] Cancel before challenger
- [ ] Timeout not responding
- [ ] Invalid wallet address
- [ ] Network errors
- [ ] Double-spending attempts
```

## Performance Testing

### Load Testing

```bash
npm install -g artillery
```

**load-test.yml:**
```yaml
config:
  target: "https://api.telegram.org"
  phases:
    - duration: 60
      arrivalRate: 10

scenarios:
  - name: "Message Sends"
    flow:
      - post:
          url: "/bot{{ $env.TOKEN }}/sendMessage"
          json:
            chat_id: "{{ $env.TEST_CHAT_ID }}"
            text: "Test message"
```

Run:
```bash
artillery run load-test.yml
```

## Database Testing

### Test Database Setup

```javascript
// tests/setup.js
const { initDB } = require('../src/database');

beforeAll(async () => {
  // Use test database
  process.env.DATABASE_URL = ':memory:';
  await initDB();
});

afterAll(async () => {
  const { getDB } = require('../src/database');
  const { sequelize } = getDB();
  await sequelize.close();
});
```

### Test Data Fixtures

```javascript
// tests/fixtures.js
const { getDB } = require('../src/database');

async function createTestUser(data = {}) {
  const { models } = getDB();
  return await models.User.create({
    telegramId: 123456,
    firstName: 'Test',
    ...data,
  });
}

async function createTestFlip(data = {}) {
  const { models } = getDB();
  const creator = await createTestUser();
  
  return await models.CoinFlip.create({
    groupChatId: -100123456,
    creatorId: creator.telegramId,
    wagerAmount: '10',
    tokenNetwork: 'EVM',
    tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    ...data,
  });
}

module.exports = { createTestUser, createTestFlip };
```

## E2E Testing

### Telegram Bot Testing

```javascript
// tests/e2e/bot.test.js
const TelegramBot = require('node-telegram-bot-api');

describe('E2E: Bot Flow', () => {
  let bot;
  const testGroupId = process.env.TEST_GROUP_ID;

  beforeAll(() => {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  });

  it('should respond to /start', async () => {
    const result = await bot.sendMessage(testGroupId, '/start');
    expect(result.ok).toBe(true);
  });

  it('should handle inline buttons', async () => {
    // Simulate button click
    const result = await bot.answerCallbackQuery('callback_id', {
      text: 'Processing',
    });
    expect(result).toBe(true);
  });
});
```

## Testing Checklist

```
✅ Unit Tests
  - Helper functions
  - Blockchain handlers
  - Database queries
  - Validation logic

✅ Integration Tests
  - Database transactions
  - Blockchain interactions
  - Session management
  
✅ E2E Tests
  - User registration
  - Flip creation
  - Deposit handling
  - Payout execution

✅ Performance Tests
  - Load handling (10+ concurrent users)
  - Response time (< 1 second)
  - Memory usage

✅ Security Tests
  - Private key encryption
  - Parameter validation
  - SQL injection protection
  - Authorization checks
```

## Continuous Integration

### GitHub Actions

**.github/workflows/test.yml:**
```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      sqlite:
        image: keinos/sqlite3
    
    steps:
      - uses: actions/checkout@v2
      
      - name: Use Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'
      
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

## Debug Logging

### Enable Debug Logging

```bash
LOG_LEVEL=debug npm start
```

### Debug Specific Components

```javascript
// In code
const logger = require('./src/utils/logger');

logger.debug('Flipping coin', { userId, amount });
logger.debug('Deposit verified', { wallet, balance });
```

## Monitoring

### Error Tracking with Sentry

```javascript
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});

bot.catch((err, ctx) => {
  Sentry.captureException(err);
  logger.error('Bot error', err);
});
```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Tests timeout | Increase timeout: `jest.setTimeout(10000)` |
| Database locked | Use in-memory DB for tests |
| Missing env vars | Load from .env.test |
| Network errors | Mock HTTP calls with Jest mocks |
| Flaky tests | Add retry logic, use proper waits |

---

**Run all tests:**
```bash
npm test
```

**Run with coverage:**
```bash
npm test -- --coverage
```

**Watch mode:**
```bash
npm test -- --watch
```
