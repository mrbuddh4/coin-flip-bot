const { Telegraf, Markup, session } = require('telegraf');
const { Op } = require('sequelize');
const config = require('./config');
const { initDB, getDB } = require('./database');
const { initBlockchainManager, getBlockchainManager } = require('./blockchain/manager');
const FlipHandler = require('./handlers/flipHandler');
const ExecutionHandler = require('./handlers/executionHandler');
const AdminHandler = require('./handlers/adminHandler');
const WalletHandler = require('./handlers/walletHandler');
const DatabaseUtils = require('./database/utils');
const logger = require('./utils/logger');
const { validateConfig } = require('./utils/helpers');

let bot;
let sessionStore = {};

/**
 * Initialize the bot
 */
async function initBot() {
  try {
    // Validate configuration
    validateConfig();

    // Initialize database
    console.log('Initializing database...');
    await initDB();

    // Initialize blockchain
    console.log('Initializing blockchain...');
    try {
      initBlockchainManager();
    } catch (blockchainErr) {
      console.error('[BLOCKCHAIN_INIT_ERROR]', blockchainErr.message);
      throw blockchainErr;
    }

    // Create bot instance
    console.log('Creating Telegraf instance...');
    bot = new Telegraf(config.telegram.token);

    // Set up bot commands menu
    console.log('Setting up commands menu...');
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🎲 Start the bot' },
      { command: 'help', description: '❓ How to play' },
      { command: 'stats', description: '📊 Your game statistics' },
      { command: 'flip', description: '🪙 Start a coin flip' },
      { command: 'wallet', description: '💳 Manage wallet addresses' },
    ]);

    // Middleware setup
    console.log('Setting up middleware...');
    bot.use(middleware.errorHandler);

    // Commands
    console.log('Registering commands...');
    bot.start(handlers.start);
    bot.help(handlers.help);
    bot.command('stats', handlers.stats);
    bot.command('flip', handlers.flip);
    bot.command('wallet', handlers.wallet);

    // Admin commands
    AdminHandler.registerCommands(bot);

    // Handle bot joining a group
    bot.on('my_chat_member', async (ctx) => {
      try {
        const status = ctx.update.my_chat_member.new_chat_member.status;
        const chat = ctx.chat;

        // Bot was added to a group
        if (status === 'member' && chat.type !== 'private') {
          const botInfo = await ctx.telegram.getMe();
          
          await ctx.reply(
            `🤖 <b>Welcome to Coin Flip Bot!</b>\n\n` +
            `I'm here to run fair, transparent coin flip games!\n\n` +
            `<b>How it works:</b>\n` +
            `1️⃣ Members start flips in their chat with me\n` +
            `2️⃣ I send a challenge here with their wager\n` +
            `3️⃣ Someone accepts the challenge\n` +
            `4️⃣ I flip a coin 🪙\n` +
            `5️⃣ Winner claims their prize!\n\n` +
            `💬 Click the button below to start!`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.url('💬 Start Flip with Bot', `https://t.me/${botInfo.username}`)]
              ]).reply_markup,
            }
          );
        }
      } catch (error) {
        logger.error('Error handling bot group join', error);
      }
    });

    // Message handlers for DMs
    bot.on('text', async (ctx) => {
      if (ctx.chat.type === 'private') {
        await handlers.dmMessageHandler(ctx);
      }
    });

    // Callback handlers

    // Wallet management callbacks
    bot.action('update_evm_wallet', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleUpdateEVM(ctx);
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error updating EVM wallet', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    bot.action('update_solana_wallet', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleUpdateSolana(ctx);
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error updating Solana wallet', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    bot.action('remove_all_wallets', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleRemoveAll(ctx);
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error removing wallets', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    // Start flip in DM from group button
    bot.action(/^start_flip_dm_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id; // Telegram user ID

        logger.info('start_flip_dm button clicked', { sessionId, userId });

        const session = await models.BotSession.findByPk(sessionId);
        if (!session) {
          logger.error('Session not found', { sessionId, userId });
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }
        
        // Ensure both are numbers for comparison
        const sessionUserId = parseInt(session.userId);
        const clickingUserId = parseInt(userId);
        
        if (sessionUserId !== clickingUserId) {
          logger.error('Session user mismatch', { sessionId, sessionUserId, clickingUserId });
          await ctx.answerCbQuery('❌ This button is for someone else');
          return;
        }

        // Get supported tokens and send to DM
        const supportedTokens = await getSupportedTokensList();
        const tokenButtons = supportedTokens.map((token, idx) => [
          Markup.button.callback(
            `${token.symbol} (${token.network})`,
            `start_flip_${session.id}_${idx}`
          ),
        ]);

        // Send token selection to DM
        await ctx.telegram.sendMessage(
          userId,
          '🪙 <b>Select a Token</b>\n\nChoose which token to flip:',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard(tokenButtons).reply_markup,
          }
        );

        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error starting flip in DM', error);
        await ctx.answerCbQuery('❌ Error');
      }
    });

    bot.action(/^accept_flip_(.+)$/, async (ctx) => {
      const flipId = ctx.match[1];
      const { models } = getDB();
      const userId = ctx.from.id;
      
      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip not found or expired.');
        return;
      }

      try {
        logger.info('Accept flip action triggered', { flipId, userId });
        
        // Show loading popup
        await ctx.answerCbQuery('⏳ Accepting challenge...');
        
        // Call the flip handler (which sends auto-DM)
        await FlipHandler.acceptFlip(ctx, flipId);
        
        // Delete the message button to clean up group
        await ctx.deleteMessage().catch(() => {});
        
        // Also send a follow-up to the user in the group to explain        
        await ctx.reply(
          '✅ <b>Challenge Accepted!</b>\n\n' +
          'Check your DM with the bot to confirm and send your deposit.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
        
        logger.info('Accept flip completed', { flipId, userId });
      } catch (error) {
        logger.error('Error accepting flip', { error: error.message, flipId, userId });
        await ctx.answerCbQuery('❌ Error accepting challenge').catch(() => {});
      }
    });

    bot.action(/^cancel_flip_(.+)$/, async (ctx) => {
      try {
        await ExecutionHandler.cancelFlip(ctx, ctx.match[1]);
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error canceling flip', error);
      }
    });

    // Confirm flip challenge from DM prompt
    bot.action(/^confirm_flip_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        logger.info('[confirm_flip] Handler called', { sessionId, userId });

        const session = await models.BotSession.findByPk(sessionId);
        if (!session) {
          logger.info('[confirm_flip] Session not found', { sessionId });
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }

        logger.info('[confirm_flip] Session found', {
          sessionId,
          userId: session.userId,
          currentStep: session.currentStep,
          sessionType: session.sessionType,
          hasData: !!session.data,
        });

        // Ensure both are numbers for comparison
        const sessionUserId = parseInt(session.userId);
        const clickingUserId = parseInt(userId);
        
        if (sessionUserId !== clickingUserId) {
          logger.info('[confirm_flip] User ID mismatch', { sessionUserId, clickingUserId });
          await ctx.answerCbQuery('❌ This button is for someone else');
          return;
        }

        if (session.currentStep !== 'AWAITING_CONFIRMATION') {
          logger.info('[confirm_flip] Wrong step', {
            currentStep: session.currentStep,
            expected: 'AWAITING_CONFIRMATION',
          });
          await ctx.answerCbQuery('❌ Challenge already confirmed or rejected');
          return;
        }

        const flipId = session.data?.flipId;
        logger.info('[confirm_flip] Got flipId from session', { flipId, hasFlipId: !!flipId });

        if (!flipId) {
          logger.warn('[confirm_flip] No flipId in session.data', { sessionData: session.data });
          await ctx.answerCbQuery('❌ Missing flip information');
          return;
        }

        const flip = await models.CoinFlip.findByPk(flipId);
        logger.info('[confirm_flip] Retrieved flip', {
          flipId,
          flipExists: !!flip,
          flipStatus: flip?.status,
        });

        if (!flip || flip.status !== 'WAITING_CHALLENGER') {
          logger.warn('[confirm_flip] Flip not found or wrong status', {
            flipExists: !!flip,
            flipStatus: flip?.status,
            expectedStatus: 'WAITING_CHALLENGER',
          });
          await ctx.answerCbQuery('❌ Flip no longer available');
          return;
        }

        // Update flip status to waiting for deposit
        flip.challengerId = userId;
        flip.status = 'WAITING_CHALLENGER_DEPOSIT';
        await flip.save();
        logger.info('[confirm_flip] Flip updated', { flipId, newStatus: flip.status });

        // Check if user has a wallet address in their profile
        const userProfile = await models.UserProfile.findByPk(userId);
        const walletField = flip.tokenNetwork === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
        const storedWallet = userProfile?.[walletField];

        if (storedWallet) {
          // Use stored wallet address
          flip.challengerDepositWalletAddress = storedWallet;
          await flip.save();

          logger.info('Using stored wallet address for challenger', { flipId, network: flip.tokenNetwork });

          session.currentStep = 'AWAITING_DEPOSIT';
          await session.save();

          // Show deposit instructions directly
          const blockchainManager = getBlockchainManager();
          const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);
          const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

          await ctx.reply(
            `💰 <b>Send Your Deposit</b>\n\n` +
            `You have <b>3 minutes</b> to complete this.\n\n` +
            `<b>Wager Amount:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
            `<b>Network:</b> ${flip.tokenNetwork}\n\n` +
            `📮 <b>Send to this address:</b>\n\n` +
            `<code>${botWalletAddress}</code>\n\n` +
            `Once sent, click the button below:`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('✅ I Sent the Deposit', `deposit_confirmed_${session.id}`)],
              ]).reply_markup,
            }
          );

          await ctx.answerCbQuery('✅ Challenge confirmed! Deposit address ready.');
        } else {
          // No stored wallet - ask user to set it up
          session.currentStep = 'AWAITING_WALLET_ADDRESS';
          await session.save();
          logger.info('[confirm_flip] No stored wallet, asking user to set up', { sessionId, network: flip.tokenNetwork });

          await ctx.reply(
            `❌ <b>Wallet Address Required</b>\n\n` +
            `We need your ${flip.tokenNetwork} wallet address to send you your winnings!\n\n` +
            `Use /wallet to add your receiving addresses, then come back here to continue.`,
            { parse_mode: 'HTML' }
          );

          await ctx.answerCbQuery('✅ Challenge confirmed! Please set up your wallet.');
        }

        // Update group message
        try {
          await ctx.telegram.editMessageText(
            flip.groupChatId,
            flip.groupMessageId,
            null,
            `🪙 <b>Challenger Found!</b>\n\n` +
            `⏳ Waiting for both players to send deposits...\n` +
            `⏰ Timeout in 3 minutes`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('Failed to update group message on confirmation', err.message);
        }

        logger.info('Flip challenge confirmed', { userId, flipId });
        
        // Delete the original message with the button
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error confirming flip', {
          message: error.message,
          stack: error.stack,
          error: error.toString(),
        });
        await ctx.answerCbQuery('❌ Error confirming challenge');
      }
    });

    // Reject flip challenge from DM prompt
    bot.action(/^reject_flip_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        const session = await models.BotSession.findByPk(sessionId);
        if (!session) {
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }

        // Ensure both are numbers for comparison
        const sessionUserId = parseInt(session.userId);
        const clickingUserId = parseInt(userId);
        
        if (sessionUserId !== clickingUserId) {
          await ctx.answerCbQuery('❌ This button is for someone else');
          return;
        }

        if (session.currentStep !== 'AWAITING_CONFIRMATION') {
          await ctx.answerCbQuery('❌ Challenge already confirmed or rejected');
          return;
        }

        const flipId = session.data.flipId;
        const flip = await models.CoinFlip.findByPk(flipId);

        if (!flip) {
          await ctx.answerCbQuery('❌ Flip not found');
          return;
        }

        // Reset flip to waiting for challenger
        if (flip.status === 'WAITING_CHALLENGER') {
          // Nothing to do, just delete session
        } else if (flip.status.includes('CHALLENGER')) {
          flip.challengerId = null;
          flip.status = 'WAITING_CHALLENGER';
          await flip.save();
        }

        // Delete confirmation session
        await session.destroy();

        // Update group message
        try {
          await ctx.telegram.editMessageText(
            flip.groupChatId,
            flip.groupMessageId,
            null,
            `🪙 <b>Coin Flip Challenge</b>\n\n` +
            `<a href="tg://user?id=${flip.creatorId}">A player</a> started a flip for <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n\n` +
            `⏰ Waiting for another challenger...`,
            { 
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{ text: 'Accept Challenge', callback_data: `accept_flip_${flip.id}` }]],
              },
            }
          );
        } catch (err) {
          logger.warn('Failed to update group message on rejection', err.message);
        }

        await ctx.editMessageText(
          `❌ Challenge rejected.\n\n` +
          `Waiting for another challenger in the group...`,
          { parse_mode: 'HTML' }
        );

        await ctx.answerCbQuery('Challenge rejected');

        logger.info('Flip challenge rejected', { userId, flipId });
        
        // Delete the original message with the button
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error rejecting flip', {
          message: error.message,
          stack: error.stack,
          error: error.toString(),
        });
        await ctx.answerCbQuery('❌ Error rejecting challenge');
      }
    });

    // Handle challenger deposit confirmation
    bot.action(/^deposit_confirmed_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        logger.info('[deposit_confirmed] Button clicked', { sessionId, userId });

        const session = await models.BotSession.findByPk(sessionId);
        if (!session) {
          logger.warn('[deposit_confirmed] Session not found', { sessionId });
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }

        // Verify user
        if (parseInt(session.userId) !== userId) {
          await ctx.answerCbQuery('❌ This is not your challenge');
          return;
        }

        const flipId = session.data?.flipId;
        const flip = await models.CoinFlip.findByPk(flipId);

        if (!flip) {
          await ctx.answerCbQuery('❌ Flip not found');
          return;
        }

        logger.info('[deposit_confirmed] Verifying challenger deposit', { flipId, userId });
        await ctx.answerCbQuery('⏳ Verifying deposit...');

        // Verify deposit on blockchain (with retries for blockchain indexing)
        const blockchainManager = getBlockchainManager();
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals
        );

        if (!verification.received) {
          logger.warn('[deposit_confirmed] Deposit not received', { userId, flipId });
          await ctx.reply(
            `⏳ <b>Deposit not received yet</b>\n\n` +
            `Expected: ${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
            `Received: ${verification.amount || '0'}\n\n` +
            `Please verify the transaction and try again.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        logger.info('[deposit_confirmed] Challenger deposit verified', { flipId, userId, amount: verification.amount });

        // Mark challenger deposit as confirmed
        flip.challengerDepositConfirmed = true;
        await flip.save();

        // Immediately edit message to remove button and show confirmation
        try {
          await ctx.editMessageText(
            `✅ <b>Your Deposit Confirmed!</b>\n\n` +
            (flip.creatorDepositConfirmed ? `🎉 Both players ready! Executing flip...` : `⏳ Waiting for the other player's deposit...`),
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('Failed to edit confirmation message', err.message);
        }

        // Delete session  
        await session.destroy();

        // Check if both deposits are confirmed
        if (flip.creatorDepositConfirmed && flip.challengerDepositConfirmed) {
          logger.info('[deposit_confirmed] Both deposits confirmed, executing flip', { flipId });

          // Execute the flip
          await ExecutionHandler.executeFlip(flipId, ctx);
        } else {

          // Notify creator in group
          try {
            await ctx.telegram.editMessageText(
              flip.groupChatId,
              flip.groupMessageId,
              null,
              `🪙 <b>Challenger Found!</b>\n\n` +
              `⏳ Waiting for both players to send deposits...\n` +
              `⏰ Timeout in 3 minutes`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            logger.warn('Failed to update group message', err.message);
          }
        }
      } catch (error) {
        logger.error('Error confirming deposit', {
          message: error.message,
          stack: error.stack,
          error: error.toString(),
        });
        await ctx.answerCbQuery('❌ Error confirming deposit');
      }
      
      // Delete the button message after handling
      await ctx.deleteMessage().catch(() => {});
    });

    // Handle creator deposit confirmation - posts challenge to group after creator deposit verified
    bot.action(/^creator_deposit_confirmed_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const flipId = ctx.match[1];
        const userId = ctx.from.id;

        logger.info('[creator_deposit_confirmed] Button clicked', { flipId, userId });

        const flip = await models.CoinFlip.findByPk(flipId);
        if (!flip) {
          await ctx.answerCbQuery('❌ Flip not found');
          return;
        }

        // Verify user is the creator (ensure both are numbers for comparison)
        if (parseInt(flip.creatorId) !== parseInt(userId)) {
          await ctx.answerCbQuery('❌ Only the creator can confirm this');
          return;
        }

        logger.info('[creator_deposit_confirmed] Verifying creator deposit', { flipId, userId });
        await ctx.answerCbQuery('⏳ Verifying deposit...');

        // Verify deposit on blockchain (with retries for blockchain indexing)
        const blockchainManager = getBlockchainManager();
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals
        );

        if (!verification.received) {
          logger.warn('[creator_deposit_confirmed] Deposit not received', { userId, flipId });
          await ctx.reply(
            `⏳ <b>Deposit not received yet</b>\n\n` +
            `Expected: ${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
            `Received: ${verification.amount || '0'}\n\n` +
            `Please verify the transaction and try again.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        logger.info('[creator_deposit_confirmed] Creator deposit verified', { flipId, userId, amount: verification.amount });

        // Mark creator deposit as confirmed
        flip.creatorDepositConfirmed = true;
        flip.status = 'WAITING_CHALLENGER';
        await flip.save();

        // Immediately edit DM message to show confirmation (removes button, prevents re-clicking)
        try {
          await ctx.editMessageText(
            `✅ <b>Your Deposit Confirmed!</b>\n\n` +
            `🪙 Challenge posted to the group...`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('Failed to edit creator confirmation message', err.message);
        }

        // Delete the old "Start a Coin Flip!" message from the group before posting the challenge
        const session = await models.BotSession.findOne({
          where: {
            userId,
            sessionType: 'INITIATING',
            coinFlipId: flip.id,
          },
        });
        
        if (session?.data?.initialGroupMessageId) {
          try {
            await ctx.telegram.deleteMessage(flip.groupChatId, session.data.initialGroupMessageId);
            logger.info('[creator_deposit_confirmed] Deleted initial group message', { flipId, messageId: session.data.initialGroupMessageId });
          } catch (err) {
            logger.warn('[creator_deposit_confirmed] Failed to delete initial message', err.message);
          }
        }

        // Now post the challenge message to the group
        const userRecord = await models.User.findByPk(userId);
        const groupMessage = await ctx.telegram.sendMessage(
          flip.groupChatId,
          `🪙 <b>Coin Flip Challenge!</b>\n\n` +
          `<a href="tg://user?id=${userId}">${userRecord?.firstName || 'A player'}</a> started a flip for:\n\n` +
          `💰 <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n` +
          `🌐 Network: ${flip.tokenNetwork}\n\n` +
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

        // Confirm to creator
        await ctx.editMessageText(
          `✅ <b>Your Deposit Confirmed!</b>\n\n` +
          `Your challenge has been posted to the group. Waiting for a challenger...`,
          { parse_mode: 'HTML' }
        );

        logger.info('[creator_deposit_confirmed] Challenge posted to group', { flipId, groupMessageId: groupMessage.message_id });
        
        // Delete the button message after handling
        await ctx.deleteMessage().catch(() => {});
      } catch (error) {
        logger.error('Error confirming creator deposit', {
          message: error.message,
          stack: error.stack,
          error: error.toString(),
        });
        await ctx.answerCbQuery('❌ Error confirming deposit');
      }
    });

    bot.action(/^start_flip_(.+)_(\d+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const tokenIdx = parseInt(ctx.match[2]);
        const userId = ctx.from.id;

        logger.info('Token selection clicked', { sessionId, tokenIdx, userId });

        const session = await models.BotSession.findByPk(sessionId);
        if (!session) {
          logger.error('Session not found for token selection', { sessionId });
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }

        // Ensure both are numbers for comparison
        const sessionUserId = parseInt(session.userId);
        const clickingUserId = parseInt(userId);
        
        if (sessionUserId !== clickingUserId) {
          logger.error('User mismatch on token selection', { sessionUserId, clickingUserId });
          await ctx.answerCbQuery('❌ This button is for someone else');
          return;
        }

        // Use the token list stored in the session to ensure consistent ordering
        const supportedTokens = session.data.tokensList || (await getSupportedTokensList());
        logger.info('Using tokens from session', { count: supportedTokens.length, tokenIdx });
        
        const token = supportedTokens[tokenIdx];

        if (!token) {
          logger.error('Token not found at index', { tokenIdx, availableTokens: supportedTokens.length });
          await ctx.answerCbQuery('❌ Token not found');
          return;
        }

        logger.info('Token selected', { token: token.symbol, network: token.network });

        // Store selected token and prepare to ask for wager
        // IMPORTANT: Must explicitly set and save for JSON field to persist
        session.data = {
          ...session.data,
          tokenInfo: token
        };
        session.currentStep = 'AWAITING_WAGER';
        await session.save();

        logger.info('Session saved with token info', { tokenInfo: session.data.tokenInfo });

        // Ask for wager amount - edit the message
        await ctx.editMessageText(
          `💰 <b>Enter Wager Amount</b>\n\n` +
          `Token: ${token.symbol}\n` +
          `Network: ${token.network}\n\n` +
          `Just reply with the amount.\n` +
          `Example: <code>10</code> or <code>100.5</code>`,
          { parse_mode: 'HTML' }
        );
        
        logger.info('Message edited for wager input');
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error selecting token', { error: error.message, stack: error.stack });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // Handle wallet menu button from /start
    bot.action('open_wallet_menu', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleWalletCommand(ctx);
      } catch (error) {
        logger.error('Error opening wallet menu', { error: error.message });
        await ctx.answerCbQuery('❌ Error opening wallet menu');
      }
    });

    logger.info('Bot initialized successfully');
    console.log('✅ Bot ready!');
  } catch (error) {
    console.error('[ERROR DETAILS]', error);
    console.error('[ERROR STACK]', error.stack);
    logger.error('Failed to initialize bot', error);
    process.exit(1);
  }
}

/**
 * Message handlers
 */
const handlers = {
  start: async (ctx) => {
    if (ctx.chat.type === 'private') {
      const { models } = getDB();
      const userId = ctx.from.id;
      
      // Check if this is a flip confirmation (from the challenger deeplink)
      const startParam = ctx.startPayload;
      if (startParam && startParam.startsWith('confirm_')) {
        const sessionId = startParam.replace('confirm_', '');
        
        try {
          const session = await models.BotSession.findByPk(sessionId);
          logger.info('[start] Confirm deeplink clicked', { sessionId, userId, sessionFound: !!session, currentStep: session?.currentStep });
          
          if (session && parseInt(session.userId) === userId && session.currentStep === 'AWAITING_CONFIRMATION') {
            // Valid confirmation session - check for wallet address
            const flip = await models.CoinFlip.findByPk(session.data.flipId);
            
            if (!flip) {
              await ctx.reply('❌ Flip not found');
              return;
            }

            // Set the challengerId now
            flip.challengerId = userId;
            flip.status = 'WAITING_CHALLENGER_DEPOSIT';
            await flip.save();
            logger.info('[start] Set challengerId on flip', { flipId: flip.id, challengerId: userId });

            // Check if user has a wallet address in their profile
            const userProfile = await models.UserProfile.findByPk(userId);
            const walletField = flip.tokenNetwork === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
            const storedWallet = userProfile?.[walletField];

            if (storedWallet) {
              // Use stored wallet address
              flip.challengerDepositWalletAddress = storedWallet;
              await flip.save();

              logger.info('[start] Using stored wallet for challenger', { flipId: flip.id, network: flip.tokenNetwork });

              session.currentStep = 'AWAITING_DEPOSIT';
              await session.save();

              // Show deposit instructions directly
              const blockchainManager = getBlockchainManager();
              const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);
              const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

              await ctx.reply(
                `💰 <b>Send Your Deposit</b>\n\n` +
                `You have <b>3 minutes</b> to complete this.\n\n` +
                `<b>Wager Amount:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
                `<b>Network:</b> ${flip.tokenNetwork}\n\n` +
                `📮 <b>Send to this address:</b>\n\n` +
                `<code>${botWalletAddress}</code>\n\n` +
                `Once sent, click the button below:`,
                {
                  parse_mode: 'HTML',
                  reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('✅ I Sent the Deposit', `deposit_confirmed_${session.id}`)],
                  ]).reply_markup,
                }
              );
            } else {
              // No stored wallet - ask user to set it up
              session.currentStep = 'AWAITING_WALLET_ADDRESS';
              await session.save();

              logger.info('[start] No stored wallet for challenger, asking to set up', { sessionId, network: flip.tokenNetwork });

              await ctx.reply(
                `❌ <b>Wallet Address Required</b>\n\n` +
                `We need your ${flip.tokenNetwork} wallet address to send you your winnings!\n\n` +
                `Use /wallet to add your receiving addresses, then come back here to continue.`,
                { parse_mode: 'HTML' }
              );
            }
            return;
          } else if (session) {
            logger.warn('[start] Confirmation session state mismatch', { userId, sessionUserId: session.userId, currentStep: session.currentStep });
            await ctx.reply('❌ This challenge has already been confirmed or is no longer available.');
            return;
          }
        } catch (error) {
          logger.error('Error handling confirmation start parameter', { error: error.message, sessionId });
          await ctx.reply('❌ Error loading challenge');
        }
      }

      // Check if this is a flip session start (from the deeplink button)
      if (startParam && startParam.startsWith('flip_')) {
        const sessionId = startParam.replace('flip_', '');
        
        try {
          const session = await models.BotSession.findByPk(sessionId);
          if (session && parseInt(session.userId) === userId) {
            // Valid flip session, send token selection
            const supportedTokens = await getSupportedTokensList();
            
            // Store the token list in the session to ensure consistent ordering
            session.data.tokensList = supportedTokens;
            await session.save();
            
            const tokenButtons = supportedTokens.map((token, idx) => [
              Markup.button.callback(
                `${token.symbol} (${token.network})`,
                `start_flip_${session.id}_${idx}`
              ),
            ]);

            await ctx.reply(
              '🪙 <b>Select a Token</b>\n\nChoose which token to flip:',
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(tokenButtons).reply_markup,
              }
            );
            return;
          }
        } catch (error) {
          logger.error('Error handling flip start parameter', error);
        }
      }

      // Regular start message
      const { models } = getDB();
      
      // Check if user has wallet addresses set up
      const userProfile = await models.UserProfile.findByPk(userId);
      const hasWallets = userProfile?.evmWalletAddress || userProfile?.solanaWalletAddress;
      
      if (!hasWallets) {
        // First time user - prompt to add wallets
        await ctx.reply(
          `🪙 <b>Welcome to Coin Flip Bot!</b>\n\n` +
          `Before you can start playing, please set up your wallet addresses.\n\n` +
          `These will be used to send you your winnings automatically.\n\n` +
          `Tap the button below to add your wallets:`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('💳 Add Wallet Addresses', 'open_wallet_menu')],
            ]).reply_markup,
          }
        );
        return;
      }
      
      // User already has wallets - show welcome message
      await ctx.reply(
        `🪙 <b>Welcome to Coin Flip Bot!</b>\n\n` +
        `Start a coin flip game from any group chat by using the buttons that appear.\n\n` +
        `<b>How it works:</b>\n` +
        `1️⃣ Click "Start Flip" button in group\n` +
        `2️⃣ Enter wager amount in DM\n` +
        `3️⃣ Send tokens to provided address\n` +
        `4️⃣ Wait for challenger\n` +
        `5️⃣ Bot flips a coin\n` +
        `6️⃣ Winner claims prizes!\n\n` +
        `<b>Supported Networks:</b> EVM (Ethereum, BSC, etc.), Solana\n\n` +
        `/help for more info`,
        { parse_mode: 'HTML' }
      );
    } else {
      // In group chat
      const { models } = getDB();

      // Get supported tokens for this group/network
      const supportedTokens = await getSupportedTokensList();

      if (supportedTokens.length === 0) {
        await ctx.reply('⚠️ No tokens configured for this bot yet.');
        return;
      }

      const inlineButtons = supportedTokens.map(token => [
        Markup.button.callback(
          `${token.symbol} (${token.network})`,
          `start_flip_${token.id}`
        ),
      ]);

      await ctx.reply(
        '🪙 <b>Welcome to Coin Flip!</b>\n\n' +
        'Select a token to start a flip:',
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(inlineButtons).reply_markup,
        }
      );
    }
  },

  help: async (ctx) => {
    await ctx.reply(
      `<b>🪙 Coin Flip Bot Help</b>\n\n` +
      `<b>Commands:</b>\n` +
      `/start - Welcome message\n` +
      `/help - This message\n` +
      `/stats - Your statistics\n` +
      `/deposit - Deposit tokens to your wallet\n\n` +
      `<b>How to Play:</b>\n` +
      `1. Start a flip with /start in a group\n` +
      `2. Specify your wager in DM\n` +
      `3. Send tokens to the provided address\n` +
      `4. Respond with "confirmed"\n` +
      `5. Wait for a challenger\n` +
      `6. Challenger follows same process\n` +
      `7. Bot flips a coin\n` +
      `8. Winner claims their prizes\n\n` +
      `<b>Rules:</b>\n` +
      `⏱️ 3 minutes to confirm each step\n` +
      `🚫 Only one active flip per group\n` +
      `👤 Creator can cancel if no challenger\n` +
      `💰 Winnings = 2x wager amount`,
      { parse_mode: 'HTML' }
    );
  },

  stats: async (ctx) => {
    try {
      const userId = ctx.from.id;
      const stats = await DatabaseUtils.getUserStats(userId);

      await ctx.reply(
        `📊 <b>Your Stats</b>\n\n` +
        `Total Games: ${stats.totalGames}\n` +
        `Wins: ${stats.wins}\n` +
        `Losses: ${stats.losses}\n` +
        `Win Rate: ${stats.winRate}%`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error('Error getting user stats', error);
      await ctx.reply('❌ Error retrieving statistics.');
    }
  },

  wallet: async (ctx) => {
    ctx.state.models = getDB().models;
    await WalletHandler.handleWalletCommand(ctx);
  },

  dmMessageHandler: async (ctx) => {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const message = ctx.message.text.trim().toLowerCase();

      logger.info('DM message received', { userId, message });

      // Find active session
      const activeSession = await models.BotSession.findOne({
        where: { userId },
        order: [['createdAt', 'DESC']],
      });

      if (!activeSession) {
        logger.warn('No active session found', { userId });
        await ctx.reply('❌ No active session. Use /flip in a group first.');
        return;
      }

      logger.info('Found active session', { sessionId: activeSession.id, sessionType: activeSession.sessionType, currentStep: activeSession.currentStep });

      // Check if this is wallet address input
      if (activeSession.sessionType === 'UPDATING_WALLET') {
        const handled = await WalletHandler.processWalletAddressInput(ctx, models);
        if (handled) return;
      }

      // Handle INITIATING sessions (wager entry for /flip)
      if (activeSession.sessionType === 'INITIATING') {
        if (activeSession.currentStep === 'AWAITING_WAGER') {
          logger.info('Processing wager amount for INITIATING session');
          await FlipHandler.processWagerAmount(ctx);
        } else if (activeSession.currentStep === 'AWAITING_DEPOSIT') {
          if (message === 'confirmed') {
            logger.info('Confirming creator deposit for INITIATING session');
            await FlipHandler.confirmCreatorDeposit(ctx);
          } else {
            await ctx.reply('Please reply with "confirmed" when you\'ve sent the tokens.');
          }
        } else {
          logger.warn('INITIATING session but unexpected currentStep', { currentStep: activeSession.currentStep });
        }
      } else if (activeSession.sessionType === 'INITIATING_DM_FLIP') {
        if (activeSession.currentStep === 'AWAITING_WAGER') {
          logger.info('Processing DM wager for INITIATING_DM_FLIP session');
          await FlipHandler.processDMWagerAmount(ctx, activeSession);
        }
      } else if (activeSession.sessionType === 'CONFIRMING_DEPOSIT') {
        if (message === 'confirmed') {
          logger.info('Confirming challenger deposit');
          await handleChallengerDepositConfirm(ctx);
        } else {
          await ctx.reply('Please reply with "confirmed" when you\'ve sent the tokens.');
        }
      } else if (activeSession.sessionType === 'CLAIMING_WINNINGS') {
        logger.info('Processing payout address');
        await ExecutionHandler.processPayoutAddress(ctx);
      } else {
        logger.warn('Unknown session type', { sessionType: activeSession.sessionType });
      }
    } catch (error) {
      logger.error('Error handling DM message', { error: error.message, stack: error.stack, userId: ctx.from.id });
      await ctx.reply('❌ An error occurred processing your message.');
    }
  },

  flip: async (ctx) => {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const isGroup = ctx.chat.type !== 'private';

      // Ensure user exists
      let user = await models.User.findByPk(userId);
      if (!user) {
        user = await models.User.create({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      }

      if (isGroup) {
        // Check if there's already an active flip in this group
        const activeFlip = await models.CoinFlip.findOne({
          where: {
            groupChatId: ctx.chat.id,
            status: {
              [Op.notIn]: ['COMPLETED', 'CANCELLED'],
            },
          },
        });

        if (activeFlip) {
          await ctx.reply(
            `⏸️ <b>A flip is already in progress!</b>\n\n` +
            `Only one coin flip can happen at a time.\n` +
            `Please wait for the current flip to complete.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        // In group: Create a session and post a button to start flip in DM
        const session = await models.BotSession.create({
          userId,
          sessionType: 'INITIATING',
          currentStep: 'AWAITING_DM_START',
          data: {
            groupId: ctx.chat.id,
          },
        });

        logger.info('Created session for flip', { sessionId: session.id, userId });

        if (!session || !session.id) {
          logger.error('Session creation failed - no ID', { userId });
          await ctx.reply('❌ Error creating session. Please try again.');
          return;
        }

        // Get bot info for deeplink
        const botInfo = await ctx.telegram.getMe();

        const groupMsg = await ctx.reply(
          '🪙 <b>Start a Coin Flip!</b>\n\n' +
          'Click below to set up your flip in DM (for privacy)',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url('💬 Start in DM', `https://t.me/${botInfo.username}?start=flip_${session.id}`)],
            ]).reply_markup,
          }
        );

        // Store the message ID so we can delete it later when challenge is posted
        session.data.initialGroupMessageId = groupMsg.message_id;
        await session.save();
      } else {
        // In DM: Check if user has a group context
        const lastGroupSession = await models.BotSession.findOne({
          where: {
            userId,
            sessionType: 'LAST_GROUP_ACTIVITY',
          },
        });

        if (!lastGroupSession || !lastGroupSession.data.groupId) {
          await ctx.reply(
            `❌ I don't know which group to post to!\n\n` +
            `Please use /flip in a group first to set up your group context.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Check if there's already an active flip in this group
        const activeFlip = await models.CoinFlip.findOne({
          where: {
            groupChatId: lastGroupSession.data.groupId,
            status: {
              [Op.notIn]: ['COMPLETED', 'CANCELLED'],
            },
          },
        });

        if (activeFlip) {
          await ctx.reply(
            `⏸️ <b>A flip is already in progress!</b>\n\n` +
            `Only one coin flip can happen at a time.\n` +
            `Please wait for the current flip to complete.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        // User has group context, show token selection
        const session = await models.BotSession.create({
          userId,
          sessionType: 'INITIATING',
          currentStep: 'SELECTING_TOKEN',
          data: {
            groupId: lastGroupSession.data.groupId,
          },
        });

        const supportedTokens = await getSupportedTokensList();
        const tokenButtons = supportedTokens.map((token, idx) => [
          Markup.button.callback(
            `${token.symbol} (${token.network})`,
            `start_flip_${session.id}_${idx}`
          ),
        ]);

        await ctx.reply(
          '🪙 <b>Select a Token</b>\n\n' +
          'Choose which token to flip:',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard(tokenButtons).reply_markup,
          }
        );
      }
    } catch (error) {
      console.error('[FLIP_ERROR]', error.message, error.stack);
      logger.error('Error starting flip', error);
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  },
};

/**
 * Middleware
 */
const middleware = {
  errorHandler: async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      logger.error('Bot error', error);
      try {
        await ctx.reply('❌ An error occurred. Please try again.');
      } catch (replyError) {
        logger.error('Failed to send error message', replyError);
      }
    }
  },
};

/**
 * Handle challenger deposit confirmation
 */
async function handleChallengerDepositConfirm(ctx) {
  const { models } = getDB();
  const userId = ctx.from.id;

  const session = await models.BotSession.findOne({
    where: { userId, sessionType: 'CONFIRMING_DEPOSIT' },
    order: [['createdAt', 'DESC']],
  });

  if (!session || !session.data.flipId) {
    await ctx.reply('❌ No active flip.');
    return;
  }

  const flip = await models.CoinFlip.findByPk(session.data.flipId);

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
      `❌ Deposit not detected.\n\n` +
      `Expected: ${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
      `Received: ${verification.amount}`
    );
    return;
  }

  // Mark challenger deposit confirmed
  flip.challengerDepositConfirmed = true;
  flip.status = 'COMPLETED';
  await flip.save();

  await ctx.reply(`✅ Deposit confirmed! Executing flip...`);

  // Execute the flip
  await ExecutionHandler.executeFlip(flip.id, ctx);
}

/**
 * Get supported tokens list
 */
async function getSupportedTokensList() {
  // Parse supported tokens from config
  const tokens = [];
  let id = 0;

  Object.entries(config.supportedTokens).forEach(([key, token]) => {
    tokens.push({
      id: id++,
      network: token.network,
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
    });
  });

  return tokens;
}

/**
 * Main entry point
 */
async function main() {
  try {
    await initBot();
    await bot.launch();

    console.log('🚀 Bot launched successfully');

    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (error) {
    logger.error('Fatal error', error);
    process.exit(1);
  }
}

module.exports = { initBot, bot };

// Run if this is the main module
if (require.main === module) {
  main();
}
