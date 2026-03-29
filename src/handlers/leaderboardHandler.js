const { Markup } = require('telegraf');
const { getDB } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class LeaderboardHandler {
  /**
   * Aggregate top winners and losers for a given token filter from CoinFlip records.
   * Returns { winners: [{user, net}], losers: [{user, net}] }
   */
  static async getTokenLeaderboard(models, tokenFilter) {
    const flips = await models.CoinFlip.findAll({
      where: { status: 'COMPLETED', ...tokenFilter },
      attributes: ['creatorId', 'challengerId', 'winnerId', 'wagerAmount'],
      raw: true,
    });

    const netByUser = {};
    for (const flip of flips) {
      const wager = parseFloat(flip.wagerAmount);
      const winnerNet = wager * 2 * 0.9 - wager; // 90% of pool minus own wager
      const loserId = String(flip.winnerId) === String(flip.creatorId)
        ? flip.challengerId
        : flip.creatorId;
      if (flip.winnerId) netByUser[flip.winnerId] = (netByUser[flip.winnerId] || 0) + winnerNet;
      if (loserId)       netByUser[loserId]       = (netByUser[loserId]       || 0) - wager;
    }

    const userIds = Object.keys(netByUser);
    if (userIds.length === 0) return { winners: [], losers: [] };

    const users = await models.User.findAll({
      where: { telegramId: { [Op.in]: userIds } },
      attributes: ['telegramId', 'firstName', 'username'],
      raw: true,
    });
    const userMap = {};
    users.forEach(u => { userMap[String(u.telegramId)] = u; });

    const entries = userIds.map(id => ({
      user: userMap[id] || { firstName: 'Unknown', username: null },
      net: netByUser[id],
    }));

    const winners = entries.filter(e => e.net > 0).sort((a, b) => b.net - a.net).slice(0, 5);
    const losers  = entries.filter(e => e.net < 0).sort((a, b) => a.net - b.net).slice(0, 5);
    return { winners, losers };
  }

  static formatSection(title, winners, losers, symbol) {
    const fmt = n => Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
    const name = u => u.username ? `@${u.username}` : (u.firstName || 'Unknown');
    let t = `${title}\n`;
    t += `🏆 <b>Top Winners</b>\n`;
    if (winners.length === 0) {
      t += 'No winners yet\n';
    } else {
      winners.forEach((e, i) => { t += `  ${i + 1}. ${name(e.user)} +${fmt(e.net)} ${symbol}\n`; });
    }
    t += `📉 <b>Top Losers</b>\n`;
    if (losers.length === 0) {
      t += 'No losers yet\n';
    } else {
      losers.forEach((e, i) => { t += `  ${i + 1}. ${name(e.user)} -${fmt(e.net)} ${symbol}\n`; });
    }
    return t + '\n';
  }

  /**
   * Show leaderboard — one section per token (SID combined EVM+Sol, PAX EVM)
   */
  static async showLeaderboard(ctx) {
    try {
      const { models } = getDB();
      logger.info('[leaderboard] Building per-token leaderboard', { userId: ctx.from.id });

      // SID: both EVM and Solana combined
      const sid = await this.getTokenLeaderboard(models, { tokenSymbol: 'SID' });
      // PAX: EVM only
      const pax = await this.getTokenLeaderboard(models, { tokenSymbol: 'PAX', tokenNetwork: 'EVM' });

      // Volume & burned from all completed flips
      const allFlips = await models.CoinFlip.findAll({
        where: { status: 'COMPLETED' },
        attributes: ['wagerAmount', 'tokenSymbol', 'tokenNetwork'],
        raw: true,
      });

      let sidVolume = 0, sidBurned = 0, paxVolume = 0, paxBurned = 0;
      allFlips.forEach(flip => {
        const pool = parseFloat(flip.wagerAmount) * 2;
        const burned = pool * 0.05;
        if (flip.tokenSymbol === 'SID') { sidVolume += pool; sidBurned += burned; }
        if (flip.tokenSymbol === 'PAX' && flip.tokenNetwork === 'EVM') { paxVolume += pool; paxBurned += burned; }
      });

      const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

      let leaderboardMessage = '';
      leaderboardMessage += this.formatSection('🟡 <b>SID LEADERBOARD</b> (Paxeer + Solana)', sid.winners, sid.losers, 'SID');
      leaderboardMessage += this.formatSection('🔵 <b>PAX LEADERBOARD</b> (Paxeer)', pax.winners, pax.losers, 'PAX');
      leaderboardMessage += `🔥 <b>TOTAL BURNED</b>\n`;
      leaderboardMessage += `  ${fmt(sidBurned)} SID | ${fmt(paxBurned)} PAX\n\n`;
      leaderboardMessage += `📊 <b>TOTAL VOLUME</b>\n`;
      leaderboardMessage += `  ${fmt(sidVolume)} SID | ${fmt(paxVolume)} PAX\n`;

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
        sidWinners: sid.winners.length,
        paxWinners: pax.winners.length,
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
