const config = require('../config');

// One source of connection settings for Sequelize and read-only recovery tools.
function connectionOptions(database = config.database) {
  if (database.url) return { connectionString: database.url };
  return {
    host: database.host, port: database.port, user: database.username,
    password: database.password, database: database.database,
  };
}

function createSequelize(Sequelize, database = config.database) {
  const options = {
    dialect: 'postgres', logging: database.logging,
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  };
  if (database.url) return new Sequelize(database.url, options);
  return new Sequelize({
    ...options, host: database.host, port: database.port,
    username: database.username, password: database.password,
    database: database.database,
  });
}

module.exports = { connectionOptions, createSequelize };
