import { TelegramClient, Logger } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import { type } from "os";

dotenv.config(); // Load .env variables

// ----------- Telegram Setup -----------

const apiIdSelfBot = parseInt(process.env.API_ID);
const apiHashSelfBot = process.env.API_HASH;
const stringSessionSelfBot = new StringSession(process.env.STRING_SESSION);
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

const selfClient = new TelegramClient(stringSessionSelfBot, apiIdSelfBot, apiHashSelfBot, {
    connectionRetries: 5
});
selfClient.setLogLevel('none');

const client = new TelegramClient(new StringSession(""), apiIdSelfBot, apiHashSelfBot, {
    connectionRetries: 5
});
client.setLogLevel('none');

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

// ----------- Telegram Bot Logic -----------

(async () => {

    //check if data.json file exists
    try {
        fs.accessSync("data.json", fs.constants.F_OK)
    } catch {
        fs.writeFileSync("data.json", "{}", "utf8");
    }

    await selfClient.start();
    const self = await selfClient.getMe();
    console.log(`[${getCurrentTime()}][INFO] Listener connected to Telegram with @${self.username}!`);
    //Selfbot

    await client.start({ botAuthToken: botToken });
    console.log(`[${getCurrentTime()}][INFO] Signaler Bot is on!`);
    //Bot

    const sourceHandler = async (event) => {
        const msg = event.message;
        //get the id of the signal source
        let sourceId;
        if (msg.peerId.channelId != null) {
            sourceId = msg.peerId.channelId;
            console.log("Recieved message from channel.");
        }
        else if (msg.peerId.chatId != null) {
            sourceId = msg.peerId.chatId;
            console.log("Recieved message from chat.");
        }
        else
            sourceId = null;

        //filter message and check if it comes back empty (null = not related)
        const text = await filterChannelMessages(msg, sourceId);
        if (!text) return;
        console.log(`[${getCurrentTime()}][INFO] Recieved signal.`)
        const chatTitle = await getChatTitle(selfClient, msg);

        //check if data.json has the required fields. if not, create them
        const fileData = fs.readFileSync("data.json", "utf8");
        const obj = JSON.parse(fileData);
        if (!obj.sources) obj.sources = {};
        if (!obj.sources[sourceId]) obj.sources[sourceId] = { sourceName: chatTitle, numberOfSignals: 0, win: 0, loss: 0 };

        //counting signals by channel
        obj.sources[sourceId].numberOfSignals++;
        fs.writeFileSync("data.json", JSON.stringify(obj, null, 2), "utf8");

        //ai summary
        let aiSummary;
        try {
            aiSummary = await AiSummary(signalSummaryPrompt + msg.message);
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

        newSendMessageToTargets(positionType, bid, tp, sl);
    };
    //check if data.json has the required fields. if not, create them
    const fileConfig = fs.readFileSync("config.json", "utf8");
    const obj = JSON.parse(fileConfig);
    if (!obj.sources) obj.sources = [];
    selfClient.addEventHandler(sourceHandler, new NewMessage({ chats: obj.destinations }));
})();


// ------------------------
// Functions
// ------------------------

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

async function getChatTitle(client, msg) {
    if (msg.chat && msg.chat.title) return msg.chat.title;
    if (msg._chat && msg._chat.title) return msg._chat.title;
    try {
        const entity = await client.getEntity(msg.peerId);
        if (entity && entity.title) return entity.title;
        if (entity && entity.firstName) return entity.firstName;
        if (entity && entity.username) return entity.username;
    } catch (err) {
        console.warn(`[${getCurrentTime()}][WARN] Could not fetch chat entity:`, err);
    }
    return "Unknown Chat";
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