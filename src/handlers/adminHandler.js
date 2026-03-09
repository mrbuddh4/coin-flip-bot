const { Markup } = require('telegraf');
const { getDB } = require('../database');
const DatabaseUtils = require('../database/utils');
const logger = require('../utils/logger');
const config = require('../config');

class AdminHandler {
  static adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id));

  /**
   * Check if user is admin
   */
  static isAdmin(userId) {
    return this.adminIds.includes(userId);
  }

  /**
   * Admin stats command
   */
  static async stats(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const stats = await DatabaseUtils.getDatabaseStats();
      const topUsers = await DatabaseUtils.getTopUsers(5);

      let message = `📊 <b>Bot Statistics</b>\n\n`;
      message += `Total Users: ${stats.totalUsers}\n`;
      message += `Total Flips: ${stats.totalFlips}\n`;
      message += `Completed: ${stats.completedFlips}\n`;
      message += `Active: ${stats.activeFlips}\n`;
      message += `Transactions: ${stats.totalTransactions}\n\n`;

      message += `<b>Top 5 Players:</b>\n`;
      topUsers.forEach((user, i) => {
        message += `${i + 1}. ${user.firstName}: ${user.totalWon} won\n`;
      });

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting stats', error);
      await ctx.reply('❌ Error retrieving statistics.');
    }
  }

  /**
   * Admin health check
   */
  static async health(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const { sequelize } = getDB();
      await sequelize.authenticate();

      const uptime = process.uptime();
      const memoryUsage = process.memoryUsage();
      const hostname = require('os').hostname();

      const message = `✅ <b>Bot Health Status</b>\n\n` +
        `Server: ${hostname}\n` +
        `Uptime: ${Math.floor(uptime / 60)} minutes\n` +
        `Memory: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB\n` +
        `Database: Connected ✅\n` +
        `Node Version: ${process.version}\n`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Health check failed', error);
      await ctx.reply(`❌ Health check failed: ${error.message}`);
    }
  }

  /**
   * Admin users command
   */
  static async users(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const { models } = getDB();
      const topUsers = await DatabaseUtils.getTopUsers(20);

      let message = `👥 <b>Top Users</b>\n\n`;
      topUsers.forEach((user, i) => {
        const stats = `Won: ${user.totalWon || 0}`;
        message += `${i + 1}. <code>${user.telegramId}</code> - ${user.firstName}\n   ${stats}\n`;
      });

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting users', error);
      await ctx.reply('❌ Error retrieving users.');
    }
  }

  /**
   * Admin broadcasts message
   */
  static async broadcast(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    // This would require implementing a broadcast system
    // For now, just acknowledge
    await ctx.reply('ℹ️ Broadcast feature not yet implemented.');
  }

  /**
   * Get flip details by ID
   */
  static async getFlipDetails(ctx, flipId) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const flip = await DatabaseUtils.getFlipWithRelations(flipId);

      if (!flip) {
        await ctx.reply('❌ Flip not found.');
        return;
      }

      let message = `🎲 <b>Flip Details</b> (ID: ${flipId})\n\n`;
      message += `Status: ${flip.status}\n`;
      message += `Creator: ${flip.creator?.firstName || 'Unknown'} (${flip.creatorId})\n`;
      message += `Challenger: ${flip.challenger?.firstName || 'Not yet'} (${flip.challengerId || 'N/A'})\n`;
      message += `Winner: ${flip.winner?.firstName || 'N/A'} (${flip.winnerId || 'N/A'})\n\n`;
      message += `Token: ${flip.tokenSymbol}\n`;
      message += `Wager: ${flip.wagerAmount}\n`;
      message += `Network: ${flip.tokenNetwork}\n\n`;
      message += `Created: ${flip.createdAt}\n`;
      message += `Result: ${flip.flipResult !== null ? (flip.flipResult === 0 ? 'Creator' : 'Challenger') : 'Pending'}\n`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting flip details', error);
      await ctx.reply('❌ Error retrieving flip.');
    }
  }

  /**
   * Admin debug mode
   */
  static async debug(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const { models } = getDB();

      const recentFlips = await models.CoinFlip.findAll({
        order: [['updatedAt', 'DESC']],
        limit: 5,
      });

      const activeSessions = await models.BotSession.findAll({
        order: [['createdAt', 'DESC']],
        limit: 5,
      });

      let message = `🐛 <b>Debug Info</b>\n\n`;
      message += `<b>Recent Flips:</b>\n`;
      recentFlips.forEach(flip => {
        message += `• ${flip.id.substring(0, 8)}: ${flip.status}\n`;
      });

      message += `\n<b>Active Sessions:</b>\n`;
      activeSessions.forEach(session => {
        message += `• User ${session.userId}: ${session.sessionType}\n`;
      });

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting debug info', error);
      await ctx.reply('❌ Error retrieving debug info.');
    }
  }

  /**
   * Admin cleanup - cancel stuck flips and clear sessions
   */
  static async cleanup(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const { models } = getDB();
      const { Op } = require('sequelize');

      // Get all active flips before cleanup
      const activeFlips = await models.CoinFlip.findAll({
        where: {
          status: {
            [Op.notIn]: ['COMPLETED', 'CANCELLED'],
          },
        },
      });

      logger.info('Cleanup: Found active flips', { count: activeFlips.length, flips: activeFlips.map(f => ({ id: f.id, status: f.status, creator: f.creatorId, challenger: f.challengerId })) });

      // Cancel all active flips
      const cancelledCount = await models.CoinFlip.update(
        { status: 'CANCELLED' },
        {
          where: {
            status: {
              [Op.notIn]: ['COMPLETED', 'CANCELLED'],
            },
          },
        }
      );

      // Clear all active sessions (except LAST_GROUP_ACTIVITY)
      const clearedSessions = await models.BotSession.destroy({
        where: {
          sessionType: {
            [Op.ne]: 'LAST_GROUP_ACTIVITY',
          },
        },
      });

      logger.info('Cleanup completed', { flipsCancelled: cancelledCount[0], sessionsClear: clearedSessions });

      let message = `🧹 <b>Cleanup Complete</b>\n\n`;
      message += `Flips Cancelled: ${cancelledCount[0]}\n`;
      message += `Sessions Cleared: ${clearedSessions}\n\n`;

      if (activeFlips.length > 0) {
        message += `<b>Cancelled Flips:</b>\n`;
        activeFlips.forEach(flip => {
          message += `• ${flip.id.substring(0, 8)}: Creator ${flip.creatorId}, Challenger ${flip.challengerId || 'None'}\n`;
        });
      }

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error during cleanup', error);
      await ctx.reply(`❌ Cleanup error: ${error.message}`);
    }
  }

  /**
   * Register admin commands
   */
  static registerCommands(bot) {
    bot.command('admin_stats', ctx => this.stats(ctx));
    bot.command('admin_health', ctx => this.health(ctx));
    bot.command('admin_users', ctx => this.users(ctx));
    bot.command('admin_broadcast', ctx => this.broadcast(ctx));
    bot.command('admin_debug', ctx => this.debug(ctx));
    bot.command('admin_cleanup', ctx => this.cleanup(ctx));

    // For flip details: /flip_<id>
    bot.hears(/^\/flip_(.+)$/, (ctx) => {
      const flipId = ctx.match[1];
      this.getFlipDetails(ctx, flipId);
    });
  }
}

module.exports = AdminHandler;
