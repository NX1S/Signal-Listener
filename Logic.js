const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');
const fs = require('fs');
const net = require('net');
const path = require('path');

dotenv.config();

const pipeName = '\\\\.\\pipe\\MT5Signal';
let pipeServer;
let pipeSocket;

// ─── RECONNECTION STATE ───
let sock = null;
const POSITIONS_FILE = "./Positions.json";

// ─── CONFIG & LOGGER ───
const CONFIG_FILE = "./config.json";
const LOGGER_SCRIPT = "./Other Scripts/Logger.js"
let sendSignalLog = null; // set only if logging is enabled

const signalSummaryPrompt = `You are a trading signal formatter and classifier for XAUUSD only. Classify the message into exactly ONE action and return ONLY a JSON object, no markdown, no explanations and no thoughts:
- "UPDATE": A message that explicitly moves/changes the take profit or stop loss of an ALREADY OPEN trade (e.g., "TP1 AS 4043", "MOVE SL TO 4045", "SL TO BREAKEVEN"). For TP updates, extract only the new tp price. For SL updates, extract the new sl price if a number is given. If the message says "breakeven", "BE", or "at entry" / "to entry" with no number, return the string "BREAKEVEN".
- "CLOSE": An instruction to close an open trade right now (e.g. "CLOSE 4050 ENTRY", "CLOSE NOW", "CLOSE ALL", "EXIT TRADE", "SMALL ACCOUNTS CLOSE"). Any price mentioned in a CLOSE message is ONLY used to identify WHICH entry to close — it is NEVER a condition to wait for. Treat every CLOSE as an immediate, unconditional close at current market price. Put the mentioned price (if any) in "referenceEntry".
- "IGNORE": If a message does not contain an update or a new position. This includes: progress/status updates ("50+ pips running", "GOLD - TP1 HIT", "120+ pips running", "70+ Pips Profit Running"), hold confirmations ("STAY 4048 HOLDING"), and any non-trade chatter.

{
  "action": "OPEN" | "UPDATE" | "CLOSE" | "IGNORE", 
  "positionType": "BUY" or "SELL" or "BUYLIMIT" or "SELLLIMIT",
  "entry": number or null,
  "referenceEntry": number or null,
  "tp": number or null,
  "sl": number or "BREAKEVEN" or null
}

Rules:
- Only allow XAUUSD trades. If the message is for any other symbol, set action as "IGNORE".
- XAUUSD is valid only when prices are between 2500 and 6000. If the signal entry, TP, or SL is below 2500 or above 6000, set action as "IGNORE".
- positionType must be uppercase "BUY", "SELL", "BUYLIMIT", or "SELLLIMIT". If you cant figure out the position type, set action as "IGNORE".
- If the message explicitly says "LIMIT" next to the direction (e.g. "BUY LIMIT", "SELL LIMIT"), set positionType to "BUYLIMIT" or "SELLLIMIT" respectively — this is a pending order that should only fill once price reaches the entry, not an instant execution. If no "LIMIT" keyword is present, treat it as an instant market order: positionType "BUY" or "SELL".
- Use null for missing prices, never 0 or empty string.
- If a price range is given for entry, set entry to the lowest value for BUY and BUYLIMIT, and the highest value for SELL and SELLLIMIT. This applies the same way whether it's an instant order or a LIMIT order — always pick the price most favorable to the trader's direction.
- When multiple TPs are present, always choose TP1, which is the closest to the entry.
- If the TP is given in pips, translate it over to a price value. each 1 pip = 0.10$. Ex: TP at 100 pip = 10$ + entry
- If the is a pip range present, choose the lowest one.
- If you want to reference an entry, set it in the referenceEntry variable.
- Return ONLY the JSON object, no markdown, no explanations

make sure the numbers you parse are the correct values for each section.

Message to analyze:
`;

const geminiAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY });
const geminiAIBackup = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY_BACKUP });

async function AiSummary(prompt, AI) {
    const response = await AI.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
        temperature: 0,
    });
    const textContent = response.text || "";
    return textContent || "No output";
}

function isPendingType(type) {
    return type === 'BUYLIMIT' || type === 'SELLLIMIT';
}

// ─── MAIN ENTRY ───
(async () => {
    ensurePositionsExists();
    createPipeServer();

    console.log(`[${getCurrentTime()}][SYSTEM] Logic handler started.`);

    const config = readJSON(CONFIG_FILE);

    if (config.LogSignalsToGroup === true) {
        const Logger = require(LOGGER_SCRIPT); // adjust path if you use Telegram/Logger.js
        sendSignalLog = Logger.sendSignalLog;
        await Logger.startLogger();
    } else {
        console.log(`[${getCurrentTime()}][INFO] Logger disabled in config.`);
    }
})();

async function AnalyzeMessage(text, sourceId, messageId, sourceName) {
    // Parse signal
    const parsed = await parseSignalFromText(text);
    if (!parsed || parsed.action === "IGNORE" || !parsed.action) {
        const title = " from " + sourceName;
        console.log(`[${getCurrentTime()}][INFO] Ignored message${title}.`);
        return;
    }

    const positions = readPositions();

    console.log('-'.repeat(80));
    console.log(parsed);
    console.log('-'.repeat(80));

    // Handle action (isolated logic)
    const result = await handleSignalAction(parsed, sourceId, messageId, positions, sourceName);
    if (result) {
        writeJSON(POSITIONS_FILE, positions);

        // Some outcomes need more than one message to MT5 — e.g. closing a
        // signal that might still be a resting LIMIT order needs both a
        // CancelPending and a ClosePosition, since we can't be sure which
        // one applies. MT5 silently no-ops whichever doesn't match.
        if (result.extraActions) {
            for (const extra of result.extraActions) {
                await sendToMT5(buildMT5Payload(extra.action, extra.data));
            }
        }

        // Send to MT5 (isolated transport)
        await sendToMT5(buildMT5Payload(result.action, result.data));
    }
}

function buildMT5Payload(action, data) {
    const payload = {
        action,
        type: data.type,
        tp: data.tp,
        sl: data.sl,
        positionId: data.messageId,
        timestamp: Date.now()
    };

    // Pending (LIMIT) orders need an explicit entry "price" so MT5 places
    // a resting order there; instant BUY/SELL orders keep using "bid" so
    // MT5 falls back to the live market price if none is supplied.
    if (isPendingType(data.type)) {
        payload.price = data.entry;
    } else {
        payload.bid = data.entry;
    }

    return payload;
}

function createPipeServer() {
    try {
        require('fs').unlinkSync(pipeName);
    } catch (e) { /* ignore if doesn't exist */ }

    pipeServer = net.createServer((socket) => {
        console.log(`[${getCurrentTime()}][SYSTEM] MT5 connected.`);
        pipeSocket = socket;
        let inboundBuffer = '';

        socket.on('data', (chunk) => {
            inboundBuffer += chunk.toString('utf8').replace(/\0/g, '');

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
            console.log(`[${getCurrentTime()}][SYSTEM] MT5 disconnected`);
            pipeSocket = null;
        });

        socket.on('error', (err) => {
            console.error(`[${getCurrentTime()}][ERROR] Socket error:`, err.message);
            pipeSocket = null;
        });

        socket.on('close', () => {
            console.log(`[${getCurrentTime()}][SYSTEM] Socket closed`);
            pipeSocket = null;
        });
    });

    pipeServer.listen(pipeName, () => {
        console.log(`[${getCurrentTime()}][INFO] Ready to connect to MT5.`);
    });

    pipeServer.on('error', (err) => {
        console.error(`[${getCurrentTime()}][ERROR] Pipe server error:`, err.message);
        setTimeout(createPipeServer, 5000);
    });
}

// ─── POSITIONS HELPER ───
function ensurePositionsExists() {
    try {
        fs.accessSync(POSITIONS_FILE, fs.constants.F_OK);
    } catch {
        writeJSON(POSITIONS_FILE, {});
        console.log(`[${getCurrentTime()}][INFO] Created default Positions.json`);
    }
}

function readPositions() {
    try {
        return readJSON(POSITIONS_FILE);
    } catch {
        return {};
    }
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
    if (!rawMessage || rawMessage.trim().length === 0) return;
    let payload;

    try {
        payload = JSON.parse(rawMessage);
    } catch (err) {
        console.error(`[${getCurrentTime()}][ERROR] Invalid pipe JSON from MT5:`, err.message);
        return;
    }

    if (payload.action === 'Ping') return;
    if (payload.action === 'PositionClosed') {
        handlePositionClosedNotification(payload);
    }
    if (payload.action === 'PendingOrderRemoved') {
        handlePendingOrderRemovedNotification(payload);
    }
}

// Shared by both PositionClosed and PendingOrderRemoved: find the tracked
// entry by its positionId (messageId) and drop it from Positions.json.
function removeTrackedPosition(payload, missingLabel) {
    const positionId = typeof payload.positionId === 'string' ? payload.positionId.trim() : '';

    if (!positionId) {
        console.log(`[${getCurrentTime()}][WARN] Ignoring ${missingLabel} notification without positionId.`);
        return;
    }

    const positions = readPositions();
    const sourceId = findPositionSourceIdByMessageId(positions, positionId);

    if (!sourceId) {
        console.log(`[${getCurrentTime()}][WARN] ${missingLabel} notification received for unknown positionId: ${positionId}`);
        return;
    }

    delete positions[sourceId];
    writeJSON(POSITIONS_FILE, positions);

    return sourceId;
}

function handlePendingOrderRemovedNotification(payload) {
    const sourceId = removeTrackedPosition(payload, 'pending-removed');
    if (!sourceId) return;

    const reason = payload.reason || 'removed';
    console.log(`[${getCurrentTime()}][INFO] Pending order removed for ${sourceId} (never filled). Reason: ${reason}`);
}

function handlePositionClosedNotification(payload) {
    const sourceId = removeTrackedPosition(payload, 'close');
    if (!sourceId) return;

    const reason = payload.reason || 'closed';
    console.log(`[${getCurrentTime()}][INFO] Closed position for ${sourceId}. Reason: ${reason}`);
}

// ─── SIGNAL PARSER (Domain Logic) ───
async function parseSignalFromText(text) {
    try {
        let raw = await AiSummary(signalSummaryPrompt + text, geminiAI);
        let clean = raw.replace(/```json?/g, '').replace(/```/g, '').trim();
        return JSON.parse(clean);
    } catch (err) {
        console.error(`[${getCurrentTime()}][ERROR] AI parse failed:`, err.message);
        if (process.env.GOOGLE_AI_KEY_BACKUP) {
            console.log(`[${getCurrentTime()}][INFO] Using backup AI.`);
            try {
                raw = await AiSummary(signalSummaryPrompt + text, geminiAIBackup);
                clean = raw.replace(/```json?/g, '').replace(/```/g, '').trim();
                return JSON.parse(clean);
            } catch (backupErr) {
                console.error(`[${getCurrentTime()}][ERROR] Backup AI parse failed:`, backupErr.message);
                return null;
            }
        }
        return null;
    }
}

// ─── STATE MANAGER (Business Logic) ───
async function handleSignalAction(parsed, sourceId, messageId, positions) {
    const action = (parsed.action || "").toString().trim().toUpperCase();

    if (action === "OPEN") {
        return await handleOpenSignal(parsed, sourceId, messageId, positions);
    } else if (action === "UPDATE") {
        return await handleUpdateSignal(parsed, sourceId, positions);
    } else if (action === "CLOSE") {
        return await handleCloseSignal(parsed, sourceId, positions);
    } else {
        console.log(`[${getCurrentTime()}][WARN] Unknown action: ${parsed.action}`);
        return null;
    }
}

async function handleOpenSignal(parsed, sourceId, messageId, positions) {
    if (!isCompleteSignal(parsed)) {
        console.log(`[${getCurrentTime()}][WARN] Incomplete OPEN signal. Required: entry, tp, sl. Skipping.`);
        return null;
    }
    const truncatedId = messageId.substring(0, 31);

    // If this source already had a tracked position and it was a LIMIT order,
    // we're about to overwrite its record with the new signal. If that old
    // LIMIT never filled, it would otherwise be orphaned on MT5 with no way
    // to reference it again — cancel it first.
    const previous = positions[sourceId];
    const extraActions = (previous && isPendingType(previous.type))
        ? [{ action: "CancelPending", data: previous }]
        : undefined;

    positions[sourceId] = {
        messageId: truncatedId,
        type: parsed.positionType,
        entry: parsed.entry,
        tp: parsed.tp,
        sl: parsed.sl
    };
    return { action: "OpenPosition", data: positions[sourceId], extraActions };
}

async function handleUpdateSignal(parsed, sourceId, positions) {
    const existing = positions[sourceId];
    if (!existing) {
        console.log(`[${getCurrentTime()}][WARN] UPDATE received but no open position for ${sourceId}. Ignoring.`);
        return null;
    }
    if (parsed.tp !== null && parsed.tp !== undefined) {
        existing.tp = parsed.tp;
    }
    if (parsed.sl !== null && parsed.sl !== undefined) {
        existing.sl = typeof parsed.sl === 'string' && parsed.sl.toUpperCase() === 'BREAKEVEN' ? existing.entry : parsed.sl;
    }
    if (parsed.positionType) {
        existing.type = parsed.positionType;
    }

    // UpdatePosition only touches an already-filled position on the MT5 side.
    // If this source is still a resting LIMIT order, also send ModifyPending
    // so the new TP/SL applies whichever state it's actually in.
    const extraActions = isPendingType(existing.type)
        ? [{ action: "ModifyPending", data: existing }]
        : undefined;

    return { action: "UpdatePosition", data: existing, extraActions };
}

async function handleCloseSignal(parsed, sourceId, positions) {
    const existing = positions[sourceId];
    if (!existing) {
        console.log(`[${getCurrentTime()}][WARN] CLOSE received but no open position for ${sourceId}. Ignoring.`);
        return null;
    }

    // We don't get a fill notification from MT5, so we can't be sure whether
    // a tracked LIMIT order has filled into a real position yet. Send both:
    // CancelPending covers it if still resting, ClosePosition covers it if
    // it already filled. MT5 no-ops whichever one doesn't apply.
    const extraActions = isPendingType(existing.type)
        ? [{ action: "CancelPending", data: existing }]
        : undefined;

    return { action: "ClosePosition", data: existing, extraActions };
}

// ─── HELPER FUNCTIONS ───
function isCompleteSignal(parsed) {
    return parsed.entry !== null && parsed.tp !== null && parsed.sl !== null;
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

// ─── UNIFIED SEND TO MT5 ───
async function sendToMT5(payload, sourceName) {
    if (pipeSocket && !pipeSocket.destroyed) {
        const message = JSON.stringify(payload) + '\n';
        pipeSocket.write(message, (err) => {
            if (err) console.error(`[${getCurrentTime()}][ERROR] Pipe write error:`, err);
            else {
                console.log(`[${getCurrentTime()}][INFO] Signal sent to MT5 → ${payload.action}`);
                if (sendSignalLog) {
                    sendSignalLog(payload.action, sourceName, payload.bid, payload.tp, payload.sl);
                }
            }
        });
    } else {
        console.log(`[${getCurrentTime()}][WARN] MT5 not connected. Signal dropped: ${payload.action}`);
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

module.exports = { AnalyzeMessage };