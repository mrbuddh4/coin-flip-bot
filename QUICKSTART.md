# Quick Start Guide 🚀

Get the Coin Flip Bot running in 10 minutes!

## Prerequisites

- Node.js 16+ installed
- npm or yarn
- PostgreSQL 12+ (or use Docker)
- A Telegram Bot Token (from @BotFather)
- Basic knowledge of environment variables

**Quick PostgreSQL Setup with Docker:**
```bash
docker run -d \
  --name coin-flip-db \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=coin_flip_bot \
  -p 5432:5432 \
  postgres:15-alpine
```

## 5-Minute Setup

### 1. Create Bot on Telegram

1. Open Telegram and find @BotFather
2. Send `/newbot`
3. Follow the prompts
4. **Save your bot token** (looks like: `123456789:ABCDEFGHIJKLMNOPQRSTUVWxyz`)

### 2. Get RPC Endpoints

**For EVM (Ethereum):**
- Visit https://www.alchemy.com/
- Sign up free
- Create an app
- **Copy your API key** (RPC URL)

**For Solana:**
- Use free public RPC: `https://api.mainnet-beta.solana.com`
- (or create account at Helius, QuickNode, etc.)

### 3. Generate Wallets

**For EVM:**
```bash
# Using Node.js REPL
node
```
```javascript
const ethers = require('ethers');
const wallet = ethers.Wallet.createRandom();
console.log("Address:", wallet.address);
console.log("Private Key:", wallet.privateKey);
.exit
```

**For Solana:**
```bash
# Using Solana CLI
solana-keygen new  # Follow prompts
solana address     # View pubkey
```

Then base58 encode the secret key in ~/.config/solana/id.json

### 4. Fund Wallets

Send small amounts of tokens to these wallets:
- EVM wallet: Send some ETH + USDC
- Solana wallet: Send some SOL + USDC

### 5. Clone & Configure

```bash
# Clone repo
git clone <repo-url>
cd coin-flip-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

**Minimal .env:**
```env
TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWxyz

# PostgreSQL Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=password
DB_NAME=coin_flip_bot

# Blockchain
EVM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-api-key
EVM_PRIVATE_KEY=0x1234567890abcdef...

SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=[1,2,3,4,5,...]

SUPPORTED_TOKENS=EVM:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC
```

### 6. Run Bot

**Option A: Using docker-compose (easiest):**
```bash
docker-compose up -d
```

**Option B: Running locally:**
```bash
npm install
npm start
```

You should see:
```
✅ Bot ready!
🚀 Bot launched successfully
```

## Testing

1. **Create a Telegram group**
2. **Add your bot** to the group
3. **Send `/start`** in the group
4. **Bot should respond** with welcome message

## Troubleshooting Quick Fixes

| Issue | Solution |
|-------|----------|
| "Cannot find module" | Run `npm install` |
| Bot not responding | Check `TELEGRAM_BOT_TOKEN` is correct |
| "Invalid RPC URL" | Verify `EVM_RPC_URL` is reachable |
| Wallet error | Ensure `EVM_PRIVATE_KEY` starts with `0x` |
| PostgreSQL connection failed | Ensure PostgreSQL is running and credentials are correct in .env |
| Database error | Check DB_HOST, DB_PORT, DB_USER, DB_PASSWORD in .env |
| Using Docker? | Ensure containers are running: `docker-compose ps` |

## Next Steps

### Test with Testnet
1. Switch to Sepolia (Ethereum testnet)
2. Get free testnet tokens from faucets
3. Update .env with testnet endpoints
4. Restart bot

See [TOKENS.md](./TOKENS.md) for testnet details.

### Deploy to Production
1. Use a VPS (DigitalOcean, AWS, etc.)
2. Set `NODE_ENV=production`
3. Use systemd or Docker
4. Enable monitoring

See [Deployment](./README.md#deployment) in README.

### Add More Tokens
1. Find token address on etherscan.io
2. Add to `SUPPORTED_TOKENS` in .env:
   ```env
   SUPPORTED_TOKENS=EVM:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC,EVM:0xNewAddress:18:NewToken
   ```
3. Restart bot

## Understanding the Flow

```
User -> Clicks /start in group
      -> Bot shows "Start Flip?" button
      -> User clicks button
      -> Bot sends DM: "How much to wager?"
      -> User sends amount (e.g., "10")
      -> Bot sends wallet address
      -> User sends 10 tokens to that address
      -> User replies "confirmed" in DM
      -> Bot shows deposit confirmed
      -> Waiting for challenger...
      
Challenger -> Clicks "Accept Challenge"
           -> Same process as above
           -> Sends 10 tokens
           -> Confirms in DM
           
Bot -> Performs random coin flip
    -> Announces winner
    -> Shows "Claim Winnings button"
    
Winner -> Clicks button
       -> Enters wallet address in DM
       -> Bot sends 20 tokens immediately
       -> Game complete!
```

## Common Questions

**Q: Can I use testnet?**
A: Yes! Change RPC URLs to testnet endpoints and use testnet tokens.

**Q: Is my private key safe?**
A: Keys are encrypted at rest. Use separate wallets for each bot instance.

**Q: Can I use multiple chains?**
A: Yes! Add both EVM and Solana tokens to SUPPORTED_TOKENS.

**Q: What if user doesn't confirm?**
A: They have 3 minutes. After that, deposit times out and is refunded.

**Q: How are random results generated?**
A: Using Node.js Math.random() with cryptographic properties suitable for gaming.

**Q: Do you take fees?**
A: No built-in fee system yet. You can add one in executionHandler.js.

## Getting Help

1. **Check logs:** `tail -f nohup.out`
2. **Enable debug logging:** Set `LOG_LEVEL=debug` in .env
3. **Check database:** `sqlite3 data/bot.db`
4. **Common issues:** See README.md #Troubleshooting

## Security Checklist

Before going live:
- [ ] Use testnet first
- [ ] Keep private keys in .env (not in code)
- [ ] Use environment variables for secrets
- [ ] Enable backups of data/bot.db
- [ ] Monitor wallet balances
- [ ] Log all transactions
- [ ] Test cancellation flows
- [ ] Rate limit API calls

## Next Resources

- [Full README](./README.md) - Complete documentation
- [Token List](./TOKENS.md) - Common token addresses
- [Database Schema](./README.md#database-schema) - Data structure
- [API Reference](./README.md#api-reference) - Code examples

---

**Happy flipping! 🪙**

Need help? Check the README or enable DEBUG logging:
```bash
LOG_LEVEL=debug npm start
```
