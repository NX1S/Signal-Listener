const readline = require('readline');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

let sock;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function showCommands() {
    console.log('\n' + '═'.repeat(60));
    console.log('📋 AVAILABLE COMMANDS');
    console.log('═'.repeat(60));
    console.log('  list              - List all groups and channels');
    console.log('  add [JID]         - Add JID to whitelist');
    console.log('  exit              - Exit CLI');
    console.log('═'.repeat(60) + '\n');
}

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync("config.json", "utf8"));
    } catch {
        return { whitelistedGroups: [] };
    }
}

function saveConfig(config) {
    const nextConfig = {
        whitelistedGroups: Array.isArray(config.whitelistedGroups) ? config.whitelistedGroups : [],
    };

    fs.writeFileSync("config.json", JSON.stringify(nextConfig, null, 2), "utf8");
}

async function listGroupsAndChannels() {
    console.log('\n⏳ Fetching groups and channels...\n');

    const chats = await sock.groupFetchAllParticipating().catch(() => ({}));

    const groups = [];
    const channels = [];

    for (const [id, metadata] of Object.entries(chats)) {
        const info = {
            id: id,
            name: metadata.subject || 'Unknown',
            participants: metadata.participants?.length || 0,
        };

        if (id.includes('@newsletter')) {
            channels.push(info);
        } else if (id.endsWith('@g.us')) {
            groups.push(info);
        }
    }

    console.log('═'.repeat(60));
    console.log(`📢 GROUPS (${groups.length} found)`);
    console.log('═'.repeat(60));
    groups.forEach((g) => {
        console.log(`   ID: ${g.id}`);
        console.log(`   Name: ${g.name}`);
        console.log(`   Participants: ${g.participants}\n`);
    });

    console.log('═'.repeat(60));
    console.log(`📢 CHANNELS (${channels.length} found)`);
    console.log('═'.repeat(60));
    channels.forEach((c) => {
        console.log(`   ID: ${c.id}`);
        console.log(`   Name: ${c.name}\n`);
    });
}

async function addToWhitelist(jid) {
    const config = loadConfig();

    if (config.whitelistedGroups.includes(jid)) {
        console.log(`⚠️  JID already whitelisted: ${jid}`);
        return;
    }

    config.whitelistedGroups.push(jid);
    saveConfig(config);
    console.log(`✅ Added to whitelist: ${jid}`);
}

function promptCommand() {
    rl.question('> ', async (input) => {
        const parts = input.trim().split(' ');
        const cmd = parts[0].toLowerCase();

        if (cmd === 'list') {
            await listGroupsAndChannels();
        } else if (cmd === 'add') {
            const jid = parts[1];
            if (!jid) {
                console.log('❌ Usage: add [JID]');
            } else {
                await addToWhitelist(jid);
            }
        } else if (cmd === 'exit') {
            console.log('👋 Goodbye!');
            process.exit(0);
        } else if (cmd === '') {
            // Empty input, just prompt again
        } else {
            console.log(`❌ Unknown command: ${cmd}`);
            showCommands();
        }

        promptCommand();
    });
}

(async () => {
    console.log('⏳ Initializing...');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    console.log('✅ Auth state loaded');

    const { version } = await fetchLatestBaileysVersion();
    console.log('✅ Version fetched');

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
    });
    console.log('✅ Socket created');

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log('📡 Connection update:', connection);

        if (qr) {
            console.log('\n📱 Scan QR:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ Connected!');
            showCommands();
            promptCommand();
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 3s...');
                setTimeout(() => {
                    console.log('⏳ Retrying connection...');
                    // Script will restart via process manager or manual re-run
                }, 3000);
            } else {
                console.log('❌ Logged out.');
                process.exit(1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
})();