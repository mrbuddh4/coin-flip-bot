const { ethers } = require('ethers');
const config = require('../config');

class EVMHandler {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);
    this.wallet = new ethers.Wallet(config.evm.privateKey, this.provider);
  }

  /**
   * Check balance of an ERC20 token at an address
   */
  async getTokenBalance(tokenAddress, walletAddress) {
    try {
      // Simple ERC20 ABI for balanceOf
      const erc20ABI = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function transfer(address to, uint256 amount) returns (bool)',
      ];

      const contract = new ethers.Contract(tokenAddress, erc20ABI, this.provider);
      const balance = await contract.balanceOf(walletAddress);
      const decimals = await contract.decimals();

      return {
        raw: balance.toString(),
        formatted: ethers.formatUnits(balance, decimals),
        decimals,
      };
    } catch (error) {
      console.error('Error getting EVM token balance:', error);
      throw error;
    }
  }

  /**
   * Get native ETH balance
   */
  async getNativeBalance(walletAddress) {
    try {
      const balance = await this.provider.getBalance(walletAddress);
      return {
        raw: balance.toString(),
        formatted: ethers.formatEther(balance),
      };
    } catch (error) {
      console.error('Error getting EVM native balance:', error);
      throw error;
    }
  }

  /**
   * Transfer ERC20 token from one wallet to another
   */
  async transferToken(tokenAddress, fromPrivateKey, toAddress, amount, decimals) {
    try {
      const fromWallet = new ethers.Wallet(fromPrivateKey, this.provider);
      const erc20ABI = [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function decimals() view returns (uint8)',
      ];

      const contract = new ethers.Contract(tokenAddress, erc20ABI, fromWallet);
      const amountBN = ethers.parseUnits(amount.toString(), decimals);

      const tx = await contract.transfer(toAddress, amountBN);
      const receipt = await tx.wait();

      return {
        txHash: receipt.transactionHash,
        from: receipt.from,
        to: receipt.to,
        blockNumber: receipt.blockNumber,
        status: receipt.status === 1 ? 'success' : 'failed',
      };
    } catch (error) {
      console.error('Error transferring EVM token:', error);
      throw error;
    }
  }

  /**
   * Transfer native ETH from one wallet to another
   */
  async transferNative(fromPrivateKey, toAddress, amountEth) {
    try {
      const fromWallet = new ethers.Wallet(fromPrivateKey, this.provider);
      const amountBN = ethers.parseEther(amountEth.toString());

      const tx = await fromWallet.sendTransaction({
        to: toAddress,
        value: amountBN,
      });

      const receipt = await tx.wait();

      return {
        txHash: receipt.transactionHash,
        from: receipt.from,
        to: receipt.to,
        blockNumber: receipt.blockNumber,
        status: receipt.status === 1 ? 'success' : 'failed',
      };
    } catch (error) {
      console.error('Error transferring native EVM:', error);
      throw error;
    }
  }

  /**
   * Check transaction status
   */
  async checkTransactionStatus(txHash) {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        return {
          status: 'pending',
          confirmations: 0,
          blockNumber: null,
        };
      }

      const currentBlock = await this.provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber;

      return {
        status: receipt.status === 1 ? 'confirmed' : 'failed',
        confirmations,
        blockNumber: receipt.blockNumber,
        from: receipt.from,
        to: receipt.to,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      console.error('Error checking EVM transaction:', error);
      throw error;
    }
  }

  /**
   * Validate if address is valid EVM format
   */
  isValidAddress(address) {
    return ethers.isAddress(address);
  }

  /**
   * Get gas price
   */
  async getGasPrice() {
    try {
      const feeData = await this.provider.getFeeData();
      return {
        gasPrice: ethers.formatUnits(feeData.gasPrice, 'gwei'),
        maxFeePerGas: feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, 'gwei') : null,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : null,
      };
    } catch (error) {
      console.error('Error getting EVM gas price:', error);
      throw error;
    }
  }

  /**
   * Find the sender of a recent incoming transaction to the bot wallet
   * Uses Paxscan API only - RPC has too many restrictions on Paxeer
   * @param {number} flipCreatedAt - Unix timestamp when flip was created, to filter out old deposits
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenAddress = null, knownSender = null, flipCreatedAt = null) {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const lookbackBlocks = 10000; // Paxscan doesn't have RPC restrictions
      const fromBlock = Math.max(0, currentBlock - lookbackBlocks);
      
      // Declare once at function scope so all queries (main, fallback 1, fallback 2, fallback 3) can access
      const flipCreatedAtSeconds = flipCreatedAt ? Math.floor(flipCreatedAt / 1000) : null;

      console.log('[getRecentDepositSender] Searching for deposits', {
        botWallet: botWalletAddress,
        token: tokenAddress,
        expectedAmount,
        knownSender,
        fromBlock,
        toBlock: currentBlock,
        blockRange: currentBlock - fromBlock,
        flipCreatedAt,
        method: 'Paxscan API only (RPC skipped)',
      });

      if (tokenAddress && tokenAddress !== 'NATIVE') {
        // Get token decimals
        const erc20ABI = ['function decimals() view returns (uint8)'];
        const contract = new ethers.Contract(tokenAddress, erc20ABI, this.provider);
        
        let decimals = 18;
        try {
          decimals = await contract.decimals();
          console.log('[getRecentDepositSender] Got token decimals', { tokenAddress, decimals });
        } catch (err) {
          console.warn('[getRecentDepositSender] Could not get token decimals, assuming 18', { error: err.message });
        }
        
        // Use Paxscan API directly
        try {
          // First query: Look for transfers of the EXPECTED token only
          let paxscanUrl;
          let response;
          let data;
          let queriedAllTokens = false;
          
          // Special handling: if looking for a CONTRACT token but none found, also check native transfers
          // This catches cases where user sends native token (PAX) instead of ERC20 (SID)
          if (tokenAddress && tokenAddress !== 'NATIVE') {
            paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=tokentx&address=${botWalletAddress}&contractaddress=${tokenAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
            
            console.log('[getRecentDepositSender] Querying Paxscan API for expected token', { url: paxscanUrl });
            
            response = await fetch(paxscanUrl);
            data = await response.json();
            
            console.log('[getRecentDepositSender] Paxscan API response (expected token)', {
              status: data.status,
              message: data.message,
              resultCount: data.result?.length || 0,
            });
            
            // If no ERC20 transfers found, query ALL tokens to find wrong ERC20 transfers
            if ((!data.result || data.result.length === 0) && data.status === '1') {
              console.log('[getRecentDepositSender] No transfers of expected token found, querying for ALL token transfers to detect wrong tokens', {
                expectedToken: tokenAddress.toLowerCase(),
              });
              
              paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=tokentx&address=${botWalletAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
              console.log('[getRecentDepositSender] Querying Paxscan API for all ERC20 tokens (wrong token detection)', { url: paxscanUrl });
              
              response = await fetch(paxscanUrl);
              data = await response.json();
              queriedAllTokens = true;
              
              console.log('[getRecentDepositSender] Paxscan API response (all ERC20 tokens)', {
                status: data.status,
                message: data.message,
                resultCount: data.result?.length || 0,
              });
            }
            
            // If STILL no ERC20 transfers, check for native transfers
            if ((!data.result || data.result.length === 0) && data.status === '1') {
              console.log('[getRecentDepositSender] No ERC20 transfers found, checking for native token transfers (PAX)', {
                expectedToken: tokenAddress.toLowerCase(),
              });
              
              paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=txlist&address=${botWalletAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
              console.log('[getRecentDepositSender] Querying Paxscan API for native transfers', { url: paxscanUrl });
              
              response = await fetch(paxscanUrl);
              data = await response.json();
              
              console.log('[getRecentDepositSender] Paxscan API response (native transfers)', {
                status: data.status,
                message: data.message,
                resultCount: data.result?.length || 0,
              });
            }
          } else if (tokenAddress === 'NATIVE') {
            // Looking for native transfers directly
            paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=txlist&address=${botWalletAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
            console.log('[getRecentDepositSender] Querying Paxscan API for native token transfers', { url: paxscanUrl });
            
            response = await fetch(paxscanUrl);
            data = await response.json();
            
            console.log('[getRecentDepositSender] Paxscan API response (native transfers)', {
              status: data.status,
              message: data.message,
              resultCount: data.result?.length || 0,
            });
          }

          if (data.status === '1' && data.result && data.result.length > 0) {
            // Determine which sender to look for
            let targetSender;
            if (knownSender) {
              targetSender = knownSender.toLowerCase();
            } else {
              const latestTx = data.result[0];
              targetSender = latestTx.from.toLowerCase();
            }
            
            // Detect if these are native transfers (txlist) vs token transfers (tokentx)
            const isNativeTransferResult = !data.result[0].contractAddress; // Native transfers don't have contractAddress
            
            console.log('[getRecentDepositSender] Paxscan filtering results', {
              targetSender,
              knownSenderProvided: !!knownSender,
              totalTransactions: data.result.length,
              queriedAllTokens, // Log which query we used
              isNativeTransferResult,
              transactionsFromAddresses: data.result.map(tx => tx.from.toLowerCase()),
              first5Transactions: data.result.slice(0, 5).map(tx => ({
                from: tx.from,
                to: tx.to,
                value: tx.value,
                hash: tx.hash,
                contractAddress: tx.contractAddress,
              })),
            });
            
            // Sum ALL transfers from target sender
            let totalAmount = 0;
            let latestTxForReturn = null;
            const transfers = [];
            
            for (const tx of data.result) {
              const txSenderLower = tx.from.toLowerCase();
              const txRecipientLower = tx.to?.toLowerCase() || '';
              const txTimestamp = parseInt(tx.timeStamp, 10);
              const txContractAddressLower = tx.contractAddress?.toLowerCase() || '';
              
              // Only process if this is an INCOMING transfer to the bot wallet
              // AND sender matches our target AND tx happened after flip was created
              const isValidSender = txRecipientLower === botWalletAddress.toLowerCase() && txSenderLower === targetSender;
              const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;
              const isCorrectToken = txContractAddressLower === tokenAddress.toLowerCase();
              
              // CRITICAL: Accept wrong ERC20 tokens if we did all-tokens query, or native transfers
              const shouldAcceptWrongToken = queriedAllTokens && !isCorrectToken;
              const isNativeTransfer = isNativeTransferResult && !txContractAddressLower;
              const shouldAccept = isCorrectToken || shouldAcceptWrongToken || isNativeTransfer;
              
              if (isValidSender && isAfterFlipCreation && shouldAccept) {
                // For native transfers, use decimals 18; for token transfers use provided decimals
                const transferDecimals = isNativeTransfer ? 18 : decimals;
                const txAmount = parseFloat(ethers.formatUnits(tx.value, transferDecimals));
                totalAmount += txAmount;
                if (!latestTxForReturn) latestTxForReturn = tx;
                transfers.push({
                  amount: txAmount,
                  hash: tx.hash,
                  blockNumber: tx.blockNumber,
                  timestamp: txTimestamp,
                  contractAddress: txContractAddressLower || 'NATIVE',
                  isNativeTransfer,
                  wrongToken: (!isCorrectToken && !isNativeTransfer) ? txContractAddressLower : null,
                });
                
                console.log('[getRecentDepositSender] Matched incoming transaction', {
                  from: txSenderLower,
                  to: txRecipientLower,
                  amount: txAmount,
                  txHash: tx.hash,
                  timestamp: txTimestamp,
                  isAfterFlipCreation,
                  contractAddress: txContractAddressLower,
                  expectedToken: tokenAddress.toLowerCase(),
                });
              }
            }
            
            if (transfers.length === 0) {
              console.warn('[getRecentDepositSender] No transfers from target sender via current query', { 
                targetSender,
                knownSender,
                transactionsChecked: data.result.length,
                currentQuery: queriedAllTokens ? 'all-tokens' : 'expected-token-only',
              });
              
              // CRITICAL FIX: If we have a knownSender (e.g., challenger's known wallet), 
              // we still need to check native transfers before giving up
              
              // If we only queried the expected token, now query all ERC20s (no contract filter)
              if (!queriedAllTokens && tokenAddress && tokenAddress !== 'NATIVE') {
                console.log('[getRecentDepositSender] Fallback 1: Querying ALL ERC20 tokens (no contract filter)', {
                  targetSender,
                  expectedToken: tokenAddress.toLowerCase(),
                });
                
                const paxscanUrlAllTokens = `https://paxscan.paxeer.app/api?module=account&action=tokentx&address=${botWalletAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
                
                try {
                  const allTokensResponse = await fetch(paxscanUrlAllTokens);
                  const allTokensData = await allTokensResponse.json();
                  
                  console.log('[getRecentDepositSender] Paxscan API response (all ERC20 tokens fallback)', {
                    status: allTokensData.status,
                    message: allTokensData.message,
                    resultCount: allTokensData.result?.length || 0,
                  });
                  
                  // Try to find transfers from target sender in the all-tokens result
                  if (allTokensData.status === '1' && allTokensData.result && allTokensData.result.length > 0) {
                    console.log('[getRecentDepositSender] DEBUG - All ERC20 tokens query has results', {
                      total: allTokensData.result.length,
                      targetSender,
                      botWalletAddress: botWalletAddress.toLowerCase(),
                      flipCreatedAtSeconds,
                      firstFive: allTokensData.result.slice(0, 5).map(tx => ({
                        from: tx.from,
                        to: tx.to,
                        value: tx.value,
                        contractAddress: tx.contractAddress,
                        timeStamp: tx.timeStamp,
                        hash: tx.hash,
                      })),
                    });
                    
                    for (const tx of allTokensData.result) {
                      const txSenderLower = tx.from.toLowerCase();
                      const txRecipientLower = tx.to?.toLowerCase() || '';
                      const txTimestamp = parseInt(tx.timeStamp, 10);
                      const txContractAddressLower = tx.contractAddress?.toLowerCase() || '';
                      
                      const isValidSender = txRecipientLower === botWalletAddress.toLowerCase() && txSenderLower === targetSender;
                      const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;
                      
                      if (isValidSender && isAfterFlipCreation) {
                        const transferDecimals = 6; // Assume 6 decimals for ERC20s (SID/other tokens)
                        const txAmount = parseFloat(ethers.formatUnits(tx.value, transferDecimals));
                        totalAmount += txAmount;
                        if (!latestTxForReturn) latestTxForReturn = tx;
                        transfers.push({
                          amount: txAmount,
                          hash: tx.hash,
                          blockNumber: tx.blockNumber,
                          timestamp: txTimestamp,
                          contractAddress: txContractAddressLower,
                          isNativeTransfer: false,
                          wrongToken: txContractAddressLower !== tokenAddress.toLowerCase() ? txContractAddressLower : null,
                        });
                      }
                    }
                  }
                } catch (fallbackErr) {
                  console.error('[getRecentDepositSender] Fallback all-tokens query failed', { error: fallbackErr.message });
                }
              }
              
              // If still no transfers found, query NATIVE transfers (txlist API)
              if (transfers.length === 0 && tokenAddress !== 'NATIVE') {
                console.log('[getRecentDepositSender] Fallback 2: Querying NATIVE transfers (PAX)', {
                  targetSender,
                  botWallet: botWalletAddress,
                });
                
                const paxscanUrlNative = `https://paxscan.paxeer.app/api?module=account&action=txlist&address=${botWalletAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
                
                try {
                  const nativeResponse = await fetch(paxscanUrlNative);
                  const nativeData = await nativeResponse.json();
                  
                  console.log('[getRecentDepositSender] Paxscan API response (native transfers fallback)', {
                    status: nativeData.status,
                    message: nativeData.message,
                    resultCount: nativeData.result?.length || 0,
                  });
                  
                  // Debug: Log all native transactions
                  console.log('[getRecentDepositSender] DEBUG - All native transactions in response', {
                    total: nativeData.result.length,
                    targetSender,
                    botWalletAddress: botWalletAddress.toLowerCase(),
                    flipCreatedAtSeconds,
                    firstFive: nativeData.result.slice(0, 5).map(tx => ({
                      from: tx.from,
                      to: tx.to,
                      value: tx.value,
                      timeStamp: tx.timeStamp,
                      hash: tx.hash,
                    })),
                  });
                  
                  // Try to find native transfers from target sender
                  if (nativeData.status === '1' && nativeData.result && nativeData.result.length > 0) {
                    for (const tx of nativeData.result) {
                      const txSenderLower = tx.from.toLowerCase();
                      const txRecipientLower = tx.to?.toLowerCase() || '';
                      const txTimestamp = parseInt(tx.timeStamp, 10);
                      
                      const isValidSender = txRecipientLower === botWalletAddress.toLowerCase() && txSenderLower === targetSender;
                      const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;
                      
                      // Debug log each transaction check
                      if (txSenderLower === targetSender || txRecipientLower === botWalletAddress.toLowerCase()) {
                        console.log('[getRecentDepositSender] DEBUG - Checking native tx', {
                          from: txSenderLower,
                          to: txRecipientLower,
                          value: tx.value,
                          timestamp: txTimestamp,
                          isValidSender,
                          isAfterFlipCreation,
                          targetSender,
                          botWalletAddress: botWalletAddress.toLowerCase(),
                        });
                      }
                      
                      if (isValidSender && isAfterFlipCreation) {
                        const txAmount = parseFloat(ethers.formatUnits(tx.value, 18)); // Native transfers use 18 decimals
                        totalAmount += txAmount;
                        if (!latestTxForReturn) latestTxForReturn = tx;
                        transfers.push({
                          amount: txAmount,
                          hash: tx.hash,
                          blockNumber: tx.blockNumber,
                          timestamp: txTimestamp,
                          contractAddress: 'NATIVE',
                          isNativeTransfer: true,
                          wrongToken: 'NATIVE', // Native PAX is "wrong" when SID was expected
                        });
                        
                        console.log('[getRecentDepositSender] Found native transfer from target sender', {
                          sender: txSenderLower,
                          amount: txAmount,
                          txHash: tx.hash,
                        });
                      }
                    }
                  }
                } catch (fallbackErr) {
                  console.error('[getRecentDepositSender] Fallback native-transfer query failed', { error: fallbackErr.message });
                }
              }
              
              // If knownSender and still no transfers found, reject to prevent fraud
              if (transfers.length === 0 && knownSender) {
                console.warn('[getRecentDepositSender] Known sender specified but no deposits found at all (checked tokens + native) - rejecting', {
                  knownSender,
                  botWalletAddress,
                  expectedToken: tokenAddress.toLowerCase(),
                });
                return null;
              }
              
              // Fallback: accumulate ALL recent incoming transfers to bot wallet that are after flip creation
              // This handles multi-deposit scenarios where user sends from same wallet in succession
              // ONLY used when knownSender is NOT specified (i.e., we don't know who should deposit)
              let fallbackTotal = 0;
              let fallbackLatestTx = null;
              let fallbackSender = null;
              const fallbackTransfers = [];
              
              for (const tx of data.result) {
                const txRecipientLower = tx.to?.toLowerCase() || '';
                const txTimestamp = parseInt(tx.timeStamp, 10);
                const txContractAddressLower = tx.contractAddress?.toLowerCase() || '';
                const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;
                
                // CRITICAL: Verify the transfer is from the expected token contract
                const isCorrectToken = txContractAddressLower === tokenAddress.toLowerCase();
                
                if (txRecipientLower === botWalletAddress.toLowerCase() && isAfterFlipCreation && isCorrectToken) {
                  const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                  const txSenderLower = tx.from.toLowerCase();
                  
                  // Use first incoming sender if not set yet
                  if (!fallbackSender) {
                    fallbackSender = txSenderLower;
                  }
                  
                  // Only accumulate if from same sender (first incoming sender)
                  if (txSenderLower === fallbackSender) {
                    fallbackTotal += txAmount;
                    if (!fallbackLatestTx) fallbackLatestTx = tx;
                    fallbackTransfers.push({
                      from: txSenderLower,
                      amount: txAmount,
                      hash: tx.hash,
                      timestamp: txTimestamp,
                      contractAddress: txContractAddressLower,
                    });
                  }
                }
              }
              
              if (fallbackTransfers.length > 0) {
                console.log('[getRecentDepositSender] Fallback - accumulated transfers', {
                  sender: fallbackSender,
                  totalAmount: fallbackTotal,
                  transferCount: fallbackTransfers.length,
                  expectedToken: tokenAddress.toLowerCase(),
                  transfers: fallbackTransfers,
                });
                
                return {
                  sender: fallbackSender,
                  amount: fallbackTotal.toString(),
                  transactionHash: fallbackLatestTx.hash,
                  blockNumber: fallbackLatestTx.blockNumber,
                  transferCount: fallbackTransfers.length,
                };
              }
              
              // CRITICAL: If still no transfers found, search for ANY transfers to bot (including wrong tokens)
              // This helps refund incorrect tokens even if they don't match the expected token
              console.log('[getRecentDepositSender] No correct-token transfers found, searching for ANY transfers to bot for refund purposes', {
                botWalletAddress: botWalletAddress.toLowerCase(),
                expectedToken: tokenAddress.toLowerCase(),
              });
              
              for (const tx of data.result) {
                const txRecipientLower = tx.to?.toLowerCase() || '';
                const txTimestamp = parseInt(tx.timeStamp, 10);
                const txSenderLower = tx.from.toLowerCase();
                const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;
                
                // Find ANY incoming transfer to bot after flip creation (for refund purposes)
                if (txRecipientLower === botWalletAddress.toLowerCase() && isAfterFlipCreation) {
                  const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                  const wrongTokenAddress = tx.contractAddress?.toLowerCase() || '';
                  
                  console.log('[getRecentDepositSender] Found transfer with WRONG token - returning sender for refund', {
                    sender: txSenderLower,
                    amount: txAmount,
                    wrongToken: wrongTokenAddress,
                    expectedToken: tokenAddress.toLowerCase(),
                    txHash: tx.hash,
                  });
                  
                  return {
                    sender: txSenderLower,
                    amount: txAmount.toString(),
                    transactionHash: tx.hash,
                    blockNumber: tx.blockNumber,
                    wrongToken: wrongTokenAddress, // Flag this as wrong token for refund handling
                  };
                }
              }
              
              return null;
            }
            
            console.log('[getRecentDepositSender] Successfully found transfers', {
              sender: targetSender,
              knownSenderProvided: !!knownSender,
              transferCount: transfers.length,
              totalAmount,
              queriedAllTokens, // Include flag showing we had to query all tokens
              hasWrongTokens: transfers.some(t => t.wrongToken), // Flag if any wrong tokens present
              transfers, // Include full transfer details for debugging
            });

            return {
              sender: targetSender,
              amount: totalAmount.toString(),
              transactionHash: latestTxForReturn.hash,
              blockNumber: latestTxForReturn.blockNumber,
              transferCount: transfers.length,
              hasWrongTokens: transfers.some(t => t.wrongToken), // Include flag in return
            };
          } else {
            console.warn('[getRecentDepositSender] No transfers found via Paxscan API', {
              status: data.status,
              message: data.message,
            });
          }
        } catch (paxscanErr) {
          console.error('[getRecentDepositSender] Paxscan API query failed', { error: paxscanErr.message });
        }
      }

      return null;
    } catch (error) {
      console.error('[getRecentDepositSender] Error:', error.message);
      return null;
    }
  }

  /**
   * Find and refund incorrect token transfers (tokens that don't match the expected contract)
   */
  async refundIncorrectTokens(botWalletAddress, expectedTokenAddress, senderAddress, flipCreatedAt = null) {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const lookbackBlocks = 10000;
      const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

      console.log('[refundIncorrectTokens] Searching for incorrect token transfers', {
        botWallet: botWalletAddress,
        expectedToken: expectedTokenAddress,
        sender: senderAddress,
        fromBlock,
        toBlock: currentBlock,
      });

      try {
        const paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=tokentx&address=${botWalletAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
        
        const response = await fetch(paxscanUrl);
        const data = await response.json();

        console.log('[refundIncorrectTokens] Paxscan response', {
          status: data.status,
          resultCount: data.result?.length || 0,
        });

        if (data.status === '1' && data.result && data.result.length > 0) {
          const senderLower = senderAddress.toLowerCase();
          const expectedTokenLower = expectedTokenAddress.toLowerCase();
          const botWalletLower = botWalletAddress.toLowerCase();
          const incorrectTransfers = [];

          for (const tx of data.result) {
            const txSenderLower = tx.from.toLowerCase();
            const txRecipientLower = tx.to?.toLowerCase() || '';
            const txContractAddressLower = tx.contractAddress?.toLowerCase() || '';
            const txTimestamp = parseInt(tx.timeStamp, 10);
            
            // Find transfers TO the bot FROM the user that are INCORRECT tokens
            const isFromSender = txSenderLower === senderLower;
            const isToBotWallet = txRecipientLower === botWalletLower;
            const isIncorrectToken = txContractAddressLower !== expectedTokenLower;
            const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;

            if (isFromSender && isToBotWallet && isIncorrectToken && isAfterFlipCreation) {
              incorrectTransfers.push({
                tokenAddress: txContractAddressLower,
                amount: tx.value,
                txHash: tx.hash,
                sender: txSenderLower,
              });
            }
          }

          if (incorrectTransfers.length > 0) {
            console.log('[refundIncorrectTokens] Found incorrect token transfers to refund', {
              count: incorrectTransfers.length,
              transfers: incorrectTransfers,
            });

            // Refund each incorrect token
            const refundResults = [];
            for (const transfer of incorrectTransfers) {
              try {
                // Get token decimals
                const erc20ABI = ['function decimals() view returns (uint8)'];
                const contract = new ethers.Contract(transfer.tokenAddress, erc20ABI, this.provider);
                let decimals = 18;
                
                try {
                  decimals = await contract.decimals();
                } catch (err) {
                  console.warn('[refundIncorrectTokens] Could not get token decimals, assuming 18', { tokenAddress: transfer.tokenAddress });
                }

                // Send the token back to sender
                const amountFormatted = ethers.formatUnits(transfer.amount, decimals);
                const result = await this.transferToken(
                  transfer.tokenAddress,
                  config.evm.privateKey,
                  senderAddress,
                  amountFormatted,
                  decimals
                );

                refundResults.push({
                  tokenAddress: transfer.tokenAddress,
                  amount: amountFormatted,
                  refundTxHash: result.txHash,
                  status: 'success',
                });

                console.log('[refundIncorrectTokens] Refunded incorrect token', {
                  tokenAddress: transfer.tokenAddress,
                  amount: amountFormatted,
                  refundTxHash: result.txHash,
                  recipient: senderAddress,
                });
              } catch (refundErr) {
                console.error('[refundIncorrectTokens] Failed to refund token', {
                  tokenAddress: transfer.tokenAddress,
                  error: refundErr.message,
                });

                refundResults.push({
                  tokenAddress: transfer.tokenAddress,
                  amount: ethers.formatUnits(transfer.amount, 18),
                  status: 'failed',
                  error: refundErr.message,
                });
              }
            }

            return refundResults;
          } else {
            console.log('[refundIncorrectTokens] No incorrect token transfers found');
            return [];
          }
        }
      } catch (paxscanErr) {
        console.error('[refundIncorrectTokens] Paxscan API query failed', { error: paxscanErr.message });
      }

      return [];
    } catch (error) {
      console.error('[refundIncorrectTokens] Error:', error.message);
      return [];
    }
  }
}

module.exports = EVMHandler;
