const { Op } = require('sequelize');
const logger = require('../utils/logger');

class DatabaseUtils {
  static async getDB() {
    const { getDB } = require('./');
    return getDB();
  }

  /**
   * Get or create user
   */
  static async getOrCreateUser(telegramId, userData) {
    const { models } = await this.getDB();
    const [user] = await models.User.findOrCreate({
      where: { telegramId },
      defaults: {
        telegramId,
        username: userData.username,
        firstName: userData.firstName,
        lastName: userData.lastName,
      },
    });
    return user;
  }

  /**
   * Get active flip in group
   */
  static async getActiveFlipInGroup(groupChatId) {
    const { models } = await this.getDB();
    return await models.CoinFlip.findOne({
      where: {
        groupChatId,
        status: {
          [Op.in]: ['WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION'],
        },
      },
    });
  }

  /**
   * Get flip with all relations
   */
  static async getFlipWithRelations(flipId) {
    const { models } = await this.getDB();
    return await models.CoinFlip.findByPk(flipId, {
      include: [
        { association: 'creator', model: models.User },
        { association: 'challenger', model: models.User },
        { association: 'winner', model: models.User },
        { model: models.Transaction },
      ],
    });
  }

  /**
   * Record transaction
   */
  static async recordTransaction(data) {
    const { models } = await this.getDB();
    try {
      return await models.Transaction.create({
        coinFlipId: data.coinFlipId,
        userId: data.userId,
        type: data.type,
        network: data.network,
        tokenAddress: data.tokenAddress,
        tokenSymbol: data.tokenSymbol,
        amount: data.amount,
        fromAddress: data.fromAddress,
        toAddress: data.toAddress,
        txHash: data.txHash,
        status: data.status || 'PENDING',
      });
    } catch (error) {
      logger.error('Error recording transaction', error);
      throw error;
    }
  }

  /**
   * Get user statistics
   */
  static async getUserStats(userId) {
    const { models } = await this.getDB();
    const games = await models.CoinFlip.findAll({
      where: {
        [Op.or]: [{ creatorId: userId }, { challengerId: userId }],
        status: 'COMPLETED',
      },
    });

    const uid = String(userId);
    const wins = games.filter(g => String(g.winnerId) === uid).length;
    const losses = games.length - wins;

    return {
      totalGames: games.length,
      wins,
      losses,
      winRate: games.length > 0 ? ((wins / games.length) * 100).toFixed(2) : 0,
    };
  }

  /**
   * Get detailed stats for user including earnings, losses, and per-token breakdown
   */
  static async getEnhancedUserStats(userId) {
    const { models } = await this.getDB();
    
    // Get all completed games where user participated
    const games = await models.CoinFlip.findAll({
      where: {
        [Op.or]: [{ creatorId: userId }, { challengerId: userId }],
        status: 'COMPLETED',
      },
      raw: true,
    });

    if (games.length === 0) {
      return {
        totalFlips: 0,
        wins: 0,
        losses: 0,
        winRate: '0.00',
        totalEarnings: '0.00',
        totalLosses: '0.00',
        perTokenStats: {},
      };
    }

    // Calculate basic stats
    const uid = String(userId);
    const wins = games.filter(g => String(g.winnerId) === uid).length;
    const losses = games.length - wins;
    const winRate = ((wins / games.length) * 100).toFixed(2);

    // Get all payouts to calculate earnings
    const payouts = await models.Transaction.findAll({
      where: {
        userId,
        type: 'PAYOUT',
        status: 'CONFIRMED',
      },
      raw: true,
    });

    // Get all deposits to calculate total wagered
    const deposits = await models.Transaction.findAll({
      where: {
        userId,
        type: 'DEPOSIT',
        status: 'CONFIRMED',
      },
      raw: true,
    });

    // Calculate totals
    const totalEarnings = payouts.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
    const totalWagered = deposits.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
    const totalLosses = totalWagered - totalEarnings; // What was wagered but not won back

    // Build per-token stats
    const perTokenStats = {};
    games.forEach(game => {
      const token = game.tokenSymbol;
      if (!perTokenStats[token]) {
        perTokenStats[token] = {
          symbol: token,
          network: game.tokenNetwork,
          flips: 0,
          wins: 0,
          losses: 0,
          winRate: '0.00',
          wagered: 0,
          earned: 0,
        };
      }
      perTokenStats[token].flips += 1;
      if (String(game.winnerId) === uid) {
        perTokenStats[token].wins += 1;
      } else {
        perTokenStats[token].losses += 1;
      }
      const wagerAmount = parseFloat(game.wagerAmount || 0);
      perTokenStats[token].wagered += wagerAmount;
      if (String(game.winnerId) === uid) {
        perTokenStats[token].earned += wagerAmount * 2; // Winner gets 2x their wager
      }
    });

    // Calculate per-token win rates
    Object.keys(perTokenStats).forEach(token => {
      const stats = perTokenStats[token];
      stats.winRate = stats.flips > 0 ? ((stats.wins / stats.flips) * 100).toFixed(2) : '0.00';
    });

    return {
      totalFlips: games.length,
      wins,
      losses,
      winRate,
      totalEarnings: totalEarnings.toFixed(6),
      totalLosses: totalLosses.toFixed(6),
      perTokenStats,
    };
  }

  /**
   * Close expired sessions
   */
  static async closeExpiredSessions() {
    const { models } = await this.getDB();
    const now = new Date();

    const expired = await models.BotSession.destroy({
      where: {
        expiresAt: {
          [Op.lt]: now,
        },
      },
    });

    logger.debug(`Cleaned up ${expired} expired sessions`);
    return expired;
  }

  /**
   * Get pending deposits
   */
  static async getPendingDeposits(maxAgeSeconds = 600) {
    const { models } = await this.getDB();
    const cutoffTime = new Date(Date.now() - maxAgeSeconds * 1000);

    return await models.CoinFlip.findAll({
      where: {
        status: {
          [Op.in]: ['WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION'],
        },
        updatedAt: {
          [Op.gt]: cutoffTime,
        },
      },
    });
  }

  /**
   * Cleanup old completed flips (older than X days)
   */
  static async cleanupOldFlips(daysOld = 30) {
    const { models } = await this.getDB();
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

    const deleted = await models.CoinFlip.destroy({
      where: {
        status: 'COMPLETED',
        createdAt: { [Op.lt]: cutoffDate },
      },
    });

    logger.info(`Cleanup: deleted ${deleted} old flips`);
    return deleted;
  }

  /**
   * Get most active users
   */
  static async getTopUsers(limit = 10) {
    const { models } = await this.getDB();
    return await models.User.findAll({
      attributes: ['telegramId', 'firstName', 'totalWon', 'totalWagered'],
      order: [['totalWon', 'DESC']],
      limit,
    });
  }

  /**
   * Get flip history for user
   */
  static async getUserFlipHistory(userId, limit = 10) {
    const { models } = await this.getDB();
    return await models.CoinFlip.findAll({
      where: {
        [Op.or]: [
          { creatorId: userId },
          { challengerId: userId },
        ],
        status: 'COMPLETED',
      },
      order: [['updatedAt', 'DESC']],
      limit,
    });
  }

  /**
   * Get database stats
   */
  static async getDatabaseStats() {
    const { models } = await this.getDB();

    const stats = {
      totalUsers: await models.User.count(),
      totalFlips: await models.CoinFlip.count(),
      completedFlips: await models.CoinFlip.count({
        where: { status: 'COMPLETED' },
      }),
      activeFlips: await models.CoinFlip.count({
        where: {
          status: {
            [Op.in]: ['WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION'],
          },
        },
      }),
      totalTransactions: await models.Transaction.count(),
    };

    return stats;
  }
}

module.exports = DatabaseUtils;
