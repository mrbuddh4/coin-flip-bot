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
    devWallet: process.env.EVM_DEV_WALLET,
  },
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL,
    privateKey: process.env.SOL_BOT_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY,
    devWallet: process.env.SOL_DEV_WALLET,
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
      let [network, address, decimals, symbol] = parts;
      // Normalize network names to match database enum values
      if (network?.toUpperCase() === 'SOLANA') {
        network = 'Solana';
      }
      const key = `${network}:${address}`;
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
