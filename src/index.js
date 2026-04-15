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
const ProfitShareHandler = require('./handlers/profitShareHandler');
const WalletHandler = require('./handlers/walletHandler');
const LeaderboardHandler = require('./handlers/leaderboardHandler');
const DatabaseUtils = require('./database/utils');
const logger = require('./utils/logger');
const { validateConfig, formatNetworkName, getVideoDuration } = require('./utils/helpers');
const { setDepositTimeout, clearDepositTimeout, depositTimeouts } = require('./utils/depositTimeout');
const botState = require('./utils/botState');

/**
 * Get token symbol from EVM token address, looking up config.supportedTokens
 */
function getTokenSymbol(tokenAddress) {
  if (!tokenAddress) return 'Token';
  const supportedTokens = config.supportedTokens;
  for (const key in supportedTokens) {
    if (supportedTokens[key].address?.toLowerCase() === tokenAddress.toLowerCase()) {
      return supportedTokens[key].symbol;
    }
  }
  // Truncate unknown address for display
  if (tokenAddress.startsWith('0x') && tokenAddress.length > 10) {
    return `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
  }
  return 'Token';
}

/**
 * Validate EVM token address format
 */
function isValidMintAddress(tokenAddress) {
  if (!tokenAddress) return false;
  if (tokenAddress === 'NATIVE') return true;
  return /^0x[0-9a-fA-F]{40}$/.test(tokenAddress);
}

let bot;
let sessionStore = {};
let challengeTimeouts = {}; // Store challenge acceptance timeouts by flipId
let initiatingTimeouts = {}; // Store expiry timeouts for INITIATING group cards by sessionId
let botInitialized = false; // Guard to prevent re-initializing bot on retries

/**
 * Set an expiry timeout for the initial "Start in DM" group card.
 * If the creator never deposits within 5 minutes, edit the card to show it expired.
 */
function setInitiatingTimeout(sessionId, groupId, messageId, telegram) {
  if (initiatingTimeouts[sessionId]) {
    clearTimeout(initiatingTimeouts[sessionId]);
  }

  initiatingTimeouts[sessionId] = setTimeout(async () => {
    try {
      const { models } = getDB();
      const session = await models.BotSession.findByPk(sessionId);

      // Only clean up if no flip was ever created from this session
      if (session && !session.coinFlipId && session.currentStep === 'AWAITING_DM_START') {
        logger.info('[initiating-timeout] Expiring unclaimed flip card', { sessionId, groupId, messageId });

        // Edit the group card to show it expired
        try {
          await telegram.editMessageCaption(
            groupId,
            messageId,
            null,
            `⏰ <b>Flip Expired</b>\n\nNo one started this flip in time.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
          );
        } catch (editErr) {
          // Fallback: text-only message — try editMessageText instead
          try {
            await telegram.editMessageText(
              groupId,
              messageId,
              null,
              `⏰ <b>Flip Expired</b>\n\nNo one started this flip in time.`,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
            );
          } catch (_) {
            // Last resort — delete it
            try { await telegram.deleteMessage(groupId, messageId); } catch (__) { /* ignore */ }
          }
        }

        // Mark the session as expired
        session.currentStep = 'EXPIRED';
        session.changed('data', true);
        await session.save();
      }
    } catch (err) {
      logger.error('[initiating-timeout] Error expiring initiating card', { sessionId, error: err.message });
    } finally {
      delete initiatingTimeouts[sessionId];
    }
  }, 5 * 60 * 1000); // 5 minutes
}

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
                // Send DM to creator notifying them the challenge expired
                try {
                  await telegram.sendMessage(
                    flipCheck.creatorId,
                    `⏰ <b>Your Challenge Expired</b>\n\n` +
                    `No one accepted your challenge for <b>${formattedWager} ${flipCheck.tokenSymbol}</b> within 4 minutes.\n\n` +
                    `Your deposit is being refunded to your wallet. Would you like to start a new challenge?`,
                    {
                      parse_mode: 'HTML',
                      reply_markup: Markup.inlineKeyboard([
                        [Markup.button.url('🪙 Start New Challenge', deeplink)],
                      ]).reply_markup,
                    }
                  );
                  logger.info('[challengeTimeout] Sent expiry DM to creator', { flipId, creatorId: flipCheck.creatorId });
                } catch (dmErr) {
                  logger.warn('[challengeTimeout] Failed to send expiry DM to creator', { flipId, creatorId: flipCheck.creatorId, error: dmErr.message });
                }
              } catch (msgErr) {
                logger.error('[challengeTimeout] Failed to send expiration message', { flipId, error: msgErr.message });
              }

              // Refund creator's deposit in background — tx.wait() can block for a long time
              // so we fire-and-forget after the message is already sent
              (async () => {
                try {
                  const creator = await models.User.findByPk(flipCheck.creatorId);
                  const creatorProfile = await models.UserProfile.findByPk(flipCheck.creatorId);
                  const profileDepositWallet = creatorProfile?.evmDepositWalletAddress;
                  const creatorDepositWallet = flipCheck.creatorDepositWalletAddress || profileDepositWallet;
                  const refundAmount = flipCheck.creatorAccumulatedDeposit || flipCheck.wagerAmount;

                  if (creator && creatorDepositWallet) {
                    const blockchainManager = getBlockchainManager();
                    const tokenAddress = flipCheck.tokenAddress || 'NATIVE';
                    const tokenDecimals = flipCheck.tokenDecimals || 18;

                    const txHash = await blockchainManager.sendWinnings(
                      flipCheck.tokenNetwork,
                      tokenAddress,
                      creatorDepositWallet,
                      refundAmount,
                      tokenDecimals
                    );

                    logger.info('[challengeTimeout] Refunded creator deposit to original wallet', {
                      flipId,
                      creatorId: flipCheck.creatorId,
                      depositWallet: creatorDepositWallet,
                      amount: refundAmount,
                      token: flipCheck.tokenSymbol,
                      txHash,
                    });
                  } else {
                    logger.warn('[challengeTimeout] Creator or deposit wallet missing for refund', {
                      flipId,
                      creatorId: flipCheck.creatorId,
                      hasDepositWallet: !!creatorDepositWallet,
                    });
                  }
                } catch (refundErr) {
                  logger.error('[challengeTimeout] Error processing creator refund', { flipId, error: refundErr.message });
                }
              })().catch(err => logger.error('[challengeTimeout] Unhandled error in background refund', { flipId, error: err.message }));
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
// In-memory set to prevent duplicate concurrent deposit verifications for the same flip.
// Guards against the user tapping the button multiple times while a verification is already running,
// which would spawn parallel Paxscan request chains and trigger rate-limiting.
const pendingVerifications = new Set();

/**
 * Idempotent enqueue for automatic refunds — deduped by the deposit txHash.
 * Safe to call fire-and-forget (.catch is handled internally for non-critical paths).
 */
async function enqueueRefund({ txHash, network, tokenAddress, amount, senderAddress, reason, flipId = null }) {
  const { models } = getDB();
  const [, created] = await models.PendingRefund.findOrCreate({
    where: { txHash },
    defaults: { network, tokenAddress, amount, senderAddress, reason, flipId },
  });
  if (created) {
    logger.info('[enqueueRefund] Queued refund', { txHash, senderAddress, amount, reason, flipId });
  } else {
    logger.debug('[enqueueRefund] Already queued (dedup)', { txHash, reason });
  }
}

/**
 * Look up ERC20 token decimals.
 * Checks SUPPORTED_TOKENS config first, then falls back to an on-chain call.
 */
async function getRefundTokenDecimals(network, tokenAddress) {
  if (!tokenAddress || tokenAddress === 'NATIVE') return 18;
  const tokens = config.supportedTokens || {};
  for (const key of Object.keys(tokens)) {
    if (tokens[key].address?.toLowerCase() === tokenAddress.toLowerCase()) {
      return tokens[key].decimals ?? 18;
    }
  }
  if (network === 'EVM') {
    try {
      const blockchainManager = getBlockchainManager();
      const handler = blockchainManager.getHandler('EVM');
      const { ethers } = require('ethers');
      const contract = new ethers.Contract(tokenAddress, ['function decimals() view returns (uint8)'], handler.provider);
      return Number(await contract.decimals());
    } catch (_) { /* fall through */ }
  }
  return 6; // safe default — all Paxeer ERC20s use 6 decimals
}

/**
 * Background worker: drains the PendingRefund queue every 60 s.
 * Processes up to 5 refunds per tick, one at a time to avoid EVM nonce collisions.
 * Uses a setTimeout chain (not setInterval) so the next tick never starts before the current one finishes.
 */
function startRefundWorker() {
  const { Op } = require('sequelize');

  const tick = async () => {
    try {
      const { models } = getDB();
      const pending = await models.PendingRefund.findAll({
        where: { status: 'PENDING', attempts: { [Op.lt]: 5 } },
        order: [['createdAt', 'ASC']],
        limit: 5,
      });

      for (const refund of pending) {
        // Mark as PROCESSING so a concurrent worker won't pick it up
        await refund.update({ status: 'PROCESSING', attempts: refund.attempts + 1 });
        try {
          const decimals = await getRefundTokenDecimals(refund.network, refund.tokenAddress);
          const blockchainManager = getBlockchainManager();
          const result = await blockchainManager.sendWinnings(
            refund.network,
            refund.tokenAddress,
            refund.senderAddress,
            parseFloat(refund.amount),
            decimals,
          );
          await refund.update({ status: 'REFUNDED', refundTxHash: result?.txHash || null });
          logger.info('[refundWorker] Refund sent', {
            id: refund.id, origTxHash: refund.txHash, refundTx: result?.txHash,
            senderAddress: refund.senderAddress, amount: refund.amount, reason: refund.reason,
          });
        } catch (err) {
          const isFinal = refund.attempts >= 5;
          await refund.update({ status: isFinal ? 'FAILED' : 'PENDING', errorMessage: err.message });
          logger.error('[refundWorker] Refund attempt failed', {
            id: refund.id, attempt: refund.attempts, error: err.message, final: isFinal,
          });
        }
      }

      if (pending.length > 0) {
        logger.info('[refundWorker] Processed batch', { count: pending.length });
      }
    } catch (err) {
      logger.error('[refundWorker] Tick error', { error: err.message });
    }
    setTimeout(tick, 60_000);
  };

  tick();
  logger.info('[refundWorker] Started — polling every 60s');
}

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
    
    if (!evmWallet || evmWallet === '0x' || evmWallet === 'undefined') {
      throw new Error('Failed to derive EVM bot wallet - check EVM_PRIVATE_KEY environment variable');
    }

    console.log('✅ Bot wallets validated');
    console.log(`   EVM wallet: ${evmWallet}`);

    // Initialize database
    console.log('Initializing database...');
    await initDB();

    // Restore sleep state persisted before the last restart
    try {
      const { models: startupModels } = getDB();
      const sleepSetting = await startupModels.BotSetting.findByPk('bot_asleep');
      if (sleepSetting && sleepSetting.value === 'true') {
        botState.asleep = true;
        logger.info('[startup] Restored sleep state — bot is asleep');
      }
    } catch (e) { /* non-critical */ }

    // Start the background refund worker (processes PendingRefund queue every 60s)
    startRefundWorker();

    // Create bot instance
    console.log('Creating Telegraf instance...');
    try {
      bot = new Telegraf(config.telegram.token, { handlerTimeout: Infinity });
      console.log('✅ Telegraf instance created');
    } catch (err) {
      console.error('❌ Failed to create Telegraf instance:', err);
      throw err;
    }

    // Set up bot commands menu
    console.log('Setting up commands menu...');
    try {
      // Group chats: only commands that work in a group context
      await bot.telegram.setMyCommands([
        { command: 'flip', description: '🪙 Start a coin flip' },
        { command: 'leaderboard', description: '🏆 Top winners and losers' },
        { command: 'shame', description: '😂 Shame a click-without-funds offender' },
        { command: 'wallofshame', description: '🏴 Hall of shame — serial click-without-funds offenders' },
      ], { scope: { type: 'all_group_chats' } });

      // Private/DM chats: full command list
      await bot.telegram.setMyCommands([
        { command: 'start', description: '🎲 Start the bot' },
        { command: 'help', description: '❓ How to play' },
        { command: 'stats', description: '📊 Your game statistics' },
        { command: 'flip', description: '🪙 Start a coin flip' },
        { command: 'wallet', description: '💳 Manage wallet addresses' },
        { command: 'leaderboard', description: '🏆 Top winners and losers' },
        { command: 'shame', description: '😂 Shame a click-without-funds offender' },
        { command: 'wallofshame', description: '🏴 Hall of shame — serial click-without-funds offenders' },
      ], { scope: { type: 'all_private_chats' } });

      console.log('✅ Commands menu set');
    } catch (err) {
      console.error('❌ Failed to set commands menu:', err);
      throw err;
    }

    // Global error handler: prevents unhandled update errors from propagating to bot.launch()
    // and crashing the process. Falls back to the middleware errorHandler for user-facing messages.
    bot.catch((error, ctx) => {
      logger.error('[bot.catch] Unhandled error in update processing', {
        error: error.message,
        name: error.name,
        update_id: ctx.update?.update_id,
      });
    });

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
    console.log('[CMD] Registering /shame');
    bot.command('shame', handlers.shame);
    console.log('[CMD] Registering /wallofshame');
    bot.command('wallofshame', handlers.wallofshame);
    console.log('✅ Commands registered successfully');

    // Admin commands
    AdminHandler.registerCommands(bot);

    // Start $FLIP profit share 24h distribution scheduler
    ProfitShareHandler.startScheduler(bot);

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
        flip.changed('data', true);
        await flip.save();

        // Send expiration notice to group
        try {
          const botInfo = await bot.telegram.getMe();
          const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
          const newFlipSession = await models.BotSession.create({
            userId: flip.creatorId,
            sessionType: 'INITIATING',
            currentStep: 'AWAITING_DM_START',
            data: { groupId: flip.groupChatId },
          });
          const deeplink = `https://t.me/${botInfo.username}?start=flip_${newFlipSession.id}`;
          const expiredMsg = await bot.telegram.sendMessage(
            flip.groupChatId,
            `⏰ <b>Challenge Expired</b>\n\n` +
            `No one accepted the challenge for <b>${formattedWager} ${flip.tokenSymbol}</b>.\n` +
            `Funds have been refunded to the creator.\n\n` +
            `Would you like to start a new challenge?`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.url('🪙 Start a Challenge', deeplink)],
              ]).reply_markup,
            }
          );
          flip.data = { ...flip.data, expiredNoticeMessageId: expiredMsg.message_id };
          flip.changed('data', true);
          await flip.save();
          // Send DM to creator notifying them the challenge expired
          try {
            await bot.telegram.sendMessage(
              flip.creatorId,
              `⏰ <b>Your Challenge Expired</b>\n\n` +
              `No one accepted your challenge for <b>${formattedWager} ${flip.tokenSymbol}</b> within 4 minutes.\n\n` +
              `Your deposit is being refunded to your wallet. Would you like to start a new challenge?`,
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.url('🪙 Start New Challenge', deeplink)],
                ]).reply_markup,
              }
            );
            logger.info('[startup] Sent expiry DM to creator', { flipId: flip.id, creatorId: flip.creatorId });
          } catch (dmErr) {
            logger.warn('[startup] Failed to send expiry DM to creator', { flipId: flip.id, creatorId: flip.creatorId, error: dmErr.message });
          }
        } catch (msgErr) {
          logger.error('[startup] Failed to send expiration message', { flipId: flip.id, error: msgErr.message });
        }

        // Refund creator's deposit in background
        (async () => {
          try {
            const creator = await models.User.findByPk(flip.creatorId);
            const creatorProfile = await models.UserProfile.findByPk(flip.creatorId);
            const profileDepositWallet = creatorProfile?.evmDepositWalletAddress;
            const creatorDepositWallet = flip.creatorDepositWalletAddress || profileDepositWallet;
            const refundAmount = flip.creatorAccumulatedDeposit || flip.wagerAmount;
            if (creator && creatorDepositWallet) {
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
              const txHash = await blockchainManager.sendWinnings(flip.tokenNetwork, tokenAddress, creatorDepositWallet, refundAmount, tokenDecimals);
              logger.info('[startup] Refunded creator deposit', { flipId: flip.id, creatorId: flip.creatorId, depositWallet: creatorDepositWallet, amount: refundAmount, txHash });
            } else {
              logger.warn('[startup] Creator or deposit wallet missing for refund', { flipId: flip.id, hasDepositWallet: !!flip.creatorDepositWalletAddress });
            }
          } catch (refundErr) {
            logger.error('[startup] Error processing creator refund', { flipId: flip.id, error: refundErr.message });
          }
        })().catch(err => logger.error('[startup] Unhandled error in background refund', { flipId: flip.id, error: err.message }));
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
              flipCheck.changed('data', true);
              await flipCheck.save();

              // Send expiration notice to group
              try {
                const botInfo = await bot.telegram.getMe();
                const formattedWager = parseFloat(flipCheck.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
                const newFlipSession = await models.BotSession.create({
                  userId: flipCheck.creatorId,
                  sessionType: 'INITIATING',
                  currentStep: 'AWAITING_DM_START',
                  data: { groupId: flipCheck.groupChatId },
                });
                const deeplink = `https://t.me/${botInfo.username}?start=flip_${newFlipSession.id}`;
                const expiredMsg = await bot.telegram.sendMessage(
                  flipCheck.groupChatId,
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
                flipCheck.data = { ...flipCheck.data, expiredNoticeMessageId: expiredMsg.message_id };
                flipCheck.changed('data', true);
                await flipCheck.save();
                // Send DM to creator notifying them the challenge expired
                try {
                  await bot.telegram.sendMessage(
                    flipCheck.creatorId,
                    `⏰ <b>Your Challenge Expired</b>\n\n` +
                    `No one accepted your challenge for <b>${formattedWager} ${flipCheck.tokenSymbol}</b> within 4 minutes.\n\n` +
                    `Your deposit is being refunded to your wallet. Would you like to start a new challenge?`,
                    {
                      parse_mode: 'HTML',
                      reply_markup: Markup.inlineKeyboard([
                        [Markup.button.url('🪙 Start New Challenge', deeplink)],
                      ]).reply_markup,
                    }
                  );
                  logger.info('[startup-timeout] Sent expiry DM to creator', { flipId: flip.id, creatorId: flipCheck.creatorId });
                } catch (dmErr) {
                  logger.warn('[startup-timeout] Failed to send expiry DM to creator', { flipId: flip.id, creatorId: flipCheck.creatorId, error: dmErr.message });
                }
              } catch (msgErr) {
                logger.error('[startup-timeout] Failed to send expiration message', { flipId: flip.id, error: msgErr.message });
              }

              // Refund creator's deposit in background
              (async () => {
                try {
                  const creator = await models.User.findByPk(flipCheck.creatorId);
                  const creatorProfile = await models.UserProfile.findByPk(flipCheck.creatorId);
                  const profileDepositWallet = creatorProfile?.evmDepositWalletAddress;
                  const creatorDepositWallet = flipCheck.creatorDepositWalletAddress || profileDepositWallet;
                  const refundAmount = flipCheck.creatorAccumulatedDeposit || flipCheck.wagerAmount;
                  if (creator && creatorDepositWallet) {
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
                    const txHash = await blockchainManager.sendWinnings(flipCheck.tokenNetwork, tokenAddress, creatorDepositWallet, refundAmount, tokenDecimals);
                    logger.info('[startup-timeout] Refunded creator deposit', { flipId: flip.id, creatorId: flipCheck.creatorId, depositWallet: creatorDepositWallet, amount: refundAmount, txHash });
                  } else {
                    logger.warn('[startup-timeout] Creator or deposit wallet missing for refund', { flipId: flip.id, hasDepositWallet: !!flipCheck.creatorDepositWalletAddress });
                  }
                } catch (refundErr) {
                  logger.error('[startup-timeout] Error processing creator refund', { flipId: flip.id, error: refundErr.message });
                }
              })().catch(err => logger.error('[startup-timeout] Unhandled error in background refund', { flipId: flip.id, error: err.message }));
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
                    flipFinal.changed('data', true);
                    await flipFinal.save();

                    // Send expiration notice to group
                    try {
                      const botInfo = await bot.telegram.getMe();
                      const formattedWager = parseFloat(flipFinal.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
                      const newFlipSession = await models.BotSession.create({
                        userId: flipFinal.creatorId,
                        sessionType: 'INITIATING',
                        currentStep: 'AWAITING_DM_START',
                        data: { groupId: flipFinal.groupChatId },
                      });
                      const deeplink = `https://t.me/${botInfo.username}?start=flip_${newFlipSession.id}`;
                      const expiredMsg = await bot.telegram.sendMessage(
                        flipFinal.groupChatId,
                        `⏰ <b>Challenge Expired</b>\n\n` +
                        `No one accepted the challenge for <b>${formattedWager} ${flipFinal.tokenSymbol}</b>.\n` +
                        `Funds have been refunded to the creator.\n\n` +
                        `Would you like to start a new challenge?`,
                        {
                          parse_mode: 'HTML',
                          reply_markup: Markup.inlineKeyboard([
                            [Markup.button.url('🪙 Start a Challenge', deeplink)],
                          ]).reply_markup,
                        }
                      );
                      flipFinal.data = { ...flipFinal.data, expiredNoticeMessageId: expiredMsg.message_id };
                      flipFinal.changed('data', true);
                      await flipFinal.save();
                      // Send DM to creator notifying them the challenge expired
                      try {
                        await bot.telegram.sendMessage(
                          flipFinal.creatorId,
                          `⏰ <b>Your Challenge Expired</b>\n\n` +
                          `No one accepted your challenge for <b>${formattedWager} ${flipFinal.tokenSymbol}</b> within 4 minutes.\n\n` +
                          `Your deposit is being refunded to your wallet. Would you like to start a new challenge?`,
                          {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                              [Markup.button.url('🪙 Start New Challenge', deeplink)],
                            ]).reply_markup,
                          }
                        );
                        logger.info('[startup-timeout] Sent expiry DM to creator', { flipId: flip.id, creatorId: flipFinal.creatorId });
                      } catch (dmErr) {
                        logger.warn('[startup-timeout] Failed to send expiry DM to creator', { flipId: flip.id, creatorId: flipFinal.creatorId, error: dmErr.message });
                      }
                    } catch (msgErr) {
                      logger.error('[startup-timeout] Failed to send expiration message', { flipId: flip.id, error: msgErr.message });
                    }

                    // Refund creator's deposit in background
                    (async () => {
                      try {
                        const creator = await models.User.findByPk(flipFinal.creatorId);
                        const creatorProfile = await models.UserProfile.findByPk(flipFinal.creatorId);
                        const profileDepositWallet = creatorProfile?.evmDepositWalletAddress;
                        const creatorDepositWallet = flipFinal.creatorDepositWalletAddress || profileDepositWallet;
                        const refundAmount = flipFinal.creatorAccumulatedDeposit || flipFinal.wagerAmount;
                        if (creator && creatorDepositWallet) {
                          const blockchainManager = getBlockchainManager();
                          const supportedTokens = config.supportedTokens;
                          let tokenAddress = 'NATIVE';
                          let tokenDecimals = 18;
                          for (const key in supportedTokens) {
                            if (supportedTokens[key].symbol === flipFinal.tokenSymbol && supportedTokens[key].network === flipFinal.tokenNetwork) {
                              tokenAddress = supportedTokens[key].address || 'NATIVE';
                              tokenDecimals = supportedTokens[key].decimals || 18;
                              break;
                            }
                          }
                          const txHash = await blockchainManager.sendWinnings(flipFinal.tokenNetwork, tokenAddress, creatorDepositWallet, refundAmount, tokenDecimals);
                          logger.info('[startup-timeout] Refunded creator deposit', { flipId: flip.id, creatorId: flipFinal.creatorId, depositWallet: creatorDepositWallet, amount: refundAmount, txHash });
                        } else {
                          logger.warn('[startup-timeout] Creator or deposit wallet missing for refund', { flipId: flip.id, hasDepositWallet: !!flipFinal.creatorDepositWalletAddress });
                        }
                      } catch (refundErr) {
                        logger.error('[startup-timeout] Error processing creator refund', { flipId: flip.id, error: refundErr.message });
                      }
                    })().catch(err => logger.error('[startup-timeout] Unhandled error in background refund', { flipId: flip.id, error: err.message }));
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

    // Restore deposit timeouts for flips waiting on challenger deposit
    const waitingDeposits = await models.CoinFlip.findAll({
      where: { status: 'WAITING_CHALLENGER_DEPOSIT', challengerDepositConfirmed: false },
    });

    const DEPOSIT_TIMEOUT = 3 * 60 * 1000; // 3 minutes

    for (const flip of waitingDeposits) {
      const elapsedTime = now - flip.updatedAt.getTime();

      if (elapsedTime > DEPOSIT_TIMEOUT) {
        // Already expired — cancel immediately
        logger.info('[startup] Auto-cancelling expired challenger deposit', { flipId: flip.id, elapsedSeconds: Math.round(elapsedTime / 1000) });
        flip.challengerTimedOut = true;
        flip.status = 'CANCELLED';
        flip.data = { ...flip.data, cancelReason: 'Challenger deposit expired on bot startup' };
        await flip.save();

        // Refund creator deposit
        if (flip.creatorDepositConfirmed && flip.creatorDepositWalletAddress) {
          try {
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
            await blockchainManager.sendWinnings(flip.tokenNetwork, tokenAddress, flip.creatorDepositWalletAddress, parseFloat(flip.wagerAmount), tokenDecimals);
            logger.info('[startup] Refunded creator deposit for expired challenger', { flipId: flip.id });
          } catch (refundErr) {
            logger.error('[startup] Failed to refund creator deposit', { flipId: flip.id, error: refundErr.message });
          }
        }

        // Notify users
        try {
          const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
          if (flip.creatorId) {
            await bot.telegram.sendMessage(flip.creatorId,
              `⏰ <b>Challenge Cancelled</b>\n\nThe challenger didn't deposit in time. The <b>${formattedWager} ${flip.tokenSymbol}</b> challenge has been cancelled.\n\n💸 Your deposit is being refunded.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          if (flip.challengerId) {
            await bot.telegram.sendMessage(flip.challengerId,
              `⏰ <b>Deposit Timeout</b>\n\nYou didn't deposit in time. The <b>${formattedWager} ${flip.tokenSymbol}</b> challenge has been cancelled.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        } catch (err) {
          logger.warn('[startup] Failed to notify users about expired deposit', { flipId: flip.id, error: err.message });
        }
      } else {
        // Still within timeout window — restore the remaining timeout
        const remainingTime = DEPOSIT_TIMEOUT - elapsedTime;
        logger.info('[startup] Restoring challenger deposit timeout', { flipId: flip.id, remainingMs: Math.round(remainingTime) });
        setDepositTimeout(flip.id, bot.telegram, remainingTime);
      }
    }

    logger.info('[startup] Restored deposit timeouts for waiting challenger deposits', { count: waitingDeposits.length });
    
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

    // Leaderboard callbacks
    bot.action('refresh_leaderboard', async (ctx) => {
      if (ctx.chat.type !== 'private') return ctx.answerCbQuery().catch(() => {});
      try {
        await LeaderboardHandler.refreshLeaderboard(ctx);
      } catch (error) {
        logger.error('Error refreshing leaderboard', error);
        await ctx.answerCbQuery('❌ Error', true);
      }
    });

    // "Start a Challenge" button on expired challenge card — triggers /flip in the same chat
    bot.action('start_flip', async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      await handlers.flip(ctx);
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
          await ctx.answerCbQuery('❌ Session expired.', { show_alert: true });
          return;
        }
        
        // Ensure both are numbers for comparison
        const sessionUserId = parseInt(session.userId);
        const clickingUserId = parseInt(userId);
        
        if (sessionUserId !== clickingUserId) {
          logger.warn('start_flip_dm: unauthorized user clicked button', { sessionId, sessionUserId, clickingUserId });
          await ctx.answerCbQuery('❌ Only the person who started this flip can use this button.', { show_alert: true });
          return;
        }

        // Answer with the deep link so the bot opens in the user's DM
        const botInfo = await ctx.telegram.getMe();
        await ctx.answerCbQuery('Opening Coin Flip...', {
          url: `https://t.me/${botInfo.username}?start=flip_${sessionId}`,
        });
      } catch (error) {
        logger.error('Error starting flip in DM', error);
        await ctx.answerCbQuery('❌ Error', { show_alert: true });
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

      if (flip.status !== 'WAITING_CHALLENGER') {
        await ctx.answerCbQuery(flip.status === 'CANCELLED' ? '❌ This challenge has expired' : '❌ This flip is no longer available');
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
        const receiveWalletField = 'evmWalletAddress';
        const depositWalletField = 'evmDepositWalletAddress';
        
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
                [Markup.button.callback('✅ I Sent the Deposit', `deposit_confirmed_${flipId}`)],
              ]).reply_markup,
            }
          );

          // Set 3-minute deposit timeout for challenger
          setDepositTimeout(flipId, ctx.telegram);

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

            // Start deposit timeout even while user sets up wallets
            setDepositTimeout(flipId, ctx.telegram);
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

        // Guard against verifying deposits on a flip that is no longer active
        if (flip.status !== 'WAITING_CHALLENGER_DEPOSIT') {
          logger.warn('[deposit_confirmed] Flip is not in expected status', { flipId, status: flip.status });
          await ctx.answerCbQuery('❌ This challenge is no longer active');
          return;
        }

        // Prevent duplicate concurrent verification chains for the same flip
        if (pendingVerifications.has(flipId)) {
          logger.info('[deposit_confirmed] Verification already in progress, ignoring duplicate click', { flipId, userId });
          await ctx.answerCbQuery('⏳ Already verifying...');
          return;
        }
        pendingVerifications.add(flipId);

        logger.info('[deposit_confirmed] Verifying challenger deposit', { flipId, userId });
        
        // GET USER'S WALLETS - Both required for flip
        const userProfile = await models.UserProfile.findByPk(userId);
        const receiveWallet = userProfile?.evmWalletAddress;
        const depositWallet = userProfile?.evmDepositWalletAddress;
        
        logger.info('[deposit_confirmed] Wallets loaded from UserProfile', {
          userId,
          network: flip.tokenNetwork,
          receiveWallet,
          depositWallet,
          allProfileData: {
            evmWalletAddress: userProfile?.evmWalletAddress,
            evmDepositWalletAddress: userProfile?.evmDepositWalletAddress,
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
        // Stamp the flip immediately so we know the challenger at least *claimed* to have
        // sent funds. This lets the timeout shame-logic distinguish "never tried" from
        // "tried but bot missed it".
        if (!flip.challengerClaimedDeposit) {
          flip.challengerClaimedDeposit = true;
          await flip.save();
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
          8, // maxRetries
          10000, // retryDelayMs - 10 second delay to account for Paxscan indexing lag
          depositWallet, // Use user's configured deposit wallet
          flip.createdAt, // pass flip creation time to filter old deposits
          flip.creatorDepositWalletAddress || null // exclude creator's wallet from any-sender fallback
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
              // CRITICAL: Use amountDisplay when available (already in display units, e.g. native PAX).
              // Only divide by tokenDecimals for raw-unit amounts.
              const tokenDecimals = flip.tokenDecimals || 18;
              const currentTotalRaw = parseFloat(verification.amount || 0);
              const currentTotal = verification.amountDisplay !== undefined ? verification.amountDisplay : (verification.isWrongToken ? currentTotalRaw : (currentTotalRaw / Math.pow(10, tokenDecimals)));
              flip.challengerAccumulatedDeposit = currentTotal.toString();
              
              logger.info('[deposit_confirmed] Updated challenger accumulated deposit', {
                flipId,
                previousAccumulated,
                currentTotal,
                newDepositsSinceLastCheck: currentTotal - previousAccumulated,
              });
            }
          }
          
          // Enqueue a refund for the wrong token — idempotent via txHash dedup.
          // The background worker will send it back within 60 s.
          if (verification.isWrongToken && verification.depositSender && verification.depositTransaction) {
            enqueueRefund({
              txHash: verification.depositTransaction,
              network: flip.tokenNetwork,
              tokenAddress: verification.wrongToken === 'NATIVE' ? 'NATIVE' : (verification.wrongToken || flip.tokenAddress),
              amount: verification.amountDisplay ?? parseFloat(verification.amount ?? '0'),
              senderAddress: verification.depositSender,
              reason: 'wrong_token',
              flipId: flip.id,
            }).catch(err => logger.error('[deposit_confirmed] Failed to enqueue wrong-token refund', { error: err.message, flipId }));
          }
          
          // Guard: re-fetch flip to check if depositTimeout cancelled it during the long verification window.
          // This prevents showing a "try again" button on an already-cancelled flip.
          const currentFlipState = await models.CoinFlip.findByPk(flipId);
          if (!currentFlipState || currentFlipState.status === 'CANCELLED' || currentFlipState.status === 'COMPLETED') {
            logger.info('[deposit_confirmed] Flip was cancelled during verification, skipping retry prompt', { flipId, status: currentFlipState?.status });
            try { await ctx.editMessageText('❌ This challenge has already been cancelled.', { parse_mode: 'HTML' }); } catch (_) {}
            return;
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
                wrongTokenName = 'PAX (native)';
              } else {
                // Lookup symbol from EVM token address
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
            } else if (verification.unmatchedDeposits?.length > 0) {
              const dep = verification.unmatchedDeposits[0];
              const shortSender = dep.senderAddress ? `${dep.senderAddress.slice(0, 6)}...${dep.senderAddress.slice(-4)}` : 'unknown';
              const depAmount = dep.amount?.toLocaleString('en-US', { maximumFractionDigits: 6 }) ?? '?';
              messageText =
                `⚠️ <b>Deposit from Unregistered Wallet</b>\n\n` +
                `Your deposit of ${depAmount} ${flip.tokenSymbol} was received from <code>${dep.senderAddress || shortSender}</code>, ` +
                `which is not your registered deposit wallet.\n\n` +
                `<b>Your registered deposit wallet:</b>\n<code>${flip.creatorDepositWalletAddress || 'check /wallet'}</code>\n\n` +
                `<b>Status: Automatically refunding to ${shortSender}...</b>\n\n` +
                `Please send from your registered deposit wallet and press the button again.`;
            } else {
              messageText = 
                `❌ <b>Insufficient Deposit</b>\n\n` +
                `Expected: ${formattedExpected} ${flip.tokenSymbol}\n` +
                `Received: ${receivedAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
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
          
          // Enqueue refunds for any correct-token deposits from unregistered wallets (wrong-wallet scenario)
          if (verification.unmatchedDeposits?.length > 0) {
            logger.info('[deposit_confirmed] Enqueueing wrong-wallet refunds', { flipId, count: verification.unmatchedDeposits.length });
            for (const dep of verification.unmatchedDeposits) {
              enqueueRefund({
                txHash: dep.txHash,
                network: flip.tokenNetwork,
                tokenAddress: dep.tokenAddress || flip.tokenAddress,
                amount: dep.amount,
                senderAddress: dep.senderAddress,
                reason: 'wrong_wallet',
                flipId: flip.id,
              }).catch(err => logger.error('[deposit_confirmed] Failed to enqueue wrong-wallet refund', { error: err.message, flipId }));
            }
          }

          return;
        }

        logger.info('[deposit_confirmed] Challenger deposit verified', { flipId, userId, amount: verification.amount });

        // Enqueue refunds for any wrong-wallet deposits detected during verification retries.
        if (verification.unmatchedDeposits?.length > 0) {
          logger.info('[deposit_confirmed] Enqueueing wrong-wallet refunds from earlier retries', { flipId, count: verification.unmatchedDeposits.length });
          for (const dep of verification.unmatchedDeposits) {
            enqueueRefund({
              txHash: dep.txHash,
              network: flip.tokenNetwork,
              tokenAddress: dep.tokenAddress || flip.tokenAddress,
              amount: dep.amount,
              senderAddress: dep.senderAddress,
              reason: 'wrong_wallet',
              flipId: flip.id,
            }).catch(err => logger.error('[deposit_confirmed] Failed to enqueue wrong-wallet refund (success path)', { error: err.message, flipId }));
          }
        }

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
              if (!isValidMintAddress(tokenAddress)) {
                logger.warn('[deposit_confirmed] Skipping excess refund - invalid token address format', { 
                  flipId, 
                  tokenAddress,
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

        // Clear the challenger deposit timeout since deposit is confirmed
        clearDepositTimeout(flipId);

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
          // Re-fetch the flip from DB to guard against a race condition where the
          // depositTimeout fired and set status=CANCELLED between the start of this
          // verification chain and now.  If the flip is no longer active, abort early
          // so we don't send the video or trigger executeFlip (which would otherwise
          // pay out winnings on a flip the timeout already refunded the creator for).
          // executeFlip has its own matching guard as a second line of defence.
          const freshFlip = await models.CoinFlip.findByPk(flipId);
          if (!freshFlip || freshFlip.status === 'CANCELLED' || freshFlip.status === 'COMPLETED') {
            logger.warn('[deposit_confirmed] Flip status changed during verification — aborting to prevent double-payout', {
              flipId,
              status: freshFlip?.status ?? 'not found',
            });
            pendingVerifications.delete(flipId);
            return;
          }

          logger.info('[deposit_confirmed] Both deposits confirmed, executing flip', { flipId });

          // Clear the challenge timeout since flip is now executing
          clearChallengeTimeout(flipId);

          // Send coin flip video to group before revealing result
          let videoMessageId = null;
          let videoReadyAt = null;
          try {
            const fs = require('fs');
            const path = require('path');
            const videoPath = path.join(process.cwd(), 'assets/coinflip.MP4');
            const { models: dbModels } = getDB();
            const SETTING_KEY = 'coinflip_video_file_id';

            // Try to load cached Telegram file_id so we skip the ~2.5 min re-upload
            let videoInput = null;
            try {
              const setting = await dbModels.BotSetting.findByPk(SETTING_KEY);
              if (setting && setting.value) {
                videoInput = setting.value; // reuse file_id — instant send
              }
            } catch (_) { /* ignore DB errors, fall through to upload */ }

            if (!videoInput && fs.existsSync(videoPath)) {
              videoInput = { filename: 'coinflip.MP4', source: fs.createReadStream(videoPath) };
            }

            if (videoInput) {
              const sentMessage = await ctx.telegram.sendVideo(
                flip.groupChatId,
                videoInput,
                {
                  caption: '🎬 <b>EXECUTING FLIP...</b>',
                  parse_mode: 'HTML',
                }
              );
              videoMessageId = sentMessage.message_id;

              // Persist the file_id after a fresh upload so future flips are instant
              const returnedFileId = sentMessage.video?.file_id;
              if (returnedFileId && typeof videoInput !== 'string') {
                try {
                  await dbModels.BotSetting.upsert({ key: SETTING_KEY, value: returnedFileId });
                } catch (_) { /* non-critical */ }
              }

              // Record when the video will finish so executeFlip can sync with it
              const videoDuration = await getVideoDuration(videoPath);
              logger.info('Video duration detected', { flipId, videoDuration });
              videoReadyAt = Date.now() + videoDuration;
            }
          } catch (videoErr) {
            logger.warn('Failed to send flip video', { flipId, error: videoErr.message });
          }

          // Execute the flip — result won't show until video finishes
          await ExecutionHandler.executeFlip(flipId, ctx, videoMessageId, videoReadyAt);
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
      } finally {
        pendingVerifications.delete(ctx.match[1]);
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

        // Guard: only accept deposit confirmation while flip is still awaiting creator deposit
        if (flip.status !== 'WAITING_CREATOR_DEPOSIT') {
          await ctx.answerCbQuery('❌ This flip is no longer active');
          return;
        }

        // Prevent duplicate concurrent verification chains for the same flip
        if (pendingVerifications.has(flipId)) {
          logger.info('[creator_deposit_confirmed] Verification already in progress, ignoring duplicate click', { flipId, userId });
          await ctx.answerCbQuery('⏳ Already verifying...');
          return;
        }
        pendingVerifications.add(flipId);

        logger.info('[creator_deposit_confirmed] Verifying creator deposit', { flipId, userId });
        
        // GET USER'S WALLETS - Both required for flip
        const userProfile = await models.UserProfile.findByPk(userId);
        const receiveWallet = userProfile?.evmWalletAddress;
        const depositWallet = userProfile?.evmDepositWalletAddress;
        
        logger.info('[creator_deposit_confirmed] Wallets loaded from UserProfile', {
          userId,
          network: flip.tokenNetwork,
          receiveWallet,
          depositWallet,
          allProfileData: {
            evmWalletAddress: userProfile?.evmWalletAddress,
            evmDepositWalletAddress: userProfile?.evmDepositWalletAddress,
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

        // Answer the callback query immediately so Telegram's loading spinner clears.
        // The verification below is long-running (up to ~120s) and must not block the
        // Telegraf update handler, which has handlerTimeout: Infinity set above.
        await ctx.answerCbQuery().catch(() => {});

        // Verify deposit on blockchain (with retries for blockchain indexing)
        // Use the user's configured deposit wallet as the knownSender
        const blockchainManager = getBlockchainManager();
        
        const verification = await blockchainManager.verifyDepositWithRetry(
          flip.tokenNetwork,
          flip.tokenAddress,
          flip.wagerAmount,
          flip.tokenDecimals,
          8, // maxRetries
          10000, // retryDelayMs - 10 second delay to account for Paxscan indexing lag
          depositWallet, // Use user's configured deposit wallet
          flip.createdAt, // pass flip creation time to filter old deposits
          flip.challengerDepositWalletAddress || null // exclude challenger's wallet from any-sender fallback
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
              // CRITICAL: Use amountDisplay when available (already in display units, e.g. native PAX).
              // Only divide by tokenDecimals for raw-unit amounts.
              const tokenDecimals = flip.tokenDecimals || 18;
              const currentTotalRaw = parseFloat(verification.amount || 0);
              const currentTotal = verification.amountDisplay !== undefined ? verification.amountDisplay : (verification.isWrongToken ? currentTotalRaw : (currentTotalRaw / Math.pow(10, tokenDecimals)));
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
                wrongTokenName = 'PAX (native)';
              } else {
                // Lookup symbol from EVM token address
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
            } else if (verification.unmatchedDeposits?.length > 0) {
              const dep = verification.unmatchedDeposits[0];
              const shortSender = dep.senderAddress ? `${dep.senderAddress.slice(0, 6)}...${dep.senderAddress.slice(-4)}` : 'unknown';
              const depAmount = dep.amount?.toLocaleString('en-US', { maximumFractionDigits: 6 }) ?? '?';
              messageText =
                `⚠️ <b>Deposit from Unregistered Wallet</b>\n\n` +
                `Your deposit of ${depAmount} ${flip.tokenSymbol} was received from <code>${dep.senderAddress || shortSender}</code>, ` +
                `which is not your registered deposit wallet.\n\n` +
                `<b>Your registered deposit wallet:</b>\n<code>${depositWallet || 'check /wallet'}</code>\n\n` +
                `<b>Status: Automatically refunding to ${shortSender}...</b>\n\n` +
                `Please send from your registered deposit wallet and press the button again.`;
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
          
          // Enqueue a refund for the wrong token — idempotent via txHash dedup.
          // The background worker will send it back within 60 s.
          if (verification.isWrongToken && verification.depositSender && verification.depositTransaction) {
            enqueueRefund({
              txHash: verification.depositTransaction,
              network: flip.tokenNetwork,
              tokenAddress: verification.wrongToken === 'NATIVE' ? 'NATIVE' : (verification.wrongToken || flip.tokenAddress),
              amount: verification.amountDisplay ?? parseFloat(verification.amount ?? '0'),
              senderAddress: verification.depositSender,
              reason: 'wrong_token',
              flipId: flip.id,
            }).catch(err => logger.error('[creator_deposit_confirmed] Failed to enqueue wrong-token refund', { error: err.message, flipId }));
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
          
          // Enqueue refunds for any correct-token deposits from unregistered wallets (wrong-wallet scenario)
          if (verification.unmatchedDeposits?.length > 0) {
            logger.info('[creator_deposit_confirmed] Enqueueing wrong-wallet refunds', { flipId, count: verification.unmatchedDeposits.length });
            for (const dep of verification.unmatchedDeposits) {
              enqueueRefund({
                txHash: dep.txHash,
                network: flip.tokenNetwork,
                tokenAddress: dep.tokenAddress || flip.tokenAddress,
                amount: dep.amount,
                senderAddress: dep.senderAddress,
                reason: 'wrong_wallet',
                flipId: flip.id,
              }).catch(err => logger.error('[creator_deposit_confirmed] Failed to enqueue wrong-wallet refund', { error: err.message, flipId }));
            }
          }

          return;
        }

        logger.info('[creator_deposit_confirmed] Creator deposit verified', { flipId, userId, amount: verification.amount });

        // Enqueue refunds for any wrong-wallet deposits detected during verification retries.
        // These are accumulated by verifyDepositWithRetry across all retry attempts.
        if (verification.unmatchedDeposits?.length > 0) {
          logger.info('[creator_deposit_confirmed] Enqueueing wrong-wallet refunds from earlier retries', { flipId, count: verification.unmatchedDeposits.length });
          for (const dep of verification.unmatchedDeposits) {
            enqueueRefund({
              txHash: dep.txHash,
              network: flip.tokenNetwork,
              tokenAddress: dep.tokenAddress || flip.tokenAddress,
              amount: dep.amount,
              senderAddress: dep.senderAddress,
              reason: 'wrong_wallet',
              flipId: flip.id,
            }).catch(err => logger.error('[creator_deposit_confirmed] Failed to enqueue wrong-wallet refund (success path)', { error: err.message, flipId }));
          }
        }

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
              const tokenAddress = flip.tokenAddress || 'NATIVE';
              const refundDecimals = flip.tokenDecimals || 18;

              // Validate token address before attempting refund
              if (!isValidMintAddress(tokenAddress)) {
                logger.warn('[creator_deposit_confirmed] Skipping excess refund - invalid token address format', { 
                  flipId, 
                  tokenAddress,
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
      } finally {
        pendingVerifications.delete(ctx.match[1]);
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
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `back_to_token_select_${session.id}`)]]).reply_markup,
          }
        );
        
        logger.info('Message edited for wager input');
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error selecting token', { error: error.message, stack: error.stack });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── Custom Token: "Enter Contract Address" button ────────────────────────────
    bot.action(/^custom_token_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        const session = await models.BotSession.findByPk(sessionId);
        if (!session || parseInt(session.userId) !== parseInt(userId)) {
          return ctx.answerCbQuery('❌ Session not found');
        }

        session.currentStep = 'AWAITING_CA';
        await session.save();

        await ctx.editMessageText(
          '🔍 <b>Enter Contract Address</b>\n\n' +
          'Send me the EVM contract address of the token you want to flip.\n\n' +
          'Example: <code>0x86949e4cdb89496490890b67c9cff63ed8efb4b1</code>\n\n' +
          'Must be a valid ERC-20 on the Paxeer EVM network.',
          { parse_mode: 'HTML' }
        );
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error handling custom_token button', { error: error.message });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── Custom Token: confirm and proceed to wager (without saving) ─────────────
    bot.action(/^confirm_custom_token_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        const session = await models.BotSession.findByPk(sessionId);
        if (!session || parseInt(session.userId) !== parseInt(userId)) {
          return ctx.answerCbQuery('❌ Session not found');
        }

        const token = session.data?.pendingCustomToken;
        if (!token) {
          await ctx.answerCbQuery('❌ Token data lost — please try again');
          return;
        }

        session.data = { ...session.data, tokenInfo: token, pendingCustomToken: null };
        session.currentStep = 'AWAITING_WAGER';
        await session.save();

        await ctx.editMessageText(
          `💰 <b>Enter Wager Amount</b>\n\n` +
          `Token: ${token.symbol}\n` +
          `Network: ${token.network}\n\n` +
          `Just reply with the amount.\n` +
          `Example: <code>10</code> or <code>100.5</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `back_to_token_select_${session.id}`)]]).reply_markup,
          }
        );
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error confirming custom token', { error: error.message });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── Custom Token: save to favorites, then proceed to wager ──────────────────
    bot.action(/^save_and_use_custom_token_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        const session = await models.BotSession.findByPk(sessionId);
        if (!session || parseInt(session.userId) !== parseInt(userId)) {
          return ctx.answerCbQuery('❌ Session not found');
        }

        const token = session.data?.pendingCustomToken;
        if (!token) {
          await ctx.answerCbQuery('❌ Token data lost — please try again');
          return;
        }

        // Persist to favorites
        let profile = await models.UserProfile.findByPk(userId);
        if (!profile) profile = await models.UserProfile.create({ userId });
        const existing = Array.isArray(profile.favoriteTokens) ? profile.favoriteTokens : [];
        const alreadySaved = existing.some(
          f => (f.address || '').toLowerCase() === token.address.toLowerCase()
        );
        if (!alreadySaved) {
          profile.favoriteTokens = [...existing, token];
          await profile.save();
        }

        session.data = { ...session.data, tokenInfo: token, pendingCustomToken: null };
        session.currentStep = 'AWAITING_WAGER';
        await session.save();

        await ctx.editMessageText(
          `${alreadySaved ? '✅' : '❤️ Saved!'}\n\n` +
          `💰 <b>Enter Wager Amount</b>\n\n` +
          `Token: ${token.symbol}\n` +
          `Network: ${token.network}\n\n` +
          `Just reply with the amount.\n` +
          `Example: <code>10</code> or <code>100.5</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `back_to_token_select_${session.id}`)]]).reply_markup,
          }
        );
        await ctx.answerCbQuery(alreadySaved ? 'Already in favorites' : '❤️ Saved to favorites!');
      } catch (error) {
        logger.error('Error saving custom token to favorites', { error: error.message });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── Custom Token: go back to token selection menu ────────────────────────────
    bot.action(/^back_to_token_select_(.+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const sessionId = ctx.match[1];
        const userId = ctx.from.id;

        const session = await models.BotSession.findByPk(sessionId);
        if (!session || parseInt(session.userId) !== parseInt(userId)) {
          return ctx.answerCbQuery('❌ Session not found');
        }

        session.currentStep = 'SELECTING_TOKEN';
        session.data = { ...session.data, pendingCustomToken: null };
        await session.save();

        await showTokenSelectionMenu(ctx, session, true);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error going back to token selection', { error: error.message });
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
        message += `💰 Total Profit: <b>${parseFloat(stats.totalEarnings).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n`;
        message += `📉 Total Losses: <b>${parseFloat(stats.totalLosses).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n`;
        message += `📊 Volume Wagered: <b>${parseFloat(stats.totalVolume).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n\n`;

        // Add per-token breakdown if available
        if (Object.keys(stats.perTokenStats).length > 0) {
          message += `<b>Per-Token Breakdown:</b>\n`;
          Object.values(stats.perTokenStats).forEach(tokenStat => {
            message += `\n🪙 <b>${tokenStat.symbol}</b> (${tokenStat.network})\n`;
            message += `   Flips: ${tokenStat.flips} | Win Rate: ${tokenStat.winRate}%\n`;
            message += `   Wagered: ${tokenStat.wagered.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
            message += `   Profit: ${tokenStat.earned.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('💰 Profit Share', 'profit_share_page'), Markup.button.callback('🏠 Home', 'back_to_home')],
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

        if (userProfile?.evmWalletAddress) {
          const evmReceive = userProfile.evmWalletAddress.substring(0, 6) + '...' + userProfile.evmWalletAddress.substring(userProfile.evmWalletAddress.length - 4);
          dashboardMsg += `✅ <b>Paxeer Receive:</b> <code>${evmReceive}</code>\n`;
        } else {
          dashboardMsg += `❌ <b>Paxeer Receive:</b> Not set\n`;
        }

        if (userProfile?.evmDepositWalletAddress) {
          const evmDeposit = userProfile.evmDepositWalletAddress.substring(0, 6) + '...' + userProfile.evmDepositWalletAddress.substring(userProfile.evmDepositWalletAddress.length - 4);
          dashboardMsg += `✅ <b>Paxeer Send:</b> <code>${evmDeposit}</code>\n`;
        } else {
          dashboardMsg += `❌ <b>Paxeer Send:</b> Not set\n`;
        }

        dashboardMsg += `\n`;

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
                Markup.button.callback('💰 Profit Share', 'profit_share_page'),
              ],
              [
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

    // Profit Share page
    bot.action('profit_share_page', async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;
        const profile = await models.UserProfile.findByPk(userId);

        // Primary wallets (receive + deposit)
        const primaryWallets = [profile?.evmWalletAddress, profile?.evmDepositWalletAddress]
          .filter(w => w && /^0x[a-fA-F0-9]{40}$/.test(w))
          .map(w => w.toLowerCase());

        // Extra profit share wallets registered by the user
        const extraRows = await models.UserProfitShareWallet.findAll({ where: { userId } });
        const extraWallets = extraRows.map(r => r.walletAddress.toLowerCase());

        const wallets = [...new Set([...primaryWallets, ...extraWallets])];

        let msg = `💰 <b>$FLIP Profit Share</b>\n\n`;

        if (wallets.length === 0) {
          msg += `No EVM wallet registered.\nSet up your wallet to track profit share earnings.`;
        } else {
          const merged = {};
          for (const w of wallets) {
            const rows = await ProfitShareHandler.getHolderTotals(w);
            for (const r of rows) {
              if (!merged[r.tokenSymbol]) merged[r.tokenSymbol] = { ...r };
              else merged[r.tokenSymbol].total += r.total;
            }
          }
          const totals = Object.values(merged).sort((a, b) => b.total - a.total);
          if (totals.length === 0) {
            msg += `No profit share receipts found for your registered wallet(s).\n\n`;
            msg += `<b>Wallets checked:</b>\n`;
            wallets.forEach(w => { msg += `<code>${w}</code>\n`; });
          } else {
            msg += `<b>Total earned from $FLIP profit share distributions:</b>\n\n`;
            for (const t of totals) {
              msg += `🪙 <b>${t.tokenSymbol}:</b> ${t.total.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
            }
            if (extraWallets.length > 0) {
              msg += `\n<i>Tracking ${wallets.length} wallet(s) including ${extraWallets.length} extra.</i>`;
            }
            msg += `\n<i>Updated each distribution cycle.</i>`;
          }
        }

        await ctx.editMessageText(msg, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🗂 Manage Wallets', 'ps_wallets_page')],
            [Markup.button.callback('🏠 Home', 'back_to_home')],
          ]).reply_markup,
        });
        await ctx.answerCbQuery();
      } catch (err) {
        logger.error('Error showing profit share page', err);
        await ctx.answerCbQuery('❌ Error loading profit share');
      }
    });

    // Profit Share — wallet management page
    bot.action('ps_wallets_page', async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;
        const profile = await models.UserProfile.findByPk(userId);
        const extraRows = await models.UserProfitShareWallet.findAll({
          where: { userId },
          order: [['createdAt', 'ASC']],
        });

        let msg = `🗂 <b>Profit Share Wallets</b>\n\n`;
        msg += `<i>Primary wallets (set via /wallet) are always included.\n`;
        msg += `Register extra wallets below if you hold $FLIP in additional addresses.</i>\n\n`;

        const primary = [profile?.evmWalletAddress, profile?.evmDepositWalletAddress].filter(Boolean);
        if (primary.length) {
          msg += `<b>Primary:</b>\n`;
          primary.forEach(w => { msg += `  <code>${w}</code>\n`; });
          msg += `\n`;
        }

        const buttons = [];
        if (extraRows.length > 0) {
          msg += `<b>Extra wallets:</b>\n`;
          for (const row of extraRows) {
            const short = row.walletAddress.substring(0, 6) + '…' + row.walletAddress.slice(-4);
            msg += `  <code>${row.walletAddress}</code>\n`;
            buttons.push([Markup.button.callback(`❌ Remove ${short}`, `ps_wallet_remove_${row.walletAddress}`)]);
          }
        } else {
          msg += `No extra wallets registered yet.`;
        }

        buttons.push([Markup.button.callback('➕ Add wallet', 'ps_wallet_add_start')]);
        buttons.push([Markup.button.callback('🔙 Back', 'profit_share_page')]);

        await ctx.editMessageText(msg, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        });
        await ctx.answerCbQuery();
      } catch (err) {
        logger.error('Error showing PS wallets page', err);
        await ctx.answerCbQuery('❌ Error loading wallets');
      }
    });

    // Profit Share — start adding a wallet (creates an input session)
    bot.action('ps_wallet_add_start', async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;

        await models.User.findOrCreate({
          where: { telegramId: userId },
          defaults: {
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
          },
        });

        await models.BotSession.destroy({ where: { userId, sessionType: 'PS_WALLET_ADD' } });
        await models.BotSession.create({
          userId,
          sessionType: 'PS_WALLET_ADD',
          currentStep: 'AWAITING_PS_WALLET_ADDRESS',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        });

        await ctx.editMessageText(
          `➕ <b>Add a profit share wallet</b>\n\n` +
          `Send me the Paxeer wallet address you want to track for profit share earnings.\n` +
          `(e.g. <code>0x1234…abcd</code>)\n\n` +
          `<i>Type /cancel to abort.</i>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await ctx.answerCbQuery();
      } catch (err) {
        logger.error('Error starting PS wallet add', err);
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // Profit Share — remove an extra wallet (dynamic callback data)
    bot.action(/^ps_wallet_remove_0x[a-fA-F0-9]{40}$/, async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;
        const walletAddress = ctx.callbackQuery.data.replace('ps_wallet_remove_', '').toLowerCase();

        await models.UserProfitShareWallet.destroy({ where: { userId, walletAddress } });

        await ctx.answerCbQuery('✅ Wallet removed');
        // Re-render wallet management page in-place
        const fakeCtx = ctx;
        const profile = await models.UserProfile.findByPk(userId);
        const extraRows = await models.UserProfitShareWallet.findAll({
          where: { userId },
          order: [['createdAt', 'ASC']],
        });

        let msg = `🗂 <b>Profit Share Wallets</b>\n\n`;
        msg += `<i>Primary wallets (set via /wallet) are always included.\n`;
        msg += `Register extra wallets below if you hold $FLIP in additional addresses.</i>\n\n`;

        const primary = [profile?.evmWalletAddress, profile?.evmDepositWalletAddress].filter(Boolean);
        if (primary.length) {
          msg += `<b>Primary:</b>\n`;
          primary.forEach(w => { msg += `  <code>${w}</code>\n`; });
          msg += `\n`;
        }

        const buttons = [];
        if (extraRows.length > 0) {
          msg += `<b>Extra wallets:</b>\n`;
          for (const row of extraRows) {
            const short = row.walletAddress.substring(0, 6) + '…' + row.walletAddress.slice(-4);
            msg += `  <code>${row.walletAddress}</code>\n`;
            buttons.push([Markup.button.callback(`❌ Remove ${short}`, `ps_wallet_remove_${row.walletAddress}`)]);
          }
        } else {
          msg += `No extra wallets registered yet.`;
        }

        buttons.push([Markup.button.callback('➕ Add wallet', 'ps_wallet_add_start')]);
        buttons.push([Markup.button.callback('🔙 Back', 'profit_share_page')]);

        await ctx.editMessageText(msg, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        });
      } catch (err) {
        logger.error('Error removing PS wallet', err);
        await ctx.answerCbQuery('❌ Error removing wallet');
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

    // ── My Tokens: open list ───────────────────────────────────────────────────
    bot.action('open_my_tokens', async (ctx) => {
      try {
        await showMyTokensMenu(ctx, true);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error opening my tokens', { error: error.message });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── My Tokens: remove a favorite by index ─────────────────────────────────
    bot.action(/^remove_fav_token_(\d+)$/, async (ctx) => {
      try {
        const { models } = getDB();
        const idx = parseInt(ctx.match[1], 10);
        const userId = ctx.from.id;
        const profile = await models.UserProfile.findByPk(userId);
        if (!profile) return ctx.answerCbQuery('❌ Profile not found');

        const favorites = Array.isArray(profile.favoriteTokens) ? profile.favoriteTokens : [];
        if (idx < 0 || idx >= favorites.length) return ctx.answerCbQuery('❌ Token not found');

        const removed = favorites[idx];
        profile.favoriteTokens = favorites.filter((_, i) => i !== idx);
        await profile.save();

        await ctx.answerCbQuery(`🗑️ ${removed.symbol} removed`);
        await showMyTokensMenu(ctx, true);
      } catch (error) {
        logger.error('Error removing favorite token', { error: error.message });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── My Tokens: prompt to add a new token via CA ───────────────────────────
    bot.action('add_fav_token', async (ctx) => {
      try {
        const { models } = getDB();
        const userId = ctx.from.id;

        await models.BotSession.destroy({
          where: { userId: String(userId), sessionType: 'MANAGING_FAVORITES' },
        });
        await models.BotSession.create({
          userId: String(userId),
          sessionType: 'MANAGING_FAVORITES',
          currentStep: 'AWAITING_FAV_CA',
          data: {},
        });

        await ctx.editMessageText(
          '➕ <b>Add Favorite Token</b>\n\nSend the EVM contract address (<code>0x…</code>) of the token you want to add to your favorites.\n\nOr /cancel to go back.',
          { parse_mode: 'HTML' }
        );
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error starting add favorite flow', { error: error.message });
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // ── My Tokens: back to start dashboard ────────────────────────────────────
    bot.action('back_to_start_dashboard', async (ctx) => {
      try {
        await showStartDashboard(ctx, true);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error('Error going back to start dashboard', { error: error.message });
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

          // Atomically claim the flip: only succeed if it is still WAITING_CHALLENGER.
          // This prevents a race with the 4-minute challenge-timeout callback which
          // also reads WAITING_CHALLENGER and sets CANCELLED.
          const [rowsClaimed] = await models.CoinFlip.update(
            { challengerId: String(userId), status: 'WAITING_CHALLENGER_DEPOSIT' },
            { where: { id: flipId, status: 'WAITING_CHALLENGER' } }
          );
          if (rowsClaimed === 0) {
            // The timeout won the race and already cancelled the flip
            logger.warn('[start] Flip was cancelled before the accept could be saved (race)', { flipId, userId });
            await ctx.reply('❌ This challenge has just expired — no one was fast enough!');
            return;
          }

          // Clear in-memory expiry timeout now that a challenger has accepted
          clearChallengeTimeout(flipId);

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
              expiredMsgId,
              flipDataField: flip.data,
              flipGroupMessageId: flip.groupMessageId
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
          const receiveWalletField = 'evmWalletAddress';
          const depositWalletField = 'evmDepositWalletAddress';
          
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

            // Set 3-minute deposit timeout for challenger
            setDepositTimeout(flipId, ctx.telegram);
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

            // Start deposit timeout even while user sets up wallets
            setDepositTimeout(flipId, ctx.telegram);
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
            const receiveWalletField = 'evmWalletAddress';
            const depositWalletField = 'evmDepositWalletAddress';
            
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
                    [Markup.button.callback('✅ I Sent the Deposit', `deposit_confirmed_${flip.id}`)],
                  ]).reply_markup,
                }
              );

              // Set 3-minute deposit timeout for challenger
              setDepositTimeout(flip.id, ctx.telegram);
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

              // Start deposit timeout even while user sets up wallets
              setDepositTimeout(flip.id, ctx.telegram);
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
            // Creator clicked through — cancel the initiating expiry timer
            if (initiatingTimeouts[session.id]) {
              clearTimeout(initiatingTimeouts[session.id]);
              delete initiatingTimeouts[session.id];
            }

            // Check if user has BOTH required wallet addresses
            const userProfile = await models.UserProfile.findByPk(userId);
            const receiveWalletField = 'evmWalletAddress'; // For receiving winnings
            const depositWalletField = 'evmDepositWalletAddress'; // For sending deposits
            
            // No need to check network-specific here - user needs both for any flip
            const hasReceiveWallet = userProfile?.evmWalletAddress;
            const hasDepositWallet = userProfile?.evmDepositWalletAddress;
            
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
            await showTokenSelectionMenu(ctx, session);
            return;
          }
        } catch (error) {
          logger.error('Error handling flip start parameter', error);
        }
      }

      // Regular start message
      
      // Check if user has BOTH required wallet addresses
      const userProfile = await models.UserProfile.findByPk(userId);
      const hasReceiveWallet = userProfile?.evmWalletAddress;
      const hasDepositWallet = userProfile?.evmDepositWalletAddress;
      
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
      await showStartDashboard(ctx, false);
    } else {
      // In group chat — /start does nothing
      return;
    }
  },

  help: async (ctx) => {
    console.log('[HANDLER] /help called');
    try {
      const helpText = `<b>🪙 Coin Flip Bot Help</b>

<b>How to Play:</b>
1. Use /flip in a group to start a challenge
2. Select your token and wager amount in DM
3. Bot sends you a deposit address
4. Send your wager to that address
5. Other members can accept your challenge
6. Challenger deposits their wager
7. Bot flips a coin - winner takes 90% of the pot!

<b>Fee Distribution:</b>
🔥 Burn: 5% of pool
👨‍💼 Dev: 5% of pool

<b>Supported Tokens:</b>
🌐 <b>Paxeer Network:</b> PAX (Native), SID

<b>Wallet Setup:</b>
For Paxeer network you need:
💰 <b>Receive Wallet</b> - Where your winnings are sent
🏦 <b>Sending Wallet</b> - Address you send deposits from
(You only need to configure networks you plan to use)

<b>Rules:</b>
⏱️ 3 minutes to confirm each deposit
👥 Both players need complete wallet setup
💎 Winner receives 1.8x their wager amount
⏳ Wager refunded to the creator if challenge times out
🔒 All transactions are recorded on-chain`;

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
      message += `💰 Total Profit: <b>${parseFloat(stats.totalEarnings).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n`;
      message += `📉 Total Losses: <b>${parseFloat(stats.totalLosses).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n`;
      message += `📊 Volume Wagered: <b>${parseFloat(stats.totalVolume).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b>\n\n`;

      // Add per-token breakdown if available
      if (Object.keys(stats.perTokenStats).length > 0) {
        message += `<b>Per-Token Breakdown:</b>\n`;
        Object.values(stats.perTokenStats).forEach(tokenStat => {
          message += `\n\uD83E\uDE99 <b>${tokenStat.symbol}</b> (${tokenStat.network})\n`;
          message += `   Flips: ${tokenStat.flips} | Win Rate: ${tokenStat.winRate}%\n`;
          message += `   Wagered: ${tokenStat.wagered.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
          message += `   Profit: ${tokenStat.earned.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n`;
        });
      }

      await ctx.reply(message, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('💰 Profit Share', 'profit_share_page')],
        ]).reply_markup,
      });
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

  shame: async (ctx) => {
    console.log('[HANDLER] /shame called');
    if (ctx.chat.type === 'private') {
      await ctx.reply('😅 /shame only works in a group chat!');
      return;
    }

    try {
      const { models } = getDB();

      // Check if a user was mentioned (@username or reply)
      let targetDisplay = null;
      let targetUserId = null;

      // Reply-to target
      if (ctx.message.reply_to_message) {
        const from = ctx.message.reply_to_message.from;
        if (from && !from.is_bot) {
          targetDisplay = from.username ? `@${from.username}` : from.first_name;
          targetUserId = from.id;
        }
      }

      // Inline mention (@username as command arg)
      if (!targetDisplay && ctx.message.entities) {
        for (const entity of ctx.message.entities) {
          if (entity.type === 'mention') {
            targetDisplay = ctx.message.text.slice(entity.offset, entity.offset + entity.length);
            break;
          } else if (entity.type === 'text_mention' && entity.user) {
            targetDisplay = entity.user.username ? `@${entity.user.username}` : entity.user.first_name;
            targetUserId = entity.user.id;
            break;
          }
        }
      }

      // If no mention, look up the last confirmed clicker-without-funds in this group.
      // Use confirmedShame: true — this is only stamped by the depositTimeout handler
      // after an on-chain check positively confirms no funds were ever sent. This keeps
      // /shame consistent with whatever the automatic shame message already posted.
      if (!targetDisplay) {
        const lastTimedOut = await models.CoinFlip.findOne({
          where: {
            groupChatId: ctx.chat.id.toString(),
            status: 'CANCELLED',
            confirmedShame: true,
          },
          order: [['updatedAt', 'DESC']],
        });

        if (lastTimedOut?.challengerId) {
          const user = await models.User.findByPk(lastTimedOut.challengerId);
          targetDisplay = user?.username ? `@${user.username}` : user?.firstName || 'the last clicker';
        }
      }

      const shameLines = [
        `😱 A SHAME FOR THOSE THAT CLICK WITHOUT FUNDS!`,
        `😹 ALL BARK, NO BITE!`,
        `🤡 WINDOW SHOPPER DETECTED!`,
        `💀 BROKE AND BOLD!`,
        `🫵 FINGERS FASTER THAN THE WALLET!`,
        `🏃‍♂️ RUNNING FROM THE CONSEQUENCES!`,
      ];
      const shameLine = shameLines[Math.floor(Math.random() * shameLines.length)];

      const target = targetDisplay ? `${targetDisplay} ` : '';
      await ctx.reply(
        `📢 ${shameLine}\n\n` +
        `${target}has been summoned to the Wall of Shame. ` +
        `Don't click the Accept button if your wallet can't cash the check! 💸`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error('[shame] Error', { error: error.message });
    }
  },

  wallofshame: async (ctx) => {
    console.log('[HANDLER] /wallofshame called');
    try {
      const { models } = getDB();

      // Only count flips that were positively confirmed as click-without-funds
      // by the deposit timeout handler (confirmedShame=true). This excludes
      // historical records from before the feature was deployed.
      const shameFlips = await models.CoinFlip.findAll({
        where: {
          confirmedShame: true,
        },
        attributes: ['challengerId'],
        raw: true,
      });

      // Count offences per user
      const countByUser = {};
      for (const flip of shameFlips) {
        if (flip.challengerId) {
          countByUser[flip.challengerId] = (countByUser[flip.challengerId] || 0) + 1;
        }
      }

      // Sort descending by count, take top 10
      const sorted = Object.entries(countByUser)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);

      let msg = `😂 <b>Wall of Shame</b>\n`;
      msg += `<i>Most click-without-funds offences</i>\n\n`;

      if (sorted.length === 0) {
        msg += `No offenders yet! 🎉\nEveryone here actually pays up. 💪`;
      } else {
        // Look up user names
        const userIds = sorted.map(([id]) => id);
        const users = await models.User.findAll({
          where: { telegramId: { [Op.in]: userIds } },
          attributes: ['telegramId', 'firstName', 'username'],
          raw: true,
        });
        const userMap = {};
        users.forEach(u => { userMap[String(u.telegramId)] = u; });

        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        const getName = u => u?.username ? `@${u.username}` : (u?.firstName || 'Unknown');

        sorted.forEach(([id, count], i) => {
          const u = userMap[String(id)];
          const times = count === 1 ? '1 time' : `${count} times`;
          msg += `${medals[i]} ${getName(u)} — <b>${times}</b>\n`;
        });
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('[wallofshame] Error', { error: error.message });
    }
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

      // Check if this is adding an extra profit share wallet
      if (activeSession.sessionType === 'PS_WALLET_ADD') {
        const address = ctx.message.text.trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          await ctx.reply(
            `❌ Invalid address format.\n\n` +
            `Please send a valid Paxeer wallet address starting with <code>0x</code> and 40 hex characters.`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        const normalised = address.toLowerCase();
        await models.UserProfitShareWallet.findOrCreate({
          where: { userId, walletAddress: normalised },
          defaults: { userId, walletAddress: normalised },
        });
        // Also register in FlipHolderAddress so it's included in future distributions
        await models.FlipHolderAddress.findOrCreate({
          where: { address: normalised },
          defaults: { address: normalised, label: `ps_user:${userId}` },
        }).catch(() => {});
        await models.BotSession.destroy({ where: { id: activeSession.id } });
        await ctx.reply(
          `✅ Wallet registered for profit share tracking!\n\n<code>${normalised}</code>\n\n` +
          `Open the Profit Share page to see your updated totals.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Handle INITIATING sessions (wager entry for /flip)
      if (activeSession.sessionType === 'INITIATING') {
        if (activeSession.currentStep === 'AWAITING_WAGER') {
          logger.info('Processing wager amount for INITIATING session');
          await FlipHandler.processWagerAmount(ctx);
        } else if (activeSession.currentStep === 'AWAITING_CA') {
          // User is entering a custom EVM contract address
          await handleCustomCAInput(ctx, activeSession);
        } else if (activeSession.currentStep === 'AWAITING_CA_CONFIRM') {
          await ctx.reply('⬆️ Please use the buttons above to confirm or go back.');
        } else if (activeSession.currentStep === 'AWAITING_DEPOSIT') {
          logger.warn('INITIATING session AWAITING_DEPOSIT: user should click button, not send text message');
          await ctx.reply('⬆️ Please click the button above when you\'ve sent the tokens.');
        } else if (activeSession.currentStep === 'SELECTING_TOKEN') {
          await ctx.reply('⬆️ Please choose a token using the buttons above.');
        } else {
          logger.warn('INITIATING session but unexpected currentStep', { currentStep: activeSession.currentStep });
        }
      } else if (activeSession.sessionType === 'CONFIRMING_DEPOSIT') {
        logger.warn('CONFIRMING_DEPOSIT session: user should click button, not send text message');
        await ctx.reply('⬆️ Please click the button above when you\'ve sent the tokens.');
      } else if (activeSession.sessionType === 'CLAIMING_WINNINGS') {
        logger.info('Processing payout address');
        await ExecutionHandler.processPayoutAddress(ctx);
      } else if (activeSession.sessionType === 'MANAGING_FAVORITES') {
        if (activeSession.currentStep === 'AWAITING_FAV_CA') {
          await handleFavCAInput(ctx, activeSession);
        }
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

      // Sleep mode: block new flips in groups
      if (isGroup && botState.asleep) {
        await ctx.reply(
          `😴 <b>Bot is currently offline for maintenance.</b>\n\nFlips are temporarily disabled. Please try again later!`,
          { parse_mode: 'HTML' }
        );
        return;
      }

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
                  [Markup.button.callback('💬 Start in DM', `start_flip_dm_${session.id}`)],
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
                [Markup.button.callback('💬 Start in DM', `start_flip_dm_${session.id}`)],
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

        // Set a 5-minute expiry on the group card in case creator never deposits
        setInitiatingTimeout(session.id, ctx.chat.id, groupMsg.message_id, ctx.telegram);
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

        await showTokenSelectionMenu(ctx, session);
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

/** Return the user's saved favorite tokens from their UserProfile. */
async function getUserFavoriteTokens(userId) {
  const { models } = getDB();
  const profile = await models.UserProfile.findByPk(userId);
  return Array.isArray(profile?.favoriteTokens) ? profile.favoriteTokens : [];
}

/**
 * Build and send (or edit) the token selection inline keyboard for a session.
 * Shows ⭐ Featured tokens first, then ❤️ Favorites (if any), then an "Enter CA" button.
 * Also stores the full ordered token list in session.data.tokensList for consistent indexing.
 */
async function showTokenSelectionMenu(ctx, session, editMessage = false) {
  const userId = parseInt(session.userId, 10);
  const featured = await getSupportedTokensList();
  const favorites = await getUserFavoriteTokens(userId);

  // Remove favorites that already appear in featured (matched by lower-case address)
  const featuredAddressSet = new Set(featured.map(t => (t.address || 'NATIVE').toLowerCase()));
  const uniqueFavorites = favorites.filter(
    f => !featuredAddressSet.has((f.address || 'NATIVE').toLowerCase())
  );

  // The ordered list that will be indexed by start_flip_SESSIONID_IDX
  const allTokens = [...featured, ...uniqueFavorites];
  session.data = { ...session.data, tokensList: allTokens };
  await session.save();

  const rows = [];

  // ⭐ Featured tokens — 2 per row
  if (featured.length > 0) {
    const featuredBtns = featured.map((token, idx) =>
      Markup.button.callback(`⭐ ${token.symbol}`, `start_flip_${session.id}_${idx}`)
    );
    for (let i = 0; i < featuredBtns.length; i += 2) {
      rows.push(featuredBtns.slice(i, i + 2));
    }
  }

  // ❤️ Favorite tokens — 2 per row
  if (uniqueFavorites.length > 0) {
    const favStartIdx = featured.length;
    const favBtns = uniqueFavorites.map((token, i) =>
      Markup.button.callback(`❤️ ${token.symbol}`, `start_flip_${session.id}_${favStartIdx + i}`)
    );
    for (let i = 0; i < favBtns.length; i += 2) {
      rows.push(favBtns.slice(i, i + 2));
    }
  }

  rows.push([Markup.button.callback('🔍 Enter Contract Address', `custom_token_${session.id}`)]);

  let msgText = '🪙 <b>Select a Token</b>\n\n';
  msgText += '⭐ <b>Featured</b> — curated tokens\n';
  if (uniqueFavorites.length > 0) msgText += '❤️ <b>Favorites</b> — your saved tokens\n';
  msgText += '\nOr tap <b>Enter Contract Address</b> to flip with any EVM token.';

  const opts = { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows).reply_markup };
  if (editMessage) {
    await ctx.editMessageText(msgText, opts);
  } else {
    await ctx.reply(msgText, opts);
  }
}

/** Render (or edit to) the main /start dashboard card. */
async function showStartDashboard(ctx, editMessage = false) {
  const { models } = getDB();
  const userId = ctx.from?.id;
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

  if (userProfile?.evmWalletAddress) {
    const s = userProfile.evmWalletAddress;
    dashboardMsg += `✅ <b>Paxeer Receive:</b> <code>${s.substring(0, 6)}...${s.substring(s.length - 4)}</code>\n`;
  } else {
    dashboardMsg += `❌ <b>Paxeer Receive:</b> Not set\n`;
  }
  if (userProfile?.evmDepositWalletAddress) {
    const s = userProfile.evmDepositWalletAddress;
    dashboardMsg += `✅ <b>Paxeer Send:</b> <code>${s.substring(0, 6)}...${s.substring(s.length - 4)}</code>\n`;
  } else {
    dashboardMsg += `❌ <b>Paxeer Send:</b> Not set\n`;
  }

  dashboardMsg += `\n<b>Ready to play?</b> Use the buttons below to get started!`;

  const opts = {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.button.callback('💳 Wallets', 'open_wallet_menu'),
        Markup.button.callback('📊 My Stats', 'show_stats'),
      ],
      [
        Markup.button.callback('🪙 Start Flip', 'start_flip_action'),
        Markup.button.callback('💰 Profit Share', 'profit_share_page'),
      ],
      [
        Markup.button.callback('⭐ My Tokens', 'open_my_tokens'),
        Markup.button.callback('❓ Help', 'show_help_action'),
      ],
    ]).reply_markup,
  };

  if (editMessage) {
    await ctx.editMessageText(dashboardMsg, opts);
  } else {
    await ctx.reply(dashboardMsg, opts);
  }
}

/** Show (or edit to) the My Tokens management page. */
async function showMyTokensMenu(ctx, editMessage = false) {
  const { models } = getDB();
  const userId = ctx.from?.id;
  const profile = await models.UserProfile.findByPk(userId);
  const favorites = Array.isArray(profile?.favoriteTokens) ? profile.favoriteTokens : [];

  let msgText = '⭐ <b>My Tokens</b>\n\n';
  const rows = [];

  if (favorites.length === 0) {
    msgText += 'You have no saved tokens yet.\n\nTap <b>Add Token</b> to save an EVM token by its contract address.';
  } else {
    msgText += 'Your saved favorite tokens:\n\n';
    favorites.forEach((token, idx) => {
      msgText += `${idx + 1}. <b>${token.symbol}</b> — ${token.network}\n   <code>${token.address}</code>\n`;
      rows.push([Markup.button.callback(`🗑️ Remove ${token.symbol}`, `remove_fav_token_${idx}`)]);
    });
    msgText += '\nFavorite tokens appear in your token picker when starting a flip.';
  }

  rows.push([Markup.button.callback('➕ Add Token', 'add_fav_token')]);
  rows.push([Markup.button.callback('◀ Back to Menu', 'back_to_start_dashboard')]);

  const opts = { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows).reply_markup };
  if (editMessage) {
    await ctx.editMessageText(msgText, opts);
  } else {
    await ctx.reply(msgText, opts);
  }
}

/** Handle a contract address sent in DM during the MANAGING_FAVORITES flow. */
async function handleFavCAInput(ctx, session) {
  const { ethers } = require('ethers');
  const { models } = getDB();
  const input = ctx.message.text.trim();

  if (!ethers.isAddress(input)) {
    await ctx.reply(
      '❌ <b>Invalid address</b>\n\nThat doesn\'t look like a valid EVM contract address.\n\nPlease send a valid <code>0x…</code> address.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const address = ethers.getAddress(input);
  await ctx.reply('🔍 Resolving token info…');

  try {
    const blockchainManager = getBlockchainManager();
    const tokenInfo = await blockchainManager.getTokenInfo('EVM', address);

    const userId = ctx.from.id;
    let profile = await models.UserProfile.findByPk(userId);
    if (!profile) profile = await models.UserProfile.create({ userId });
    const existing = Array.isArray(profile.favoriteTokens) ? profile.favoriteTokens : [];
    const alreadySaved = existing.some(f => (f.address || '').toLowerCase() === address.toLowerCase());

    if (!alreadySaved) {
      profile.favoriteTokens = [...existing, {
        network: 'EVM',
        address,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
      }];
      await profile.save();
    }

    await session.destroy();

    const statusText = alreadySaved
      ? `ℹ️ <b>${tokenInfo.symbol}</b> is already in your favorites.`
      : `❤️ <b>${tokenInfo.symbol}</b> added to your favorites!`;
    await ctx.reply(statusText, { parse_mode: 'HTML' });
    await showMyTokensMenu(ctx, false);
  } catch (err) {
    logger.error('[handleFavCAInput] Failed to resolve token', { address, error: err.message });
    await ctx.reply(
      `❌ <b>Could not resolve token</b>\n\nMake sure this is a valid ERC-20 contract on the Paxeer EVM network.\n\nError: ${err.message}`,
      { parse_mode: 'HTML' }
    );
  }
}

async function handleCustomCAInput(ctx, session) {
  const { ethers } = require('ethers');
  const input = ctx.message.text.trim();

  if (!ethers.isAddress(input)) {
    await ctx.reply(
      '❌ <b>Invalid address</b>\n\nThat doesn\'t look like a valid EVM contract address.\n\nPlease send a valid <code>0x…</code> address, or type /cancel to go back.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const address = ethers.getAddress(input); // checksummed

  await ctx.reply('🔍 Resolving token info…');

  try {
    const blockchainManager = getBlockchainManager();
    const tokenInfo = await blockchainManager.getTokenInfo('EVM', address);

    // Store resolved token in session for the confirmation step
    session.data = {
      ...session.data,
      pendingCustomToken: {
        network: 'EVM',
        address,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
      },
    };
    session.currentStep = 'AWAITING_CA_CONFIRM';
    await session.save();

    await ctx.reply(
      `✅ <b>Token Found</b>\n\n` +
      `Symbol: <b>${tokenInfo.symbol}</b>\n` +
      `Decimals: ${tokenInfo.decimals}\n` +
      `Contract: <code>${address}</code>\n\n` +
      `<b>Use this token for your flip?</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Use ${tokenInfo.symbol}`, `confirm_custom_token_${session.id}`)],
          [Markup.button.callback(`❤️ Save & Use`, `save_and_use_custom_token_${session.id}`)],
          [Markup.button.callback('← Back to Token List', `back_to_token_select_${session.id}`)],
        ]).reply_markup,
      }
    );
  } catch (err) {
    logger.error('[handleCustomCAInput] Failed to resolve token', { address, error: err.message });
    await ctx.reply(
      `❌ <b>Could not resolve token</b>\n\nMake sure the contract address is a valid ERC-20 token on the Paxeer EVM network.\n\nError: ${err.message}`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Acquire a PostgreSQL session-level advisory lock so only one bot instance
 * runs at a time. The lock is automatically released when the process exits
 * and its DB connection closes — no manual release needed.
 *
 * If another instance already holds the lock this will wait (pg_try_advisory_lock
 * returns false immediately; pg_advisory_lock blocks). We use the try variant
 * so Railway doesn't stall the health-check: if we can't get the lock within
 * the retry window we exit, letting Railway restart us once the old instance dies.
 */
async function acquireSingleInstanceLock() {
  const { sequelize } = getDB();
  const LOCK_ID = 42424242; // arbitrary stable integer for this bot
  const MAX_WAIT_MS = 30_000;
  const RETRY_MS = 1_000;
  const start = Date.now();

  while (true) {
    const [[{ acquired }]] = await sequelize.query(
      `SELECT pg_try_advisory_lock(${LOCK_ID}) AS acquired`
    );
    if (acquired) {
      logger.info('[lock] Acquired single-instance advisory lock');
      return;
    }
    const elapsed = Date.now() - start;
    if (elapsed + RETRY_MS > MAX_WAIT_MS) {
      logger.error('[lock] Could not acquire single-instance lock within timeout — another instance is still running');
      process.exit(1);
    }
    logger.info(`[lock] Lock held by another instance, retrying in ${RETRY_MS}ms…`);
    await new Promise(r => setTimeout(r, RETRY_MS));
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    await initBot();
    await acquireSingleInstanceLock();

    // Retry bot.launch() if 409 — the old instance's Telegram long-poll may
    // still be active even after its DB connection (advisory lock) was released.
    // We wait and retry rather than letting the process die + restart.
    const MAX_LAUNCH_ATTEMPTS = 8;
    const LAUNCH_RETRY_MS = 5_000;
    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
      try {
        await bot.launch({ dropPendingUpdates: true });
        break; // success
      } catch (launchErr) {
        if (launchErr.response?.error_code === 409 && attempt < MAX_LAUNCH_ATTEMPTS) {
          logger.warn(`[launch] 409 conflict on attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS} — old instance still polling, retrying in ${LAUNCH_RETRY_MS}ms…`);
          await new Promise(r => setTimeout(r, LAUNCH_RETRY_MS));
        } else {
          throw launchErr; // rethrow on non-409 or final attempt
        }
      }
    }

    console.log('🚀 Bot launched successfully');

    // Graceful shutdown — await bot.stop() so the long-poll is cleanly
    // cancelled before the process exits, preventing 409 conflicts on redeploy.
    process.once('SIGINT', async () => { await bot.stop('SIGINT'); process.exit(0); });
    process.once('SIGTERM', async () => { await bot.stop('SIGTERM'); process.exit(0); });
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

// Prevent unhandled promise rejections from crashing the process (e.g. in-flight
// sendWinnings calls that were started by old code before a rolling deploy).
process.on('unhandledRejection', (reason) => {
  logger.error('[process] Unhandled promise rejection (non-fatal)', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Run if this is the main module
if (require.main === module) {
  main();
}
