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
   * Find the sender of a recent incoming transaction to the bot wallet
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenMint = null) {
    try {
      const botPublicKey = new PublicKey(botWalletAddress);
      const signatures = await this.connection.getSignaturesForAddress(botPublicKey, { limit: 100 });

      // Collect all deposits from the most recent event's sender
      let firstSenderFound = null;
      const depositsFromSender = [];
      
      for (const sig of signatures) {
        try {
          const transaction = await this.connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!transaction) continue;

          const { meta, transaction: tx } = transaction;

          // Look for transfers in the transaction
          if (tokenMint) {
            // For SPL tokens, parse token program instructions
            // Look for token transfer instructions where bot's account receives tokens
            if (tx.message && tx.message.instructions) {
              for (const instruction of tx.message.instructions) {
                try {
                  // Check if this is a token program instruction
                  const programId = tx.message.accountKeys[instruction.programIdIndex];
                  if (!programId) continue;
                  
                  const programIdStr = programId.toBase58();
                  // Solana Token Program ID: TokenkegQfeZyiNwAJsyFbPVwwQQfuls8PsPkkP7gC9j
                  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJsyFbPVwwQQfuls8PsPkkP7gC9j';
                  
                  if (programIdStr === TOKEN_PROGRAM_ID && instruction.accounts) {
                    // Instruction account 0 = source, 1 = destination, 2 = authority/owner
                    const sourceIndex = instruction.accounts[0];
                    const destIndex = instruction.accounts[1];
                    
                    if (destIndex !== undefined && sourceIndex !== undefined) {
                      const destAccount = tx.message.accountKeys[destIndex];
                      const sourceAccount = tx.message.accountKeys[sourceIndex];
                      
                      // Check if this is the bot's token account receiving tokens
                      if (destAccount && sourceAccount) {
                        const destStr = destAccount.toBase58();
                        const sourceStr = sourceAccount.toBase58();
                        
                        // Get bot's ATA for the token mint
                        try {
                          const { getAssociatedTokenAddress } = require('@solana/spl-token');
                          const botATA = await getAssociatedTokenAddress(
                            new PublicKey(tokenMint),
                            botPublicKey
                          );
                          const botATAStr = botATA.toBase58();
                          
                          // If destination is bot's ATA, this is a deposit
                          if (destStr === botATAStr) {
                            // Try to find the original sender from the authority account
                            if (tx.message.accountKeys.length > 2) {
                              const authorityIndex = instruction.accounts[2];
                              if (authorityIndex !== undefined) {
                                const authority = tx.message.accountKeys[authorityIndex];
                                const authorityStr = authority.toBase58();
                                
                                // Extract amount from instruction data if available
                                // Token program Transfer instruction: opcode (1 byte) + amount (8 bytes little-endian)
                                if (instruction.data && instruction.data.length > 1) {
                                  const buffer = Buffer.from(instruction.data);
                                  if (buffer.length >= 9) {
                                    // Read 8 bytes for amount (little-endian)
                                    const amount = buffer.readBigUInt64LE(1);
                                    
                                    // Get token decimals from account data
                                    let decimals = 6; // Default for most SPL tokens
                                    try {
                                      const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
                                      if (mintInfo.value?.data?.parsed?.info?.decimals !== undefined) {
                                        decimals = mintInfo.value.data.parsed.info.decimals;
                                      }
                                    } catch (err) {
                                      console.warn('Could not get token decimals, using default 6');
                                    }
                                    
                                    const formattedAmount = Number(amount) / Math.pow(10, decimals);
                                    
                                    // Track sender from first deposit found
                                    if (!firstSenderFound) {
                                      firstSenderFound = authorityStr;
                                    }
                                    
                                    // Only accumulate if from same sender
                                    if (authorityStr === firstSenderFound) {
                                      depositsFromSender.push({
                                        amount: formattedAmount,
                                        signature: sig.signature,
                                        slot: sig.slot,
                                      });
                                    }
                                  }
                                }
                              }
                            }
                          }
                        } catch (ataErr) {
                          console.warn('Could not process SPL token transfer:', ataErr.message);
                        }
                      }
                    }
                  }
                } catch (instructionErr) {
                  console.warn('Error parsing instruction:', instructionErr.message);
                  continue;
                }
              }
            }
          } else {
            // For native SOL transfers
            for (let i = 0; i < tx.message.accountKeys.length; i++) {
              const account = tx.message.accountKeys[i];
              if (account.toBase58() === botWalletAddress) {
                // Found the bot receive the transaction
                // The sender is typically the first account (index 0)
                if (tx.message.accountKeys.length > 0) {
                  // Get the account that decreased in balance (the sender)
                  const senderKey = tx.message.accountKeys[0];
                  const senderStr = senderKey.toBase58();
                  
                  if (meta && meta.preBalances && meta.postBalances) {
                    const balanceChange = meta.postBalances[botPublicKey.toString()] - meta.preBalances[botPublicKey.toString()];
                    if (balanceChange > 0) {
                      // Track sender from first deposit found
                      if (!firstSenderFound) {
                        firstSenderFound = senderStr;
                      }
                      
                      // Only accumulate if from same sender
                      if (senderStr === firstSenderFound) {
                        const transactionAmount = balanceChange / LAMPORTS_PER_SOL;
                        depositsFromSender.push({
                          amount: transactionAmount,
                          signature: sig.signature,
                          slot: sig.slot,
                        });
                      }
                  }
                }
              }
            }
          }
        } catch (err) {
          console.warn('Error processing Solana transaction:', err.message);
          continue;
        }
      }

      // If we found deposits from the same sender, sum them all and return
      if (depositsFromSender.length > 0 && firstSenderFound) {
        const totalAmount = depositsFromSender.reduce((sum, dep) => sum + dep.amount, 0);
        
        console.log('[getRecentDepositSender] Found multiple deposits from sender', {
          sender: firstSenderFound,
          depositCount: depositsFromSender.length,
          totalAmount,
          deposits: depositsFromSender,
        });
        
        return {
          sender: firstSenderFound,
          amount: totalAmount.toString(),
          signature: depositsFromSender[0].signature,
          slot: depositsFromSender[0].slot,
          transferCount: depositsFromSender.length,
        };
      }

      return null;
    } catch (error) {
      console.error('Error getting recent Solana deposit sender:', error);
      return null;
    }
  }
}

module.exports = SolanaHandler;
