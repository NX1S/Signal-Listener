const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const WHATSAPP_BOT_FILE = path.join(ROOT, 'WhatsApp', 'WhatsappListener.js');
const WHATSAPP_LIST_FILE = path.join(ROOT, 'WhatsApp', 'WhatsappGroupLister.js');
const TELEGRAM_BOT_FILE = path.join(ROOT, 'Telegram', 'TelegramListener.js');
const TELEGRAM_LIST_FILE = path.join(ROOT, 'Telegram', 'TelegramGroupLister.js');

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
    return JSON.parse(raw || '{}');
  } catch {
    return {
      whiteListedGroups: {
        Whatsapp: [],
        Telegram: []
      }
    };
  }
}

function saveConfig(config) {
  const nextConfig = {
    whiteListedGroups: {
      Whatsapp: Array.isArray(config.whiteListedGroups?.Whatsapp) ? config.whiteListedGroups.Whatsapp : [],
      Telegram: Array.isArray(config.whiteListedGroups?.Telegram) ? config.whiteListedGroups.Telegram : []
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 2), 'utf8');
}

function getAllWhitelist(config) {
  const groups = config.whiteListedGroups || {};
  const result = [];

  (groups.Whatsapp || []).forEach(id => {
    result.push({ platform: 'Whatsapp', id });
  });
  (groups.Telegram || []).forEach(id => {
    result.push({ platform: 'Telegram', id });
  });

  return result;
}

function getWhitelistByPlatform(config, platform) {
  const groups = config.whiteListedGroups || {};
  return Array.isArray(groups[platform]) ? groups[platform] : [];
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
  const allEntries = getAllWhitelist(config);

  console.clear();
  console.log('Whitelist');
  console.log('---------');
  if (allEntries.length === 0) {
    console.log('No IDs are currently whitelisted.');
    return;
  }

  allEntries.forEach((entry, index) => {
    console.log(`${index + 1}. [${entry.platform}] ${entry.id}`);
  });
}

async function addWhitelistEntry() {
  console.clear();
  console.log('Add Whitelist');
  console.log('-------------');
  console.log('');
  console.log('Platforms: Whatsapp, Telegram');
  console.log('Leave empty if you want to quit...');

  const platformChoice = (await ask('Choose platform:\n[W] Whatsapp [T] Telegram\n> ')).trim().toUpperCase();

  let platform;
  if (platformChoice === 'W') {
    platform = 'Whatsapp';
  } else if (platformChoice === 'T') {
    platform = 'Telegram';
  } else {
    console.log('Invalid choice.');
    return;
  }

  const id = (await ask('Enter ID to add: ')).trim();
  if (!id) {
    return;
  }

  const config = loadConfig();
  const platformList = getWhitelistByPlatform(config, platform);

  if (platformList.includes(id)) {
    console.log(`Already whitelisted on ${platform}: ${id}`);
    return;
  }

  platformList.push(id);
  config.whiteListedGroups = config.whiteListedGroups || {};
  config.whiteListedGroups[platform] = platformList;
  saveConfig(config);
  console.log(`Added to ${platform} whitelist: ${id}`);
}

async function removeWhitelistEntry() {
  console.clear();
  console.log('Remove Whitelist');
  console.log('----------------');

  const config = loadConfig();
  const allEntries = getAllWhitelist(config);

  if (allEntries.length === 0) {
    console.log('No IDs are currently whitelisted.');
    return;
  }

  allEntries.forEach((entry, index) => {
    console.log(`${index + 1}. [${entry.platform}] ${entry.id}`);
  });

  console.log('');
  console.log('Leave empty if you want to quit...');

  const platformChoice = (await ask('Choose platform:\n[W] Whatsapp [T] Telegram\n> ')).trim().toUpperCase();

  let platform;
  if (platformChoice === 'W') {
    platform = 'Whatsapp';
  } else if (platformChoice === 'T') {
    platform = 'Telegram';
  } else {
    console.log('Invalid choice.');
    return;
  }

  const id = (await ask('Enter ID to remove: ')).trim();
  if (!id) {
    return;
  }

  const platformList = getWhitelistByPlatform(config, platform);
  const nextList = platformList.filter((entry) => entry !== id);

  if (nextList.length === platformList.length) {
    console.log(`ID not found in ${platform} whitelist: ${id}`);
    return;
  }

  config.whiteListedGroups[platform] = nextList;
  saveConfig(config);
  console.log(`Removed from ${platform} whitelist: ${id}`);
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
      await runNodeScript(WHATSAPP_LIST_FILE, '[SYSTEM] Triggering WhatsappGroupLister.js...');
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
      await runNodeScript(TELEGRAM_LIST_FILE, '[SYSTEM] Triggering TelegramGroupLister.js...');
    } else if (choice === '3') {
      return;
    } else {
      console.log('Invalid choice.');
    }
  }
}

async function configMenu() {
  while (true) {
    printHeader('Configurations');
    console.log('1. List whitelist');
    console.log('2. Add whitelist item');
    console.log('3. Remove whitelist item');
    console.log('4. List Log Destination Item');
    console.log('5. Add Log Destination Item');
    console.log('6. Remove Log Destination Item');
    console.log('7. Toggle Action Logging');
    console.log('8. Toggle Debug Logs');
    console.log('9. Back');

    const choice = (await ask('Choose an option: ')).trim();

    switch (choice) {
      case '1':
        await listWhitelist();
        await ask('\nPress Enter to return to the menu...');
        break;
      case '2':
        await addWhitelistEntry();
        break;
      case '3':
        await removeWhitelistEntry();
        break;
      case '4':

        break;
      case '5':

        break;
      case '6':

        break;
      case '7':

        break;
      case '8':

        break;
      case '9':
        return;

      default:
        console.log('Invalid choice.');
        break;
    }
  }
}

async function mainMenu() {
  while (true) {
    printHeader('Signal Copier CLI');
    console.log('1. WhatsApp bot');
    console.log('2. Telegram bot');
    console.log('3. Configuration');
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
