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
  async verifyDeposit(network, tokenAddress, expectedAmount, tokenDecimals) {
    const handler = this.getHandler(network);
    const botWallet = this.getBotWalletAddress(network);

    try {
      console.log('[verifyDeposit] Starting verification', {
        network,
        tokenAddress,
        expectedAmount,
        tokenDecimals,
        botWallet,
      });

      // Primary verification: Check blockchain for actual deposit transaction
      let depositInfo = await handler.getRecentDepositSender(botWallet, expectedAmount, tokenAddress);

      if (depositInfo) {
        // Transaction found on blockchain
        const receivedAmount = parseFloat(depositInfo.amount);
        const expectedAmountNum = parseFloat(expectedAmount);
        
        // Allow 1% variance for rounding/fees
        const variance = expectedAmountNum * 0.01;
        const hasDeposit = receivedAmount >= (expectedAmountNum - variance);

        console.log('[verifyDeposit] Blockchain transaction found', {
          network,
          received: receivedAmount,
          expected: expectedAmountNum,
          sender: depositInfo.sender,
          hasDeposit,
        });

        return {
          received: hasDeposit,
          amount: receivedAmount,
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
  async verifyDepositWithRetry(network, tokenAddress, expectedAmount, tokenDecimals, maxRetries = 4, retryDelayMs = 2000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.verifyDeposit(network, tokenAddress, expectedAmount, tokenDecimals);
      
      if (result.received) {
        console.log(`Deposit verified on attempt ${attempt}/${maxRetries}`);
        return result;
      }

      // If not last attempt, wait before retrying
      if (attempt < maxRetries) {
        console.log(`Deposit not found on attempt ${attempt}/${maxRetries}, retrying in ${retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    // After all retries, return the last result
    console.log('Deposit verification failed after all retries');
    return await this.verifyDeposit(network, tokenAddress, expectedAmount, tokenDecimals);
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
