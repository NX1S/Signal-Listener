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
const POSITIONS_FILE = "./Positions.json"; // open position file for each source


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
- When multiple TPs are present, always choose TP1, which is the closest to the entry.
- If you want to reference an entry, set it in the referenceEntry variable.
- Return ONLY the JSON object, no markdown, no explanations

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

// ─── MAIN ENTRY ───
(async () => {
    ensurePositionsExists();
    createPipeServer();

    console.log('🚀 Logic handler started.');
})();

async function AnalyzeMessage(text, sourceId, messageId) {
    // Parse signal
    const parsed = await parseSignalFromText(text);
    if (!parsed || parsed.action === "IGNORE" || !parsed.action) {
        console.log(`[${getCurrentTime()}][INFO] Ignored.`);
        return;
    }

    const positions = readPositions();

    console.log('-'.repeat(80));
    console.log(parsed);
    console.log('-'.repeat(80));

    // Handle action (isolated logic)
    const result = await handleSignalAction(parsed, sourceId, messageId, positions);
    if (result) {
        writeJSON(POSITIONS_FILE, positions);

        // Send to MT5 (isolated transport)
        await sendToMT5({
            action: result.action,
            type: result.data.type,
            bid: result.data.entry,
            tp: result.data.tp,
            sl: result.data.sl,
            positionId: result.data.messageId,
            timestamp: Date.now()
        });
    }

    console.log('-'.repeat(80));
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
    writeJSON(POSITIONS_FILE, positions);

    const reason = payload.reason || 'closed';
    console.log(`[${getCurrentTime()}][INFO] Removed closed position from Positions.json for ${sourceId} (messageId: ${positionId}, reason: ${reason})`);
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
    positions[sourceId] = {
        messageId: truncatedId,
        type: parsed.positionType,
        entry: parsed.entry,
        tp: parsed.tp,
        sl: parsed.sl
    };
    return { action: "OpenPosition", data: positions[sourceId] };
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
    return { action: "UpdatePosition", data: existing };
}

async function handleCloseSignal(parsed, sourceId, positions) {
    const existing = positions[sourceId];
    if (!existing) {
        console.log(`[${getCurrentTime()}][WARN] CLOSE received but no open position for ${sourceId}. Ignoring.`);
        return null;
    }
    return { action: "ClosePosition", data: existing };
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