const { TelegramClient, utils } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { GoogleGenAI } = require("@google/genai");
const dotenv = require("dotenv");
const fs = require("fs");
const Logic = require('../Logic.js');

dotenv.config(); // Load .env variables

// ----------- Telegram Setup -----------

const apiIdSelfBot = parseInt(process.env.API_ID);
const apiHashSelfBot = process.env.API_HASH;
const stringSessionSelfBot = new StringSession(process.env.STRING_SESSION);
const CONFIG_FILE = "./config.json"; // config file location

const selfClient = new TelegramClient(stringSessionSelfBot, apiIdSelfBot, apiHashSelfBot, {
    connectionRetries: 5,
    useWSS: true,      // wont work without it on my network
    useIPv6: false,    // Optional but safe to keep
});
selfClient.setLogLevel('none');
// ----------- Telegram Bot Logic -----------

(async () => {
    ensureConfigExists();

    await selfClient.start();
    const self = await selfClient.getMe();
    console.log(`[${getCurrentTime()}][INFO] Listener connected to Telegram with @${self.username}!`);
    //Selfbot

    const sourceHandler = async (event) => {
        const config = readJSON(CONFIG_FILE);
        const whiteListedGroupsSources = config.whiteListedGroups.Telegram || [];
        const msg = event.message;

        //get the id of the signal source
        let sourceId = null;
        if (msg.chatId != null) {
            sourceId = msg.chatId.toString();
        }

        if (!whiteListedGroupsSources.includes(sourceId)) return;
        let text = msg.text || '';
        if (!text) return;
        const ignoreWordFound = [].some(word => text.toLowerCase().includes(word));
        if (ignoreWordFound) return; // auto ignore signal with certain words. NOW ITS EMPTY
        const foundWords = ["buy", "sell", "close", "tp", "sl", "breakeven", "exit"].some(word => text.toLowerCase().includes(word));
        if (!foundWords) return; // skip if message doesnt contain trigger word
        const chat = msg.chat || await selfClient.getEntity(msg.chatId);
        const chatTitle = chat?.title || chat?.username || '';
        const title = " from " + chatTitle;

        console.log(`[${getCurrentTime()}][INFO] Received signal${title}.`);

        // send over to logic.js here
        const messageId = msg.id.toString();
        try {
            await Logic.AnalyzeMessage(text, sourceId, messageId, chatTitle);
        } catch (err) {
            console.error(`[${getCurrentTime()}][ERROR] Message analysis failed:`, err.message);
        }
    };

    const config = readJSON(CONFIG_FILE);
    const whiteListedGroupsSources = config.whiteListedGroups.Telegram || [];
    const processedIds = new Set();

    console.log(`[${getCurrentTime()}][INFO] Preparing to listen to Channels...`);
    for (const chatId of whiteListedGroupsSources) {
        try {
            const messages = await selfClient.getMessages(chatId, { limit: 2 });
            for (const msg of messages) {
                processedIds.add(`${chatId}:${msg.id}`);
            }
        } catch (err) {
            console.error(`[${getCurrentTime()}][ERROR] Preparing failed for ${chatId}:`, err.message);
        }
    }
    console.log(`[${getCurrentTime()}][INFO] Listening for signals.`);

    // Now start the actual polling
    setInterval(async () => {
        for (const chatId of whiteListedGroupsSources) {
            try {
                const messages = await selfClient.getMessages(chatId, { limit: 2 });
                for (const msg of messages) {
                    const key = `${chatId}:${msg.id}`;
                    if (processedIds.has(key)) continue;
                    processedIds.add(key);

                    if (processedIds.size > 200) {
                        const iterator = processedIds.values();
                        processedIds.delete(iterator.next().value);
                    } // hard cap for processedIds.

                    await sourceHandler({ message: msg });
                }
            } catch (err) {
                console.error(`[${getCurrentTime()}][ERROR] Fetch message failed for ${chatId}:`, err.message);
            }
        }
    }, 8000); // polling for channels
})();


// ------------------------
// Functions
// ------------------------

function ensureConfigExists() {
    const defaultConfig = {
        whiteListedGroups: { Whatsapp: [], Telegram: [] }
    };
    try {
        fs.accessSync(CONFIG_FILE, fs.constants.F_OK);
    } catch {
        writeJSON(CONFIG_FILE, defaultConfig);
        console.log(`[${getCurrentTime()}][INFO] Created default config.json`);
    }
}

function readJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
    } catch {
        return {};
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function getCurrentTime(date = new Date()) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const hh = String(hours).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${minutes} ${ampm}`;
}