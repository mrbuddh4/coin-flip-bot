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
   * Find the sender of a recent incoming transaction to the bot wallet using Helius API
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenMint = null, knownSender = null, flipCreatedAt = null) {
    try {
      const flipCreatedAtSeconds = flipCreatedAt ? Math.floor(flipCreatedAt / 1000) : null;

      console.log('[getRecentDepositSender] Searching for Solana deposits via Helius API', {
        botWallet: botWalletAddress,
        tokenMint,
        expectedAmount,
        knownSender,
        flipCreatedAt,
      });

      // Construct Helius API request
      const heliusApiKey = config.solana.heliusApiKey;
      if (!heliusApiKey) {
        console.error('[getRecentDepositSender] Helius API key not configured');
        return null;
      }

      const url = `https://api.helius.xyz/v0/addresses/${botWalletAddress}/transactions?api-key=${heliusApiKey}`;
      
      const response = await this.withExponentialBackoff(() => fetch(url));
      if (!response.ok) {
        console.error('[getRecentDepositSender] Helius API error:', response.status);
        return null;
      }

      const transactions = await response.json();
      console.log('[getRecentDepositSender] Helius API response', {
        transactionCount: transactions?.length || 0,
      });

      if (!transactions || transactions.length === 0) {
        console.warn('[getRecentDepositSender] No transactions found');
        return null;
      }

      // Collect deposits and wrong tokens
      let deposits = [];
      let wrongTokenDeposits = [];

      for (const tx of transactions) {
        try {
          // Skip if transaction is failed
          if (tx.type === 'FAILED') continue;

          // Check for token transfers
          if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
            for (const transfer of tx.tokenTransfers) {
              // Validation depends on transfer type:
              // - SPL tokens (when searching for specific tokenMint): MUST go to ATA only
              // - Native SOL (no tokenMint specified): goes to main wallet
              
              let isTransferToBot = false;
              
              if (tokenMint) {
                // Looking for a specific SPL token: ONLY accept transfers to the bot's ATA for that token
                const transferMintPublicKey = new PublicKey(transfer.mint);
                const botPublicKey = new PublicKey(botWalletAddress);
                
                try {
                  const expectedBotATA = await getAssociatedTokenAddress(
                    transferMintPublicKey,
                    botPublicKey
                  );
                  const expectedBotATAStr = expectedBotATA.toBase58();
                  
                  // For SPL tokens: ONLY accept ATA, not main wallet
                  if (transfer.toUserAccount === expectedBotATAStr) {
                    isTransferToBot = true;
                  }
                } catch (ataErr) {
                  console.warn('[getRecentDepositSender] Could not calculate ATA:', ataErr.message);
                }
              } else {
                // Looking for native SOL: accept transfers to main wallet
                if (transfer.toUserAccount === botWalletAddress) {
                  isTransferToBot = true;
                }
              }
              
              if (!isTransferToBot) {
                console.log('[getRecentDepositSender] Skipping transfer to non-bot account', {
                  toAccount: transfer.toUserAccount,
                  botWallet: botWalletAddress,
                  mint: transfer.mint,
                });
                continue;
              }

              const transferMint = transfer.mint;
              const sender = transfer.fromUserAccount;
              const amount = parseFloat(transfer.tokenAmount);
              const decimals = transfer.tokenDecimals || 6;

              console.log('[getRecentDepositSender] Found token transfer TO BOT', {
                sender,
                recipient: transfer.toUserAccount,
                mint: transferMint,
                amount,
                signature: tx.signature,
              });

              // Check if this is the expected token or a wrong token
              if (tokenMint) {
                const tokenMintStr = tokenMint.toLowerCase();
                const transferMintStr = transferMint.toLowerCase();

                if (transferMintStr === tokenMintStr) {
                  // Correct token
                  deposits.push({
                    sender,
                    amount: amount.toString(),
                    signature: tx.signature,
                    slot: tx.slot || 0,
                    tokenMint,
                    wrongToken: null,
                  });
                } else {
                  // Wrong token detected
                  console.log('[getRecentDepositSender] Wrong token detected', {
                    sender,
                    expectedMint: tokenMint,
                    receivedMint: transferMint,
                    amount,
                  });
                  wrongTokenDeposits.push({
                    sender,
                    amount: amount.toString(),
                    signature: tx.signature,
                    slot: tx.slot || 0,
                    tokenMint: transferMint,
                    wrongToken: transferMint,
                  });
                }
              } else {
                // No specific token expected (shouldn't happen for token transfers)
                deposits.push({
                  sender,
                  amount: amount.toString(),
                  signature: tx.signature,
                  slot: tx.slot || 0,
                  tokenMint,
                  wrongToken: null,
                });
              }
            }
          }

          // Check for native SOL transfers
          if (!tokenMint && tx.nativeTransfers && tx.nativeTransfers.length > 0) {
            for (const transfer of tx.nativeTransfers) {
              // Look for transfers TO the bot wallet
              if (transfer.toUserAccount !== botWalletAddress) continue;

              const sender = transfer.fromUserAccount;
              const amount = transfer.amount / LAMPORTS_PER_SOL;

              console.log('[getRecentDepositSender] Found native SOL transfer', {
                sender,
                amount,
                signature: tx.signature,
              });

              deposits.push({
                sender,
                amount: amount.toString(),
                signature: tx.signature,
                slot: tx.slot || 0,
                tokenMint: null,
                wrongToken: null,
              });
            }
          }
        } catch (txErr) {
          console.warn('[getRecentDepositSender] Error processing transaction:', txErr.message);
          continue;
        }
      }

      // Process collected deposits
      const wrongTokensFound = wrongTokenDeposits.filter(d => d.sender === knownSender || !knownSender);

      if (wrongTokensFound.length > 0 && deposits.length === 0) {
        // Only wrong tokens detected, mark as wrong token
        console.log('[getRecentDepositSender] Wrong token deposits detected (no correct token found)', {
          count: wrongTokensFound.length,
        });

        const mostRecentWrong = wrongTokensFound[0];
        return {
          sender: mostRecentWrong.sender,
          amount: mostRecentWrong.amount,
          signature: mostRecentWrong.signature,
          slot: mostRecentWrong.slot,
          wrongToken: mostRecentWrong.wrongToken,
        };
      }

      if (deposits.length === 0) {
        console.warn('[getRecentDepositSender] No deposits found');
        return null;
      }

      if (knownSender) {
        // If a known sender is provided, accumulate ALL deposits from that sender
        const fromSender = deposits.filter(d => d.sender === knownSender);

        if (fromSender.length === 0) {
          console.warn('[getRecentDepositSender] No deposits found from known sender', { knownSender });
          return null;
        }

        const totalAmount = fromSender.reduce((sum, d) => parseFloat(d.amount) + sum, 0);

        console.log('[getRecentDepositSender] Accumulated deposits from known sender (Solana)', {
          sender: knownSender,
          depositCount: fromSender.length,
          totalAmount,
        });

        return {
          sender: knownSender,
          amount: totalAmount.toString(),
          signature: fromSender[0].signature,
          slot: fromSender[0].slot,
          wrongToken: null,
        };
      } else {
        // If no known sender, just return the most recent deposit
        const mostRecent = deposits[0];

        console.log('[getRecentDepositSender] Found recent deposit (Solana)', {
          sender: mostRecent.sender,
          amount: mostRecent.amount,
          signature: mostRecent.signature,
        });

        return {
          sender: mostRecent.sender,
          amount: mostRecent.amount,
          signature: mostRecent.signature,
          slot: mostRecent.slot,
          wrongToken: null,
        };
      }
    } catch (error) {
      console.error('Error getting recent Solana deposit sender:', error);
      return null;
    }
  }

  /**
   * Refund incorrect tokens on Solana using Helius API (for wrong token deposits)
   */
  async refundIncorrectTokens(botWalletAddress, expectedTokenMint, senderAddress, flipCreatedAt = null) {
    try {
      const flipCreatedAtSeconds = flipCreatedAt ? Math.floor(flipCreatedAt / 1000) : null;

      console.log('[refundIncorrectTokens] Starting Solana token refund via Helius', {
        senderAddress,
        expectedTokenMint,
        botWalletAddress,
        flipCreatedAt: flipCreatedAtSeconds,
      });

      // Construct Helius API request
      const heliusApiKey = config.solana.heliusApiKey;
      if (!heliusApiKey) {
        console.error('[refundIncorrectTokens] Helius API key not configured');
        return [];
      }

      const url = `https://api.helius.xyz/v0/addresses/${botWalletAddress}/transactions?api-key=${heliusApiKey}`;
      
      const response = await this.withExponentialBackoff(() => fetch(url));
      if (!response.ok) {
        console.error('[refundIncorrectTokens] Helius API error:', response.status);
        return [];
      }

      const transactions = await response.json();
      console.log('[refundIncorrectTokens] Helius API response', {
        transactionCount: transactions?.length || 0,
      });

      if (!transactions || transactions.length === 0) {
        console.log('[refundIncorrectTokens] No transactions found');
        return [];
      }

      let refundSigs = [];
      const expectedMintStr = expectedTokenMint?.toLowerCase() || null;

      for (const tx of transactions) {
        try {
          // Skip if transaction is failed
          if (tx.type === 'FAILED') continue;

          // Look for token transfers FROM the sender TO the bot of a wrong token
          if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
            for (const transfer of tx.tokenTransfers) {
              // Check if sender matches
              if (transfer.fromUserAccount !== senderAddress) {
                continue;
              }
              
              // For SPL tokens, check if transfer went to bot's ATA for that mint
              // We only need to check ATA since SPL tokens never go to main wallet
              let isTransferToBot = false;
              const transferMintPublicKey = new PublicKey(transfer.mint);
              const botPublicKey = new PublicKey(botWalletAddress);
              
              try {
                const expectedBotATA = await getAssociatedTokenAddress(
                  transferMintPublicKey,
                  botPublicKey
                );
                const expectedBotATAStr = expectedBotATA.toBase58();
                
                // For SPL tokens (wrong token refunds): ONLY accept ATA
                if (transfer.toUserAccount === expectedBotATAStr) {
                  isTransferToBot = true;
                }
              } catch (ataErr) {
                console.warn('[refundIncorrectTokens] Could not calculate ATA:', ataErr.message);
              }
              
              if (!isTransferToBot) {
                continue;
              }

              const transferMint = transfer.mint;
              const transferMintStr = transferMint.toLowerCase();

              // Check if this is a wrong token transfer (mint doesn't match expected)
              if (expectedMintStr && transferMintStr !== expectedMintStr) {
                console.log('[refundIncorrectTokens] Found wrong token transfer, initiating refund', {
                  signature: tx.signature,
                  wrongMint: transferMint,
                  expectedMint: expectedTokenMint,
                  sender: senderAddress,
                  amount: transfer.tokenAmount,
                });

                try {
                  // Determine refund amount - bot's current balance of the wrong token
                  const botPublicKey = new PublicKey(botWalletAddress);
                  const transferMintPublicKey = new PublicKey(transferMint);
                  const senderPublicKey = new PublicKey(senderAddress);

                  // Get bot's ATA for the wrong token
                  const botATA = await getAssociatedTokenAddress(
                    transferMintPublicKey,
                    botPublicKey
                  );

                  // Get the account balance from RPC to determine refund amount
                  let refundAmount = BigInt(0);
                  try {
                    const accountInfo = await this.connection.getParsedAccountInfo(botATA);
                    const balance = accountInfo.value?.data?.parsed?.info?.tokenAmount?.amount;
                    if (balance) {
                      refundAmount = BigInt(balance);
                    }
                  } catch (balanceErr) {
                    console.warn('[refundIncorrectTokens] Could not get bot ATA balance, using transferred amount', { balanceErr: balanceErr.message });
                    // Fall back to using the transfer amount
                    refundAmount = BigInt(Math.floor(parseFloat(transfer.tokenAmount) * Math.pow(10, transfer.tokenDecimals || 6)));
                  }

                  if (refundAmount > 0n) {
                    // Get sender's ATA for the wrong token
                    const senderATA = await getAssociatedTokenAddress(
                      transferMintPublicKey,
                      senderPublicKey
                    );

                    const decimals = transfer.tokenDecimals || 6;

                    console.log('[refundIncorrectTokens] Refunding wrong token', {
                      amount: refundAmount.toString(),
                      decimals,
                      formattedAmount: Number(refundAmount) / Math.pow(10, decimals),
                    });

                    // Create transfer instruction to refund
                    const transferInstruction = createTransferInstruction(
                      botATA,
                      senderATA,
                      this.wallet.publicKey,
                      refundAmount,
                      []
                    );

                    // Create and send transaction
                    const refundTx = new Transaction().add(transferInstruction);
                    const refundSignature = await this.connection.sendTransaction(refundTx, [this.wallet], {
                      skipPreflight: false,
                      preflightCommitment: 'confirmed',
                    });

                    // Wait for confirmation
                    await this.connection.confirmTransaction(refundSignature, 'confirmed');

                    console.log('[refundIncorrectTokens] ✅ Refund successful', {
                      transactionSignature: refundSignature,
                      refundAmount: refundAmount.toString(),
                    });

                    refundSigs.push({
                      txHash: refundSignature,
                      amount: Number(refundAmount) / Math.pow(10, decimals),
                      token: transferMint,
                    });
                  }
                } catch (refundErr) {
                  console.error('[refundIncorrectTokens] Error processing refund', {
                    error: refundErr.message,
                  });
                }
              }
            }
          }
        } catch (txErr) {
          console.warn('[refundIncorrectTokens] Error processing transaction:', txErr.message);
          continue;
        }
      }

      return refundSigs;
    } catch (error) {
      console.error('[refundIncorrectTokens] Error refunding incorrect tokens on Solana:', error);
      return [];
    }
  }
}

module.exports = SolanaHandler;
