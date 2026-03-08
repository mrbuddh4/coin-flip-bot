# File Directory Reference

## Project Files Created

### Root Configuration Files
- `package.json` - NPM dependencies and scripts
- `.env.example` - Environment template
- `.gitignore` - Git ignore patterns
- `Dockerfile` - Docker containerization
- `docker-compose.yml` - Docker compose config
- `setup.sh` - Interactive setup script

### Documentation Files
- `README.md` - Complete feature documentation (850+ lines)
- `QUICKSTART.md` - 5-10 minute setup guide
- `TOKENS.md` - Token address reference and configuration
- `TESTING.md` - Testing guide and examples
- `DEPLOYMENT.md` - Production deployment instructions
- `ARCHITECTURE.md` - System architecture and diagrams
- `PROJECT_SUMMARY.md` - This project overview

### Application Code

#### src/index.js (Main Bot)
- Bot initialization
- Middleware setup
- Command handlers
- Message routing
- Callback handling

#### src/config.js (Configuration)
- Environment variable parsing
- Configuration object
- Token parsing
- Network settings

#### src/handlers/flipHandler.js (Flip Logic)
- Start flip in group
- Process wager amount
- Confirm creator deposit
- Accept flip challenge
- Timeout handling

#### src/handlers/executionHandler.js (Execution & Payouts)
- Execute coin flip
- Claim winnings
- Process payout address
- Handle cancellation

#### src/handlers/adminHandler.js (Administration)
- Statistics display
- Health checks
- User management
- Debug information
- Admin command registration

#### src/blockchain/evmHandler.js (EVM Chain)
- Wallet generation
- Token balance checking
- Token transfers
- Transaction status
- Address validation

#### src/blockchain/solanaHandler.js (Solana Chain)
- Solana wallet generation
- SPL token balance
- Token transfers
- Native SOL transfers
- Transaction verification

#### src/blockchain/manager.js (Blockchain Manager)
- Unified blockchain interface
- Private key encryption/decryption
- Wallet generation delegation
- Deposit verification
- Payout execution

#### src/database/models.js (Data Models)
- User model
- CoinFlip model
- Transaction model
- BotSession model
- Model associations

#### src/database/index.js (Database Init)
- Sequelize initialization
- Database authentication
- Model synchronization
- Connection management

#### src/database/utils.js (Database Utilities)
- User management
- Flip queries
- Transaction recording
- User statistics
- Session cleanup
- Database analytics

#### src/utils/helpers.js (Helper Functions)
- Coin flip randomization
- Token amount formatting
- Address formatting
- Configuration validation
- Time formatting
- Number validation

#### src/utils/logger.js (Logging)
- Log level management
- Formatted log output
- Error logging
- Debug logging
- Info logging

### Data Directory
- `data/` - Database storage (created at runtime)

## Total Project Size
- **Code Files**: 14 (application logic)
- **Configuration Files**: 6 (setup and config)
- **Documentation Files**: 7 (guides and reference)
- **Total Files**: 27

## File Dependencies

```
index.js
├── config.js
├── database/index.js
│   └── database/models.js
│       └── database/utils.js
├── blockchain/manager.js
│   ├── blockchain/evmHandler.js
│   └── blockchain/solanaHandler.js
├── handlers/flipHandler.js
│   └── utils/helpers.js
├── handlers/executionHandler.js
│   └── utils/helpers.js
├── handlers/adminHandler.js
│   └── database/utils.js
└── utils/logger.js
```

## Documentation Map

| Document | Purpose | Length |
|----------|---------|--------|
| README.md | Complete feature guide | 850+ lines |
| QUICKSTART.md | Setup guide | 400+ lines |
| TOKENS.md | Token reference | 300+ lines |
| TESTING.md | Testing guide | 500+ lines |
| DEPLOYMENT.md | Production guide | 600+ lines |
| ARCHITECTURE.md | System design | 500+ lines |
| PROJECT_SUMMARY.md | Overview | 300+ lines |

**Total Documentation**: ~3,800 lines

## Getting Started Files

1. **First Time Setup**
   - Read: `QUICKSTART.md`
   - Use: `setup.sh`

2. **Understanding System**
   - Read: `README.md`
   - Reference: `ARCHITECTURE.md`

3. **Configuring Tokens**
   - Reference: `TOKENS.md`
   - Edit: `.env`

4. **Deployment**
   - Read: `DEPLOYMENT.md`
   - Use: `docker-compose.yml` or `setup.sh`

5. **Testing**
   - Read: `TESTING.md`
   - Run: `npm test`

## File Access Guide

### For Understanding Code
```
Want to understand...          → Read file...
├─ How bot starts              → src/index.js
├─ Game flow                   → src/handlers/flipHandler.js
├─ Blockchain interactions     → src/blockchain/manager.js
├─ Data models                 → src/database/models.js
└─ Helper functions            → src/utils/helpers.js
```

### For Setup & Deployment
```
Want to...                     → Use file...
├─ Quick start                 → QUICKSTART.md + setup.sh
├─ Production deploy           → DEPLOYMENT.md + docker-compose.yml
├─ Configure tokens            → TOKENS.md + .env
├─ Find token addresses        → TOKENS.md
└─ Understand architecture     → ARCHITECTURE.md
```

### For Development
```
Want to...                     → Check/run...
├─ Install dependencies        → npm install
├─ Start development           → npm run dev
├─ Run tests                   → npm test
├─ Enable debug logging        → LOG_LEVEL=debug npm start
└─ Admin commands              → /admin_stats, /admin_health
```

## Environment Variables Checklist

Required in .env:
- [ ] TELEGRAM_BOT_TOKEN
- [ ] EVM_RPC_URL
- [ ] EVM_PRIVATE_KEY
- [ ] SOLANA_RPC_URL
- [ ] SOLANA_PRIVATE_KEY
- [ ] SUPPORTED_TOKENS

Optional in .env:
- [ ] BOT_WALLET_ADDRESS
- [ ] FLIP_TIMEOUT_SECONDS
- [ ] NETWORK
- [ ] LOG_LEVEL
- [ ] ADMIN_IDS

## Directory Tree (Full Structure)

```
coin-flip-bot/
├── README.md ........................ (Documentation)
├── QUICKSTART.md .................... (Quick Setup)
├── TOKENS.md ........................ (Token Reference)
├── TESTING.md ....................... (Testing Guide)
├── DEPLOYMENT.md .................... (Deploy Guide)
├── ARCHITECTURE.md .................. (Architecture)  
├── PROJECT_SUMMARY.md .............. (This File)
├── package.json ..................... (Dependencies)
├── .env.example ..................... (Config Template)
├── .gitignore ....................... (Git Config)
├── Dockerfile ....................... (Docker Build)
├── docker-compose.yml ............... (Docker Run)
├── setup.sh ......................... (Setup Script)
├── data/ ............................ (Database)
└── src/
    ├── index.js ..................... (Bot Entry Point)
    ├── config.js .................... (Configuration)
    ├── handlers/
    │   ├── flipHandler.js ........... (Flip Logic)
    │   ├── executionHandler.js ...... (Execution)
    │   └── adminHandler.js .......... (Admin Commands)
    ├── blockchain/
    │   ├── evmHandler.js ............ (EVM Chain)
    │   ├── solanaHandler.js ......... (Solana Chain)
    │   └── manager.js ............... (Blockchain Manager)
    ├── database/
    │   ├── models.js ................ (ORM Models)
    │   ├── index.js ................. (DB Init)
    │   └── utils.js ................. (DB Utilities)
    └── utils/
        ├── helpers.js ............... (Helpers)
        └── logger.js ................ (Logger)
```

## Quick File Reference

**Bot Core**: `src/index.js`  
**Game Logic**: `src/handlers/flipHandler.js`  
**Payouts**: `src/handlers/executionHandler.js`  
**EVM Support**: `src/blockchain/evmHandler.js`  
**Solana Support**: `src/blockchain/solanaHandler.js`  
**Database**: `src/database/models.js`  

**Config**: `.env` (after setup)  
**Setup**: `QUICKSTART.md` or `setup.sh`  
**Deploy**: `DEPLOYMENT.md` + `docker-compose.yml`  

---

**All files are documented and ready for production use!**
