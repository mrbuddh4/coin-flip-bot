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
   * Find the sender of a recent incoming transaction to the bot wallet using optimized RPC
   * Queries the sender's wallet history instead of bot wallet to minimize RPC calls
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenMint = null, knownSender = null, flipCreatedAt = null) {
    try {
      console.log('[getRecentDepositSender] Searching for Solana deposits via RPC (sender-optimized)', {
        botWallet: botWalletAddress,
        tokenMint,
        expectedAmount,
        knownSender,
      });

      // If we have a known sender, query their wallet history to find transfers to bot
      if (!knownSender) {
        console.log('[getRecentDepositSender] No known sender, cannot verify deposit');
        return null;
      }

      // Use RPC to get recent signatures from the SENDER (not bot) - fetch up to 5, but skip failures
      const senderPublicKey = new PublicKey(knownSender);
      const signatures = await this.withExponentialBackoff(() =>
        this.connection.getSignaturesForAddress(senderPublicKey, { limit: 5 })
      );

      console.log('[getRecentDepositSender] RPC response from sender', {
        transactionCount: signatures?.length || 0,
        sender: knownSender,
      });

      if (!signatures || signatures.length === 0) {
        console.log('[getRecentDepositSender] No transactions found from sender');
        return null;
      }

      // Fetch transactions - skip failures and continue to next one
      const transactions = [];
      for (let i = 0; i < signatures.length; i++) {
        try {
          // Add long delay before each fetch to avoid rate limiting
          if (i > 0) {
            console.log(`[getRecentDepositSender] Waiting 5s before fetching tx ${i + 1}/${signatures.length}...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }

          console.log(`[getRecentDepositSender] Fetching tx ${i + 1}/${signatures.length}: ${signatures[i].signature.substring(0, 20)}...`);
          const tx = await this.connection.getTransaction(signatures[i].signature, {
            maxSupportedTransactionVersion: 0
          });
          
          if (tx && !tx.meta?.err) {
            transactions.push({ ...tx, signature: signatures[i].signature, slot: signatures[i].slot });
            console.log(`[getRecentDepositSender] Successfully fetched tx ${i + 1}/${signatures.length}`);
          } else {
            console.log(`[getRecentDepositSender] Transaction ${i + 1}/${signatures.length} failed or has error, skipping`);
          }
        } catch (err) {
          console.warn(`[getRecentDepositSender] Error fetching tx ${i + 1}/${signatures.length}:`, err.message);
          // Continue to next transaction on failure
        }
      }

      console.log('[getRecentDepositSender] Fetched transactions from sender', { count: transactions.length });

      // Collect deposits from sender to bot
      let deposits = [];
      let wrongTokenDeposits = [];

      for (const tx of transactions) {
        try {
          // Parse token transfers from metadata
          const postBalances = tx.meta?.postTokenBalances || [];
          const preBalances = tx.meta?.preTokenBalances || [];

          console.log(`[getRecentDepositSender] Analyzing tx ${tx.signature.substring(0, 20)}... - Token balance changes: ${postBalances.length}`);

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
            if (!accountKey) {
              console.log(`[getRecentDepositSender] Account key not found for index ${post.accountIndex}`);
              continue;
            }

            const accountStr = accountKey.toBase58();
            const expectedBotATAStr = config.solana.sidTokenATA;
            const correctBotATA = 'BNGHJazs5Ddps9pgYgFr1JvqPVjRChDngpXvWbYqoz6F'; // The actual SID token account
            
            console.log(`[getRecentDepositSender] Token balance change: account=${accountStr}, pre=${preAmount}, post=${postAmount}, change=${tokenReceived}, mint=${post.mint}`);

            const isToBot = (accountStr === botWalletAddress || accountStr === expectedBotATAStr || accountStr === correctBotATA);
            if (!isToBot) {
              console.log(`[getRecentDepositSender] Transfer NOT to bot. Bot wallet=${botWalletAddress}, Bot ATA=${expectedBotATAStr}, Correct ATA=${correctBotATA}`);
              continue;
            }

            const transferMint = post.mint;

            console.log('[getRecentDepositSender] Found token transfer from sender TO BOT', {
              sender: knownSender,
              recipient: accountStr,
              mint: transferMint,
              amount: tokenReceived,
              signature: tx.signature,
            });

            // Check if expected token
            if (tokenMint) {
              if (transferMint.toLowerCase() === tokenMint.toLowerCase()) {
                deposits.push({
                  sender: knownSender,
                  amount: tokenReceived.toString(),
                  signature: tx.signature,
                  slot: tx.slot || 0,
                  tokenMint,
                  wrongToken: null,
                });
              } else {
                wrongTokenDeposits.push({
                  sender: knownSender,
                  amount: tokenReceived.toString(),
                  signature: tx.signature,
                  slot: tx.slot || 0,
                  tokenMint: transferMint,
                  wrongToken: transferMint,
                });
              }
            } else {
              deposits.push({
                sender: knownSender,
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
        console.log('[getRecentDepositSender] Found matching deposits from sender:', deposits.length);
        return deposits[0];
      }

      // Return wrong token deposit instead of throwing - let caller decide what to do
      if (wrongTokenDeposits.length > 0) {
        console.log('[getRecentDepositSender] Found wrong token deposits from sender:', wrongTokenDeposits.length);
        const wrongTokenDeposit = wrongTokenDeposits[0];
        return {
          ...wrongTokenDeposit,
          hasWrongTokens: true,
          wrongToken: wrongTokenDeposit.wrongToken,
        };
      }

      console.log('[getRecentDepositSender] No deposits found from sender');
      return null;
    } catch (error) {
      console.error('[getRecentDepositSender] Error:', error);
      throw error;
    }
  }

  /**
   * Refund incorrect tokens on Solana - search recent transactions for wrong token transfers
   */
  async refundIncorrectTokens(botWalletAddress, expectedTokenMint, senderAddress, flipCreatedAt = null) {
    try {
      console.log('[refundIncorrectTokens] Searching for wrong token deposits to refund', {
        senderAddress,
        expectedTokenMint,
        botWallet: botWalletAddress,
        flipCreatedAt,
      });

      // Query sender's recent transactions to find any token transfers that DON'T match expected mint
      const senderPublicKey = new PublicKey(senderAddress);
      const signatures = await this.withExponentialBackoff(() =>
        this.connection.getSignaturesForAddress(senderPublicKey, { limit: 10 })
      );

      if (!signatures || signatures.length === 0) {
        console.log('[refundIncorrectTokens] No transactions found from sender');
        return [];
      }

      // Find wrong token transfers
      const refundsToProcess = [];
      const correctBotATA = 'BNGHJazs5Ddps9pgYgFr1JvqPVjRChDngpXvWbYqoz6F';

      for (let i = 0; i < signatures.length; i++) {
        try {
          // Add delay between requests
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          const tx = await this.connection.getTransaction(signatures[i].signature, {
            maxSupportedTransactionVersion: 0
          });

          if (!tx || tx.meta?.err) continue;

          // Look for token transfers to bot with WRONG token
          const postBalances = tx.meta?.postTokenBalances || [];
          const preBalances = tx.meta?.preTokenBalances || [];

          for (const post of postBalances) {
            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
            if (!pre) continue;

            const postAmount = parseFloat(post.uiTokenAmount?.amount || 0);
            const preAmount = parseFloat(pre.uiTokenAmount?.amount || 0);
            const tokenReceived = postAmount - preAmount;

            if (tokenReceived <= 0) continue;

            // Check if transfer is to bot
            const accountKey = tx.transaction.message.staticAccountKeys[post.accountIndex];
            if (!accountKey) continue;

            const accountStr = accountKey.toBase58();
            const isToBot = (accountStr === botWalletAddress || accountStr === correctBotATA);
            if (!isToBot) continue;

            // Check if it's the WRONG token
            const transferMint = post.mint;
            if (transferMint.toLowerCase() !== expectedTokenMint.toLowerCase()) {
              console.log('[refundIncorrectTokens] Found wrong token transfer to refund', {
                mint: transferMint,
                amount: tokenReceived,
                recipient: accountStr,
                signature: tx.signature,
              });

              refundsToProcess.push({
                wrongTokenMint: transferMint,
                amount: tokenReceived,
                senderAddress: senderAddress,
                signature: tx.signature,
              });
            }
          }
        } catch (err) {
          console.warn('[refundIncorrectTokens] Error processing transaction:', err.message);
          continue;
        }
      }

      if (refundsToProcess.length === 0) {
        console.log('[refundIncorrectTokens] No wrong token transfers found to refund');
        return [];
      }

      console.log('[refundIncorrectTokens] Found wrong token transfers, but refund service not yet implemented', {
        count: refundsToProcess.length,
        refunds: refundsToProcess,
      });

      // TODO: Implement actual refund transfers using SPL Token Program
      // For now, return the info for logging
      return refundsToProcess;
    } catch (error) {
      console.error('[refundIncorrectTokens] Error:', error);
      return [];
    }
  }
}

module.exports = SolanaHandler;
