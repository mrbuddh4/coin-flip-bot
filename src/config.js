require('dotenv').config();

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  database: {
    url: process.env.DATABASE_URL,
    dialect: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'coin_flip_bot',
    logging: process.env.LOG_LEVEL === 'debug' ? console.log : false,
  },
  evm: {
    rpcUrl: process.env.EVM_RPC_URL,
    privateKey: process.env.EVM_BOT_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY,
    walletAddress: process.env.EVM_BOT_WALLET_ADDRESS, // Optional: explicit address (derived from private key if not set)
    devWallet: process.env.EVM_DEV_WALLET,
    devPrivateKey: process.env.EVM_DEV_PRIVATE_KEY,
  },
  bot: {
    walletAddress: process.env.BOT_WALLET_ADDRESS,
    flipTimeoutSeconds: parseInt(process.env.FLIP_TIMEOUT_SECONDS) || 180,
    maxConcurrentFlipsPerGroup: parseInt(process.env.MAX_CONCURRENT_FLIPS_PER_GROUP) || 1,
    network: process.env.NETWORK || 'mainnet',
  },
  supportedTokens: parseSupportedTokens(process.env.SUPPORTED_TOKENS),
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

function parseSupportedTokens(tokenString) {
  if (!tokenString) return {};
  
  const tokens = {};
  const tokenList = tokenString.split(',');
  
  tokenList.forEach(token => {
    const parts = token.trim().split(':');
    if (parts.length === 4) {
      const [network, address, decimals, symbol] = parts;
      const key = `${network}_${symbol}`;
      tokens[key] = {
        network,
        address,
        decimals: parseInt(decimals),
        symbol,
      };
    }
  });
  
  return tokens;
}
