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
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenAddress = null, knownSender = null) {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      // Paxeer has very strict RPC limits - use 2-block window for reliability
      // This covers pending + 1 recent block, which is enough for most use cases
      const lookbackBlocks = 2; 
      const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

      console.log('[getRecentDepositSender] Searching for deposits', {
        botWallet: botWalletAddress,
        token: tokenAddress,
        expectedAmount,
        knownSender,
        fromBlock,
        toBlock: currentBlock,
        blockRange: currentBlock - fromBlock,
      });

      if (tokenAddress && tokenAddress !== 'NATIVE') {
        // For ERC20, look for Transfer events
        const erc20ABI = [
          'function decimals() view returns (uint8)',
          'event Transfer(address indexed from, address indexed to, uint256 value)',
        ];
        const contract = new ethers.Contract(tokenAddress, erc20ABI, this.provider);
        
        // Get token decimals - declare outside try so it's available in catch block
        let decimals = 18;
        try {
          decimals = await contract.decimals();
          console.log('[getRecentDepositSender] Got token decimals', { tokenAddress, decimals });
        } catch (err) {
          console.warn('[getRecentDepositSender] Could not get token decimals, assuming 18', { error: err.message });
        }
        
        try {
          const events = await contract.queryFilter(
            contract.filters.Transfer(null, botWalletAddress),
            fromBlock,
            currentBlock
          );

          console.log('[getRecentDepositSender] Query results', { 
            eventsFound: events.length,
            queryFilter: `Transfer(null, ${botWalletAddress})`,
          });

          if (events.length > 0) {
            // Identify the sender to look for
            const latestEvent = events[events.length - 1];
            // EVM addresses: always normalize to lowercase for consistent comparison
            let targetSender = (knownSender || latestEvent.args.from).toLowerCase();
            
            console.log('[getRecentDepositSender] Processing events', { 
              eventsFound: events.length,
              targetSender,
              knownSenderProvided: !!knownSender,
            });
            
            if (knownSender) {
              // If a known sender is provided, accumulate ALL transfers from that sender
              let totalAmount = 0n;
              let transfers = [];
              
              console.log('[getRecentDepositSender] Filtering events for known sender', {
                targetSender,
                totalEventsFound: events.length,
                eventsFromAddresses: events.map(e => e.args.from.toLowerCase()),
              });
              
              for (const event of events) {
                const eventSenderLower = event.args.from.toLowerCase();
                console.log('[getRecentDepositSender] Comparing event sender', {
                  eventSender: eventSenderLower,
                  targetSender,
                  matches: eventSenderLower === targetSender,
                });
                
                if (eventSenderLower === targetSender) {
                  totalAmount += event.args.value;
                  transfers.push({
                    amount: ethers.formatUnits(event.args.value, decimals),
                    txHash: event.transactionHash,
                    blockNumber: event.blockNumber,
                  });
                }
              }
              
              if (transfers.length === 0) {
                console.warn('[getRecentDepositSender] No transfers found from known sender', { 
                  knownSender,
                  targetSender,
                  eventsChecked: events.length,
                });
                return null;
              }
              
              const totalFormatted = ethers.formatUnits(totalAmount, decimals);
              console.log('[getRecentDepositSender] Accumulated transfers from known sender', { 
                sender: targetSender,
                transferCount: transfers.length,
                totalAmount: totalFormatted,
              });
              
              return {
                sender: targetSender,
                amount: totalFormatted,
                transactionHash: transfers[0].txHash,
                blockNumber: transfers[0].blockNumber,
              };
            } else {
              // If no known sender, just return the most recent transfer (no accumulation)
              const amount = ethers.formatUnits(latestEvent.args.value, decimals);
              
              console.log('[getRecentDepositSender] Found recent transfer (no accumulation)', { 
                sender: targetSender,
                amount,
                txHash: latestEvent.transactionHash,
                blockNumber: latestEvent.blockNumber,
              });
              
              return {
                sender: targetSender,
                amount: amount,
                transactionHash: latestEvent.transactionHash,
                blockNumber: latestEvent.blockNumber,
              };
            }
          } else {
            console.warn('[getRecentDepositSender] No Transfer events found via queryFilter, trying Paxscan API fallback', {
              botWallet: botWalletAddress,
              tokenAddress,
            });
            
            // Fallback: Check Paxscan API for recent token transfers
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
                  // If known sender provided, use that (for multi-deposit accumulation)
                  targetSender = knownSender.toLowerCase();
                } else {
                  // Otherwise, use the most recent transfer's sender (first detection)
                  const latestTx = data.result[0];
                  targetSender = latestTx.from.toLowerCase();
                }
                
                console.log('[getRecentDepositSender] Paxscan filtering results', {
                  targetSender,
                  knownSenderProvided: !!knownSender,
                  totalTransactions: data.result.length,
                  transactionsFromAddresses: data.result.map(tx => tx.from.toLowerCase()),
                });
                
                // Sum ALL transfers from target sender
                let totalAmount = 0;
                let latestTxForReturn = null;
                const transfers = [];
                
                for (const tx of data.result) {
                  const txSenderLower = tx.from.toLowerCase();
                  console.log('[getRecentDepositSender] Paxscan comparing transaction', {
                    txSender: txSenderLower,
                    targetSender,
                    matches: txSenderLower === targetSender,
                    txHash: tx.hash,
                  });
                  
                  if (txSenderLower === targetSender) {
                    const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                    totalAmount += txAmount;
                    if (!latestTxForReturn) latestTxForReturn = tx; // Keep track of first match for return
                    transfers.push({
                      amount: txAmount,
                      hash: tx.hash,
                      blockNumber: tx.blockNumber,
                    });
                  }
                }
                
                if (transfers.length === 0) {
                  console.warn('[getRecentDepositSender] No transfers from target sender via Paxscan', { 
                    targetSender,
                    knownSender,
                    transactionsChecked: data.result.length,
                  });
                  return null;
                }
                
                console.log('[getRecentDepositSender] Found transfers via Paxscan', {
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
              console.error('[getRecentDepositSender] Paxscan API fallback failed', { error: paxscanErr.message });
            }
          }
        } catch (queryErr) {
          console.error('[getRecentDepositSender] Error querying events, trying Paxscan API', { 
            error: queryErr.message,
            tokenAddress,
            botWalletAddress,
          });
          
          // Try Paxscan fallback if queryFilter fails
          try {
            const paxscanUrl = `https://paxscan.paxeer.app/api?module=account&action=tokentx&address=${botWalletAddress}&contractaddress=${tokenAddress}&startblock=${fromBlock}&endblock=${currentBlock}&sort=desc`;
            
            const response = await fetch(paxscanUrl);
            const data = await response.json();

            if (data.status === '1' && data.result && data.result.length > 0) {
              // Determine which sender to look for
              let targetSender;
              if (knownSender) {
                // If known sender provided, use that (for multi-deposit accumulation)
                targetSender = knownSender.toLowerCase();
              } else {
                // Otherwise, use the most recent transfer's sender (first detection)
                const latestTx = data.result[0];
                targetSender = latestTx.from.toLowerCase();
              }
              
              // Sum all transfers from target sender
              let totalAmount = 0;
              let latestTxForReturn = null;
              const transfers = [];
              
              for (const tx of data.result) {
                if (tx.from.toLowerCase() === targetSender) {
                  const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                  totalAmount += txAmount;
                  if (!latestTxForReturn) latestTxForReturn = tx;
                  transfers.push({
                    amount: txAmount,
                    hash: tx.hash,
                  });
                }
              }
              
              if (transfers.length === 0) {
                console.warn('[getRecentDepositSender] No transfers from target sender via Paxscan (after queryFilter failure)', { 
                  targetSender,
                  knownSender,
                  transactionsChecked: data.result.length,
                });
                // Fall through to return null
              } else {
                console.log('[getRecentDepositSender] Found transfers via Paxscan (after queryFilter failure)', {
                  targetSender,
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
              }
            }
            } catch (paxscanErr) {
              console.error('[getRecentDepositSender] Paxscan API fallback also failed', { error: paxscanErr.message });
            }
        }
      }

      return null;
    } catch (error) {
      console.error('[getRecentDepositSender] Error:', error.message);
      return null;
    }
  }
}

module.exports = EVMHandler;
