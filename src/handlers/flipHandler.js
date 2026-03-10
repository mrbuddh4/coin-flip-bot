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
      logger.error('Error starting flip in group', { error: error.message, stack: error.stack });
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

      logger.info('Session data before wager processing', { sessionData: session.data });

      const { tokenInfo, groupId } = session.data;

      if (!tokenInfo) {
        logger.error('Token info missing from session', { sessionId: session.id, sessionData: session.data });
        await ctx.reply('❌ Token selection was lost. Please start over with /flip');
        return;
      }

      if (!groupId) {
        logger.error('Group ID missing from session', { sessionId: session.id, sessionData: session.data });
        await ctx.reply('❌ Group context was lost. Please start over with /flip');
        return;
      }

      // Check if there's already an active flip in this group
      const activeFlip = await models.CoinFlip.findOne({
        where: {
          groupChatId: groupId,
          status: {
            [require('sequelize').Op.notIn]: ['COMPLETED', 'CANCELLED'],
          },
        },
      });

      if (activeFlip) {
        logger.warn('Attempted to create flip while one is active', { groupId, activeFlipId: activeFlip.id });
        await ctx.reply(
          `⏸️ <b>A flip is already in progress!</b>\n\n` +
          `Only one coin flip can happen at a time in this group.\n` +
          `Please wait for the current flip to complete.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Create flip record with WAITING_CREATOR_DEPOSIT status (won't post to group yet)
      const flip = await models.CoinFlip.create({
        groupChatId: groupId,
        creatorId: userId,
        tokenNetwork: tokenInfo.network,
        tokenAddress: tokenInfo.address,
        tokenSymbol: tokenInfo.symbol,
        tokenDecimals: tokenInfo.decimals,
        wagerAmount: wagerAmount.toString(),
        status: 'WAITING_CREATOR_DEPOSIT',
      });

      // Get bot's wallet address for this network
      const blockchainManager = getBlockchainManager();
      const botWalletAddress = blockchainManager.getBotWalletAddress(tokenInfo.network);

      // Update session with flip ID
      session.coinFlipId = flip.id;
      session.data = {
        ...session.data,
        flipId: flip.id,
        wagerAmount: wagerAmount.toString(),
      };
      
      // Check if user has a wallet address in their profile
      const userProfile = await models.UserProfile.findByPk(userId);
      const walletField = tokenInfo.network === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
      const storedWallet = userProfile?.[walletField];

      if (storedWallet) {
        // Use stored wallet address
        flip.creatorDepositWalletAddress = storedWallet;
        await flip.save();

        logger.info('Using stored wallet address for creator', { flipId: flip.id, network: tokenInfo.network });

        session.currentStep = 'AWAITING_DEPOSIT';
        await session.save();

        // Show deposit instructions directly
        const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
        await ctx.reply(
          `💰 <b>Send Your Deposit</b>\n\n` +
          `You have <b>3 minutes</b> to complete this.\n\n` +
          `<b>Wager Amount:</b> ${formattedWager} ${tokenInfo.symbol}\n` +
          `<b>Network:</b> ${tokenInfo.network}\n\n` +
          `📮 <b>Send to this address:</b>\n\n` +
          `<code>${botWalletAddress}</code>\n\n` +
          `Once sent, click the button below:`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('✅ I Sent the Deposit', `creator_deposit_confirmed_${flip.id}`)],
            ]).reply_markup,
          }
        );
      } else {
        // No stored wallet - ask user to set it up
        session.currentStep = 'AWAITING_WALLET_ADDRESS';
        await session.save();

        await ctx.reply(
          `❌ <b>Wallet Address Required</b>\n\n` +
          `We need your ${tokenInfo.network} wallet address to send you your winnings!\n\n` +
          `Use /wallet to add your receiving addresses, then come back here to continue.`,
          { parse_mode: 'HTML' }
        );
      }

      // Set timeout for creator deposit
      setTimeout(() => {
        this.handleDepositTimeout(flip.id, 'creator');
      }, config.bot.flipTimeoutSeconds * 1000);

      logger.info('Flip created, awaiting creator wallet address', { userId, groupId, wagerAmount, flipId: flip.id });
    } catch (error) {
      logger.error('Error processing wager', { error: error.message, stack: error.stack, userId: ctx.from.id });
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
        const formattedExpected = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
        await ctx.reply(
          `❌ Deposit not detected yet.\n\n` +
          `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
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
      const groupId = ctx.chat.id;

      logger.info('Challenger accepting flip', { challengerId, flipId, groupId });

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        logger.error('Flip not found on accept', { flipId });
        await ctx.answerCbQuery('❌ Flip not found or expired.');
        return;
      }

      if (flip.status !== 'WAITING_CHALLENGER') {
        logger.warn('Flip not in WAITING_CHALLENGER status', { flipId, status: flip.status });
        await ctx.answerCbQuery('❌ This flip is no longer available.');
        return;
      }

      if (flip.creatorId === challengerId) {
        logger.warn('Challenger is the creator', { challengerId, flipId });
        await ctx.answerCbQuery('❌ You cannot challenge your own flip.');
        return;
      }

      // Get or create challenger user
      let user = await models.User.findByPk(challengerId);
      if (!user) {
        logger.info('Creating new user for challenger', { challengerId });
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
          return session.save();
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

      logger.info('Created confirmation session for challenger', { sessionId: confirmSession.id });

      // Update the group message with a button to confirm in DM (deeplink)
      const botUsername = (await ctx.telegram.getMe()).username;
      const deeplink = `https://t.me/${botUsername}?start=confirm_${confirmSession.id}`;

      // Format wager amount to remove unnecessary decimals
      const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

      // Get creator's and challenger's user info for display
      const creator = await models.User.findByPk(flip.creatorId);
      const creatorDisplay = creator?.username ? `@${creator.username}` : creator?.firstName || 'A player';
      
      // Get challenger's username or name
      const challenger = await models.User.findByPk(challengerId);
      const challengerDisplay = challenger?.username ? `@${challenger.username}` : challenger?.firstName || 'Challenger';

      await ctx.editMessageText(
        `🪙 <b>Challenger Found!</b>\n\n` +
        `${challengerDisplay} is reviewing the flip.\n\n` +
        `💰 <b>Wager:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
        `🌐 <b>Network:</b> ${flip.tokenNetwork}`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url('🔗 Confirm in DM', deeplink)],
          ]).reply_markup,
        }
      );

      // Send confirmation prompt directly to challenger's DM
      try {
        logger.info('Sending confirmation DM to challenger', { 
          challengerId, 
          flipId, 
          sessionId: confirmSession.id,
          deeplink 
        });
        
        const dmResult = await ctx.telegram.sendMessage(
          challengerId,
          `🪙 <b>Challenge Accepted!</b>\n\n` +
          `${creatorDisplay} challenged you to a flip!\n\n` +
          `💰 <b>Wager:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
          `🌐 <b>Network:</b> ${flip.tokenNetwork}\n\n` +
          `Tap the button below to confirm and send your deposit:`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url('✅ Confirm Challenge', deeplink)],
            ]).reply_markup,
          }
        );
        logger.info('Sent confirmation DM to challenger', { challengerId, flipId, messageId: dmResult.message_id });
      } catch (dmErr) {
        logger.error('Failed to send confirmation DM', { 
          error: dmErr.message, 
          errorCode: dmErr.code,
          errorResponse: dmErr.response,
          challengerId, 
          flipId 
        });
        console.error('[acceptFlip] DM Send Error:', dmErr);
        // If DM fails, try to send a group message instead
        try {
          await ctx.reply(
            `⚠️ <b>Couldn't send DM to challenger</b>\n\n` +
            `${challengerDisplay}, please open a DM with the bot and use /start to continue.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('Failed to send group fallback message', err.message);
        }
      }

      await ctx.answerCbQuery('✅ Check your DM to confirm the challenge!');

      logger.info('Flip acceptance complete', { flipId, challengerId });
    } catch (error) {
      logger.error('Error accepting flip', { error: error.message, stack: error.stack, flipId, userId: ctx.from.id });
      try {
        await ctx.answerCbQuery('❌ Error accepting challenge. Please try again.');
      } catch (e) {
        logger.error('Failed to send error callback', { error: e.message });
      }
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
            `<a href="tg://user?id=${flip.creatorId}">${(await models.User.findByPk(flip.creatorId))?.firstName || 'Player'}</a> started a flip for <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n\n` +
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

      // Check for active flip in this group (any flip not completed or cancelled)
      const activeFlip = await models.CoinFlip.findOne({
        where: {
          groupChatId,
          status: {
            [Op.notIn]: ['COMPLETED', 'CANCELLED'],
          },
        },
      });

      if (activeFlip) {
        await ctx.reply(
          `⏸️ <b>A flip is already in progress!</b>\n\n` +
          `Only one coin flip can happen at a time in this group.\n` +
          `Please wait for the current flip to complete.`,
          { parse_mode: 'HTML' }
        );
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
