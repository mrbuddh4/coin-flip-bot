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

      // Get top 5 winners by net profit (totalWon - totalWagered)
      const allWinners = await models.User.findAll({
        attributes: ['telegramId', 'firstName', 'username', 'totalWon', 'totalWagered'],
        where: {
          totalWon: {
            [Op.gt]: 0,
          },
        },
        raw: true,
      });

      const topWinners = allWinners
        .map(user => ({
          ...user,
          profit: parseFloat(user.totalWon) - parseFloat(user.totalWagered),
        }))
        .filter(user => user.profit > 0)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 5);

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

      // Calculate losses for each user — sort ascending, take 5 biggest, display smallest→biggest
      const losersDisplay = allUsers
        .map(user => ({
          ...user,
          losses: parseFloat(user.totalWagered) - parseFloat(user.totalWon),
        }))
        .filter(user => user.losses > 0)
        .sort((a, b) => a.losses - b.losses)  // ASC: smallest loss first
        .slice(-5);                             // keep top 5 biggest, still ASC order

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
          const amount = parseFloat(winner.profit).toLocaleString('en-US', {
            maximumFractionDigits: 6,
            minimumFractionDigits: 0,
          });
          winnersText += `${index + 1}. ${displayName} - ${amount}\n`;
        });
        winnersText += '\n';
      }

      // Format losers section (ascending: least loss = #1, most loss = last)
      let losersText = '📉 <b>TOP LOSERS</b>\n';
      if (losersDisplay.length === 0) {
        losersText += 'No losers yet\n\n';
      } else {
        losersDisplay.forEach((loser, index) => {
          const rank = losersDisplay.length - index; // 5 at top, 1 at bottom (losingest)
          const displayName = loser.username ? `@${loser.username}` : loser.firstName;
          const losses = parseFloat(loser.losses).toLocaleString('en-US', {
            maximumFractionDigits: 6,
            minimumFractionDigits: 0,
          });
          losersText += `${rank}. ${displayName} - ${losses}\n`;
        });
        losersText += '\n';
      }

      // Group volume and burned amounts by token (symbol + network for uniqueness)
      const volumeByToken = {};
      const burnedByToken = {};
      allFlipsWithTokens.forEach(flip => {
        const tokenKey = `${flip.tokenSymbol}_${flip.tokenNetwork}`;
        const volume = parseFloat(flip.wagerAmount) * 2; // both sides
        if (!volumeByToken[tokenKey]) {
          volumeByToken[tokenKey] = { symbol: flip.tokenSymbol, network: flip.tokenNetwork, amount: 0 };
        }
        volumeByToken[tokenKey].amount += volume;

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

      // Format total volume section
      let volumeText = '📊 <b>TOTAL VOLUME</b>\n';
      const volumeList = Object.values(volumeByToken);
      if (volumeList.length === 0) {
        volumeText += 'None yet\n\n';
      } else {
        volumeList.forEach(token => {
          const amount = token.amount.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 0 });
          volumeText += `${amount} ${token.symbol}`;
          if (token.network) volumeText += ` (${token.network})`;
          volumeText += '\n';
        });
        volumeText += '\n';
      }

      const leaderboardMessage = winnersText + losersText + burnedText + volumeText;

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
        losersCount: losersDisplay.length,
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
      // Photo messages use editMessageCaption; text messages use editMessageText
      try {
        if (ctx.callbackQuery.message.photo) {
          await ctx.editMessageCaption('⏳ Refreshing leaderboard...', { parse_mode: 'HTML' });
        } else {
          await ctx.editMessageText('⏳ Refreshing leaderboard...', { parse_mode: 'HTML' });
        }
      } catch (editErr) {
        // Ignore — proceed with delete + resend regardless
      }

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
