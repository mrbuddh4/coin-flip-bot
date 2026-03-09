#!/usr/bin/env node

require('dotenv').config();
const { initDB, getDB } = require('./src/database');
const { Op } = require('sequelize');

async function cancelActiveFlips() {
  try {
    console.log('Initializing database...');
    await initDB();
    const { models } = getDB();

    // Find all active flips (not completed or cancelled)
    const activeFlips = await models.CoinFlip.findAll({
      where: {
        status: {
          [Op.notIn]: ['COMPLETED', 'CANCELLED'],
        },
      },
    });

    if (activeFlips.length === 0) {
      console.log('✅ No active flips to cancel');
      process.exit(0);
    }

    console.log(`Found ${activeFlips.length} active flip(s):`);
    
    for (const flip of activeFlips) {
      console.log(`  - Flip ${flip.id} (Status: ${flip.status})`);
      flip.status = 'CANCELLED';
      await flip.save();
      console.log(`    ✅ Cancelled`);
    }

    console.log('\n✅ All active flips have been cancelled');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

cancelActiveFlips();
