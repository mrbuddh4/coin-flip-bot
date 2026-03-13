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
  createAssociatedTokenAccountInstruction,
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

      // Check if destination ATA exists - CREATE IT if needed
      try {
        await getAccount(this.connection, toATA);
      } catch (error) {
        // ATA doesn't exist - create it first
        console.log('[transferToken] Destination ATA does not exist, creating:', toATA.toBase58());
        const createATAInstruction = createAssociatedTokenAccountInstruction(
          fromPublicKey,  // Payer (bot will pay for ATA creation)
          toATA,          // ATA to create
          toPublicKey,    // Owner of ATA
          mint            // Token mint
        );
        transaction.add(createATAInstruction);
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

      // Use RPC to get recent signatures from the SENDER (not bot) - fetch up to 2 to reduce rate limiting.
      // Limit to 2 to aggressively avoid hitting RPC rate limits on high-volume verification
      const senderPublicKey = new PublicKey(knownSender);
      const signatures = await this.withExponentialBackoff(() =>
        this.connection.getSignaturesForAddress(senderPublicKey, { limit: 2 })
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
          // Add aggressive delay BEFORE each fetch to avoid rate limiting
          if (i === 0) {
            console.log(`[getRecentDepositSender] Waiting 2s before fetching tx ${i + 1}/${signatures.length}...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Initial 2s delay
          } else {
            console.log(`[getRecentDepositSender] Waiting 3s before fetching tx ${i + 1}/${signatures.length}...`);
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3s between subsequent calls
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

      // Calculate cutoff time for filtering deposits to this specific flip
      let filterByTime = false;
      let cutoffTimestamp = 0;
      if (flipCreatedAt) {
        const createdTime = new Date(flipCreatedAt);
        cutoffTimestamp = Math.floor(createdTime.getTime() / 1000); // Convert to Unix timestamp in seconds
        filterByTime = true;
        console.log('[getRecentDepositSender] Filtering deposits by flip creation time', { 
          flipCreatedAt, 
          cutoffTimestamp,
          createdDateString: createdTime.toISOString() 
        });
      }

      // Collect deposits from sender to bot
      let deposits = [];
      let wrongTokenDeposits = [];

      for (const tx of transactions) {
        try {
          // Skip transactions that happened before this flip was created
          if (filterByTime && tx.blockTime) {
            if (tx.blockTime < cutoffTimestamp) {
              console.log(`[getRecentDepositSender] Skipping tx ${tx.signature.substring(0, 20)} (blockTime ${tx.blockTime} < cutoff ${cutoffTimestamp})`);
              continue;
            }
          }

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

            // Check if transfer is to bot (main wallet or any token ATA owned by bot)
            const isToBot = (accountStr === botWalletAddress || accountStr === expectedBotATAStr || accountStr === correctBotATA);
            
            if (!isToBot) {
              // For ATA accounts, we can't reliably check ownership from transaction data alone
              // So we'll accept transfers to ATAs we haven't explicitly recognized
              // This allows us to receive other SPL tokens as "wrong token"
              const isLikelyBotATA = accountStr.length === expectedBotATAStr.length && 
                                     accountStr.match(/^[1-9A-HJ-NP-Z]{43,44}$/); // Solana base58 address format
              
              if (!isLikelyBotATA) {
                console.log(`[getRecentDepositSender] Transfer NOT to bot. Bot wallet=${botWalletAddress}, Expected ATA=${expectedBotATAStr}, Correct ATA=${correctBotATA}`);
                continue;
              }
              
              console.log(`[getRecentDepositSender] Transfer to unknown bot ATA: ${accountStr} (mint: ${post.mint})`);
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

        // NATIVE SOL CHECK: Also check if native SOL was transferred to the bot's main wallet
        // This catches cases where user sends SOL instead of SID
        try {
          const preBalances = tx.meta?.preBalances || [];
          const postBalances = tx.meta?.postBalances || [];
          const accountKeys = tx.transaction.message.staticAccountKeys || [];

          for (let i = 0; i < accountKeys.length; i++) {
            const accountKey = accountKeys[i].toBase58();
            
            // Check if this is the bot's main wallet (not ATA, the main wallet)
            // botWalletAddress is already a string, compare directly
            if (accountKey === botWalletAddress) {
              const preBalance = preBalances[i] || 0;
              const postBalance = postBalances[i] || 0;
              const solReceived = (postBalance - preBalance) / 1000000000; // Convert lamports to SOL
              
              // Only count if SOL was actually received (and more than just fee refunds)
              if (solReceived > 0.001) { // More than 0.001 SOL to distinguish from fee refunds
                console.log('[getRecentDepositSender] Detected native SOL transfer to bot wallet', {
                  signature: tx.signature,
                  sender: knownSender,
                  solReceived,
                  preBalance,
                  postBalance,
                });

                // Only mark as wrong token if we were expecting an SPL token (not native)
                if (tokenMint && tokenMint !== 'NATIVE') {
                  wrongTokenDeposits.push({
                    sender: knownSender,
                    amount: solReceived.toString(),
                    signature: tx.signature,
                    slot: tx.slot || 0,
                    tokenMint: 'NATIVE', // Native SOL
                    wrongToken: 'NATIVE',
                  });
                  console.log('[getRecentDepositSender] Marked as wrong token: native SOL sent when SID expected', {
                    flipId: 'N/A',
                    sender: knownSender,
                    expectedToken: tokenMint,
                    receivedToken: 'NATIVE',
                  });
                }
              }
            }
          }
        } catch (nativeErr) {
          console.warn('[getRecentDepositSender] Error checking native SOL:', nativeErr.message);
        }
      }

      if (deposits.length > 0) {
        console.log('[getRecentDepositSender] Found matching deposits from sender:', deposits.length);
        // Sum all deposits from sender (handle multiple transfers accumulating)
        const totalAmount = deposits.reduce((sum, dep) => sum + parseFloat(dep.amount), 0);
        console.log('[getRecentDepositSender] Total accumulated from multiple deposits:', { count: deposits.length, total: totalAmount });
        return {
          ...deposits[0], // Use first deposit's metadata
          amount: totalAmount.toString(), // But use the cumulative amount
        };
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

      // Add aggressive delay BEFORE attempting any RPC calls to reduce rate limiting
      console.log('[refundIncorrectTokens] Waiting 5s before querying sender transactions...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Query sender's recent transactions to find any token transfers that DON'T match expected mint
      // Limit to 1 transaction only to minimize RPC calls
      const senderPublicKey = new PublicKey(senderAddress);
      const signatures = await this.withExponentialBackoff(() =>
        this.connection.getSignaturesForAddress(senderPublicKey, { limit: 1 })
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
          // Add aggressive delay BEFORE each transaction fetch to prevent RPC rate limiting
          if (i === 0) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Initial 2s delay
          } else {
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3s between subsequent calls
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

          // NATIVE SOL CHECK: Also look for native SOL transfers to bot's main wallet
          if (expectedTokenMint !== 'NATIVE') { // Only mark as wrong if we were expecting an SPL token
            try {
              const preNativeBalances = tx.meta?.preBalances || [];
              const postNativeBalances = tx.meta?.postBalances || [];
              const accountKeys = tx.transaction.message.staticAccountKeys || [];

              for (let i = 0; i < accountKeys.length; i++) {
                const accountKey = accountKeys[i].toBase58();
                
                // Check if this is the bot's main wallet
                if (accountKey === botWalletAddress) {
                  const preBalance = preNativeBalances[i] || 0;
                  const postBalance = postNativeBalances[i] || 0;
                  const solReceived = (postBalance - preBalance) / 1000000000; // Convert lamports to SOL
                  
                  // Only count if SOL was actually received (and more than just fee refunds)
                  if (solReceived > 0.001) { // More than 0.001 SOL
                    console.log('[refundIncorrectTokens] Found native SOL transfer to bot - will refund as wrong token', {
                      signature: tx.signature,
                      sender: senderAddress,
                      solReceived,
                    });

                    refundsToProcess.push({
                      wrongTokenMint: 'NATIVE', // Mark as native SOL
                      amount: solReceived,
                      senderAddress: senderAddress,
                      signature: tx.signature,
                    });
                  }
                }
              }
            } catch (nativeErr) {
              console.warn('[refundIncorrectTokens] Error checking native SOL:', nativeErr.message);
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

      console.log('[refundIncorrectTokens] Processing wrong token refunds', {
        count: refundsToProcess.length,
        refunds: refundsToProcess.map(r => ({ mint: r.wrongTokenMint, amount: r.amount })),
      });

      // Execute actual refund transfers using SPL Token Program
      const refundResults = [];
      
      for (const refund of refundsToProcess) {
        try {
          console.log('[refundIncorrectTokens] Attempting to refund wrong token', {
            mint: refund.wrongTokenMint,
            amount: refund.amount,
            sender: refund.senderAddress,
          });

          // SPECIAL CASE: Native SOL refund
          if (refund.wrongTokenMint === 'NATIVE') {
            console.log('[refundIncorrectTokens] Refunding native SOL', {
              amount: refund.amount,
              sender: refund.senderAddress,
            });

            try {
              // Convert bot's keypair to Base58 for transferNative
              const botPrivateKeyB58 = bs58.encode(this.wallet.secretKey);
              
              // Use transferNative to send SOL back to sender
              const refundResult = await this.transferNative(
                botPrivateKeyB58,
                refund.senderAddress,
                refund.amount
              );

              console.log('[refundIncorrectTokens] ✅ Successfully refunded native SOL', {
                amount: refund.amount,
                sender: refund.senderAddress,
                signature: refundResult.txHash,
              });

              refundResults.push({
                mint: 'NATIVE',
                amount: refund.amount,
                recipient: refund.senderAddress,
                signature: refundResult.txHash,
                status: 'success',
              });
            } catch (solErr) {
              console.error('[refundIncorrectTokens] Failed to refund native SOL', {
                sender: refund.senderAddress,
                amount: refund.amount,
                error: solErr.message,
              });
              // Continue to next refund
              continue;
            }
            continue; // Skip SPL token logic for native SOL
          }

          // SPL TOKEN REFUND (non-native)

          // Get bot's token account for this wrong token
          const botTokenAccount = await getAssociatedTokenAddress(
            new PublicKey(refund.wrongTokenMint),
            this.botKeypair.publicKey
          );

          // Verify bot has the tokens to refund
          let botTokenAccountExists = false;
          try {
            const botAccount = await getAccount(this.connection, botTokenAccount);
            if (botAccount.amount < BigInt(refund.amount)) {
              console.warn('[refundIncorrectTokens] Bot token account has insufficient balance', {
                mint: refund.wrongTokenMint,
                balance: botAccount.amount.toString(),
                needed: refund.amount.toString(),
              });
              continue; // Skip this refund if insufficient balance
            }
            botTokenAccountExists = true;
          } catch (err) {
            console.warn('[refundIncorrectTokens] Bot token account not found or error checking balance', {
              mint: refund.wrongTokenMint,
              error: err.message,
            });
            continue;
          }

          if (!botTokenAccountExists) {
            continue;
          }

          // Create transfer instruction
          const transferInstruction = createTransferInstruction(
            botTokenAccount,           // from (bot's token account)
            senderTokenAccount,        // to (sender's token account)
            this.botKeypair.publicKey, // owner
            BigInt(refund.amount)      // amount in raw units
          );

          // Create and send transaction
          const transaction = new Transaction().add(transferInstruction);
          transaction.feePayer = this.botKeypair.publicKey;
          transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

          const signature = await this.connection.sendTransaction(transaction, [this.botKeypair], {
            maxRetries: 3,
          });

          // Wait for confirmation with timeout
          const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
          
          if (confirmation.value.err) {
            console.error('[refundIncorrectTokens] Transaction failed', {
              mint: refund.wrongTokenMint,
              signature,
              error: confirmation.value.err,
            });
            continue;
          }

          console.log('[refundIncorrectTokens] ✅ Successfully refunded wrong token', {
            mint: refund.wrongTokenMint,
            amount: refund.amount,
            sender: refund.senderAddress,
            signature,
          });

          refundResults.push({
            mint: refund.wrongTokenMint,
            amount: refund.amount,
            recipient: refund.senderAddress,
            signature,
            status: 'SUCCESS',
          });

        } catch (err) {
          console.error('[refundIncorrectTokens] Failed to process refund', {
            mint: refund.wrongTokenMint,
            sender: refund.senderAddress,
            error: err.message,
            stack: err.stack,
          });

          refundResults.push({
            mint: refund.wrongTokenMint,
            amount: refund.amount,
            recipient: refund.senderAddress,
            status: 'FAILED',
            error: err.message,
          });
        }
      }

      console.log('[refundIncorrectTokens] Refund processing complete', {
        totalAttempted: refundsToProcess.length,
        successful: refundResults.filter(r => r.status === 'SUCCESS').length,
        failed: refundResults.filter(r => r.status === 'FAILED').length,
      });

      return refundResults;
    } catch (error) {
      console.error('[refundIncorrectTokens] Error:', error);
      return [];
    }
  }
}

module.exports = SolanaHandler;
