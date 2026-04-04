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
    creatorAccumulatedDeposit: {
      type: DataTypes.DECIMAL(36, 18),
      defaultValue: 0,
    },
    challengerAccumulatedDeposit: {
      type: DataTypes.DECIMAL(36, 18),
      defaultValue: 0,
    },
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
      type: DataTypes.ENUM('WAITING_CREATOR_DEPOSIT', 'WAITING_CHALLENGER', 'WAITING_CHALLENGER_DEPOSIT', 'WAITING_EXECUTION', 'COMPLETED', 'CANCELLED'),
      defaultValue: 'WAITING_CREATOR_DEPOSIT',
    },
    creatorTimedOut: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    challengerTimedOut: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    challengerClaimedDeposit: {
      // Set to true the moment the challenger clicks "I Sent the Deposit".
      // If this is true but challengerAccumulatedDeposit is 0, the bot likely
      // had a detection failure rather than the user never sending anything.
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    confirmedShame: {
      // Set to true ONLY when depositTimeout fires and positively confirms the
      // challenger never sent any funds (on-chain check passes). Used by
      // /wallofshame so that pre-feature historical records are never counted.
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    messageId: DataTypes.INTEGER,
    messageIdGroupChat: DataTypes.INTEGER,
    data: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
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
    sessionType: DataTypes.ENUM('INITIATING', 'CONFIRMING_DEPOSIT', 'CLAIMING_WINNINGS', 'INITIATING_DM_FLIP', 'LAST_GROUP_ACTIVITY', 'UPDATING_WALLET'),
    currentStep: DataTypes.STRING,
    data: DataTypes.JSON,
    expiresAt: DataTypes.DATE,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });

  // UserProfile Model - stores wallet addresses for receiving winnings and making deposits
  const UserProfile = sequelize.define('UserProfile', {
    userId: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
    },
    evmWalletAddress: DataTypes.STRING,         // Paxeer address to receive winnings & profit share
    evmDepositWalletAddress: DataTypes.STRING,  // User's wallet for sending EVM deposits
    favoriteTokens: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of { network, address, symbol, decimals } objects saved by the user',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });

  // FlipHolderAddress Model - known $FLIP token holder addresses for on-chain distribution
  // Admins add addresses here; each distribution cycle queries balanceOf on-chain for each entry.
  const FlipHolderAddress = sequelize.define('FlipHolderAddress', {
    address: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  }, {
    timestamps: true,
  });

  // ProfitSharePool Model - tracks accumulated flip fees for $FLIP holder distribution
  const ProfitSharePool = sequelize.define('ProfitSharePool', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    network: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'EVM', // 'EVM' or 'Solana'
    },
    tokenAddress: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    tokenSymbol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    tokenDecimals: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 18,
    },
    pendingAmount: {
      type: DataTypes.DECIMAL(36, 18),
      defaultValue: 0,
    },
    totalDistributed: {
      type: DataTypes.DECIMAL(36, 18),
      defaultValue: 0,
    },
    lastDistributedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    timestamps: true,
    // Unique per network+token so 'native' can exist for both EVM (PAX) and Solana (SOL)
    indexes: [{ unique: true, fields: ['network', 'tokenAddress'] }],
  });

  // PendingRefund Model - queue for automatic refunds (wrong token, wrong wallet, overpayment)
  // txHash is the unique dedup key so the same deposit can never be enqueued twice.
  const PendingRefund = sequelize.define('PendingRefund', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    txHash: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    network: {
      type: DataTypes.STRING, // 'EVM' | 'Solana'
      allowNull: false,
    },
    tokenAddress: {
      type: DataTypes.STRING, // 'NATIVE' or ERC20/SPL contract address
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(36, 18), // display units (already converted via ethers.formatUnits)
      allowNull: false,
    },
    senderAddress: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    reason: DataTypes.STRING, // 'wrong_token' | 'wrong_wallet' | 'overpayment'
    flipId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING, // 'PENDING' | 'PROCESSING' | 'REFUNDED' | 'FAILED'
      defaultValue: 'PENDING',
    },
    refundTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    errorMessage: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    attempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  }, {
    timestamps: true,
    indexes: [{ unique: true, fields: ['txHash'] }],
  });

  return {
    User,
    CoinFlip,
    Transaction,
    BotSession,
    UserProfile,
    FlipHolderAddress,
    ProfitSharePool,
    PendingRefund,
    sequelize, // Export sequelize so handlers can use it for queries
  };
};

module.exports = defineModels;
