const tmi = require('tmi.js');
const fs = require('fs');
const net = require('net');
const path = require('path');

const dataDir = process.env.CHATCOMMANDER_DATA_PATH || '.';

function sendToReactor(message) {
    const socket = new net.Socket();
    socket.connect(9000, '127.0.0.1', () => {
        socket.write(message);
        socket.destroy();
    });
    socket.on('error', () => {});
}

function getCommands() {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'commands.json'), 'utf8'));
}

function getActions() {
    const actionsPath = path.join(dataDir, 'actions.json');
    if (!fs.existsSync(actionsPath)) return {};
    return JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
}

const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));

const client = new tmi.Client({
    identity: {
        username: config.botUsername,
        password: config.token
    },
    channels: [config.channel]
});

client.connect().catch(err => {
    console.error('Bot connection failed:', err);
});

// ---- Reply listener on port 9001 ----
const replyServer = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
        const msg = data.trim();
        if (msg) {
            console.log('[bot] Reply from action:', msg);
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
            const user = key.slice(5);
            const current = parseInt(mem[key]) || 0;
            mem[key] = String(current + 50);
            changed = true;
            console.log(`[bank] Hourly bonus +$50 to ${user} (bank: ${mem[key]})`);
        }
    }

    if (changed) {
        fs.writeFileSync(memPath, JSON.stringify(mem, null, 4));
    }
}

// Run 1 minute after bot starts, then every hour
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
            // Echo back to stream as bot message
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

function getDefaults() {
    const p = path.join(dataDir, 'defaults.json');
    if (!fs.existsSync(p)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log('[debug] defaults path:', p, '| bank_cd:', data['!bank_cd']);
        return data;
    } catch(e) { return {}; }
}


// Per-user, per-command cooldown tracker (in-memory)
const cooldownMap = {}; // key: "username:command" → timestamp ms

function isOnCooldown(username, command, cooldownSecs) {
    if (!cooldownSecs || cooldownSecs <= 0) return false;
    const key = username + ':' + command;
    const last = cooldownMap[key] || 0;
    return (Date.now() - last) < cooldownSecs * 1000;
}

function setCooldown(username, command) {
    cooldownMap[username + ':' + command] = Date.now();
}

// ---- Chat handler ----
client.on('message', (channel, tags, message, self) => {
    if (self) return;

    const msg = message.trim().toLowerCase();
    const username = tags['display-name'] || tags.username || '';
    const command = msg.split(' ')[0];
    const args = msg.split(' ').slice(1).join(' ');

    console.log(`${username}: ${message}`);

    // Forward to dashboard chat stream
    const chatMsg = JSON.stringify({
        username,
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

    // ── Text commands (custom) ────────────────────────────────────────────────
    if (commands[command]) {
        const c = commands[command];
        if (c.enabled === false) return;
        const cd = c.cooldown ?? 5;
        if (isOnCooldown(username, command, cd)) return;
        setCooldown(username, command);
        client.say(channel, c.response);
        return;
    }

    // ── C++ Actions ───────────────────────────────────────────────────────────
    const actionKey = command.startsWith('!') ? command.slice(1) : null;
    if (actionKey && actions[actionKey]) {
        const a = actions[actionKey];
        if (a.enabled === false) return;
        const cd = a.cooldown ?? 5;
        if (isOnCooldown(username, command, cd)) return;
        setCooldown(username, command);
        const reactorMsg = `COMMAND:${actionKey}:${username}:${message}:${args}:${config.channel}`;
        sendToReactor(reactorMsg);
        return;
    }

    // ── Built-in defaults ─────────────────────────────────────────────────────

   // !bank / !gamble — routed to reactor
if (command === '!bank' || command === '!gamble') {
    const key = command;
    if (defaults[key] === false) return;
    const cd = defaults[key + '_cd'] ?? 5;
    console.log('[debug] cooldown check:', username, command, cd, cooldownMap[username + ':' + command]);
    if (isOnCooldown(username, command, cd)) return;
    setCooldown(username, command);
    if (actionKey) sendToReactor(`COMMAND:${actionKey}:${username}:${message}:${args}:${config.channel}`);
    return;
}

    // !so
    if (msg.startsWith('!so ') || msg.startsWith('!shoutout ')) {
        if (defaults['!so'] === false) return;
        const cd = defaults['!so_cd'] ?? 5;
        if (isOnCooldown(username, '!so', cd)) return;
        setCooldown(username, '!so');
        const target = msg.split(' ')[1];
        client.say(channel, `🔥 Go check out ${target} over at twitch.tv/${target} !`);
        return;
    }

    // !commands
    if (msg === '!commands') {
        if (defaults['!commands'] === false) return;
        const cd = defaults['!commands_cd'] ?? 30;
        if (isOnCooldown(username, '!commands', cd)) return;
        setCooldown(username, '!commands');
        const allCommands = [
            ...Object.entries(commands).filter(([,v]) => v.enabled !== false).map(([k]) => k),
            ...Object.entries(actions).filter(([,v]) => v.enabled !== false).map(([k]) => '!' + k),
            ...(defaults['!so'] !== false ? ['!so'] : []),
            ...(defaults['!commands'] !== false ? ['!commands'] : []),
            ...(defaults['!bank'] !== false ? ['!bank'] : []),
            ...(defaults['!gamble'] !== false ? ['!gamble'] : []),
        ];
        client.say(channel, `Commands: ${[...new Set(allCommands)].join(' | ')}`);
        return;
    }
});

console.log('ChatCommander is running...');