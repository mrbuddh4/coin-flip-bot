const { Telegraf, Markup, session } = require('telegraf');
const { Op } = require('sequelize');
const config = require('./config');
const { initDB, getDB } = require('./database');
const { initBlockchainManager } = require('./blockchain/manager');
const FlipHandler = require('./handlers/flipHandler');
const ExecutionHandler = require('./handlers/executionHandler');
const AdminHandler = require('./handlers/adminHandler');
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

    bot.action(/^start_flip_(.+)$/, async (ctx) => {
      const tokenId = parseInt(ctx.match[1]);
      const supportedTokens = await getSupportedTokensList();
      const token = supportedTokens[tokenId];

      if (token) {
        await FlipHandler.startFlipInGroup(ctx, token);
      }
      await ctx.answerCbQuery();
    });

    bot.action(/^accept_flip_(.+)$/, async (ctx) => {
      const flipId = ctx.match[1];
      const { models } = getDB();
      
      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip not found or expired.');
        return;
      }

      await FlipHandler.acceptFlip(ctx, flipId);
    });

    bot.action(/^claim_winnings_(.+)$/, async (ctx) => {
      await ExecutionHandler.claimWinnings(ctx, ctx.match[1]);
    });

    bot.action(/^cancel_flip_(.+)$/, async (ctx) => {
      await ExecutionHandler.cancelFlip(ctx, ctx.match[1]);
    });

    // Confirm flip challenge from DM prompt
    bot.action(/^confirm_flip_(.+)$/, async (ctx) => {
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

        if (!flip || flip.status !== 'WAITING_CHALLENGER') {
          await ctx.answerCbQuery('❌ Flip no longer available');
          return;
        }

        // Update flip status to waiting for deposit
        flip.challengerId = userId;
        flip.status = 'WAITING_CHALLENGER_DEPOSIT';
        await flip.save();

        // Update session to awaiting deposit
        session.currentStep = 'AWAITING_DEPOSIT';
        await session.save();

        // Get bot wallet and send deposit instructions
        const blockchainManager = getBlockchainManager();
        const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);

        await ctx.editMessageText(
          `🎮 <b>Challenge Confirmed!</b>\n\n` +
          `You have <b>3 minutes</b> to send your wager.\n\n` +
          `💰 <b>Wager Amount:</b> ${flip.wagerAmount} ${flip.tokenSymbol}\n` +
          `🌐 <b>Network:</b> ${flip.tokenNetwork}\n\n` +
          `📮 <b>Send to this address:</b>\n\n` +
          `<code>${botWalletAddress}</code>\n\n` +
          `✅ Reply <code>confirmed</code> when sent.`,
          {
            parse_mode: 'HTML',
          }
        );

        await ctx.answerCbQuery('✅ Challenge confirmed! Send your wager tokens.');

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
      } catch (error) {
        logger.error('Error confirming flip', error);
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
            `<a href="tg://user?id=${flip.creatorId}">A player</a> started a flip for <b>${flip.wagerAmount} ${flip.tokenSymbol}</b>\n\n` +
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
      } catch (error) {
        logger.error('Error rejecting flip', error);
        await ctx.answerCbQuery('❌ Error rejecting challenge');
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
        session.data.tokenInfo = token;
        session.currentStep = 'AWAITING_WAGER';
        await session.save();

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
      
      // Check if this is a flip session start (from the deeplink button)
      const startParam = ctx.startPayload;
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

  dmMessageHandler: async (ctx) => {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const message = ctx.message.text.trim().toLowerCase();

      // Find active session
      const activeSession = await models.BotSession.findOne({
        where: { userId },
        order: [['createdAt', 'DESC']],
      });

      if (!activeSession) {
        await ctx.reply('❌ No active session. Use /flip in a group first.');
        return;
      }

      // Handle INITIATING sessions (wager entry for /flip)
      if (activeSession.sessionType === 'INITIATING') {
        if (activeSession.currentStep === 'AWAITING_WAGER') {
          await FlipHandler.processWagerAmount(ctx);
        } else if (activeSession.currentStep === 'AWAITING_DEPOSIT') {
          if (message === 'confirmed') {
            await FlipHandler.confirmCreatorDeposit(ctx);
          } else {
            await ctx.reply('Please reply with "confirmed" when you\'ve sent the tokens.');
          }
        }
      } else if (activeSession.sessionType === 'INITIATING_DM_FLIP') {
        if (activeSession.currentStep === 'AWAITING_WAGER') {
          await FlipHandler.processDMWagerAmount(ctx, activeSession);
        }
      } else if (activeSession.sessionType === 'CONFIRMING_DEPOSIT') {
        if (message === 'confirmed') {
          await handleChallengerDepositConfirm(ctx);
        } else {
          await ctx.reply('Please reply with "confirmed" when you\'ve sent the tokens.');
        }
      } else if (activeSession.sessionType === 'CLAIMING_WINNINGS') {
        await ExecutionHandler.processPayoutAddress(ctx);
      }
    } catch (error) {
      logger.error('Error handling DM message', error);
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

        await ctx.reply(
          '🪙 <b>Start a Coin Flip!</b>\n\n' +
          'Click below to set up your flip in DM (for privacy)',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url('💬 Start in DM', `https://t.me/${botInfo.username}?start=flip_${session.id}`)],
            ]).reply_markup,
          }
        );
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
  const { getBlockchainManager } = require('./blockchain/manager');
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
      `Expected: ${flip.wagerAmount} ${flip.tokenSymbol}\n` +
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
