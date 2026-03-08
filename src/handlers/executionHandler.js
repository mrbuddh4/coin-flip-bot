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
      const flip = await models.CoinFlip.findByPk(flipId, {
        include: [
          { association: 'creator', model: models.User },
          { association: 'challenger', model: models.User },
        ],
      });

      if (!flip || !flip.creatorDepositConfirmed || !flip.challengerDepositConfirmed) {
        logger.warn('Cannot execute flip - deposits not confirmed', { flipId });
        return;
      }

      // Perform coin flip (0 = creator wins, 1 = challenger wins)
      const result = performCoinFlip();
      const winnerId = result === 0 ? flip.creatorId : flip.challengerId;

      // Update flip record
      flip.flipResult = result;
      flip.winnerId = winnerId;
      flip.status = 'WAITING_EXECUTION';
      await flip.save();

      // Send result to group chat
      const winnerName = result === 0 ? flip.creator.firstName : flip.challenger.firstName;
      const totalPool = flip.wagerAmount * 2;
      const winnerPrize = (totalPool * 0.9).toFixed(flip.tokenDecimals);
      
      await ctx.telegram.sendMessage(
        flip.groupChatId,
        `🎲 <b>Coin Flip Result: ${winnerName} WINS!</b>\n\n` +
        `💰 <b>Winnings: ${winnerPrize} ${flip.tokenSymbol} (90%)</b>\n` +
        `📊 Total Pool: ${totalPool} ${flip.tokenSymbol}\n` +
        `⚡ Fees: 10% (5% dev + 5% burn)\n\n` +
        `Click below to claim!`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('Claim Winnings', `claim_winnings_${flipId}`)],
          ]).reply_markup,
        }
      );

      // Notify winner in DM
      await ctx.telegram.sendMessage(
        winnerId,
        `🎉 <b>YOU WON!</b>\n\n` +
        `Prize: ${winnerPrize} ${flip.tokenSymbol} (90% of pool)\n\n` +
        `Go back to the group chat and click "Claim Winnings"\n` +
        `Or reply with your wallet address here to receive automatically.`,
        { parse_mode: 'HTML' }
      );

      logger.info('Flip executed', { flipId, result, winnerId });
    } catch (error) {
      logger.error('Error executing flip', error);
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
