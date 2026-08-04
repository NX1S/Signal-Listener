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
const CONFIG_FILE = "./config.json"; // config file location
const DATA_FILE = "./data.json"; // data file location
const POSITIONS_FILE = "./positions.json"; // open position file for each source


const signalSummaryPrompt = `You are a trading signal formatter and classifier for XAUUSD only. Classify the message into exactly ONE action and return ONLY a JSON object, no markdown, no explanations and no thoughts:
- "UPDATE": A message that explicitly moves/changes the take profit or stop loss of an ALREADY OPEN trade (e.g., "TP1 AS 4043", "MOVE SL TO 4045", "SL TO BREAKEVEN"). For TP updates, extract only the new tp price. For SL updates, extract the new sl price if a number is given. If the message says "breakeven", "BE", or "at entry" / "to entry" with no number, return the string "BREAKEVEN".
- "CLOSE": An instruction to close an open trade right now (e.g. "CLOSE 4050 ENTRY", "CLOSE NOW", "CLOSE ALL", "EXIT TRADE", "SMALL ACCOUNTS CLOSE"). Any price mentioned in a CLOSE message is ONLY used to identify WHICH entry to close — it is NEVER a condition to wait for. Treat every CLOSE as an immediate, unconditional close at current market price. Put the mentioned price (if any) in "referenceEntry".
- "IGNORE": If a message does not contain an update or a new position. This includes: progress/status updates ("50+ pips running", "GOLD - TP1 HIT", "120+ pips running", "70+ Pips Profit Running"), hold confirmations ("STAY 4048 HOLDING"), and any non-trade chatter.

{
  "action": "OPEN" | "UPDATE" | "CLOSE" | "IGNORE", 
  "positionType": "BUY" or "SELL",
  "entry": number or null,
  "referenceEntry": number or null,
  "tp": number or null,
  "sl": number or "BREAKEVEN" or null
}

Rules:
- Only allow XAUUSD trades. If the message is for any other symbol, set action as "IGNORE".
- XAUUSD is valid only when prices are between 2500 and 6000. If the signal entry, TP, or SL is below 2500 or above 6000, set action as "IGNORE".
- positionType must be uppercase "BUY" or "SELL", if you cant figure out the position type, set action as "IGNORE".
- Use null for missing prices, never 0 or empty string.
- If price range given, set entry to the lowest for BUY, and highest for SELL.
- When multiple TPs are present, choose the lower one on buy, and greater one on sell. the one closer to the enter gets to be the TP.
- If you want to reference an entry, set it in the referenceEntry variable.
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
        let inboundBuffer = '';

        socket.on('data', (chunk) => {
            inboundBuffer += chunk.toString('utf8');

            let newlineIndex;
            while ((newlineIndex = inboundBuffer.indexOf('\n')) !== -1) {
                const line = inboundBuffer.slice(0, newlineIndex).trim();
                inboundBuffer = inboundBuffer.slice(newlineIndex + 1);

                if (line) {
                    handlePipeMessage(line);
                }
            }
        });

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
        whiteListedGroups: []
    };
    try {
        fs.accessSync(CONFIG_FILE, fs.constants.F_OK);
    } catch {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), "utf8");
        console.log(`[${getCurrentTime()}][INFO] Created default config.json`);
    }
}

// ─── POSITIONS HELPER ───
function ensurePositionsExists() {
    try {
        fs.accessSync(POSITIONS_FILE, fs.constants.F_OK);
    } catch {
        fs.writeFileSync(POSITIONS_FILE, "{}", "utf8");
        console.log(`[${getCurrentTime()}][INFO] Created default positions.json`);
    }
}

function clearPositionsFile() {
    fs.writeFileSync(POSITIONS_FILE, "{}", "utf8");
    console.log(`[${getCurrentTime()}][INFO] Cleared positions.json for a fresh start.`);
}

function readPositions() {
    try {
        return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8") || "{}");
    } catch {
        return {};
    }
}

function writePositions(positions) {
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2), "utf8");
}

function findPositionSourceIdByMessageId(positions, messageId) {
    const entries = Object.entries(positions);

    for (const [sourceId, position] of entries) {
        if (position && position.messageId === messageId) {
            return sourceId;
        }
    }

    return null;
}

function handlePipeMessage(rawMessage) {
    let payload;

    try {
        payload = JSON.parse(rawMessage);
    } catch (err) {
        console.error(`[${getCurrentTime()}][ERROR] Invalid pipe JSON from MT5:`, err.message);
        return;
    }

    if (payload.action === 'PositionClosed') {
        handlePositionClosedNotification(payload);
    }
}

function handlePositionClosedNotification(payload) {
    const positionId = typeof payload.positionId === 'string' ? payload.positionId.trim() : '';

    if (!positionId) {
        console.log(`[${getCurrentTime()}][WARN] Ignoring close notification without positionId.`);
        return;
    }

    const positions = readPositions();
    const sourceId = findPositionSourceIdByMessageId(positions, positionId);

    if (!sourceId) {
        console.log(`[${getCurrentTime()}][INFO] Close notification received for unknown positionId: ${positionId}`);
        return;
    }

    delete positions[sourceId];
    writePositions(positions);

    const reason = payload.reason || 'closed';
    console.log(`[${getCurrentTime()}][INFO] Removed closed position from positions.json for ${sourceId} (messageId: ${positionId}, reason: ${reason})`);
}

// ─── DATA.JSON HELPER ───
function ensureDataExists() {
    try {
        fs.accessSync(DATA_FILE, fs.constants.F_OK);
    } catch {
        fs.writeFileSync(DATA_FILE, "{}", "utf8");
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

// ─── MESSAGE HANDLER ───
function attachMessageHandler(socket) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const whitelistedGroups = config.whiteListedGroups || [];

    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            const jid = msg.key.remoteJid;
            const sourceId = jid;
            let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (!text) continue;

            // ─── WHITELIST CHECK ───
            if (!whitelistedGroups.includes(sourceId)) continue;

            // ─── TRIGGER WORD CHECK ───
            const found = ["buy", "sell", "gold", "xauusd", "close", "tp", "sl", "breakeven", "be", "exit"].some(word => text.toLowerCase().includes(word));
            if (!found) continue;

            console.log(`[${getCurrentTime()}][INFO] Received signal.`);

            // Update signal count in data.json
            const fileData = fs.readFileSync(DATA_FILE, "utf8");
            const dataObj = JSON.parse(fileData || "{}");
            if (!dataObj.whiteListedGroups) dataObj.whiteListedGroups = {};
            if (!dataObj.whiteListedGroups[sourceId]) {
                dataObj.whiteListedGroups[sourceId] = { sourceName: jid, numberOfSignals: 0, win: 0, loss: 0 };
            }
            dataObj.whiteListedGroups[sourceId].numberOfSignals++;
            fs.writeFileSync(DATA_FILE, JSON.stringify(dataObj, null, 2), "utf8");

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

            if (parsed.action === "IGNORE" || !parsed.action) {
                continue; // Not a signal
            }

            const messageId = msg.key.id;
            const positions = readPositions();

            console.log('-'.repeat(80));
            console.log(parsed);
            console.log('-'.repeat(80));

            // ─── ACTION: OPEN ───
            // ─── ACTION: OPEN ───
            if (parsed.action === "OPEN") {
                if (!isCompleteSignal(parsed)) {
                    console.log(`[${getCurrentTime()}][WARN] Incomplete OPEN signal. Required: entry, tp, sl. Skipping.`);
                    continue;
                }

                const truncatedId = messageId.substring(0, 31);

                positions[sourceId] = {
                    messageId: truncatedId,
                    type: parsed.positionType,
                    entry: parsed.entry,
                    tp: parsed.tp,
                    sl: parsed.sl
                };
                writePositions(positions);

                console.log(`[${getCurrentTime()}][INFO] New position stored for ${sourceId}, messageId: ${truncatedId}`);
                console.log(`OPEN → ${parsed.positionType} | Entry: ${parsed.entry} | TP: ${parsed.tp} | SL: ${parsed.sl}`);

                await sendToMT5({
                    action: "OpenPosition",
                    type: parsed.positionType,
                    bid: parsed.entry,
                    tp: parsed.tp,
                    sl: parsed.sl,
                    positionId: truncatedId,
                    timestamp: Date.now()
                });
            }

            // ─── ACTION: UPDATE ───
            else if (parsed.action === "UPDATE") {
                const existing = positions[sourceId];
                if (!existing) {
                    console.log(`[${getCurrentTime()}][WARN] UPDATE received but no open position for ${sourceId}. Ignoring.`);
                    continue;
                }

                const originalMessageId = existing.messageId;

                if (parsed.tp !== null && parsed.tp !== undefined) {
                    existing.tp = parsed.tp;
                }
                if (parsed.sl !== null && parsed.sl !== undefined) {
                    if (typeof parsed.sl === 'string' && parsed.sl.toUpperCase() === 'BREAKEVEN') {
                        existing.sl = existing.entry;
                    } else {
                        existing.sl = parsed.sl;
                    }
                }
                if (parsed.positionType) {
                    existing.type = parsed.positionType;
                }

                writePositions(positions);

                console.log(`[${getCurrentTime()}][INFO] Position updated for ${sourceId}, originalId: ${originalMessageId}`);
                console.log(`UPDATE → Type: ${existing.type} | Entry: ${existing.entry} | TP: ${existing.tp} | SL: ${existing.sl}`);

                await sendToMT5({
                    action: "UpdatePosition",
                    type: existing.type,
                    bid: existing.entry,
                    tp: existing.tp,
                    sl: existing.sl,
                    positionId: originalMessageId,
                    updateId: messageId,
                    timestamp: Date.now()
                });
            }

            // ─── ACTION: CLOSE ───
            else if (parsed.action === "CLOSE") {
                const existing = positions[sourceId];
                if (!existing) {
                    console.log(`[${getCurrentTime()}][WARN] CLOSE received but no open position for ${sourceId}. Ignoring.`);
                    continue;
                }

                const hasReferenceEntry = parsed.referenceEntry !== null && parsed.referenceEntry !== undefined && parsed.referenceEntry !== "";
                const hasStoredEntry = existing.entry !== null && existing.entry !== undefined && existing.entry !== "";

                if (hasReferenceEntry && hasStoredEntry) {
                    const referenceEntry = Number(parsed.referenceEntry);
                    const storedEntry = Number(existing.entry);

                    if (!Number.isFinite(referenceEntry) || !Number.isFinite(storedEntry) || referenceEntry !== storedEntry) {
                        console.log(`[${getCurrentTime()}][WARN] CLOSE reference entry ${parsed.referenceEntry} did not match stored entry ${existing.entry} for ${sourceId}. Ignoring.`);
                        continue;
                    }
                }

                const originalMessageId = existing.messageId;

                console.log(`[${getCurrentTime()}][INFO] Closing position for ${sourceId}, originalId: ${originalMessageId}`);
                console.log(`CLOSE → ${existing.type} | Entry: ${existing.entry}`);

                await sendToMT5({
                    action: "ClosePosition",
                    type: existing.type,
                    bid: existing.entry,
                    tp: existing.tp,
                    sl: existing.sl,
                    positionId: originalMessageId,
                    timestamp: Date.now()
                });

                delete positions[sourceId];
                writePositions(positions);
                console.log(`[${getCurrentTime()}][INFO] Position removed from positions.json.`);
            }

            console.log('-'.repeat(80));
        }
    });
}

// ─── HELPER FUNCTIONS ───
function isCompleteSignal(parsed) {
    return parsed.entry !== null && parsed.tp !== null && parsed.sl !== null;
}

// ─── UNIFIED SEND TO MT5 ───
async function sendToMT5(payload) {
    if (pipeSocket && !pipeSocket.destroyed) {
        const message = JSON.stringify(payload) + '\n';
        pipeSocket.write(message, (err) => {
            if (err) console.error(`[${getCurrentTime()}][ERROR] Pipe write error:`, err);
            else console.log(`[${getCurrentTime()}][INFO] Signal sent to MT5 → ${payload.action}`);
        });
    } else {
        console.log(`[${getCurrentTime()}][WARN] MT5 not connected. Signal dropped: ${payload.action}`);
    }
}

// ─── MAIN ENTRY ───
(async () => {
    ensureDataExists();
    ensureConfigExists();
    ensurePositionsExists();
    clearPositionsFile();
    createPipeServer();

    console.log('🚀 Listener started. Waiting for QR code...');
    await connectWhatsApp();
})();

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