import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input"; // npm install input
import dotenv from "dotenv";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config(); // Load .env variables

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

const envPath = path.join(__dirname, '.env');
let envContent = fs.readFileSync(envPath, 'utf-8');

// empty session for first login
let stringSession = new StringSession("");

(async () => {
  console.log("⚡ Starting Telegram session...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("📱 Enter your phone number: "),
    password: async () => await input.text("🔑 Enter your 2FA password: "),
    phoneCode: async () => await input.text("💬 Enter the code you received: "),
    onError: (err) => console.log(err),
  });

  console.log("✅ Logged in!");
  console.log("Here’s your StringSession:\n");
  stringSession = client.session.save();
  console.log(stringSession); // <-- copy this and reuse it


  const regex = /STRING_SESSION=.*/;
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `STRING_SESSION=${stringSession}`);
  } else {
    envContent += `\nSTRING_SESSION=${stringSession}`;
  }
  fs.writeFileSync(envPath, envContent);
  // Replace or add STRING_SESSION

  await client.disconnect();
})();
