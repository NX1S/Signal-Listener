// ============================================================
// BAILEYS READ-ONLY WHATSAPP LISTENER (FIXED QR)
// Copy-paste this into a file (e.g., listener.js) and run:
//   npm init -y
//   npm install @whiskeysockets/baileys pino qrcode-terminal
//   node listener.js
// ============================================================

// --- 1. IMPORTS ---
const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');


dotenv.config(); // Load .env variables

const botToken = process.env.BOT_TOKEN;
const targetGroupId = parseInt(process.env.TARGET_GROUP_ID);
const signalDestination = [-1003150924994, -4911865260];

const signalSummaryPrompt = `You are a trading signal formatter.  Take the following trading signal message and extract the key values into the following format:

"BUY||SELL LIMIT TP SL"
"BUY||SELL 0000.00 0000.00 0000.00"

Rules:
- Replace every 0000.00 with the actual number, otherwise keep it if the number is absent.  
- Always keep BUY/SELL uppercase.  
- Always keep the order: Entry, Limit, TP, SL.
- Do not analyze/put your thoughts on it, your only purpose is to format text.
- Symbols are not allowed 
Your only response should be nothing but the prompt.\n`;

const signalCheckPrompt = `The following text is telling me to take a market position (only taking a position, not ads, not TP hits, not congratulations, not signals telling to take a position without any given numbers) reply "true" or "false", no other text: `;


// ----------- Google AI Setup -----------

const geminiAIRating = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY_RATING });
const geminiAICheck = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY_CHECK });

async function AiCheck(prompt) {
    const response = await geminiAICheck.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        temperature: 0,
    });
    return response.text || "No output";
}

async function AiSummary(prompt) {
    const response = await geminiAIRating.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        temperature: 0,
    });
    return response.text || "No output";
}

// ============================================================
// --- MAIN FUNCTION ---
// ============================================================
(async () => {


    // 1. check if data.json has the required fields. if not, create them
    const fileConfig = fs.readFileSync("config.json", "utf8");
    const obj = JSON.parse(fileConfig);
    if (!obj.sources) obj.sources = [];


    // --- 2a. AUTH STATE SETUP ---
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // --- 2b. CREATE THE SOCKET ---
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        // printQRInTerminal: true,  // ← This sometimes fails silently
    });

    // ============================================================
    // --- 3. CONNECTION STATUS + QR CODE ---
    // ============================================================
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- QR CODE HANDLER ---
        // When qr is present, print it to terminal using qrcode-terminal
        if (qr) {
            console.log('\n📱 Scan this QR code with WhatsApp → Settings → Linked Devices:\n');
            qrcode.generate(qr, { small: true });
            console.log('\n');
        }

        if (connection === 'open') {
            console.log('Connected to WhatsApp!');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (!shouldReconnect) {
                console.log('   → Logged out. Delete auth_info_baileys folder and scan QR again.');
            }
        }
    });

    // --- 3b. CREDENTIALS UPDATE ---
    sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // --- 4. MESSAGE LISTENER ---
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            const messageId = msg.key.id;
            const timestamp = msg.messageTimestamp;

            const isGroup = jid.endsWith('@g.us'); // group
            const isChannel = jid.endsWith('@newsletter'); // channel
            const isPrivate = jid.endsWith('@s.whatsapp.net'); // private message

            let text = '';
            const m = msg.message;

            if (!m) {
                text = '[NON-TEXT MESSAGE]';
            } else if (m.conversation) {
                text = m.conversation;

            } else if (m.extendedTextMessage?.text) {
                text = m.extendedTextMessage.text;

            } else {
                text = '[NON-TEXT MESSAGE]';
            }

            const senderID = msg.key.participant || jid;
            const pushName = msg.pushName || 'Unknown';

            console.log(`[${getCurrentTime()}][INFO] Recieved message.`);

            /*//check if data.json has the required fields. if not, create them
            const fileData = fs.readFileSync("data.json", "utf8");
            const obj = JSON.parse(fileData);
            if (!obj.sources) obj.sources = {};
            if (!obj.sources[senderID]) obj.sources[senderID] = { sourceName: pushName, numberOfSignals: 0, win: 0, loss: 0 };

            //counting signals by channel
            obj.sources[senderID].numberOfSignals++;
            fs.writeFileSync("data.json", JSON.stringify(obj, null, 2), "utf8");

            //ai summary
            let aiSummary;
            try {
                aiSummary = await AiSummary(signalSummaryPrompt + text);
            } catch (err) {
                console.error(`[${getCurrentTime()}][ERROR] AI error:`, err);
                aiSummary = "AI Summary failed.";
            }

            console.log(aiSummary);
            const AIOutputArray = aiSummary.split(" ");
            const positionType = AIOutputArray[0];
            const bid = Number(AIOutputArray[1]); // 0000.00 same as 0
            const tp = Number(AIOutputArray[2]);
            const sl = Number(AIOutputArray[3]);

            // newSendMessageToTargets(positionType, bid, tp, sl);*/

            const isReply = !!m?.extendedTextMessage?.contextInfo?.stanzaId;
            const quotedMsgId = m?.extendedTextMessage?.contextInfo?.stanzaId || null;
            const isForwarded = m?.extendedTextMessage?.contextInfo?.isForwarded || false;
            const isViewOnce = !!m?.imageMessage?.viewOnce || !!m?.videoMessage?.viewOnce;

            console.log('────────────────────────────────────────');
            console.log(`📩 New Message [${type}]`);
            console.log(`   Chat Type : ${isGroup ? 'GROUP' : isChannel ? 'CHANNEL' : 'PRIVATE'}`);
            console.log(`   Sender    : ${senderID} (${pushName})`);
            console.log(`   Text      : ${text}`);
            console.log(`   JID       : ${jid}`);
            console.log(`   Msg ID    : ${messageId}`);
            console.log(`   Time      : ${new Date(timestamp * 1000).toISOString()}`);
            console.log(`   Is Reply  : ${isReply} ${quotedMsgId ? '(to ' + quotedMsgId + ')' : ''}`);
            console.log(`   Forwarded : ${isForwarded}`);
            console.log(`   View Once : ${isViewOnce}`);
            console.log('────────────────────────────────────────');
        }
    });

    // ============================================================
    // --- 5. KEEP ALIVE ---
    // ============================================================
    console.log('🚀 Listener started. Waiting for QR code...');
    console.log('   If no QR appears in 5 seconds, make sure your terminal supports Unicode.');
    console.log('   Press Ctrl+C to stop.');

})();


async function newSendMessageToTargets(type, bid, tp, sl) {
    let message = `Position Type: ${type}\nBid: ${bid}\nTP: ${tp}\nSL:${sl}`;
    const fileConfig = fs.readFileSync("config.json", "utf8");
    const obj = JSON.parse(fileConfig);
    if (!obj.destinations) obj.destinations = [];
    for (const destination of obj.destinations) {
        try {
            await client.sendMessage(destination, { message: message });
        } catch (err) {
            console.error(`[${getCurrentTime()}][ERROR] Failed to send message to destination ${destination}.\n Am I in this group?`);
        }
    }
}

async function filterChannelMessages(msg, sourceId) {
    let keywords;
    keywords = ["buy", "sell", "gold", "xauusd"];
    /*switch (sourceId) {
    
        case "groupIDHere":
            keywords = ["buy", "sell", "gold", "xauusd"];
            break;

        default:0
            keywords = ["buy", "sell", "gold", "xauusd"];
            break;
    }*/
    const found = keywords.some(word => msg.message.toLowerCase().includes(word.toLowerCase()));

    if (found) {
        let aiChecking;
        try {
            aiChecking = await AiCheck(signalCheckPrompt + msg.message);
        } catch (err) {
            console.error(`[${getCurrentTime()}][ERROR] AI error:`, err);
            aiChecking = "AI checking failed.";
            return null;
        }

        const vipSources = ["2473656171", "2266717234", "4923847295", "2948171548"];

        if (aiChecking.trim().toLowerCase() === "true") {
            if (vipSources.includes(sourceId.toString())) {
                console.log(`[${getCurrentTime()}][INFO] VIP Signal detected!`)
                return "⚠️⚠️⚠️VIP SIGNAL⚠️⚠️⚠️\n\n" + msg.message + "\n\n⚠️⚠️⚠️VIP SIGNAL⚠️⚠️⚠️";
            }
            else
                return msg.message;
        } else
            console.console.error("AI Checking Failed.");
    } else {
        return null;
    }
}

function formatTelegramSignal(msgText, msgDate, aiResponse, msgChatTitle) {
    let response;
    if (aiResponse != null)
        response = `\n\n💡 Summary:\n${aiResponse}`;
    else
        response = "";
    return `From: ` + msgChatTitle + `\n\n` + msgText + `\`` + response + `\``;
}

function getCurrentTime(date = new Date()) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const yyyy = date.getFullYear();

    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12; // Convert 0 to 12 for 12-hour format
    const hh = String(hours).padStart(2, '0');

    return `${dd}-${mm}-${yyyy} ${hh}:${minutes} ${ampm}`;
}