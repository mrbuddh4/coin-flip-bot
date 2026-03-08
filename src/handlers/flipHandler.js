const { Markup } = require('telegraf');
const { Op } = require('sequelize');
const { getDB } = require('../database');
const { getBlockchainManager } = require('../blockchain/manager');
const { performCoinFlip, formatAddress, isValidNumber } = require('../utils/helpers');
const logger = require('../utils/logger');
const config = require('../config');

class FlipHandler {
  /**
   * Start a new coin flip in a group
   */
  static async startFlipInGroup(ctx, token) {
    try {
      const { models } = getDB();
      const groupId = ctx.chat.id;
      const userId = ctx.from.id;

      // Check if there's already an active flip in this group
      const activeFlip = await models.CoinFlip.findOne({
        where: {
          groupChatId: groupId,
          status: {
            [Op.in]: ['WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION'],
          },
        },
      });

      if (activeFlip) {
        await ctx.reply(
          '⏳ A coin flip is already in progress in this group. Please wait for it to complete.',
          Markup.removeKeyboard()
        );
        return;
      }

      // Store token and user info in session for DM flow
      const session = await models.BotSession.create({
        userId,
        sessionType: 'INITIATING',
        currentStep: 'SELECTING_TOKEN',
        data: {
          tokenInfo: token,
          groupId,
        },
      });

      // Create initial message in group
      const groupMessage = await ctx.reply(
        `🪙 <b>Coin Flip Challenge Started!</b>\n\n` +
        `Player: <a href="tg://user?id=${userId}">${ctx.from.first_name}</a>\n` +
        `Token: ${token.symbol}\n\n` +
        `👇 Click below to accept the challenge!`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('Accept Challenge', `accept_flip_${session.id}`)],
          ]).reply_markup,
        }
      );

      // Save message ID for later updates
      session.data.groupMessageId = groupMessage.message_id;
      await session.save();

      // Send DM to initiator
      await ctx.telegram.sendMessage(
        userId,
        `Welcome to Coin Flip! 🪙\n\n` +
        `You've initiated a coin flip for <b>${token.symbol}</b>\n\n` +
        `How much do you want to wager?\n` +
        `Reply with an amount (e.g., 10 for 10 ${token.symbol})`,
        { parse_mode: 'HTML' }
      );

      logger.info('Coin flip started', { userId, groupId, token: token.symbol });
    } catch (error) {
      logger.error('Error starting flip', error);
      await ctx.reply('❌ Error starting coin flip. Please try again.');
    }
  }

  /**
   * Process wager amount from user in DM
   */
  static async processWagerAmount(ctx) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const amount = ctx.message.text.trim();

      // Find active session
      const session = await models.BotSession.findOne({
        where: { userId, sessionType: 'INITIATING' },
        order: [['createdAt', 'DESC']],
      });

      if (!session) {
        await ctx.reply('❌ No active coin flip session. Start one from the group chat.');
        return;
      }

      if (!isValidNumber(amount)) {
        await ctx.reply('❌ Please enter a valid number for the wager amount.');
        return;
      }

      // Get or create user
      let user = await models.User.findByPk(userId);
      if (!user) {
        user = await models.User.create({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      }

      const { tokenInfo, groupId } = session.data;

      // Create flip record
      const flip = await models.CoinFlip.create({
        groupChatId: groupId,
        creatorId: userId,
        tokenNetwork: tokenInfo.network,
        tokenAddress: tokenInfo.address,
        tokenSymbol: tokenInfo.symbol,
        tokenDecimals: tokenInfo.decimals,
        wagerAmount: amount,
        status: 'WAITING_CHALLENGER',
      });

      // Get bot's wallet address for this network
      const blockchainManager = getBlockchainManager();
      const botWalletAddress = blockchainManager.getBotWalletAddress(tokenInfo.network);

      // Update session
      session.currentStep = 'AWAITING_DEPOSIT';
      session.data = {
        ...session.data,
        flipId: flip.id,
        currentStep: 'AWAITING_DEPOSIT',
        wagerAmount: amount,
      };
      await session.save();

      // Send deposit instructions pointing to bot wallet
      await ctx.reply(
        `✅ Wager confirmed: <b>${amount} ${tokenInfo.symbol}</b>\n\n` +
        `<b>Step 2: Send tokens to this address</b>\n\n` +
        `<code>${botWalletAddress}</code>\n\n` +
        `Network: ${tokenInfo.network}\n` +
        `Token: ${tokenInfo.symbol}\n` +
        `Amount: ${amount}\n\n` +
        `⏳ You have 3 minutes to complete this.\n\n` +
        `Reply <code>confirmed</code> when you've sent the tokens.`,
        { parse_mode: 'HTML' }
      );

      // Set timeout for creator deposit
      setTimeout(() => {
        this.handleDepositTimeout(flip.id, 'creator');
      }, config.bot.flipTimeoutSeconds * 1000);

      logger.info('Wager amount processed', { userId, amount, tokenSymbol: tokenInfo.symbol });
    } catch (error) {
      logger.error('Error processing wager', error);
      await ctx.reply('❌ Error processing wager. Please try again.');
    }
  }

  /**
   * Confirm deposit received from creator
   */
  static async confirmCreatorDeposit(ctx) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;

      // Find active session
      const session = await models.BotSession.findOne({
        where: { userId, sessionType: 'INITIATING' },
        order: [['createdAt', 'DESC']],
      });

      if (!session || !session.data.flipId) {
        await ctx.reply('❌ No active coin flip session.');
        return;
      }

      const flipId = session.data.flipId;
      const flip = await models.CoinFlip.findByPk(flipId);

      if (!flip) {
        await ctx.reply('❌ Flip not found.');
        return;
      }

      // Verify deposit on bot's wallet
      const blockchainManager = getBlockchainManager();
      const verification = await blockchainManager.verifyDeposit(
        flip.tokenNetwork,
        flip.tokenAddress,
        flip.wagerAmount,
        flip.tokenDecimals
      );

      if (!verification.received) {
        await ctx.reply(
          `❌ Deposit not detected yet.\n\n` +
          `Expected: ${flip.wagerAmount} ${flip.tokenSymbol}\n` +
          `Received: ${verification.amount}\n\n` +
          `Please ensure the tokens have been sent to the correct address.`
        );
        return;
      }

      // Mark deposit as confirmed
      flip.creatorDepositConfirmed = true;
      flip.status = 'WAITING_CHALLENGER';
      await flip.save();

      session.currentStep = 'DEPOSIT_CONFIRMED';
      session.data.depositConfirmed = true;
      await session.save();

      await ctx.reply(
        `✅ <b>Deposit confirmed!</b>\n\n` +
        `Received: ${verification.amount} ${flip.tokenSymbol}\n\n` +
        `Waiting for a challenger...`
      );

      logger.info('Creator deposit confirmed', { userId, flipId, amount: flip.wagerAmount });
    } catch (error) {
      logger.error('Error confirming deposit', error);
      await ctx.reply('❌ Error confirming deposit. Please try again.');
    }
  }

  /**
   * Handle deposit timeout
   */
  static async handleDepositTimeout(flipId, role) {
    try {
      const { models } = getDB();
      const flip = await models.CoinFlip.findByPk(flipId);

      if (!flip) return;

      if (role === 'creator' && !flip.creatorDepositConfirmed) {
        flip.creatorTimedOut = true;
        flip.status = 'CANCELLED';
        await flip.save();

        await this.notifyCancelledFlip(flip, 'Creator did not deposit tokens within 3 minutes.');
      } else if (role === 'challenger' && !flip.challengerDepositConfirmed) {
        flip.challengerTimedOut = true;
        flip.status = 'CANCELLED';
        await flip.save();

        await this.notifyCancelledFlip(flip, 'Challenger did not deposit tokens within 3 minutes.');
      }
    } catch (error) {
      logger.error('Error handling deposit timeout', error);
    }
  }

  /**
   * Notify group that flip was cancelled
   */
  static async notifyCancelledFlip(flip, reason) {
    try {
      // Implementation will depend on having bot context
      // This would send a message to the group chat explaining cancellation
      logger.info('Flip cancelled', { flipId: flip.id, reason });
    } catch (error) {
      logger.error('Error notifying cancelled flip', error);
    }
  }

  /**
   * Accept flip and start challenger flow
   */
  static async acceptFlip(ctx, flipId) {
    try {
      const { models } = getDB();
      const challengerId = ctx.from.id;

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip not found or expired.');
        return;
      }

      if (flip.status !== 'WAITING_CHALLENGER') {
        await ctx.answerCbQuery('❌ This flip is no longer available.');
        return;
      }

      if (flip.creatorId === challengerId) {
        await ctx.answerCbQuery('❌ You cannot challenge your own flip.');
        return;
      }

      // Set challenger
      flip.challengerId = challengerId;
      flip.status = 'WAITING_CHALLENGER_DEPOSIT';
      await flip.save();

      // Create session for challenger
      const session = await models.BotSession.create({
        userId: challengerId,
        coinFlipId: flipId,
        sessionType: 'CONFIRMING_DEPOSIT',
        currentStep: 'AWAITING_DEPOSIT',
        data: {
          flipId,
          wagerAmount: flip.wagerAmount,
        },
      });

      // Get or create challenger user
      let user = await models.User.findByPk(challengerId);
      if (!user) {
        user = await models.User.create({
          telegramId: challengerId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      }

      // Generate deposit wallet for challenger
      const blockchainManager = getBlockchainManager();
      const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);

      // Send DM to challenger
      await ctx.telegram.sendMessage(
        challengerId,
        `🎮 <b>Challenge Accepted!</b>\n\n` +
        `You're challenging a coin flip for:\n` +
        `<b>${flip.wagerAmount} ${flip.tokenSymbol}</b>\n\n` +
        `Send tokens to this address:\n\n` +
        `<code>${botWalletAddress}</code>\n\n` +
        `⏳ You have 3 minutes.\n\n` +
        `Reply <code>confirmed</code> when sent.`,
        { parse_mode: 'HTML' }
      );

      // Notify in group
      await ctx.editMessageText(
        `🪙 <b>Challenger Found!</b>\n\n` +
        `Waiting for both players to confirm deposits...`,
        {
          chat_id: ctx.callbackQuery.message.chat.id,
          message_id: ctx.callbackQuery.message.message_id,
          parse_mode: 'HTML',
        }
      );

      await ctx.answerCbQuery('✅ Challenge accepted! Check your DMs.');

      // Set timeout for challenger deposit
      setTimeout(() => {
        this.handleDepositTimeout(flipId, 'challenger');
      }, config.bot.flipTimeoutSeconds * 1000);

      logger.info('Challenge accepted', { challengerId, flipId });
    } catch (error) {
      logger.error('Error accepting flip', error);
      await ctx.answerCbQuery('❌ Error accepting challenge.');
    }
  }
}

module.exports = FlipHandler;
