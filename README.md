\# WhatsApp Trading Signal Listener



Automated trading signal relay from WhatsApp groups to MetaTrader 5 via named pipes.



\## Features



\- 📱 WhatsApp group message monitoring

\- 🤖 AI-powered signal parsing (Google Gemini)

\- 💱 XAUUSD/Gold signal support (BUY/SELL with entry, TP, SL)

\- 📊 Signal tracking \& update detection

\- 🔗 MT5 integration via named pipes

\- 🔄 Automatic reconnection with exponential backoff



\## Setup



\### Prerequisites



\- Node.js 16+

\- Google Gemini API key

\- WhatsApp account (for scanning QR code)

\- MetaTrader 5 with pipe listener



\### Installation



```bash

npm install

```



\### Configuration



1\. \*\*Create `.env`:\*\*

&#x20;  ```

&#x20;  GOOGLE\_AI\_KEY\_RATING=your\_gemini\_api\_key\_here

&#x20;  ```



2\. \*\*Get your WhatsApp group IDs:\*\*

&#x20;  ```bash

&#x20;  node GroupLister.js

&#x20;  ```

&#x20;  Scan the QR code, then copy the group IDs from the output.



3\. \*\*Create `config.json`:\*\*

&#x20;  ```json

&#x20;  {

&#x20;    "whitelistedGroups": \["120363000000000000@g.us"],

&#x20;    "destinations": \[]

&#x20;  }

&#x20;  ```



\## Usage



Start the listener:

```bash

node V3.js

```



Scan the QR code on first run. The bot will:

\- Monitor whitelisted groups for signals

\- Extract BUY/SELL orders with entry/TP/SL

\- Send parsed signals to MT5 via named pipe

\- Track signal updates (within 10 min window)



\## Files



\- `V3.js` - Main listener \& MT5 relay

\- `GroupLister.js` - Utility to list your WhatsApp groups

\- `config.json` - Whitelisted groups \& destinations

\- `data.json` - Signal statistics

\- `signalTimestamps.json` - Signal timing for update detection



\---



\*\*Note:\*\* Keep API keys secure. Don't commit `.env` to version control.

