# WhatsApp/TeleGram Trading Signal Listener

Automated trading signal relay from WhatsApp groups and TeleGram Groups/Channels to MetaTrader 5 via named pipes.

## Features

- 📱 WhatsApp and TeleGram message monitoring
- 🤖 AI-powered signal parsing (Google Gemini)
- 💱 XAUUSD signal support only (BUY/SELL with entry, TP, SL)
- 📊 Signal tracking & update detection
- 🔗 MT5 integration via named pipes
- 🔄 Automatic reconnection with exponential backoff

## Setup

### Prerequisites

- Node.js 16+
- Google Gemini API key
- WhatsApp account or/and TeleGram account (for listening to signals)
- Telegram Bot token
- MetaTrader 5 with pipe listener

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
         "whiteListedGroups": ["120363000000000000@g.us"]
   }
   ```
    You can add WhatsApp or TeleGram IDs here.

## Usage

Start the program:
```bash
npm start
```

Scan the QR code on first run. The bot will:
- Monitor whitelisted IDs for signals
- Extract XAUUSD BUY/SELL orders with entry/TP/SL
- Send parsed signals to MT5 via named pipe
- Track signal updates (within 10 min window)

## Files

- `main.js` - CLI launcher & menu
- `WhatsApp/WhatsappBot.js` - Main WhatsApp listener & MT5 relay
- `WhatsApp/GroupLister.js` - Utility to list your WhatsApp groups
- `Telegram/TelegramBot.js` - Main Telegram listener & bot relay
- `Telegram/ListGroupsChannels.js` - Utility to list your Telegram groups and channels
- `config.json` - Whitelisted IDs
- `data.json` - Signal statistics
- `positions.json` - Open positions for update detection

---