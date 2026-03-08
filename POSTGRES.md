# PostgreSQL Setup Guide

The bot is now configured to use PostgreSQL instead of SQLite. This guide covers setup for different environments.

## Quick Start with Docker

The easiest way - PostgreSQL is included in docker-compose.yml:

```bash
# Create .env file
cp .env.example .env

# Edit .env with your Telegram bot token and blockchain credentials
nano .env

# Start everything (Postgres + Bot)
docker-compose up -d

# Check logs
docker-compose logs -f coin-flip-bot
```

That's it! PostgreSQL starts automatically and creates the database.

---

## Manual PostgreSQL Setup

### 1. Install PostgreSQL

**On macOS:**
```bash
brew install postgresql
brew services start postgresql
```

**On Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

**On Windows:**
Download from https://www.postgresql.org/download/windows/

### 2. Create Database and User

```bash
# Connect to PostgreSQL
psql -U postgres

# Create user and database
CREATE USER coin_flip_bot WITH PASSWORD 'your_secure_password';
CREATE DATABASE coin_flip_bot OWNER coin_flip_bot;

# Enable extensions (optional)
\c coin_flip_bot
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

# Exit
\q
```

### 3. Configure .env

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=coin_flip_bot
DB_PASSWORD=your_secure_password
DB_NAME=coin_flip_bot
```

### 4. Start Bot

```bash
npm install
npm start
```

---

## Environment Variables

### PostgreSQL Connection
```env
DB_HOST=localhost              # Server hostname
DB_PORT=5432                   # PostgreSQL default port
DB_USER=postgres               # Database user
DB_PASSWORD=your_password      # Database password
DB_NAME=coin_flip_bot          # Database name
```

### Optional
```env
DATABASE_URL=postgresql://user:password@host:port/database
```

---

## Docker Compose Configuration

The docker-compose.yml includes:
- PostgreSQL 15 Alpine (lightweight)
- Persistent volume for data
- Health checks
- Automatic database creation

```bash
# View logs
docker-compose logs postgres

# Connect to database inside container
docker-compose exec postgres psql -U postgres -d coin_flip_bot

# Backup database
docker-compose exec postgres pg_dump -U postgres coin_flip_bot > backup.sql

# Restore database
docker-compose exec -T postgres psql -U postgres coin_flip_bot < backup.sql
```

---

## Production Setup with Systemd

**Install PostgreSQL:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib

sudo systemctl enable postgresql
sudo systemctl start postgresql
```

**Create database:**
```bash
sudo -u postgres createdb coin_flip_bot
sudo -u postgres createuser -P coin_flip_bot
```

**Set permissions:**
```bash
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE coin_flip_bot TO coin_flip_bot;"
```

**Update .env:**
```env
DB_HOST=localhost
DB_USER=coin_flip_bot
DB_PASSWORD=your_secure_password
DB_NAME=coin_flip_bot
```

**Secure PostgreSQL:**
```bash
# Edit /etc/postgresql/15/main/postgresql.conf
sudo nano /etc/postgresql/15/main/postgresql.conf

# Find and set:
# listen_addresses = 'localhost'
# password_encryption = 'scram-sha-256'

# Restart PostgreSQL
sudo systemctl restart postgresql
```

---

## Backup & Restore

### Backup

**Full backup:**
```bash
pg_dump -U coin_flip_bot -h localhost coin_flip_bot > backup_$(date +%Y%m%d).sql
```

**Using Docker:**
```bash
docker-compose exec postgres pg_dump -U postgres coin_flip_bot > backup.sql
```

**Compressed backup:**
```bash
pg_dump -U coin_flip_bot -h localhost coin_flip_bot | gzip > backup.sql.gz
```

### Restore

```bash
psql -U coin_flip_bot -h localhost coin_flip_bot < backup.sql
```

**From compressed:**
```bash
gunzip -c backup.sql.gz | psql -U coin_flip_bot -h localhost coin_flip_bot
```

---

## Automated Backups

**Backup script (backup_db.sh):**
```bash
#!/bin/bash
BACKUP_DIR="/backups/coin-flip-bot"
DB_USER="coin_flip_bot"
DB_HOST="localhost"
DB_NAME="coin_flip_bot"

mkdir -p $BACKUP_DIR

# Full backup
pg_dump -U $DB_USER -h $DB_HOST $DB_NAME | gzip > $BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).sql.gz

# Keep last 30 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete
```

**Cron job (daily at 2 AM):**
```bash
0 2 * * * /home/bot/backup_db.sh
```

---

## Troubleshooting

### Connection refused

**Check if PostgreSQL is running:**
```bash
# Linux
sudo systemctl status postgresql

# macOS
brew services list | grep postgresql

# Docker
docker-compose ps postgres
```

**Check connection:**
```bash
psql -U postgres -h localhost
```

### Database does not exist

```bash
# Create it
createdb -U postgres coin_flip_bot

# Or using psql
psql -U postgres -c "CREATE DATABASE coin_flip_bot;"
```

### Permission denied

Ensure the user has permissions:
```bash
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE coin_flip_bot TO coin_flip_bot;"
```

### Connection pool exhausted

Increase pool size in config.js:
```javascript
pool: {
  max: 10,  // Increase from 5
  min: 0,
  acquire: 30000,
  idle: 10000,
}
```

---

## Performance Tuning

### Connection Pooling
Already configured in bot:
```javascript
pool: {
  max: 5,           // Max connections
  min: 0,           // Min connections
  acquire: 30000,   // Timeout to get connection
  idle: 10000,      // Close idle after 10s
}
```

### PostgreSQL Settings

Edit `/etc/postgresql/15/main/postgresql.conf`:

```ini
# Memory settings
shared_buffers = 256MB          # 25% of RAM
effective_cache_size = 1GB      # 50-75% of RAM

# Connections
max_connections = 100

# Query planning
random_page_cost = 1.1          # For SSD

# Logging
log_duration = off              # Only log slow queries
log_min_duration_statement = 1000  # Log queries > 1s
```

Restart: `sudo systemctl restart postgresql`

---

## Monitoring

### Check database size
```bash
psql -U postgres -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname = 'coin_flip_bot';"
```

### Check table sizes
```bash
psql -U postgres -d coin_flip_bot -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) FROM pg_tables ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"
```

### Check connections
```bash
psql -U postgres -c "SELECT usename, count(*) FROM pg_stat_activity GROUP BY usename;"
```

### Check for locks
```bash
psql -U postgres -d coin_flip_bot -c "SELECT * FROM pg_locks l JOIN pg_stat_activity a ON l.pid = a.pid;"
```

---

## Migration from SQLite

If you had SQLite database before:

```bash
# 1. Export SQLite data
sqlite3 data/bot.db ".dump" > sqlite_dump.sql

# 2. Create PostgreSQL database
createdb -U postgres coin_flip_bot

# 3. Use migration tool (if structure matches)
# Or manually:
psql -U postgres -d coin_flip_bot < sqlite_dump.sql

# 4. Start bot (will sync schemas)
npm start
```

---

## Cloud Deployment

### AWS RDS PostgreSQL

**Create RDS instance:**
```
- Engine: PostgreSQL
- Version: 15
- Instance class: db.t3.micro (free tier)
- Storage: 20 GB
- Backup retention: 7 days
```

**Update .env:**
```env
DB_HOST=your-db-instance.amazonaws.com
DB_USER=postgres
DB_PASSWORD=your_secure_password
DB_NAME=coin_flip_bot
```

### DigitalOcean Managed Database

**Create from dashboard:**
```
Database Type: PostgreSQL
Version: 15
Region: Choose closest
```

**Get connection string from dashboard, update .env:**
```env
DB_HOST=db-postgresql-xxx.ondigitalocean.com
DB_USER=doadmin
DB_PASSWORD=xxx
DB_NAME=coin_flip_bot
```

---

## Security Best Practices

1. **Strong passwords:**
   ```bash
   openssl rand -base64 32
   ```

2. **Restrict network:**
   - PostgreSQL listens only on localhost by default
   - For remote access, use SSH tunneling

3. **Enable SSL:**
   ```bash
   # In postgresql.conf
   ssl = on
   ```

4. **Backup encryption:**
   ```bash
   pg_dump coin_flip_bot | gpg -e > backup.sql.gpg
   ```

5. **Regular updates:**
   ```bash
   sudo apt update && sudo apt upgrade postgresql
   ```

---

## Useful Commands

```bash
# Connect to database
psql -U coin_flip_bot -h localhost -d coin_flip_bot

# List databases
\l

# List tables
\dt

# Describe table
\d table_name

# Count rows
SELECT COUNT(*) FROM users;

# Exit
\q
```

---

**PostgreSQL migrations are handled automatically by Sequelize!** 

Just run the bot and it will create/update all tables automatically on startup.

Happy flipping with PostgreSQL! 🐘
