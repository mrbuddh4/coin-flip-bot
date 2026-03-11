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
   */
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenAddress = null, knownSender = null) {
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
            
            for (const tx of data.result) {
              const txSenderLower = tx.from.toLowerCase();
              const txRecipientLower = tx.to?.toLowerCase() || '';
              
              // Only process if this is an INCOMING transfer to the bot wallet
              // (recipient is the bot wallet AND sender matches our target)
              if (txRecipientLower === botWalletAddress.toLowerCase() && txSenderLower === targetSender) {
                const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                totalAmount += txAmount;
                if (!latestTxForReturn) latestTxForReturn = tx;
                transfers.push({
                  amount: txAmount,
                  hash: tx.hash,
                  blockNumber: tx.blockNumber,
                });
                
                console.log('[getRecentDepositSender] Matched incoming transaction', {
                  from: txSenderLower,
                  to: txRecipientLower,
                  amount: txAmount,
                  txHash: tx.hash,
                });
              }
            }
            
            if (transfers.length === 0) {
              console.warn('[getRecentDepositSender] No transfers from target sender via Paxscan', { 
                targetSender,
                knownSender,
                transactionsChecked: data.result.length,
                first5FromAddress: data.result.slice(0, 5).map(tx => tx.from.toLowerCase()),
              });
              
              // If knownSender filtering didn't work and this is a retry (knownSender was set),
              // it might be because the transaction hasn't been indexed yet.
              // Fall through to check for most recent ANY transfer as fallback
              if (knownSender) {
                console.warn('[getRecentDepositSender] Known sender had no matches, checking most recent transfer as fallback');
                
                // Get most recent transfer TO bot wallet from ANYONE (for first-time detection)
                for (const tx of data.result) {
                  const txRecipientLower = tx.to?.toLowerCase() || '';
                  if (txRecipientLower === botWalletAddress.toLowerCase()) {
                    const txAmount = parseFloat(ethers.formatUnits(tx.value, decimals));
                    const txSenderLower = tx.from.toLowerCase();
                    
                    console.log('[getRecentDepositSender] Using most recent transfer as fallback', {
                      from: txSenderLower,
                      amount: txAmount,
                      txHash: tx.hash,
                    });
                    
                    return {
                      sender: txSenderLower,
                      amount: txAmount.toString(),
                      transactionHash: tx.hash,
                      blockNumber: tx.blockNumber,
                      transferCount: 1,
                    };
                  }
                }
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
}

module.exports = EVMHandler;
