// Fix wallet address in database
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
    console.log('Connected successfully');

    // Update the user's deposit wallet from old to new
    const result = await sequelize.query(`
      UPDATE "UserProfiles" 
      SET "evmDepositWalletAddress" = '0x5EF988e94663cDd823a0FAeFa269848413f0A3eE'
      WHERE "evmDepositWalletAddress" = '0x026f46b2500e504343aa8e64245814e2ba8f06b9'
      RETURNING "userId", "evmDepositWalletAddress";
    `);
    
    console.log('✅ Wallet update successful!');
    console.log('Updated profiles:', result[0]);
    
    if (result[0].length === 0) {
      console.log('⚠️  No profiles found with old wallet address');
    }
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
