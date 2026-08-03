const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const WHATSAPP_BOT_FILE = path.join(ROOT, 'WhatsApp', 'WhatsappBot.js');
const WHATSAPP_LIST_FILE = path.join(ROOT, 'WhatsApp', 'GroupLister.js');
const TELEGRAM_BOT_FILE = path.join(ROOT, 'Telegram', 'TelegramBot.js');
const TELEGRAM_LIST_FILE = path.join(ROOT, 'Telegram', 'ListGroupsChannels.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw || '{}');
    const whitelist = Array.isArray(config.whiteListedGroups)
      ? config.whiteListedGroups
      : Array.isArray(config.whitelistedGroups)
        ? config.whitelistedGroups
        : [];

    return {
      ...config,
      whiteListedGroups: whitelist,
      whitelistedGroups: whitelist,
    };
  } catch {
    return {
      whiteListedGroups: [],
      whitelistedGroups: [],
      destinations: [],
    };
  }
}

function saveConfig(config) {
  const whitelist = Array.isArray(config.whiteListedGroups)
    ? config.whiteListedGroups
    : Array.isArray(config.whitelistedGroups)
      ? config.whitelistedGroups
      : [];

  const nextConfig = {
    ...config,
    whiteListedGroups: whitelist,
    whitelistedGroups: whitelist,
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 2), 'utf8');
}

function getWhitelist(config) {
  if (Array.isArray(config.whiteListedGroups)) {
    return config.whiteListedGroups;
  }

  if (Array.isArray(config.whitelistedGroups)) {
    return config.whitelistedGroups;
  }

  return [];
}

function printHeader(title) {
  console.clear();
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function runNodeScript(scriptFile, systemMessage) {
  return new Promise((resolve, reject) => {
    console.clear();
    if (systemMessage) {
      console.log(systemMessage);
      console.log('');
    }

    const child = spawn(process.execPath, [scriptFile], {
      stdio: 'inherit',
      cwd: ROOT,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${path.basename(scriptFile)} exited with code ${code}`));
    });
  });
}

async function listWhitelist() {
  const config = loadConfig();
  const whitelist = getWhitelist(config);

  console.clear();
  console.log('Whitelist');
  console.log('---------');
  if (whitelist.length === 0) {
    console.log('No IDs are currently whitelisted.');
    return;
  }

  whitelist.forEach((id, index) => {
    console.log(`${index + 1}. ${id}`);
  });
}

async function addWhitelistEntry() {
  console.clear();
  console.log('Add Whitelist');
  console.log('-------------');
  console.log('');
  console.log('Allowed IDs:');
  console.log(' - Whatsapp Groups');
  console.log(' - Telegram Groups');
  console.log(' - Telegram Channels');
  console.log('Leave empty if you want to quit...');

  const id = (await ask('Enter ID to add: ')).trim();
  if (!id) {
    return;
  }

  const config = loadConfig();
  const whitelist = getWhitelist(config);

  if (whitelist.includes(id)) {
    console.log(`Already whitelisted: ${id}`);
    return;
  }

  whitelist.push(id);
  config.whiteListedGroups = whitelist;
  config.whitelistedGroups = whitelist;
  saveConfig(config);
  console.log(`Added to whitelist: ${id}`);
}

async function removeWhitelistEntry() {
  console.clear();
  console.log('Remove Whitelist');
  console.log('----------------');

  const config = loadConfig();
  const whitelist = getWhitelist(config);

  if (whitelist.length === 0) {
    console.log('No IDs are currently whitelisted.');
  } else {
    whitelist.forEach((id, index) => {
      console.log(`${index + 1}. ${id}`);
    });
  }

  console.log('');
  console.log('Leave empty if you want to quit...');

  const id = (await ask('Enter ID to remove: ')).trim();
  if (!id) {
    return;
  }

  const nextWhitelist = whitelist.filter((entry) => entry !== id);

  if (nextWhitelist.length === whitelist.length) {
    console.log(`ID not found in whitelist: ${id}`);
    return;
  }

  config.whiteListedGroups = nextWhitelist;
  config.whitelistedGroups = nextWhitelist;
  saveConfig(config);
  console.log(`Removed from whitelist: ${id}`);
}

async function whatsappMenu() {
  while (true) {
    printHeader('WhatsApp Bot');
    console.log('1. Start bot');
    console.log('2. List joined groups');
    console.log('3. back');

    const choice = (await ask('Choose an option: ')).trim();

    if (choice === '1') {
      await runNodeScript(WHATSAPP_BOT_FILE);
    } else if (choice === '2') {
      await runNodeScript(WHATSAPP_LIST_FILE, '[SYSTEM] Triggering GroupLister.js...');
    } else if (choice === '3') {
      return;
    } else {
      console.log('Invalid choice.');
    }
  }
}

async function telegramMenu() {
  while (true) {
    printHeader('Telegram Bot');
    console.log('1. Start bot');
    console.log('2. List joined groups');
    console.log('3. back');

    const choice = (await ask('Choose an option: ')).trim();

    if (choice === '1') {
      await runNodeScript(TELEGRAM_BOT_FILE);
    } else if (choice === '2') {
      await runNodeScript(TELEGRAM_LIST_FILE, '[SYSTEM] Triggering ListGroupsChannels.js...');
    } else if (choice === '3') {
      return;
    } else {
      console.log('Invalid choice.');
    }
  }
}

async function configMenu() {
  while (true) {
    printHeader('Configure JSON Files');
    console.log('1. List whitelist');
    console.log('2. Add whitelist item');
    console.log('3. Remove whitelist item');
    console.log('4. Back');

    const choice = (await ask('Choose an option: ')).trim();

    if (choice === '1') {
      await listWhitelist();
      await ask('\nPress Enter to return to the menu...');
    } else if (choice === '2') {
      await addWhitelistEntry();
    } else if (choice === '3') {
      await removeWhitelistEntry();
    } else if (choice === '4') {
      return;
    } else {
      console.log('Invalid choice.');
    }
  }
}

async function mainMenu() {
  while (true) {
    printHeader('Signal Copier CLI');
    console.log('1. WhatsApp bot');
    console.log('2. Telegram bot');
    console.log('3. Configure JSON files');
    console.log('4. Exit');

    const choice = (await ask('Choose an option: ')).trim();

    if (choice === '1') {
      await whatsappMenu();
    } else if (choice === '2') {
      await telegramMenu();
    } else if (choice === '3') {
      await configMenu();
    } else if (choice === '4') {
      rl.close();
      process.exit(0);
    } else {
      console.log('Invalid choice.');
    }
  }
}

process.on('SIGINT', () => {
  rl.close();
  process.exit(0);
});

mainMenu().catch((error) => {
  console.error('CLI error:', error.message);
  rl.close();
  process.exit(1);
});