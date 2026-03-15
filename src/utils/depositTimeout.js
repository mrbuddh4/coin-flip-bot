const logger = require('./logger');

// In-memory map of flipId -> timeout handle for challenger deposit timeouts
const depositTimeouts = {};

/**
 * Set a 3-minute challenger deposit timeout. Cancels flip, refunds creator, and notifies users on expiry.
 * @param {string} flipId 
 * @param {object} telegram - Telegraf telegram instance for sending messages
 * @param {number} timeoutMs - timeout in milliseconds (default 180000 = 3 minutes)
 */
function setDepositTimeout(flipId, telegram, timeoutMs = 180000) {
  clearDepositTimeout(flipId);

  depositTimeouts[flipId] = setTimeout(async () => {
    delete depositTimeouts[flipId];
    try {
      // Lazy requires to avoid circular dependencies
      const { getDB } = require('../database');
      const { getBlockchainManager } = require('../blockchain/manager');
      const config = require('../config');
      const { models } = getDB();

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        logger.info('[depositTimeout] Flip not found', { flipId });
        return;
      }

      if (flip.status !== 'WAITING_CHALLENGER_DEPOSIT' || flip.challengerDepositConfirmed) {
        logger.info('[depositTimeout] Flip no longer waiting for challenger deposit, skipping', { flipId, status: flip.status });
        return;
      }

      logger.info('[depositTimeout] Challenger deposit timeout expired, cancelling flip', { flipId });

      flip.challengerTimedOut = true;
      flip.status = 'CANCELLED';
      flip.data = { ...flip.data, cancelReason: 'Challenger did not deposit within 3 minutes' };
      await flip.save();

      // Refund creator's deposit (creator already deposited before challenger was matched)
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

          await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            tokenAddress,
            flip.creatorDepositWalletAddress,
            parseFloat(flip.wagerAmount),
            tokenDecimals
          );

          logger.info('[depositTimeout] Refunded creator deposit', {
            flipId,
            amount: flip.wagerAmount,
            to: flip.creatorDepositWalletAddress,
          });
        } catch (refundErr) {
          logger.error('[depositTimeout] Failed to refund creator deposit', { flipId, error: refundErr.message });
        }
      }

      // Refund any partial challenger deposit
      if (flip.challengerDepositWalletAddress && parseFloat(flip.challengerAccumulatedDeposit || 0) > 0) {
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

          await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            tokenAddress,
            flip.challengerDepositWalletAddress,
            parseFloat(flip.challengerAccumulatedDeposit),
            tokenDecimals
          );

          logger.info('[depositTimeout] Refunded partial challenger deposit', {
            flipId,
            amount: flip.challengerAccumulatedDeposit,
            to: flip.challengerDepositWalletAddress,
          });
        } catch (refundErr) {
          logger.error('[depositTimeout] Failed to refund challenger partial deposit', { flipId, error: refundErr.message });
        }
      }

      const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

      // Notify challenger via DM
      if (flip.challengerId) {
        try {
          await telegram.sendMessage(
            flip.challengerId,
            `⏰ <b>Deposit Timeout</b>\n\n` +
            `You didn't deposit within 3 minutes. The challenge for <b>${formattedWager} ${flip.tokenSymbol}</b> has been cancelled.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('[depositTimeout] Failed to notify challenger', { flipId, error: err.message });
        }
      }

      // Notify creator via DM
      if (flip.creatorId) {
        try {
          await telegram.sendMessage(
            flip.creatorId,
            `⏰ <b>Challenge Cancelled</b>\n\n` +
            `The challenger didn't deposit within 3 minutes. The challenge for <b>${formattedWager} ${flip.tokenSymbol}</b> has been cancelled.\n\n` +
            (flip.creatorDepositConfirmed ? `💸 Your deposit is being refunded.` : ``),
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('[depositTimeout] Failed to notify creator', { flipId, error: err.message });
        }
      }

      // Notify group
      if (flip.groupChatId) {
        try {
          await telegram.sendMessage(
            flip.groupChatId,
            `❌ <b>Challenge Cancelled</b>\n\n` +
            `The challenger didn't deposit within 3 minutes. The <b>${formattedWager} ${flip.tokenSymbol}</b> challenge has been cancelled.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.warn('[depositTimeout] Failed to notify group', { flipId, error: err.message });
        }
      }
    } catch (err) {
      logger.error('[depositTimeout] Error in timeout handler', { flipId, error: err.message });
    }
  }, timeoutMs);

  logger.info('[depositTimeout] Set challenger deposit timeout', { flipId, timeoutMs });
}

/**
 * Clear a challenger deposit timeout (e.g. when deposit is confirmed)
 * @param {string} flipId 
 */
function clearDepositTimeout(flipId) {
  if (depositTimeouts[flipId]) {
    clearTimeout(depositTimeouts[flipId]);
    delete depositTimeouts[flipId];
    logger.info('[depositTimeout] Cleared challenger deposit timeout', { flipId });
  }
}

module.exports = { setDepositTimeout, clearDepositTimeout, depositTimeouts };
