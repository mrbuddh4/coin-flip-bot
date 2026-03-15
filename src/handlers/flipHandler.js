const { Markup } = require('telegraf');
const { Op } = require('sequelize');
const { getDB } = require('../database');
const { getBlockchainManager } = require('../blockchain/manager');
const { performCoinFlip, formatAddress, isValidNumber, formatNetworkName } = require('../utils/helpers');
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
        order: [['updatedAt', 'DESC']], // Use updatedAt to get the most recently modified session
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
        `<b>Network:</b> ${formatNetworkName(tokenInfo.network)}\n\n` +
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
        logger.info('[confirmCreatorDeposit] Insufficient deposit received', { flipId });
        
        // Check if notification already sent for this verification attempt
        const lastNotificationTime = flip.data?.lastInsufficientDepositNotification || 0;
        const timeSinceLastNotification = Date.now() - lastNotificationTime;
        
        // Only send notification if more than 30 seconds have passed since last one
        if (timeSinceLastNotification > 30000) {
          const formattedExpected = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
          const receivedAmount = parseFloat(verification.amount || '0');
          const shortfallAmount = (parseFloat(flip.wagerAmount) - receivedAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
          
          // Check if wrong token was detected
          let messageText;
          if (verification.isWrongToken) {
              const wrongTokenName = verification.wrongToken === 'NATIVE' ? 'SOL (native)' : (verification.wrongToken || 'unknown token');
            messageText = 
              `⚠️ <b>Wrong Token Detected</b>\n\n` +
              `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
              `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${wrongTokenName}\n\n` +
              `<b>Status: Automatically refunding your ${wrongTokenName}...</b>\n\n` +
              `Please send the correct token: <b>${flip.tokenSymbol}</b>`;
          } else {
            messageText = 
              `❌ <b>Insufficient Deposit</b>\n\n` +
              `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
              `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
              `<b>Still needed: ${shortfallAmount} ${flip.tokenSymbol}</b>\n\n` +
              `You have <b>3 minutes</b> to send the remaining amount to the same address, otherwise your deposit will be refunded and the challenge cancelled.`;
          }
          
          await ctx.reply(messageText);
          
          // Record that we just sent a notification
          if (!flip.data) flip.data = {};
          flip.data.lastInsufficientDepositNotification = Date.now();
          flip.data.partialDepositReceived = receivedAmount;
          flip.data.partialDepositAttempt = true;
          await flip.save();
        } else {
          logger.info('[confirmCreatorDeposit] Skipping duplicate notification (sent within last 30s)', { flipId });
        }
        
        // Set timeout to refund partial deposit if not completed in 3 minutes
        setTimeout(async () => {
          try {
            const flipCheck = await models.CoinFlip.findByPk(flip.id);
            if (flipCheck && flipCheck.status === 'WAITING_CHALLENGER_DEPOSIT' && flipCheck.data?.partialDepositAttempt) {
              logger.info('[insufficient_deposit_timeout] Refunding partial deposit and cancelling', { flipId: flip.id });
              
              // Cancel the challenge
              flipCheck.status = 'CANCELLED';
              flipCheck.data = { ...flipCheck.data, cancelReason: 'Insufficient deposit - timeout' };
              await flipCheck.save();
              
              // Refund the partial amount that was sent
              if (verification.depositSender && verification.amount) {
                try {
                  const blockchainManager = getBlockchainManager();
                  const supportedTokens = config.supportedTokens;
                  let tokenAddress = 'NATIVE';
                  let tokenDecimals = 18;
                  
                  for (const key in supportedTokens) {
                    if (supportedTokens[key].symbol === flipCheck.tokenSymbol && supportedTokens[key].network === flipCheck.tokenNetwork) {
                      tokenAddress = supportedTokens[key].address || 'NATIVE';
                      tokenDecimals = supportedTokens[key].decimals || 18;
                      break;
                    }
                  }

                  await blockchainManager.sendWinnings(
                    flipCheck.tokenNetwork,
                    tokenAddress,
                    verification.depositSender,
                    verification.amount,
                    tokenDecimals
                  );
                  
                  logger.info('[insufficient_deposit_timeout] Refunded partial deposit', { 
                    flipId: flip.id,
                    amount: verification.amount,
                    recipient: verification.depositSender
                  });
                } catch (refundErr) {
                  logger.error('[insufficient_deposit_timeout] Failed to refund partial deposit', { 
                    flipId: flip.id,
                    error: refundErr.message 
                  });
                }
              }
            }
          } catch (err) {
            logger.error('[insufficient_deposit_timeout] Error in timeout handler', { flipId: flip.id, error: err.message });
          }
        }, 180000); // 3 minutes
        
        return;
      }

      // Mark deposit as confirmed
      flip.creatorDepositConfirmed = true;
      flip.status = 'WAITING_CHALLENGER';
      
      // Store the detected sender address for refunds
      if (verification.depositSender) {
        flip.creatorDepositWalletAddress = verification.depositSender;
        logger.info('Detected creator deposit sender', { flipId, sender: verification.depositSender });
      }
      
      // If they sent more than the wager, refund the excess
      const receivedAmount = parseFloat(verification.amount || flip.wagerAmount);
      const wagerAmount = parseFloat(flip.wagerAmount);
      
      if (receivedAmount > wagerAmount) {
        const excessAmount = receivedAmount - wagerAmount;
        logger.info('Excess deposit detected, will refund', { flipId, excess: excessAmount, sender: verification.depositSender });
        
        // Notify user about overpayment and refund
        const formattedReceived = receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
        const formattedWager = wagerAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
        const formattedExcess = excessAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
        
        await ctx.reply(
          `⚠️ <b>Overpayment Detected</b>\n\n` +
          `You sent: ${formattedReceived} ${flip.tokenSymbol}\n` +
          `Wager amount: ${formattedWager} ${flip.tokenSymbol}\n\n` +
          `<b>Refunding excess: ${formattedExcess} ${flip.tokenSymbol}</b>\n\n` +
          `The refund will be sent to your wallet shortly.`,
          { parse_mode: 'HTML' }
        );
        
        try {
          if (verification.depositSender) {
            const blockchainManager = getBlockchainManager();
            const supportedTokens = config.supportedTokens;
            let tokenAddress = 'NATIVE';
            let tokenDecimals = 18;
            
            for (const key in supportedTokens) {
              if (supportedTokens[key].symbol === flip.tokenSymbol && supportedTokens[key].network === flip.tokenNetwork) {
                tokenAddress = supportedTokens[key].address || 'NATIVE';
                tokenDecimals = supportedTokens[key].decimals || 18;
                break;
              }
            }

            const excessStr = excessAmount.toFixed(tokenDecimals);
            await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              tokenAddress,
              verification.depositSender,
              excessStr,
              tokenDecimals
            );
            
            logger.info('Refunded excess deposit', { 
              flipId, 
              excess: excessStr,
              recipient: verification.depositSender
            });
          }
        } catch (excessErr) {
          logger.error('Failed to refund excess deposit', { flipId, error: excessErr.message });
        }
      }
      
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
        flip.creatorDepositWalletAddress = null;
        flip.challengerDepositWalletAddress = null;
        flip.creatorAccumulatedDeposit = 0;
        flip.challengerAccumulatedDeposit = 0;
        await flip.save();

        await this.notifyCancelledFlip(flip, 'Creator did not deposit tokens within 3 minutes.');
      } else if (role === 'challenger' && !flip.challengerDepositConfirmed) {
        flip.challengerTimedOut = true;
        flip.status = 'CANCELLED';
        flip.creatorDepositWalletAddress = null;
        flip.challengerDepositWalletAddress = null;
        flip.creatorAccumulatedDeposit = 0;
        flip.challengerAccumulatedDeposit = 0;
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
        
        // Handle expired/cancelled flips
        if (flip.status === 'CANCELLED') {
          await ctx.answerCbQuery('❌ This challenge expired');
          
          // Send a helpful message to the challenger with option to start new challenge
          try {
            const botInfo = await ctx.telegram.getMe();
            await ctx.reply(
              `⏰ <b>Challenge Expired</b>\n\n` +
              `The challenge for <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b> has expired.\n\n` +
              `Would you like to start a new challenge?`,
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.url('🪙 Start a Challenge', `https://t.me/${botInfo.username}`)],
                ]).reply_markup,
              }
            );
          } catch (err) {
            logger.warn('Failed to send expired challenge message', { flipId, error: err.message });
          }
        } else {
          await ctx.answerCbQuery('❌ This flip is no longer available.');
        }
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

      // Edit the group message with button to take challenger to bot DM
      try {
        await ctx.editMessageCaption(
          `🪙 <b>Challenger Found!</b>\n\n` +
          `${challengerDisplay} has accepted the challenge!\n\n` +
          `💰 <b>Wager:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
          `🌐 <b>Network:</b> ${formatNetworkName(flip.tokenNetwork)}`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url('📱 Confirm in DM', deeplink)],
            ]).reply_markup,
          }
        );
      } catch (captionErr) {
        // If caption edit fails (text message), try text edit
        logger.info('Caption edit failed, trying text edit', { error: captionErr.message });
        await ctx.editMessageText(
          `🪙 <b>Challenger Found!</b>\n\n` +
          `${challengerDisplay} has accepted the challenge!\n\n` +
          `💰 <b>Wager:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
          `🌐 <b>Network:</b> ${formatNetworkName(flip.tokenNetwork)}`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url('📱 Confirm in DM', deeplink)],
            ]).reply_markup,
          }
        ).catch((textErr) => {
          logger.warn('Both caption and text edits failed', { captionErr: captionErr.message, textErr: textErr.message });
        });
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

      // Handle both group-based and DM-initiated flips
      let token = session.data.tokenInfo;
      let groupChatId = session.data.groupChatId;

      // If this is a DM-initiated flip, we need to get the token info and group
      if (session.data.isDMFlip) {
        // Get full token info from supported tokens
        const supportedTokensMap = Array.from(
          new Map(
            Object.entries(config.supportedTokens).map(([key, val]) => [val.id, val])
          ).values()
        );
        const selectedToken = supportedTokensMap.find(t => t.id === session.data.tokenId);
        if (!selectedToken) {
          await ctx.reply('❌ Selected token not found.');
          return;
        }
        token = selectedToken;

        // Try to use last group activity
        const lastGroupSession = await models.BotSession.findOne({
          where: {
            userId,
            sessionType: 'LAST_GROUP_ACTIVITY',
          },
        });

        if (!lastGroupSession || !lastGroupSession.data?.groupId) {
          await ctx.reply(
            `❌ <b>Need a Group to Start Flip</b>\n\n` +
            `To start a flip, you first need to use /flip in a group to set up your group context.\n\n` +
            `Try this:\n` +
            `1️⃣ Go to a group chat\n` +
            `2️⃣ Use /flip command\n` +
            `3️⃣ Follow the prompts\n\n` +
            `Then you'll be able to start flips from this dashboard!`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        groupChatId = lastGroupSession.data.groupId;
      }

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
        `The bot will automatically verify your deposit.`,
        { parse_mode: 'HTML' }
      );

      // Send challenge message to group
      try {
        const botInfo = await ctx.telegram.getMe();
        const deeplink = `https://t.me/${botInfo.username}?start=accept_${flip.id}`;
        
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
              [Markup.button.url('Accept Challenge', deeplink)],
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
