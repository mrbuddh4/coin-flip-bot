const crypto = require('crypto');
const EVMHandler = require('./evmHandler');
const SolanaHandler = require('./solanaHandler');
const config = require('../config');

class BlockchainManager {
  constructor() {
    this.evmHandler = new EVMHandler();
    this.solanaHandler = new SolanaHandler();
    // Track last seen balances for deposit detection
    this.lastSeenEVMBalance = {};
    this.lastSeenSolanaBalance = {};
  }

  /**
   * Get appropriate handler for network
   */
  getHandler(network) {
    if (network === 'EVM') {
      return this.evmHandler;
    } else if (network === 'Solana') {
      return this.solanaHandler;
    }
    throw new Error(`Unknown network: ${network}`);
  }

  /**
   * Generate deposit wallet for flip
   */
  async generateDepositWallet(network) {
    const handler = this.getHandler(network);
    const wallet = await handler.generateWallet();
    return wallet;
  }

  /**
   * Get bot's wallet address for the network
   */
  getBotWalletAddress(network) {
    if (network === 'EVM') {
      // Return explicit address if set, otherwise derive from private key
      if (config.evm.walletAddress) {
        return config.evm.walletAddress;
      }
      // Derive from private key
      const { ethers } = require('ethers');
      const wallet = new ethers.Wallet(config.evm.privateKey);
      return wallet.address;
    } else if (network === 'Solana') {
      // Return explicit address if set, otherwise derive from private key
      if (config.solana.walletAddress) {
        return config.solana.walletAddress;
      }
      // Derive from private key
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');
      
      let secretKey;
      try {
        // Try parsing as JSON array first
        secretKey = new Uint8Array(JSON.parse(config.solana.privateKey));
      } catch {
        // If not JSON, assume base58 encoded
        try {
          secretKey = new Uint8Array(bs58.decode(config.solana.privateKey));
        } catch (err) {
          throw new Error(`Failed to decode Solana private key. Expected JSON array or base58 string. Error: ${err.message}`);
        }
      }
      
      const keypair = Keypair.fromSecretKey(secretKey);
      return keypair.publicKey.toBase58();
    }
    throw new Error(`Unknown network: ${network}`);
  }

  /**
   * Check if deposit has been received (by verifying blockchain transaction)
   */
  async verifyDeposit(network, tokenAddress, expectedAmount, tokenDecimals, knownSender = null, flipCreatedAt = null) {
    const handler = this.getHandler(network);
    const botWallet = this.getBotWalletAddress(network);

    try {
      console.log('[verifyDeposit] Starting verification', {
        network,
        tokenAddress,
        expectedAmount,
        tokenDecimals,
        botWallet,
        knownSender,
        flipCreatedAt,
      });

      // Primary verification: Check blockchain for actual deposit transaction
      let depositInfo = await handler.getRecentDepositSender(botWallet, expectedAmount, tokenAddress, knownSender, flipCreatedAt);

      if (depositInfo) {
        // Transaction found on blockchain
        const receivedAmountRaw = parseFloat(depositInfo.amount); // Amount returned from handler
        const expectedAmountNum = parseFloat(expectedAmount);      // Amount in display units
        
        // SPECIAL CASE: For native SOL tokens, amount is already in display units (SOL)
        // For SPL tokens, amount is in raw units and needs conversion
        let receivedAmountDisplay;
        if (depositInfo.tokenMint === 'NATIVE') {
          // Native SOL - amount is already in display units (SOL)
          receivedAmountDisplay = receivedAmountRaw;
        } else {
          // SPL token - convert from raw units to display units
          receivedAmountDisplay = receivedAmountRaw / Math.pow(10, tokenDecimals);
        }
        
        // Allow 1% variance for rounding/fees
        const variance = expectedAmountNum * 0.01;
        const hasDeposit = receivedAmountDisplay >= (expectedAmountNum - variance);
        
        // CRITICAL: Check if the deposit is the WRONG TOKEN
        // If it is, reject it so the refund logic can trigger
        const hasWrongTokens = depositInfo.hasWrongTokens || depositInfo.wrongToken;
        
        if (hasWrongTokens) {
          console.log('[verifyDeposit] WRONG TOKEN DETECTED - rejecting deposit to trigger refund', {
            network,
            receivedRaw: receivedAmountRaw,
            receivedDisplay: receivedAmountDisplay,
            expected: expectedAmountNum,
            sender: depositInfo.sender,
            wrongTokenInfo: depositInfo.wrongToken,
            hasWrongTokens,
          });

          // Return with depositSender so refund logic can execute
          return {
            received: false,
            amount: receivedAmountRaw,
            expected: expectedAmountNum,
            botWallet: botWallet,
            depositSender: depositInfo.sender,  // Keep sender so refund can happen!
            depositTransaction: depositInfo.transactionHash || depositInfo.signature || null,
            blockNumber: depositInfo.blockNumber || depositInfo.slot || null,
            verified: 'blockchain',
            wrongToken: depositInfo.wrongToken,  // Include info about wrong token (e.g., 'NATIVE' or token address)
            isWrongToken: true,  // Flag indicating this is a wrong token scenario
            network: network,  // CRITICAL: Include network for correct token label in message
            error: 'Wrong token sent - will refund automatically',
          };
        }

        console.log('[verifyDeposit] Blockchain transaction found', {
          network,
          receivedRaw: receivedAmountRaw,
          receivedDisplay: receivedAmountDisplay,
          expected: expectedAmountNum,
          sender: depositInfo.sender,
          hasDeposit,
          variance,
        });

        return {
          received: hasDeposit,
          amount: receivedAmountRaw,
          expected: expectedAmountNum,
          botWallet: botWallet,
          depositSender: depositInfo.sender,
          depositTransaction: depositInfo.transactionHash || depositInfo.signature || null,
          blockNumber: depositInfo.blockNumber || depositInfo.slot || null,
          verified: 'blockchain', // Explicitly mark this as blockchain-verified
        };
      }

      // CRITICAL FIX: Do NOT use balance fallback - it causes false positives!
      // If no specific transaction is found from this user, we must fail the verification.
      // Using the bot wallet's total balance is unsafe because:
      // 1. It includes tokens from previous flips/other users
      // 2. It doesn't verify THIS user actually sent tokens
      // 3. A challenger with 0 tokens could pass if bot has balance from other sources
      
      console.error('[verifyDeposit] NO DEPOSIT TRANSACTION FOUND - rejecting deposit verification', {
        network,
        tokenAddress,
        expectedAmount,
        botWallet,
        reason: 'No blockchain transaction found - cannot accept balance-based verification'
      });

      return {
        received: false,
        amount: 0,
        expected: parseFloat(expectedAmount),
        botWallet: botWallet,
        depositSender: null,
        depositTransaction: null,
        verified: 'blockchain', // Require blockchain verification only
        error: 'No transaction found from depositor'
      };
    } catch (error) {
      console.error('[verifyDeposit] Error verifying deposit:', error);
      return {
        received: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify deposit with retries (accounts for blockchain indexing delay)
   */
  async verifyDepositWithRetry(network, tokenAddress, expectedAmount, tokenDecimals, maxRetries = 3, retryDelayMs = 15000, knownSender = null, flipCreatedAt = null) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.verifyDeposit(network, tokenAddress, expectedAmount, tokenDecimals, knownSender, flipCreatedAt);
      
      // CRITICAL: Only return on success
      if (result.received) {
        console.log(`Deposit verified on attempt ${attempt}/${maxRetries}`);
        return result;
      }
      
      // CRITICAL: If we FOUND a deposit but it's underpaid/wrong-token, return immediately
      // Don't retry - we found the transaction, it's just not enough or wrong token
      if (result.depositSender) {
        console.log(`Deposit transaction found but validation failed (underpayment or wrong token), returning without retry`, {
          attempt,
          depositSender: result.depositSender,
          received: result.received,
          isWrongToken: result.isWrongToken,
          amount: result.amount,
          expected: result.expected,
        });
        return result;
      }

      // ONLY retry if we found NO transaction at all (null depositSender)
      if (attempt < maxRetries) {
        console.log(`No deposit transaction found on attempt ${attempt}/${maxRetries}, retrying in ${retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    // After all retries, return the last result
    console.log('Deposit verification failed after all retries');
    return await this.verifyDeposit(network, tokenAddress, expectedAmount, tokenDecimals, knownSender, flipCreatedAt);
  }

  /**
   * Send winnings to winner from bot wallet
   */
  async sendWinnings(network, tokenAddress, winnerAddress, amount, decimals) {
    const handler = this.getHandler(network);

    try {
      let result;
      const botPrivateKey = network === 'EVM' ? config.evm.privateKey : config.solana.privateKey;
      
      if (tokenAddress === 'NATIVE') {
        result = await handler.transferNative(botPrivateKey, winnerAddress, amount);
      } else {
        result = await handler.transferToken(tokenAddress, botPrivateKey, winnerAddress, amount, decimals);
      }
      return result;
    } catch (error) {
      console.error('Error sending winnings:', error);
      throw error;
    }
  }

  /**
   * Refund incorrect token transfers (tokens that don't match the expected contract)
   */
  async refundIncorrectTokens(network, expectedTokenAddress, senderAddress, flipCreatedAt = null) {
    const handler = this.getHandler(network);

    if (!handler.refundIncorrectTokens) {
      console.log('[refundIncorrectTokens] Refund not supported for network:', network);
      return [];
    }

    try {
      const botWallet = this.getBotWalletAddress(network);
      const results = await handler.refundIncorrectTokens(botWallet, expectedTokenAddress, senderAddress, flipCreatedAt);
      return results;
    } catch (error) {
      console.error('[refundIncorrectTokens] Error refunding incorrect tokens:', error);
      return [];
    }
  }

  /**
   * Check transaction confirmation
   */
  async checkTransactionConfirmation(network, txHash, requiredConfirmations = 1) {
    const handler = this.getHandler(network);

    try {
      const status = await handler.checkTransactionStatus(txHash);
      return {
        confirmed: status.confirmations >= requiredConfirmations,
        confirmations: status.confirmations,
        status: status.status,
      };
    } catch (error) {
      console.error('Error checking transaction:', error);
      return {
        confirmed: false,
        error: error.message,
      };
    }
  }

  /**
   * Validate wallet address
   */
  isValidAddress(network, address) {
    const handler = this.getHandler(network);
    return handler.isValidAddress(address);
  }
}

// Singleton instance
let blockchainManager;

const initBlockchainManager = () => {
  if (!blockchainManager) {
    blockchainManager = new BlockchainManager();
  }
  return blockchainManager;
};

const getBlockchainManager = () => {
  if (!blockchainManager) {
    throw new Error('BlockchainManager not initialized');
  }
  return blockchainManager;
};

module.exports = {
  BlockchainManager,
  initBlockchainManager,
  getBlockchainManager,
};
