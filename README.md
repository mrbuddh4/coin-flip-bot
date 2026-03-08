# Coin Flip Bot 🪙

A Telegram bot for peer-to-peer coin flip games supporting EVM and Solana tokens. Players wager tokens, the bot randomly determines a winner, and automatically distributes winnings.

## Features

- 🪙 Peer-to-peer coin flip games
- 💰 Support for both EVM and Solana tokens
- 🎰 Cryptographically secure random coin flip
- 🔐 Encrypted wallet management
- ⏱️ 3-minute timeout for each phase
- 🚫 Single active flip per group
- 💸 Automatic payout to winners
- 📊 Player statistics tracking

## Architecture

```
src/
├── index.js              # Main bot entry point
├── config.js             # Configuration management
├── handlers/             # Game flow handlers
│   ├── flipHandler.js    # Flip initialization and acceptance
│   └── executionHandler.js # Coin flip execution and payouts
├── blockchain/           # Blockchain interactions
│   ├── evmHandler.js     # EVM (Ethereum, BSC, etc.)
│   ├── solanaHandler.js  # Solana integration
│   └── manager.js        # Unified blockchain interface
├── database/             # Database layer
│   ├── models.js         # Sequelize models
│   └── index.js          # Database initialization
└── utils/                # Utility functions
    ├── helpers.js        # Helper functions
    └── logger.js         # Logging utility
```

## Prerequisites

- Node.js 16+
- npm or yarn
- PostgreSQL 12+ (or use Docker Compose)
- Telegram Bot Token (from @BotFather)
- EVM RPC endpoint (Alchemy, Infura, etc.)
- Solana RPC endpoint

## Installation

1. **Clone the repository**
```bash
cd coin-flip-bot
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment variables**
```bash
cp .env.example .env
```

4. **Edit `.env` with your configuration:**
```env
TELEGRAM_BOT_TOKEN=your_bot_token
EVM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
EVM_PRIVATE_KEY=0x...
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=[1,2,3,...]
SUPPORTED_TOKENS=EVM:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC,SOLANA:EPjFWdd5Au....:6:USDC
```

## Configuration

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456789:ABCDEFGHIJKLMNOPQRSTUVWxyz` |
| `DB_HOST` | PostgreSQL hostname | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USER` | PostgreSQL user | `coin_flip_bot` |
| `DB_PASSWORD` | PostgreSQL password | `secure_password` |
| `DB_NAME` | PostgreSQL database name | `coin_flip_bot` |
| `EVM_RPC_URL` | Ethereum RPC endpoint | `https://eth-mainnet.g.alchemy.com/v2/...` |
| `EVM_PRIVATE_KEY` | Private key (0x prefixed) | `0x...` |
| `SOLANA_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `SOLANA_PRIVATE_KEY` | Solana keypair (JSON array) | `[1,2,3,...]` |
| `BOT_WALLET_ADDRESS` | Wallet to receive fees (optional) | `0x...` |
| `FLIP_TIMEOUT_SECONDS` | Timeout per phase | `180` |
| `NETWORK` | Network mode | `mainnet` or `testnet` |
| `SUPPORTED_TOKENS` | Comma-separated tokens | See format below |
| `LOG_LEVEL` | Logging level | `info`, `debug`, `warn`, `error` |

### Token Configuration Format

```env
SUPPORTED_TOKENS=NETWORK:ADDRESS:DECIMALS:SYMBOL,...

NETWORK can be: EVM, Solana
ADDRESS is the token contract address
DECIMALS is the token decimal places (usually 18 for EVM, 6 for Solana)
SYMBOL is the short name (USDC, USDT, etc.)

Example:
SUPPORTED_TOKENS=EVM:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC,EVM:0xdac17f958d2ee523a2206206994597c13d831ec7:6:USDT,SOLANA:EPjFWdd5Au4UsJx2QH91uNjjnNp6sKc8YYHCCKjvn7fU:6:USDC
```

## Usage

### Running the Bot

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

### Game Flow

#### 1. Starting a Flip (Creator)
- User clicks `/start` in group chat
- Selects a token
- Receives DM asking for wager amount
- Sends tokens to generated address
- Confirms deposit with "confirmed"

#### 2. Accepting Challenge
- Other user clicks "Accept Challenge" button
- Receives DM with deposit instructions
- Sends tokens and confirms
- 3-minute timeout for confirmation

#### 3. Coin Flip Execution
- Bot performs random coin flip
- Posts result in group
- Winner clicks "Claim Winnings"
- Provides wallet address
- Receives 2x wager automatically

#### 4. Cancellation
- Creator can cancel if no challenger within 3 minutes
- Deposit is refunded

## Database Schema

### Users
- `telegramId`: Unique user ID
- `username`/`firstName`/`lastName`: User info
- `walletAddress`: Primary wallet
- `totalWagered`: Total amount wagered
- `totalWon`: Total winnings

### CoinFlips
- `id`: UUID
- `creatorId`/`challengerId`: Player IDs
- `wagerAmount`: Amount per player
- `tokenNetwork`/`tokenAddress`: Token details
- `status`: Current game state
- `flipResult`: 0 (creator) or 1 (challenger)
- `winnerId`: Winner's ID

### FlipWallets
- Temporary wallet per flip per player
- Stores encrypted private keys
- Tracks deposit addresses

### Transactions
- `type`: DEPOSIT or PAYOUT
- `status`: PENDING, CONFIRMED, FAILED
- `txHash`: Blockchain transaction hash

## Security Considerations

🔐 **Encryption:**
- Private keys encrypted with AES-256-CBC
- Encryption key derived from master private key

🚀 **Best Practices:**
- Never commit `.env` files
- Use hardware wallet for hot wallet
- Regularly backup database
- Monitor wallet balances
- Implement rate limiting in production

⚠️ **Risks:**
- Smart contract vulnerabilities (audit contracts)
- Network congestion (implement gas limit checks)
- Private key exposure (rotate keys regularly)
- User input validation (already implemented)

## Troubleshooting

### Bot not responding
- Check `TELEGRAM_BOT_TOKEN` is correct
- Verify internet connection
- Check logs with `LOG_LEVEL=debug`

### Deposits not detected
- Verify RPC endpoint is working
- Check token contract address
- Ensure sufficient gas for transactions

### Transaction failures
- Check wallet has sufficient balance
- Verify gas prices aren't too high
- Check network congestion

## Testing

```bash
npm test
```

Create a test group and test bot with test tokens:

```env
NETWORK=testnet
EVM_RPC_URL=https://sepolia.infura.io/...
SOLANA_RPC_URL=https://api.devnet.solana.com
```

## Deployment

### Docker
```bash
docker build -t coin-flip-bot .
docker run -e TELEGRAM_BOT_TOKEN=... --env-file .env coin-flip-bot
```

### Systemd Service
```ini
[Unit]
Description=Coin Flip Bot
After=network.target

[Service]
Type=simple
User=bot
WorkingDirectory=/opt/coin-flip-bot
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
```

## API Reference

### Database Models

```javascript
// Create user
User.create({
  telegramId: 123456,
  firstName: "John"
})

// Create flip
CoinFlip.create({
  groupChatId: -100123456,
  creatorId: 123456,
  wagerAmount: "100.5",
  tokenNetwork: "EVM"
})

// Start game flow
FlipHandler.startFlipInGroup(ctx, token)
ExecutionHandler.executeFlip(flipId, ctx)
```

## Limitations

- Single independent bot instance only
- SQLite (use PostgreSQL for scaling)
- No rate limiting (implement in production)
- No fee collection mechanism
- Manual wallet management

## Future Improvements

- [ ] Multi-instance support with Redis
- [ ] PostgreSQL/MongoDB support
- [ ] Fee collection and bot revenue
- [ ] Leaderboards and rankings
- [ ] Multiple games (dice, higher/lower, etc.)
- [ ] Multiplayer tournaments
- [ ] Staking mechanisms
- [ ] Web dashboard

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review logs with debug logging
3. Open an issue on GitHub
4. Contact support

## License

MIT License

## Disclaimer

This bot facilitates peer-to-peer gambling. Users assume all risk. The developer is not responsible for losses. Use at your own risk.

---

**Happy flipping! 🪙**
