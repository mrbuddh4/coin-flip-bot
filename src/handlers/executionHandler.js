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
  static async executeFlip(flipId, ctx) {
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

      // Send immediate victory notification to winner (don't wait for blockchain)
      try {
        await ctx.telegram.sendMessage(
          winnerId,
          `🎉 <b>YOU WON!</b> 🎉\n\n` +
          `Congratulations! You won the coin flip!\n\n` +
          `💰 Your Prize: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90% of pool)\n` +
          `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n\n` +
          `⏳ Sending your winnings to your wallet...`,
          { parse_mode: 'HTML' }
        );
        logger.info('Sent immediate victory notification', { winnerId, flipId });
      } catch (notifyErr) {
        logger.warn('Failed to send victory notification', { error: notifyErr.message, winnerId });
      }

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

      // Send fees (5% dev + 5% burn = 10% total) to dev wallet
      const feeAmount = totalPool * 0.1;
      const feeWallet = flip.tokenNetwork === 'EVM' 
        ? process.env.EVM_DEV_WALLET 
        : process.env.SOLANA_DEV_WALLET;
      
      logger.info('[executeFlip] Fee wallet check', { 
        flipId, 
        network: flip.tokenNetwork,
        feeWallet: feeWallet ? `${feeWallet.substring(0, 10)}...` : 'NOT_SET',
        feeAmount 
      });
      
      let feeTxHash = null;
      if (feeWallet) {
        try {
          const blockchainManager = getBlockchainManager();
          const feeResult = await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            flip.tokenAddress,
            feeWallet,
            feeAmount.toString(),
            flip.tokenDecimals
          );
          feeTxHash = feeResult.txHash;
          logger.info('[executeFlip] Fees sent to dev wallet', { flipId, feeWallet, txHash: feeTxHash, amount: feeAmount });
        } catch (feeError) {
          logger.error('[executeFlip] Error sending fees', { flipId, feeWallet, error: feeError.message, stack: feeError.stack });
          // Continue even if fee send fails
        }
      } else {
        logger.warn('[executeFlip] Dev wallet not configured', { network: flip.tokenNetwork });
      }

      // Update flip record with result
      flip.flipResult = flipResultEnum;
      flip.winnerId = winnerId;
      flip.winningTxHash = winningTxHash;
      flip.claimedByWinner = true; // Mark as claimed since we sent it automatically
      flip.status = 'COMPLETED';
      await flip.save();

      // Generate transaction link based on network
      const txLink = flip.tokenNetwork === 'EVM'
        ? `https://etherscan.io/tx/${winningTxHash}`
        : `https://solscan.io/tx/${winningTxHash}`;

      // Send result to group chat by editing the existing message
      const txLinkMessage = winningTxHash 
        ? `\n🔗 <a href="${txLink}">View Transaction</a>`
        : `\n⏳ Processing winnings...`;

      try {
        await ctx.telegram.editMessageText(
          flip.groupChatId,
          flip.groupMessageId,
          null,
          `🎲 <b>FLIP RESULT: ${winnerName.toUpperCase()} WINS! 🎉</b>\n\n` +
          `💰 <b>Winnings: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90%)</b>\n` +
          `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
          `⚡ Fees: 10% (5% dev + 5% burn)${txLinkMessage}`,
          {
            parse_mode: 'HTML',
          }
        );
      } catch (editErr) {
        logger.warn('Failed to edit group message with result', { flipId, error: editErr.message });
        // Fallback: send a new message if edit fails
        try {
          await ctx.telegram.sendMessage(
            flip.groupChatId,
            `🎲 <b>FLIP RESULT: ${winnerName.toUpperCase()} WINS! 🎉</b>\n\n` +
            `💰 <b>Winnings: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90%)</b>\n` +
            `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
            `⚡ Fees: 10% (5% dev + 5% burn)${txLinkMessage}`,
            {
              parse_mode: 'HTML',
            }
          );
        } catch (err) {
          logger.error('Failed to send flip result to group', { flipId, error: err.message });
        }
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
        ? '0x0000000000000000000000000000000000000001'
        : '11111111111111111111111111111111';  // Null address for Solana

      try {
        // Send winner payout (90%)
        const winnerTx = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          walletAddress,
          winnerAmount,
          flip.tokenDecimals
        );

        // Send dev fee (5%)
        const devTx = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          devWallet,
          devAmount,
          flip.tokenDecimals
        );

        // Send burn fee (5%)
        const burnTx = await blockchainManager.sendWinnings(
          flip.tokenNetwork,
          flip.tokenAddress,
          burnAddress,
          burnAmount,
          flip.tokenDecimals
        );

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

        // Mark as claimed
        flip.claimedByWinner = true;
        flip.winningTxHash = winnerTx.txHash;
        flip.status = 'COMPLETED';
        await flip.save();

        // Update user stats
        const user = await models.User.findByPk(userId);
        if (user) {
          user.totalWon = (parseFloat(user.totalWon) + parseFloat(winnerAmount)).toString();
          await user.save();
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
