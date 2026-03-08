# Architecture Documentation

## System Overview

The Coin Flip Bot is a peer-to-peer gambling bot for Telegram that facilitates crypto token trading through randomized coin flips.

```
┌─────────────────────────────────────────────────────────────┐
│                    Telegram Chat Groups                      │
├─────────────────────────────────────────────────────────────┤
│                         Bot UI Layer                         │
│  (Buttons, Inline Keyboards, Messages)                      │
├─────────────────────────────────────────────────────────────┤
│              Bot Application (telegraf.js)                   │
│  ├─ Command Handlers (/start, /help, /stats)               │
│  ├─ Message Router (DM vs Group)                           │
│  ├─ Callback Handlers (Button clicks)                      │
│  └─ Session Management                                      │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐│
│  │ FlipHandler    │  │ExecutionHandler│  │AdminHandler    ││
│  │ (Game Flow)    │  │(Execution)     │  │(Management)    ││
│  └────────────────┘  └────────────────┘  └────────────────┘│
├─────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐│
│  │ EVMHandler     │  │SolanaHandler   │  │BlockchainMgr   ││
│  │(Ethereum-like) │  │(Solana chain)  │  │(Unified API)   ││
│  └────────────────┘  └────────────────┘  └────────────────┘│
├─────────────────────────────────────────────────────────────┤
│         Database Layer (Sequelize + PostgreSQL)             │
│  ├─ Users        ├─ CoinFlips    ├─ Transactions          │
│  └─ BotSessions                                             │
├─────────────────────────────────────────────────────────────┤
│      Blockchain Networks (Ethereum, BSC, Solana)            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. **Entry Point** (`src/index.js`)
- Initializes bot, database, and blockchain
- Sets up middleware and command handlers
- Manages callback routing
- Error handling

### 2. **Handlers** (`src/handlers/`)

#### FlipHandler
Manages flip initiation and acceptance
- `startFlipInGroup()` - Creates new flip in group
- `processWagerAmount()` - Accepts wager from user
- `confirmCreatorDeposit()` - Verifies creator's deposit
- `acceptFlip()` - Challenger accepts flip
- `handleDepositTimeout()` - Timeout management

#### ExecutionHandler
Manages coin flip execution and payouts
- `executeFlip()` - Performs RNG and announces winner
- `claimWinnings()` - Initiates claim process
- `processPayoutAddress()` - Receives wallet address
- `cancelFlip()` - Cancels flip if no challenger

#### AdminHandler
Bot administration and monitoring
- `stats()` - Show bot statistics
- `health()` - Health check
- `users()` - List top users
- `debug()` - Debug information

### 3. **Blockchain Layer** (`src/blockchain/`)

#### EVMHandler
Manages Ethereum and EVM-compatible chains
```javascript
- getTokenBalance()         // Check token balance
- getNativeBalance()        // Check ETH/native balance
- transferToken()           // Send ERC20 tokens
- transferNative()          // Send native tokens
- checkTransactionStatus()  // Verify transaction
- isValidAddress()          // Validate address
```

#### SolanaHandler
Manages Solana blockchain interactions
```javascript
- getTokenBalance()         // Check SPL token balance  
- getNativeBalance()        // Check SOL balance
- transferToken()           // Send SPL tokens
- transferNative()          // Send SOL
- checkTransactionStatus()  // Verify transaction
- isValidAddress()          // Validate pubkey
```

#### BlockchainManager
Unified interface for both chains
```javascript
- getHandler()              // Get appropriate handler
- getBotWalletAddress()     // Get bot's wallet for network
- verifyDeposit()          // Check deposit on bot's wallet
- sendWinnings()           // Send funds from bot wallet
- checkTransactionConfirmation() // Verify tx confirmation
```

### 4. **Database Layer** (`src/database/`)

#### Models
- **User** - Player information and statistics
- **CoinFlip** - Game state and results
- **Transaction** - Deposit and payout records
- **BotSession** - DM conversation state

#### Utilities
- `getOrCreateUser()` - User management
- `getActiveFlipInGroup()` - Find active game
- `recordTransaction()` - Log all transfers
- `getUserStats()` - Get player statistics
- `getDatabaseStats()` - Bot analytics

### 5. **Utilities** (`src/utils/`)

#### Logger
```javascript
- error()  // Critical errors
- warn()   // Warnings
- info()   // General info
- debug()  // Debug details
```

#### Helpers
```javascript
- performCoinFlip()      // Random 0 or 1
- formatTokenAmount()    // Format with decimals
- parseTokenAmount()     // Convert to smallest unit
- formatAddress()        // Shorten address display
- isValidNumber()        // Number validation
- validateConfig()       // Check env vars
```

## Data Flow Diagrams

### Flip Creation Flow
```
User clicks /start in group chat
    ↓
Bot asks which token
    ↓
User selects token (callback)
    ↓
Bot sends DM: "How much to wager?"
    ↓
User sends amount in DM
    ↓
Bot generates temporary wallet
    ↓
Bot sends wallet address to user
    ↓
User sends tokens to wallet (manually)
    ↓
User replies "confirmed" in DM
    ↓
Bot verifies deposit on blockchain
    ↓
Display in group: "Flip started, awaiting challenger"
    ↓
Show "Accept Challenge" button
```

### Challenge & Execution Flow
```
Challenger clicks "Accept Challenge"
    ↓
Bot sends DM with deposit instructions
    ↓
Challenger sends tokens
    ↓
Challenger confirms with "confirmed"
    ↓
Bot verifies both deposits
    ↓
Bot performs random coin flip
    ↓
Announce winner in group
    ↓
Show "Claim Winnings" button
```

### Payout Flow
```
Winner clicks "Claim Winnings"
    ↓
Bot sends DM: "Enter wallet address"
    ↓
Winner provides address
    ↓
Bot validates address
    ↓
Bot transfers 2x wager to winner
    ↓
Confirm payout in DM
    ↓
Record transaction in database
    ↓
Mark flip as completed
```

## State Machine

### CoinFlip States
```
WAITING_CHALLENGER
    ↓
    └─→ CANCELLED (timeout or creator cancels)
    
WAITING_CHALLENGER_DEPOSIT (after challenger joins)
    ↓
    └─→ CANCELLED (timeout)
    
WAITING_EXECUTION (both deposits confirmed)
    ↓
    └─→ COMPLETED (flip executed and claimed)
```

### BotSession States
```
INITIATING
    ├─ SELECTING_TOKEN
    └─ AWAITING_DEPOSIT → DEPOSIT_CONFIRMED

CONFIRMING_DEPOSIT
    └─ AWAITING_DEPOSIT → DEPOSIT_CONFIRMED

CLAIMING_WINNINGS
    ├─ GETTING_ADDRESS
    └─ PAYOUT_COMPLETE
```

## Security Architecture

### Private Key Management
```
Raw Private Key
    ↓ [Encrypt with AES-256-CBC]
    ↓
Database Storage (FlipWallet.privateKey)
    ↓ [On Use: Decrypt]
    ↓
Blockchain Transaction
    ↓
Key destroyed from memory
```

### Transaction Flow Security
```
1. Token sent to temporary wallet (user action)
2. Bot verifies balance on blockchain
3. If confirmed, execute flip
4. Announce winner
5. Winner provides address
6. Bot transfers funds from temp wallet
7. Delete/archive temp wallet
```

## API Endpoints

### Telegram Callbacks
- `start_flip_{tokenId}` - Start flip with token
- `accept_flip_{sessionId}` - Accept challenge
- `claim_winnings_{flipId}` - Claim prize
- `cancel_flip_{flipId}` - Cancel flip

### Commands
- `/start` - Welcome and token selection
- `/help` - Help information
- `/stats` - User statistics
- `/admin_stats` - Bot stats (admin only)
- `/admin_health` - Health check (admin only)

## Performance Considerations

### Scalability
- **Current**: Single instance, SQLite
- **Single Instance Limits**: 1000+ users sustainable
- **For Scaling**: 
  - PostgreSQL database
  - Redis for sessions
  - Multiple bot instances
  - Load balancer

### Response Times
| Operation | Target |
|-----------|--------|
| Command response | < 1 second |
| Deposit verification | < 5 seconds |
| Payout execution | < 10 seconds |
| Database query | < 100ms |

### Memory Usage
- Base: ~100MB
- Per active flip: ~5MB
- Per active session: ~1MB

## Error Handling

### Graceful Degradation
1. **RPC Unavailable** → Retry with exponential backoff
2. **Wallet Generate Fails** → Cancel flip, refund user
3. **Deposit Unverified** → Allow user to retry
4. **Payout Fails** → Store failed transaction, allow retry

### Timeout Strategy
- Creator deposit: 3 minutes
- Challenger deposit: 3 minutes  
- Inactivity: Auto-cancel
- Session expiry: 1 hour

## Testing Strategy

### Unit Tests
- Helpers functions
- Blockchain handlers
- Database queries

### Integration Tests
- Flip creation → deposit → execution
- Database transactions
- Blockchain interactions

### E2E Tests
- Full user flow
- Error scenarios
- Timeout handling

## Deployment Architecture

### Development
```
Local machine
├─ Node.js
├─ SQLite database
├─ Environment variables
└─ Bot token
```

### Production
```
VPS / Cloud Instance
├─ Node.js application
├─ SQLite/PostgreSQL
├─ Systemd service (restart handling)
├─ Log rotation
└─ Monitoring
```

### Docker
```
nginx/supervisor
    ↓
Node.js container
    ├─ Application code
    ├─ SQLite volume
    └─ Environment config
```

## Future Architecture Improvements

1. **Multi-instance Support**
   - Redis for session management
   - Load balancer
   - PostgreSQL for shared database

2. **Advanced Features**
   - Tournament system
   - Staking mechanism
   - Multiple game types
   - Referral system

3. **Monitoring**
   - Prometheus metrics
   - Grafana dashboards
   - Error tracking (Sentry)

4. **Scalability**
   - Message queue (RabbitMQ)
   - Caching layer
   - CDN for assets

---

For specific implementation details, see individual file headers and inline comments.
