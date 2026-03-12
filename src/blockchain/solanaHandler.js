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
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenMint = null, knownSender = null) {
    try {
      const botPublicKey = new PublicKey(botWalletAddress);
      // Check recent signatures only (~30 minute window on Solana)
      const signatures = await this.connection.getSignaturesForAddress(botPublicKey, { limit: 100 });

      // Collect all deposits to find sender info
      let deposits = [];
      let wrongTokenDeposits = [];
      
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
                      
                      // Check if this is any token transfer to the bot
                      if (destAccount && sourceAccount) {
                        const destStr = destAccount.toBase58();
                        
                        // Parse the token instruction to get token mint
                        let transferTokenMint = null;
                        try {
                          // Token program instruction format: opcode (1) + amount (8) + other data
                          const buffer = Buffer.from(instruction.data);
                          if (buffer.length >= 1) {
                            // Get the mint from the source account's parsed data
                            const sourceAccountInfo = await this.connection.getParsedAccountInfo(sourceAccount);
                            if (sourceAccountInfo.value?.data?.parsed?.info?.mint) {
                              transferTokenMint = sourceAccountInfo.value.data.parsed.info.mint;
                            }
                          }
                        } catch (err) {
                          console.warn('Could not determine token mint from transfer');
                        }
                        
                        // Get bot's ATA for the token mint to check if this is received by bot
                        try {
                          const { getAssociatedTokenAddress } = require('@solana/spl-token');
                          const botATA = await getAssociatedTokenAddress(
                            new PublicKey(tokenMint),
                            botPublicKey
                          );
                          const botATAStr = botATA.toBase58();
                          
                          if (tx.message.accountKeys.length > 2) {
                            const authorityIndex = instruction.accounts[2];
                            if (authorityIndex !== undefined) {
                              const authority = tx.message.accountKeys[authorityIndex];
                              const authorityStr = authority.toBase58();
                              
                              // Extract amount from instruction data
                              if (instruction.data && instruction.data.length > 1) {
                                const buffer = Buffer.from(instruction.data);
                                if (buffer.length >= 9) {
                                  const amount = buffer.readBigUInt64LE(1);
                                  
                                  // Get token decimals
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
                                  
                                  // Check if this is the expected token or wrong token
                                  if (destStr === botATAStr) {
                                    // Correct token received
                                    deposits.push({
                                      sender: authorityStr,
                                      amount: formattedAmount,
                                      signature: sig.signature,
                                      slot: sig.slot,
                                      tokenMint,
                                      wrongToken: null,
                                    });
                                  } else if (transferTokenMint && transferTokenMint !== tokenMint) {
                                    // Wrong token detected
                                    console.log('[getRecentDepositSender] Wrong token detected', {
                                      sender: authorityStr,
                                      expectedMint: tokenMint,
                                      receivedMint: transferTokenMint,
                                      amount: formattedAmount,
                                    });
                                    wrongTokenDeposits.push({
                                      sender: authorityStr,
                                      amount: formattedAmount,
                                      signature: sig.signature,
                                      slot: sig.slot,
                                      tokenMint: transferTokenMint,
                                      wrongToken: transferTokenMint,
                                    });
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
                    const balanceChange = meta.postBalances[i] - meta.preBalances[i];
                    if (balanceChange > 0) {
                      const transactionAmount = balanceChange / LAMPORTS_PER_SOL;
                      
                      deposits.push({
                        sender: senderStr,
                        amount: transactionAmount,
                        signature: sig.signature,
                        slot: sig.slot,
                        tokenMint: null,
                        wrongToken: null,
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
    } catch (error) {
      console.error('Error getting recent Solana deposit sender:', error);
      return null;
    }
  }

  /**
   * Refund incorrect tokens on Solana (for wrong token deposits)
   */
  async refundIncorrectTokens(botWalletAddress, expectedTokenMint, senderAddress, flipCreatedAt = null) {
    try {
      console.log('[refundIncorrectTokens] Starting Solana token refund', {
        senderAddress,
        expectedTokenMint,
        botWalletAddress,
      });

      // Get recent transactions to find wrong token transfers
      const botPublicKey = new PublicKey(botWalletAddress);
      const signatures = await this.connection.getSignaturesForAddress(botPublicKey, { limit: 100 });

      let refundSigs = [];
      const expectedMintStr = expectedTokenMint?.toLowerCase() || null;

      for (const sig of signatures) {
        try {
          const transaction = await this.connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!transaction) continue;

          const { meta, transaction: tx } = transaction;

          // Only look at transactions after the flip was created
          if (flipCreatedAt && sig.blockTime) {
            const flipCreatedAtSeconds = Math.floor(flipCreatedAt / 1000);
            if (sig.blockTime < flipCreatedAtSeconds) {
              continue;
            }
          }

          // Look for token transfers in this transaction
          if (tx.message && tx.message.instructions) {
            for (const instruction of tx.message.instructions) {
              try {
                const programId = tx.message.accountKeys[instruction.programIdIndex];
                if (!programId) continue;

                const programIdStr = programId.toBase58();
                const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJsyFbPVwwQQfuls8PsPkkP7gC9j';

                if (programIdStr === TOKEN_PROGRAM_ID && instruction.accounts && instruction.accounts.length >= 3) {
                  const sourceIndex = instruction.accounts[0];
                  const destIndex = instruction.accounts[1];
                  const authorityIndex = instruction.accounts[2];

                  if (sourceIndex !== undefined && destIndex !== undefined) {
                    const sourceAccount = tx.message.accountKeys[sourceIndex];
                    const destAccount = tx.message.accountKeys[destIndex];
                    const authority = tx.message.accountKeys[authorityIndex];

                    // Check if sender is the authority
                    if (authority && authority.toBase58() === senderAddress) {
                      // Parse the source account to get the token mint
                      try {
                        const sourceAccountInfo = await this.connection.getParsedAccountInfo(sourceAccount);
                        if (sourceAccountInfo.value?.data?.parsed?.info?.mint) {
                          const transferMint = sourceAccountInfo.value.data.parsed.info.mint;
                          const transferMintStr = transferMint.toLowerCase();

                          // Check if this is a wrong token transfer (mint doesn't match expected)
                          if (expectedMintStr && transferMintStr !== expectedMintStr) {
                            console.log('[refundIncorrectTokens] Found wrong token transfer, initiating refund', {
                              signature: sig.signature,
                              wrongMint: transferMint,
                              expectedMint: expectedTokenMint,
                              source: sourceAccount.toBase58(),
                              destination: destAccount.toBase58(),
                            });

                            // Get token decimals
                            let decimals = 6;
                            try {
                              const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(transferMint));
                              if (mintInfo.value?.data?.parsed?.info?.decimals !== undefined) {
                                decimals = mintInfo.value.data.parsed.info.decimals;
                              }
                            } catch (err) {
                              console.warn('Could not get token decimals for wrong token, using default 6');
                            }

                            // Get bot's ATA balance for the wrong token to determine refund amount
                            try {
                              const botATA = await getAssociatedTokenAddress(
                                new PublicKey(transferMint),
                                botPublicKey
                              );

                              const botATAInfo = await this.connection.getParsedAccountInfo(botATA);
                              const balance = botATAInfo.value?.data?.parsed?.info?.tokenAmount?.amount;

                              if (balance && Number(balance) > 0) {
                                const refundAmount = BigInt(balance);
                                
                                // Get sender's ATA for the wrong token
                                const senderPublicKey = new PublicKey(senderAddress);
                                const senderATA = await getAssociatedTokenAddress(
                                  new PublicKey(transferMint),
                                  senderPublicKey
                                );

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
                            } catch (ataErr) {
                              console.error('[refundIncorrectTokens] Error refunding balance', {
                                error: ataErr.message,
                              });
                            }
                          }
                        }
                      } catch (parseErr) {
                        console.warn('Could not parse source account mint:', parseErr.message);
                      }
                    }
                  }
                }
              } catch (instructionErr) {
                console.warn('Error processing instruction for refund:', instructionErr.message);
                continue;
              }
            }
          }
        } catch (err) {
          console.warn('Error processing Solana transaction for refund:', err.message);
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
