/**
 * One-time backfill: scans on-chain ERC20 Transfer events sent FROM the dev
 * wallet and inserts a ProfitShareReceipt row for each one.
 *
 * Safe to re-run — uses INSERT … ON CONFLICT DO NOTHING via sequelize upsert
 * keyed on the unique txHash column (plus a composite per send when txHash is
 * shared, we key on the log index instead).
 *
 * Usage:
 *   node scripts/backfillProfitShareReceipts.js
 */

'use strict';

require('dotenv').config();
const { ethers } = require('ethers');
const config    = require('../src/config');
const { initDB, getDB } = require('../src/database');

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Chunk size for getLogs (some RPCs cap at 2000 blocks per request)
const BLOCK_CHUNK = 2000;

async function main() {
  console.log('[backfill] Initialising database…');
  await initDB();
  const { models } = getDB();
  const { ProfitSharePool, ProfitShareReceipt } = models;

  const provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);
  const devWallet = (config.evm.devWallet || '').toLowerCase();

  if (!devWallet) {
    console.error('[backfill] EVM_DEV_WALLET not set — aborting.');
    process.exit(1);
  }

  console.log('[backfill] Dev wallet:', devWallet);

  // Load all ERC20 profit share pools (skip 'native' — no Transfer event)
  const pools = await ProfitSharePool.findAll({
    where: { network: 'EVM' },
  });

  if (pools.length === 0) {
    console.log('[backfill] No EVM profit share pools found — nothing to do.');
    process.exit(0);
  }

  const latestBlock = await provider.getBlockNumber();
  console.log(`[backfill] Latest block: ${latestBlock}`);

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const pool of pools) {
    if (pool.tokenAddress === 'native') {
      console.log(`[backfill] Skipping native pool (${pool.tokenSymbol}) — no ERC20 events`);
      continue;
    }

    const tokenAddress = pool.tokenAddress.toLowerCase();
    console.log(`\n[backfill] Processing pool ${pool.tokenSymbol} (${pool.tokenAddress})`);

    // Pad devWallet to 32-byte topic
    const fromTopic = ethers.zeroPadValue(devWallet, 32);

    // Scan from block 0 in chunks
    for (let from = 0; from <= latestBlock; from += BLOCK_CHUNK) {
      const to = Math.min(from + BLOCK_CHUNK - 1, latestBlock);

      let logs;
      try {
        logs = await provider.getLogs({
          address: tokenAddress,
          fromBlock: from,
          toBlock:   to,
          topics: [ERC20_TRANSFER_TOPIC, fromTopic],
        });
      } catch (err) {
        console.warn(`[backfill]   getLogs error blocks ${from}-${to}: ${err.message} — skipping chunk`);
        continue;
      }

      if (logs.length === 0) continue;

      const iface = new ethers.Interface([
        'event Transfer(address indexed from, address indexed to, uint256 value)',
      ]);

      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }

        const toAddr   = parsed.args.to.toLowerCase();
        const rawValue = parsed.args.value; // BigInt
        const amount   = parseFloat(
          ethers.formatUnits(rawValue, pool.tokenDecimals)
        );
        const txHash   = log.transactionHash;

        // Use txHash + logIndex as a composite unique key stored in txHash column
        // so a single tx with multiple Transfer logs doesn't collide.
        // Format: "0xabc…123#42"
        const receiptKey = `${txHash}#${log.logIndex}`;

        // Get block timestamp for distributedAt
        let distributedAt = new Date();
        try {
          const block = await provider.getBlock(log.blockNumber);
          if (block?.timestamp) distributedAt = new Date(block.timestamp * 1000);
        } catch { /* use now */ }

        // Upsert by receiptKey stored in txHash field
        const [, created] = await ProfitShareReceipt.upsert({
          holderAddress:  toAddr,
          tokenAddress:   pool.tokenAddress,
          tokenSymbol:    pool.tokenSymbol,
          amount,
          txHash:         receiptKey,
          distributedAt,
        }, { conflictFields: ['txHash'] });

        if (created) {
          totalInserted++;
          console.log(`[backfill]   + ${pool.tokenSymbol} ${amount} → ${toAddr} (${txHash})`);
        } else {
          totalSkipped++;
        }
      }
    }
  }

  console.log(`\n[backfill] Done. Inserted: ${totalInserted}, Already existed: ${totalSkipped}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
