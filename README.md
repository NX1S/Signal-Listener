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
   GOOGLE_AI_KEY="AI KEY HERE"
   GOOGLE_AI_KEY_BACKUP="BACKUP AI KEY HERE"
   ```

2. **Get your WhatsApp/Telegram source IDs:**

   - Check Usage section how to run the code
   - Choose which platform
   - Select list sources
   - Navigate over to prefered source

3. **Add source ID to WhiteList:**

   - Run the code
   - Choose option 3
   - Select the add option
   - Paste the ID

4. **Manually edit `config.json`:**
   ```json
   {
      "whiteListedGroups" : {
         "Whatsapp":["123456789@g.us", "0000000000@g.us"],
         "Telegram":["-1234567891","-1001234567891"]
      }
   }
   ```
    You can add and remove WhatsApp and TeleGram IDs manually here.

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