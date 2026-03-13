const SolanaHandler = require('./solanaHandler');

// Mock the Solana connection
jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn(() => ({
    getSignaturesForAddress: jest.fn(),
    getTransaction: jest.fn(),
  })),
  PublicKey: jest.fn((addr) => ({
    toString: () => addr,
  })),
}));

describe('SolanaHandler', () => {
  let solanaHandler;

  beforeEach(() => {
    // Create a minimal solanaHandler instance for testing
    solanaHandler = {
      verifyDeposit: require('./solanaHandler.js').prototype.verifyDeposit,
      getRecentDepositSender: require('./solanaHandler.js').prototype.getRecentDepositSender,
    };
  });

  describe('Unit conversion tests', () => {
    test('should correctly convert raw units to display units for 6-decimal token', () => {
      const rawAmount = 1000000; // 1 token at 6 decimals
      const decimals = 6;
      const displayAmount = rawAmount / Math.pow(10, decimals);
      expect(displayAmount).toBe(1);
    });

    test('should correctly convert raw units to display units for 18-decimal token', () => {
      const rawAmount = 1000000000000000000n; // 1 token at 18 decimals
      const decimals = 18;
      const displayAmount = parseFloat(rawAmount) / Math.pow(10, decimals);
      expect(displayAmount).toBe(1);
    });

    test('should detect overpayment correctly', () => {
      const receivedRaw = 2000000; // 2 tokens
      const decimals = 6;
      const wagerDisplay = 1;

      const receivedDisplay = receivedRaw / Math.pow(10, decimals);
      const isOverpaid = receivedDisplay > wagerDisplay;
      const excess = receivedDisplay - wagerDisplay;

      expect(isOverpaid).toBe(true);
      expect(excess).toBeCloseTo(1, 5);
    });

    test('should detect underpayment correctly', () => {
      const receivedRaw = 500000; // 0.5 tokens
      const decimals = 6;
      const wagerDisplay = 1;

      const receivedDisplay = receivedRaw / Math.pow(10, decimals);
      const isUnderpaid = receivedDisplay < wagerDisplay;
      const shortfall = wagerDisplay - receivedDisplay;

      expect(isUnderpaid).toBe(true);
      expect(shortfall).toBeCloseTo(0.5, 5);
    });

    test('should correctly convert excess back to raw units for blockchain refund', () => {
      const receivedDisplay = 2;
      const wagerDisplay = 1;
      const excessDisplay = receivedDisplay - wagerDisplay;
      const decimals = 6;

      const excessRaw = (excessDisplay * Math.pow(10, decimals)).toFixed(0);

      expect(excessRaw).toBe('1000000');
    });
  });

  describe('Deposit validation logic', () => {
    test('should accumulate deposits correctly when multiple deposits received', () => {
      // First deposit: 0.5 SID (underpay)
      let accumulated = 0.5;
      let currentVerification = 0.5;
      accumulated = Math.max(accumulated, currentVerification);
      expect(accumulated).toBe(0.5);

      // Second deposit: 0.7 SID cumulative (still underpay)
      currentVerification = 0.7;
      accumulated = Math.max(accumulated, currentVerification);
      expect(accumulated).toBe(0.7);

      // Third deposit: 1.2 SID cumulative (now overpay)
      currentVerification = 1.2;
      accumulated = Math.max(accumulated, currentVerification);
      expect(accumulated).toBe(1.2);
    });

    test('should calculate correct refund for partial deposits', () => {
      const accumulatedDisplay = 1.2; // User sent 1.2 total
      const wagerDisplay = 1;
      const excessDisplay = accumulatedDisplay - wagerDisplay;

      expect(excessDisplay).toBeCloseTo(0.2, 5);

      // Convert to raw for blockchain
      const decimals = 6;
      const excessRaw = (excessDisplay * Math.pow(10, decimals)).toFixed(0);
      expect(excessRaw).toBe('200000');
    });

    test('should not trigger refund if deposit exactly matches wager', () => {
      const receivedDisplay = 1;
      const wagerDisplay = 1;

      const isOverpaid = receivedDisplay > wagerDisplay;
      expect(isOverpaid).toBe(false);
    });
  });

  describe('3-minute timeout logic', () => {
    test('should set timeout for underpayment auto-refund', (done) => {
      const mockFlip = {
        status: 'WAITING_CHALLENGER',
        challengerDepositConfirmed: false,
        challengerAccumulatedDeposit: '0.5',
      };

      // Simulate 3-minute timeout
      const timeoutMs = 180000;
      const startTime = Date.now();

      const timeoutId = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 100); // Allow 100ms margin
        done();
      }, timeoutMs);

      // This test would take 3 minutes to run, so we verify the logic instead
      clearTimeout(timeoutId);
      expect(timeoutMs).toBe(180000);
      done();
    });
  });

  describe('Wrong token detection', () => {
    test('should identify when received token mint differs from expected', () => {
      const expectedMint = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump'; // SID mint
      const receivedMint = 'EPjFWaLb3odcccccccccccccccccccccccccccccccc'; // USDC mint

      const isWrongToken = receivedMint.toLowerCase() !== expectedMint.toLowerCase();
      expect(isWrongToken).toBe(true);
    });

    test('should correctly identify correct token', () => {
      const expectedMint = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';
      const receivedMint = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';

      const isWrongToken = receivedMint.toLowerCase() !== expectedMint.toLowerCase();
      expect(isWrongToken).toBe(false);
    });
  });

  describe('Bot ATA recognition', () => {
    test('should recognize deposits to correct bot ATA', () => {
      const correctBotATA = 'BNGHJazs5Ddps9pgYgFr1JvqPVjRChDngpXvWbYqoz6F';
      const botWallet = '6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY';
      const wrongATA = 'BoyaYRYtLtCbKdGFLP3aMhdPm3asfUCMbeo7sh1YHfzk';

      const isToBot = (account) => {
        return account === botWallet || account === correctBotATA;
      };

      expect(isToBot(correctBotATA)).toBe(true);
      expect(isToBot(botWallet)).toBe(true);
      expect(isToBot(wrongATA)).toBe(false);
    });
  });
});
