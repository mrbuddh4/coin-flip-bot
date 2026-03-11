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
  async getRecentDepositSender(botWalletAddress, expectedAmount, tokenAddress = null) {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const lookbackBlocks = 5000; // Check recent blocks
      const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

      console.log('[getRecentDepositSender] Searching for deposits', {
        botWallet: botWalletAddress,
        token: tokenAddress,
        expectedAmount,
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
        
        // Get token decimals
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
            // Get the most recent transfer (last in array) - don't filter by amount
            const latestEvent = events[events.length - 1];
            const amount = ethers.formatUnits(latestEvent.args.value, decimals);
            
            console.log('[getRecentDepositSender] Found latest transfer', { 
              from: latestEvent.args.from,
              to: latestEvent.args.to,
              amount,
              txHash: latestEvent.transactionHash,
              blockNumber: latestEvent.blockNumber,
            });
            
            return {
              sender: latestEvent.args.from,
              amount: amount,
              transactionHash: latestEvent.transactionHash,
              blockNumber: latestEvent.blockNumber,
            };
          } else {
            console.warn('[getRecentDepositSender] No Transfer events found', {
              botWallet: botWalletAddress,
              tokenAddress,
              fromBlock,
              toBlock: currentBlock,
            });
          }
        } catch (queryErr) {
          console.error('[getRecentDepositSender] Error querying events', { 
            error: queryErr.message,
            tokenAddress,
            botWalletAddress,
          });
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
