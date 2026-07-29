// ============================================================
// BAILEYS READ-ONLY WHATSAPP LISTENER (FIXED QR)
// Copy-paste this into a file (e.g., listener.js) and run:
//   npm init -y
//   npm install @whiskeysockets/baileys pino qrcode-terminal
//   node listener.js
// ============================================================

// --- 1. IMPORTS ---
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ============================================================
// --- 2. MAIN FUNCTION ---
// ============================================================
(async () => {

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
            console.log('✅ Connected to WhatsApp!');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
            if (!shouldReconnect) {
                console.log('   → Logged out. Delete auth_info_baileys folder and scan QR again.');
            }
        }
    });

    // --- 3b. CREDENTIALS UPDATE ---
    sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // --- 4. MESSAGE LISTENER (THE CORE) ---
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            const messageId = msg.key.id;
            const timestamp = msg.messageTimestamp;

            const isGroup = jid.endsWith('@g.us');
            const isChannel = jid.endsWith('@newsletter');
            const isPrivate = jid.endsWith('@s.whatsapp.net');

            let text = '';
            const m = msg.message;

            if(!m){
                text = '[NON-TEXT MESSAGE]';
            } else if (m.conversation) {
                text = m.conversation;

            } else if (m.extendedTextMessage?.text) {
                text = m.extendedTextMessage.text;

            } else if (m.imageMessage?.caption) {
                text = m.imageMessage.caption;

            } else if (m.videoMessage?.caption) {
                text = m.videoMessage.caption;

            } else if (m.documentMessage?.caption) {
                text = m.documentMessage.caption;

            } else if (m.buttonsResponseMessage?.selectedButtonId) {
                text = m.buttonsResponseMessage.selectedButtonId;

            } else if (m.listResponseMessage?.title) {
                text = m.listResponseMessage.title;

            } else if (m.pollUpdateMessage) {
                text = '[POLL_VOTE]';

            } else if (m.reactionMessage) {
                text = `[REACTION: ${m.reactionMessage.text}]`;

            } else {
                text = '[NON-TEXT MESSAGE]';
            }

            const sender = msg.key.participant || jid;
            const pushName = msg.pushName || 'Unknown';
            const isReply = !!m?.extendedTextMessage?.contextInfo?.stanzaId;
            const quotedMsgId = m?.extendedTextMessage?.contextInfo?.stanzaId || null;
            const isForwarded = m?.extendedTextMessage?.contextInfo?.isForwarded || false;
            const isViewOnce = !!m?.imageMessage?.viewOnce || !!m?.videoMessage?.viewOnce;

            console.log('────────────────────────────────────────');
            console.log(`📩 New Message [${type}]`);
            console.log(`   Chat Type : ${isGroup ? 'GROUP' : isChannel ? 'CHANNEL' : 'PRIVATE'}`);
            console.log(`   JID       : ${jid}`);
            console.log(`   Sender    : ${sender} (${pushName})`);
            console.log(`   Msg ID    : ${messageId}`);
            console.log(`   Time      : ${new Date(timestamp * 1000).toISOString()}`);
            console.log(`   Is Reply  : ${isReply} ${quotedMsgId ? '(to ' + quotedMsgId + ')' : ''}`);
            console.log(`   Forwarded : ${isForwarded}`);
            console.log(`   View Once : ${isViewOnce}`);
            console.log(`   Text      : ${text}`);
            console.log('────────────────────────────────────────');
        }
    });

    // ============================================================
    // --- 5. OTHER EVENT LISTENERS ---
    // ============================================================

    // Group participant changes (join/leave/promote/demote)
    sock.ev.on('group-participants.update', (update) => {
        console.log('[EVENT] 👥 Group Event:', update.id, '| Action:', update.action, '| Participants:', update.participants);
    });

    // Group metadata changes (name, description, settings)
    sock.ev.on('groups.update', (updates) => {
        for (const group of updates) {
            console.log('🏷️ Group Updated:', group.id);
            if (group.subject) console.log('   New Name:', group.subject);
            if (group.desc) console.log('   New Desc:', group.desc);
        }
    });

    // Presence updates (online/offline/typing)
    sock.ev.on('presence.update', (update) => {
        console.log('[INFO] 🟢 Presence:', update.id, '→', update.presences[update.id]?.lastKnownPresence);
    });

    // Contact sync updates
    sock.ev.on('contacts.update', (contacts) => {
        for (const contact of contacts) {
            console.log('[INFO] 📇 Contact Update:', contact.id, contact.notify || '');
        }
    });

    // Chat metadata updates (archive, pin, mute)
    sock.ev.on('chats.update', (chats) => {
        for (const chat of chats) {
            console.log('[INFO] 💬 Chat Update:', chat.id, chat);
        }
    });

    // Initial history sync progress
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
        console.log('[INFO] 📜 History Sync:', messages.length, 'messages | Is Latest:', isLatest);
    });

    // Message deletions / revokes
    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            if (update.update?.messageStubType) {
                console.log('[INFO] 🗑️ Message Update/Delete:', update.key.id, 'Stub:', update.update.messageStubType);
            }
        }
    });

    // ============================================================
    // --- 6. KEEP ALIVE ---
    // ============================================================
    console.log('🚀 Listener started. Waiting for QR code...');
    console.log('   If no QR appears in 5 seconds, make sure your terminal supports Unicode.');
    console.log('   Press Ctrl+C to stop.');

})();