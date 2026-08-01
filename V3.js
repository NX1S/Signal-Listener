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

const signalSummaryPrompt = `You are a trading signal classifier for XAUUSD/GOLD messages. Classify the message into exactly ONE action, then return ONLY a JSON object (no markdown, no explanation).

Action definitions:

- "OPEN": A FULLY STRUCTURED trade setup that includes an entry price (or range) AND a stop loss AND at least one take profit. This is the ONLY case that opens a new position.
  A bare alert like "SELL GOLD NOW 4048" or "BUY GOLD NOW 2100" with no stop loss / TP is NOT enough on its own — classify that as "IGNORE", not "OPEN". Wait for the follow-up message that has full SL/TP details.

- "UPDATE_TP": A message that explicitly moves/changes the take profit of an ALREADY OPEN trade (e.g. "TP1 AS 4043", "1ST TP AT 4043", "MOVE TP TO 4030"). Extract only the new tp price.

- "UPDATE_SL": A message that explicitly moves/changes the stop loss of an ALREADY OPEN trade (e.g. "SL TO BREAKEVEN", "MOVE SL TO 4045", "SL AT ENTRY", "STOP LOSS TO ENTRY"). Extract the new sl price if a number is given. If the message says "breakeven", "BE", or "at entry" / "to entry" with no number, return the string "BREAKEVEN" (these all mean the same thing: move the stop to the trade's entry price).

- "CLOSE": An instruction to close an open trade right now (e.g. "CLOSE 4050 ENTRY", "CLOSE NOW", "CLOSE ALL", "EXIT TRADE"). Any price mentioned in a CLOSE message is ONLY used to identify WHICH entry to close — it is NEVER a condition to wait for. Treat every CLOSE as an immediate, unconditional close at current market price. Put the mentioned price (if any) in "referenceEntry".

- "IGNORE": Everything else. This includes: bare "BUY/SELL NOW" alerts with no SL/TP, progress/status updates ("50+ pips running", "GOLD - TP1 HIT", "120+ pips running", "70+ Pips Profit Running"), hold confirmations ("STAY 4048 HOLDING"), and any non-trade chatter. "TP HIT" style messages must ALWAYS be IGNORE, never OPEN or UPDATE_TP.

Return ONLY this JSON shape:
{
  "action": "OPEN" | "UPDATE_TP" | "UPDATE_SL" | "CLOSE" | "IGNORE",
  "positionType": "BUY" or "SELL" or null,
  "entry": number or null,
  "tp": number or null,
  "sl": number or "BREAKEVEN" or null,
  "referenceEntry": number or null
}

Rules:
- positionType is only set for "OPEN"; null for every other action.
- For OPEN: if a price range is given (e.g. "4048-4050"), use the lowest number for BUY and the highest number for SELL as "entry".
- For OPEN: if multiple TPs are listed (TP1, TP2, ...), use TP1 (the first/nearest level) as "tp". Ignore TP2 and beyond.
- For UPDATE_TP: put the new value in "tp", leave "entry" and "sl" null.
- For UPDATE_SL: put the new value in "sl", leave "entry" and "tp" null.
- For CLOSE: put any referenced entry price in "referenceEntry" only — never in "tp" or "sl".
- Use null for any field that doesn't apply. Never use 0 or empty string as a placeholder.
- Return ONLY the JSON object, no markdown, no explanations.

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
            // Widened beyond just "buy/sell/gold/xauusd" so update/close messages
            // like "TP1 AS 4043" or "CLOSE 4050 ENTRY" aren't silently dropped
            // before they ever reach the AI classifier.
            const found = ["buy", "sell", "gold", "xauusd", "tp", "sl", "close", "entry", "stop"]
                .some(word => text.toLowerCase().includes(word));
            if (!found) continue;

            console.log(`[${getCurrentTime()}][INFO] Keyword match found, asking AI to classify...`);

            let parsed;
            try {
                const raw = await AiSummary(signalSummaryPrompt + text);
                const clean = raw.replace(/```json?/g, '').replace(/```/g, '').trim();
                parsed = JSON.parse(clean);
            } catch (err) {
                console.error(`[${getCurrentTime()}][ERROR] JSON parse failed:`, err.message);
                continue; // Skip this message
            }

            const { action, positionType, entry, tp, sl, referenceEntry } = parsed;
            const messageId = msg.key.id;

            console.log('-'.repeat(80));
            console.log(parsed);
            console.log('-'.repeat(80));

            if (!action || action === "IGNORE") {
                console.log(`[${getCurrentTime()}][INFO] AI classified as IGNORE - no action taken.`);
                continue; // Nothing recorded, nothing counted, nothing sent
            }

            // ─── OPEN: only fires on a fully structured setup (entry + SL + TP) ───
            if (action === "OPEN") {
                console.log(`[${getCurrentTime()}][INFO] New OPEN signal confirmed.`);

                const fileData = fs.readFileSync("data.json", "utf8");
                const dataObj = JSON.parse(fileData || "{}");
                if (!dataObj.whitelistedGroups) dataObj.whitelistedGroups = {};
                if (!dataObj.whitelistedGroups[sourceId]) {
                    dataObj.whitelistedGroups[sourceId] = { sourceName: jid, numberOfSignals: 0, win: 0, loss: 0 };
                }
                dataObj.whitelistedGroups[sourceId].numberOfSignals++;
                fs.writeFileSync("data.json", JSON.stringify(dataObj, null, 2), "utf8");

                // Remember this as the active trade for the source so later
                // UPDATE_TP / UPDATE_SL / CLOSE messages know what they refer to.
                setOpenPosition(sourceId, { positionId: messageId, positionType, entry, tp, sl });

                console.log(`[${getCurrentTime()}][INFO] AI Response: ${positionType} ${entry} TP:${tp} SL:${sl} | Message ID: ${messageId}`);
                await sendToMT5({ action: "OpenPosition", type: positionType, bid: entry, tp, sl, positionId: messageId });
                console.log('═'.repeat(60));
                continue;
            }

            // Every action below refers to an ALREADY open trade for this source
            const openPosition = getOpenPosition(sourceId);
            if (!openPosition) {
                console.log(`[${getCurrentTime()}][WARN] Got ${action} but no tracked open position for this source - ignoring.`);
                continue;
            }

            // ─── UPDATE_TP ───
            if (action === "UPDATE_TP") {
                console.log(`[${getCurrentTime()}][INFO] Updating TP for open position ${openPosition.positionId} to ${tp}`);
                openPosition.tp = tp;
                setOpenPosition(sourceId, openPosition);
                await sendToMT5({ action: "UpdateTP", type: openPosition.positionType, tp, positionId: openPosition.positionId });
                console.log('═'.repeat(60));
                continue;
            }

            // ─── UPDATE_SL ───
            if (action === "UPDATE_SL") {
                // "SL to breakeven" / "SL at entry" both mean: move SL to this
                // trade's actual entry price. The AI can't know that number from
                // the message text alone, so resolve it from tracked state.
                let resolvedSl = sl;
                if (sl === "BREAKEVEN") {
                    resolvedSl = openPosition.entry;
                    console.log(`[${getCurrentTime()}][INFO] SL instruction resolved to entry price: ${resolvedSl}`);
                } else if (sl === null) {
                    console.log(`[${getCurrentTime()}][WARN] UPDATE_SL classified but no SL value or BREAKEVEN marker returned - skipping.`);
                    continue;
                }

                console.log(`[${getCurrentTime()}][INFO] Updating SL for open position ${openPosition.positionId} to ${resolvedSl}`);
                openPosition.sl = resolvedSl;
                setOpenPosition(sourceId, openPosition);
                await sendToMT5({ action: "UpdateSL", type: openPosition.positionType, sl: resolvedSl, positionId: openPosition.positionId });
                console.log('═'.repeat(60));
                continue;
            }

            // ─── CLOSE ───
            // Any price mentioned (referenceEntry) is purely an identifier.
            // This is always an IMMEDIATE close at current market price - never
            // treated as a limit/condition to wait for.
            if (action === "CLOSE") {
                console.log(`[${getCurrentTime()}][INFO] Closing position ${openPosition.positionId} immediately (mentioned price ${referenceEntry} is informational only).`);
                await sendToMT5({ action: "ClosePosition", type: openPosition.positionType, positionId: openPosition.positionId });
                clearOpenPosition(sourceId);
                console.log('═'.repeat(60));
                continue;
            }
        }
    });
}

// ─── MAIN ENTRY ───
(async () => {
    ensureDataExists();
    ensureConfigExists();
    createPipeServer();

    console.log('🚀 Listener started. Waiting for QR code...');
    await connectWhatsApp();
})();

// action: "OpenPosition" | "UpdateTP" | "UpdateSL" | "ClosePosition"
// The EA on the MT5 side needs to handle each of these action strings.
// ClosePosition carries no price - it's an immediate market close, never conditional.
async function sendToMT5({ action, type, bid = null, tp = null, sl = null, positionId }) {
    if (pipeSocket && !pipeSocket.destroyed) {
        let payload;
        switch (action) {
            case "OpenPosition":
                // Entry, SL, and TP go out TOGETHER in one message.
                payload = { action, type, bid, tp, sl, positionId };
                break;
            case "UpdateSL":
                // Only the new SL — no tp, no bid.
                payload = { action, type, sl, positionId };
                break;
            case "UpdateTP":
                // Only the new TP — no sl, no bid.
                payload = { action, type, tp, positionId };
                break;
            case "ClosePosition":
                // No price at all — just identifies which position to close now.
                payload = { action, type, positionId };
                break;
            default:
                payload = { action, type, bid, tp, sl, positionId };
        }
        payload.timestamp = Date.now();

        const message = JSON.stringify(payload) + '\n';
        pipeSocket.write(message, (err) => {
            if (err) console.error(`[${getCurrentTime()}][ERROR] Pipe write error:`, err);
            else console.log(`[${getCurrentTime()}][INFO] ${action} sent to MT5`);
        });
    } else {
        console.log(`[${getCurrentTime()}][WARN] MT5 not connected - ${action} dropped`);
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

// ─── OPEN POSITION STATE ───
// Tracks the currently-open trade per source so UPDATE_TP / UPDATE_SL / CLOSE
// know exactly which position they refer to, instead of guessing from a time window.
function getOpenPositions() {
    try {
        const data = fs.readFileSync("positions.json", "utf8");
        return JSON.parse(data || "{}");
    } catch {
        return {};
    }
}

function saveOpenPositions(positions) {
    fs.writeFileSync("positions.json", JSON.stringify(positions, null, 2), "utf8");
}

function setOpenPosition(sourceId, position) {
    const positions = getOpenPositions();
    positions[sourceId] = position;
    saveOpenPositions(positions);
}

function getOpenPosition(sourceId) {
    const positions = getOpenPositions();
    return positions[sourceId] || null;
}

function clearOpenPosition(sourceId) {
    const positions = getOpenPositions();
    delete positions[sourceId];
    saveOpenPositions(positions);
}