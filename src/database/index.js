const { Sequelize } = require('sequelize');
const { createSequelize } = require('./connection');
const defineModels = require('./models');

let sequelize;
let models;

const initDB = async () => {
  try {
    sequelize = createSequelize(Sequelize);

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

    // Recovery must never silently rewrite an existing financial schema.
    const schemaMode = process.env.DB_SCHEMA_MODE || 'verify';
    if (!['verify', 'create', 'alter'].includes(schemaMode)) {
      throw new Error('DB_SCHEMA_MODE must be verify, create or alter');
    }
    if (schemaMode === 'verify') {
      const queryInterface = sequelize.getQueryInterface();
      for (const model of Object.values(models)) {
        if (!model || typeof model.getTableName !== 'function') continue;
        const columns = await queryInterface.describeTable(model.getTableName());
        const missing = Object.values(model.rawAttributes)
          .map(attribute => attribute.field)
          .filter(field => !Object.hasOwn(columns, field));
        if (missing.length) throw new Error(`Schema mismatch in ${model.name}: missing columns ${missing.join(', ')}`);
      }
      console.log('Database tables and columns verified (types, enums and indexes require migration review)');
    } else {
      // Only on a backed-up database after reviewing the generated changes.
      await sequelize.sync({ alter: schemaMode === 'alter' });
      console.log(`Database schema initialization completed (${schemaMode})`);
    }

    return { sequelize, models };
  } catch (error) {
    if (sequelize) await sequelize.close().catch(() => {});
    sequelize = undefined; models = undefined;
    throw error;
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
