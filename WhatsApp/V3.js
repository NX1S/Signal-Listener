const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const net = require('net');
const path = require('path');

dotenv.config();

const pipeName = '\\\\.\\pipe\\MT5Signal';
let pipeServer;
let pipeSocket;

// ─── RECONNECTION STATE ───
let sock = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3000; // 3 seconds base
const MAX_RECONNECT_DELAY_MS = 60000; // 60 seconds cap

const signalSummaryPrompt = `You are a trading signal formatter. Extract the following from the message and return ONLY a JSON object:

{
  "valid": true,
  "positionType": "BUY" or "SELL",
  "entry": number or null,
  "tp": number or null,
  "sl": number or null
}

Rules:
- If the message is not a trading signal, return {"valid": false}
- positionType must be uppercase "BUY" or "SELL"
- Use null for missing prices, never 0 or empty string
- If price range given, use lowest for BUY, highest for SELL
- If multiple TPs are present, choose the lowest one on buy, and biggest one on sell.
- Return ONLY the JSON object, no markdown, no explanations

Message to analyze:
`;

const geminiAIRating = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY_RATING });

async function AiSummary(prompt) {
    const response = await geminiAIRating.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
        temperature: 0,
    });

    const textContent = response.text || "";
    return textContent || "No output";
}

function createPipeServer() {
    try {
        require('fs').unlinkSync(pipeName);
    } catch (e) { /* ignore if doesn't exist */ }

    pipeServer = net.createServer((socket) => {
        console.log(`[${getCurrentTime()}][INFO] MT5 connected to pipe`);
        pipeSocket = socket;

        socket.on('end', () => {
            console.log(`[${getCurrentTime()}][WARN] MT5 disconnected`);
            pipeSocket = null;
        });

        socket.on('error', (err) => {
            console.error(`[${getCurrentTime()}][ERROR] Socket error:`, err.message);
            pipeSocket = null;
        });

        socket.on('close', () => {
            console.log(`[${getCurrentTime()}][INFO] Socket closed`);
            pipeSocket = null;
        });
    });

    pipeServer.listen(pipeName, () => {
        console.log(`[${getCurrentTime()}][INFO] Pipe server listening on ${pipeName}`);
    });

    pipeServer.on('error', (err) => {
        console.error(`[${getCurrentTime()}][ERROR] Pipe server error:`, err.message);
        setTimeout(createPipeServer, 5000);
    });
}

// ─── CONFIG HELPER ───
function ensureConfigExists() {
    const defaultConfig = {
        whitelistedGroups: [],
        destinations: []
    };

    try {
        fs.accessSync("config.json", fs.constants.F_OK);
    } catch {
        fs.writeFileSync("config.json", JSON.stringify(defaultConfig, null, 2), "utf8");
        console.log(`[${getCurrentTime()}][INFO] Created default config.json`);
    }
}

// ─── DATA.JSON HELPER ───
function ensureDataExists() {
    try {
        fs.accessSync("data.json", fs.constants.F_OK);
    } catch {
        fs.writeFileSync("data.json", "{}", "utf8");
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
                // Reset retry counter on successful connection
                reconnectAttempts = 0;
                console.log(`[${getCurrentTime()}][INFO] Listener connected to WhatsApp!`);
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

// ─── MESSAGE HANDLER ───
function attachMessageHandler(socket) {
    // Load whitelisted groups from config.json
    const fileConfig = fs.readFileSync("config.json", "utf8");
    const obj = JSON.parse(fileConfig);
    if (!obj.whitelistedGroups) obj.whitelistedGroups = [];
    const whitelistedGroups = obj.whitelistedGroups;

    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            const jid = msg.key.remoteJid;
            const sourceId = jid;
            let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (!text) continue;

            // ─── WHITELIST CHECK ───
            const isWhitelisted = whitelistedGroups.includes(sourceId);
            if (!isWhitelisted) {
                continue;
            }

            // ─── TRIGGER WORD CHECK ───
            const found = ["buy", "sell", "gold", "xauusd"].some(word => text.toLowerCase().includes(word));
            if (!found) continue;

            console.log(`[${getCurrentTime()}][INFO] Recieved signal.`);

            const isUpdate = isSignalUpdate(sourceId);
            if (isUpdate) {
                console.log(`[${getCurrentTime()}][INFO] Signal is an update, processing as update.`);
            } else {
                recordSignalTime(sourceId);
                console.log(`[${getCurrentTime()}][INFO] New signal recorded.`);
            }

            const fileData = fs.readFileSync("data.json", "utf8");
            const dataObj = JSON.parse(fileData || "{}");
            if (!dataObj.whitelistedGroups) dataObj.whitelistedGroups = {};
            if (!dataObj.whitelistedGroups[sourceId]) {
                dataObj.whitelistedGroups[sourceId] = { sourceName: jid, numberOfSignals: 0, win: 0, loss: 0 };
            }

            dataObj.whitelistedGroups[sourceId].numberOfSignals++;
            fs.writeFileSync("data.json", JSON.stringify(dataObj, null, 2), "utf8");

            let parsed;
            try {
                const raw = await AiSummary(signalSummaryPrompt + text);
                // Clean up potential markdown fences
                const clean = raw.replace(/```json?/g, '').replace(/```/g, '').trim();
                parsed = JSON.parse(clean);
            } catch (err) {
                console.error(`[${getCurrentTime()}][ERROR] JSON parse failed:`, err.message);
                continue; // Skip this message
            }

            if (!parsed.valid) {
                continue; // Not a signal
            }

            const { positionType, entry, tp, sl } = parsed;
            console.log('-'.repeat(80));
            console.log(parsed);
            console.log('-'.repeat(80));
            // entry/bid is now explicitly named — no index confusion
            const messageId = msg.key.id;
            console.log("AI Response: " + positionType + " " + entry + " " + tp + " " + sl + "\nMessage ID: " + messageId);
            console.log('-'.repeat(80));

            await sendToMT5(positionType, entry, tp, sl, messageId, isUpdate);
        }
    });
}

// ─── MAIN ENTRY ───
(async () => {
    ensureDataExists();
    ensureConfigExists();
    //createPipeServer();

    console.log('🚀 Listener started. Waiting for QR code...');
    await connectWhatsApp();
})();

async function sendToMT5(type, bid, tp, sl, messageId, isUpdate) {
    const action = isUpdate ? "UpdatePosition" : "OpenPosition";
    if (pipeSocket && !pipeSocket.destroyed) {
        const message = JSON.stringify({
            action,
            type,
            bid,
            tp,
            sl,
            positionId: messageId,
            timestamp: Date.now()
        }) + '\n';
        pipeSocket.write(message, (err) => {
            if (err) console.error(`[${getCurrentTime()}][ERROR] Pipe write error:`, err);
            else console.log(`[${getCurrentTime()}][INFO] Signal sent to MT5`);
        });
    } else {
        console.log(`[${getCurrentTime()}][WARN] MT5 not connected`);
    }
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

// Add this function to manage signal timestamps
function getSignalTimestamps() {
    try {
        const data = fs.readFileSync("signalTimestamps.json", "utf8");
        return JSON.parse(data || "{}");
    } catch {
        return {};
    }
}

function saveSignalTimestamps(timestamps) {
    fs.writeFileSync("signalTimestamps.json", JSON.stringify(timestamps, null, 2), "utf8");
}

function isSignalUpdate(sourceId) {
    const timestamps = getSignalTimestamps();
    const lastSignalTime = timestamps[sourceId];

    if (!lastSignalTime) return false;

    const timeDiff = Date.now() - lastSignalTime;
    const tenMinutes = 10 * 60 * 1000;

    return timeDiff < tenMinutes;
}

function recordSignalTime(sourceId) {
    const timestamps = getSignalTimestamps();
    timestamps[sourceId] = Date.now();
    saveSignalTimestamps(timestamps);
}