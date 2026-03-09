const { initDB, getDB } = require('./src/database');
const { Op } = require('sequelize');

async function findStuckFlips() {
  try {
    console.log('Initializing database...');
    await initDB();
    
    const { models } = getDB();
    
    console.log('\n=== Finding stuck flips ===');
    const stuckFlips = await models.CoinFlip.findAll({
      where: {
        status: {
          [Op.notIn]: ['COMPLETED', 'CANCELLED'],
        },
      },
      order: [['createdAt', 'DESC']],
    });

    console.log(`Found ${stuckFlips.length} stuck flip(s):\n`);
    
    for (const flip of stuckFlips) {
      console.log(`Flip ID: ${flip.id}`);
      console.log(`  Creator ID: ${flip.creatorId}`);
      console.log(`  Challenger ID: ${flip.challengerId}`);
      console.log(`  Status: ${flip.status}`);
      console.log(`  Group Chat ID: ${flip.groupChatId}`);
      console.log(`  Created: ${flip.createdAt}`);
      console.log('');
    }

    // List sessions
    console.log('=== Finding stuck sessions ===');
    const stuckSessions = await models.BotSession.findAll({
      where: {
        sessionType: {
          [Op.ne]: 'LAST_GROUP_ACTIVITY',
        },
      },
      order: [['updatedAt', 'DESC']],
      limit: 10,
    });

    console.log(`Found ${stuckSessions.length} session(s):\n`);
    for (const session of stuckSessions) {
      console.log(`Session ID: ${session.id}`);
      console.log(`  User ID: ${session.userId}`);
      console.log(`  Type: ${session.sessionType}`);
      console.log(`  Current Step: ${session.currentStep}`);
      console.log(`  Flip ID: ${session.coinFlipId}`);
      console.log('');
    }

    if (stuckFlips.length > 0) {
      console.log('\n=== Cancelling stuck flips ===');
      for (const flip of stuckFlips) {
        flip.status = 'CANCELLED';
        await flip.save();
        console.log(`✅ Cancelled flip ${flip.id}`);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

findStuckFlips();
