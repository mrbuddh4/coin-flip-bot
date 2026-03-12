const { Telegraf, Markup, session } = require('telegraf');
const { Op } = require('sequelize');
const config = require('./config');
const { initDB, getDB } = require('./database');
const { initBlockchainManager, getBlockchainManager } = require('./blockchain/manager');
const FlipHandler = require('./handlers/flipHandler');
const ExecutionHandler = require('./handlers/executionHandler');
const AdminHandler = require('./handlers/adminHandler');
const WalletHandler = require('./handlers/walletHandler');
const LeaderboardHandler = require('./handlers/leaderboardHandler');
const DatabaseUtils = require('./database/utils');
const logger = require('./utils/logger');
const { validateConfig, formatNetworkName, getVideoDuration } = require('./utils/helpers');

let bot;
let sessionStore = {};
let challengeTimeouts = {}; // Store challenge acceptance timeouts by flipId

/**
 * Set a challenge acceptance timeout (3 minutes for challenger to accept)
 */
function setChallengeTimeout(flipId, groupId, groupMessageId, telegram) {
  // Clear any existing timeout for this flip
  if (challengeTimeouts[flipId]) {
    clearTimeout(challengeTimeouts[flipId]);
  }

  // Set new timeout for 3 minutes (180000 ms)
  challengeTimeouts[flipId] = setTimeout(async () => {
    try {
      const { models } = getDB();
      const flip = await models.CoinFlip.findByPk(flipId);

      if (!flip) {
        logger.info('[challengeTimeout] Flip not found', { flipId });
        delete challengeTimeouts[flipId];
        return;
      }

      // Only send alert if challenge is still waiting
      if (flip.status === 'WAITING_CHALLENGER') {
        logger.info('[challengeTimeout] Sending timeout alert to group', { flipId, groupId });

        try {
          // Send alert message to group
          const botInfo = await telegram.getMe();
          const deeplink = `https://t.me/${botInfo.username}?start=accept_${flipId}`;
          await telegram.sendMessage(
            groupId,
            `⏰ <b>Challenge Expiring!</b>\n\n` +
            `The challenge for <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b> ` +
            `will expire in <b>1 minute</b> if no one accepts!\n\n` +
            `⚡ Tap the button below to join:`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.url('Accept Challenge', deeplink)],
              ]).reply_markup,
            }
          );
        } catch (err) {
          logger.error('[challengeTimeout] Error sending alert message', { flipId, error: err.message });
        }

        // Set another timeout for 1 minute to auto-cancel if still not accepted
        challengeTimeouts[flipId] = setTimeout(async () => {
          try {
            const flipCheck = await models.CoinFlip.findByPk(flipId);
            if (flipCheck && flipCheck.status === 'WAITING_CHALLENGER') {
              logger.info('[challengeTimeout] Auto-cancelling expired challenge', { flipId });
              
              // Mark as cancelled
              flipCheck.status = 'CANCELLED';
              flipCheck.data = { ...flipCheck.data, cancelReason: 'Challenge expired (no acceptances within 4 minutes)' };
              await flipCheck.save();

              // Refund creator's deposit
              try {
                const creator = await models.User.findByPk(flipCheck.creatorId);
                
                // Use the wallet they sent the deposit FROM (not their receiving wallet)
                const creatorDepositWallet = flipCheck.creatorDepositWalletAddress;
                
                if (creator && creatorDepositWallet) {
                  const blockchainManager = getBlockchainManager();
                  
                  try {
                    // Refund the exact wager amount - get token config to find token address
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

                    const txHash = await blockchainManager.sendWinnings(
                      flipCheck.tokenNetwork,
                      tokenAddress,
                      creatorDepositWallet,
                      flipCheck.creatorAccumulatedDeposit,
                      tokenDecimals
                    );
                    
                    logger.info('[challengeTimeout] Refunded creator deposit to original wallet', { 
                      flipId, 
                      creatorId: flipCheck.creatorId,
                      depositWallet: creatorDepositWallet,
                      amount: flipCheck.creatorAccumulatedDeposit,
                      token: flipCheck.tokenSymbol,
                      txHash 
                    });
                  } catch (refundErr) {
                    logger.error('[challengeTimeout] Failed to refund creator', { 
                      flipId, 
                      error: refundErr.message 
                    });
                  }
                } else {
                  logger.warn('[challengeTimeout] Creator or deposit wallet missing for refund', { 
                    flipId, 
                    creatorId: flipCheck.creatorId,
                    hasDepositWallet: !!creatorDepositWallet
                  });
                }
              } catch (creatorErr) {
                logger.error('[challengeTimeout] Error processing creator refund', { flipId, error: creatorErr.message });
              }

              // Send timeout notification to group with start new challenge button
              try {
                const botInfo = await telegram.getMe();
                const formattedWager = parseFloat(flipCheck.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
                
                // Create a new session for starting a fresh flip
                const newFlipSession = await models.BotSession.create({
                  userId: flipCheck.creatorId, // Creator can start a new flip
                  sessionType: 'INITIATING',
                  currentStep: 'AWAITING_DM_START',
                  data: {
                    groupId: groupId,
                  },
                });

                const deeplink = `https://t.me/${botInfo.username}?start=flip_${newFlipSession.id}`;
                
                await telegram.sendMessage(
                  groupId,
                  `⏰ <b>Challenge Expired</b>\n\n` +
                  `No one accepted the challenge for <b>${formattedWager} ${flipCheck.tokenSymbol}</b>.\n` +
                  `Funds have been refunded to the creator.\n\n` +
                  `Would you like to start a new challenge?`,
                  {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                      [Markup.button.url('🪙 Start a Challenge', deeplink)],
                    ]).reply_markup,
                  }
                );
                logger.info('[challengeTimeout] Sent expiration message with new flip session', { flipId, sessionId: newFlipSession.id });
              } catch (msgErr) {
                logger.error('[challengeTimeout] Failed to send expiration message', { flipId, error: msgErr.message });
              }
            }
            delete challengeTimeouts[flipId];
          } catch (err) {
            logger.error('[challengeTimeout] Error in auto-cancel timeout', { flipId, error: err.message });
          }
        }, 60000); // 1 more minute = 4 minutes total before auto-cancel
      } else {
        logger.info('[challengeTimeout] Flip no longer in WAITING_CHALLENGER status', { flipId, status: flip.status });
        delete challengeTimeouts[flipId];
      }
    } catch (error) {
      logger.error('[challengeTimeout] Error in challenge timeout handler', { flipId, error: error.message });
      delete challengeTimeouts[flipId];
    }
  }, 180000); // 3 minutes
}

/**
 * Clear a challenge timeout when challenge is accepted or flip completes
 */
function clearChallengeTimeout(flipId) {
  if (challengeTimeouts[flipId]) {
    clearTimeout(challengeTimeouts[flipId]);
    delete challengeTimeouts[flipId];
    logger.info('[clearChallengeTimeout] Timeout cleared', { flipId });
  }
}

/**
 * Initialize the bot
 */
async function initBot() {
  try {
    // Validate configuration
    validateConfig();

    // Initialize blockchain handlers first (needed for wallet validation)
    console.log('Initializing blockchain...');
    try {
      initBlockchainManager();
    } catch (blockchainErr) {
      console.error('[BLOCKCHAIN_INIT_ERROR]', blockchainErr.message);
      throw blockchainErr;
    }

    // Validate blockchain wallets are properly derived
    console.log('Validating blockchain wallets...');
    const blockchainManager = getBlockchainManager();
    const evmWallet = blockchainManager.getBotWalletAddress('EVM');
    const solanaWallet = blockchainManager.getBotWalletAddress('Solana');
    
    if (!evmWallet || evmWallet === '0x' || evmWallet === 'undefined') {
      throw new Error('Failed to derive EVM bot wallet - check EVM_PRIVATE_KEY environment variable');
    }
    if (!solanaWallet || solanaWallet === 'undefined') {
      throw new Error('Failed to derive Solana bot wallet - check SOLANA_PRIVATE_KEY environment variable');
    }

    console.log('✅ Bot wallets validated');
    console.log(`   EVM wallet: ${evmWallet}`);
    console.log(`   Solana wallet: ${solanaWallet}`);

    // Initialize database
    console.log('Initializing database...');
    await initDB();

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
      { command: 'leaderboard', description: '🏆 Top winners and losers' },
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
    bot.command('leaderboard', handlers.leaderboard);

    // Admin commands
    AdminHandler.registerCommands(bot);

    // Check for expired challenges on startup and restore timeouts
    const { models } = getDB();
    const waitingChallenges = await models.CoinFlip.findAll({
      where: { status: 'WAITING_CHALLENGER' },
    });

    const now = Date.now();
    const CHALLENGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes
    const ALERT_DELAY = 1 * 60 * 1000; // 1 more minute

    for (const flip of waitingChallenges) {
      const elapsedTime = now - flip.createdAt.getTime();

      if (elapsedTime > CHALLENGE_TIMEOUT + ALERT_DELAY) {
        // Challenge is fully expired, cancel it
        logger.info('[startup] Auto-cancelling expired challenge', { flipId: flip.id, elapsedSeconds: Math.round(elapsedTime / 1000) });
        flip.status = 'CANCELLED';
        flip.data = { ...flip.data, cancelReason: 'Challenge expired on bot startup' };
        flip.creatorDepositWalletAddress = null;
        flip.challengerDepositWalletAddress = null;
        flip.creatorAccumulatedDeposit = 0;
        flip.challengerAccumulatedDeposit = 0;
        await flip.save();
      } else if (elapsedTime > CHALLENGE_TIMEOUT) {
        // Challenge is in the alert window, re-set the alert timeout
        const remainingAlert = (CHALLENGE_TIMEOUT + ALERT_DELAY) - elapsedTime;
        logger.info('[startup] Restoring timeout for challenge in alert window', { flipId: flip.id, remainingMs: Math.round(remainingAlert) });
        
        const alertTimeout = setTimeout(async () => {
          try {
            const flipCheck = await models.CoinFlip.findByPk(flip.id);
            if (flipCheck && flipCheck.status === 'WAITING_CHALLENGER') {
              logger.info('[startup-timeout] Auto-cancelling expired challenge', { flipId: flip.id });
              flipCheck.status = 'CANCELLED';
              flipCheck.data = { ...flipCheck.data, cancelReason: 'Challenge expired' };
              flipCheck.creatorDepositWalletAddress = null;
              flipCheck.challengerDepositWalletAddress = null;
              flipCheck.creatorAccumulatedDeposit = 0;
              flipCheck.challengerAccumulatedDeposit = 0;
              await flipCheck.save();
              
              // Try to notify group
              try {
                await bot.telegram.editMessageCaption(
                  `❌ <b>Challenge Expired</b>\n\n` +
                  `The challenge for <b>${parseFloat(flipCheck.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flipCheck.tokenSymbol}</b> ` +
                  `expired because no one accepted it.`,
                  {
                    chat_id: flipCheck.groupChatId,
                    message_id: flipCheck.groupMessageId,
                    parse_mode: 'HTML'
                  }
                );
              } catch (err) {
                logger.warn('[startup-timeout] Failed to update group message', { flipId: flip.id, error: err.message });
              }
            }
            delete challengeTimeouts[flip.id];
          } catch (err) {
            logger.error('[startup-timeout] Error auto-cancelling', { flipId: flip.id, error: err.message });
          }
        }, remainingAlert);
        
        challengeTimeouts[flip.id] = alertTimeout;
      } else {
        // Challenge is still in the 3-minute initial window, restore the alert timeout
        const remainingInitial = CHALLENGE_TIMEOUT - elapsedTime;
        logger.info('[startup] Restoring timeout for active challenge', { flipId: flip.id, remainingMs: Math.round(remainingInitial) });
        
        const initialTimeout = setTimeout(async () => {
          try {
            const flipCheck = await models.CoinFlip.findByPk(flip.id);
            if (flipCheck && flipCheck.status === 'WAITING_CHALLENGER') {
              logger.info('[startup-timeout] Sending alert for active challenge', { flipId: flip.id });
              
              try {
                const botInfo = await bot.telegram.getMe();
                const deeplink = `https://t.me/${botInfo.username}?start=accept_${flipCheck.id}`;
                await bot.telegram.sendMessage(
                  flipCheck.groupChatId,
                  `⏰ <b>Challenge Expiring!</b>\n\n` +
                  `The challenge for <b>${parseFloat(flipCheck.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flipCheck.tokenSymbol}</b> ` +
                  `will expire in <b>1 minute</b> if no one accepts!\n\n` +
                  `⚡ Tap the button below to join:`,
                  {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                      [Markup.button.url('Accept Challenge', deeplink)],
                    ]).reply_markup,
                  }
                );
              } catch (err) {
                logger.error('[startup-timeout] Error sending alert', { flipId: flip.id, error: err.message });
              }

              // Set auto-cancel timeout
              const cancelTimeout = setTimeout(async () => {
                try {
                  const flipFinal = await models.CoinFlip.findByPk(flip.id);
                  if (flipFinal && flipFinal.status === 'WAITING_CHALLENGER') {
                    logger.info('[startup-timeout] Auto-cancelling expired challenge', { flipId: flip.id });
                    flipFinal.status = 'CANCELLED';
                    flipFinal.data = { ...flipFinal.data, cancelReason: 'Challenge expired' };
                    await flipFinal.save();

                    try {
                      await bot.telegram.editMessageCaption(
                        `❌ <b>Challenge Expired</b>\n\n` +
                        `The challenge for <b>${parseFloat(flipFinal.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flipFinal.tokenSymbol}</b> ` +
                        `expired because no one accepted it.`,
                        {
                          chat_id: flipFinal.groupChatId,
                          message_id: flipFinal.groupMessageId,
                          parse_mode: 'HTML'
                        }
                      );
                    } catch (err) {
                      logger.warn('[startup-timeout] Failed to update message on cancel', { flipId: flip.id, error: err.message });
                    }
                  }
                  delete challengeTimeouts[flip.id];
                } catch (err) {
                  logger.error('[startup-timeout] Error in cancel timeout', { flipId: flip.id, error: err.message });
                }
              }, ALERT_DELAY);

              challengeTimeouts[flip.id] = cancelTimeout;
            }
          } catch (err) {
            logger.error('[startup-timeout] Error in initial timeout', { flipId: flip.id, error: err.message });
          }
        }, remainingInitial);

        challengeTimeouts[flip.id] = initialTimeout;
      }
    }

    logger.info('[startup] Restored timeouts for waiting challenges', { count: waitingChallenges.length });

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
        logger.error('Error updating Paxeer wallet', error);
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

    // Leaderboard callbacks
    bot.action('refresh_leaderboard', async (ctx) => {
      try {
        await LeaderboardHandler.refreshLeaderboard(ctx);
      } catch (error) {
        logger.error('Error refreshing leaderboard', error);
        await ctx.answerCbQuery('❌ Error', true);
      }
    });

    // Start flip in DM from group button
    bot.action(/^start_flip_dm_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

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

        // Just acknowledge - the /start deeplink will handle token selection
        await ctx.answerCbQuery('Opening Coin Flip...');
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
        
        // Clear the challenge acceptance timeout since someone accepted
        clearChallengeTimeout(flipId);
        
        // Show loading popup
        await ctx.answerCbQuery('⏳ Accepting challenge...');
        
        // Call the flip handler (which sends auto-DM)
        await FlipHandler.acceptFlip(ctx, flipId);
        
        // Delete the message button to clean up group
        await ctx.deleteMessage().catch(() => {});
        
        // Send a message that challenger is reviewing the flip
        const challengerName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        await ctx.reply(
          `${challengerName} has accepted and is reviewing the flip.`,
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
        const flipId = ctx.match[1];
        clearChallengeTimeout(flipId);
        await ExecutionHandler.cancelFlip(ctx, flipId);
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

        // Update group message with image - delete old and send new
        const fs = require('fs');
        const path = require('path');
        const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');
        
        try {
          const botInfo = await ctx.telegram.getMe();
          const deeplink = `https://t.me/${botInfo.username}?start=accept_${flip.id}`;
          
          const resetText = `🪙 <b>Coin Flip Challenge</b>\n\n` +
            `<a href="tg://user?id=${flip.creatorId}">A player</a> started a flip for <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n\n` +
            `⏰ Waiting for another challenger...`;
          
          // Delete the old message first
          try {
            await ctx.telegram.deleteMessage(flip.groupChatId, flip.groupMessageId);
          } catch (delErr) {
            logger.warn('Failed to delete old message', { error: delErr.message });
          }
          
          // Try to send new photo message
          if (fs.existsSync(imagePath)) {
            try {
              await ctx.telegram.sendPhoto(
                flip.groupChatId,
                { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
                {
                  caption: resetText,
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [[{ text: 'Accept Challenge', url: deeplink }]],
                  },
                }
              );
            } catch (photoErr) {
              logger.warn('Failed to send reset photo', { flipId, error: photoErr.message });
              // Fallback to text message
              await ctx.telegram.sendMessage(
                flip.groupChatId,
                resetText,
                { 
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [[{ text: 'Accept Challenge', url: deeplink }]],
                  },
                }
              );
            }
          } else {
            logger.warn('Image not found at path', { imagePath });
            // Image not found, send text
            await ctx.telegram.sendMessage(
              flip.groupChatId,
              resetText,
              { 
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: 'Accept Challenge', url: deeplink }]],
                },
              }
            );
          }
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
        const flipId = ctx.match[1];  // This is actually the flipId, not sessionId
        const userId = ctx.from.id;

        logger.info('[deposit_confirmed] Button clicked', { flipId, userId });

        logger.info('[deposit_confirmed] Attempting to find flip in database', { flipId });
        const flip = await models.CoinFlip.findByPk(flipId);
        logger.info('[deposit_confirmed] Database lookup result', { flipId, found: !!flip });
        
        if (!flip) {
          logger.warn('[deposit_confirmed] Flip not found in database', { flipId });
          await ctx.answerCbQuery('❌ Session expired');
          return;
        }

        // Verify user is the challenger
        if (parseInt(flip.challengerId) !== userId) {
          await ctx.answerCbQuery('❌ This is not your challenge');
          return;
        }

        logger.info('[deposit_confirmed] Verifying challenger deposit', { flipId, userId });
        
        // Edit the button message to show processing
        const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
        try {
          await ctx.editMessageText(
            `⏳ <b>Processing Transaction...</b>\n\n` +
            `Verifying your deposit of ${formattedWager} ${flip.tokenSymbol} on the blockchain.\n` +
            `This usually takes 10-30 seconds.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('[deposit_confirmed] Failed to edit message to processing state', err.message);
        }

        // Verify deposit on blockchain (with retries for blockchain indexing)
        // If we already detected a sender, pass it to accumulate all their transfers
        const blockchainManager = getBlockchainManager();
        const knownSender = flip.challengerDepositWalletAddress || null;
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals,
          4, // maxRetries
          2000, // retryDelayMs
          knownSender, // pass known sender to accumulate multi-deposits
          flip.createdAt // pass flip creation time to filter old deposits
        );

        logger.info('[deposit_confirmed] Challenger verification result', { 
          flipId, 
          received: verification.received,
          amount: verification.amount,
          expected: flip.wagerAmount,
          depositSender: verification.depositSender,
        });

        if (!verification.received) {
          logger.info('[deposit_confirmed] Deposit not received', { userId, flipId, before_save: flip });
          
          // Store the detected sender address for refunds (if not already set)
          if (verification.depositSender && !flip.challengerDepositWalletAddress) {
            flip.challengerDepositWalletAddress = verification.depositSender;
            flip.challengerAccumulatedDeposit = parseFloat(verification.amount || 0);
            logger.info('[deposit_confirmed] Detected challenger deposit sender and initial amount', { 
              flipId, 
              sender: verification.depositSender,
              initialAmount: verification.amount
            });
          } else if (verification.depositSender && flip.challengerDepositWalletAddress) {
            // On retry, update accumulated amount (Paxscan query returns cumulative from that sender)
            const previousAccumulated = parseFloat(flip.challengerAccumulatedDeposit || 0);
            const currentTotal = parseFloat(verification.amount || 0);
            flip.challengerAccumulatedDeposit = currentTotal;
            
            logger.info('[deposit_confirmed] Updated challenger accumulated deposit', {
              flipId,
              previousAccumulated,
              currentTotal,
              newDepositsSinceLastCheck: currentTotal - previousAccumulated,
            });
          }
          
          // Check if notification already sent for this verification attempt
          const lastNotificationTime = flip.data?.lastInsufficientDepositNotification || 0;
          const timeSinceLastNotification = Date.now() - lastNotificationTime;
          
          // Only send notification if more than 30 seconds have passed since last one
          if (timeSinceLastNotification > 30000) {
            const formattedExpected = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            const receivedAmount = parseFloat(verification.amount || '0');
            const shortfallAmount = (parseFloat(flip.wagerAmount) - receivedAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            const botWallet = verification.botWallet || 'Unknown';
            
            try {
              await ctx.editMessageText(
                `❌ <b>Insufficient Deposit</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
                `<b>Still needed: ${shortfallAmount} ${flip.tokenSymbol}</b>\n\n` +
                `<b>Troubleshooting:</b>\n` +
                `• Verify you sent to: <code>${botWallet}</code>\n` +
                `• Check amount matches exactly (${formattedExpected})\n` +
                `• Wait 30 seconds for blockchain confirmation\n` +
                `• Then try confirming again\n\n` +
                `You have <b>3 minutes</b> to send the remaining amount, otherwise your deposit will be refunded and the challenge cancelled.`,
                {
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '✅ I sent the deposit', callback_data: `deposit_confirmed_${flipId}` }]
                    ]
                  }
                }
              );
            } catch (editErr) {
              logger.warn('[deposit_confirmed] Failed to edit insufficient deposit message', editErr.message);
            }
            
            // Record that we just sent a notification
            flip.data = { ...flip.data, lastInsufficientDepositNotification: Date.now() };
            await flip.save();
          } else {
            logger.info('[deposit_confirmed] Skipping duplicate notification (sent within last 30s)', { flipId });
          }
          
          // Set timeout to refund partial deposit if not completed in 3 minutes
          setTimeout(async () => {
            try {
              const flipCheck = await models.CoinFlip.findByPk(flipId);
              if (flipCheck && flipCheck.status === 'WAITING_CHALLENGER_DEPOSIT' && !flipCheck.challengerDepositConfirmed) {
                logger.info('[insufficient_deposit_timeout_challenger] Refunding partial deposit and cancelling', { flipId });
                
                // Cancel the challenge
                flipCheck.status = 'CANCELLED';
                flipCheck.data = { ...flipCheck.data, cancelReason: 'Challenger insufficient deposit - timeout' };
                await flipCheck.save();
                
                // Refund the full accumulated amount that was sent
                if (flipCheck.challengerDepositWalletAddress && flipCheck.challengerAccumulatedDeposit > 0) {
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
                      flipCheck.challengerDepositWalletAddress,
                      flipCheck.challengerAccumulatedDeposit,
                      tokenDecimals
                    );
                    
                    logger.info('[insufficient_deposit_timeout_challenger] Refunded accumulated deposit', { 
                      flipId,
                      amount: flipCheck.challengerAccumulatedDeposit,
                      recipient: flipCheck.challengerDepositWalletAddress
                    });
                  } catch (refundErr) {
                    logger.error('[insufficient_deposit_timeout_challenger] Failed to refund accumulated deposit', { 
                      flipId,
                      error: refundErr.message 
                    });
                  }
                }
              }
            } catch (err) {
              logger.error('[insufficient_deposit_timeout_challenger] Error in timeout handler', { flipId, error: err.message });
            }
          }, 180000); // 3 minutes
          
          // CRITICAL: Save the sender address and accumulated deposit before returning
          // This ensures that on the next verification, we can track deposits from the same sender
          logger.info('[deposit_confirmed] About to save flip before showing retry button', { flipId,status: flip.status });
          await flip.save();
          logger.info('[deposit_confirmed] Flip saved successfully', { flipId });
          
          return;
        }

        logger.info('[deposit_confirmed] Challenger deposit verified', { flipId, userId, amount: verification.amount });

        // Store the detected sender address for refunds (if not already set)
        if (verification.depositSender && !flip.challengerDepositWalletAddress) {
          flip.challengerDepositWalletAddress = verification.depositSender;
          logger.info('[deposit_confirmed] Detected challenger deposit sender', { flipId, sender: verification.depositSender });
        }

        // Ensure accumulated deposit is set for overpayment check
        // Check numeric value, not truthiness (DB stores as string)
        if (parseFloat(flip.challengerAccumulatedDeposit || 0) < parseFloat(verification.amount || 0)) {
          flip.challengerAccumulatedDeposit = parseFloat(verification.amount);
          // CRITICAL: Also update wallet address when updating accumulated deposit
          // This ensures refund goes to the wallet that sent the current verified amount
          flip.challengerDepositWalletAddress = verification.depositSender;
        }

        logger.info('[deposit_confirmed] Starting overpayment check', {
          flipId,
          challengerAccumulatedDeposit: flip.challengerAccumulatedDeposit,
          wagerAmount: flip.wagerAmount,
          accumulatedVsWager: `${flip.challengerAccumulatedDeposit} vs ${flip.wagerAmount}`,
        });

        // If they sent more than the wager, refund the excess
        const receivedAmount = parseFloat(flip.challengerAccumulatedDeposit || flip.wagerAmount);
        const wagerAmount = parseFloat(flip.wagerAmount);
        let overpaymentDetected = false;
        
        if (receivedAmount > wagerAmount) {
          overpaymentDetected = true;
          const excessAmount = receivedAmount - wagerAmount;
          logger.info('[deposit_confirmed] Excess deposit detected, will refund', { flipId, excess: excessAmount, sender: verification.depositSender });
          
          // Notify user about overpayment and refund
          const formattedReceived = receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
          const formattedWager = wagerAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
          const formattedExcess = excessAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
          
          try {
            await ctx.editMessageText(
              `⚠️ <b>Overpayment Detected</b>\n\n` +
              `You sent: ${formattedReceived} ${flip.tokenSymbol}\n` +
              `Wager amount: ${formattedWager} ${flip.tokenSymbol}\n\n` +
              `<b>Refunding excess: ${formattedExcess} ${flip.tokenSymbol}</b>\n\n` +
              `The refund will be sent to your wallet shortly.\n\n` +
              `✅ Your deposit is confirmed. ${flip.creatorDepositConfirmed ? '🎉 Both players ready! Executing flip...' : '⏳ Waiting for the other player...'}`,
              { parse_mode: 'HTML' }
            );
          } catch (editErr) {
            logger.warn('[deposit_confirmed] Failed to edit overpayment message', editErr.message);
          }
          
          try {
            logger.info('[deposit_confirmed] Checking refund conditions', {
              flipId,
              hasWallet: !!flip.challengerDepositWalletAddress,
              walletAddress: flip.challengerDepositWalletAddress,
              accumulatedDeposit: flip.challengerAccumulatedDeposit,
              isAccumulatedPositive: flip.challengerAccumulatedDeposit > 0,
            });
            
            if (flip.challengerDepositWalletAddress && flip.challengerAccumulatedDeposit > 0) {
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
              logger.info('[deposit_confirmed] Sending refund', {
                flipId,
                network: flip.tokenNetwork,
                tokenAddress,
                recipient: flip.challengerDepositWalletAddress,
                amount: excessStr,
                decimals: tokenDecimals,
              });
              
              await blockchainManager.sendWinnings(
                flip.tokenNetwork,
                tokenAddress,
                flip.challengerDepositWalletAddress,
                excessStr,
                tokenDecimals
              );
              
              logger.info('[deposit_confirmed] Refunded excess deposit', { 
                flipId, 
                excess: excessStr,
                recipient: flip.challengerDepositWalletAddress
              });
            }
          } catch (excessErr) {
            logger.error('[deposit_confirmed] Failed to refund excess deposit', { flipId, error: excessErr.message });
          }
        }

        // Mark challenger deposit as confirmed
        flip.challengerDepositConfirmed = true;
        await flip.save();

        // Only show confirmation message if no overpayment (overpayment message already shown)
        if (!overpaymentDetected) {
          try {
            await ctx.editMessageText(
              `✅ <b>Your Deposit Confirmed!</b>\n\n` +
              (flip.creatorDepositConfirmed ? `🎉 Both players ready! Executing flip...` : `⏳ Waiting for the other player's deposit...`),
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            logger.warn('Failed to edit confirmation message', err.message);
          }
        }

        // Delete session  
        await session.destroy();

        // Check if both deposits are confirmed
        if (flip.creatorDepositConfirmed && flip.challengerDepositConfirmed) {
          logger.info('[deposit_confirmed] Both deposits confirmed, executing flip', { flipId });

          // Clear the challenge timeout since flip is now executing
          clearChallengeTimeout(flipId);

          // Send coin flip video to group before revealing result
          let videoMessageId = null;
          try {
            const fs = require('fs');
            const path = require('path');
            const videoPath = path.join(process.cwd(), 'assets/coinflip.MP4');
            
            if (fs.existsSync(videoPath)) {
              const sentMessage = await ctx.telegram.sendVideo(
                flip.groupChatId,
                { filename: 'coinflip.MP4', source: fs.createReadStream(videoPath) },
                {
                  caption: '🎬 <b>EXECUTING FLIP...</b>',
                  parse_mode: 'HTML',
                }
              );
              videoMessageId = sentMessage.message_id;
              
              // Get actual video duration and auto-delete after it finishes
              const videoDuration = await getVideoDuration(videoPath);
              logger.info('Video duration detected', { flipId, videoDuration });
              
              setTimeout(async () => {
                try {
                  await ctx.telegram.deleteMessage(flip.groupChatId, videoMessageId);
                  logger.info('Auto-deleted video message after duration', { flipId, videoMessageId, duration: videoDuration });
                } catch (err) {
                  logger.warn('Failed to auto-delete video message', { flipId, videoMessageId, error: err.message });
                }
              }, videoDuration);
            }
          } catch (videoErr) {
            logger.warn('Failed to send flip video', { flipId, error: videoErr.message });
          }

          // Execute the flip and pass video message ID to delete it after result
          await ExecutionHandler.executeFlip(flipId, ctx, videoMessageId);
        } else {

          // Notify creator in group with image - delete old and send new
          const fs = require('fs');
          const path = require('path');
          const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');
          
          try {
            const statusText = `🪙 <b>Challenger Found!</b>\n\n` +
              `⏳ Waiting for both players to send deposits...\n` +
              `⏰ Timeout in 3 minutes`;
            
            // Delete the old message first
            try {
              await ctx.telegram.deleteMessage(flip.groupChatId, flip.groupMessageId);
            } catch (delErr) {
              logger.warn('Failed to delete old message', { error: delErr.message });
            }
            
            // Try to send a new photo message
            if (fs.existsSync(imagePath)) {
              try {
                await ctx.telegram.sendPhoto(
                  flip.groupChatId,
                  { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
                  {
                    caption: statusText,
                    parse_mode: 'HTML',
                  }
                );
              } catch (photoErr) {
                logger.warn('Failed to send status photo', { flipId, error: photoErr.message });
                // Fallback to text message
                await ctx.telegram.sendMessage(
                  flip.groupChatId,
                  statusText,
                  { parse_mode: 'HTML' }
                );
              }
            } else {
              // Image not found, send text
              await ctx.telegram.sendMessage(
                flip.groupChatId,
                statusText,
                { parse_mode: 'HTML' }
              );
            }
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

        // Check if deposit already confirmed to prevent duplicate messages
        if (flip.creatorDepositConfirmed) {
          logger.info('[creator_deposit_confirmed] Deposit already confirmed, ignoring duplicate', { flipId, userId });
          await ctx.answerCbQuery('✅ Already confirmed!');
          return;
        }

        logger.info('[creator_deposit_confirmed] Verifying creator deposit', { flipId, userId });
        
        // Edit the button message to show processing
        const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
        try {
          await ctx.editMessageText(
            `⏳ <b>Processing Transaction...</b>\n\n` +
            `Verifying your deposit of ${formattedWager} ${flip.tokenSymbol} on the blockchain.\n` +
            `This usually takes 10-30 seconds.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('[creator_deposit_confirmed] Failed to edit message to processing state', err.message);
        }

        // Verify deposit on blockchain (with retries for blockchain indexing)
        // If we already detected a sender, pass it to accumulate all their transfers
        const blockchainManager = getBlockchainManager();
        const knownSender = flip.creatorDepositWalletAddress || null;
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals,
          4, // maxRetries
          2000, // retryDelayMs
          knownSender, // pass known sender to accumulate multi-deposits
          flip.createdAt // pass flip creation time to filter old deposits
        );

        logger.info('[creator_deposit_confirmed] Creator verification result', { 
          flipId, 
          received: verification.received,
          amount: verification.amount,
          expected: flip.wagerAmount,
          depositSender: verification.depositSender,
        });

        if (!verification.received) {
          logger.warn('[creator_deposit_confirmed] Deposit not received (insufficient)', { userId, flipId, verificationReceived: verification.received });
          
          // Store the detected sender address for refunds (if not already set)
          if (verification.depositSender && !flip.creatorDepositWalletAddress) {
            flip.creatorDepositWalletAddress = verification.depositSender;
            flip.creatorAccumulatedDeposit = parseFloat(verification.amount || 0);
            logger.info('[creator_deposit_confirmed] Detected creator deposit sender and initial amount', { 
              flipId, 
              sender: verification.depositSender,
              initialAmount: verification.amount
            });
          } else if (verification.depositSender && flip.creatorDepositWalletAddress) {
            // On retry, update accumulated amount (Paxscan query returns cumulative from that sender)
            const previousAccumulated = parseFloat(flip.creatorAccumulatedDeposit || 0);
            const currentTotal = parseFloat(verification.amount || 0);
            flip.creatorAccumulatedDeposit = currentTotal;
            
            logger.info('[creator_deposit_confirmed] Updated creator accumulated deposit', {
              flipId,
              previousAccumulated,
              currentTotal,
              newDepositsSinceLastCheck: currentTotal - previousAccumulated,
            });
          }
          
          // Check if notification already sent for this verification attempt
          const lastNotificationTime = flip.data?.lastInsufficientDepositNotification || 0;
          const timeSinceLastNotification = Date.now() - lastNotificationTime;
          
          // Only send notification if more than 30 seconds have passed since last one
          if (timeSinceLastNotification > 30000) {
            const formattedExpected = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            const receivedAmount = parseFloat(verification.amount || '0');
            const shortfallAmount = (parseFloat(flip.wagerAmount) - receivedAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            const botWallet = verification.botWallet || 'Unknown';
            
            try {
              await ctx.editMessageText(
                `⏳ <b>Insufficient Deposit</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
                `<b>Still needed: ${shortfallAmount} ${flip.tokenSymbol}</b>\n\n` +
                `<b>Troubleshooting:</b>\n` +
                `• Verify you sent to: <code>${botWallet}</code>\n` +
                `• Check amount matches exactly (${formattedExpected})\n` +
                `• Wait 30 seconds for blockchain confirmation\n` +
                `• Then try confirming again\n\n` +
                `If not sent within 3 minutes, the challenge will auto-cancel.`,
                {
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '✅ I sent the deposit', callback_data: `creator_deposit_confirmed_${flipId}` }]
                    ]
                  }
                }
              );
            } catch (editErr) {
              logger.warn('[creator_deposit_confirmed] Failed to edit insufficient deposit message', editErr.message);
            }
            
            // Record that we just sent a notification
            flip.data = { ...flip.data, lastInsufficientDepositNotification: Date.now() };
            await flip.save();
          } else {
            logger.info('[creator_deposit_confirmed] Skipping duplicate notification (sent within last 30s)', { flipId });
          }
          
          // CRITICAL: Save the sender address before returning if we just detected it
          if (verification.depositSender && flip.creatorDepositWalletAddress === verification.depositSender) {
            await flip.save();
          }
          
          return;
        }

        logger.info('[creator_deposit_confirmed] Creator deposit verified', { flipId, userId, amount: verification.amount });

        // Store the detected sender address for refunds (if not already set)
        if (verification.depositSender && !flip.creatorDepositWalletAddress) {
          flip.creatorDepositWalletAddress = verification.depositSender;
          flip.creatorAccumulatedDeposit = parseFloat(verification.amount || 0);
          logger.info('[creator_deposit_confirmed] Detected creator deposit sender with accumulated amount', { 
            flipId, 
            sender: verification.depositSender,
            accumulatedDeposit: verification.amount
          });
        }

        // Ensure accumulated deposit is set for overpayment check
        // Check numeric value, not truthiness (DB stores as string)
        if (parseFloat(flip.creatorAccumulatedDeposit || 0) < parseFloat(verification.amount || 0)) {
          flip.creatorAccumulatedDeposit = parseFloat(verification.amount);
          // CRITICAL: Also update wallet address when updating accumulated deposit
          // This ensures refund goes to the wallet that sent the current verified amount
          flip.creatorDepositWalletAddress = verification.depositSender;
        }

        logger.info('[creator_deposit_confirmed] Starting overpayment check', {
          flipId,
          creatorAccumulatedDeposit: flip.creatorAccumulatedDeposit,
          wagerAmount: flip.wagerAmount,
          accumulatedVsWager: `${flip.creatorAccumulatedDeposit} vs ${flip.wagerAmount}`,
        });

        // Check if creator sent more than the wager (overpayment)
        const creatorReceivedAmount = parseFloat(flip.creatorAccumulatedDeposit || flip.wagerAmount);
        const creatorWagerAmount = parseFloat(flip.wagerAmount);
        let creatorOverpaymentDetected = false;
        
        if (creatorReceivedAmount > creatorWagerAmount) {
          creatorOverpaymentDetected = true;
          const creatorExcessAmount = creatorReceivedAmount - creatorWagerAmount;
          logger.info('[creator_deposit_confirmed] Excess deposit detected, will refund', { flipId, excess: creatorExcessAmount, sender: verification.depositSender });
          
          // Notify user about overpayment and refund
          const formattedReceived = creatorReceivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
          const formattedWager = creatorWagerAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
          const formattedExcess = creatorExcessAmount.toLocaleString('en-US', { maximumFractionDigits: 6 });
          
          try {
            await ctx.editMessageText(
              `⚠️ <b>Overpayment Detected</b>\n\n` +
              `You sent: ${formattedReceived} ${flip.tokenSymbol}\n` +
              `Wager amount: ${formattedWager} ${flip.tokenSymbol}\n\n` +
              `<b>Refunding excess: ${formattedExcess} ${flip.tokenSymbol}</b>\n\n` +
              `The refund will be sent to your wallet shortly.\n\n` +
              `✅ Your deposit is confirmed. Challenge posted to the group...`,
              { parse_mode: 'HTML' }
            );
          } catch (editErr) {
            logger.warn('[creator_deposit_confirmed] Failed to edit overpayment message', editErr.message);
          }
          
          try {
            logger.info('[creator_deposit_confirmed] Checking refund conditions', {
              flipId,
              hasWallet: !!flip.creatorDepositWalletAddress,
              walletAddress: flip.creatorDepositWalletAddress,
              accumulatedDeposit: flip.creatorAccumulatedDeposit,
              isAccumulatedPositive: flip.creatorAccumulatedDeposit > 0,
            });
            
            if (flip.creatorDepositWalletAddress && flip.creatorAccumulatedDeposit > 0) {
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

              const excessStr = creatorExcessAmount.toFixed(tokenDecimals);
              logger.info('[creator_deposit_confirmed] Sending refund', {
                flipId,
                network: flip.tokenNetwork,
                tokenAddress,
                recipient: flip.creatorDepositWalletAddress,
                amount: excessStr,
                decimals: tokenDecimals,
              });
              
              await blockchainManager.sendWinnings(
                flip.tokenNetwork,
                tokenAddress,
                flip.creatorDepositWalletAddress,
                excessStr,
                tokenDecimals
              );
              
              logger.info('[creator_deposit_confirmed] Refunded excess deposit', { 
                flipId, 
                excess: excessStr,
                recipient: flip.creatorDepositWalletAddress
              });
            }
          } catch (excessErr) {
            logger.error('[creator_deposit_confirmed] Failed to refund excess deposit', { flipId, error: excessErr.message });
          }
        }

        // Mark creator deposit as confirmed
        flip.creatorDepositConfirmed = true;
        flip.status = 'WAITING_CHALLENGER';
        await flip.save();

        // Only show confirmation message if no overpayment (overpayment message already shown)
        if (!creatorOverpaymentDetected) {
          try {
            await ctx.editMessageText(
              `✅ <b>Your Deposit Confirmed!</b>\n\n` +
              `💤 Challenge posted to the group...`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            logger.warn('Failed to edit creator confirmation message', err.message);
          }
        }

        // Check if challenge was already posted (prevent duplicate posts from webhook retries)
        if (flip.groupMessageId) {
          logger.info('[creator_deposit_confirmed] Challenge already posted, skipping duplicate', { flipId, groupMessageId: flip.groupMessageId });
          try {
            await ctx.editMessageText(
              `✅ <b>Your Deposit Confirmed!</b>\n\n` +
              `Your challenge has been posted to the group. Waiting for a challenger...`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            logger.warn('Failed to edit duplicate challenge message', err.message);
          }
          return;
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

        // Now post the challenge message to the group with image
        const fs = require('fs');
        const path = require('path');
        const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');
        const userRecord = await models.User.findByPk(userId);
        
        const botInfo = await ctx.telegram.getMe();
        const deeplink = `https://t.me/${botInfo.username}?start=accept_${flip.id}`;
        
        let groupMessage;
        try {
          if (fs.existsSync(imagePath)) {
            groupMessage = await ctx.telegram.sendPhoto(
              flip.groupChatId,
              { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
              {
                caption: `🪙 <b>Coin Flip Challenge!</b>\n\n` +
                `<a href="tg://user?id=${userId}">${userRecord?.firstName || 'A player'}</a> started a flip for:\n\n` +
                `💰 <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n` +
                `🌐 Network: ${formatNetworkName(flip.tokenNetwork)}\n\n` +
                `⏰ Waiting for a challenger...`,
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.url('Accept Challenge', deeplink)],
                ]).reply_markup,
              }
            );
          } else {
            groupMessage = await ctx.telegram.sendMessage(
              flip.groupChatId,
              `🪙 <b>Coin Flip Challenge!</b>\n\n` +
              `<a href="tg://user?id=${userId}">${userRecord?.firstName || 'A player'}</a> started a flip for:\n\n` +
              `💰 <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n` +
              `🌐 Network: ${formatNetworkName(flip.tokenNetwork)}\n\n` +
              `⏰ Waiting for a challenger...`,
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.url('Accept Challenge', deeplink)],
                ]).reply_markup,
              }
            );
          }
        } catch (imgErr) {
          logger.warn('Failed to send photo, falling back to text', { flipId, error: imgErr.message });
          groupMessage = await ctx.telegram.sendMessage(
            flip.groupChatId,
            `🪙 <b>Coin Flip Challenge!</b>\n\n` +
            `<a href="tg://user?id=${userId}">${userRecord?.firstName || 'A player'}</a> started a flip for:\n\n` +
            `💰 <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b>\n` +
            `🌐 Network: ${formatNetworkName(flip.tokenNetwork)}\n\n` +
            `⏰ Waiting for a challenger...`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.url('Accept Challenge', `https://t.me/${botInfo.username}?start=accept_${flip.id}`)],
              ]).reply_markup,
            }
          );
        }

        // Save message ID to flip
        flip.groupMessageId = groupMessage.message_id;
        await flip.save();
        logger.info('[creator_deposit_confirmed] Stored challenge message for deletion', { 
          flipId: flip.id, 
          messageId: groupMessage.message_id, 
          groupId: flip.groupChatId 
        });

        // Set 3-minute timeout for challenge acceptance
        setChallengeTimeout(flip.id, flip.groupChatId, groupMessage.message_id, ctx.telegram);

        // Only show final confirmation if no overpayment (overpayment message should remain visible)
        if (!creatorOverpaymentDetected) {
          await ctx.editMessageText(
            `✅ <b>Your Deposit Confirmed!</b>\n\n` +
            `Your challenge has been posted to the group. Waiting for a challenger...`,
            { parse_mode: 'HTML' }
          );
        }

        logger.info('[creator_deposit_confirmed] Challenge posted to group', { flipId, groupMessageId: groupMessage.message_id });
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
      
      // Check if this is accepting a flip (from the button deeplink)
      const startParam = ctx.startPayload;
      if (startParam && startParam.startsWith('accept_')) {
        const flipId = startParam.replace('accept_', '');
        
        try {
          const flip = await models.CoinFlip.findByPk(flipId);
          logger.info('[start] Accept deeplink clicked', { flipId, userId, flipFound: !!flip, status: flip?.status });
          
          if (!flip) {
            await ctx.reply('❌ Flip not found');
            return;
          }

          if (flip.status !== 'WAITING_CHALLENGER') {
            if (flip.status === 'CANCELLED') {
              await ctx.reply('❌ This challenge has expired');
            } else {
              await ctx.reply('❌ This flip is no longer available');
            }
            return;
          }

          if (flip.creatorId === userId) {
            await ctx.reply('❌ You cannot challenge your own flip');
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

          // Create confirmation session for challenger
          const confirmSession = await models.BotSession.create({
            userId,
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

          // Set the challengerId
          flip.challengerId = userId;
          flip.status = 'WAITING_CHALLENGER_DEPOSIT';
          await flip.save();

          logger.info('[start] Accepted flip via deeplink', { flipId, userId, groupChatId: flip.groupChatId, groupMessageId: flip.groupMessageId });

          // Delete the original challenge message
          logger.info('[accept_deeplink] Attempting to delete challenge message', {
            flipId,
            hasGroupChatId: !!flip.groupChatId,
            hasGroupMessageId: !!flip.groupMessageId,
            groupChatId: flip.groupChatId,
            groupMessageId: flip.groupMessageId
          });
          
          try {
            if (!flip.groupChatId) {
              logger.error('[accept_deeplink] ❌ Missing groupChatId when trying to delete', { flipId });
            } else if (!flip.groupMessageId) {
              logger.error('[accept_deeplink] ❌ Missing groupMessageId when trying to delete', { flipId });
            } else {
              await ctx.telegram.deleteMessage(flip.groupChatId, flip.groupMessageId);
              logger.info('[accept_deeplink] ✅ Deleted original challenge message', { flipId, messageId: flip.groupMessageId, groupId: flip.groupChatId });
            }
          } catch (delErr) {
            logger.error('[accept_deeplink] ❌ Failed to delete original challenge message', { 
              error: delErr.message, 
              flipId, 
              messageId: flip.groupMessageId,
              groupId: flip.groupChatId,
              errorCode: delErr.code
            });
          }

          // Send new "Challenger Found!" message
          try {
            const challenger = await models.User.findByPk(userId);
            const challengerDisplay = challenger?.username ? `@${challenger.username}` : challenger?.firstName || 'Challenger';
            const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

            const groupText = `🪙 <b>Challenger Found!</b>\n\n` +
              `${challengerDisplay} has accepted the challenge!\n\n` +
              `💰 <b>Wager:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
              `🌐 <b>Network:</b> ${formatNetworkName(flip.tokenNetwork)}\n\n` +
              `⏳ Processing deposits...`;

            const sentMsg = await ctx.telegram.sendMessage(
              flip.groupChatId,
              groupText,
              { parse_mode: 'HTML' }
            );
            logger.info('[start] Sent new challenger found message', { flipId, sentMessageId: sentMsg?.message_id });
          } catch (sendErr) {
            logger.warn('[start] Failed to send new challenger message', { error: sendErr.message, flipId, groupChatId: flip.groupChatId });
          }

          // Check if user has a wallet address in their profile
          const userProfile = await models.UserProfile.findByPk(userId);
          const walletField = flip.tokenNetwork === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
          const storedWallet = userProfile?.[walletField];

          if (storedWallet) {
            // Use stored wallet address
            flip.challengerDepositWalletAddress = storedWallet;
            await flip.save();

            logger.info('[start] Using stored wallet for challenger', { flipId, network: flip.tokenNetwork });

            confirmSession.currentStep = 'AWAITING_DEPOSIT';
            await confirmSession.save();

            // Show deposit instructions
            const blockchainManager = getBlockchainManager();
            const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);
            const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

            await ctx.reply(
              `💰 <b>Send Your Deposit</b>\n\n` +
              `You have <b>3 minutes</b> to complete this.\n\n` +
              `<b>Wager Amount:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
              `<b>Network:</b> ${formatNetworkName(flip.tokenNetwork)}\n\n` +
              `📮 <b>Send to this address:</b>\n\n` +
              `<code>${botWalletAddress}</code>\n\n` +
              `Once sent, click the button below:`,
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.callback('✅ I Sent the Deposit', `deposit_confirmed_${confirmSession.id}`)],
                ]).reply_markup,
              }
            );
          } else {
            // No stored wallet - ask user to set it up
            confirmSession.currentStep = 'AWAITING_WALLET_ADDRESS';
            await confirmSession.save();

            logger.info('[start] No stored wallet for challenger, asking to set up', { flipId, network: flip.tokenNetwork });

            await ctx.reply(
              `❌ <b>Wallet Address Required</b>\n\n` +
              `We need your ${flip.tokenNetwork} wallet address to send you your winnings!\n\n` +
              `Use /wallet to add your receiving addresses, then come back here to continue.`,
              { parse_mode: 'HTML' }
            );
          }
          return;
        } catch (error) {
          logger.error('Error handling accept start parameter', { error: error.message, flipId });
          await ctx.reply('❌ Error accepting challenge');
        }
      }

      // Check if this is a flip confirmation (from the challenger deeplink)
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
          logger.info('[flip_deeplink] Retrieved session from DB', {
            sessionId,
            found: !!session,
            sessionJSON: JSON.stringify(session?.toJSON ? session.toJSON() : session),
            dataField: session?.data,
            typeOfData: typeof session?.data
          });
          
          if (session && parseInt(session.userId) === userId) {
            // Delete the original "Start a Coin Flip!" message from the group
            logger.info('[flip_deeplink] Attempting to delete initial message', {
              sessionId,
              hasMessageId: !!session.data?.initialGroupMessageId,
              hasGroupId: !!session.data?.groupId,
              messageId: session.data?.initialGroupMessageId,
              groupId: session.data?.groupId
            });
            
            if (session.data?.initialGroupMessageId && session.data?.groupId) {
              try {
                await ctx.telegram.deleteMessage(
                  session.data.groupId,
                  session.data.initialGroupMessageId
                );
                logger.info('[flip_deeplink] ✅ Deleted initial Start Flip message from group', { 
                  sessionId, 
                  messageId: session.data.initialGroupMessageId,
                  groupId: session.data.groupId
                });
              } catch (delErr) {
                logger.error('[flip_deeplink] ❌ Failed to delete initial Start Flip message', { 
                  error: delErr.message,
                  messageId: session.data.initialGroupMessageId,
                  groupId: session.data.groupId,
                  errorCode: delErr.code
                });
              }
            } else {
              logger.warn('[flip_deeplink] ⚠️ Could not delete initial message - missing IDs', { 
                hasMessageId: !!session.data?.initialGroupMessageId,
                hasGroupId: !!session.data?.groupId,
                sessionData: session.data
              });
            }

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

  leaderboard: async (ctx) => {
    await LeaderboardHandler.showLeaderboard(ctx);
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

        const fs = require('fs');
        const path = require('path');
        const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');
        
        let groupMsg;
        try {
          if (fs.existsSync(imagePath)) {
            groupMsg = await ctx.replyWithPhoto(
              { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
              {
                caption: '🪙 <b>Start a Coin Flip!</b>\n\n' +
                'Click below to set up your flip in DM (for privacy)',
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.url('💬 Start in DM', `https://t.me/${botInfo.username}?start=flip_${session.id}`)],
                ]).reply_markup,
              }
            );
            logger.info('Photo sent successfully', { messageId: groupMsg.message_id });
          } else {
            logger.warn('Image file not found', { imagePath });
            throw new Error('Image not found');
          }
        } catch (imgErr) {
          logger.warn('Failed to send Start Flip photo', { error: imgErr.message, imagePath });
          groupMsg = await ctx.reply(
            '🪙 <b>Start a Coin Flip!</b>\n\n' +
            'Click below to set up your flip in DM (for privacy)',
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.url('💬 Start in DM', `https://t.me/${botInfo.username}?start=flip_${session.id}`)],
              ]).reply_markup,
            }
          );
        }

        // Store the message ID and group ID so we can delete it later
        session.data.initialGroupMessageId = groupMsg.message_id;
        session.data.groupId = ctx.chat.id; // Explicitly preserve groupId
        await session.save();
        logger.info('[flip] Stored initial message for deletion', { sessionId: session.id, messageId: groupMsg.message_id, groupId: ctx.chat.id });
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
    const expectedAmount = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
    const botWallet = verification.botWallet || 'Unknown';
    await ctx.reply(
      `❌ <b>Deposit Not Detected</b>\n\n` +
      `Expected: ${expectedAmount} ${flip.tokenSymbol}\n` +
      `Received: ${(verification.amount || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n\n` +
      `<b>Troubleshooting:</b>\n` +
      `• Confirm you sent to: <code>${botWallet}</code>\n` +
      `• Check the amount is exactly ${expectedAmount}\n` +
      `• Blockchain transactions take 30-60 seconds to confirm\n` +
      `• Try confirming again in 30 seconds\n\n` +
      `If problem persists, contact support.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Mark challenger deposit confirmed
  flip.challengerDepositConfirmed = true;
  flip.status = 'COMPLETED';
  // Clear deposit wallet addresses and accumulated amounts for next session
  flip.creatorDepositWalletAddress = null;
  flip.challengerDepositWalletAddress = null;
  flip.creatorAccumulatedDeposit = 0;
  flip.challengerAccumulatedDeposit = 0;
  await flip.save();

  await ctx.reply(`✅ Deposit confirmed! Executing flip...`);

  // Clear the challenge timeout since flip is now executing
  clearChallengeTimeout(flip.id);

  // Execute the flip
  await ExecutionHandler.executeFlip(flip.id, ctx, null);
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
