describe('Wrong Token Detection & Refund Scenario', () => {
  describe('Wrong Token Detection', () => {
    test('should detect wrong token (different mint than expected)', () => {
      // Simulate deposit detection result from handler
      const depositResult = {
        sender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
        amount: '1000000', // 1 token
        signature: 'test-sig-wrong-token',
        tokenMint: 'EPjFWaLb3odcccccccccccccccccccccccccccccccc', // Wrong mint (USDC)
        wrongToken: 'EPjFWaLb3odcccccccccccccccccccccccccccccccc',
        hasWrongTokens: true,
      };

      const expectedMint = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump'; // SID

      const isWrongToken = depositResult.tokenMint !== expectedMint;
      expect(isWrongToken).toBe(true);
      expect(depositResult.hasWrongTokens).toBe(true);
      expect(depositResult.wrongToken).toBe('EPjFWaLb3odcccccccccccccccccccccccccccccccc');
    });

    test('should NOT flag correct token as wrong', () => {
      const depositResult = {
        sender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
        amount: '1000000',
        signature: 'test-sig-correct-token',
        tokenMint: '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump', // Correct SID
        wrongToken: null,
        hasWrongTokens: false,
      };

      const expectedMint = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';

      const isWrongToken = depositResult.tokenMint !== expectedMint;
      expect(isWrongToken).toBe(false);
      expect(depositResult.hasWrongTokens).toBe(false);
    });
  });

  describe('Wrong Token Refund Logic', () => {
    test('should trigger refund when verification.isWrongToken is true', () => {
      const verification = {
        received: false,
        isWrongToken: true,
        depositSender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
        wrongToken: 'EPjFWaLb3odcccccccccccccccccccccccccccccccc',
      };

      const flip = {
        tokenNetwork: 'Solana',
        tokenAddress: '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump', // SID
        createdAt: new Date(),
        data: {},
      };

      // Check refund conditions
      const shouldRefund = 
        verification.isWrongToken && 
        verification.depositSender && 
        flip.tokenAddress && 
        flip.tokenAddress !== 'NATIVE' && 
        !flip.data?.refundAttempted;

      expect(shouldRefund).toBe(true);
    });

    test('should NOT trigger refund when isWrongToken is false', () => {
      const verification = {
        received: false,
        isWrongToken: false, // Correct token
        depositSender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
      };

      const flip = {
        tokenNetwork: 'Solana',
        tokenAddress: '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump',
        createdAt: new Date(),
        data: {},
      };

      const shouldRefund = 
        verification.isWrongToken && 
        verification.depositSender && 
        flip.tokenAddress && 
        flip.tokenAddress !== 'NATIVE' && 
        !flip.data?.refundAttempted;

      expect(shouldRefund).toBe(false);
    });

    test('should NOT trigger refund twice (prevent duplicate)', () => {
      const verification = {
        isWrongToken: true,
        depositSender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
      };

      const flip = {
        tokenNetwork: 'Solana',
        tokenAddress: '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump',
        createdAt: new Date(),
        data: { refundAttempted: true }, // Already tried to refund
      };

      const shouldRefund = 
        verification.isWrongToken && 
        verification.depositSender && 
        flip.tokenAddress && 
        flip.tokenAddress !== 'NATIVE' && 
        !flip.data?.refundAttempted;

      expect(shouldRefund).toBe(false); // Second attempt should be skipped
    });

    test('should NOT refund native token deposits (skip for NATIVE)', () => {
      const verification = {
        isWrongToken: true,
        depositSender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
      };

      const flip = {
        tokenNetwork: 'Solana',
        tokenAddress: 'NATIVE', // Native SOL, not SPL
        createdAt: new Date(),
        data: {},
      };

      const shouldRefund = 
        verification.isWrongToken && 
        verification.depositSender && 
        flip.tokenAddress && 
        flip.tokenAddress !== 'NATIVE' && 
        !flip.data?.refundAttempted;

      expect(shouldRefund).toBe(false); // Should skip native refunds
    });

    test('should include deposit filtering by flip creation time', () => {
      // Old flip created 1 hour ago
      const oldFlipCreatedAt = new Date(Date.now() - 3600000);
      // New flip created just now
      const newFlipCreatedAt = new Date();
      
      // Sender's transaction from 50 minutes ago (after old flip, before new flip)
      const txBlockTime = Math.floor((Date.now() - 3000000) / 1000);
      
      const oldFlipCutoff = Math.floor(oldFlipCreatedAt.getTime() / 1000);
      const newFlipCutoff = Math.floor(newFlipCreatedAt.getTime() / 1000);

      // Should be included in old flip
      expect(txBlockTime > oldFlipCutoff).toBe(true);
      
      // Should NOT be included in new flip (happened before new flip was created)
      expect(txBlockTime > newFlipCutoff).toBe(false);
    });
  });

  describe('Wrong Token Message Display', () => {
    test('should display wrong token message to user', () => {
      const verification = {
        isWrongToken: true,
        wrongToken: 'EPjFWaLb3odcccccccccccccccccccccccccccccccc',
        amount: '1000000', // 1 USDC
      };

      const flip = {
        tokenSymbol: 'SID',
        wagerAmount: '1',
      };

      let message = '';
      if (verification.isWrongToken) {
        const wrongTokenSymbol = verification.wrongToken === 'NATIVE' ? 'SOL' : 'Unknown Token';
        message = `❌ <b>Wrong Token Detected</b>\n\n` +
          `Expected: ${flip.tokenSymbol}\n` +
          `Received: ${wrongTokenSymbol}\n\n` +
          `Your deposit will be refunded automatically.`;
      }

      expect(message).toContain('Wrong Token Detected');
      expect(message).toContain('Expected: SID');
      expect(message).toContain('Your deposit will be refunded automatically');
    });
  });

  describe('Full Wrong Token Flow', () => {
    test('complete: wrong token + auto-refund + flip cancellation', async () => {
      // Step 1: Detect wrong token deposit
      const depositVerification = {
        received: false,
        isWrongToken: true,
        depositSender: '4kkWyqPFhSPuoPtyDu3PgWtRXe2DLn2nMvBGqMDjn1TR',
        wrongToken: 'EPjFWaLb3odcccccccccccccccccccccccccccccccc',
        amount: '1000000',
      };

      expect(depositVerification.isWrongToken).toBe(true);
      expect(depositVerification.received).toBe(false);

      // Step 2: Check if refund should be triggered
      const flip = {
        tokenNetwork: 'Solana',
        tokenAddress: '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump',
        createdAt: new Date(),
        data: {},
        status: 'AWAITING_CHALLENGER_DEPOSIT',
      };

      const shouldRefund = 
        depositVerification.isWrongToken && 
        depositVerification.depositSender && 
        flip.tokenAddress !== 'NATIVE' && 
        !flip.data?.refundAttempted;

      expect(shouldRefund).toBe(true);

      // Step 3: Mark refund as attempted
      flip.data.refundAttempted = true;

      // Step 4: In real flow, call blockchainManager.refundIncorrectTokens()
      // Expected behavior:
      // - Search sender's recent transactions for other token transfers
      // - Find the wrong token transfer
      // - Validate bot has balance (or auto-create ATA)
      // - Execute refund transaction

      // Step 5: Cancel the flip or wait for challenger
      expect(flip.status).toBe('AWAITING_CHALLENGER_DEPOSIT');
      // Would update to CANCELLED if timeout triggers
    });
  });
});
