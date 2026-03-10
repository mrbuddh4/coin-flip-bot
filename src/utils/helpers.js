/**
 * Perform a random coin flip
 * Returns 0 (creator) or 1 (challenger)
 */
const performCoinFlip = () => {
  return Math.random() < 0.5 ? 0 : 1;
};

/**
 * Format token amount with decimals
 */
const formatTokenAmount = (amount, decimals = 18) => {
  const divisor = Math.pow(10, decimals);
  return (parseFloat(amount) / divisor).toFixed(decimals);
};

/**
 * Parse token amount to smallest unit
 */
const parseTokenAmount = (amount, decimals = 18) => {
  const multiplier = Math.pow(10, decimals);
  return Math.floor(parseFloat(amount) * multiplier).toString();
};

/**
 * Format address for display (short version)
 */
const formatAddress = (address, chars = 6) => {
  return `${address.substring(0, chars)}...${address.substring(address.length - chars)}`;
};

/**
 * Validate environment variables required for bot
 */
const validateConfig = () => {
  const required = [
    'TELEGRAM_BOT_TOKEN',
    'EVM_RPC_URL',
    'EVM_PRIVATE_KEY',
    'SOLANA_RPC_URL',
    'SOLANA_PRIVATE_KEY',
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

/**
 * Convert seconds to minutes and seconds display
 */
const formatTimeRemaining = (seconds) => {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
};

/**
 * Check if string is valid number
 */
const isValidNumber = (str) => {
  const num = parseFloat(str);
  return !isNaN(num) && num > 0;
};

/**
 * Generate random ID - using crypto for better randomness
 */
const generateId = () => {
  const crypto = require('crypto');
  return crypto.randomUUID();
};

/**
 * Throttle function executions
 */
const throttle = (func, limit) => {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
};

/**
 * Retry function with exponential backoff
 */
const retryWithBackoff = async (fn, maxRetries = 3, delay = 1000) => {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }
  
  throw lastError;
};

/**
 * Format network name for display
 */
const formatNetworkName = (network) => {
  const networkMap = {
    'EVM': 'Paxeer',
    'SOLANA': 'Solana',
  };
  return networkMap[network] || network;
};

/**
 * Get video duration in milliseconds
 */
const getVideoDuration = async (filePath) => {
  try {
    const getDuration = require('get-video-duration');
    const durationSeconds = await getDuration(filePath);
    return Math.ceil(durationSeconds * 1000); // Convert to milliseconds and round up
  } catch (error) {
    console.warn('Failed to get video duration:', error.message);
    return 7000; // Default to 7 seconds if detection fails
  }
};

/**
 * Safe JSON parse
 */
const safeJsonParse = (str, defaultValue = {}) => {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
};

module.exports = {
  performCoinFlip,
  formatTokenAmount,
  parseTokenAmount,
  formatAddress,
  validateConfig,
  formatTimeRemaining,
  isValidNumber,
  generateId,
  throttle,
  retryWithBackoff,
  formatNetworkName,
  getVideoDuration,
  safeJsonParse,
};
