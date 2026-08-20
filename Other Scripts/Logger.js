const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions/index.js');
const { NewMessage } = require('telegram/events/index.js');

const CONFIG_FILE = 'config.json';

dotenv.config();

let config = {};
let loggerClient = null;
let isStarted = false;

const defaultConfig = {
    "whiteListedGroups": {
        "Whatsapp": [],
        "Telegram": []
    },
    "LogDestinations": [],
    "LogSignalsToGroup": false,
    "DebugLogs": false
};


// ═══════════════════════════════════════════════════════════════════════════════
// LOG FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

async function sendSignalLog(payload, source) {
    if (!loggerClient || !loggerClient.connected) {
        console.error(`[${getTimestamp()}][ERROR] Logger bot not connected`);
        return;
    }

    const action = payload.action;
    const actionMap = {
        'OpenPosition': 'OPEN POSITION',
        'UpdatePosition': 'UPDATE POSITION',
        'ModifyPending': 'MODIFY LIMIT',
        'ClosePosition': 'CLOSE POSITION',
        'PositionClosed': 'CLOSED POSITION',
        'CancelPending': 'CANCEL LIMIT',
        'PendingOrderRemoved': 'CANCELED LIMIT'
    };

    const mappedAction = actionMap[action] || action.toUpperCase();
    const timeStr = getTimestampInHoursOnly();
    let formattedText = '';
    if (!payload.type?.toUpperCase().includes("LIMIT"))
        formattedText = `**${mappedAction}**\n→ ${source}`;
    else
        formattedText = `**${mappedAction} LIMIT**\n→ ${source}`;

    if (!['PendingOrderRemoved','CancelPending','PositionClosed','ClosePosition'].some(word => action.includes(word))) {
        const entry = payload.bid ? payload.bid : payload.price;
        const tp = payload.tp;
        const sl = payload.sl;
        formattedText += `\nentry: ${entry}\nTP: ${tp}\nSL: ${sl}`;
    }
    formattedText += `\n@ ${timeStr}`;

    for (const destId of config.LogDestinations) {
        try {
            let entity;
            try {
                entity = await loggerClient.getInputEntity(destId);
            } catch (e) {
                const str = String(destId);
                if (str.startsWith('-100')) {
                    const channelId = BigInt(str.slice(4));
                    entity = await loggerClient.getInputEntity(channelId);
                } else if (str.startsWith('-')) {
                    const chatId = BigInt(str);
                    entity = await loggerClient.getInputEntity(chatId);
                } else {
                    console.error(`[${getTimestamp()}][ERROR] Invalid destId format: ${destId}`);
                    continue;
                }
            }

            await loggerClient.sendMessage(entity, { message: formattedText });
            console.log(`[${getTimestamp()}][LOG] Message sent to ${destId}`);
        } catch (err) {
            console.error(`[${getTimestamp()}][ERROR] Failed to send to ${destId}:`, err.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

async function connectTelegramBot() {
    const apiId = parseInt(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    const botToken = process.env.BOT_TOKEN;

    if (!botToken) {
        console.error(`[${getTimestamp()}][ERROR] BOT_TOKEN not set in .env!`);
        return;
    }
    if (!apiId) {
        console.error(`[${getTimestamp()}][ERROR] API_ID not set in .env!`);
        return;
    }
    if (!apiHash) {
        console.error(`[${getTimestamp()}][ERROR] API_HASH not set in .env!`);
        return;
    }

    loggerClient = new TelegramClient(new StringSession(''), apiId, apiHash, {
        connectionRetries: 5,
        useWSS: true,
        useIPv6: false,
    });
    loggerClient.setLogLevel('none');

    try {
        await loggerClient.start({ botAuthToken: botToken });
        console.log(`[${getTimestamp()}][SYSTEM] Logger bot connected!`);
    } catch (err) {
        console.error(`[${getTimestamp()}][ERROR] Bot connection failed:`, err.message);
        setTimeout(connectTelegramBot, 10000);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function ensureConfigExists() {
    try {
        fs.accessSync(CONFIG_FILE, fs.constants.F_OK);
    } catch {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
        console.log(`[${getTimestamp()}][CONFIG] Created default ${CONFIG_FILE}`);
    }
}

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8") || "{}");
    } catch (err) {
        console.error(`[${getTimestamp()}][ERROR] Error loading config:`, err.message);
        return defaultConfig;
    }
}

function getTimestamp(date = new Date()) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const hh = String(hours).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${minutes} ${ampm}`;
}

function getTimestampInHoursOnly(date = new Date()) {
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const subscripts = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
    const seconds = String(date.getSeconds())
        .padStart(2, '0')
        .replace(/\d/g, d => subscripts[d]);

    return `${hours}:${minutes}:${seconds}`;
}

function cleanup() {
    console.log(`\n[${getTimestamp()}][SYSTEM] Shutting down gracefully...`);
    if (loggerClient) loggerClient.disconnect();
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function startLogger() {
    if (isStarted) return;
    isStarted = true;

    console.log(`[${getTimestamp()}][SYSTEM] Starting Telegram Logger...\n`);
    await connectTelegramBot();

    ensureConfigExists();
    config = loadConfig();
    console.log(`[${getTimestamp()}][INFO] LogDestinations: ${config.LogDestinations.length}`);

}

module.exports = { sendSignalLog, startLogger };