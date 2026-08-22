const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const Logic = require('../Logic.js');

let sock = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3000; // 3 seconds base
const MAX_RECONNECT_DELAY_MS = 60000; // 60 seconds cap
const CONFIG_FILE = "./config.json"; // config file location

// ─── MAIN ENTRY ───
(async () => {
    ensureConfigExists();

    console.log('🚀 Listener started. Waiting for QR code...');
    await connectWhatsApp();
})();


// ─── MESSAGE HANDLER ───
function attachMessageHandler(socket) {
    const config = readJSON(CONFIG_FILE);
    const whiteListedGroupsSources = config.whiteListedGroups.Whatsapp || [];

    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {

            const sourceId = msg.key.remoteJid;
            const messageId = msg.key.id;
            if (!whiteListedGroupsSources.includes(sourceId)) continue;

            let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!text) continue;
            const foundWords = ["buy", "sell", "close", "tp", "sl", "breakeven", "exit"].some(word => text.toLowerCase().includes(word));
            if (!foundWords) continue; // words to search for

            const title = " from " + sourceId;

            console.log(`[${getCurrentTime()}][INFO] Received signal${title}.`);

            // send over to logic.js here
            try {
                await Logic.AnalyzeMessage(text, sourceId, messageId, sourceId);
            } catch (err) {
                console.error(`[${getCurrentTime()}][ERROR] Message analysis failed:`, err.message);
            } // replaced sourceName with sourceId.
        }
    });
}

// ─── CONFIG HELPER ───
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

// ─── CREDENTIAL CLEANUP HELPER ───
function deleteAuthFolder() {
    const authPath = path.resolve('auth_info_baileys');
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log(`[${getCurrentTime()}][INFO] Deleted auth_info_baileys folder`);
            return true;
        }
        return false;
    } catch (err) {
        console.error(`[${getCurrentTime()}][ERROR] Failed to delete auth_info_baileys:`, err.message);
        return false;
    }
}

// ─── RECONNECTION LOGIC ───
function getBackoffDelay(attempt) {
    // Exponential backoff: 3s, 6s, 12s, 24s, 48s, 60s (capped)
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
    return delay;
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

async function connectWhatsApp() {
    // Prevent multiple simultaneous connection attempts
    clearReconnectTimer();

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 Scan this QR code with WhatsApp → Settings → Linked Devices:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                reconnectAttempts = 0;
                const phone = sock.user?.id?.split('@')[0] || 'Unknown';
                const name = sock.user?.name || 'Unknown';
                console.log(`[${getCurrentTime()}][INFO] Listener connected to WhatsApp using ${phone} || ${name}`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (!shouldReconnect) {
                    console.log(`[${getCurrentTime()}][FATAL] Logged out. Clearing credentials...`);

                    // Delete auth folder to force fresh QR on next startup
                    deleteAuthFolder();

                    console.log(`[${getCurrentTime()}][INFO] Stopped reconnecting. Restart the app to scan QR again.`);

                    // Stop reconnection attempts permanently
                    reconnectAttempts = MAX_RECONNECT_ATTEMPTS + 1;
                    return;
                }

                // Log the disconnect reason
                const reason = lastDisconnect?.error?.message || 'Unknown reason';
                console.log(`[${getCurrentTime()}][WARN] WhatsApp disconnected: ${reason}`);

                // Schedule reconnection with backoff
                scheduleReconnect();
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Attach message handler
        attachMessageHandler(sock);

    } catch (err) {
        console.error(`[${getCurrentTime()}][ERROR] Failed to create WhatsApp socket:`, err.message);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    clearReconnectTimer();

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[${getCurrentTime()}][FATAL] Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
        return;
    }

    const delay = getBackoffDelay(reconnectAttempts);
    reconnectAttempts++;

    console.log(`[${getCurrentTime()}][INFO] Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    reconnectTimer = setTimeout(async () => {
        console.log(`[${getCurrentTime()}][INFO] Attempting reconnection...`);
        await connectWhatsApp();
    }, delay);
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