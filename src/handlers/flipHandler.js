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

      // Ensure user exists before creating session
      let user = await models.User.findByPk(userId);
      if (!user) {
        user = await models.User.create({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      }

      // Check if there's already an active flip in this group
      const activeFlip = await models.CoinFlip.findOne({
        where: {
          groupChatId: groupId,
          status: {
            [Op.in]: ['WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION', 'WAITING_CREATOR_WAGER'],
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

      // Store token and user info in session for tracking (flip will be created after wager entry)
      const session = await models.BotSession.create({
        userId,
        sessionType: 'INITIATING',
        currentStep: 'AWAITING_WAGER',
        data: {
          tokenInfo: token,
          groupId,
        },
      });

      // Send DM asking for wager amount (flip will be created in processWagerAmount)
      await ctx.telegram.sendMessage(
        userId,
        `Welcome to Coin Flip! 🪙\n\n` +
        `You've started a coin flip for <b>${token.symbol}</b> in a group.\n\n` +
        `How much do you want to wager?\n` +
        `Reply with an amount (e.g., 10 for 10 ${token.symbol})`,
        { parse_mode: 'HTML' }
      );

      logger.info('Coin flip initiated in group', { userId, groupId, token: token.symbol });
    } catch (error) {
      logger.error('Error starting flip in group', error);
      await ctx.reply('❌ Error starting coin flip. Please try again.');
    }
  }

  /**
   * Process wager amount from user in DM (for group flip initiated via /flip)
   */
  static async processWagerAmount(ctx) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const amount = ctx.message.text.trim();

      // Find active session from group-initiated flip
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

      const wagerAmount = parseFloat(amount);
      if (wagerAmount <= 0) {
        await ctx.reply('❌ Wager must be greater than 0.');
        return;
      }

      const { tokenInfo, groupId } = session.data;

      // Create flip record NOW (after wager confirmed)
      const flip = await models.CoinFlip.create({
        groupChatId: groupId,
        creatorId: userId,
        tokenNetwork: tokenInfo.network,
        tokenAddress: tokenInfo.address,
        tokenSymbol: tokenInfo.symbol,
        tokenDecimals: tokenInfo.decimals,
        wagerAmount: wagerAmount.toString(),
        status: 'WAITING_CHALLENGER',
      });

      // Get bot's wallet address for this network
      const blockchainManager = getBlockchainManager();
      const botWalletAddress = blockchainManager.getBotWalletAddress(tokenInfo.network);

      // Update session with flip ID
      session.coinFlipId = flip.id;
      session.currentStep = 'AWAITING_DEPOSIT';
      session.data = {
        ...session.data,
        flipId: flip.id,
        wagerAmount: wagerAmount.toString(),
      };
      await session.save();

      // NOW post the challenge message in the group with Accept button
      const groupMessage = await ctx.telegram.sendMessage(
        groupId,
        `🪙 <b>Coin Flip Challenge!</b>\n\n` +
        `<a href="tg://user?id=${userId}">${(await models.User.findByPk(userId))?.firstName || 'A player'}</a> started a flip for:\n\n` +
        `💰 <b>${wagerAmount} ${tokenInfo.symbol}</b>\n` +
        `🌐 Network: ${tokenInfo.network}\n\n` +
        `⏰ Waiting for a challenger...`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('Accept Challenge', `accept_flip_${flip.id}`)],
          ]).reply_markup,
        }
      );

      // Save message ID to flip
      flip.groupMessageId = groupMessage.message_id;
      await flip.save();

      // Send deposit instructions to creator in DM
      await ctx.reply(
        `✅ Wager confirmed: <b>${wagerAmount} ${tokenInfo.symbol}</b>\n\n` +
        `<b>Step 2: Send tokens to this address</b>\n\n` +
        `<code>${botWalletAddress}</code>\n\n` +
        `Network: ${tokenInfo.network}\n` +
        `Token: ${tokenInfo.symbol}\n` +
        `Amount: ${wagerAmount}\n\n` +
        `⏳ You have 3 minutes to complete this.\n\n` +
        `Reply <code>confirmed</code> when you've sent the tokens.`,
        { parse_mode: 'HTML' }
      );

      // Set timeout for creator deposit
      setTimeout(() => {
        this.handleDepositTimeout(flip.id, 'creator');
      }, config.bot.flipTimeoutSeconds * 1000);

      logger.info('Wager confirmed and flip posted to group', { userId, groupId, wagerAmount });
    } catch (error) {
      logger.error('Error processing wager', error);
      await ctx.reply('❌ Error processing wager. Please try again.');
    }
  }
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
   * Accept flip and immediately show confirmation prompt in DM
   */
  static async acceptFlip(ctx, flipId) {
    try {
      const { models } = getDB();
      const challengerId = ctx.from.id;
      const groupId = ctx.chat.id; // Store which group the button was clicked in

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

      // Record the group where this button was clicked as user's active group
      await models.BotSession.findOrCreate({
        where: {
          userId: challengerId,
          sessionType: 'LAST_GROUP_ACTIVITY',
        },
        defaults: {
          data: { groupId },
        },
      }).then(([session]) => {
        if (session.sessionType === 'LAST_GROUP_ACTIVITY') {
          session.data = { groupId };
          session.save();
        }
      });

      // Create confirmation session for challenger
      const confirmSession = await models.BotSession.create({
        userId: challengerId,
        coinFlipId: flipId,
        sessionType: 'CONFIRMING_DEPOSIT',
        currentStep: 'AWAITING_CONFIRMATION',
        data: {
          flipId,
          groupChatId: flip.groupChatId,
          wagerAmount: flip.wagerAmount,
          tokenSymbol: flip.tokenSymbol,
          tokenNetwork: flip.tokenNetwork,
        },
      });

      // Send confirmation prompt to challenger in DM
      await ctx.telegram.sendMessage(
        challengerId,
        `🪙 <b>Coin Flip Challenge!</b>\n\n` +
        `A player is challenging you to a flip:\n\n` +
        `💰 <b>Wager:</b> ${flip.wagerAmount} ${flip.tokenSymbol}\n` +
        `🌐 <b>Network:</b> ${flip.tokenNetwork}\n\n` +
        `<b>How it works:</b>\n` +
        `1️⃣ Both players send their wager to the bot\n` +
        `2️⃣ Coin flips 🪙\n` +
        `3️⃣ Winner takes the pot!\n\n` +
        `⚠️ <b>Note:</b> By confirming, you agree to send <b>${flip.wagerAmount} ${flip.tokenSymbol}</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Accept', `confirm_flip_${confirmSession.id}`),
              Markup.button.callback('❌ Reject', `reject_flip_${confirmSession.id}`),
            ],
          ]).reply_markup,
        }
      );

      // Notify in group that challenger is reviewing
      await ctx.editMessageText(
        `🪙 <b>Challenger Found!</b>\n\n` +
        `⏳ Waiting for challenger to confirm in DM...`,
        {
          chat_id: ctx.callbackQuery.message.chat.id,
          message_id: ctx.callbackQuery.message.message_id,
          parse_mode: 'HTML',
        }
      );

      await ctx.answerCbQuery('✅ Check your DMs to confirm the challenge!');

      // Set timeout for confirmation (30 seconds to confirm)
      setTimeout(() => {
        this.handleConfirmationTimeout(flipId, 'challenger', confirmSession.id);
      }, 30 * 1000);

      logger.info('Challenge prompt sent', { challengerId, flipId });
    } catch (error) {
      logger.error('Error accepting flip', error);
      await ctx.answerCbQuery('❌ Error accepting challenge.');
    }
  }

  /**
   * Handle confirmation timeout
   */
  static async handleConfirmationTimeout(flipId, role, sessionId) {
    try {
      const { models } = getDB();
      const session = await models.BotSession.findByPk(sessionId);
      
      if (!session || session.currentStep !== 'AWAITING_CONFIRMATION') {
        return; // Already confirmed or rejected
      }

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) return;

      // Delete the confirmation session
      await session.destroy();

      // Reset flip if challenger timesout during confirmation
      if (flip.status === 'WAITING_CHALLENGER_DEPOSIT') {
        flip.challengerId = null;
        flip.status = 'WAITING_CHALLENGER';
        await flip.save();

        // Notify in group
        try {
          await Models.telegram.editMessageText(
            `🪙 <b>Coin Flip Challenge!</b>\n\n` +
            `<a href="tg://user?id=${flip.creatorId}">${(await models.User.findByPk(flip.creatorId))?.firstName || 'Player'}</a> started a flip for <b>${flip.wagerAmount} ${flip.tokenSymbol}</b>\n\n` +
            `⏰ Waiting for a challenger...`,
            {
              chat_id: flip.groupChatId,
              message_id: flip.groupMessageId,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{ text: 'Accept Challenge', callback_data: `accept_flip_${flip.id}` }]],
              },
            }
          );
        } catch (err) {
          logger.warn('Failed to update group message on confirmation timeout', err.message);
        }

        logger.info('Challenge confirmation timeout', { flipId, role });
      }
    } catch (error) {
      logger.error('Error handling confirmation timeout', error);
    }
  }

  /**
   * Process wager amount from DM flip flow
   */
  static async processDMWagerAmount(ctx, session) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const wagerText = ctx.message.text.trim();

      // Validate wager amount
      if (!isValidNumber(wagerText)) {
        await ctx.reply('❌ Please enter a valid number (e.g., 10 or 100.5)');
        return;
      }

      const wagerAmount = parseFloat(wagerText);
      if (wagerAmount <= 0) {
        await ctx.reply('❌ Wager must be greater than 0.');
        return;
      }

      const token = session.data.tokenInfo;
      const groupChatId = session.data.groupChatId;

      // Check for active flip in this group
      const activeFlip = await models.CoinFlip.findOne({
        where: {
          groupChatId,
          status: {
            [Op.in]: ['WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION'],
          },
        },
      });

      if (activeFlip) {
        await ctx.reply('⏳ A coin flip is already in progress in that group.');
        return;
      }

      // Create or get creator user
      let user = await models.User.findByPk(userId);
      if (!user) {
        user = await models.User.create({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      }

      // Create flip record
      const flip = await models.CoinFlip.create({
        groupChatId,
        creatorId: userId,
        tokenNetwork: token.network,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        wagerAmount: wagerAmount.toString(),
        status: 'WAITING_CHALLENGER',
      });

      // Update session
      session.data.flipId = flip.id;
      session.currentStep = 'AWAITING_DEPOSIT';
      await session.save();

      // Get bot wallet for deposit
      const blockchainManager = getBlockchainManager();
      const botWalletAddress = blockchainManager.getBotWalletAddress(token.network);

      // Send deposit instructions in DM
      await ctx.reply(
        `✅ Flip created! Wager: <b>${wagerAmount} ${token.symbol}</b>\n\n` +
        `<b>Deposit Instructions:</b>\n` +
        `Send <b>${wagerAmount} ${token.symbol}</b> to:\n` +
        `<code>${botWalletAddress}</code>\n\n` +
        `Once sent, reply with "confirmed"`,
        { parse_mode: 'HTML' }
      );

      // Send challenge message to group
      try {
        const supportedTokens = Array.from(
          new Map(
            Object.entries(config.supportedTokens).map(([key, val]) => [val.symbol, val])
          ).values()
        );

        const tokenButtons =  supportedTokens.map((t, idx) => [
          Markup.button.callback(
            `${t.symbol} (${t.network})`,
            `select_dm_group_token_${flip.id}_${idx}`
          ),
        ]);

        await ctx.telegram.sendMessage(
          groupChatId,
          `🪙 <b>Coin Flip Challenge!</b>\n\n` +
          `<a href="tg://user?id=${userId}">${user.firstName}</a> started a flip for <b>${wagerAmount} ${token.symbol}</b>\n\n` +
          `⏰ Waiting for a challenger...`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('Accept Challenge', `accept_flip_${flip.id}`)],
            ]).reply_markup,
          }
        );
      } catch (groupError) {
        logger.error('Failed to send challenge to group', groupError);
        await ctx.reply('⚠️ Failed to send challenge to group. It may have removed the bot.');
      }

      logger.info('DM flip created', { userId, flipId: flip.id });
    } catch (error) {
      logger.error('Error processing DM wager', error);
      await ctx.reply('❌ Error creating flip. Please try again.');
    }
  }
}

module.exports = FlipHandler;
