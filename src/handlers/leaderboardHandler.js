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

      // Calculate burned amounts for top winners
      const winnersWithBurned = await Promise.all(
        topWinners.map(async (winner) => {
          const flips = await models.CoinFlip.findAll({
            where: {
              [Op.or]: [{ creatorId: winner.telegramId }, { challengerId: winner.telegramId }],
              status: 'COMPLETED',
            },
            attributes: ['wagerAmount'],
            raw: true,
          });

          // Calculate 5% burned per flip
          const totalBurned = flips.reduce((sum, flip) => {
            return sum + parseFloat(flip.wagerAmount) * 0.05;
          }, 0);

          return { ...winner, totalBurned };
        })
      );

      // Calculate burned amounts for top losers
      const losersWithBurned = await Promise.all(
        usersWithLosses.map(async (loser) => {
          const flips = await models.CoinFlip.findAll({
            where: {
              [Op.or]: [{ creatorId: loser.telegramId }, { challengerId: loser.telegramId }],
              status: 'COMPLETED',
            },
            attributes: ['wagerAmount'],
            raw: true,
          });

          // Calculate 5% burned per flip
          const totalBurned = flips.reduce((sum, flip) => {
            return sum + parseFloat(flip.wagerAmount) * 0.05;
          }, 0);

          return { ...loser, totalBurned };
        })
      );

      // Format top winners section
      let winnersText = '🏆 <b>TOP 5 WINNERS</b>\n\n';
      if (winnersWithBurned.length === 0) {
        winnersText += 'No winners yet!\n\n';
      } else {
        winnersWithBurned.forEach((winner, idx) => {
          const displayName = winner.username ? `@${winner.username}` : winner.firstName || 'Unknown';
          const winnings = parseFloat(winner.totalWon).toLocaleString('en-US', {
            maximumFractionDigits: 4,
            minimumFractionDigits: 0,
          });
          const burned = winner.totalBurned.toLocaleString('en-US', {
            maximumFractionDigits: 4,
            minimumFractionDigits: 0,
          });
          winnersText += `${idx + 1}. ${displayName}\n   💰 Won: <b>+${winnings}</b>\n   🔥 Burned: <b>${burned}</b>\n\n`;
        });
      }

      // Format top losers section
      let losersText = '📉 <b>TOP 5 LOSERS</b>\n\n';
      if (losersWithBurned.length === 0) {
        losersText += 'No losers yet!\n\n';
      } else {
        losersWithBurned.forEach((loser, idx) => {
          const displayName = loser.username ? `@${loser.username}` : loser.firstName || 'Unknown';
          const losses = loser.losses.toLocaleString('en-US', {
            maximumFractionDigits: 4,
            minimumFractionDigits: 0,
          });
          const burned = loser.totalBurned.toLocaleString('en-US', {
            maximumFractionDigits: 4,
            minimumFractionDigits: 0,
          });
          losersText += `${idx + 1}. ${displayName}\n   📊 Lost: <b>-${losses}</b>\n   🔥 Burned: <b>${burned}</b>\n\n`;
        });
      }

      const leaderboardMessage = winnersText + losersText;

      await ctx.reply(leaderboardMessage, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'refresh_leaderboard')],
        ]).reply_markup,
      });

      logger.info('[leaderboard] Leaderboard displayed', {
        userId: ctx.from.id,
        winnersCount: winnersWithBurned.length,
        losersCount: losersWithBurned.length,
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
