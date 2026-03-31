const { Markup } = require('telegraf');
const { getDB } = require('../database');
const { getBlockchainManager } = require('../blockchain/manager');
const { performCoinFlip, formatAddress } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');
const ProfitShareHandler = require('./profitShareHandler');

// Minimum native balance (in display units) to always keep in the bot wallet for gas.
// Applies per-chain; irrelevant for ERC-20/SPL token flips.
const GAS_RESERVE = parseFloat(process.env.BOT_GAS_RESERVE || '0.1');

/**
 * For native-token flips, cap `amount` so the bot wallet always retains at least
 * GAS_RESERVE after the send. Returns the safe amount to send (may be 0).
 */
async function safeNativeAmount(network, amount) {
  if (isNaN(amount) || amount <= 0) return 0;
  try {
    const bm = getBlockchainManager();
    const handler = bm.getHandler(network);
    const botAddress = bm.getBotWalletAddress(network);
    const balObj = await handler.getNativeBalance(botAddress);
    const balance = parseFloat(balObj.formatted);
    const safe = balance - GAS_RESERVE;
    if (safe <= 0) return 0;
    return Math.min(amount, safe);
  } catch (err) {
    logger.warn('[safeNativeAmount] Could not check balance, sending as-is', { network, error: err.message });
    return amount;
  }
}

class ExecutionHandler {
  /**
   * Execute the coin flip once both deposits are confirmed
   */
  static async executeFlip(flipId, ctx, videoMessageId, videoReadyAt = null) {
    try {
      const { models } = getDB();
      const flip = await models.CoinFlip.findByPk(flipId);

      if (!flip || !flip.creatorDepositConfirmed || !flip.challengerDepositConfirmed) {
        logger.warn('Cannot execute flip - deposits not confirmed', { flipId });
        return;
      }

      logger.info('[executeFlip] Starting execution', { 
        flipId, 
        creatorId: flip.creatorId, 
        challengerId: flip.challengerId,
        status: flip.status 
      });

      // Update group message to show flip is executing
      try {
        await ctx.telegram.editMessageText(
          flip.groupChatId,
          flip.groupMessageId,
          null,
          `🎲 <b>Executing Flip...</b>\n\n` +
          `Both players confirmed deposits. Flipping coin...`,
          {
            parse_mode: 'HTML',
          }
        );
      } catch (err) {
        logger.warn('Failed to update group message for execution', { flipId, error: err.message });
      }

      // Fetch creator and challenger user records
      const creator = await models.User.findByPk(flip.creatorId);
      const challenger = await models.User.findByPk(flip.challengerId);

      logger.info('[executeFlip] User lookup complete', { 
        creatorFound: !!creator, 
        challengerFound: !!challenger,
        creatorId: flip.creatorId,
        challengerId: flip.challengerId
      });

      if (!creator || !challenger) {
        logger.warn('Creator or challenger user not found', { 
          flipId, 
          creatorId: flip.creatorId, 
          challengerId: flip.challengerId,
          creatorFound: !!creator,
          challengerFound: !!challenger
        });
        return;
      }

      // Perform coin flip (0 = creator wins, 1 = challenger wins)
      const result = performCoinFlip();
      const winnerId = result === 0 ? flip.creatorId : flip.challengerId;
      const flipResultEnum = result === 0 ? 'CREATOR' : 'CHALLENGER';
      const winnerDepositAddress = result === 0 ? flip.creatorDepositWalletAddress : flip.challengerDepositWalletAddress;
      const winnerName = result === 0 ? creator.firstName : challenger.firstName;

      // Calculate winnings
      const totalPool = parseFloat(flip.wagerAmount) * 2;
      const winnerPrize = totalPool * 0.9; // 90% to winner, 10% fees
      const winnerPrizeFormatted = winnerPrize.toLocaleString('en-US', { maximumFractionDigits: 6 });

      // Send winnings to winner automatically — retry up to 3 times with a 5-second delay
      let winningTxHash = null;
      const MAX_PAYOUT_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_PAYOUT_ATTEMPTS; attempt++) {
        try {
          const blockchainManager = getBlockchainManager();
          const sendResult = await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            flip.tokenAddress,
            winnerDepositAddress,
            winnerPrize.toString(),
            flip.tokenDecimals
          );
          winningTxHash = sendResult.txHash;
          logger.info('Winnings sent to winner', { flipId, winnerId, txHash: winningTxHash, amount: winnerPrize });
          break; // success — stop retrying
        } catch (sendError) {
          logger.error('Error sending winnings', { flipId, winnerId, attempt, maxAttempts: MAX_PAYOUT_ATTEMPTS, error: sendError.message });
          if (attempt < MAX_PAYOUT_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      // Send fees - split between $FLIP holder distribution pool (5%) and burn address (5%)
      const devFeeAmount = totalPool * 0.05;  // 5% to $FLIP holders
      const burnFeeAmount = totalPool * 0.05; // 5% to burn

      // Burn addresses for each network
      const burnAddress = flip.tokenNetwork === 'EVM'
        ? '0x000000000000000000000000000000000000dEaD' // EVM burn address (dead address)
        : '1nc1nerator11111111111111111111111111111111'; // Solana SPL incinerator address

      // Accumulate dev fee in DB immediately (fast DB write) so the midnight scheduler
      // always has an accurate pending amount even if the background send hasn't landed yet.
      try {
        await ProfitShareHandler.accumulateFee(
          flip.tokenAddress,
          flip.tokenSymbol,
          flip.tokenDecimals,
          devFeeAmount.toString(),
          flip.tokenNetwork === 'EVM' ? 'EVM' : 'Solana'
        );
        logger.info('[executeFlip] Dev fee accumulated for $FLIP distribution', { flipId, devFeeAmount, token: flip.tokenSymbol, network: flip.tokenNetwork });
      } catch (accErr) {
        logger.error('[executeFlip] ERROR accumulating dev fee', { flipId, error: accErr.message });
      }

      // Fire dev fee + burn fee sends in the background so they don't block the result message.
      // The winner already received their payout above — fees are housekeeping and can settle async.
      const devWalletAddress = flip.tokenNetwork === 'EVM' ? config.evm.devWallet : config.solana.devWallet;
      (async () => {
        try {
          if (devWalletAddress) {
            const blockchainManager = getBlockchainManager();
            const safeDevFee = flip.tokenAddress === 'NATIVE'
              ? await safeNativeAmount(flip.tokenNetwork, devFeeAmount)
              : devFeeAmount;
            if (safeDevFee > 0) {
              const devFeeTx = await blockchainManager.sendWinnings(
                flip.tokenNetwork,
                flip.tokenAddress,
                devWalletAddress,
                safeDevFee.toString(),
                flip.tokenDecimals
              );
              logger.info('[executeFlip] Dev fee sent to dev wallet', { flipId, devFeeAmount: safeDevFee, devWallet: devWalletAddress, txHash: devFeeTx.txHash });
            } else {
              logger.warn('[executeFlip] Skipped dev fee send — bot wallet below gas reserve', { flipId, devFeeAmount, gasReserve: GAS_RESERVE });
            }
          } else {
            logger.warn('[executeFlip] No dev wallet configured, skipping on-chain dev fee send', { flipId });
          }
        } catch (devFeeError) {
          logger.error('[executeFlip] ERROR processing dev fee', { flipId, devFeeAmount, error: devFeeError.message });
        }

        // Add delay before burn on Solana to avoid RPC rate limiting (429)
        if (flip.tokenNetwork === 'Solana') {
          logger.info('[executeFlip] Waiting 15s before burn fee to avoid RPC rate limit', { flipId });
          await new Promise(resolve => setTimeout(resolve, 15000));
        }

        try {
          const blockchainManager = getBlockchainManager();
          const safeBurnFee = flip.tokenAddress === 'NATIVE'
            ? await safeNativeAmount(flip.tokenNetwork, burnFeeAmount)
            : burnFeeAmount;
          const burnResult = await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            flip.tokenAddress,
            burnAddress,
            safeBurnFee.toString(),
            flip.tokenDecimals
          );
          logger.info('[executeFlip] Burn fee SENT', { flipId, burnAddress: `${burnAddress.substring(0, 10)}...`, txHash: burnResult.txHash, amount: safeBurnFee });
        } catch (burnFeeError) {
          logger.error('[executeFlip] ERROR SENDING BURN FEE (attempt 1)', { flipId, burnAddress, burnFeeAmount, error: burnFeeError.message });
          // Retry once after a delay
          const retryDelay = flip.tokenNetwork === 'Solana' ? 20000 : 5000;
          await new Promise(r => setTimeout(r, retryDelay));
          try {
            const blockchainManager = getBlockchainManager();
            const burnRetry = await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              flip.tokenAddress,
              burnAddress,
              burnFeeAmount.toString(),
              flip.tokenDecimals
            );
            logger.info('[executeFlip] Burn fee SENT (retry)', { flipId, txHash: burnRetry.txHash, amount: burnFeeAmount });
          } catch (burnRetryError) {
            logger.error('[executeFlip] ERROR SENDING BURN FEE (retry failed)', { flipId, burnAddress, burnFeeAmount, error: burnRetryError.message });
          }
        }
      })().catch(err => logger.error('[executeFlip] Unhandled error in background fee send', { flipId, error: err.message }));

      // Update flip record with result
      flip.flipResult = flipResultEnum;
      flip.winnerId = winnerId;
      flip.winningTxHash = winningTxHash;
      // Only mark as claimed if the payout transaction actually landed.
      // If sendWinnings threw and winningTxHash is null, leave claimedByWinner=false
      // so the winner can still use the manual claim flow to recover their funds.
      flip.claimedByWinner = winningTxHash !== null;
      flip.status = 'COMPLETED';
      // Clear deposit wallet addresses and accumulated amounts for next session
      flip.creatorDepositWalletAddress = null;
      flip.challengerDepositWalletAddress = null;
      flip.creatorAccumulatedDeposit = 0;
      flip.challengerAccumulatedDeposit = 0;
      await flip.save();

      // Update winner's stats
      const winner = result === 0 ? creator : challenger;
      const loser = result === 0 ? challenger : creator;
      
      if (winner) {
        try {
          winner.totalWon = (parseFloat(winner.totalWon || 0) + parseFloat(winnerPrize)).toString();
          winner.totalWagered = (parseFloat(winner.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await winner.save();
          logger.info('[executeFlip] Winner stats updated', { flipId, winnerId, totalWon: winner.totalWon, totalWagered: winner.totalWagered, winnerPrize });
        } catch (statsErr) {
          logger.error('[executeFlip] Error updating winner stats', { flipId, winnerId, error: statsErr.message });
        }
      }

      // Update loser's stats (only totalWagered, no winnings)
      if (loser) {
        try {
          loser.totalWagered = (parseFloat(loser.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await loser.save();
          logger.info('[executeFlip] Loser stats updated', { flipId, loserId: loser.telegramId, totalWagered: loser.totalWagered });
        } catch (statsErr) {
          logger.error('[executeFlip] Error updating loser stats', { flipId, loserId: loser.telegramId, error: statsErr.message });
        }
      }

      // Generate transaction link based on network
      const txLink = flip.tokenNetwork === 'EVM'
        ? `https://paxscan.io/tx/${winningTxHash}`
        : `https://solscan.io/tx/${winningTxHash}`;

      // Send result to group chat by editing the existing message
      const txLinkMessage = winningTxHash 
        ? `\n🔗 <a href="${txLink}">View Transaction</a>`
        : `\n⏳ Processing winnings...`;

      const flipBuyButton = {
        inline_keyboard: [[
          { text: '💎 BUY $FLIP', url: 'https://sidiora.fun/token/0xA0Cd0F92f12f881aeBaFF9e0fb3144511c9ebF6c' }
        ]]
      };

      const resultMessageText = 
        `🎲 <b>FLIP RESULT: ${winnerName.toUpperCase()} WINS! 🎉</b>\n\n` +
        `💰 <b>Winnings: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90%)</b>\n` +
        `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
        `⚡ Fees: 10% (5% $FLIP holders + 5% burn)${txLinkMessage}\n\n` +
        `💎 Share in the profits from this bot by holding $FLIP`;

      const fs = require('fs');
      const path = require('path');
      const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');

      try {
        // Wait for the video to finish playing before showing the result,
        // then delete it and reveal the result in one smooth step
        if (videoReadyAt) {
          const remaining = videoReadyAt - Date.now();
          if (remaining > 0) {
            logger.info('Waiting for video to finish before showing result', { flipId, remainingMs: remaining });
            await new Promise(r => setTimeout(r, remaining));
          }
        }
        if (videoMessageId) {
          try {
            await ctx.telegram.deleteMessage(flip.groupChatId, videoMessageId);
            logger.info('Deleted video message, revealing result now', { flipId, videoMessageId });
          } catch (deleteErr) {
            logger.warn('Failed to delete video message', { flipId, videoMessageId, error: deleteErr.message });
          }
        }

        // Try to send with image first
        if (fs.existsSync(imagePath)) {
          try {
            await ctx.telegram.sendPhoto(
              flip.groupChatId,
              { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
              {
                caption: resultMessageText,
                parse_mode: 'HTML',
                reply_markup: flipBuyButton,
              }
            );
          } catch (photoErr) {
            logger.warn('Failed to send result photo, falling back to text edit', { flipId, error: photoErr.message });
            // Fallback to editing existing message
            await ctx.telegram.editMessageText(
              flip.groupChatId,
              flip.groupMessageId,
              null,
              resultMessageText,
              {
                parse_mode: 'HTML',
                reply_markup: flipBuyButton,
              }
            );
          }
        } else {
          // Image not found, just edit existing message
          await ctx.telegram.editMessageText(
            flip.groupChatId,
            flip.groupMessageId,
            null,
            resultMessageText,
            {
              parse_mode: 'HTML',
              reply_markup: flipBuyButton,
            }
          );
        }

      } catch (editErr) {
        logger.warn('Failed to send flip result to group', { flipId, error: editErr.message });
        // Last fallback: send a new message if everything fails
        try {
          await ctx.telegram.sendMessage(
            flip.groupChatId,
            resultMessageText,
            {
              parse_mode: 'HTML',
              reply_markup: flipBuyButton,
            }
          );
          
          // Delete the video message now that result is displayed
          if (videoMessageId) {
            try {
              await ctx.telegram.deleteMessage(flip.groupChatId, videoMessageId);
              logger.info('Deleted video message after flip result', { flipId, videoMessageId });
            } catch (deleteErr) {
              logger.warn('Failed to delete video message', { flipId, videoMessageId, error: deleteErr.message });
            }
          }
        } catch (err) {
          logger.error('Failed to send flip result to group', { flipId, error: err.message });
        }
      }

      // If transaction is pending, edit the message after a delay to show the link once it completes
      if (!winningTxHash && flip.groupMessageId) {
        setTimeout(async () => {
          try {
            // Re-fetch flip to get updated tx hash
            const { models } = getDB();
            const updatedFlip = await models.CoinFlip.findByPk(flipId);
            
            if (updatedFlip && updatedFlip.winningTxHash) {
              const txLinkUpdated = updatedFlip.tokenNetwork === 'EVM'
                ? `https://paxscan.io/tx/${updatedFlip.winningTxHash}`
                : `https://solscan.io/tx/${updatedFlip.winningTxHash}`;
              
              const updatedMessage = 
                `🎲 <b>FLIP RESULT: ${winnerName.toUpperCase()} WINS! 🎉</b>\n\n` +
                `💰 <b>Winnings: ${winnerPrizeFormatted} ${flip.tokenSymbol} (90%)</b>\n` +
                `📊 Total Pool: ${totalPool.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${flip.tokenSymbol}\n` +
                `⚡ Fees: 10% (5% $FLIP holders + 5% burn)\n🔗 <a href="${txLinkUpdated}">View Transaction</a>\n\n` +
                `💎 Share in the profits from this bot by holding $FLIP`;
              
              await ctx.telegram.editMessageText(
                flip.groupChatId,
                flip.groupMessageId,
                null,
                updatedMessage,
                {
                  parse_mode: 'HTML',
                  reply_markup: flipBuyButton,
                }
              );
              logger.info('Updated flip result message with transaction link', { flipId, txHash: updatedFlip.winningTxHash });
            }
          } catch (err) {
            logger.warn('Failed to update flip result with transaction link', { flipId, error: err.message });
          }
        }, 3000); // Wait 3 seconds then check for tx link
      }

      // Notify winner in DM
      await ctx.telegram.sendMessage(
        winnerId,
        `🎉 <b>CONGRATULATIONS!</b>\n\n` +
        `You won ${winnerPrizeFormatted} ${flip.tokenSymbol} (90% of pool)!\n\n` +
        (winningTxHash 
          ? `✅ Winnings sent automatically!\n🔗 <a href="${txLink}">View Transaction</a>`
          : `⏳ Processing your winnings... You'll receive them shortly.`),
        { parse_mode: 'HTML' }
      );

      logger.info('Flip executed successfully', { flipId, result: flipResultEnum, winnerId, winnerName, txHash: winningTxHash });
    } catch (error) {
      logger.error('Error executing flip', { 
        flipId,
        message: error.message, 
        stack: error.stack,
        error: error.toString()
      });
    }
  }

  /**
   * Process claim winnings request
   */
  static async claimWinnings(ctx, flipId) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip expired.');
        return;
      }

      if (flip.winnerId !== userId) {
        await ctx.answerCbQuery('❌ Only the winner can claim.');
        return;
      }

      if (flip.claimedByWinner) {
        await ctx.answerCbQuery('✅ Winnings already claimed.');
        return;
      }

      // Create session for payout
      const session = await models.BotSession.create({
        userId,
        coinFlipId: flipId,
        sessionType: 'CLAIMING_WINNINGS',
        currentStep: 'GETTING_ADDRESS',
        data: { flipId },
      });

      // Send DM asking for wallet address
      const totalPool = flip.wagerAmount * 2;
      const winnerPrize = (totalPool * 0.9).toFixed(flip.tokenDecimals);
      
      await ctx.telegram.sendMessage(
        userId,
        `💰 <b>Claim Your Winnings!</b>\n\n` +
        `Amount: <b>${winnerPrize} ${flip.tokenSymbol} (90% of pool)</b>\n\n` +
        `Please reply with your ${flip.tokenNetwork} wallet address.`,
        { parse_mode: 'HTML' }
      );

      await ctx.answerCbQuery('✅ Check your DMs to claim winnings!');

      logger.info('Claim winnings initiated', { userId, flipId });
    } catch (error) {
      logger.error('Error claiming winnings', error);
      await ctx.answerCbQuery('❌ Error processing claim.');
    }
  }

  /**
   * Process wallet address for payout
   */
  static async processPayoutAddress(ctx) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;
      const walletAddress = ctx.message.text.trim();

      // Find active claiming session
      const session = await models.BotSession.findOne({
        where: { userId, sessionType: 'CLAIMING_WINNINGS' },
        order: [['createdAt', 'DESC']],
      });

      if (!session || !session.data.flipId) {
        await ctx.reply('❌ No active claim session.');
        return;
      }

      const flip = await models.CoinFlip.findByPk(session.data.flipId);
      if (!flip) {
        await ctx.reply('❌ Flip not found.');
        return;
      }

      // Validate wallet address
      const blockchainManager = getBlockchainManager();
      if (!blockchainManager.isValidAddress(flip.tokenNetwork, walletAddress)) {
        await ctx.reply(
          `❌ Invalid ${flip.tokenNetwork} wallet address.\n\n` +
          `Please reply with a valid address.`
        );
        return;
      }

      // Send payout from bot wallet
      await ctx.reply(`⏳ Processing payout...`);

      const totalPool = parseFloat(flip.wagerAmount) * 2;
      const winnerAmount = (totalPool * 0.9).toFixed(flip.tokenDecimals);
      const devAmount = (totalPool * 0.05).toFixed(flip.tokenDecimals);
      const burnAmount = (totalPool * 0.05).toFixed(flip.tokenDecimals);

      const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);

      // Get burn address for this network
      const burnAddress = flip.tokenNetwork === 'EVM'
        ? '0x000000000000000000000000000000000000dEaD' // EVM burn address (dead address)
        : '1nc1nerator11111111111111111111111111111111'; // Solana SPL incinerator address

      // Send winner payout (90%)
      const winnerTx = await blockchainManager.sendWinnings(
        flip.tokenNetwork,
        flip.tokenAddress,
        walletAddress,
        winnerAmount,
        flip.tokenDecimals
      );

      // Fire-and-forget: dev fee and burn fee sends — do NOT block the payout reply
      (async () => {
        // Send 5% dev fee to dev wallet on-chain, then accumulate in DB for midnight distribution
        const devWallet = flip.tokenNetwork === 'EVM' ? config.evm.devWallet : config.solana.devWallet;
        let devTx = null;
        try {
          if (devWallet) {
            // For native tokens, cap the send to preserve gas reserve in the bot wallet
            const safeDevAmount = flip.tokenAddress === 'NATIVE'
              ? await safeNativeAmount(flip.tokenNetwork, parseFloat(devAmount))
              : parseFloat(devAmount);
            if (safeDevAmount > 0) {
              devTx = await blockchainManager.sendWinnings(
                flip.tokenNetwork,
                flip.tokenAddress,
                devWallet,
                safeDevAmount.toFixed(flip.tokenDecimals),
                flip.tokenDecimals
              );
              logger.info('[confirmPayoutAddress] Dev fee sent to dev wallet', { flipId, amount: safeDevAmount, devWallet, txHash: devTx.txHash });
            } else {
              logger.warn('[confirmPayoutAddress] Skipped dev fee send — bot wallet below gas reserve', { flipId, devAmount, gasReserve: GAS_RESERVE });
            }
          } else {
            logger.warn('[confirmPayoutAddress] No dev wallet configured, skipping on-chain dev fee send', { flipId });
          }
          // Accumulate in DB so the midnight scheduler knows how much to distribute
          await ProfitShareHandler.accumulateFee(
            flip.tokenAddress,
            flip.tokenSymbol,
            flip.tokenDecimals,
            devAmount,
            flip.tokenNetwork === 'EVM' ? 'EVM' : 'Solana'
          );
          logger.info('[confirmPayoutAddress] Dev fee accumulated for $FLIP distribution', { flipId, amount: devAmount, token: flip.tokenSymbol, network: flip.tokenNetwork });
        } catch (devFeeError) {
          logger.error('[confirmPayoutAddress] ERROR processing dev fee', { flipId, devAmount, error: devFeeError.message });
        }

        // Send burn fee (5%)
        let burnTx = null;
        try {
          if (flip.tokenNetwork === 'Solana') await new Promise(r => setTimeout(r, 15000));
          // For native tokens, cap the send to preserve gas reserve
          const safeBurnAmount = flip.tokenAddress === 'NATIVE'
            ? await safeNativeAmount(flip.tokenNetwork, parseFloat(burnAmount))
            : parseFloat(burnAmount);
          burnTx = await blockchainManager.sendWinnings(
            flip.tokenNetwork,
            flip.tokenAddress,
            burnAddress,
            safeBurnAmount.toFixed(flip.tokenDecimals),
            flip.tokenDecimals
          );
        } catch (burnFeeError) {
          logger.error('[confirmPayoutAddress] ERROR SENDING BURN FEE (attempt 1)', { flipId, burnAddress, burnAmount, error: burnFeeError.message });
          // Retry once after a longer delay
          if (flip.tokenNetwork === 'Solana') {
            logger.info('[confirmPayoutAddress] Retrying burn fee after 20s', { flipId });
            await new Promise(r => setTimeout(r, 20000));
            try {
              burnTx = await blockchainManager.sendWinnings(
                flip.tokenNetwork,
                flip.tokenAddress,
                burnAddress,
                burnAmount,
                flip.tokenDecimals
              );
            } catch (burnRetryError) {
              logger.error('[confirmPayoutAddress] ERROR SENDING BURN FEE (retry failed)', { flipId, burnAddress, burnAmount, error: burnRetryError.message });
            }
          }
        }

        // Record fee transactions
        try {
          if (devTx) {
            await models.Transaction.create({
              coinFlipId: flip.id,
              userId: null,
              type: 'FEE_DEV',
              network: flip.tokenNetwork,
              tokenAddress: flip.tokenAddress,
              tokenSymbol: flip.tokenSymbol,
              amount: devAmount,
              fromAddress: botWalletAddress,
              toAddress: devWallet,
              txHash: devTx.txHash,
              status: 'CONFIRMED',
            });
          }
          if (burnTx) {
            await models.Transaction.create({
              coinFlipId: flip.id,
              userId: null,
              type: 'FEE_BURN',
              network: flip.tokenNetwork,
              tokenAddress: flip.tokenAddress,
              tokenSymbol: flip.tokenSymbol,
              amount: burnAmount,
              fromAddress: botWalletAddress,
              toAddress: burnAddress,
              txHash: burnTx.txHash,
              status: 'CONFIRMED',
            });
          }
        } catch (feeRecordError) {
          logger.error('[confirmPayoutAddress] Error recording fee transactions', { flipId, error: feeRecordError.message });
        }
      })().catch(err => logger.error('[confirmPayoutAddress] Unhandled error in background fee send', { flipId, error: err.message }));

      try {
        // Record winner transaction
        await models.Transaction.create({
          coinFlipId: flip.id,
          userId,
          type: 'PAYOUT',
          network: flip.tokenNetwork,
          tokenAddress: flip.tokenAddress,
          tokenSymbol: flip.tokenSymbol,
          amount: winnerAmount,
          fromAddress: botWalletAddress,
          toAddress: walletAddress,
          txHash: winnerTx.txHash,
          status: 'CONFIRMED',
        });

        // Mark as claimed
        flip.claimedByWinner = true;
        flip.winningTxHash = winnerTx.txHash;
        flip.status = 'COMPLETED';
        // Clear deposit wallet addresses and accumulated amounts for next session
        flip.creatorDepositWalletAddress = null;
        flip.challengerDepositWalletAddress = null;
        flip.creatorAccumulatedDeposit = 0;
        flip.challengerAccumulatedDeposit = 0;
        await flip.save();

        // Update user stats
        const user = await models.User.findByPk(userId);
        const otherPlayerId = userId === flip.creatorId ? flip.challengerId : flip.creatorId;
        const otherPlayer = await models.User.findByPk(otherPlayerId);
        
        if (user) {
          user.totalWon = (parseFloat(user.totalWon || 0) + parseFloat(winnerAmount)).toString();
          user.totalWagered = (parseFloat(user.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await user.save();
          logger.info('[confirmPayoutAddress] Winner stats updated', { userId, flipId, totalWon: user.totalWon, totalWagered: user.totalWagered });
        }

        // Update loser's stats
        if (otherPlayer) {
          otherPlayer.totalWagered = (parseFloat(otherPlayer.totalWagered || 0) + parseFloat(flip.wagerAmount)).toString();
          await otherPlayer.save();
          logger.info('[confirmPayoutAddress] Loser stats updated', { loserId: otherPlayerId, flipId, totalWagered: otherPlayer.totalWagered });
        }

        // Update session
        session.currentStep = 'PAYOUT_COMPLETE';
        await session.save();

        await ctx.reply(
          `✅ <b>Payout Complete!</b>\n\n` +
          `Your Winnings (90%): <b>${winnerAmount} ${flip.tokenSymbol}</b>\n` +
          `Tx: <code>${winnerTx.txHash}</code>\n\n` +
          `📊 <b>Fee Distribution:</b>\n` +
          `Dev Fee (5%): ${devAmount} ${flip.tokenSymbol}\n` +
          `Burn Fee (5%): ${burnAmount} ${flip.tokenSymbol}`,
          { parse_mode: 'HTML' }
        );

        logger.info('Payout processed', { userId, flipId, txHash: winnerTx.txHash });
      } catch (payoutError) {
        logger.error('Payout failed', payoutError);
        await ctx.reply(
          `❌ Payout failed: ${payoutError.message}\n\n` +
          `Please contact support.`
        );
      }
    } catch (error) {
      logger.error('Error processing payout address', error);
      await ctx.reply('❌ Error processing payout.');
    }
  }

  /**
   * Cancel flip (creator only, if no challenger yet)
   */
  static async cancelFlip(ctx, flipId) {
    try {
      const { models } = getDB();
      const userId = ctx.from.id;

      const flip = await models.CoinFlip.findByPk(flipId);
      if (!flip) {
        await ctx.answerCbQuery('❌ Flip not found.');
        return;
      }

      if (flip.creatorId !== userId) {
        await ctx.answerCbQuery('❌ Only creator can cancel.');
        return;
      }

      if (flip.challengerId !== null) {
        await ctx.answerCbQuery('❌ Cannot cancel with an active challenger.');
        return;
      }

      // Refund deposit to creator if confirmed
      if (flip.creatorDepositConfirmed) {
        const blockchainManager = getBlockchainManager();
        const user = await models.User.findByPk(userId);

        if (user.walletAddress) {
          try {
            await blockchainManager.sendWinnings(
              flip.tokenNetwork,
              flip.tokenAddress,
              user.walletAddress,
              flip.wagerAmount,
              flip.tokenDecimals
            );
          } catch (error) {
            logger.error('Error refunding deposit on cancel', error);
          }
        }
      }

      // Update flip status
      flip.status = 'CANCELLED';
      // Clear deposit wallet addresses and accumulated amounts
      flip.creatorDepositWalletAddress = null;
      flip.challengerDepositWalletAddress = null;
      flip.creatorAccumulatedDeposit = 0;
      flip.challengerAccumulatedDeposit = 0;
      await flip.save();

      await ctx.answerCbQuery('✅ Flip cancelled.');
      await ctx.editMessageText('❌ This flip has been cancelled.');

      logger.info('Flip cancelled by creator', { userId, flipId });
    } catch (error) {
      logger.error('Error cancelling flip', error);
      await ctx.answerCbQuery('❌ Error cancelling flip.');
    }
  }
}

module.exports = ExecutionHandler;
