const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  getAccount,
  transfer,
  createTransferInstruction,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const config = require('../config');

class SolanaHandler {
  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    
    // Handle both JSON array and Base58 string formats for private key
    let secretKey;
    try {
      // Try JSON array format first
      secretKey = new Uint8Array(JSON.parse(config.solana.privateKey));
    } catch (e) {
      // If JSON parsing fails, assume it's Base58
      secretKey = bs58.decode(config.solana.privateKey);
    }
    
    this.wallet = Keypair.fromSecretKey(secretKey);
  }

  /**
   * Get SOL balance
   */
  async getNativeBalance(walletAddress) {
    try {
      const publicKey = new PublicKey(walletAddress);
      const lamports = await this.connection.getBalance(publicKey);

      return {
        raw: lamports.toString(),
        formatted: lamports / LAMPORTS_PER_SOL,
      };
    } catch (error) {
      console.error('Error getting Solana native balance:', error);
      throw error;
    }
  }

  /**
   * Get SPL token balance
   */
  async getTokenBalance(tokenAddress, walletAddress) {
    try {
      const mint = new PublicKey(tokenAddress);
      const owner = new PublicKey(walletAddress);

      const ata = await getAssociatedTokenAddress(mint, owner);
      const account = await getAccount(this.connection, ata);

      return {
        raw: account.amount.toString(),
        formatted: Number(account.amount) / Math.pow(10, account.decimals),
        decimals: account.decimals,
      };
    } catch (error) {
      // ATA might not exist
      if (error.message.includes('TokenAccountNotFoundError')) {
        return {
          raw: '0',
          formatted: 0,
          decimals: 0,
        };
      }
      console.error('Error getting Solana token balance:', error);
      throw error;
    }
  }

  /**
   * Transfer SPL token
   */
  async transferToken(tokenAddress, fromPrivateKeyB58, toAddress, amount, decimals) {
    try {
      const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromPrivateKeyB58));
      const fromPublicKey = fromKeypair.publicKey;
      const mint = new PublicKey(tokenAddress);
      const toPublicKey = new PublicKey(toAddress);

      const fromATA = await getAssociatedTokenAddress(mint, fromPublicKey);
      const toATA = await getAssociatedTokenAddress(mint, toPublicKey);

      const transaction = new Transaction();

      // Check if destination ATA exists
      try {
        await getAccount(this.connection, toATA);
      } catch (error) {
        // ATA doesn't exist, but we'll let the transfer fail gracefully
        // In production, you might want to create the ATA first
      }

      const amountInTokens = Math.floor(amount * Math.pow(10, decimals));

      const instruction = createTransferInstruction(
        fromATA,
        toATA,
        fromPublicKey,
        amountInTokens
      );

      transaction.add(instruction);

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromPublicKey;

      transaction.sign(fromKeypair);

      const signature = await this.connection.sendTransaction(transaction, [fromKeypair]);
      await this.connection.confirmTransaction(signature, 'confirmed');

      return {
        txHash: signature,
        from: fromPublicKey.toBase58(),
        to: toAddress,
        status: 'success',
      };
    } catch (error) {
      console.error('Error transferring Solana token:', error);
      throw error;
    }
  }

  /**
   * Transfer native SOL
   */
  async transferNative(fromPrivateKeyB58, toAddress, amountSol) {
    try {
      const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromPrivateKeyB58));
      const toPublicKey = new PublicKey(toAddress);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: toPublicKey,
          lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromKeypair.publicKey;

      transaction.sign(fromKeypair);

      const signature = await this.connection.sendTransaction(transaction, [fromKeypair]);
      await this.connection.confirmTransaction(signature, 'confirmed');

      return {
        txHash: signature,
        from: fromKeypair.publicKey.toBase58(),
        to: toAddress,
        status: 'success',
      };
    } catch (error) {
      console.error('Error transferring native Solana:', error);
      throw error;
    }
  }

  /**
   * Check transaction status
   */
  async checkTransactionStatus(txHash) {
    try {
      const status = await this.connection.getSignatureStatus(txHash);

      if (!status) {
        return {
          status: 'pending',
          confirmations: 0,
          blockNumber: null,
        };
      }

      const confirmations = status.value?.confirmations || 0;
      const finalStatus = status.value?.err ? 'failed' : 'confirmed';

      return {
        status: finalStatus,
        confirmations,
        blockNumber: status.value?.slot,
      };
    } catch (error) {
      console.error('Error checking Solana transaction:', error);
      throw error;
    }
  }

  /**
   * Validate if address is valid Solana format
   */
  isValidAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get transaction fees
   */
  async getTransactionFee() {
    try {
      const feeCalculator = await this.connection.getRecentBlockhash();
      return {
        lamportsPerSignature: feeCalculator.feeCalculator.lamportsPerSignature / LAMPORTS_PER_SOL,
      };
    } catch (error) {
      console.error('Error getting Solana fees:', error);
      // Return a default estimate
      return {
        lamportsPerSignature: 0.00005, // ~5000 lamports
      };
    }
  }

  /**
   * Helper function for exponential backoff with jitter
   */
  async withExponentialBackoff(fn, maxRetries = 5) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Check if it's a rate limit error
        const is429 = error.message?.includes('429') || error.message?.includes('Too many requests');
        
        if (!is429 || attempt === maxRetries - 1) {
          throw error;
        }
        
        // Exponential backoff with jitter: 100ms * 2^attempt + random 0-50ms
        const baseDelay = 100 * Math.pow(2, attempt);
        const jitter = Math.random() * 50;
        const delay = baseDelay + jitter;
        
        console.warn(`[withExponentialBackoff] Rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Find the sender of a recent incoming transaction to the bot wallet using RPC
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenMint = null, knownSender = null, flipCreatedAt = null) {
    try {
      console.log('[getRecentDepositSender] Searching for Solana deposits via RPC', {
        botWallet: botWalletAddress,
        tokenMint,
        expectedAmount,
        knownSender,
      });

      // Use RPC to get recent signatures
      const botPublicKey = new PublicKey(botWalletAddress);
      const signatures = await this.withExponentialBackoff(() =>
        this.connection.getSignaturesForAddress(botPublicKey, { limit: 50 })
      );

      console.log('[getRecentDepositSender] RPC response', {
        transactionCount: signatures?.length || 0,
      });

      if (!signatures || signatures.length === 0) {
        console.log('[getRecentDepositSender] No transactions found');
        return null;
      }

      // Fetch full transaction details
      const transactions = [];
      for (const sig of signatures) {
        try {
          const tx = await this.withExponentialBackoff(() =>
            this.connection.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
          );
          if (tx && !tx.meta?.err) {
            transactions.push({ ...tx, signature: sig.signature, slot: sig.slot });
          }
        } catch (err) {
          // Skip transactions that can't be fetched
        }
      }

      // Collect deposits and wrong tokens
      let deposits = [];
      let wrongTokenDeposits = [];

      for (const tx of transactions) {
        try {
          // Parse token transfers from metadata
          const postBalances = tx.meta?.postTokenBalances || [];
          const preBalances = tx.meta?.preTokenBalances || [];

          for (const post of postBalances) {
            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
            if (!pre) continue;

            const postAmount = parseFloat(post.uiTokenAmount?.amount || 0);
            const preAmount = parseFloat(pre.uiTokenAmount?.amount || 0);
            const tokenReceived = postAmount - preAmount;

            // Skip if no tokens received
            if (tokenReceived <= 0) continue;

            // Check if this is to bot's wallet or ATA
            const accountKey = tx.transaction.message.staticAccountKeys[post.accountIndex];
            if (!accountKey) continue;

            const accountStr = accountKey.toBase58();
            const expectedBotATAStr = config.solana.sidTokenATA;
            
            const isToBot = (accountStr === botWalletAddress || accountStr === expectedBotATAStr);
            if (!isToBot) continue;

            const transferMint = post.mint;

            console.log('[getRecentDepositSender] Found token transfer TO BOT', {
              recipient: accountStr,
              mint: transferMint,
              amount: tokenReceived,
              signature: tx.signature,
            });

            // Check if expected token
            if (tokenMint) {
              if (transferMint.toLowerCase() === tokenMint.toLowerCase()) {
                deposits.push({
                  sender: knownSender || 'unknown',
                  amount: tokenReceived.toString(),
                  signature: tx.signature,
                  slot: tx.slot || 0,
                  tokenMint,
                  wrongToken: null,
                });
              } else {
                wrongTokenDeposits.push({
                  sender: knownSender || 'unknown',
                  amount: tokenReceived.toString(),
                  signature: tx.signature,
                  slot: tx.slot || 0,
                  tokenMint: transferMint,
                  wrongToken: transferMint,
                });
              }
            } else {
              deposits.push({
                sender: knownSender || 'unknown',
                amount: tokenReceived.toString(),
                signature: tx.signature,
                slot: tx.slot || 0,
                tokenMint,
                wrongToken: null,
              });
            }
          }
        } catch (txErr) {
          console.warn('[getRecentDepositSender] Error processing transaction:', txErr.message);
          continue;
        }
      }

      if (deposits.length > 0) {
        console.log('[getRecentDepositSender] Found matching deposits:', deposits.length);
        return deposits[0];
      }

      if (wrongTokenDeposits.length > 0) {
        console.log('[getRecentDepositSender] Found wrong token deposits:', wrongTokenDeposits.length);
        // Store wrong token deposits for refund
        this.wrongTokenDeposits = wrongTokenDeposits;
        throw new Error(`Wrong token received. Deposit in ${wrongTokenDeposits[0].wrongToken} instead of ${tokenMint}`);
      }

      console.log('[getRecentDepositSender] No deposits found');
      return null;
    } catch (error) {
      console.error('[getRecentDepositSender] Error:', error);
      throw error;
    }
  }

  /**
   * Refund incorrect tokens on Solana  
   */
  async refundIncorrectTokens(botWalletAddress, expectedTokenMint, senderAddress, flipCreatedAt = null) {
    try {
      console.log('[refundIncorrectTokens] Refund function temporarily disabled', {
        senderAddress,
        expectedTokenMint,
        botWalletAddress,
      });
      // TODO: Implement refunds via Solscan API
      return [];
    } catch (error) {
      console.error('[refundIncorrectTokens] Error:', error);
      return [];
    }
  }
}

module.exports = SolanaHandler;
