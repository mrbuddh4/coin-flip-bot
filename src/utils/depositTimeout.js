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

  // Send a 1-minute warning to the group at the 2/3 mark
  const warnMs = Math.floor(timeoutMs * (2 / 3));
  const warnTimer = setTimeout(async () => {
    try {
      const { getDB } = require('../database');
      const { models } = getDB();
      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip || flip.status !== 'WAITING_CHALLENGER_DEPOSIT' || flip.challengerDepositConfirmed) return;

      const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });
      const challenger = await models.User.findByPk(flip.challengerId);
      const challengerDisplay = challenger?.username ? `@${challenger.username}` : challenger?.firstName || 'Challenger';

      if (flip.groupChatId) {
        await telegram.sendMessage(
          flip.groupChatId,
          `⏰ <b>Deposit Reminder</b>\n\n` +
          `${challengerDisplay} — you have <b>1 minute</b> left to send your <b>${formattedWager} ${flip.tokenSymbol}</b> deposit, or the challenge will be cancelled!`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } catch (_) {}
  }, warnMs);

  // Store warn timer so it can be cancelled if deposit arrives in time
  depositTimeouts[`${flipId}_warn`] = warnTimer;

  depositTimeouts[flipId] = setTimeout(async () => {
    // Cancel the warn timer if it somehow hasn't fired yet
    clearTimeout(depositTimeouts[`${flipId}_warn`]);
    delete depositTimeouts[`${flipId}_warn`];
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
          const tokenAddress = flip.tokenAddress || 'NATIVE';
          const tokenDecimals = flip.tokenDecimals || 18;

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
          const tokenAddress = flip.tokenAddress || 'NATIVE';
          const tokenDecimals = flip.tokenDecimals || 18;

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

      // Only shame if the bot never detected any deposit from the challenger.
      // If challengerAccumulatedDeposit > 0, they genuinely tried but the bot
      // may have had a detection issue — don't publicly shame them for that.
      const neverDepositedAnything = parseFloat(flip.challengerAccumulatedDeposit || 0) === 0;

      // For EVM flips where the bot saw nothing: do a definitive on-chain check.
      // This lets us distinguish "truly never sent anything" from "bot had a detection failure".
      let onChainDepositFound = false;
      let missedDepositRefundAddr = null; // challenger's wallet address if we need to refund a missed deposit
      if (neverDepositedAnything && flip.tokenNetwork === 'EVM' && flip.challengerId) {
        try {
          const { ethers } = require('ethers');
          const config = require('../config');
          const { getDB } = require('../database');
          const { models: checkModels } = getDB();
          const { getBlockchainManager } = require('../blockchain/manager');

          // Determine which wallet address the challenger sends FROM
          const challengerProfile = await checkModels.UserProfile.findByPk(flip.challengerId);
          const senderAddr = flip.challengerDepositWalletAddress
            || challengerProfile?.evmDepositWalletAddress;
          if (senderAddr) missedDepositRefundAddr = senderAddr;

          if (senderAddr) {
            const blockchainManager = getBlockchainManager();
            const botWallet = blockchainManager.getBotWalletAddress('EVM');
            const provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);
            const latestBlock = await provider.getBlockNumber();
            // Use flip.createdAt to scope the search window to just after the flip
            // was created. latestBlock - 999 is too wide and picks up transactions
            // from previous flips the same user made, which falsely suppresses shame.
            const secondsSinceCreate = Math.floor((Date.now() - new Date(flip.createdAt).getTime()) / 1000);
            const PAXEER_BLOCK_TIME_SECS = 0.3; // ~3 blocks/sec on Paxeer mainnet
            const blocksSinceCreate = Math.ceil(secondsSinceCreate / PAXEER_BLOCK_TIME_SECS);
            const fromBlock = Math.max(0, latestBlock - blocksSinceCreate - 300); // 300-block safety buffer

            const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
            const senderTopic = ethers.zeroPadValue(senderAddr.toLowerCase(), 32);
            const recipientTopic = ethers.zeroPadValue(botWallet.toLowerCase(), 32);

            // Check ERC-20 token transfers
            if (flip.tokenAddress && flip.tokenAddress !== 'NATIVE') {
              const tokenLogs = await provider.getLogs({
                address: flip.tokenAddress,
                topics: [TRANSFER_TOPIC, senderTopic, recipientTopic],
                fromBlock,
                toBlock: latestBlock,
              }).catch(() => []);
              if (tokenLogs.length > 0) onChainDepositFound = true;
            }

            // For native PAX, eth_getLogs has no Transfer events — query Paxscan txlist instead.
            // For any ERC-20 fallback (wrong token scenario), also check all Transfer logs.
            if (!onChainDepositFound) {
              if (flip.tokenAddress === 'NATIVE') {
                // Native PAX: use Paxscan txlist API to find value-bearing transactions
                try {
                  const PAXSCAN_API = 'https://paxscan.paxeer.app/api';
                  const paxscanUrl = `${PAXSCAN_API}?module=account&action=txlist&address=${botWallet}&startblock=${fromBlock}&endblock=999999999&sort=desc`;
                  const resp = await fetch(paxscanUrl);
                  const data = await resp.json();
                  if (data.status === '1' && Array.isArray(data.result)) {
                    const lowerSender = senderAddr.toLowerCase();
                    onChainDepositFound = data.result.some(tx =>
                      tx.from?.toLowerCase() === lowerSender && BigInt(tx.value || '0') > 0n
                    );
                  }
                } catch (_) {
                  // Paxscan unavailable — err on the side of caution (no shame)
                  onChainDepositFound = true;
                }
              } else {
                // Catch any ERC-20 transfer *to* the bot from this sender (wrong token scenario)
                const anyTransferLogs = await provider.getLogs({
                  topics: [TRANSFER_TOPIC, senderTopic, recipientTopic],
                  fromBlock,
                  toBlock: latestBlock,
                }).catch(() => []);
                if (anyTransferLogs.length > 0) onChainDepositFound = true;
              }
            }

            logger.info('[depositTimeout] On-chain deposit check', {
              flipId,
              senderAddr,
              botWallet,
              fromBlock,
              onChainDepositFound,
            });
          }
        } catch (chainCheckErr) {
          // If the on-chain check itself fails, err on the side of caution and skip shame
          logger.warn('[depositTimeout] On-chain deposit check failed, skipping shame to be safe', { flipId, error: chainCheckErr.message });
          onChainDepositFound = true; // treat as "unclear" → no shame
        }
      }

      const confirmedClickWithoutFunds = neverDepositedAnything && !onChainDepositFound;

      // If the on-chain check found a deposit the bot missed, refund the challenger and alert them
      if (neverDepositedAnything && onChainDepositFound) {
        logger.warn('[depositTimeout] On-chain deposit found but bot missed it — possible detection failure', { flipId, challengerId: flip.challengerId });

        // Refund the full wager to the challenger since we confirmed their deposit arrived
        if (missedDepositRefundAddr) {
          try {
            const blockchainManager = getBlockchainManager();
            const tokenAddress = flip.tokenAddress || 'NATIVE';
            const tokenDecimals = flip.tokenDecimals || 18;
            await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              tokenAddress,
              missedDepositRefundAddr,
              parseFloat(flip.wagerAmount),
              tokenDecimals
            );
            logger.info('[depositTimeout] Refunded missed challenger deposit', {
              flipId,
              amount: flip.wagerAmount,
              to: missedDepositRefundAddr,
            });
          } catch (refundErr) {
            logger.error('[depositTimeout] Failed to refund missed challenger deposit', { flipId, error: refundErr.message });
          }
        }

        if (flip.challengerId) {
          try {
            await telegram.sendMessage(
              flip.challengerId,
              `⚠️ <b>Deposit Detection Issue</b>\n\n` +
              `We detected a possible issue verifying your deposit for the <b>${formattedWager} ${flip.tokenSymbol}</b> challenge.\n\n` +
              `The challenge has been cancelled and your deposit is being refunded. If you do not receive your funds within 10 minutes, please contact support.`,
              { parse_mode: 'HTML' }
            );
          } catch (_) {}
        }
      }

      // Stamp the flip so /wallofshame can count only positively-confirmed cases
      if (confirmedClickWithoutFunds) {
        flip.confirmedShame = true;
        await flip.save();
      }

      // Notify group with shame message only for confirmed click-without-funds
      if (flip.groupChatId && confirmedClickWithoutFunds) {
        try {
          const { getDB } = require('../database');
          const { models: shameModels } = getDB();
          const challenger = await shameModels.User.findByPk(flip.challengerId);
          const challengerDisplay = challenger?.username
            ? `@${challenger.username}`
            : challenger?.firstName || 'The challenger';

          const shameLines = [
            `😂 <b>CLICK WITHOUT FUNDS DETECTED!</b>`,
            `😹 <b>ALL BARK, NO BITE!</b>`,
            `🤡 <b>WINDOW SHOPPER ALERT!</b>`,
            `💀 <b>BROKE BOT CAUGHT!</b>`,
            `🫵 <b>ANOTHER ONE BITES THE DUST!</b>`,
          ];
          const shameLine = shameLines[Math.floor(Math.random() * shameLines.length)];

          await telegram.sendMessage(
            flip.groupChatId,
            `${shameLine}\n\n` +
            `${challengerDisplay} accepted the <b>${formattedWager} ${flip.tokenSymbol}</b> challenge ` +
            `but couldn't back it up with funds. The challenge has been cancelled.\n\n` +
            `🏃‍♂️ <i>A shame for those that click without funds!</i>`,
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
  if (depositTimeouts[`${flipId}_warn`]) {
    clearTimeout(depositTimeouts[`${flipId}_warn`]);
    delete depositTimeouts[`${flipId}_warn`];
  }
  if (depositTimeouts[flipId]) {
    clearTimeout(depositTimeouts[flipId]);
    delete depositTimeouts[flipId];
    logger.info('[depositTimeout] Cleared challenger deposit timeout', { flipId });
  }
}

module.exports = { setDepositTimeout, clearDepositTimeout, depositTimeouts };
