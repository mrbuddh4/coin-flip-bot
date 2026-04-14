const { Markup } = require('telegraf');
const { getDB } = require('../database');
const DatabaseUtils = require('../database/utils');
const logger = require('../utils/logger');
const config = require('../config');
const botState = require('../utils/botState');

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
   * Register admin commands
   */
  /**
   * Cancel all active flips
   */
  static async cancelAllFlips(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const { models } = getDB();
      const { Op } = require('sequelize');

      // Find all active flips
      const activeFlips = await models.CoinFlip.findAll({
        where: {
          status: {
            [Op.notIn]: ['COMPLETED', 'CANCELLED'],
          },
        },
      });

      if (activeFlips.length === 0) {
        await ctx.reply('✅ No active flips to cancel.');
        return;
      }

      // Cancel all flips
      for (const flip of activeFlips) {
        flip.status = 'CANCELLED';
        flip.creatorDepositWalletAddress = null;
        flip.challengerDepositWalletAddress = null;
        flip.creatorAccumulatedDeposit = 0;
        flip.challengerAccumulatedDeposit = 0;
        await flip.save();
        logger.info('Admin cancelled flip', { flipId: flip.id });
      }

      await ctx.reply(
        `✅ <b>Cancelled ${activeFlips.length} flip(s)</b>\n\n` +
        activeFlips.map(f => `• Flip ${f.id.substring(0, 8)}... (${f.status})`).join('\n'),
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error('Error cancelling flips', error);
      await ctx.reply('❌ Error cancelling flips.');
    }
  }

  /**
   * Show current $FLIP profit share pool status
   */
  static async profitShareStatus(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }
    try {
      const ProfitShareHandler = require('./profitShareHandler');
      const pools = await ProfitShareHandler.getPoolStatus();

      if (pools.length === 0) {
        await ctx.reply('ℹ️ No profit share pools yet. Fees accumulate after EVM flips complete.');
        return;
      }

      let message = `💰 <b>$FLIP Profit Share Pools</b>\n\n`;
      for (const pool of pools) {
        const lastDist = pool.lastDistributedAt
          ? new Date(pool.lastDistributedAt).toUTCString()
          : 'Never';
        message += `<b>${pool.tokenSymbol}</b>\n`;
        message += `  Pending: ${parseFloat(pool.pendingAmount).toFixed(6)} ${pool.tokenSymbol}\n`;
        message += `  Total distributed: ${parseFloat(pool.totalDistributed).toFixed(4)} ${pool.tokenSymbol}\n`;
        message += `  Last distribution: ${lastDist}\n\n`;
      }
      message += `Auto-distribution runs every 24 hours.`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting profit share status', error);
      await ctx.reply('❌ Error retrieving profit share status.');
    }
  }

  /**
   * Manually trigger a profit share distribution to all $FLIP holders
   */
  static async triggerDistribute(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }
    await ctx.reply('⏳ Running $FLIP profit share distribution...');
    try {
      const ProfitShareHandler = require('./profitShareHandler');
      const result = await ProfitShareHandler.distribute(null, 'admin');

      if (!result.distributed) {
        await ctx.reply(`ℹ️ Distribution skipped: ${result.reason}`);
        return;
      }

      const summary = result.results
        .map(r => `• ${r.totalSent.toFixed(4)} ${r.symbol} → ${r.successCount} holders (${r.failCount} failed)`)
        .join('\n');

      await ctx.reply(
        `✅ <b>Distribution complete!</b>\n\n` +
        `$FLIP holders reached: ${result.holderCount}\n\n${summary}`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error('Error triggering profit share distribution', error);
      await ctx.reply(`❌ Distribution failed: ${error.message}`);
    }
  }

  static async flipHoldersAdd(ctx) {
    if (!this.isAdmin(ctx.from.id)) { await ctx.reply('❌ Not authorized.'); return; }
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];
    const label = parts.slice(2).join(' ') || '';
    if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      await ctx.reply('Usage: /flip_holders_add 0x<address> [optional label]');
      return;
    }
    try {
      const ProfitShareHandler = require('./profitShareHandler');
      const { created } = await ProfitShareHandler.addHolder(address, label);
      await ctx.reply(created
        ? `✅ Added <code>${address}</code>${label ? ` (${label})` : ''} to $FLIP holder list.`
        : `ℹ️ <code>${address}</code> is already in the list.`,
        { parse_mode: 'HTML' });
    } catch (err) {
      logger.error('[AdminHandler] flipHoldersAdd error', { error: err.message });
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  static async flipHoldersRemove(ctx) {
    if (!this.isAdmin(ctx.from.id)) { await ctx.reply('❌ Not authorized.'); return; }
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];
    if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      await ctx.reply('Usage: /flip_holders_remove 0x<address>');
      return;
    }
    try {
      const ProfitShareHandler = require('./profitShareHandler');
      const removed = await ProfitShareHandler.removeHolder(address);
      await ctx.reply(removed
        ? `✅ Removed <code>${address}</code> from $FLIP holder list.`
        : `❌ Address not found in list.`,
        { parse_mode: 'HTML' });
    } catch (err) {
      logger.error('[AdminHandler] flipHoldersRemove error', { error: err.message });
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  static async flipHoldersBackfill(ctx) {
    if (!this.isAdmin(ctx.from.id)) { await ctx.reply('❌ Not authorized.'); return; }
    try {
      const { getDB } = require('../database');
      const { models } = getDB();
      const profiles = await models.UserProfile.findAll();
      let added = 0;
      let skipped = 0;
      for (const profile of profiles) {
        const addrs = [
          profile.evmWalletAddress,
        ].filter(a => a && /^0x[a-fA-F0-9]{40}$/i.test(a));
        for (const addr of addrs) {
          const [, created] = await models.FlipHolderAddress.findOrCreate({
            where: { address: addr.toLowerCase() },
            defaults: { address: addr.toLowerCase(), label: `user:${profile.userId}` },
          });
          created ? added++ : skipped++;
        }
      }
      await ctx.reply(`✅ Backfill complete.\n• Added: ${added}\n• Already existed: ${skipped}\n• Profiles scanned: ${profiles.length}`);
    } catch (err) {
      logger.error('[AdminHandler] flipHoldersBackfill error', { error: err.message });
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  static async profitShareReceiptsBackfill(ctx) {
    if (!this.isAdmin(ctx.from.id)) { await ctx.reply('❌ Not authorized.'); return; }
    await ctx.reply('⏳ Scanning on-chain Transfer events from dev wallet… this may take a few minutes.');
    try {
      const { ethers } = require('ethers');
      const cfg = require('../config');
      const { getDB } = require('../database');
      const { models } = getDB();

      const devWallet = (cfg.evm.devWallet || '').toLowerCase();
      if (!devWallet) { await ctx.reply('❌ EVM_DEV_WALLET not set.'); return; }

      // Short RPC timeout so a slow provider never hangs the bot process
      const provider = new ethers.JsonRpcProvider(cfg.evm.rpcUrl, undefined, { timeout: 15_000 });
      const pools = await models.ProfitSharePool.findAll({ where: { network: 'EVM' } });
      const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
      const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const CHUNK = 2000;
      const latestBlock = await provider.getBlockNumber();
      const fromTopic = ethers.zeroPadValue(devWallet, 32);

      // Estimate fromBlock: 1 week before oldest distribution (or 30 days ago), ~3s block time
      const BLOCK_TIME_SECS = 3;
      const oldestPool = pools
        .filter(p => p.lastDistributedAt)
        .sort((a, b) => new Date(a.lastDistributedAt) - new Date(b.lastDistributedAt))[0];
      const fromDate = oldestPool
        ? new Date(new Date(oldestPool.lastDistributedAt).getTime() - 7 * 24 * 3600 * 1000)
        : new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const secondsBack = Math.max(0, Math.floor((Date.now() - fromDate.getTime()) / 1000));
      const startBlock = Math.max(0, latestBlock - Math.ceil(secondsBack / BLOCK_TIME_SECS));

      let totalInserted = 0;
      let totalSkipped  = 0;

      for (const pool of pools) {
        if (pool.tokenAddress === 'native') continue;
        const tokenAddress = pool.tokenAddress.toLowerCase();

        for (let from = startBlock; from <= latestBlock; from += CHUNK) {
          const to = Math.min(from + CHUNK - 1, latestBlock);
          let logs = [];
          try {
            logs = await provider.getLogs({
              address: tokenAddress,
              fromBlock: from,
              toBlock: to,
              topics: [ERC20_TRANSFER_TOPIC, fromTopic],
            });
          } catch { continue; }

          for (const log of logs) {
            let parsed;
            try { parsed = iface.parseLog(log); } catch { continue; }

            const toAddr   = parsed.args.to.toLowerCase();
            const amount   = parseFloat(ethers.formatUnits(parsed.args.value, pool.tokenDecimals));
            const receiptKey = `${log.transactionHash}#${log.logIndex}`;

            let distributedAt = new Date();
            try {
              const block = await provider.getBlock(log.blockNumber);
              if (block?.timestamp) distributedAt = new Date(block.timestamp * 1000);
            } catch { /* use now */ }

            const [, created] = await models.ProfitShareReceipt.upsert({
              holderAddress: toAddr,
              tokenAddress:  pool.tokenAddress,
              tokenSymbol:   pool.tokenSymbol,
              amount,
              txHash:        receiptKey,
              distributedAt,
            }, { conflictFields: ['txHash'] });
            created ? totalInserted++ : totalSkipped++;
          }
        }
      }

      await ctx.reply(`✅ Profit share receipt backfill complete.\n• Inserted: ${totalInserted}\n• Already existed: ${totalSkipped}`);
    } catch (err) {
      logger.error('[AdminHandler] profitShareReceiptsBackfill error', { error: err.message });
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  static async flipHoldersList(ctx) {
    if (!this.isAdmin(ctx.from.id)) { await ctx.reply('❌ Not authorized.'); return; }
    try {
      const ProfitShareHandler = require('./profitShareHandler');
      const rows = await ProfitShareHandler.listHolders();
      if (rows.length === 0) {
        await ctx.reply('No $FLIP holders registered.\nUse /flip_holders_add 0x<address> to add one.');
        return;
      }
      const lines = rows.map((r, i) =>
        `${i + 1}. <code>${r.address}</code>${r.label ? ` — ${r.label}` : ''}`
      );
      await ctx.reply(
        `<b>Registered $FLIP Holders (${rows.length})</b>\n\n` + lines.join('\n'),
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      logger.error('[AdminHandler] flipHoldersList error', { error: err.message });
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  static async flipResults(ctx) {
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }

    try {
      const { models } = getDB();
      const { QueryTypes } = require('sequelize');
      const rows = await models.sequelize.query(
        `SELECT
           "flipResult",
           COUNT(*) AS cnt
         FROM "CoinFlips"
         WHERE status = 'COMPLETED'
           AND "flipResult" IS NOT NULL
         GROUP BY "flipResult"
         ORDER BY "flipResult"`,
        { type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        await ctx.reply('No completed flips yet.');
        return;
      }

      const total = rows.reduce((s, r) => s + parseInt(r.cnt), 0);
      let msg = `🎲 <b>Flip Result Distribution</b>\n\nTotal completed: <b>${total}</b>\n\n`;
      rows.forEach(r => {
        const pct = ((parseInt(r.cnt) / total) * 100).toFixed(1);
        msg += `${r.flipResult === 'CREATOR' ? '🟡' : '🔵'} <b>${r.flipResult}</b>: ${r.cnt} wins (${pct}%)\n`;
      });

      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error getting flip results', error);
      await ctx.reply('❌ Error retrieving flip results.');
    }
  }

  static async sleep(ctx) {
    if (ctx.chat.type !== 'private') return;
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }
    botState.asleep = true;
    // Persist across restarts
    try {
      const { models } = getDB();
      await models.BotSetting.upsert({ key: 'bot_asleep', value: 'true' });
    } catch (e) { logger.warn('[AdminHandler] Failed to persist sleep state', { error: e.message }); }
    logger.info('[AdminHandler] Bot put to sleep', { by: ctx.from.id });
    await ctx.reply('😴 Bot is now <b>asleep</b>. New flips are disabled.\n\nUse /wake to re-enable.', { parse_mode: 'HTML' });
  }

  static async wake(ctx) {
    if (ctx.chat.type !== 'private') return;
    if (!this.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Not authorized.');
      return;
    }
    botState.asleep = false;
    // Clear persisted sleep state
    try {
      const { models } = getDB();
      await models.BotSetting.upsert({ key: 'bot_asleep', value: 'false' });
    } catch (e) { logger.warn('[AdminHandler] Failed to clear sleep state', { error: e.message }); }
    logger.info('[AdminHandler] Bot woken up', { by: ctx.from.id });
    await ctx.reply('✅ Bot is now <b>awake</b>. Flips are enabled again.', { parse_mode: 'HTML' });
  }

  static registerCommands(bot) {
    bot.command('sleep', ctx => this.sleep(ctx));
    bot.command('wake', ctx => this.wake(ctx));
    bot.command('admin_stats', ctx => this.stats(ctx));
    bot.command('admin_health', ctx => this.health(ctx));
    bot.command('admin_users', ctx => this.users(ctx));
    bot.command('admin_broadcast', ctx => this.broadcast(ctx));
    bot.command('admin_debug', ctx => this.debug(ctx));
    bot.command('admin_cancel_all', ctx => this.cancelAllFlips(ctx));
    bot.command('profit_status', ctx => this.profitShareStatus(ctx));
    bot.command('profit_distribute', ctx => this.triggerDistribute(ctx));
    bot.command('flip_holders_add', ctx => this.flipHoldersAdd(ctx));
    bot.command('flip_holders_remove', ctx => this.flipHoldersRemove(ctx));
    bot.command('flip_holders_list', ctx => this.flipHoldersList(ctx));
    bot.command('flip_holders_backfill', ctx => this.flipHoldersBackfill(ctx));
    bot.command('ps_receipts_backfill', ctx => this.profitShareReceiptsBackfill(ctx));
    bot.command('admin_flipresults', ctx => this.flipResults(ctx));

    // For flip details: /flip_<id>
    bot.hears(/^\/flip_(.+)$/, (ctx) => {
      const flipId = ctx.match[1];
      this.getFlipDetails(ctx, flipId);
    });
  }
}

module.exports = AdminHandler;
