# Deployment Guide

## Production Deployment

### Option 1: Docker (Recommended)

**Build image:**
```bash
docker build -t coin-flip-bot:latest .
```

**Run container:**
```bash
docker run -d \
  --name coin-flip-bot \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  -p 3000:3000 \
  coin-flip-bot:latest
```

**Using docker-compose:**
```bash
docker-compose up -d
```

**View logs:**
```bash
docker logs -f coin-flip-bot
```

**Stop container:**
```bash
docker stop coin-flip-bot
docker rm coin-flip-bot
```

### Option 2: Systemd Service

**Create service file:** `/etc/systemd/system/coin-flip-bot.service`

```ini
[Unit]
Description=Telegram Coin Flip Bot
After=network.target

[Service]
Type=simple
User=bot
Group=bot
WorkingDirectory=/opt/coin-flip-bot
ExecStart=/usr/bin/node /opt/coin-flip-bot/src/index.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/coin-flip-bot/stdout.log
StandardError=append:/var/log/coin-flip-bot/stderr.log

Environment="NODE_ENV=production"
EnvironmentFile=/opt/coin-flip-bot/.env

[Install]
WantedBy=multi-user.target
```

**Setup:**
```bash
# Create user
sudo useradd -m -s /bin/bash bot

#Copy application
sudo cp -r coin-flip-bot /opt/

# Fix permissions
sudo chown -R bot:bot /opt/coin-flip-bot

# Create log directory
sudo mkdir -p /var/log/coin-flip-bot
sudo chown bot:bot /var/log/coin-flip-bot

# Enable service
sudo systemctl enable coin-flip-bot

# Start service
sudo systemctl start coin-flip-bot

# Check status
sudo systemctl status coin-flip-bot

# View logs
sudo journalctl -u coin-flip-bot -f
```

### Option 3: PM2 Process Manager

**Install PM2:**
```bash
npm install -g pm2
```

**Create ecosystem file:** `ecosystem.config.js`
```javascript
module.exports = {
  apps: [{
    name: 'coin-flip-bot',
    script: './src/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time_format: 'YYYY-MM-DD HH:mm:ss Z',
    restart_delay: 5000,
    max_memory_restart: '1G'
  }]
};
```

**Manage:**
```bash
# Start
pm2 start ecosystem.config.js

# Monitor
pm2 monit

# Logs
pm2 logs coin-flip-bot

# Restart
pm2 restart coin-flip-bot

# Stop
pm2 stop coin-flip-bot

# Start on boot
pm2 startup
pm2 save
```

## Cloud Deployment

### AWS EC2

1. **Launch instance:**
   - Ubuntu 22.04 LTS
   - t3.small (minimum)
   - Security group: allow SSH (22), HTTPS (443)

2. **Install dependencies:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm sqlite3

# Or use Node Version Manager
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
```

3. **Deploy:**
```bash
cd /home/ubuntu
git clone <repo-url>
cd coin-flip-bot
npm install
cp .env.example .env
# Edit .env with your config
npm start &
```

### DigitalOcean App Platform

1. **Connect GitHub repo**
2. **Set environment variables** in dashboard
3. **Deploy** - automatically deploys on push

### Heroku

**Procfile:**
```
worker: npm start
```

**Deploy:**
```bash
heroku login
heroku create coin-flip-bot
heroku config:set TELEGRAM_BOT_TOKEN=<token>
heroku config:set EVM_RPC_URL=<url>
# ... set all env vars
git push heroku main
```

## Monitoring & Maintenance

### Health Check

```javascript
// Add to src/index.js health endpoint
bot.on('email', ctx => {
  if (ctx.message.text === '/health') {
    ctx.reply('✅ Healthy');
  }
});
```

### Database Backups

**Automated backup script:**
```bash
#!/bin/bash
# backup_db.sh
BACKUP_DIR="/backups/coin-flip-bot"
mkdir -p $BACKUP_DIR
cp /opt/coin-flip-bot/data/bot.db $BACKUP_DIR/bot_$(date +%Y%m%d_%H%M%S).db
# Keep last 7 days
find $BACKUP_DIR -name "*.db" -mtime +7 -delete
```

**Cron job:**
```bash
0 2 * * * /home/bot/backup_db.sh  # Daily at 2 AM
```

### Monitoring

**Uptime monitoring:**
- Use uptimerobot.com
- Ping `/health` endpoint every 5 minutes

**Error tracking:**
- Add Sentry integration for error logging
- Monitor database size
- Track wallet balances

**Log rotation:**
```bash
# Install logrotate
$ apt install logrotate

# Create /etc/logrotate.d/coin-flip-bot
/var/log/coin-flip-bot/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

## Scaling Considerations

### Single Instance
- Current setup supports 1 bot instance
- Suitable for groups < 1000 users
- Database: SQLite

### Multiple Instances
- Would need Redis for session management
- PostgreSQL for database
- Load balancer (nginx)
- Separate wallet per instance

### Network Optimization
- Cache RPC responses
- Use batch calls for multiple token checks
- Implement rate limiting

## Security in Production

### Environment
```bash
# Never commit .env
echo ".env" >> .gitignore

# Use strong passwords
TELEGRAM_BOT_TOKEN=<random>
EVM_PRIVATE_KEY=0x<secure-random>
SOLANA_PRIVATE_KEY=[<secure-random>]
```

### Wallet Security
- Use hardware wallet for hot wallet
- Minimize funds in bot wallet
- Monitor transactions frequently
- Rotate keys periodically

### API Security
- Rate limit RPC calls
- Use proxy RPC if available
- Monitor for suspicious transactions

### Access Control
```bash
# Restrict file permissions
chmod 600 .env
chmod 700 data/
chown bot:bot -R /opt/coin-flip-bot
```

## Troubleshooting Deployment

### Bot not starting
```bash
# Check logs
journalctl -u coin-flip-bot -n 100

# Check Node version
node --version

# Test manually
cd /opt/coin-flip-bot
npm start
```

### Database locked
```bash
# Check if another instance running
ps aux | grep node

# Restart service
sudo systemctl restart coin-flip-bot
```

### Out of memory
```bash
# Check memory usage
free -h

# Increase swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## Rollback Procedure

```bash
# Keep previous version
cp -r coin-flip-bot coin-flip-bot.old
git clone <repo> coin-flip-bot.new

# If error, rollback
rm -rf coin-flip-bot
mv coin-flip-bot.old coin-flip-bot
systemctl restart coin-flip-bot
```

## Performance Tuning

### Node.js
```bash
# Increase max file descriptors
ulimit -n 65536

# Enable clustering (future enhancement)
NODE_CLUSTER_SCHED_POLICY=rr
```

### Database
```bash
# Optimize SQLite
PRAGMA cache_size=10000;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
```

## Cost Estimation

**Typical monthly costs:**
- VPS: $5-20/month
- RPC calls: Free-$100/month (depends on usage)
- Domain: $1-3/month
- Total: $6-123/month

---

For production support, monitor these metrics:
- Bot response time (< 1s target)
- Payment confirmation time (< 10s target)
- Error rates (< 1% target)
- Wallet balance (maintain threshold)
