#!/bin/bash

# Coin Flip Bot - Setup Script
# This script helps configure the bot for the first time

set -e

echo "🚀 Coin Flip Bot Setup"
echo "======================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not installed. Please install Node.js 16+"
    exit 1
fi

echo "✅ Node.js $(node --version) detected"
echo ""

# Create directories
echo "📁 Creating directories..."
mkdir -p logs
echo "✅ Directories created"
echo ""

# Check if .env exists
if [ -f .env ]; then
    echo "⚠️  .env file already exists"
    read -p "Do you want to overwrite it? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing .env file"
        echo ""
    else
        cp .env.example .env
    fi
else
    echo "📝 Creating .env from template..."
    cp .env.example .env
    echo "✅ .env created"
fi

echo ""
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed"
echo ""

# Get Telegram token
echo "🤖 Telegram Bot Setup"
echo "---------------------"
echo "1. Go to https://t.me/BotFather"
echo "2. Send /newbot"
echo "3. Follow instructions to create a bot"
echo ""
read -p "Enter your bot token: " BOT_TOKEN
sed -i "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$BOT_TOKEN/" .env
echo "✅ Bot token configured"
echo ""

# Get RPC URLs
echo "🔗 RPC Configuration"
echo "-------------------"
echo "EVM RPC (get free one from https://www.alchemy.com/)"
read -p "Enter EVM RPC URL: " EVM_RPC
sed -i "s|EVM_RPC_URL=.*|EVM_RPC_URL=$EVM_RPC|" .env
echo "✅ EVM RPC configured"
echo ""

echo "Solana RPC (leave blank for public endpoint)"
read -p "Enter Solana RPC URL (optional): " SOLANA_RPC
if [ -z "$SOLANA_RPC" ]; then
    SOLANA_RPC="https://api.mainnet-beta.solana.com"
fi
sed -i "s|SOLANA_RPC_URL=.*|SOLANA_RPC_URL=$SOLANA_RPC|" .env
echo "✅ Solana RPC configured"
echo ""

# Get private keys
echo "🔑 Wallet Setup"
echo "---------------"
echo "1. EVM Wallet - Can be any Ethereum wallet"
echo "   Get one from MetaMask, create random with ethers.js, etc."
echo "2. Solana Wallet - SPL token wallet address"
echo ""
read -p "Enter EVM Private Key (0x...): " EVM_KEY
sed -i "s/EVM_PRIVATE_KEY=.*/EVM_PRIVATE_KEY=$EVM_KEY/" .env
echo "✅ EVM wallet configured"
echo ""

# Get Solana private key strategy
echo "For Solana, enter your keypair as JSON array, or leave blank to generate one"
read -p "Enter Solana Private Key ([1,2,3,...]): " SOLANA_KEY
if [ ! -z "$SOLANA_KEY" ]; then
    sed -i "s/SOLANA_PRIVATE_KEY=.*/SOLANA_PRIVATE_KEY=$SOLANA_KEY/" .env
    echo "✅ Solana wallet configured"
else
    echo "⚠️  Using default Solana wallet. Update later or generate one:"
    echo "   solana-keygen new"
fi
echo ""

# Network selection
echo "🌐 Network Selection"
echo "-------------------"
read -p "Use mainnet or testnet? (mainnet/testnet) [testnet]: " NETWORK
NETWORK=${NETWORK:-testnet}
sed -i "s/NETWORK=.*/NETWORK=$NETWORK/" .env
echo "✅ Network set to: $NETWORK"
echo ""

# Token configuration
echo "💰 Token Configuration"
echo "---------------------"
echo "Add tokens to SUPPORTED_TOKENS in .env"
echo "Format: NETWORK:ADDRESS:DECIMALS:SYMBOL,..."
echo ""
echo "Example:"
echo "EVM:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC,SOLANA:EPjFWdd5Au4...:6:USDC"
echo ""

# Show final config
echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Configuration Summary"
echo "------------------------"
echo "Edit .env to verify:"
echo ""
grep -E "TELEGRAM_BOT_TOKEN|EVM_RPC|NETWORK|SUPPORTED_TOKENS" .env | head -5
echo ""

# Offer to test
echo "🧪 Ready to test?"
read -p "Do you want to start the bot now? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Starting bot..."
    npm start
else
    echo ""
    echo "To start the bot later, run:"
    echo "  npm start"
    echo ""
    echo "For development with auto-reload:"
    echo "  npm run dev"
    echo ""
    echo "Happy flipping! 🪙"
fi
