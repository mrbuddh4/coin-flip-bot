const { Markup } = require('telegraf');
const { getDB } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class LeaderboardHandler {
  /**
   * Show leaderboard with top winners and losers
   */
  static async showLeaderboard(ctx) {
    try {
      const { models } = getDB();

      logger.info('[leaderboard] Fetching top 5 winners and losers', { userId: ctx.from.id });

      // Get top 5 winners (by totalWon)
      const topWinners = await models.User.findAll({
        attributes: ['telegramId', 'firstName', 'username', 'totalWon', 'totalWagered'],
        where: {
          totalWon: {
            [Op.gt]: 0,
          },
        },
        order: [['totalWon', 'DESC']],
        limit: 5,
      });

      // Get top 5 biggest losers (by losses = totalWagered - totalWon)
      const allUsers = await models.User.findAll({
        attributes: ['telegramId', 'firstName', 'username', 'totalWon', 'totalWagered'],
        where: {
          totalWagered: {
            [Op.gt]: 0,
          },
        },
        raw: true,
      });

      // Calculate losses for each user and sort
      const usersWithLosses = allUsers
        .map(user => ({
          ...user,
          losses: parseFloat(user.totalWagered) - parseFloat(user.totalWon),
        }))
        .filter(user => user.losses > 0) // Only show users with actual losses
        .sort((a, b) => b.losses - a.losses)
        .slice(0, 5);

      // Calculate total burned by token across all completed flips
      const allFlipsWithTokens = await models.CoinFlip.findAll({
        where: {
          status: 'COMPLETED',
        },
        attributes: ['wagerAmount', 'tokenSymbol', 'tokenNetwork'],
        raw: true,
      });

      // Format winners section
      let winnersText = '🏆 <b>TOP WINNERS</b>\n';
      if (topWinners.length === 0) {
        winnersText += 'No winners yet\n\n';
      } else {
        topWinners.forEach((winner, index) => {
          const displayName = winner.username ? `@${winner.username}` : winner.firstName;
          const amount = parseFloat(winner.totalWon).toLocaleString('en-US', {
            maximumFractionDigits: 6,
            minimumFractionDigits: 0,
          });
          winnersText += `${index + 1}. ${displayName} - ${amount}\n`;
        });
        winnersText += '\n';
      }

      // Format losers section
      let losersText = '📉 <b>TOP LOSERS</b>\n';
      if (usersWithLosses.length === 0) {
        losersText += 'No losers yet\n\n';
      } else {
        usersWithLosses.forEach((loser, index) => {
          const displayName = loser.username ? `@${loser.username}` : loser.firstName;
          const losses = parseFloat(loser.losses).toLocaleString('en-US', {
            maximumFractionDigits: 6,
            minimumFractionDigits: 0,
          });
          losersText += `${index + 1}. ${displayName} - ${losses}\n`;
        });
        losersText += '\n';
      }

      // Group burned amounts by token (symbol + network for uniqueness)
      const burnedByToken = {};
      allFlipsWithTokens.forEach(flip => {
        const tokenKey = `${flip.tokenSymbol}_${flip.tokenNetwork}`;
        const burned = parseFloat(flip.wagerAmount) * 0.10; // 5% of total pool (both sides)
        if (!burnedByToken[tokenKey]) {
          burnedByToken[tokenKey] = {
            symbol: flip.tokenSymbol,
            network: flip.tokenNetwork,
            amount: 0,
          };
        }
        burnedByToken[tokenKey].amount += burned;
      });

      // Format total burned section with breakdown by token
      let burnedText = '🔥 <b>TOTAL BURNED</b>\n';
      const tokenList = Object.values(burnedByToken);
      if (tokenList.length === 0) {
        burnedText += 'None yet\n\n';
      } else {
        tokenList.forEach(token => {
          const amount = token.amount.toLocaleString('en-US', {
            maximumFractionDigits: 6,
            minimumFractionDigits: 0,
          });
          burnedText += `${amount} ${token.symbol}`;
          if (token.network) {
            burnedText += ` (${token.network})`;
          }
          burnedText += '\n';
        });
        burnedText += '\n';
      }

      const leaderboardMessage = winnersText + losersText + burnedText;

      // Try to send with image
      const fs = require('fs');
      const path = require('path');
      const imagePath = path.join(process.cwd(), 'assets/coinflip.jpg');
      
      try {
        if (fs.existsSync(imagePath)) {
          try {
            await ctx.replyWithPhoto(
              { filename: 'coinflip.jpg', source: fs.createReadStream(imagePath) },
              {
                caption: leaderboardMessage,
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [Markup.button.callback('🔄 Refresh', 'refresh_leaderboard')],
                ]).reply_markup,
              }
            );
          } catch (photoErr) {
            logger.warn('Failed to send leaderboard with photo, falling back to text', { error: photoErr.message });
            await ctx.reply(leaderboardMessage, {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'refresh_leaderboard')],
              ]).reply_markup,
            });
          }
        } else {
          logger.warn('Image not found at path', { imagePath });
          await ctx.reply(leaderboardMessage, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Refresh', 'refresh_leaderboard')],
            ]).reply_markup,
          });
        }
      } catch (imgErr) {
        logger.warn('Failed to send leaderboard, general error', { error: imgErr.message });
        await ctx.reply(leaderboardMessage, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'refresh_leaderboard')],
          ]).reply_markup,
        });
      }

      logger.info('[leaderboard] Leaderboard displayed', {
        userId: ctx.from.id,
        winnersCount: topWinners.length,
        losersCount: usersWithLosses.length,
        tokensBurned: Object.keys(burnedByToken).length,
      });
    } catch (error) {
      logger.error('[leaderboard] Error fetching leaderboard', { error: error.message, stack: error.stack });
      await ctx.reply('❌ Error fetching leaderboard. Please try again.');
    }
  }

  /**
   * Handle refresh leaderboard button
   */
  static async refreshLeaderboard(ctx) {
    try {
      await ctx.editMessageText(
        '⏳ Refreshing leaderboard...',
        { parse_mode: 'HTML' }
      );

      // Delete and resend to avoid edit limitations
      await ctx.deleteMessage().catch(() => {});
      await this.showLeaderboard(ctx);

      await ctx.answerCbQuery('✅ Leaderboard refreshed!').catch(() => {});
    } catch (error) {
      logger.error('[refreshLeaderboard] Error', { error: error.message });
      await ctx.answerCbQuery('❌ Error refreshing leaderboard').catch(() => {});
    }
  }
}

module.exports = LeaderboardHandler;
