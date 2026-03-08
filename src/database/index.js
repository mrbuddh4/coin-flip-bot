const { Sequelize } = require('sequelize');
const path = require('path');
const config = require('../config');
const defineModels = require('./models');

let sequelize;
let models;

const initDB = async () => {
  try {
    const dbConfig = {
      dialect: config.database.dialect,
      host: config.database.host,
      port: config.database.port,
      username: config.database.username,
      password: config.database.password,
      database: config.database.database,
      logging: config.database.logging,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000,
      },
    };

    sequelize = new Sequelize(dbConfig);

    models = defineModels(sequelize);

    // Set up associations
    models.CoinFlip.belongsTo(models.User, { as: 'creator', foreignKey: 'creatorId' });
    models.CoinFlip.belongsTo(models.User, { as: 'challenger', foreignKey: 'challengerId' });
    models.CoinFlip.belongsTo(models.User, { as: 'winner', foreignKey: 'winnerId' });

    models.Transaction.belongsTo(models.CoinFlip, { foreignKey: 'coinFlipId' });
    models.Transaction.belongsTo(models.User, { foreignKey: 'userId' });

    models.BotSession.belongsTo(models.User, { foreignKey: 'userId' });
    models.BotSession.belongsTo(models.CoinFlip, { foreignKey: 'coinFlipId' });

    await sequelize.authenticate();
    console.log('Database connection authenticated');

    await sequelize.sync({ alter: false });
    console.log('Database models synchronized');

    return { sequelize, models };
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
};

const getDB = () => {
  if (!sequelize || !models) {
    throw new Error('Database not initialized');
  }
  return { sequelize, models };
};

module.exports = {
  initDB,
  getDB,
};
