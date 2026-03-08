FROM node:18

WORKDIR /app

# Install dependencies (Updated: 2026-03-08)
COPY package.json ./
COPY package-lock.json ./
RUN npm install --production

# Copy source code
COPY src ./src

# Create logs directory
RUN mkdir -p logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start bot
CMD ["node", "src/index.js"]

# Labels
LABEL name="coin-flip-bot"
LABEL version="1.0.0"
LABEL description="Telegram Coin Flip Bot for EVM and Solana tokens"
