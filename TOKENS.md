# Common Token Addresses for Testing

## EVM Tokens (Ethereum Mainnet)

### Stablecoins
- **USDC**: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6 decimals)
- **USDT**: `0xdac17f958d2ee523a2206206994597c13d831ec7` (6 decimals)
- **DAI**: `0x6B175474E89094C44Da98b954EedeAC495271d0F` (18 decimals)

### Other Popular Tokens
- **LINK**: `0x514910771AF9CA656af840dff83E8264EcF986CA` (18 decimals)
- **UNI**: `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` (18 decimals)
- **WETH**: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (18 decimals)

## Solana Tokens

### Stablecoins
- **USDC**: `EPjFWdd5Au4UsJx2QH91uNjjnNp6sKc8YYHCCKjvn7fU` (6 decimals)
- **USDT**: `Es9vMFrzaCERmJfrieF1QYwiaYQafwnA3cJ5sobZY7g` (6 decimals)

### Popular Tokens
- **SOL** (wrapped): `So11111111111111111111111111111111111111112` (9 decimals)
- **COPE**: `8HGyAAB1yoM1ttS7pnqw68sNnZWQCAXhjwNb3qwwaH6` (6 decimals)

## Test Networks (Testnet)

### EVM Sepolia (Ethereum Testnet)
```env
EVM_RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY
EVM_NETWORK_ID=11155111
```

Faucets:
- https://sepoliafaucet.com
- https://www.alchemy.com/faucets/ethereum-sepolia

### Solana Devnet
```env
SOLANA_RPC_URL=https://api.devnet.solana.com
```

Faucet:
```bash
solana airdrop 2 <YOUR_WALLET_ADDRESS> --url devnet
```

## Configuration Examples

### Ethereum Mainnet (Production)
```env
TELEGRAM_BOT_TOKEN=your_bot_token
EVM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
EVM_PRIVATE_KEY=0x...
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=[...]
NETWORK=mainnet
SUPPORTED_TOKENS=EVM:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC,EVM:0xdac17f958d2ee523a2206206994597c13d831ec7:6:USDT,SOLANA:EPjFWdd5Au4UsJx2QH91uNjjnNp6sKc8YYHCCKjvn7fU:6:USDC
```

### Test Networks (Development)
```env
TELEGRAM_BOT_TOKEN=your_bot_token
EVM_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
EVM_PRIVATE_KEY=0x...
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY=[...]
NETWORK=testnet
SUPPORTED_TOKENS=EVM:0x...testnet_token:6:TEST_USDC,SOLANA:EPjFWdd5Au4UsJx2QH91uNjjnNp6sKc8YYHCCKjvn7fU:6:DEVNET_USDC
```

## Adding New Tokens

1. Find token contract address on block explorer
2. Verify decimals (usually 18 for EVM, 6 for Solana)
3. Add to SUPPORTED_TOKENS in .env:
   ```env
   SUPPORTED_TOKENS=...existing...,EVM:0xNewAddress:18:NewSymbol
   ```
4. Restart bot
5. New token will appear in `/start` menu

## Popular Block Explorers

- **Ethereum**: https://etherscan.io
- **BSC**: https://bscscan.com
- **Polygon**: https://polygonscan.com
- **Avalanche**: https://snowscan.xyz
- **Solana**: https://solscan.io

## Decimal Look-up

```javascript
// On Etherscan, check the token contract
// "Decimals" field shows the decimal places

// For Solana tokens:
// Visit solscan.io and view token info
// "Decimals" shown in token details
```
