const { DataTypes } = require('sequelize');

// Models will be initialized in database/index.js

const defineModels = (sequelize) => {
  // User Model
  const User = sequelize.define('User', {
    telegramId: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
    },
    username: DataTypes.STRING,
    firstName: DataTypes.STRING,
    lastName: DataTypes.STRING,
    walletAddress: DataTypes.STRING,
    walletNetwork: DataTypes.ENUM('EVM', 'Solana'),
    totalWagered: {
      type: DataTypes.DECIMAL(36, 18),
      defaultValue: 0,
    },
    totalWon: {
      type: DataTypes.DECIMAL(36, 18),
      defaultValue: 0,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });

  // CoinFlip Model - represents a single flip game
  const CoinFlip = sequelize.define('CoinFlip', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    groupChatId: DataTypes.BIGINT,
    creatorId: DataTypes.BIGINT,
    challengerId: DataTypes.BIGINT,
    tokenNetwork: DataTypes.ENUM('EVM', 'Solana'),
    tokenAddress: DataTypes.STRING,
    tokenSymbol: DataTypes.STRING,
    tokenDecimals: DataTypes.INTEGER,
    wagerAmount: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false,
    },
    creatorDepositWalletAddress: DataTypes.STRING,
    challengerDepositWalletAddress: DataTypes.STRING,
    creatorDepositTxHash: DataTypes.STRING,
    challengerDepositTxHash: DataTypes.STRING,
    creatorDepositConfirmed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    challengerDepositConfirmed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    flipResult: DataTypes.ENUM('CREATOR', 'CHALLENGER'), // 0 or 1
    winnerId: DataTypes.BIGINT,
    winningTxHash: DataTypes.STRING,
    claimedByWinner: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    status: {
      type: DataTypes.ENUM('WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION', 'COMPLETED', 'CANCELLED'),
      defaultValue: 'WAITING_CHALLENGER',
    },
    creatorTimedOut: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    challengerTimedOut: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    messageId: DataTypes.INTEGER,
    messageIdGroupChat: DataTypes.INTEGER,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  }, {
    timestamps: true,
  });

  // Transaction Model - for tracking deposits and payouts
  const Transaction = sequelize.define('Transaction', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    coinFlipId: DataTypes.UUID,
    userId: DataTypes.BIGINT,
    type: DataTypes.ENUM('DEPOSIT', 'PAYOUT'),
    network: DataTypes.ENUM('EVM', 'Solana'),
    tokenAddress: DataTypes.STRING,
    tokenSymbol: DataTypes.STRING,
    amount: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false,
    },
    fromAddress: DataTypes.STRING,
    toAddress: DataTypes.STRING,
    txHash: DataTypes.STRING,
    status: {
      type: DataTypes.ENUM('PENDING', 'CONFIRMED', 'FAILED'),
      defaultValue: 'PENDING',
    },
    confirmations: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });

  // Session Model - track active bot conversations
  const BotSession = sequelize.define('BotSession', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    userId: DataTypes.BIGINT,
    coinFlipId: DataTypes.UUID,
    sessionType: DataTypes.ENUM('INITIATING', 'CONFIRMING_DEPOSIT', 'CLAIMING_WINNINGS'),
    currentStep: DataTypes.STRING,
    data: DataTypes.JSON,
    expiresAt: DataTypes.DATE,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });

  return {
    User,
    CoinFlip,
    Transaction,
    BotSession,
  };
};

module.exports = defineModels;
