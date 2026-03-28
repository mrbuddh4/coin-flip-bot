'use strict';

const { ethers } = require('ethers');
const { getDB } = require('../database');
const { getBlockchainManager } = require('../blockchain/manager');
const config = require('../config');
const logger = require('../utils/logger');

const FLIP_TOKEN_ADDRESS = process.env.FLIP_TOKEN_ADDRESS || '0x2aA5968F710080ea453e7e09E59d769E8C470fac';
const PAXSCAN_BASE = 'https://paxscan.paxeer.app/api';
const DISTRIBUTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_PER_HOLDER = 0.001; // Skip sending dust amounts below this

const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

// Addresses excluded from both receiving distributions AND from the supply denominator.
// Includes burn address, zero address, token contract itself, the Sidiora.fun exchange
// pool, and any extras supplied via FLIP_EXCLUDED_ADDRESSES env var.
const _extraExclusions = (process.env.FLIP_EXCLUDED_ADDRESSES || '')
  .split(',')
  .map(a => a.trim().toLowerCase())
  .filter(Boolean);

const EXCLUDED_ADDRESSES = new Set([
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
  FLIP_TOKEN_ADDRESS.toLowerCase(),
  // Sidiora.fun exchange pool — holds liquidity, not a real holder
  (process.env.SIDIORA_EXCHANGE_ADDRESS || '0xA0Cd0F92f12f881aeBaFF9e0fb3144511c9ebF6c').toLowerCase(),
  ..._extraExclusions,
]);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class ProfitShareHandler {
  /**
   * Compute the effective $FLIP supply — i.e. totalSupply minus the balance
   * held by every excluded address (burn, zero, token contract, exchange pool).
   *
   * This is the denominator for profit share calculations, so each holder
   * receives exactly (their_balance / effective_supply) * pool_amount, which
   * equals their % of the supply held *outside* the excluded addresses.
   */
  static async getFlipEffectiveSupply() {
    const provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);
    const contract = new ethers.Contract(FLIP_TOKEN_ADDRESS, ERC20_ABI, provider);

    const totalSupply = await contract.totalSupply();

    // Sum balances held by all excluded addresses and subtract from total
    let excludedTotal = 0n;
    for (const addr of EXCLUDED_ADDRESSES) {
      try {
        const bal = await contract.balanceOf(addr);
        if (bal > 0n) {
          excludedTotal += bal;
          logger.info('[ProfitShare] Excluded address balance', { addr, balance: bal.toString() });
        }
      } catch (_) { /* address may not exist on-chain, skip gracefully */ }
    }

    const effectiveSupply = totalSupply > excludedTotal ? totalSupply - excludedTotal : 0n;

    logger.info('[ProfitShare] $FLIP effective supply computed', {
      totalSupply: totalSupply.toString(),
      excludedTotal: excludedTotal.toString(),
      effectiveSupply: effectiveSupply.toString(),
    });

    return effectiveSupply;
  }
  /**
   * Accumulate an EVM flip dev fee into the profit share pool instead of
   * sending it to the dev wallet. Called from executionHandler after each
   * completed EVM flip.
   */
  static async accumulateFee(tokenAddress, tokenSymbol, tokenDecimals, amount) {
    try {
      const { models } = getDB();
      const amountNum = parseFloat(amount);
      if (!amountNum || amountNum <= 0) return;

      const normalizedAddress = tokenAddress === 'NATIVE' ? 'native' : tokenAddress.toLowerCase();

      const [pool] = await models.ProfitSharePool.findOrCreate({
        where: { tokenAddress: normalizedAddress },
        defaults: {
          tokenAddress: normalizedAddress,
          tokenSymbol,
          tokenDecimals,
          pendingAmount: 0,
          totalDistributed: 0,
        },
      });

      pool.pendingAmount = (parseFloat(pool.pendingAmount) + amountNum).toString();
      await pool.save();

      logger.info('[ProfitShare] Fee accumulated', {
        tokenSymbol,
        amount: amountNum,
        newPending: pool.pendingAmount,
      });
    } catch (err) {
      logger.error('[ProfitShare] Failed to accumulate fee', { error: err.message });
    }
  }

  /**
   * Fetch all $FLIP token holders from Paxscan, paginating until exhausted.
   * Excludes burn/zero/contract addresses.
   * Returns array of { address: string, balance: BigInt }.
   */
  static async getFlipHolders() {
    const holders = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const url =
        `${PAXSCAN_BASE}?module=token&action=tokenholderlist` +
        `&contractaddress=${FLIP_TOKEN_ADDRESS}&page=${page}&offset=${pageSize}`;

      logger.info('[ProfitShare] Fetching $FLIP holders page', { page, url });

      let data;
      try {
        const res = await fetch(url);
        data = await res.json();
      } catch (err) {
        logger.error('[ProfitShare] Failed to fetch holders page', { page, error: err.message });
        break;
      }

      if (!data.result || !Array.isArray(data.result) || data.result.length === 0) break;

      for (const h of data.result) {
        const addr = (h.TokenHolderAddress || '').toLowerCase();
        if (EXCLUDED_ADDRESSES.has(addr)) continue;
        const quantity = BigInt(h.TokenHolderQuantity || '0');
        if (quantity <= 0n) continue;
        holders.push({ address: h.TokenHolderAddress, balance: quantity });
      }

      if (data.result.length < pageSize) break;
      page++;
      await sleep(500); // Avoid Paxscan rate limiting between pages
    }

    logger.info('[ProfitShare] $FLIP holders fetched', { count: holders.length });
    return holders;
  }

  /**
   * Run one full distribution cycle.
   * Distributes all pending EVM token fees to $FLIP holders proportionally
   * to their $FLIP holdings.
   *
   * @param {object|null} bot   Telegraf bot instance for admin notifications, or null
   * @param {string} triggeredBy  'scheduler' | 'admin' | 'startup-catchup'
   * @returns {object} Summary of the distribution run
   */
  static async distribute(bot, triggeredBy = 'scheduler') {
    logger.info('[ProfitShare] Starting distribution cycle', { triggeredBy });

    const { models } = getDB();
    const { Op } = require('sequelize');

    const pools = await models.ProfitSharePool.findAll({
      where: {
        pendingAmount: { [Op.gt]: MIN_PER_HOLDER },
      },
    });

    if (pools.length === 0) {
      logger.info('[ProfitShare] No pending fees to distribute');
      return { distributed: false, reason: 'No pending fees' };
    }

    // Fetch $FLIP holders once — used proportionally for every token pool
    const holders = await this.getFlipHolders();
    if (holders.length === 0) {
      logger.warn('[ProfitShare] No $FLIP holders found, skipping distribution');
      return { distributed: false, reason: 'No $FLIP holders found' };
    }

    // Effective supply = totalSupply minus exchange pool + burn + other excluded addresses.
    // Each holder receives (their_balance / effectiveSupply) * fees, which equals
    // their exact % of the supply held outside excluded addresses.
    let effectiveSupply;
    try {
      effectiveSupply = await this.getFlipEffectiveSupply();
    } catch (err) {
      logger.error('[ProfitShare] Failed to compute $FLIP effective supply, aborting distribution', { error: err.message });
      return { distributed: false, reason: `Could not compute $FLIP effective supply: ${err.message}` };
    }
    if (effectiveSupply === 0n) {
      return { distributed: false, reason: 'Effective $FLIP supply is zero (all tokens excluded or burned)' };
    }

    logger.info('[ProfitShare] Distribution parameters', {
      holderCount: holders.length,
      effectiveSupply: effectiveSupply.toString(),
    });

    const blockchainManager = getBlockchainManager();
    const results = [];

    for (const pool of pools) {
      const pending = parseFloat(pool.pendingAmount);
      if (pending < MIN_PER_HOLDER) continue;

      logger.info('[ProfitShare] Distributing pool', {
        symbol: pool.tokenSymbol,
        pending,
        holderCount: holders.length,
      });

      const sendTokenAddress = pool.tokenAddress === 'native' ? 'NATIVE' : pool.tokenAddress;
      let totalSent = 0;
      let successCount = 0;
      let failCount = 0;

      for (const holder of holders) {
        const share = Number(holder.balance) / Number(effectiveSupply);
        const amount = pending * share;

        if (amount < MIN_PER_HOLDER) continue;

        try {
          await sleep(1200); // ~50 tx/min to avoid RPC hammering
          const result = await blockchainManager.sendWinnings(
            'EVM',
            sendTokenAddress,
            holder.address,
            amount.toString(),
            pool.tokenDecimals
          );
          totalSent += amount;
          successCount++;
          logger.info('[ProfitShare] Sent share to holder', {
            holder: holder.address,
            amount,
            symbol: pool.tokenSymbol,
            txHash: result.txHash,
          });
        } catch (err) {
          failCount++;
          logger.error('[ProfitShare] Failed to send share to holder', {
            holder: holder.address,
            amount,
            symbol: pool.tokenSymbol,
            error: err.message,
          });
        }
      }

      // Preserve any unsent amounts (from failed sends) for the next cycle
      const remaining = Math.max(0, pending - totalSent);
      pool.pendingAmount = remaining < MIN_PER_HOLDER ? '0' : remaining.toString();
      pool.totalDistributed = (parseFloat(pool.totalDistributed) + totalSent).toString();
      pool.lastDistributedAt = new Date();
      await pool.save();

      results.push({ symbol: pool.tokenSymbol, totalSent, successCount, failCount });

      logger.info('[ProfitShare] Pool distribution complete', {
        symbol: pool.tokenSymbol,
        totalSent,
        successCount,
        failCount,
        remainingPending: pool.pendingAmount,
      });
    }

    // Notify admins via Telegram
    if (bot) {
      const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      const summary = results
        .map(r => `• ${r.totalSent.toFixed(4)} ${r.symbol} → ${r.successCount} holders (${r.failCount} failed)`)
        .join('\n');

      for (const adminId of adminIds) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `💰 <b>$FLIP Profit Share Distributed</b>\n\n` +
            `Triggered by: ${triggeredBy}\n` +
            `$FLIP holders reached: ${holders.length}\n\n${summary}`,
            { parse_mode: 'HTML' }
          );
        } catch (_) { /* ignore failed DM to admin */ }
      }
    }

    return { distributed: true, results, holderCount: holders.length };
  }

  /**
   * Get current pool balances (for admin status command).
   */
  static async getPoolStatus() {
    const { models } = getDB();
    return models.ProfitSharePool.findAll();
  }

  /**
   * Start the 24-hour automatic distribution scheduler.
   * Also runs immediately on startup if the last distribution was >24h ago.
   */
  static startScheduler(bot) {
    logger.info('[ProfitShare] Starting 24h distribution scheduler');

    // On startup: trigger immediately if any pool is overdue
    this.getPoolStatus()
      .then(pools => {
        const overdue = pools.some(p => {
          if (!p.lastDistributedAt) return parseFloat(p.pendingAmount) > MIN_PER_HOLDER;
          const hoursSince = (Date.now() - new Date(p.lastDistributedAt).getTime()) / 3600000;
          return hoursSince >= 24 && parseFloat(p.pendingAmount) > MIN_PER_HOLDER;
        });
        if (overdue) {
          logger.info('[ProfitShare] Overdue distribution detected on startup, running now');
          this.distribute(bot, 'startup-catchup').catch(err =>
            logger.error('[ProfitShare] Startup catchup distribution failed', { error: err.message })
          );
        }
      })
      .catch(() => {}); // Ignore errors during startup check

    setInterval(async () => {
      try {
        await this.distribute(bot, 'scheduler');
      } catch (err) {
        logger.error('[ProfitShare] Scheduled distribution failed', { error: err.message });
      }
    }, DISTRIBUTION_INTERVAL_MS);
  }
}

module.exports = ProfitShareHandler;
