const tmi = require('tmi.js');
const fs = require('fs');
const net = require('net');
const path = require('path');

const dataDir = process.env.CHATCOMMANDER_DATA_PATH || '.';

// Only this account can use !join and !leave — hardcoded, not user-configurable
const APP_CREATORS = ['therealink', 'whalehouse8'];

// Track which channel a user's last command came from
const userLastChannel = {};

// Guest channels — persisted to file so they survive restarts
const guestChannels = new Set();
const guestChannelsFile = path.join(dataDir, 'guest_channels.json');

function loadGuestChannelsFromFile() {
    try {
        if (fs.existsSync(guestChannelsFile)) {
            const arr = JSON.parse(fs.readFileSync(guestChannelsFile, 'utf8'));
            arr.forEach(ch => guestChannels.add(ch));
        }
    } catch(e) {}
}

function saveGuestChannelsToFile() {
    fs.writeFileSync(guestChannelsFile, JSON.stringify([...guestChannels], null, 2));
}

loadGuestChannelsFromFile();

function sendToReactor(message) {
    const socket = new net.Socket();
    socket.connect(9000, '127.0.0.1', () => {
        socket.write(message);
        socket.destroy();
    });
    socket.on('error', () => {});
}

function getCommands() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'commands.json'), 'utf8')); }
    catch(e) { return {}; }
}

function getActions() {
    const actionsPath = path.join(dataDir, 'actions.json');
    if (!fs.existsSync(actionsPath)) return {};
    try { return JSON.parse(fs.readFileSync(actionsPath, 'utf8')); }
    catch(e) { return {}; }
}

function getDefaults() {
    const p = path.join(dataDir, 'defaults.json');
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch(e) { return {}; }
}

const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
let lastCommandChannel = '#' + config.channel.replace('#', '');

// Track guest channels the bot has joined

const client = new tmi.Client({
    identity: {
        username: config.botUsername,
        password: config.token
    },
    channels: [config.channel]
});

client.connect().then(() => {
    // Rejoin any saved guest channels
    for (const ch of guestChannels) {
        client.join(ch).catch(() => guestChannels.delete(ch));
    }
    // Auto-join approved mod channels
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
        const homeChannel = (cfg.channel || '').replace('#', '').toLowerCase();
        (cfg.mods || []).filter(m => m.approved).forEach(m => {
            if (m.username !== homeChannel && !guestChannels.has(m.username)) {
                client.join(m.username).catch(() => {});
            }
        });
    } catch(e) {}
}).catch(err => {
    console.error('Bot connection failed:', err);
});

// ---- Reply listener on port 9001 ----
const replyServer = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
        const msg = data.trim();
        if (msg) {
            client.say(lastCommandChannel, msg);
            const chatMsg = JSON.stringify({
                username: config.botUsername,
                message: msg,
                color: '#4fffb0',
                isBot: true,
                ts: Date.now()
            });
            process.stdout.write('CHAT_MSG:' + chatMsg + '\n');
        }
    });
    socket.on('error', () => {});
});

replyServer.listen(9001, '127.0.0.1', () => {
    console.log('Bot reply listener running on port 9001');
});

// ---- Auto $50/hr bank bonus ----
function giveHourlyBonus() {
    const memPath = path.join(dataDir, 'memory.json');
    if (!fs.existsSync(memPath)) return;
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync(memPath, 'utf8')); } catch(e) { return; }
    let changed = false;
    for (const key of Object.keys(mem)) {
        if (key.startsWith('bank_')) {
            const current = parseInt(mem[key]) || 0;
            mem[key] = String(current + 50);
            changed = true;
        }
    }
    if (changed) fs.writeFileSync(memPath, JSON.stringify(mem, null, 4));
}

setTimeout(() => {
    giveHourlyBonus();
    setInterval(giveHourlyBonus, 60 * 60 * 1000);
}, 60 * 1000);

// ---- Send listener on port 9002 (dashboard → chat) ----
const sendServer = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
        const msg = data.trim();
        if (msg) {
            client.say('#' + config.channel.replace('#', ''), msg);
            const chatMsg = JSON.stringify({
                username: config.botUsername,
                message: msg,
                color: '#4fffb0',
                isBot: true,
                ts: Date.now()
            });
            process.stdout.write('CHAT_MSG:' + chatMsg + '\n');
        }
    });
    socket.on('error', () => {});
});

sendServer.listen(9002, '127.0.0.1', () => {
    console.log('Bot send listener running on port 9002');
});

// Per-user, per-command cooldown tracker
const cooldownMap = {};

function isOnCooldown(username, command, cooldownSecs) {
    if (!cooldownSecs || cooldownSecs <= 0) return false;
    const key = username + ':' + command;
    const last = cooldownMap[key] || 0;
    return (Date.now() - last) < cooldownSecs * 1000;
}

function setCooldown(username, command) {
    cooldownMap[username + ':' + command] = Date.now();
}

// therealink is always an admin in every channel, regardless of config
function isAdmin(username) {
    if (APP_CREATORS.includes(username)) return true;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
        return (cfg.admins || []).map(a => a.toLowerCase()).includes(username.toLowerCase());
    } catch(e) { return false; }
}


function buildCommandsList() {
    const commands = getCommands();
    const actions = getActions();
    const defaults = getDefaults();
    const all = [
        ...Object.entries(commands).filter(([,v]) => v.enabled !== false).map(([k]) => k),
        ...Object.entries(actions).filter(([,v]) => v.enabled !== false).map(([k]) => '!' + k),
        ...(defaults['!so'] !== false ? ['!so'] : []),
        ...(defaults['!commands'] !== false ? ['!commands'] : []),
        ...(defaults['!bank'] !== false ? ['!bank'] : []),
        ...(defaults['!gamble'] !== false ? ['!gamble'] : []),
        ...(defaults['!car'] !== false ? ['!car'] : []),
    ];
    return [...new Set(all)].join(' | ');
}

// ---- Chat handler ----
client.on('message', (channel, tags, message, self) => {
    if (self) return;

    const normalizedChannel = channel.replace('#', '').toLowerCase();
    const homeChannel = config.channel.replace('#', '').toLowerCase();
    const username = (tags['display-name'] || tags.username || '').toLowerCase();
    const msg = message.trim();
    const msgLower = msg.toLowerCase();
    const command = msgLower.split(' ')[0];
    const args = msg.split(' ').slice(1).join(' ');

    // ── !join — therealink types this in ANY channel they're in ──────────────
    // Bot joins that channel and starts responding to !commands there
    if (command === '!join' && APP_CREATORS.includes(username)) {
        const target = normalizedChannel; // join the channel this message came from
        if (target === homeChannel) {
            client.say(channel, '@' + username + ' Already in this channel.');
            return;
        }
        if (guestChannels.has(target)) {
            client.say(channel, '@' + username + ' Bot is already here.');
            return;
        }
        client.join(target).then(() => {
            guestChannels.add(target);
            client.say(channel, '@' + username + ' ✓ Bot joined — viewers can use !commands');
        }).catch(() => {
            client.say(channel, '@' + username + ' Failed to join.');
        });
        return;
    }

    // ── !leave — therealink types this in the guest channel to remove the bot ─
    if (command === '!leave' && APP_CREATORS.includes(username)) {
        const target = normalizedChannel;
        if (target === homeChannel) {
            client.say(channel, '@' + username + ' Can\'t leave home channel.');
            return;
        }
        if (!guestChannels.has(target)) {
            client.say(channel, '@' + username + ' Bot isn\'t in this channel.');
            return;
        }
        client.say(channel, '@' + username + ' ✓ Bot leaving — see you!').then(() => {
            client.part(target);
            guestChannels.delete(target);
        }).catch(() => {
            client.part(target);
            guestChannels.delete(target);
        });
        return;
    }

    // ── Guest channel — respond to all commands ───────────────────────────────
    if (normalizedChannel !== homeChannel) {
        if (msgLower === '!commands') {
            client.say(channel, 'Commands: ' + buildCommandsList());
            return;
        }

        const guestCommands = getCommands();
        const guestActions = getActions();
        const guestDefaults = getDefaults();

        // Text commands
        if (guestCommands[command]) {
            const c = guestCommands[command];
            if (c.enabled === false) return;
            if (isOnCooldown(username, command, c.cooldown ?? 5)) return;
            setCooldown(username, command);
            client.say(channel, c.response);
            return;
        }

        // C++ Actions
        const guestActionKey = command.startsWith('!') ? command.slice(1) : null;
        if (guestActionKey && guestActions[guestActionKey]) {
            const a = guestActions[guestActionKey];
            if (a.enabled === false) return;
            if (isOnCooldown(username, command, a.cooldown ?? 5)) return;
            setCooldown(username, command);
            lastCommandChannel = channel;
            sendToReactor(`COMMAND:${guestActionKey}:${username}:${message}:${args}:${channel.replace('#','')}`);
            return;
        }

        // !bank / !gamble
        if (command === '!bank' || command === '!gamble') {
            if (guestDefaults[command] === false) return;
            const sub = args.split(' ')[0] || '';
            const cd = guestDefaults[command + '_sub_' + sub] ?? guestDefaults[command + '_cd'] ?? 5;
            if (isOnCooldown(username, command + ':' + sub, cd)) return;
            setCooldown(username, command + ':' + sub);
            lastCommandChannel = channel;
            sendToReactor(`COMMAND:${command.slice(1)}:${username}:${message}:${args}:${channel.replace('#','')}`);
            return;
        }

        // !car
        if (command === '!car') {
            if (guestDefaults['!car'] === false) return;
            const sub = args.split(' ')[0] || '';
            const cd = guestDefaults['!car_sub_' + sub] ?? guestDefaults['!car_cd'] ?? 5;
            if (isOnCooldown(username, '!car:' + sub, cd)) return;
            setCooldown(username, '!car:' + sub);
            lastCommandChannel = channel;
            sendToReactor(`COMMAND:car:${username}:${message}:${args}:${channel.replace('#','')}`);
            return;
        }

        // !so
        if (msgLower.startsWith('!so ') || msgLower.startsWith('!shoutout ')) {
            if (guestDefaults['!so'] === false) return;
            if (isOnCooldown(username, '!so', guestDefaults['!so_cd'] ?? 5)) return;
            setCooldown(username, '!so');
            const target = msgLower.split(' ')[1];
            client.say(channel, `🔥 Go check out ${target} over at twitch.tv/${target} !`);
            return;
        }

        return; // ignore everything else in guest channels
    }

    // ── Everything below is home channel only ────────────────────────────────

    // Forward to dashboard chat stream
    const chatMsg = JSON.stringify({
        username: tags['display-name'] || tags.username || '',
        message,
        color: tags.color || '#d0f0ff',
        badges: tags.badges || {},
        isMod: tags.mod || false,
        isSub: tags.subscriber || false,
        ts: Date.now()
    });
    process.stdout.write('CHAT_MSG:' + chatMsg + '\n');

    const commands = getCommands();
    const actions = getActions();
    const defaults = getDefaults();

    // Text commands (custom)
    if (commands[command]) {
        const c = commands[command];
        if (c.enabled === false) return;
        const cd = c.cooldown ?? 5;
        if (isOnCooldown(username, command, cd)) return;
        setCooldown(username, command);
        client.say(channel, c.response);
        return;
    }

    // C++ Actions
    const actionKey = command.startsWith('!') ? command.slice(1) : null;
    if (actionKey && actions[actionKey]) {
        const a = actions[actionKey];
        if (a.enabled === false) return;
        const cd = a.cooldown ?? 5;
        if (isOnCooldown(username, command, cd)) return;
        setCooldown(username, command);
        lastCommandChannel = channel;
        sendToReactor(`COMMAND:${actionKey}:${username}:${message}:${args}:${config.channel}`);
        return;
    }

    // !bank / !gamble
    if (command === '!bank' || command === '!gamble') {
        if (defaults[command] === false) return;
        const sub = args.split(' ')[0] || '';
        const cdKey = sub ? (command + '_sub_' + sub) : (command + '_cd');
        const cd = defaults[cdKey] ?? defaults[command + '_cd'] ?? 5;
        if (isOnCooldown(username, command + ':' + sub, cd)) return;
        setCooldown(username, command + ':' + sub);
        lastCommandChannel = channel;
        sendToReactor(`COMMAND:${command.slice(1)}:${username}:${message}:${args}:${config.channel}`);
        return;
    }

    // !car
    if (command === '!car') {
        if (defaults['!car'] === false) return;
        const sub = args.split(' ')[0] || '';
        const cdKey = sub ? ('!car_sub_' + sub) : '!car_cd';
        const cd = defaults[cdKey] ?? defaults['!car_cd'] ?? 5;
        if (isOnCooldown(username, '!car:' + sub, cd)) return;
        setCooldown(username, '!car:' + sub);
        lastCommandChannel = channel;
        sendToReactor(`COMMAND:car:${username}:${message}:${args}:${config.channel}`);
        return;
    }

    // !alerts
    const alertsFilePath = path.join(dataDir, 'alerts.json');
    if (fs.existsSync(alertsFilePath)) {
        let alertsData = {};
        try { alertsData = JSON.parse(fs.readFileSync(alertsFilePath, 'utf8')); } catch(e) {}
        const alertKey = command.slice(1);
        if (alertsData[alertKey] && alertsData[alertKey].enabled !== false) {
            const a = alertsData[alertKey];
            if (defaults['!alerts'] === false) return;
            const access = a.access || 'moderator';
            const isMod = tags.mod || false;
            const isBroadcaster = username === homeChannel;
            const isSub = tags.subscriber || false;
            if (access === 'moderator' && !isMod && !isBroadcaster) return;
            if (access === 'subscriber' && !isSub && !isMod && !isBroadcaster) return;
            const cd = defaults['!alerts_cd'] ?? 10;
            if (isOnCooldown(username, '!alert:' + alertKey, cd)) return;
            setCooldown(username, '!alert:' + alertKey);
            const http = require('http');
            const options = { hostname: '127.0.0.1', port: 3000, path: '/api/alerts/trigger/' + alertKey, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 0 } };
            const req2 = http.request(options, () => {});
            req2.on('error', () => {});
            req2.end();
            return;
        }
    }

    // !so
    if (msgLower.startsWith('!so ') || msgLower.startsWith('!shoutout ')) {
        if (defaults['!so'] === false) return;
        const cd = defaults['!so_cd'] ?? 5;
        if (isOnCooldown(username, '!so', cd)) return;
        setCooldown(username, '!so');
        const target = msgLower.split(' ')[1];
        client.say(channel, `🔥 Go check out ${target} over at twitch.tv/${target} !`);
        return;
    }

    // !commands
    if (msgLower === '!commands') {
        if (defaults['!commands'] === false) return;
        const cd = defaults['!commands_cd'] ?? 30;
        if (isOnCooldown(username, '!commands', cd)) return;
        setCooldown(username, '!commands');
        client.say(channel, 'Commands: ' + buildCommandsList());
        return;
    }
});

// ---- Guest channel control server on port 9003 (dashboard → bot) ----
const guestControlServer = net.createServer({ allowHalfOpen: true }, (socket) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
        const msg = data.trim();
        if (msg === 'LIST') {
            socket.write(JSON.stringify([...guestChannels]));
            socket.end();
        } else if (msg.startsWith('JOIN:')) {
            const target = msg.slice(5).toLowerCase().replace('#', '');
            const homeChannel = config.channel.replace('#', '').toLowerCase();
            if (target === homeChannel) {
                socket.write(JSON.stringify({ success: false, error: 'Already home channel' }));
                socket.end();
                return;
            }
            if (guestChannels.has(target)) {
                socket.write(JSON.stringify({ success: false, error: 'Already in #' + target }));
                socket.end();
                return;
            }
            client.join(target).then(() => {
                guestChannels.add(target);
                saveGuestChannelsToFile();
                socket.write(JSON.stringify({ success: true }));
                socket.end();
            }).catch((err) => {
                socket.write(JSON.stringify({ success: false, error: 'Failed to join: ' + err }));
                socket.end();
            });
        } else if (msg.startsWith('LEAVE:')) {
            const target = msg.slice(6).toLowerCase().replace('#', '');
            if (!guestChannels.has(target)) {
                socket.write(JSON.stringify({ success: false, error: 'Not in #' + target }));
                socket.end();
                return;
            }
            client.part(target).then(() => {
                guestChannels.delete(target);
                saveGuestChannelsToFile();
                socket.write(JSON.stringify({ success: true }));
                socket.end();
            }).catch(() => {
                guestChannels.delete(target);
                saveGuestChannelsToFile();
                socket.write(JSON.stringify({ success: true }));
                socket.end();
            });
        } else {
            socket.write(JSON.stringify({ success: false, error: 'Unknown command' }));
            socket.end();
        }
    });
    socket.on('error', () => {});
});

guestControlServer.listen(9003, '127.0.0.1', () => {
    console.log('Guest channel control running on port 9003');
});

console.log('ChatCommander is running...');