# Kalshi Trading Bot v2

A Kelly-sized, approval-gated Kalshi crypto + weather bot with Telegram control.

## Quick Start

### Installation
```bash
npm install
```

### Configuration
Edit `.env` with your:
- `KALSHI_API_KEY` - Your Kalshi API key
- `TELEGRAM_TOKEN` - Your Telegram bot token
- `YOUR_TELEGRAM_ID` - Your Telegram user ID
- `KALSHI_KEY_PATH` - Path to your Kalshi private key
- Risk parameters (BANKROLL, MAX_TRADE_SIZE, etc.)

### Run
```bash
npm start
```

## Features
- Automated trading with Kelly criterion sizing
- Telegram command approval gate
- Crypto market analysis with technical indicators
- Commodity trading support
- Risk management (daily loss limits, drawdown protection)
- Auto profit-locking on winning positions

## Files
- `index.js` - Main bot engine
- `.env` - Configuration (create from template)
- `package.json` - Dependencies
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...' >> ~/.env