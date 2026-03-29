'use strict';

const { ethers } = require('ethers');
const { getDB } = require('../database');
const { getBlockchainManager } = require('../blockchain/manager');
const config = require('../config');
const logger = require('../utils/logger');

const FLIP_TOKEN_ADDRESS = process.env.FLIP_TOKEN_ADDRESS || '0x2aA5968F710080ea453e7e09E59d769E8C470fac';
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
   * Accumulate a flip dev fee into the profit share pool instead of sending
   * it to the dev wallet. Called from executionHandler after each completed flip.
   *
   * @param {string} network  'EVM' or 'Solana' — determines which distribution
   *                          path is used at payout time.
   */
  static async accumulateFee(tokenAddress, tokenSymbol, tokenDecimals, amount, network = 'EVM') {
    try {
      const { models } = getDB();
      const amountNum = parseFloat(amount);
      if (!amountNum || amountNum <= 0) return;

      const normalizedAddress = tokenAddress === 'NATIVE' ? 'native' : tokenAddress.toLowerCase();

      const [pool] = await models.ProfitSharePool.findOrCreate({
        where: { network, tokenAddress: normalizedAddress },
        defaults: {
          network,
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
        network,
        tokenSymbol,
        amount: amountNum,
        newPending: pool.pendingAmount,
      });
    } catch (err) {
      logger.error('[ProfitShare] Failed to accumulate fee', { error: err.message });
    }
  }

  /**
   * Distribute a Solana fee pool to bot users who have registered both an EVM
   * wallet (used to look up their $FLIP balance) and a Solana wallet (where
   * they receive the payout).
   *
   * Users who have not registered both wallets do not receive a payout for
   * this cycle — their share carries over in the pool for the next cycle.
   *
   * @param {object} pool             ProfitSharePool record (Solana network)
   * @param {BigInt} effectiveSupply  Pre-computed effective $FLIP supply
   * @returns {{ totalSent: number, successCount: number, failCount: number }}
   */
  static async distributeToRegisteredSolanaHolders(pool, effectiveSupply) {
    const { models } = getDB();
    const { Op } = require('sequelize');
    const pending = parseFloat(pool.pendingAmount);

    // Find bot users who have saved a Solana wallet (to receive the payout) and at least
    // one EVM wallet for the $FLIP balance check (flipHoldingWalletAddress preferred,
    // falling back to evmWalletAddress).
    const profiles = await models.UserProfile.findAll({
      where: {
        solanaWalletAddress: { [Op.not]: null },
        // Must have at least one EVM address to check FLIP balance against
        [Op.or]: [
          { flipHoldingWalletAddress: { [Op.not]: null } },
          { evmWalletAddress: { [Op.not]: null } },
        ],
      },
    });

    if (profiles.length === 0) {
      logger.info('[ProfitShare] No users with both wallets registered — Solana pool carries over', {
        symbol: pool.tokenSymbol,
      });
      return { totalSent: 0, successCount: 0, failCount: 0 };
    }

    logger.info('[ProfitShare] Solana pool distribution: querying $FLIP balances for registered users', {
      symbol: pool.tokenSymbol,
      pending,
      registeredUsers: profiles.length,
    });

    // Query each registered user's on-chain $FLIP balance to determine their share
    const provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);
    const flipContract = new ethers.Contract(FLIP_TOKEN_ADDRESS, ERC20_ABI, provider);
    const blockchainManager = getBlockchainManager();
    const sendTokenAddress = pool.tokenAddress === 'native' ? 'NATIVE' : pool.tokenAddress;

    let totalSent = 0;
    let successCount = 0;
    let failCount = 0;

    for (const profile of profiles) {
      // Use the dedicated FLIP holding wallet if set; otherwise fall back to the
      // Paxeer receive wallet (evmWalletAddress).
      const holdingAddr = (profile.flipHoldingWalletAddress || profile.evmWalletAddress || '').toLowerCase();
      if (!holdingAddr || EXCLUDED_ADDRESSES.has(holdingAddr)) continue;

      let flipBalance;
      try {
        flipBalance = await flipContract.balanceOf(holdingAddr);
      } catch (_) { continue; }

      if (flipBalance === 0n) continue;

      // Share = their FLIP balance / total effective supply (same denominator as EVM payouts)
      const share = Number(flipBalance) / Number(effectiveSupply);
      const amount = pending * share;
      if (amount < MIN_PER_HOLDER) continue;

      try {
        await sleep(1200);
        const result = await blockchainManager.sendWinnings(
          'Solana',
          sendTokenAddress,
          profile.solanaWalletAddress,
          amount.toString(),
          pool.tokenDecimals
        );
        totalSent += amount;
        successCount++;
        logger.info('[ProfitShare] Sent Solana share to registered user', {
          userId: profile.userId,
          holdingWallet: holdingAddr,
          solanaWallet: profile.solanaWalletAddress,
          flipBalance: flipBalance.toString(),
          amount,
          symbol: pool.tokenSymbol,
          txHash: result.txHash,
        });
      } catch (err) {
        failCount++;
        logger.error('[ProfitShare] Failed to send Solana share to user', {
          userId: profile.userId,
          solanaWallet: profile.solanaWalletAddress,
          amount,
          error: err.message,
        });
      }
    }

    return { totalSent, successCount, failCount };
  }

  /**
   * Fetch all known $FLIP holders from the DB, then query each address's balance
   * on-chain via balanceOf. This is more reliable than Paxscan's tokenholderlist API.
   * Returns array of { address: string, balance: BigInt }.
   */
  static async getFlipHolders() {
    const { models } = getDB();
    const provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);
    const contract = new ethers.Contract(FLIP_TOKEN_ADDRESS, ERC20_ABI, provider);

    const rows = await models.FlipHolderAddress.findAll();
    const holders = [];

    for (const row of rows) {
      const addr = row.address.toLowerCase();
      if (EXCLUDED_ADDRESSES.has(addr)) continue;
      try {
        const balance = await contract.balanceOf(row.address);
        if (balance > 0n) {
          holders.push({ address: row.address, balance });
        }
      } catch (err) {
        logger.warn('[ProfitShare] Could not fetch balanceOf for holder', { address: addr, error: err.message });
      }
      await sleep(200); // Avoid RPC rate limiting
    }

    logger.info('[ProfitShare] $FLIP holders fetched (on-chain balanceOf)', { registered: rows.length, withBalance: holders.length });
    return holders;
  }

  /** Add an address to the known holder list. Returns { created: bool }. */
  static async addHolder(address, label = '') {
    const { models } = getDB();
    const normalized = address.toLowerCase();
    const [, created] = await models.FlipHolderAddress.findOrCreate({
      where: { address: normalized },
      defaults: { address: normalized, label },
    });
    return { created };
  }

  /** Remove an address from the known holder list. Returns true if it existed. */
  static async removeHolder(address) {
    const { models } = getDB();
    const count = await models.FlipHolderAddress.destroy({
      where: { address: address.toLowerCase() },
    });
    return count > 0;
  }

  /** List all registered holder addresses (DB rows only, no on-chain call). */
  static async listHolders() {
    const { models } = getDB();
    return models.FlipHolderAddress.findAll({ order: [['createdAt', 'ASC']] });
  }

  /**
   * Run one full distribution cycle.
   *
   * EVM pools  → distribute to ALL on-chain $FLIP holders (via Paxscan).
   * Solana pools → distribute only to bot users who have registered both an
   *   EVM wallet (used to look up their $FLIP balance) and a Solana wallet
   *   (where they receive the payout). Unregistered holders retain their
   *   share in the pool until the next cycle.
   *
   * Both pool types use the same effective-supply denominator, so every user
   * receives exactly (their_FLIP / effective_supply) * pool_amount.
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

    const evmPools = pools.filter(p => p.network !== 'Solana');
    const solanaPools = pools.filter(p => p.network === 'Solana');

    // Fetch Paxscan holders only when there are EVM pools to distribute
    let holders = [];
    if (evmPools.length > 0) {
      holders = await this.getFlipHolders();
      if (holders.length === 0) {
        logger.warn('[ProfitShare] No $FLIP holders with balance found — EVM pools will carry over (add holders via /flip_holders_add)');
      }
    }

    // Effective supply is the shared denominator for both EVM and Solana distributions
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
      evmPoolCount: evmPools.length,
      solanaPoolCount: solanaPools.length,
      evmHolderCount: holders.length,
      effectiveSupply: effectiveSupply.toString(),
    });

    const blockchainManager = getBlockchainManager();
    const results = [];

    // ── EVM pools: send to every on-chain $FLIP holder via Paxscan ────────────
    for (const pool of evmPools) {
      const pending = parseFloat(pool.pendingAmount);
      if (pending < MIN_PER_HOLDER || holders.length === 0) continue;

      logger.info('[ProfitShare] Distributing EVM pool', {
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
          logger.info('[ProfitShare] Sent EVM share to holder', {
            holder: holder.address,
            amount,
            symbol: pool.tokenSymbol,
            txHash: result.txHash,
          });
        } catch (err) {
          failCount++;
          logger.error('[ProfitShare] Failed to send EVM share to holder', {
            holder: holder.address,
            amount,
            symbol: pool.tokenSymbol,
            error: err.message,
          });
        }
      }

      const remaining = Math.max(0, pending - totalSent);
      pool.pendingAmount = remaining < MIN_PER_HOLDER ? '0' : remaining.toString();
      pool.totalDistributed = (parseFloat(pool.totalDistributed) + totalSent).toString();
      pool.lastDistributedAt = new Date();
      await pool.save();

      results.push({ symbol: pool.tokenSymbol, network: 'EVM', totalSent, successCount, failCount });
      logger.info('[ProfitShare] EVM pool distribution complete', {
        symbol: pool.tokenSymbol, totalSent, successCount, failCount,
        remainingPending: pool.pendingAmount,
      });
    }

    // ── Solana pools: send to bot users with registered EVM+Solana wallets ────
    for (const pool of solanaPools) {
      const pending = parseFloat(pool.pendingAmount);
      if (pending < MIN_PER_HOLDER) continue;

      logger.info('[ProfitShare] Distributing Solana pool', { symbol: pool.tokenSymbol, pending });

      const { totalSent, successCount, failCount } =
        await this.distributeToRegisteredSolanaHolders(pool, effectiveSupply);

      const remaining = Math.max(0, pending - totalSent);
      pool.pendingAmount = remaining < MIN_PER_HOLDER ? '0' : remaining.toString();
      pool.totalDistributed = (parseFloat(pool.totalDistributed) + totalSent).toString();
      pool.lastDistributedAt = new Date();
      await pool.save();

      results.push({ symbol: pool.tokenSymbol, network: 'Solana', totalSent, successCount, failCount });
      logger.info('[ProfitShare] Solana pool distribution complete', {
        symbol: pool.tokenSymbol, totalSent, successCount, failCount,
        remainingPending: pool.pendingAmount,
      });
    }

    if (results.length === 0) {
      return { distributed: false, reason: 'All pools skipped (no holders found or below minimum)' };
    }

    // Notify admins via Telegram
    if (bot) {
      const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      const summary = results
        .map(r => `• [${r.network}] ${r.totalSent.toFixed(4)} ${r.symbol} → ${r.successCount} recipients (${r.failCount} failed)`)
        .join('\n');

      for (const adminId of adminIds) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `💰 <b>$FLIP Profit Share Distributed</b>\n\n` +
            `Triggered by: ${triggeredBy}\n` +
            `EVM holders reached: ${holders.length}\n\n${summary}`,
            { parse_mode: 'HTML' }
          );
        } catch (_) { /* ignore failed DM to admin */ }
      }
    }

    return { distributed: true, results, evmHolderCount: holders.length };
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
