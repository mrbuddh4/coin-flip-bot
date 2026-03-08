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
      const sessionId = ctx.match[1];
      const { models } = getDB();
      const flipSession = await models.BotSession.findByPk(sessionId);

      if (flipSession && flipSession.data.flipId) {
        await FlipHandler.acceptFlip(ctx, flipSession.data.flipId);
      } else {
        await ctx.answerCbQuery('❌ Session expired');
      }
    });

    bot.action(/^claim_winnings_(.+)$/, async (ctx) => {
      await ExecutionHandler.claimWinnings(ctx, ctx.match[1]);
    });

    bot.action(/^cancel_flip_(.+)$/, async (ctx) => {
      await ExecutionHandler.cancelFlip(ctx, ctx.match[1]);
    });

    // DM flip flow: Select token and initiate flip
    bot.action(/^select_dm_token_(.+)_(\d+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const tokenIdx = parseInt(ctx.match[2]);
        const userId = ctx.from.id;

        const session = await models.BotSession.findByPk(sessionId);
        if (!session || session.userId !== userId) {
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }

        const supportedTokens = await getSupportedTokensList();
        const token = supportedTokens[tokenIdx];

        if (!token) {
          await ctx.answerCbQuery('❌ Token not found');
          return;
        }

        // Update session with token selection
        session.data.tokenInfo = token;
        session.currentStep = 'AWAITING_WAGER';
        await session.save();

        await ctx.editMessageText(
          `💰 <b>Enter Wager Amount</b>\n\n` +
          `Token: ${token.symbol}\n` +
          `Network: ${token.network}\n\n` +
          `Reply in this chat with the amount you want to wager (e.g., 10, 100.5)`,
          { parse_mode: 'HTML' }
        );
        await ctx.answerCbQuery('✅ Token selected');
      } catch (error) {
        logger.error('Error selecting token', error);
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
        await ctx.reply('❌ No active session. Start from group chat.');
        return;
      }

      if (activeSession.sessionType === 'INITIATING_DM_FLIP') {
        if (activeSession.currentStep === 'AWAITING_WAGER') {
          // User is entering wager amount from DM flow
          await FlipHandler.processDMWagerAmount(ctx, activeSession);
        }
      } else if (activeSession.sessionType === 'INITIATING') {
        if (activeSession.currentStep === 'SELECTING_TOKEN') {
          // User should provide wager
          await FlipHandler.processWagerAmount(ctx);
        } else if (activeSession.currentStep === 'AWAITING_DEPOSIT') {
          if (message === 'confirmed') {
            await FlipHandler.confirmCreatorDeposit(ctx);
          } else {
            await ctx.reply('Please reply with "confirmed" when you\'ve sent the tokens.');
          }
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
    if (ctx.chat.type === 'private') {
      // DM: Get the user's last active group
      const { models } = getDB();
      const userId = ctx.from.id;

      try {
        // Get user's last active group
        const lastGroupSession = await models.BotSession.findOne({
          where: {
            userId,
            sessionType: 'LAST_GROUP_ACTIVITY',
          },
        });

        let groupChatId = null;

        if (lastGroupSession && lastGroupSession.data.groupId) {
          groupChatId = lastGroupSession.data.groupId;
        } else {
          await ctx.reply(
            '❌ No group detected!\n\n' +
            'Please send a message in a group where this bot is active first, then come back and use /flip'
          );
          return;
        }

        // User has group detected, show token options
        const supportedTokens = await getSupportedTokensList();
        if (supportedTokens.length === 0) {
          await ctx.reply('⚠️ No tokens configured for this bot yet.');
          return;
        }

        // Create session for token selection
        const session = await models.BotSession.create({
          userId,
          sessionType: 'INITIATING_DM_FLIP',
          currentStep: 'SELECTING_TOKEN',
          data: { groupChatId },
        });

        const tokenButtons = supportedTokens.map((token, idx) => [
          Markup.button.callback(
            `${token.symbol} (${token.network})`,
            `select_dm_token_${session.id}_${idx}`
          ),
        ]);

        await ctx.reply(
          '🪙 <b>Start a Coin Flip!</b>\n\n' +
          `✅ Group detected! Sending challenge there.\n\n` +
          'Select a token:',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard(tokenButtons).reply_markup,
          }
        );
      } catch (error) {
        logger.error('Error starting flip in DM', error);
        await ctx.reply('❌ Error starting flip. Please try again.');
      }
    } else {
      // In group chat - show token selection (original behavior)
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
        '🪙 <b>Start a Coin Flip!</b>\n\n' +
        'Select a token:',
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(inlineButtons).reply_markup,
        }
      );
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
