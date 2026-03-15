const { Markup } = require('telegraf');
const { getDB } = require('../database');
const { getBlockchainManager } = require('../blockchain/manager');
const { performCoinFlip, formatAddress } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class ExecutionHandler {
  /**
   * Execute the coin flip once both deposits are confirmed
   */
  static async executeFlip(flipId, ctx, videoMessageId) {
    try {
      const { models } = getDB();
      const flip = await models.CoinFlip.findByPk(flipId);

      if (!flip || !flip.creatorDepositConfirmed || !flip.challengerDepositConfirmed) {
        logger.warn('Cannot execute flip - deposits not confirmed', { flipId });
        return;
      }

      logger.info('[executeFlip] Starting execution', { 
        flipId, 
        creatorId: flip.creatorId, 
        challengerId: flip.challengerId,
        status: flip.status 
      });

      // Update group message to show flip is executing
      try {
        await ctx.telegram.editMessageText(
          flip.groupChatId,
          flip.groupMessageId,
          null,
          `🎲 <b>Executing Flip...</b>\n\n` +
          `Both players confirmed deposits. Flipping coin...`,
          {
            parse_mode: 'HTML',
          }
        );
      } catch (err) {
        logger.warn('Failed to update group message for execution', { flipId, error: err.message });
      }

      // Fetch creator and challenger user records
      const creator = await models.User.findByPk(flip.creatorId);
      const challenger = await models.User.findByPk(flip.challengerId);

      logger.info('[executeFlip] User lookup complete', { 
        creatorFound: !!creator, 
        challengerFound: !!challenger,
        creatorId: flip.creatorId,
        challengerId: flip.challengerId
      });

      if (!creator || !challenger) {
        logger.warn('Creator or challenger user not found', { 
          flipId, 
          creatorId: flip.creatorId, 
          challengerId: flip.challengerId,
          creatorFound: !!creator,
          challengerFound: !!challenger
        });
        return;
      }

      // Perform coin flip (0 = creator wins, 1 = challenger wins)
      const result = performCoinFlip();
      const winnerId = result === 0 ? flip.creatorId : flip.challengerId;
      const flipResultEnum = result === 0 ? 'CREATOR' : 'CHALLENGER';
      const winnerDepositAddress = result === 0 ? flip.creatorDepositWalletAddress : flip.challengerDepositWalletAddress;
      const winnerName = result === 0 ? creator.firstName : challenger.firstName;

      // Calculate winnings
      const totalPool = parseFloat(flip.wagerAmount) * 2;
      const winnerPrize = totalPool * 0.9; // 90% to winner, 10% fees
      const winnerPrizeFormatted = winnerPrize.toLocaleString('en-US', { maximumFractionDigits: 6 });

      // Send winnings to winner automatically
      let winningTxHash = null;
      try {
        const blockchainManager = getBlockchainManager();
        const sendResult = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          winnerDepositAddress,
          winnerPrize.toString(),
          flip.tokenDecimals
        );
        winningTxHash = sendResult.txHash;
        logger.info('Winnings sent to winner', { flipId, winnerId, txHash: winningTxHash, amount: winnerPrize });
      } catch (sendError) {
        logger.error('Error sending winnings', { flipId, winnerId, error: sendError.message });
        // Continue even if send fails, we still want to record the flip result
      }

      // Send fees - split between dev wallet (5%) and burn address (5%)
      const devFeeAmount = totalPool * 0.05;  // 5% to dev
      const burnFeeAmount = totalPool * 0.05; // 5% to burn
      
      const devWallet = flip.tokenNetwork === 'EVM' 
        ? process.env.EVM_DEV_WALLET 
        : process.env.SOL_DEV_WALLET;
      
      // Burn addresses for each network
      const burnAddress = flip.tokenNetwork === 'EVM'
        ? '0x0000000000000000000000000000000000000000' // EVM burn address (null address)
        : '1nc1nerator11111111111111111111111111111111'; // Solana SPL incinerator address
      
      logger.info('[executeFlip] Fee distribution starting', { 
        flipId, 
        network: flip.tokenNetwork,
        totalPool,
        devFeeAmount,
        burnFeeAmount,
        devWalletEnv: `EVM_DEV_WALLET=${process.env.EVM_DEV_WALLET ? 'SET' : 'NOT_SET'}, SOL_DEV_WALLET=${process.env.SOL_DEV_WALLET ? 'SET' : 'NOT_SET'}`,

        devWallet: devWallet ? `${devWallet.substring(0, 10)}...` : 'NOT_SET',
        burnAddress: `${burnAddress.substring(0, 10)}...`,
      });
      
      // Send 5% to dev wallet
      if (devWallet) {
        try {
          logger.info('[executeFlip] Sending dev fee', { flipId, devWallet, devFeeAmount, tokenAddress: flip.tokenAddress, tokenDecimals: flip.tokenDecimals });
          console.log(`[executeFlip] DEV FEE - Amount: ${devFeeAmount}, To: ${devWallet}, Token: ${flip.tokenAddress}`);
          const blockchainManager = getBlockchainManager();
          const devResult = await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            flip.tokenAddress,
            devWallet,
            devFeeAmount.toString(),
            flip.tokenDecimals
          );
          logger.info('[executeFlip] Dev fee SENT', { flipId, devWallet: `${devWallet.substring(0, 10)}...`, txHash: devResult.txHash, amount: devFeeAmount });
          console.log(`[SUCCESS] Dev fee sent with txHash: ${devResult.txHash}`);
        } catch (devFeeError) {
          logger.error('[executeFlip] ERROR SENDING DEV FEE', { flipId, devWallet, devFeeAmount, error: devFeeError.message, stack: devFeeError.stack });
          console.error(`[ERROR] Dev fee failed:`, devFeeError.message);
        }
      } else {
        logger.warn('[executeFlip] DEV WALLET NOT CONFIGURED', { network: flip.tokenNetwork, envVarEVM: 'EVM_DEV_WALLET', envVarSolana: 'SOL_DEV_WALLET' });
        console.warn(`[WARN] DEV WALLET NOT SET - EVM_DEV_WALLET: ${process.env.EVM_DEV_WALLET}, SOL_DEV_WALLET: ${process.env.SOL_DEV_WALLET}`);
      }
      
      // Send 5% to burn address
      // Add delay before burn to avoid Solana RPC rate limiting (429)
      if (flip.tokenNetwork === 'Solana') {
        logger.info('[executeFlip] Waiting 15s before burn fee to avoid RPC rate limit', { flipId });
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
      try {
        logger.info('[executeFlip] Sending burn fee', { flipId, burnAddress, burnFeeAmount, tokenAddress: flip.tokenAddress, tokenDecimals: flip.tokenDecimals });
        console.log(`[executeFlip] BURN FEE - Amount: ${burnFeeAmount}, To: ${burnAddress}, Token: ${flip.tokenAddress}`);
        const blockchainManager = getBlockchainManager();
        logger.info('[executeFlip] About to call sendWinnings for burn', { burnAddress, burnFeeAmount });
        const burnResult = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          burnAddress,
          burnFeeAmount.toString(),
          flip.tokenDecimals
        );
        logger.info('[executeFlip] Burn fee SENT', { flipId, burnAddress: `${burnAddress.substring(0, 10)}...`, txHash: burnResult.txHash, amount: burnFeeAmount });
        console.log(`[SUCCESS] Burn fee sent with txHash: ${burnResult.txHash}`);
      } catch (burnFeeError) {
        logger.error('[executeFlip] ERROR SENDING BURN FEE (attempt 1)', { flipId, burnAddress, burnFeeAmount, error: burnFeeError.message });
        // Retry once after a longer delay
        if (flip.tokenNetwork === 'Solana') {
          logger.info('[executeFlip] Retrying burn fee after 20s', { flipId });
          await new Promise(resolve => setTimeout(resolve, 20000));
          try {
            const blockchainManager = getBlockchainManager();
            const burnRetry = await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              flip.tokenAddress,
              burnAddress,
              burnFeeAmount.toString(),
              flip.tokenDecimals
            );
            logger.info('[executeFlip] Burn fee SENT (retry)', { flipId, txHash: burnRetry.txHash, amount: burnFeeAmount });
            console.log(`[SUCCESS] Burn fee sent on retry with txHash: ${burnRetry.txHash}`);
          } catch (burnRetryError) {
            logger.error('[executeFlip] ERROR SENDING BURN FEE (retry failed)', { flipId, burnAddress, burnFeeAmount, error: burnRetryError.message });
            console.error(`[ERROR] Burn fee retry failed:`, burnRetryError.message);
          }
        } else {
          console.error(`[ERROR] Burn fee failed:`, burnFeeError.message);
        }
      }

      // Update flip record with result
      flip.flipResult = flipResultEnum;
      flip.winnerId = winnerId;
      flip.winningTxHash = winningTxHash;
      flip.claimedByWinner = true; // Mark as claimed since we sent it automatically
      flip.status = 'COMPLETED';
      // Clear deposit wallet addresses and accumulated amounts for next session
      flip.creatorDepositWalletAddress = null;
      flip.challengerDepositWalletAddress = null;
      flip.creatorAccumulatedDeposit = 0;
      flip.challengerAccumulatedDeposit = 0;
      await flip.save();

      // Update winner's stats
      const winner = result === 0 ? creator : challenger;
      const loser = result === 0 ? challenger : creator;
      
      if (winner) {
        try {
          winner.totalWon = (parseFloat(winner.totalWon || 0) + parseFloat(winnerPrize)).toString();
          winner.totalWagered = (parseFloat(winner.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await winner.save();
          logger.info('[executeFlip] Winner stats updated', { flipId, winnerId, totalWon: winner.totalWon, totalWagered: winner.totalWagered, winnerPrize });
        } catch (statsErr) {
          logger.error('[executeFlip] Error updating winner stats', { flipId, winnerId, error: statsErr.message });
        }
      }

      // Update loser's stats (only totalWagered, no winnings)
      if (loser) {
        try {
          loser.totalWagered = (parseFloat(loser.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await loser.save();
          logger.info('[executeFlip] Loser stats updated', { flipId, loserId: loser.telegramId, totalWagered: loser.totalWagered });
        } catch (statsErr) {
          logger.error('[executeFlip] Error updating loser stats', { flipId, loserId: loser.telegramId, error: statsErr.message });
        }
      }

      // Generate transaction link based on network
      const txLink = flip.tokenNetwork === 'EVM'
        ? `https://paxscan.io/tx/${winningTxHash}`
        : `https://solscan.io/tx/${winningTxHash}`;

      // Send result to group chat by editing the existing message
      const txLinkMessage = winningTxHash 
        ? `\n🔗 <a href="${txLink}">View Transaction</a>`
        : `\n⏳ Processing winnings...`;

      const resultMessageText = 
        `🎲 <b>FLIP RESULT: ${winnerName.toUpperCase()} WINS! 🎉</b>\n\n` +
        `💰 <b>Winnings: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90%)</b>\n` +
        `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
        `⚡ Fees: 10% (5% dev + 5% burn)${txLinkMessage}`;

      const fs = require('fs');
      const path = require('path');
      const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');

      try {
        // Try to send with image first
        if (fs.existsSync(imagePath)) {
          try {
            await ctx.telegram.sendPhoto(
              flip.groupChatId,
              { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
              {
                caption: resultMessageText,
                parse_mode: 'HTML',
              }
            );
          } catch (photoErr) {
            logger.warn('Failed to send result photo, falling back to text edit', { flipId, error: photoErr.message });
            // Fallback to editing existing message
            await ctx.telegram.editMessageText(
              flip.groupChatId,
              flip.groupMessageId,
              null,
              resultMessageText,
              {
                parse_mode: 'HTML',
              }
            );
          }
        } else {
          // Image not found, just edit existing message
          await ctx.telegram.editMessageText(
            flip.groupChatId,
            flip.groupMessageId,
            null,
            resultMessageText,
            {
              parse_mode: 'HTML',
            }
          );
        }
        
        // Delete the video message now that result is displayed
        if (videoMessageId) {
          try {
            await ctx.telegram.deleteMessage(flip.groupChatId, videoMessageId);
            logger.info('Deleted video message after flip result', { flipId, videoMessageId });
          } catch (deleteErr) {
            logger.warn('Failed to delete video message', { flipId, videoMessageId, error: deleteErr.message });
          }
        }
      } catch (editErr) {
        logger.warn('Failed to send flip result to group', { flipId, error: editErr.message });
        // Last fallback: send a new message if everything fails
        try {
          await ctx.telegram.sendMessage(
            flip.groupChatId,
            resultMessageText,
            {
              parse_mode: 'HTML',
            }
          );
          
          // Delete the video message now that result is displayed
          if (videoMessageId) {
            try {
              await ctx.telegram.deleteMessage(flip.groupChatId, videoMessageId);
              logger.info('Deleted video message after flip result', { flipId, videoMessageId });
            } catch (deleteErr) {
              logger.warn('Failed to delete video message', { flipId, videoMessageId, error: deleteErr.message });
            }
          }
        } catch (err) {
          logger.error('Failed to send flip result to group', { flipId, error: err.message });
        }
      }

      // If transaction is pending, edit the message after a delay to show the link once it completes
      if (!winningTxHash && flip.groupMessageId) {
        setTimeout(async () => {
          try {
            // Re-fetch flip to get updated tx hash
            const { models } = getDB();
            const updatedFlip = await models.CoinFlip.findByPk(flipId);
            
            if (updatedFlip && updatedFlip.winningTxHash) {
              const txLinkUpdated = updatedFlip.tokenNetwork === 'EVM'
                ? `https://paxscan.io/tx/${updatedFlip.winningTxHash}`
                : `https://solscan.io/tx/${updatedFlip.winningTxHash}`;
              
              const updatedMessage = 
                `🎲 <b>FLIP RESULT: ${winnerName.toUpperCase()} WINS! 🎉</b>\n\n` +
                `💰 <b>Winnings: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90%)</b>\n` +
                `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
                `⚡ Fees: 10% (5% dev + 5% burn)\n🔗 <a href="${txLinkUpdated}">View Transaction</a>`;
              
              await ctx.telegram.editMessageText(
                flip.groupChatId,
                flip.groupMessageId,
                null,
                updatedMessage,
                {
                  parse_mode: 'HTML',
                }
              );
              logger.info('Updated flip result message with transaction link', { flipId, txHash: updatedFlip.winningTxHash });
            }
          } catch (err) {
            logger.warn('Failed to update flip result with transaction link', { flipId, error: err.message });
          }
        }, 3000); // Wait 3 seconds then check for tx link
      }

      // Notify winner in DM
      await ctx.telegram.sendMessage(
        winnerId,
        `🎉 <b>CONGRATULATIONS!</b>\n\n` +
        `You won ${winnerPrizeFormatted} ${flip.tokenSymbol} (90% of pool)!\n\n` +
        (winningTxHash 
          ? `✅ Winnings sent automatically!\n🔗 <a href="${txLink}">View Transaction</a>`
          : `⏳ Processing your winnings... You'll receive them shortly.`),
        { parse_mode: 'HTML' }
      );

      logger.info('Flip executed successfully', { flipId, result: flipResultEnum, winnerId, winnerName, txHash: winningTxHash });
    } catch (error) {
      logger.error('Error executing flip', { 
        flipId,
        message: error.message, 
        stack: error.stack,
        error: error.toString()
      });
    }
  }

  /**
   * Process claim winnings request
   */
  static async claimWinnings(ctx, flipId) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip expired.');
        return;
      }

      if (flip.winnerId !== userId) {
        await ctx.answerCbQuery('❌ Only the winner can claim.');
        return;
      }

      if (flip.claimedByWinner) {
        await ctx.answerCbQuery('✅ Winnings already claimed.');
        return;
      }

      // Create session for payout
      const session = await models.BotSession.create({
        userId,
        coinFlipId: flipId,
        sessionType: 'CLAIMING_WINNINGS',
        currentStep: 'GETTING_ADDRESS',
        data: { flipId },
      });

      // Send DM asking for wallet address
      const totalPool = flip.wagerAmount * 2;
      const winnerPrize = (totalPool * 0.9).toFixed(flip.tokenDecimals);
      
      await ctx.telegram.sendMessage(
        userId,
        `💰 <b>Claim Your Winnings!</b>\n\n` +
        `Amount: <b>${winnerPrize} ${flip.tokenSymbol} (90% of pool)</b>\n\n` +
        `Please reply with your ${flip.tokenNetwork} wallet address.`,
        { parse_mode: 'HTML' }
      );

      await ctx.answerCbQuery('✅ Check your DMs to claim winnings!');

      logger.info('Claim winnings initiated', { userId, flipId });
    } catch (error) {
      logger.error('Error claiming winnings', error);
      await ctx.answerCbQuery('❌ Error processing claim.');
    }
  }

  /**
   * Process wallet address for payout
   */
  static async processPayoutAddress(ctx) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const walletAddress = ctx.message.text.trim();

      // Find active claiming session
      const session = await models.BotSession.findOne({
        where: { userId, sessionType: 'CLAIMING_WINNINGS' },
        order: [['createdAt', 'DESC']],
      });

      if (!session || !session.data.flipId) {
        await ctx.reply('❌ No active claim session.');
        return;
      }

      const flip = await models.CoinFlip.findByPk(session.data.flipId);
      if (!flip) {
        await ctx.reply('❌ Flip not found.');
        return;
      }

      // Validate wallet address
      const blockchainManager = getBlockchainManager();
      if (!blockchainManager.isValidAddress(flip.tokenNetwork, walletAddress)) {
        await ctx.reply(
          `❌ Invalid ${flip.tokenNetwork} wallet address.\n\n` +
          `Please reply with a valid address.`
        );
        return;
      }

      // Send payout from bot wallet
      await ctx.reply(`⏳ Processing payout...`);

      const totalPool = parseFloat(flip.wagerAmount) * 2;
      const winnerAmount = (totalPool * 0.9).toFixed(flip.tokenDecimals);
      const devAmount = (totalPool * 0.05).toFixed(flip.tokenDecimals);
      const burnAmount = (totalPool * 0.05).toFixed(flip.tokenDecimals);

      const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);

      // Get dev wallet and burn address for this network
      const devWallet = flip.tokenNetwork === 'EVM' ? config.evm.devWallet : config.solana.devWallet;
      const burnAddress = flip.tokenNetwork === 'EVM'
        ? '0x0000000000000000000000000000000000000000' // EVM burn address (null address)
        : '1nc1nerator11111111111111111111111111111111'; // Solana SPL incinerator address

      // Send winner payout (90%)
      const winnerTx = await blockchainManager.sendWinnings(
        flip.tokenNetwork,
        flip.tokenAddress,
        walletAddress,
        winnerAmount,
        flip.tokenDecimals
      );

      // Send dev fee (5%)
      let devTx = null;
      try {
        if (flip.tokenNetwork === 'Solana') await new Promise(r => setTimeout(r, 5000));
        devTx = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          devWallet,
          devAmount,
          flip.tokenDecimals
        );
      } catch (devFeeError) {
        logger.error('[confirmPayoutAddress] ERROR SENDING DEV FEE', { flipId, devWallet, devAmount, error: devFeeError.message });
      }

      // Send burn fee (5%)
      let burnTx = null;
      try {
        if (flip.tokenNetwork === 'Solana') await new Promise(r => setTimeout(r, 15000));
        burnTx = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          burnAddress,
          burnAmount,
          flip.tokenDecimals
        );
      } catch (burnFeeError) {
        logger.error('[confirmPayoutAddress] ERROR SENDING BURN FEE (attempt 1)', { flipId, burnAddress, burnAmount, error: burnFeeError.message });
        // Retry once after a longer delay
        if (flip.tokenNetwork === 'Solana') {
          logger.info('[confirmPayoutAddress] Retrying burn fee after 20s', { flipId });
          await new Promise(r => setTimeout(r, 20000));
          try {
            burnTx = await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              flip.tokenAddress,
              burnAddress,
              burnAmount,
              flip.tokenDecimals
            );
          } catch (burnRetryError) {
            logger.error('[confirmPayoutAddress] ERROR SENDING BURN FEE (retry failed)', { flipId, burnAddress, burnAmount, error: burnRetryError.message });
          }
        }
      }

      try {
        // Record transactions
        await models.Transaction.create({
          coinFlipId: flip.id,
          userId,
          type: 'PAYOUT',
          network: flip.tokenNetwork,
          tokenAddress: flip.tokenAddress,
          tokenSymbol: flip.tokenSymbol,
          amount: winnerAmount,
          fromAddress: botWalletAddress,
          toAddress: walletAddress,
          txHash: winnerTx.txHash,
          status: 'CONFIRMED',
        });

        if (devTx) {
          await models.Transaction.create({
            coinFlipId: flip.id,
            userId: null,
            type: 'FEE_DEV',
            network: flip.tokenNetwork,
            tokenAddress: flip.tokenAddress,
            tokenSymbol: flip.tokenSymbol,
            amount: devAmount,
            fromAddress: botWalletAddress,
            toAddress: devWallet,
            txHash: devTx.txHash,
            status: 'CONFIRMED',
          });
        }

        if (burnTx) {
          await models.Transaction.create({
            coinFlipId: flip.id,
            userId: null,
            type: 'FEE_BURN',
            network: flip.tokenNetwork,
            tokenAddress: flip.tokenAddress,
            tokenSymbol: flip.tokenSymbol,
            amount: burnAmount,
            fromAddress: botWalletAddress,
            toAddress: burnAddress,
            txHash: burnTx.txHash,
            status: 'CONFIRMED',
          });
        }

        // Mark as claimed
        flip.claimedByWinner = true;
        flip.winningTxHash = winnerTx.txHash;
        flip.status = 'COMPLETED';
        // Clear deposit wallet addresses and accumulated amounts for next session
        flip.creatorDepositWalletAddress = null;
        flip.challengerDepositWalletAddress = null;
        flip.creatorAccumulatedDeposit = 0;
        flip.challengerAccumulatedDeposit = 0;
        await flip.save();

        // Update user stats
        const user = await models.User.findByPk(userId);
        const otherPlayerId = userId === flip.creatorId ? flip.challengerId : flip.creatorId;
        const otherPlayer = await models.User.findByPk(otherPlayerId);
        
        if (user) {
          user.totalWon = (parseFloat(user.totalWon || 0) + parseFloat(winnerAmount)).toString();
          user.totalWagered = (parseFloat(user.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await user.save();
          logger.info('[confirmPayoutAddress] Winner stats updated', { userId, flipId, totalWon: user.totalWon, totalWagered: user.totalWagered });
        }

        // Update loser's stats
        if (otherPlayer) {
          otherPlayer.totalWagered = (parseFloat(otherPlayer.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await otherPlayer.save();
          logger.info('[confirmPayoutAddress] Loser stats updated', { loserId: otherPlayerId, flipId, totalWagered: otherPlayer.totalWagered });
        }

        // Update session
        session.currentStep = 'PAYOUT_COMPLETE';
        await session.save();

        await ctx.reply(
          `✅ <b>Payout Complete!</b>\n\n` +
          `Your Winnings (90%): <b>${winnerAmount} ${flip.tokenSymbol}</b>\n` +
          `Tx: <code>${winnerTx.txHash}</code>\n\n` +
          `📊 <b>Fee Distribution:</b>\n` +
          `Dev Fee (5%): ${devAmount} ${flip.tokenSymbol}\n` +
          `Burn Fee (5%): ${burnAmount} ${flip.tokenSymbol}`,
          { parse_mode: 'HTML' }
        );

        logger.info('Payout processed', { userId, flipId, txHash: winnerTx.txHash });
      } catch (payoutError) {
        logger.error('Payout failed', payoutError);
        await ctx.reply(
          `❌ Payout failed: ${payoutError.message}\n\n` +
          `Please contact support.`
        );
      }
    } catch (error) {
      logger.error('Error processing payout address', error);
      await ctx.reply('❌ Error processing payout.');
    }
  }

  /**
   * Cancel flip (creator only, if no challenger yet)
   */
  static async cancelFlip(ctx, flipId) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip not found.');
        return;
      }

      if (flip.creatorId !== userId) {
        await ctx.answerCbQuery('❌ Only creator can cancel.');
        return;
      }

      if (flip.challengerId !== null) {
        await ctx.answerCbQuery('❌ Cannot cancel with an active challenger.');
        return;
      }

      // Refund deposit to creator if confirmed
      if (flip.creatorDepositConfirmed) {
        const blockchainManager = getBlockchainManager();
        const user = await models.User.findByPk(userId);

        if (user.walletAddress) {
          try {
            await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              flip.tokenAddress,
              user.walletAddress,
              flip.wagerAmount,
              flip.tokenDecimals
            );
          } catch (error) {
            logger.error('Error refunding deposit on cancel', error);
          }
        }
      }

      // Update flip status
      flip.status = 'CANCELLED';
      // Clear deposit wallet addresses and accumulated amounts
      flip.creatorDepositWalletAddress = null;
      flip.challengerDepositWalletAddress = null;
      flip.creatorAccumulatedDeposit = 0;
      flip.challengerAccumulatedDeposit = 0;
      await flip.save();

      await ctx.answerCbQuery('✅ Flip cancelled.');
      await ctx.editMessageText('❌ This flip has been cancelled.');

      logger.info('Flip cancelled by creator', { userId, flipId });
    } catch (error) {
      logger.error('Error cancelling flip', error);
      await ctx.answerCbQuery('❌ Error cancelling flip.');
    }
  }
}

module.exports = ExecutionHandler;
