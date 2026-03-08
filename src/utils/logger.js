const config = require('../config');

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const LEVEL_NAMES = {
  0: 'ERROR',
  1: 'WARN',
  2: 'INFO',
  3: 'DEBUG',
};

const getCurrentLevelValue = () => {
  return LOG_LEVELS[config.logging.level.toUpperCase()] || LOG_LEVELS.INFO;
};

const shouldLog = (level) => {
  return level <= getCurrentLevelValue();
};

const formatLog = (level, message, data = null) => {
  const timestamp = new Date().toISOString();
  const levelName = LEVEL_NAMES[level];
  
  let output = `[${timestamp}] [${levelName}] ${message}`;
  
  if (data) {
    output += '\n' + JSON.stringify(data, null, 2);
  }
  
  return output;
};

const logger = {
  error: (message, data = null) => {
    if (shouldLog(LOG_LEVELS.ERROR)) {
      console.error(formatLog(LOG_LEVELS.ERROR, message, data));
    }
  },

  warn: (message, data = null) => {
    if (shouldLog(LOG_LEVELS.WARN)) {
      console.warn(formatLog(LOG_LEVELS.WARN, message, data));
    }
  },

  info: (message, data = null) => {
    if (shouldLog(LOG_LEVELS.INFO)) {
      console.log(formatLog(LOG_LEVELS.INFO, message, data));
    }
  },

  debug: (message, data = null) => {
    if (shouldLog(LOG_LEVELS.DEBUG)) {
      console.log(formatLog(LOG_LEVELS.DEBUG, message, data));
    }
  },
};

module.exports = logger;
