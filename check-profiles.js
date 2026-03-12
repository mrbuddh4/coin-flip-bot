// Check what's in the database
const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: false,
  },
});

(async () => {
  try {
    console.log('Connecting to database...');
    await sequelize.authenticate();
    console.log('Connected successfully\n');

    // Get all user profiles to see what we have
    const profiles = await sequelize.query(`
      SELECT "userId", "evmWalletAddress", "evmDepositWalletAddress" 
      FROM "UserProfiles" 
      ORDER BY "userId"
      LIMIT 20;
    `);
    
    console.log('All UserProfiles in database:');
    console.log(JSON.stringify(profiles[0], null, 2));
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
