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
          const paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=tokentx&address=${botWalletAddress}&contractaddress=${tokenAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
          
          console.log('[getRecentDepositSender] Querying Paxscan API', { url: paxscanUrl });
          
          const response = await fetch(paxscanUrl);
          const data = await response.json();
          
          console.log('[getRecentDepositSender] Paxscan API response', {
            status: data.status,
            message: data.message,
            resultCount: data.result?.length || 0,
          });

          if (data.status === '1' && data.result && data.result.length > 0) {
            // Determine which sender to look for
            let targetSender;
            if (knownSender) {
              targetSender = knownSender.toLowerCase();
            } else {
              const latestTx = data.result[0];
              targetSender = latestTx.from.toLowerCase();
            }
            
            console.log('[getRecentDepositSender] Paxscan filtering results', {
              targetSender,
              knownSenderProvided: !!knownSender,
              totalTransactions: data.result.length,
              transactionsFromAddresses: data.result.map(tx => tx.from.toLowerCase()),
              first5Transactions: data.result.slice(0, 5).map(tx => ({
                from: tx.from,
                to: tx.to,
                value: tx.value,
                hash: tx.hash,
              })),
            });
            
            // Sum ALL transfers from target sender
            let totalAmount = 0;
            let latestTxForReturn = null;
            const transfers = [];
            const flipCreatedAtSeconds = flipCreatedAt ? Math.floor(flipCreatedAt / 1000) : null;
            
            for (const tx of data.result) {
              const txSenderLower = tx.from.toLowerCase();
              const txRecipientLower = tx.to?.toLowerCase() || '';
              const txTimestamp = parseInt(tx.timeStamp, 10);
              const txContractAddressLower = tx.contractAddress?.toLowerCase() || '';
              
              // Only process if this is an INCOMING transfer to the bot wallet
              // AND sender matches our target AND tx happened after flip was created
              // AND it's from the correct token contract
              const isValidSender = txRecipientLower === botWalletAddress.toLowerCase() && txSenderLower === targetSender;
              const isAfterFlipCreation = !flipCreatedAtSeconds || txTimestamp >= flipCreatedAtSeconds;
              const isCorrectToken = txContractAddressLower === tokenAddress.toLowerCase();
              
              if (isValidSender && isAfterFlipCreation && isCorrectToken) {
                const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                totalAmount += txAmount;
                if (!latestTxForReturn) latestTxForReturn = tx;
                transfers.push({
                  amount: txAmount,
                  hash: tx.hash,
                  blockNumber: tx.blockNumber,
                  timestamp: txTimestamp,
                  contractAddress: txContractAddressLower,
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
              console.warn('[getRecentDepositSender] No transfers from target sender via Paxscan', { 
                targetSender,
                knownSender,
                transactionsChecked: data.result.length,
              });
              
              // Fallback: accumulate ALL recent incoming transfers to bot wallet that are after flip creation
              // This handles multi-deposit scenarios where user sends from same wallet in succession
              let fallbackTotal = 0;
              let fallbackLatestTx = null;
              let fallbackSender = null;
              const fallbackTransfers = [];
              const flipCreatedAtSeconds = flipCreatedAt ? Math.floor(flipCreatedAt / 1000) : null;
              
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
              
              return null;
            }
            
            console.log('[getRecentDepositSender] Successfully found transfers', {
              sender: targetSender,
              knownSenderProvided: !!knownSender,
              transferCount: transfers.length,
              totalAmount,
            });

            return {
              sender: targetSender,
              amount: totalAmount.toString(),
              transactionHash: latestTxForReturn.hash,
              blockNumber: latestTxForReturn.blockNumber,
              transferCount: transfers.length,
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
          const flipCreatedAtSeconds = flipCreatedAt ? Math.floor(flipCreatedAt / 1000) : null;
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
