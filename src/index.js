const { Telegraf, Markup, session } = require('telegraf');
const { Op } = require('sequelize');
const config = require('./config');
const { initDB, getDB } = require('./database');
const { initBlockchainManager, getBlockchainManager } = require('./blockchain/manager');
const fs = require('fs');
const path = require('path');
const FlipHandler = require('./handlers/flipHandler');
const ExecutionHandler = require('./handlers/executionHandler');
const AdminHandler = require('./handlers/adminHandler');
const WalletHandler = require('./handlers/walletHandler');
const LeaderboardHandler = require('./handlers/leaderboardHandler');
const DatabaseUtils = require('./database/utils');
const logger = require('./utils/logger');
const { validateConfig, formatNetworkName, getVideoDuration } = require('./utils/helpers');

// Known token symbols for common Solana tokens
const KNOWN_TOKENS = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD9DUwRzTk67cBrTSsiv31': 'USDT',
  'So11111111111111111111111111111111111111112': 'SOL',
  '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump': 'SID', // Our test token
};

/**
 * Get token symbol from mint address
 */
function getTokenSymbol(mint) {
  if (!mint) return 'Token';
  return KNOWN_TOKENS[mint] || 'Token';
}

/**
 * Validate mint address format
 */
function isValidMintAddress(tokenAddress) {
  if (!tokenAddress) return false;
  if (tokenAddress === 'NATIVE') return true;
  return tokenAddress.match(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/) !== null;
}

let bot;
let sessionStore = {};
let challengeTimeouts = {}; // Store challenge acceptance timeouts by flipId
let botInitialized = false; // Guard to prevent re-initializing bot on retries

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
          // Send alert video to group
          const botInfo = await telegram.getMe();
          const deeplink = `https://t.me/${botInfo.username}?start=accept_${flipId}`;
          const videoPath = path.join(process.cwd(), 'assets/accept-it-stan-marsh.mp4');
          
          if (fs.existsSync(videoPath)) {
            await telegram.sendVideo(
              groupId,
              { filename: 'accept-it-stan-marsh.mp4', source: fs.createReadStream(videoPath) },
              {
                caption: `⏰ <b>Challenge Expiring!</b>\n\n` +
                  `The challenge for <b>${parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}</b> ` +
                  `will expire in <b>1 minute</b> if no one accepts!\n\n` +
                  `⚡ Tap the button below to join:`,
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.url('Accept Challenge', deeplink)],
                ]).reply_markup,
              }
            );
          } else {
            // Fallback to text message if video not found
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
          }
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
              flipCheck.changed('data', true); // Explicitly mark JSON field as changed for Sequelize
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
                
                const expiredMsg = await telegram.sendMessage(
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
                // Store expired notice message ID for later deletion
                flipCheck.data = { ...(flipCheck.data || {}), expiredNoticeMessageId: expiredMsg.message_id };
                flipCheck.changed('data', true); // Explicitly mark JSON field as changed for Sequelize
                await flipCheck.save();
                
                // Verify it was saved
                const savedFlip = await models.CoinFlip.findByPk(flipId);
                logger.info('[challengeTimeout] ✅ Stored expiration message for later deletion', { 
                  flipId, 
                  sessionId: newFlipSession.id, 
                  messageId: expiredMsg.message_id,
                  groupChatId: flipCheck.groupChatId,
                  stored: savedFlip?.data?.expiredNoticeMessageId,
                  verified: savedFlip?.data?.expiredNoticeMessageId === expiredMsg.message_id
                });
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
 * Safely delete a message from a group
 */
async function deleteGroupMessage(telegram, groupId, messageId) {
  if (!messageId || !groupId) {
    logger.debug('[deleteGroupMessage] Skipping - missing IDs', { groupId, messageId });
    return false;
  }
  
  try {
    logger.debug('[deleteGroupMessage] Attempting deletion', { groupId, messageId });
    await telegram.deleteMessage(groupId, messageId);
    logger.info('[deleteGroupMessage] ✅ Message deleted successfully', { groupId, messageId });
    return true;
  } catch (err) {
    const errorMsg = err.message.toLowerCase();
    if (errorMsg.includes('message to delete not found') || errorMsg.includes('message_not_found') || errorMsg.includes('bad request')) {
      logger.info('[deleteGroupMessage] Message already deleted or expired', { groupId, messageId, error: err.message });
      return true; // Not an error - message is already gone
    }
    logger.warn('[deleteGroupMessage] ❌ Failed to delete message', { groupId, messageId, error: err.message, errorCode: err.code });
    return false;
  }
}

/**
 * Auto-delete a message after a delay (for interaction confirmations)
 */
function autoDeleteMessageAfterDelay(telegram, groupId, messageId, delayMs = 5000) {
  if (!messageId || !groupId) {
    logger.debug('[autoDeleteMessageAfterDelay] Skipping - missing IDs', { groupId, messageId });
    return;
  }
  
  logger.debug('[autoDeleteMessageAfterDelay] Scheduled deletion', { groupId, messageId, delayMs });
  
  setTimeout(async () => {
    try {
      logger.debug('[autoDeleteMessageAfterDelay] Executing deletion', { groupId, messageId });
      await deleteGroupMessage(telegram, groupId, messageId);
    } catch (err) {
      logger.warn('[autoDeleteMessageAfterDelay] Error during auto-delete', { groupId, messageId, error: err.message });
    }
  }, delayMs);
}

/**
 * Delete all old messages from previous flip before posting new one
 */
async function deleteOldFlipMessagesInGroup(telegram, groupId, excludeFlipId) {
  try {
    if (!groupId || !telegram) {
      logger.warn('[deleteOldFlipMessagesInGroup] ❌ Missing telegram or groupId', { groupId, excludeFlipId });
      return;
    }

    logger.info('[deleteOldFlipMessagesInGroup] 🔍 Starting cleanup', { groupId, excludeFlipId });

    const { models } = getDB();
    const oldFlips = await models.CoinFlip.findAll({
      where: {
        groupChatId: groupId,
        id: { [Op.ne]: excludeFlipId },
        status: { [Op.in]: ['COMPLETED', 'CANCELLED', 'WAITING_CHALLENGER'] },
      },
      order: [['createdAt', 'DESC']],
      limit: 5,
      raw: false,
    });

    logger.info('[deleteOldFlipMessagesInGroup] 📋 Found old flips', { 
      groupId, 
      count: oldFlips.length,
      flipIds: oldFlips.map(f => ({ id: f.id, status: f.status, hasData: !!f.data })),
    });

    for (const flip of oldFlips) {
      try {
        // Handle both old and new storage formats
        const groupMsgId = flip.data?.groupMessageId || flip.groupMessageId;
        const expiredMsgId = flip.data?.expiredNoticeMessageId;
        
        logger.info('[deleteOldFlipMessagesInGroup] 🗑️ Cleaning flip', { 
          flipId: flip.id,
          flipStatus: flip.status,
          hasGroupMsgId: !!groupMsgId,
          groupMsgId,
          hasExpiredMsgId: !!expiredMsgId,
          expiredMsgId,
          flipData: flip.data,
        });

        if (groupMsgId) {
          logger.info('[deleteOldFlipMessagesInGroup] Deleting group message', { groupId, msgId: groupMsgId });
          const deleted = await deleteGroupMessage(telegram, groupId, groupMsgId);
          logger.info('[deleteOldFlipMessagesInGroup] Group message deletion result', { msgId: groupMsgId, deleted });
        }
        if (expiredMsgId) {
          logger.info('[deleteOldFlipMessagesInGroup] Deleting expired notice', { groupId, msgId: expiredMsgId });
          const deleted = await deleteGroupMessage(telegram, groupId, expiredMsgId);
          logger.info('[deleteOldFlipMessagesInGroup] Expired notice deletion result', { msgId: expiredMsgId, deleted });
        }
      } catch (flipErr) {
        logger.error('[deleteOldFlipMessagesInGroup] Error cleaning individual flip', { flipId: flip.id, error: flipErr.message });
      }
    }

    logger.info('[deleteOldFlipMessagesInGroup] ✅ Cleanup complete', { groupId, flipsProcessed: oldFlips.length });
  } catch (err) {
    logger.error('[deleteOldFlipMessagesInGroup] ❌ Error during cleanup', { groupId, error: err.message, stack: err.stack });
  }
}

/**
 * Delete old flip message when new flip starts in same group (prevent stale buttons)
 */
async function deleteOldFlipMessage(groupId, telegram) {
  try {
    const { models } = getDB();
    const previousFlip = await models.CoinFlip.findOne({
      where: {
        groupChatId: groupId,
        status: ['COMPLETED', 'CANCELLED']
      },
      order: [['createdAt', 'DESC']],
      limit: 1
    });

    if (previousFlip && previousFlip.data?.groupMessageId) {
      await deleteGroupMessage(telegram, groupId, previousFlip.data.groupMessageId);
    }
  } catch (err) {
    logger.warn('[deleteOldFlipMessage] Error deleting old message', { groupId, error: err.message });
  }
}

/**
 * Initialize the bot
 */
async function initBot() {
  try {
    console.log('[INIT_BOT] Starting bot initialization...');
    // Skip re-initialization if bot already initialized (prevents duplicate from retry)
    if (botInitialized && bot) {
      logger.info('Bot already initialized, skipping re-init');
      return;
    }

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
    try {
      bot = new Telegraf(config.telegram.token);
      console.log('✅ Telegraf instance created');
    } catch (err) {
      console.error('❌ Failed to create Telegraf instance:', err);
      throw err;
    }

    // Set up bot commands menu
    console.log('Setting up commands menu...');
    try {
      await bot.telegram.setMyCommands([
        { command: 'start', description: '🎲 Start the bot' },
        { command: 'help', description: '❓ How to play' },
        { command: 'stats', description: '📊 Your game statistics' },
        { command: 'flip', description: '🪙 Start a coin flip' },
        { command: 'wallet', description: '💳 Manage wallet addresses' },
        { command: 'leaderboard', description: '🏆 Top winners and losers' },
      ]);
      console.log('✅ Commands menu set');
    } catch (err) {
      console.error('❌ Failed to set commands menu:', err);
      throw err;
    }

    // Middleware setup
    console.log('Setting up middleware...');
    bot.use(middleware.errorHandler);
    console.log('[MW] Error handler middleware registered');

    // Commands
    console.log('Registering commands...');
    console.log('[CMD] Registering /start');
    bot.start(handlers.start);
    console.log('[CMD] Registering /help');
    bot.command('help', handlers.help);
    console.log('[CMD] Registering /stats');
    bot.command('stats', handlers.stats);
    console.log('[CMD] Registering /flip');
    bot.command('flip', handlers.flip);
    console.log('[CMD] Registering /wallet');
    bot.command('wallet', handlers.wallet);
    console.log('[CMD] Registering /leaderboard');
    bot.command('leaderboard', handlers.leaderboard);
    console.log('✅ Commands registered successfully');

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
                const videoPath = path.join(process.cwd(), 'assets/accept-it-stan-marsh.mp4');
                
                if (fs.existsSync(videoPath)) {
                  await bot.telegram.sendVideo(
                    flipCheck.groupChatId,
                    { filename: 'accept-it-stan-marsh.mp4', source: fs.createReadStream(videoPath) },
                    {
                      caption: `⏰ <b>Challenge Expiring!</b>\n\n` +
                        `The challenge for <b>${parseFloat(flipCheck.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flipCheck.tokenSymbol}</b> ` +
                        `will expire in <b>1 minute</b> if no one accepts!\n\n` +
                        `⚡ Tap the button below to join:`,
                      parse_mode: 'HTML',
                      reply_markup: Markup.inlineKeyboard([
                        [Markup.button.url('Accept Challenge', deeplink)],
                      ]).reply_markup,
                    }
                  );
                } else {
                  // Fallback to text message if video not found
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
                }
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
    
    // Mark bot as successfully initialized to prevent re-init on retries
    botInitialized = true;

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
      console.log('[TEXT_HANDLER] Message received:', { text: ctx.message.text, userId: ctx.from.id, chatType: ctx.chat.type });
      // Skip if this is a command - let command handlers process it
      if (ctx.message.text.startsWith('/')) {
        console.log('[TEXT_HANDLER] Skipping command, letting command handler process');
        return;
      }
      
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
      } catch (error) {
        logger.error('Error updating Paxeer wallet', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    bot.action('update_solana_wallet', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleUpdateSolana(ctx);
      } catch (error) {
        logger.error('Error updating Solana wallet', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    bot.action('remove_all_wallets', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleRemoveAll(ctx);
      } catch (error) {
        logger.error('Error removing wallets', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    bot.action('update_evm_deposit_wallet', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleUpdateEVMDeposit(ctx);
      } catch (error) {
        logger.error('Error updating Paxeer deposit wallet', error);
        await ctx.answerCbQuery('Error', true);
      }
    });

    bot.action('update_solana_deposit_wallet', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleUpdateSolanaDeposit(ctx);
      } catch (error) {
        logger.error('Error updating Solana deposit wallet', error);
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
        logger.info('[accept_flip] Action triggered', { flipId, userId, hasGroupChatId: !!flip.groupChatId });
        
        // Clear the challenge acceptance timeout since someone accepted
        clearChallengeTimeout(flipId);
        
        // Show loading popup
        await ctx.answerCbQuery('⏳ Accepting challenge...');
        
        // Call the flip handler (which sends auto-DM)
        await FlipHandler.acceptFlip(ctx, flipId);
        
        // Delete the flip's original challenge message and any expired notice
        if (flip.groupChatId && ctx.telegram) {
          // Check both old and new storage formats
          const groupMsgId = flip.data?.groupMessageId || flip.groupMessageId;
          const expiredMsgId = flip.data?.expiredNoticeMessageId;
          
          logger.info('[accept_flip] Attempting to delete messages', { 
            flipId, 
            groupChatId: flip.groupChatId,
            groupMsgId,
            expiredMsgId
          });
          
          if (groupMsgId) {
            await deleteGroupMessage(ctx.telegram, flip.groupChatId, groupMsgId);
          }
          if (expiredMsgId) {
            await deleteGroupMessage(ctx.telegram, flip.groupChatId, expiredMsgId);
          }
        }
        
        // Delete the current button message
        try {
          await ctx.deleteMessage();
        } catch (delErr) {
          logger.debug('[accept_flip] Could not delete button message', { error: delErr.message });
        }
        
        // Send a confirmation message that will auto-delete after 5 seconds
        const challengerName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        let confirmMsg;
        try {
          confirmMsg = await ctx.reply(
            `✅ ${challengerName} has accepted and is reviewing the flip.`,
            { parse_mode: 'HTML' }
          );
          logger.debug('[accept_flip] Sent confirmation message', { messageId: confirmMsg?.message_id });
          
          // Auto-delete confirmation after 5 seconds
          if (confirmMsg && flip.groupChatId) {
            logger.debug('[accept_flip] Scheduling auto-delete for confirmation', { 
              groupChatId: flip.groupChatId,
              messageId: confirmMsg.message_id 
            });
            autoDeleteMessageAfterDelay(ctx.telegram, flip.groupChatId, confirmMsg.message_id, 5000);
          }
        } catch (replyErr) {
          logger.warn('[accept_flip] Could not send confirmation message', { error: replyErr.message });
        }
        
        logger.info('[accept_flip] Completed successfully', { flipId, userId });
      } catch (error) {
        logger.error('[accept_flip] Error', { error: error.message, stack: error.stack, flipId, userId });
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

        // Check if user has both required wallet addresses in their profile
        const userProfile = await models.UserProfile.findByPk(userId);
        const receiveWalletField = flip.tokenNetwork === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
        const depositWalletField = flip.tokenNetwork === 'EVM' ? 'evmDepositWalletAddress' : 'solanaDepositWalletAddress';
        
        const receiveWallet = userProfile?.[receiveWalletField];
        const depositWallet = userProfile?.[depositWalletField];

        if (receiveWallet && depositWallet) {
          // Both wallets are set - use them and show deposit instructions
          // DON'T store on flip - UserProfile is source of truth
          
          logger.info('Using stored wallet addresses for challenger', { flipId, network: flip.tokenNetwork, hasReceive: !!receiveWallet, hasDeposit: !!depositWallet });

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
          // Missing one or both wallets - ask user to set them up
          session.currentStep = 'AWAITING_WALLET_ADDRESS';
          await session.save();
          logger.info('[confirm_flip] Missing wallets, asking user to set up', { sessionId, network: flip.tokenNetwork, hasReceive: !!receiveWallet, hasDeposit: !!depositWallet });

          await ctx.reply(
            `❌ <b>Setup Complete Wallet Configuration</b>\n\n` +
            `Before you can play, you need to set up both:\n` +
            `${receiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
            `${depositWallet ? '✅' : '❌'} <b>Sending Wallet:</b> Where you send payments from\n\n` +
            `Configure your wallets to continue:`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('💳 Configure Wallets', 'open_wallet_menu')],
              ]).reply_markup,
            }
          );

          await ctx.answerCbQuery('✅ Challenge confirmed! Please set up your wallets.');
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
        
        // GET USER'S WALLETS - Both required for flip
        const userProfile = await models.UserProfile.findByPk(userId);
        const receiveWallet = flip.tokenNetwork === 'EVM' 
          ? userProfile?.evmWalletAddress 
          : userProfile?.solanaWalletAddress;
        const depositWallet = flip.tokenNetwork === 'EVM' 
          ? userProfile?.evmDepositWalletAddress 
          : userProfile?.solanaDepositWalletAddress;
        
        logger.info('[deposit_confirmed] Wallets loaded from UserProfile', {
          userId,
          network: flip.tokenNetwork,
          receiveWallet,
          depositWallet,
          allProfileData: {
            evmWalletAddress: userProfile?.evmWalletAddress,
            evmDepositWalletAddress: userProfile?.evmDepositWalletAddress,
            solanaWalletAddress: userProfile?.solanaWalletAddress,
            solanaDepositWalletAddress: userProfile?.solanaDepositWalletAddress,
          },
        });
        
        // Require user to set both wallets first
        if (!receiveWallet || !depositWallet) {
          try {
            await ctx.editMessageText(
              `❌ <b>Wallet Configuration Required</b>\n\n` +
              `${receiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
              `${depositWallet ? '✅' : '❌'} <b>Sending Wallet:</b> Where you send payments from\n\n` +
              `Use /wallet to complete your setup.`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            logger.warn('[deposit_confirmed] Failed to edit message', err.message);
          }
          return;
        }
        
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
        // Use the user's configured deposit wallet as the knownSender
        const blockchainManager = getBlockchainManager();
        
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals,
          4, // maxRetries
          5000, // retryDelayMs - 5 second delay to account for Helius indexing lag
          depositWallet, // Use user's configured deposit wallet
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
          
          // Store detected amount for refunds
          if (verification.depositSender) {
            if (!flip.challengerAccumulatedDeposit) {
              // CRITICAL: Store in DISPLAY units, not raw units
              const tokenDecimals = flip.tokenDecimals || 18;
              // Use pre-calculated amountDisplay if available, otherwise calculate
              const receivedDisplay = verification.amountDisplay !== undefined ? verification.amountDisplay : (verification.isWrongToken && verification.wrongToken === 'NATIVE' ? parseFloat(verification.amount || 0) : (parseFloat(verification.amount || 0) / Math.pow(10, tokenDecimals)));
              flip.challengerAccumulatedDeposit = receivedDisplay.toString();
              logger.info('[deposit_confirmed] Initial deposit detected', { 
                flipId, 
                sender: verification.depositSender,
                initialAmount: verification.amount
              });
            } else {
              // On retry, update accumulated amount (query returns cumulative from that sender)
              const previousAccumulated = parseFloat(flip.challengerAccumulatedDeposit || 0);
              // CRITICAL: Convert current total from raw to display units
              const tokenDecimals = flip.tokenDecimals || 18;
              const currentTotalRaw = parseFloat(verification.amount || 0);
              // For wrong tokens (especially native SOL), amount is already display units
              const currentTotal = verification.isWrongToken ? currentTotalRaw : (currentTotalRaw / Math.pow(10, tokenDecimals));
              flip.challengerAccumulatedDeposit = currentTotal.toString();
              
              logger.info('[deposit_confirmed] Updated challenger accumulated deposit', {
                flipId,
                previousAccumulated,
                currentTotal,
                newDepositsSinceLastCheck: currentTotal - previousAccumulated,
              });
            }
          }
          
          // CRITICAL: Attempt to refund any incorrect tokens that were sent (not throttled by time)
          // But only attempt ONCE per flip to prevent duplicate transactions
          const hasAttemptedRefund = flip.data?.refundAttempted === true;
          if (verification.isWrongToken && verification.depositSender && flip.tokenAddress && flip.tokenAddress !== 'NATIVE' && !hasAttemptedRefund) {
            try {
              const blockchainManager = getBlockchainManager();
              logger.info('[deposit_confirmed] Attempting to refund incorrect tokens from challenger', { 
                flipId, 
                expectedToken: flip.tokenAddress, 
                sender: verification.depositSender 
              });
              
              // Mark that we've attempted refund to prevent duplicate calls
              flip.data = { ...flip.data, refundAttempted: true };
              await flip.save();
              
              // Wait 10 seconds before calling refund to let RPC recover from rate limiting
              logger.info('[deposit_confirmed] Waiting 10s before attempting refund to avoid RPC rate limits', { flipId });
              await new Promise(resolve => setTimeout(resolve, 10000));
              
              // Call refund with RPC back-off
              const refundResults = await blockchainManager.refundIncorrectTokens(
                flip.tokenNetwork,
                flip.tokenAddress,
                verification.depositSender,
                flip.createdAt
              );

              if (refundResults && refundResults.length > 0) {
                logger.info('[deposit_confirmed] Refunded incorrect tokens to challenger', { 
                  flipId, 
                  refundCount: refundResults.length,
                  refunds: refundResults 
                });
              }
            } catch (refundErr) {
              logger.error('[deposit_confirmed] Error refunding incorrect tokens', { 
                flipId, 
                error: refundErr.message 
              });
            }
          }
          
          // Check if notification already sent for this verification attempt (separate from refund logic)
          const lastNotificationTime = flip.data?.lastInsufficientDepositNotification || 0;
          const timeSinceLastNotification = Date.now() - lastNotificationTime;
          
          // Only send notification if more than 30 seconds have passed since last one
          if (timeSinceLastNotification > 30000) {
            const tokenDecimals = flip.tokenDecimals || 18;
            const formattedExpected = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            // CRITICAL: For wrong tokens, amount is already display units. For correct tokens, convert from raw to display
            const receivedAmountRaw = parseFloat(verification.amount || '0');
            const receivedAmount = verification.amountDisplay !== undefined ? verification.amountDisplay : (verification.isWrongToken ? receivedAmountRaw : (receivedAmountRaw / Math.pow(10, tokenDecimals)));
            const shortfallAmount = (parseFloat(flip.wagerAmount) - receivedAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            const botWallet = verification.botWallet || 'Unknown';
            
            // Check if wrong token was detected
            let messageText;
            if (verification.isWrongToken) {
              // Determine correct native token name based on network
              let wrongTokenName = verification.wrongToken;
              if (verification.wrongToken === 'NATIVE') {
                wrongTokenName = verification.network === 'Solana' ? 'SOL (native)' : 'PAX (native)';
              } else {
                // For SPL tokens, lookup the symbol from mint address
                wrongTokenName = getTokenSymbol(verification.wrongToken);
              }
              messageText = 
                `⚠️ <b>Wrong Token Detected</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${wrongTokenName}\n\n` +
                `<b>Status: Automatically refunding your ${wrongTokenName}...</b>\n\n` +
                `<b>Send ${flip.tokenSymbol} to:</b>\n` +
                `<code>${botWallet}</code>\n\n` +
                `Please send the correct token: <b>${flip.tokenSymbol}</b>`;
            } else {
              messageText = 
                `❌ <b>Insufficient Deposit</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` + +
                `<b>Still needed: ${shortfallAmount} ${flip.tokenSymbol}</b>\n\n` +
                `<b>Troubleshooting:</b>\n` +
                `• Verify you sent to: <code>${botWallet}</code>\n` +
                `• Check amount matches exactly (${formattedExpected})\n` +
                `• Wait 30 seconds for blockchain confirmation\n` +
                `• Then try confirming again\n\n` +
                `You have <b>3 minutes</b> to send the remaining amount, otherwise your deposit will be refunded and the challenge cancelled.`;
            }
            
            try {
              await ctx.editMessageText(
                messageText,
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
            try {
              await flip.save();
            } catch (saveErr) {
              logger.error('[deposit_confirmed] ERROR saving flip after notification', { flipId, error: saveErr.message });
            }
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
          logger.info('[deposit_confirmed] About to save flip before showing retry button', { flipId, status: flip.status });
          try {
            await flip.save();
            logger.info('[deposit_confirmed] Flip saved successfully', { flipId });
          } catch (saveErr) {
            logger.error('[deposit_confirmed] ERROR saving flip after insufficient deposit', { flipId, error: saveErr.message, stack: saveErr.stack });
          }
          
          return;
        }

        logger.info('[deposit_confirmed] Challenger deposit verified', { flipId, userId, amount: verification.amount });

        // Store the detected sender address for refunds (if not already set)
        if (verification.depositSender && !flip.challengerDepositWalletAddress) {
          flip.challengerDepositWalletAddress = verification.depositSender;
          logger.info('[deposit_confirmed] Detected challenger deposit sender', { flipId, sender: verification.depositSender });
        }

        // Convert received amount from raw units to display units for comparison
        const tokenDecimals = flip.tokenDecimals || 18;
        const receivedAmountDisplay = parseFloat(verification.amount) / Math.pow(10, tokenDecimals);
        const wagerAmountDisplay = parseFloat(flip.wagerAmount);

        // Use pre-calculated amountDisplay from manager if available, otherwise calculate
        // amountDisplay already accounts for token decimals and native token special cases
        const receivedAmountDisplayFinal = verification.amountDisplay !== undefined ? 
          verification.amountDisplay : 
          receivedAmountDisplay;

        // Ensure accumulated deposit is set for overpayment check (store in display units for consistency)
        if (parseFloat(flip.challengerAccumulatedDeposit || 0) < receivedAmountDisplayFinal) {
          flip.challengerAccumulatedDeposit = receivedAmountDisplayFinal.toString();
          // CRITICAL: Also update wallet address when updating accumulated deposit
          // This ensures refund goes to the wallet that sent the current verified amount
          flip.challengerDepositWalletAddress = verification.depositSender;
        }

        logger.info('[deposit_confirmed] Starting overpayment check', {
          flipId,
          receivedRawAmount: verification.amount,
          receivedDisplayAmount: receivedAmountDisplayFinal,
          wagerAmount: wagerAmountDisplay,
          tokenDecimals,
        });

        // If they sent more than the wager, refund the excess (both in display units)
        // Use accumulated deposit if available, otherwise use wager as fallback
        const receivedAmount = flip.challengerAccumulatedDeposit ? parseFloat(flip.challengerAccumulatedDeposit) : receivedAmountDisplayFinal;
        const wagerAmount = wagerAmountDisplay;
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
              let refundDecimals = 18;
              
              for (const key in supportedTokens) {
                if (supportedTokens[key].symbol === flip.tokenSymbol && supportedTokens[key].network === flip.tokenNetwork) {
                  tokenAddress = supportedTokens[key].address || 'NATIVE';
                  refundDecimals = supportedTokens[key].decimals || 18;
                  break;
                }
              }

              // Validate token address before attempting refund
              // Only refund if we have a recognized token with known on-chain validity
              const isRecognizedToken = tokenAddress === 'NATIVE' || (tokenAddress && tokenAddress in KNOWN_TOKENS);
              if (!isValidMintAddress(tokenAddress)) {
                logger.warn('[deposit_confirmed] Skipping excess refund - invalid token address format', { 
                  flipId, 
                  tokenAddress,
                  excess: excessAmount.toString()
                });
              } else if (!isRecognizedToken) {
                logger.warn('[deposit_confirmed] Skipping excess refund - unrecognized token (may be invalid on-chain)', { 
                  flipId, 
                  tokenAddress,
                  tokenSymbol: flip.tokenSymbol,
                  excess: excessAmount.toString()
                });
              } else {
                // Pass display units - transferToken will convert to raw units
                logger.info('[deposit_confirmed] Sending refund', {
                  flipId,
                  network: flip.tokenNetwork,
                  tokenAddress,
                  recipient: flip.challengerDepositWalletAddress,
                  excessDisplay: excessAmount.toString(),
                  decimals: refundDecimals,
                });
                
                await blockchainManager.sendWinnings(
                  flip.tokenNetwork,
                  tokenAddress,
                  flip.challengerDepositWalletAddress,
                  excessAmount,
                  refundDecimals
                );
                
                logger.info('[deposit_confirmed] Refunded excess deposit', { 
                  flipId, 
                  excess: excessAmount,
                  recipient: flip.challengerDepositWalletAddress
                });
              }
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
        
        // GET USER'S WALLETS - Both required for flip
        const userProfile = await models.UserProfile.findByPk(userId);
        const receiveWallet = flip.tokenNetwork === 'EVM' 
          ? userProfile?.evmWalletAddress 
          : userProfile?.solanaWalletAddress;
        const depositWallet = flip.tokenNetwork === 'EVM' 
          ? userProfile?.evmDepositWalletAddress 
          : userProfile?.solanaDepositWalletAddress;
        
        logger.info('[creator_deposit_confirmed] Wallets loaded from UserProfile', {
          userId,
          network: flip.tokenNetwork,
          receiveWallet,
          depositWallet,
          allProfileData: {
            evmWalletAddress: userProfile?.evmWalletAddress,
            evmDepositWalletAddress: userProfile?.evmDepositWalletAddress,
            solanaWalletAddress: userProfile?.solanaWalletAddress,
            solanaDepositWalletAddress: userProfile?.solanaDepositWalletAddress,
          },
        });
        
        // Require user to set both wallets first
        if (!receiveWallet || !depositWallet) {
          try {
            await ctx.editMessageText(
              `❌ <b>Wallet Configuration Required</b>\n\n` +
              `${receiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
              `${depositWallet ? '✅' : '❌'} <b>Deposit Wallet:</b> Where you send deposits from\n\n` +
              `Use /wallet to complete your setup.`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            logger.warn('[creator_deposit_confirmed] Failed to edit message', err.message);
          }
          return;
        }
        
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
        // Use the user's configured deposit wallet as the knownSender
        const blockchainManager = getBlockchainManager();
        
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals,
          4, // maxRetries
          5000, // retryDelayMs - 5 second delay to account for Helius indexing lag
          depositWallet, // Use user's configured deposit wallet
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
          
          // Store detected amount for refunds  
          if (verification.depositSender) {
            if (!flip.creatorAccumulatedDeposit) {
              // CRITICAL: Store in DISPLAY units, not raw units
              const tokenDecimals = flip.tokenDecimals || 18;
              // Use pre-calculated amountDisplay if available, otherwise calculate
              const receivedDisplay = verification.amountDisplay !== undefined ? verification.amountDisplay : (verification.isWrongToken && verification.wrongToken === 'NATIVE' ? parseFloat(verification.amount || 0) : (parseFloat(verification.amount || 0) / Math.pow(10, tokenDecimals)));
              flip.creatorAccumulatedDeposit = receivedDisplay.toString();
              logger.info('[creator_deposit_confirmed] Initial deposit detected', { 
                flipId, 
                sender: verification.depositSender,
                initialAmount: verification.amount
              });
            } else {
              // On retry, update accumulated amount (query returns cumulative from that sender)
              const previousAccumulated = parseFloat(flip.creatorAccumulatedDeposit || 0);
              // CRITICAL: Convert current total from raw to display units
              const tokenDecimals = flip.tokenDecimals || 18;
              const currentTotalRaw = parseFloat(verification.amount || 0);
              // For wrong tokens (especially native SOL), amount is already display units
              const currentTotal = verification.isWrongToken ? currentTotalRaw : (currentTotalRaw / Math.pow(10, tokenDecimals));
              flip.creatorAccumulatedDeposit = currentTotal.toString();

              logger.info('[creator_deposit_confirmed] Updated creator accumulated deposit', {
                flipId,
                previousAccumulated,
                currentTotal,
                newDepositsSinceLastCheck: currentTotal - previousAccumulated,
              });
            }
          }
          
          // Check if notification already sent for this verification attempt
          const lastNotificationTime = flip.data?.lastInsufficientDepositNotification || 0;
          const timeSinceLastNotification = Date.now() - lastNotificationTime;
          
          // Only send notification if more than 30 seconds have passed since last one
          if (timeSinceLastNotification > 30000) {
            const tokenDecimals = flip.tokenDecimals || 18;
            const formattedExpected = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            // CRITICAL: For wrong tokens, amount is already display units. For correct tokens, convert from raw to display
            const receivedAmountRaw = parseFloat(verification.amount || '0');
            const receivedAmount = verification.amountDisplay !== undefined ? verification.amountDisplay : (verification.isWrongToken ? receivedAmountRaw : (receivedAmountRaw / Math.pow(10, tokenDecimals)));
            const shortfallAmount = (parseFloat(flip.wagerAmount) - receivedAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
            const botWallet = verification.botWallet || 'Unknown';
            
            // Check if wrong token was detected
            let messageText;
            if (verification.isWrongToken) {
              // Determine correct native token name based on network
              let wrongTokenName = verification.wrongToken;
              if (verification.wrongToken === 'NATIVE') {
                wrongTokenName = verification.network === 'Solana' ? 'SOL (native)' : 'PAX (native)';
              } else {
                // For SPL tokens, lookup the symbol from mint address
                wrongTokenName = getTokenSymbol(verification.wrongToken);
              }
              messageText = 
                `⚠️ <b>Wrong Token Detected</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${wrongTokenName}\n\n` +
                `<b>Status: Automatically refunding your ${wrongTokenName}...</b>\n\n` +
                `<b>Send ${flip.tokenSymbol} to:</b>\n` +
                `<code>${botWallet}</code>\n\n` +
                `Please send the correct token: <b>${flip.tokenSymbol}</b>`;
            } else {
              messageText = 
                `⏳ <b>Insufficient Deposit</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
                `<b>Still needed: ${shortfallAmount} ${flip.tokenSymbol}</b>\n\n` +
                `<b>Troubleshooting:</b>\n` +
                `• Verify you sent to: <code>${botWallet}</code>\n` +
                `• Check amount matches exactly (${formattedExpected})\n` +
                `• Wait 30 seconds for blockchain confirmation\n` +
                `• Then try confirming again\n\n` +
                `If not sent within 3 minutes, the challenge will auto-cancel.`;
            }
            
            try {
              await ctx.editMessageText(
                messageText,
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
            try {
              await flip.save();
            } catch (saveErr) {
              logger.error('[creator_deposit_confirmed] ERROR saving flip after notification', { flipId, error: saveErr.message });
            }
          } else {
            logger.info('[creator_deposit_confirmed] Skipping duplicate notification (sent within last 30s)', { flipId });
          }
          
          // CRITICAL: Attempt to refund any incorrect tokens that were sent (not throttled by time)
          // But only attempt ONCE per flip to prevent duplicate transactions
          const hasAttemptedRefund = flip.data?.refundAttempted === true;
          if (verification.isWrongToken && verification.depositSender && flip.tokenAddress && flip.tokenAddress !== 'NATIVE' && !hasAttemptedRefund) {
            try {
              const blockchainManager = getBlockchainManager();
              logger.info('[creator_deposit_confirmed] Attempting to refund incorrect tokens from creator', { 
                flipId, 
                expectedToken: flip.tokenAddress, 
                sender: verification.depositSender 
              });
              
              // Mark that we've attempted refund to prevent duplicate calls
              flip.data = { ...flip.data, refundAttempted: true };
              await flip.save();
              
              // Wait 10 seconds before calling refund to let RPC recover from rate limiting
              logger.info('[creator_deposit_confirmed] Waiting 10s before attempting refund to avoid RPC rate limits', { flipId });
              await new Promise(resolve => setTimeout(resolve, 10000));
              
              // Call refund with RPC back-off
              const refundResults = await blockchainManager.refundIncorrectTokens(
                flip.tokenNetwork,
                flip.tokenAddress,
                verification.depositSender,
                flip.createdAt
              );

              if (refundResults && refundResults.length > 0) {
                logger.info('[creator_deposit_confirmed] Refunded incorrect tokens to creator', { 
                  flipId, 
                  refundCount: refundResults.length,
                  refunds: refundResults 
                });
              }
            } catch (refundErr) {
              logger.error('[creator_deposit_confirmed] Error refunding incorrect tokens', { 
                flipId, 
                error: refundErr.message 
              });
            }
          }
          
          // CRITICAL: Save the sender address before returning if we just detected it
          if (verification.depositSender && flip.creatorDepositWalletAddress === verification.depositSender) {
            try {
              await flip.save();
              logger.info('[creator_deposit_confirmed] Saved flip after detecting sender', { flipId });
            } catch (saveErr) {
              logger.error('[creator_deposit_confirmed] ERROR saving flip after detecting sender', { flipId, error: saveErr.message });
            }
          }
          
          return;
        }

        logger.info('[creator_deposit_confirmed] Creator deposit verified', { flipId, userId, amount: verification.amount });

        // Store the deposit sender wallet address for refunds
        if (verification.depositSender) {
          flip.creatorDepositWalletAddress = verification.depositSender;
          logger.info('[creator_deposit_confirmed] Stored creator deposit wallet address', { 
            flipId, 
            wallet: verification.depositSender 
          });
        }

        // Convert received amount from raw units to display units for comparison
        const creatorTokenDecimals = flip.tokenDecimals || 18;
        // Use pre-calculated amountDisplay from manager if available, otherwise calculate
        // amountDisplay already accounts for token decimals and native token special cases
        const creatorReceivedAmountDisplayFinal = verification.amountDisplay !== undefined ? 
          verification.amountDisplay : 
          (parseFloat(verification.amount) / Math.pow(10, creatorTokenDecimals));
        const creatorWagerAmountDisplay = parseFloat(flip.wagerAmount);

        // Ensure accumulated deposit is set for overpayment check (store in display units for consistency)
        if (parseFloat(flip.creatorAccumulatedDeposit || 0) < creatorReceivedAmountDisplayFinal) {
          flip.creatorAccumulatedDeposit = creatorReceivedAmountDisplayFinal.toString();
        }

        logger.info('[creator_deposit_confirmed] Starting overpayment check', {
          flipId,
          receivedRawAmount: verification.amount,
          receivedDisplayAmount: creatorReceivedAmountDisplayFinal,
          wagerAmount: creatorWagerAmountDisplay,
          tokenDecimals: creatorTokenDecimals,
        });

        // Check if creator sent more than the wager (overpayment) - both in display units
        const creatorReceivedAmount = parseFloat(flip.creatorAccumulatedDeposit || creatorReceivedAmountDisplayFinal);
        const creatorWagerAmount = creatorWagerAmountDisplay;
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
              let refundDecimals = 18;
              
              for (const key in supportedTokens) {
                if (supportedTokens[key].symbol === flip.tokenSymbol && supportedTokens[key].network === flip.tokenNetwork) {
                  tokenAddress = supportedTokens[key].address || 'NATIVE';
                  refundDecimals = supportedTokens[key].decimals || 18;
                  break;
                }
              }

              // Validate token address before attempting refund
              // Only refund if we have a recognized token with known on-chain validity
              const isRecognizedToken = tokenAddress === 'NATIVE' || (tokenAddress && tokenAddress in KNOWN_TOKENS);
              if (!isValidMintAddress(tokenAddress)) {
                logger.warn('[creator_deposit_confirmed] Skipping excess refund - invalid token address format', { 
                  flipId, 
                  tokenAddress,
                  excessDisplay: creatorExcessAmount.toString()
                });
              } else if (!isRecognizedToken) {
                logger.warn('[creator_deposit_confirmed] Skipping excess refund - unrecognized token (may be invalid on-chain)', { 
                  flipId, 
                  tokenAddress,
                  tokenSymbol: flip.tokenSymbol,
                  excessDisplay: creatorExcessAmount.toString()
                });
              } else {
                // Pass display units - transferToken will convert to raw units
                logger.info('[creator_deposit_confirmed] Sending refund', {
                  flipId,
                  network: flip.tokenNetwork,
                  tokenAddress,
                  recipient: flip.creatorDepositWalletAddress,
                  excessDisplay: creatorExcessAmount.toString(),
                  decimals: refundDecimals,
                });
                
                await blockchainManager.sendWinnings(
                  flip.tokenNetwork,
                  tokenAddress,
                  flip.creatorDepositWalletAddress,
                  creatorExcessAmount,
                  refundDecimals
                );
                
                logger.info('[creator_deposit_confirmed] Refunded excess deposit', { 
                  flipId, 
                  excess: creatorExcessAmount,
                  recipient: flip.creatorDepositWalletAddress
                });
              }
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

        // Delete old flip messages from the group before posting the new challenge
        logger.info('[creator_deposit_confirmed] 🧹 About to clean up old messages', { 
          flipId: flip.id,
          groupChatId: flip.groupChatId
        });
        await deleteOldFlipMessagesInGroup(ctx.telegram, flip.groupChatId, flip.id);

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

        // Save message ID to flip (both old and new format for compatibility)
        flip.groupMessageId = groupMessage.message_id;
        flip.data = { ...(flip.data || {}), groupMessageId: groupMessage.message_id };
        flip.changed('data', true); // Explicitly mark JSON field as changed for Sequelize
        await flip.save();
        
        // Verify it was saved
        const savedFlipAfterMsg = await models.CoinFlip.findByPk(flip.id);
        logger.info('[creator_deposit_confirmed] ✅ Stored challenge message for deletion', { 
          flipId: flip.id, 
          messageId: groupMessage.message_id,
          groupChatId: flip.groupChatId,
          dataField: flip.data?.groupMessageId,
          verified: savedFlipAfterMsg?.data?.groupMessageId === groupMessage.message_id
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
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error opening wallet menu', { error: error.message });
        await ctx.answerCbQuery('❌ Error opening wallet menu');
      }
    });

    // Handle back to wallets button after setting a wallet
    bot.action('back_to_wallets', async (ctx) => {
      try {
        ctx.state.models = getDB().models;
        await WalletHandler.handleWalletCommand(ctx);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error going back to wallets', { error: error.message });
        await ctx.answerCbQuery('❌ Error loading wallets');
      }
    });

    // Handle stats button from dashboard
    bot.action('show_stats', async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;
        
        const stats = await DatabaseUtils.getEnhancedUserStats(userId);

        if (stats.totalFlips === 0) {
          await ctx.editMessageText(
            `📊 <b>Your Stats</b>\n\n` +
            `You haven't completed any flips yet!\n` +
            `Start a flip to begin building your stats.`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🏠 Home', 'back_to_home')],
              ]).reply_markup,
            }
          );
          await ctx.answerCbQuery();
          return;
        }

        // Format the stats message
        let message = `📊 <b>Your Game Statistics</b>\n\n`;
        message += `<b>Overall Performance:</b>\n`;
        message += `🎮 Total Flips: <b>${stats.totalFlips}</b>\n`;
        message += `✅ Wins: <b>${stats.wins}</b>\n`;
        message += `❌ Losses: <b>${stats.losses}</b>\n`;
        message += `📈 Win Rate: <b>${stats.winRate}%</b>\n\n`;
        
        message += `<b>Financial Summary:</b>\n`;
        message += `💰 Total Earnings: <b>${parseFloat(stats.totalEarnings).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n`;
        message += `📉 Total Losses: <b>${parseFloat(stats.totalLosses).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n\n`;

        // Add per-token breakdown if available
        if (Object.keys(stats.perTokenStats).length > 0) {
          message += `<b>Per-Token Breakdown:</b>\n`;
          Object.values(stats.perTokenStats).forEach(tokenStat => {
            message += `\n🪙 <b>${tokenStat.symbol}</b> (${tokenStat.network})\n`;
            message += `   Flips: ${tokenStat.flips} | Win Rate: ${tokenStat.winRate}%\n`;
            message += `   Wagered: ${tokenStat.wagered.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
            message += `   Earned: ${tokenStat.earned.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Home', 'back_to_home')],
          ]).reply_markup,
        });
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error showing stats', error);
        await ctx.answerCbQuery('❌ Error loading statistics');
      }
    });

    // Handle start flip button from dashboard
    bot.action('start_flip_action', async (ctx) => {
      try {
        await ctx.editMessageText(
          `ℹ️ <b>Start a Flip in a Group</b>\n\n` +
          `Coin flips can only be initiated in groups.\n\n` +
          `Create or find a group and use /flip to start a game!\n\n` +
          `Once you post a flip in a group, other members can challenge you.`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🏠 Home', 'back_to_home')],
            ]).reply_markup,
          }
        );
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error in start flip action', error);
        await ctx.answerCbQuery('❌ Error');
      }
    });



    // Handle back to home button
    bot.action('back_to_home', async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;

        const userProfile = await models.UserProfile.findByPk(userId);
        const stats = await DatabaseUtils.getEnhancedUserStats(userId);
        
        let dashboardMsg = `🏠 <b>Coin Flip Dashboard</b>\n\n`;
        
        if (stats.totalFlips > 0) {
          dashboardMsg += `<b>Quick Stats:</b>\n`;
          dashboardMsg += `📊 Flips: ${stats.totalFlips} | Win Rate: ${stats.winRate}%\n`;
          dashboardMsg += `💰 Earnings: ${parseFloat(stats.totalEarnings).toLocaleString('en-US', { maximumFractionDigits: 4 })}\n\n`;
        } else {
          dashboardMsg += `Welcome! Ready to start flipping? 🪙\n\n`;
        }

        dashboardMsg += `🌐 <b>Wallets Configured:</b>\n`;
        dashboardMsg += userProfile?.evmWalletAddress ? `✅ EVM Receive Wallet\n` : `❌ EVM Receive Wallet\n`;
        dashboardMsg += userProfile?.solanaWalletAddress ? `✅ Solana Receive Wallet\n` : `❌ Solana Receive Wallet\n`;
        dashboardMsg += `\n<b>Ready to play?</b> Use the buttons below to get started!`;

        await ctx.editMessageText(
          dashboardMsg,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback('💳 Wallets', 'open_wallet_menu'),
                Markup.button.callback('📊 My Stats', 'show_stats'),
              ],
              [
                Markup.button.callback('🪙 Start Flip', 'start_flip_action'),
                Markup.button.callback('❓ Help', 'show_help_action'),
              ],
            ]).reply_markup,
          }
        );
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error going back to home', error);
        await ctx.answerCbQuery('❌ Error returning home');
      }
    });

    // Handle help button callback
    bot.action('show_help_action', async (ctx) => {
      try {
        await handlers.help(ctx);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error showing help from button', error);
        await ctx.answerCbQuery('❌ Error loading help');
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
    console.log('[HANDLER] /start called');
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

          // Delete the original challenge message and any expired notice
          if (flip.groupChatId && ctx.telegram) {
            // Check both old and new storage formats
            const groupMsgId = flip.data?.groupMessageId || flip.groupMessageId;
            const expiredMsgId = flip.data?.expiredNoticeMessageId;
            
            logger.info('[accept_deeplink] Attempting to delete challenge messages', { 
              flipId, 
              groupChatId: flip.groupChatId,
              groupMsgId,
              expiredMsgId
            });
            
            if (groupMsgId) {
              await deleteGroupMessage(ctx.telegram, flip.groupChatId, groupMsgId);
            }
            if (expiredMsgId) {
              await deleteGroupMessage(ctx.telegram, flip.groupChatId, expiredMsgId);
            }
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

          // Check if user has both required wallet addresses in their profile
          const userProfile = await models.UserProfile.findByPk(userId);
          const receiveWalletField = flip.tokenNetwork === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
          const depositWalletField = flip.tokenNetwork === 'EVM' ? 'evmDepositWalletAddress' : 'solanaDepositWalletAddress';
          
          const receiveWallet = userProfile?.[receiveWalletField];
          const depositWallet = userProfile?.[depositWalletField];

          if (receiveWallet && depositWallet) {
            // Both wallets are set - use them and show deposit instructions
            flip.challengerDepositWalletAddress = depositWallet;
            await flip.save();

            logger.info('[start] Using stored wallets for challenger', { flipId, network: flip.tokenNetwork });

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
                  [Markup.button.callback('✅ I Sent the Deposit', `deposit_confirmed_${flipId}`)],
                ]).reply_markup,
              }
            );
          } else {
            // Missing one or both wallets - ask user to set them up
            confirmSession.currentStep = 'AWAITING_WALLET_ADDRESS';
            await confirmSession.save();

            logger.info('[start] Missing wallets for challenger, asking to set up', { flipId, network: flip.tokenNetwork, hasReceive: !!receiveWallet, hasDeposit: !!depositWallet });

            await ctx.reply(
              `❌ <b>Setup Complete Wallet Configuration</b>\n\n` +
              `Before you can play, you need to set up both:\n` +
              `${receiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
              `${depositWallet ? '✅' : '❌'} <b>Deposit Wallet:</b> Where you send deposits from\n\n` +
              `Configure your wallets to continue:`,
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.callback('💳 Configure Wallets', 'open_wallet_menu')],
                ]).reply_markup,
              }
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

            // Check if user has both required wallet addresses in their profile
            const userProfile = await models.UserProfile.findByPk(userId);
            const receiveWalletField = flip.tokenNetwork === 'EVM' ? 'evmWalletAddress' : 'solanaWalletAddress';
            const depositWalletField = flip.tokenNetwork === 'EVM' ? 'evmDepositWalletAddress' : 'solanaDepositWalletAddress';
            
            const receiveWallet = userProfile?.[receiveWalletField];
            const depositWallet = userProfile?.[depositWalletField];
            const storedWallet = depositWallet; // For backward compatibility in naming

            if (receiveWallet && depositWallet) {
              // Both wallets are set - use them and show deposit instructions
              flip.challengerDepositWalletAddress = depositWallet;
              await flip.save();

              logger.info('[start] Using stored wallets for challenger', { flipId: flip.id, network: flip.tokenNetwork });

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
              // Missing one or both wallets - ask user to set them up
              session.currentStep = 'AWAITING_WALLET_ADDRESS';
              await session.save();

              logger.info('[start] Missing wallets for challenger, asking to set up', { sessionId, network: flip.tokenNetwork, hasReceive: !!receiveWallet, hasDeposit: !!depositWallet });

              await ctx.reply(
                `❌ <b>Setup Complete Wallet Configuration</b>\n\n` +
                `Before you can play, you need to set up both:\n` +
                `${receiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
                `${depositWallet ? '✅' : '❌'} <b>Deposit Wallet:</b> Where you send deposits from\n\n` +
                `Configure your wallets to continue:`,
                {
                  parse_mode: 'HTML',
                  reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Configure Wallets', 'open_wallet_menu')],
                  ]).reply_markup,
                }
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
            // Check if user has BOTH required wallet addresses
            const userProfile = await models.UserProfile.findByPk(userId);
            const receiveWalletField = 'evmWalletAddress'; // For receiving winnings
            const depositWalletField = 'evmDepositWalletAddress'; // For sending deposits
            
            // No need to check network-specific here - user needs both for any flip
            const hasReceiveWallet = userProfile?.evmWalletAddress || userProfile?.solanaWalletAddress;
            const hasDepositWallet = userProfile?.evmDepositWalletAddress || userProfile?.solanaDepositWalletAddress;
            
            if (!hasReceiveWallet || !hasDepositWallet) {
              // Missing wallets - prompt to set up
              logger.info('[flip_deeplink] Missing wallets, redirecting to wallet setup', {
                sessionId,
                hasReceive: !!hasReceiveWallet,
                hasDeposit: !!hasDepositWallet
              });

              await ctx.reply(
                `❌ <b>Setup Complete Wallet Configuration</b>\n\n` +
                `Before you can play, you need to set up both:\n` +
                `${hasReceiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
                `${hasDepositWallet ? '✅' : '❌'} <b>Deposit Wallet:</b> Where you send deposits from\n\n` +
                `Configure your wallets to continue:`,
                {
                  parse_mode: 'HTML',
                  reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Configure Wallets', 'open_wallet_menu')],
                  ]).reply_markup,
                }
              );
              return;
            }

            // Delete the original "Start a Coin Flip!" message from the group
            logger.info('[flip_deeplink] Attempting to delete initial message', {
              sessionId,
              hasMessageId: !!session.data?.initialGroupMessageId,
              hasGroupId: !!session.data?.groupId,
              messageId: session.data?.initialGroupMessageId,
              groupId: session.data?.groupId
            });
            
            if (session.data?.initialGroupMessageId && session.data?.groupId) {
              await deleteGroupMessage(ctx.telegram, session.data.groupId, session.data.initialGroupMessageId);
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
      
      // Check if user has BOTH required wallet addresses
      const userProfile = await models.UserProfile.findByPk(userId);
      const hasReceiveWallet = userProfile?.evmWalletAddress || userProfile?.solanaWalletAddress;
      const hasDepositWallet = userProfile?.evmDepositWalletAddress || userProfile?.solanaDepositWalletAddress;
      
      if (!hasReceiveWallet || !hasDepositWallet) {
        // Missing wallets - prompt to set up
        await ctx.reply(
          `❌ <b>Setup Complete Wallet Configuration</b>\n\n` +
          `Before you can start playing, you need to set up both:\n` +
          `${hasReceiveWallet ? '✅' : '❌'} <b>Receive Wallet:</b> Where your winnings go\n` +
          `${hasDepositWallet ? '✅' : '❌'} <b>Deposit Wallet:</b> Where you send deposits from\n\n` +
          `Configure your wallets to continue:`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('💳 Configure Wallets', 'open_wallet_menu')],
            ]).reply_markup,
          }
        );
        return;
      }
      
      // User already has wallets - show dashboard
      // userProfile is already loaded from the check above
      if (!userProfile) {
        const newProfile = await models.UserProfile.create({ userId });
        await ctx.reply('✅ Wallet profile created!', { parse_mode: 'HTML' });
      }

      // Get user stats for quick display
      const stats = await DatabaseUtils.getEnhancedUserStats(userId);
      
      // Build dashboard message
      let dashboardMsg = `🏠 <b>Coin Flip Dashboard</b>\n\n`;
      
      if (stats.totalFlips > 0) {
        dashboardMsg += `<b>Quick Stats:</b>\n`;
        dashboardMsg += `📊 Flips: ${stats.totalFlips} | Win Rate: ${stats.winRate}%\n`;
        dashboardMsg += `💰 Earnings: ${parseFloat(stats.totalEarnings).toLocaleString('en-US', { maximumFractionDigits: 4 })}\n\n`;
      } else {
        dashboardMsg += `Welcome! Ready to start flipping? 🪙\n\n`;
      }

      dashboardMsg += `🌐 <b>Wallets Configured:</b>\n`;
      
      // Format EVM wallets
      if (userProfile.evmWalletAddress) {
        const evmReceive = userProfile.evmWalletAddress.substring(0, 6) + '...' + userProfile.evmWalletAddress.substring(userProfile.evmWalletAddress.length - 4);
        dashboardMsg += `✅ <b>EVM Receive:</b> <code>${evmReceive}</code>\n`;
      } else {
        dashboardMsg += `❌ <b>EVM Receive:</b> Not set\n`;
      }
      
      if (userProfile.evmDepositWalletAddress) {
        const evmDeposit = userProfile.evmDepositWalletAddress.substring(0, 6) + '...' + userProfile.evmDepositWalletAddress.substring(userProfile.evmDepositWalletAddress.length - 4);
        dashboardMsg += `✅ <b>EVM Send:</b> <code>${evmDeposit}</code>\n`;
      } else {
        dashboardMsg += `❌ <b>EVM Send:</b> Not set\n`;
      }

      dashboardMsg += `\n`;
      
      // Format Solana wallets
      if (userProfile.solanaWalletAddress) {
        const solReceive = userProfile.solanaWalletAddress.substring(0, 6) + '...' + userProfile.solanaWalletAddress.substring(userProfile.solanaWalletAddress.length - 4);
        dashboardMsg += `✅ <b>Solana Receive:</b> <code>${solReceive}</code>\n`;
      } else {
        dashboardMsg += `❌ <b>Solana Receive:</b> Not set\n`;
      }
      
      if (userProfile.solanaDepositWalletAddress) {
        const solDeposit = userProfile.solanaDepositWalletAddress.substring(0, 6) + '...' + userProfile.solanaDepositWalletAddress.substring(userProfile.solanaDepositWalletAddress.length - 4);
        dashboardMsg += `✅ <b>Solana Send:</b> <code>${solDeposit}</code>\n`;
      } else {
        dashboardMsg += `❌ <b>Solana Send:</b> Not set\n`;
      }

      dashboardMsg += `\n<b>Ready to play?</b> Use the buttons below to get started!`;

      await ctx.reply(
        dashboardMsg,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback('💳 Wallets', 'open_wallet_menu'),
              Markup.button.callback('📊 My Stats', 'show_stats'),
            ],
            [
              Markup.button.callback('🪙 Start Flip', 'start_flip_action'),
              Markup.button.callback('❓ Help', 'show_help_action'),
            ],
          ]).reply_markup,
        }
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
    console.log('[HANDLER] /help called');
    try {
      const helpText = 
        `<b>🪙 Coin Flip Bot Help</b>

` +
        `<b>How to Play:</b>
` +
        `1. Use /flip in a group to start a challenge
` +
        `2. Select your token and wager amount in DM
` +
        `3. Bot sends you a deposit address
` +
        `4. Send your wager to that address
` +
        `5. Other members can accept your challenge
` +
        `6. Challenger deposits their wager
` +
        `7. Bot flips a coin - winner takes 90% of the pot!

` +
        `<b>Fee Distribution:</b>
` +
        `🔥 Burn: 5% of pool
` +
        `👨‍💼 Dev: 5% of pool

` +
        `<b>Wallet Setup:</b>
` +
        `For each network (Paxeer & Solana) you need:
` +
        `💰 <b>Receive Wallet</b> - Where your winnings are sent
` +
        `🏦 <b>Sending Wallet</b> - Address you send deposits from
` +
        `(You only need to configure networks you plan to use)

` +
        `<b>Rules:</b>
` +
        `⏱️ 3 minutes to confirm each deposit
` +
        `👥 Both players need complete wallet setup
` +
        `💎 Winner receives 1.8x their wager amount
` +
        `⏳ Wager refunded to the creator if challenge times out
` +
        `🔒 All transactions are recorded on-chain`;

      const replyMarkup = Markup.inlineKeyboard([
        [Markup.button.callback('🏠 Home', 'back_to_home')],
      ]).reply_markup;

      // If called from callback button, edit existing message
      if (ctx.callbackQuery) {
        await ctx.editMessageText(helpText, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
      } else {
        // If called as command, reply with new message
        await ctx.reply(helpText, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
      }
    } catch (error) {
      logger.error('Error in help command', error);
      await ctx.reply('❌ Error displaying help.');
    }
  },

stats: async (ctx) => {
    console.log('[HANDLER] /stats called');
    try {
      const userId = ctx.from.id;
      const stats = await DatabaseUtils.getEnhancedUserStats(userId);

      if (stats.totalFlips === 0) {
        await ctx.reply(
          `📊 <b>Your Stats</b>\n\n` +
          `You haven't completed any flips yet!\n` +
          `Start a flip to begin building your stats.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Format the main stats message
      let message = `📊 <b>Your Game Statistics</b>\n\n`;
      message += `<b>Overall Performance:</b>\n`;
      message += `🎮 Total Flips: <b>${stats.totalFlips}</b>\n`;
      message += `✅ Wins: <b>${stats.wins}</b>\n`;
      message += `❌ Losses: <b>${stats.losses}</b>\n`;
      message += `📈 Win Rate: <b>${stats.winRate}%</b>\n\n`;
      
      message += `<b>Financial Summary:</b>\n`;
      message += `💰 Total Earnings: <b>${parseFloat(stats.totalEarnings).toLocaleString('en-US', { maximumFractionDigits: 6 })} USD</b>\n`;
      message += `📉 Total Losses: <b>${parseFloat(stats.totalLosses).toLocaleString('en-US', { maximumFractionDigits: 6 })} USD</b>\n\n`;

      // Add per-token breakdown if available
      if (Object.keys(stats.perTokenStats).length > 0) {
        message += `<b>Per-Token Breakdown:</b>\n`;
        Object.values(stats.perTokenStats).forEach(tokenStat => {
          message += `\n🪙 <b>${tokenStat.symbol}</b> (${tokenStat.network})\n`;
          message += `   Flips: ${tokenStat.flips} | Win Rate: ${tokenStat.winRate}%\n`;
          message += `   Wagered: ${tokenStat.wagered.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
          message += `   Earned: ${tokenStat.earned.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
        });
      }

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting user stats', error);
      await ctx.reply('❌ Error retrieving statistics.');
    }
  },

  wallet: async (ctx) => {
    console.log('[HANDLER] /wallet called');
    ctx.state.models = getDB().models;
    await WalletHandler.handleWalletCommand(ctx);
  },

  leaderboard: async (ctx) => {
    console.log('[HANDLER] /leaderboard called');
    await LeaderboardHandler.showLeaderboard(ctx);
  },

  dmMessageHandler: async (ctx) => {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const message = ctx.message.text.trim().toLowerCase();

      logger.info('DM message received', { userId, message });

      // Find active session - skip AWAITING_DM_START since it's just waiting for button click, not message input
      const activeSession = await models.BotSession.findOne({
        where: {
          userId,
          currentStep: {
            [Op.ne]: 'AWAITING_DM_START', // Skip transitional states waiting for button click
          },
        },
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
          logger.warn('INITIATING session AWAITING_DEPOSIT: user should click button, not send text message');
          await ctx.reply('⬆️ Please click the button above when you\'ve sent the tokens.');
        } else {
          logger.warn('INITIATING session but unexpected currentStep', { currentStep: activeSession.currentStep });
        }
      } else if (activeSession.sessionType === 'CONFIRMING_DEPOSIT') {
        logger.warn('CONFIRMING_DEPOSIT session: user should click button, not send text message');
        await ctx.reply('⬆️ Please click the button above when you\'ve sent the tokens.');
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
    console.log('[HANDLER] /flip called');
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
        session.changed('data', true); // Mark JSON field as changed for Sequelize
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
    // Handle Telegram conflict error (409) - fail immediately
    if (error.response?.error_code === 409) {
      logger.error('❌ FATAL: Telegram conflict detected (409) - another bot instance is already running!', { 
        error: error.response?.description 
      });
      logger.error('Please stop the other instance and try again.');
      process.exit(1);
    }
    
    // All other errors: exit
    logger.error('Fatal error', error);
    process.exit(1);
  }
}

module.exports = { initBot, bot };

// Run if this is the main module
if (require.main === module) {
  main();
}
