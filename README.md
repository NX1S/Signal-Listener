# WhatsApp/TeleGram Trading Signal Listener

Automated trading signal relay from WhatsApp groups and TeleGram Groups/Channels to MetaTrader 5 via named pipes.

## Features

- 📱 WhatsApp and TeleGram message monitoring
- 🤖 AI-powered signal parsing (Google Gemini) with backup AI.
- 💱 XAUUSD signal support only (BUY/SELL with entry, TP, SL)
- 📊 Signal tracking, update & close detection
- 🔗 MT5 integration via named pipes
- 🔄 Automatic reconnection with exponential backoff

## Setup

### Prerequisites

- Node.js 16+
- 2 Google Gemini API keys
- Trading account with AlgoTrading enabled
- WhatsApp account or/and TeleGram account
- MetaTrader 5

### Installation

```bash
npm install
```

### Configuration

1. **Create `.env`:**
   ```
   GOOGLE_AI_KEY_RATING=your_gemini_api_key_here
   ```

2. **Get your WhatsApp group IDs:**
   ```bash
   node WhatsApp/GroupLister.js
   ```
   Scan the QR code, then copy the group IDs from the output.

3. **Create `config.json`:**
   ```json
   {
   "whiteListedGroups" : {
      "Whatsapp":["123456789@g.us", "0000000000@g.us"],
      "Telegram":["-1234567891","-1001234567891"]
   }
   }
   ```
    You can add WhatsApp and TeleGram IDs here.

## Usage

Start the listener:
```bash
npm start
```

Once logged in with your monitoring account. The bot will:
- Monitor whitelisted IDs for signals
- Extract XAUUSD BUY/SELL orders with entry/TP/SL
- Send over the signal to MT5
- Keep monitoring for signal updates

## Files

- `main.js` - CLI launcher & menu
- `Logic.js` - Main script for handling incoming messages
- `WhatsApp/WhatsappListener.js` - WhatsApp listener
- `WhatsApp/WhatsappGroupLister.js` - Utility to list your WhatsApp groups
- `Telegram/TelegramListener.js` - Telegram listener
- `Telegram/TelegramGroupLister.js` - Utility to list your Telegram groups and channels
- `config.json` - Whitelisted IDs
- `positions.json` - Open positions for update detection

---