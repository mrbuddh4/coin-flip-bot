// Quick fix script to update the deposit wallet
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
    // Update the user with the correct deposit wallet
    // The user has transactions from 0x5ef988e94663cdd823a0faefa269848413f0a3ee
    // But their profile shows 0x026f46b2500e504343aa8e64245814e2ba8f06b9
    
    const result = await sequelize.query(`
      UPDATE "UserProfiles" 
      SET "evmDepositWalletAddress" = '0x5EF988e94663cDd823a0FAeFa269848413f0A3eE'
      WHERE "evmDepositWalletAddress" = '0x026f46b2500e504343aa8e64245814e2ba8f06b9'
      RETURNING telegram_id, "evmDepositWalletAddress";
    `);
    
    console.log('Updated wallet addresses:');
    console.log(result[0]);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
