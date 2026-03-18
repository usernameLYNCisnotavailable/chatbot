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

function fireOverlayCommand(command, args, usernameCtx) {
    const http = require('http');
    // Parse and strip :gifname: from args before sending as TTS text
    const parsed = parseGifSyntax(args || '');
    const cleanArgs = parsed.text;
    if (parsed.gifName) fireGifOverlay(parsed.gifName, usernameCtx || '');
    const body = JSON.stringify({ command, args: cleanArgs });
    const options = {
        hostname: '127.0.0.1', port: 3000,
        path: '/api/overlay/fire-command', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(options, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
}

function fireGifOverlay(gifName, username) {
    const http = require('http');
    const body = JSON.stringify({ gifName, username });
    const options = {
        hostname: '127.0.0.1', port: 3000,
        path: '/api/gif-library/fire', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(options, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
}

// Parse :gifname: tokens out of a message, return { text, gifName }
function parseGifSyntax(msg) {
    const match = msg.match(/:([a-zA-Z0-9_-]+):/);
    if (!match) return { text: msg, gifName: null };
    const gifName = match[1].toLowerCase();
    const text = msg.replace(match[0], '').replace(/\s+/g, ' ').trim();
    return { text, gifName };
}

function getCommands() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'commands.json'), 'utf8')); }
    catch(e) { return {}; }
}

function getAutomod() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'automod.json'), 'utf8')); }
    catch(e) { return null; }
}

const spamTracker = {};

function automodCheck(channel, username, message, tags, homeChannel) {
    const cfg = getAutomod();
    if (!cfg || !cfg.enabled) return false;
    const isMod = tags.mod || false;
    const isBroadcaster = username.toLowerCase() === homeChannel.toLowerCase();
    const isSub = tags.subscriber || false;
    if (isMod || isBroadcaster) return false;
    if (cfg.exemptSubs && isSub) return false;

    function doAction(action, duration, reason) {
        const ch = channel.startsWith('#') ? channel : '#' + channel;
        client.say(ch, `/timeout ${username} 1`).catch(() => {});
        if (action === 'timeout' && duration > 1) {
            setTimeout(() => client.say(ch, `/timeout ${username} ${duration}`).catch(() => {}), 200);
        }
        if (action === 'ban') {
            setTimeout(() => client.say(ch, `/ban ${username}`).catch(() => {}), 200);
        }
        if (cfg.warnings && cfg.warnings.enabled && (action === 'warn' || action === 'delete')) {
            client.say(ch, `@${username} ⚠️ ${reason}`).catch(() => {});
        }
        return true;
    }

    if (cfg.bannedWords && cfg.bannedWords.length) {
        const msgLower = message.toLowerCase();
        const hit = cfg.bannedWords.find(w => w && msgLower.includes(w.toLowerCase()));
        if (hit) return doAction(cfg.bannedWords_action || 'timeout', cfg.bannedWords_duration || 300, 'That word is not allowed here.');
    }

    if (cfg.caps && cfg.caps.enabled) {
        const letters = message.replace(/[^a-zA-Z]/g, '');
        if (letters.length >= (cfg.caps.minLength || 10)) {
            const capsCount = (message.match(/[A-Z]/g) || []).length;
            if ((capsCount / letters.length) * 100 >= (cfg.caps.threshold || 70)) {
                return doAction(cfg.caps.action || 'warn', cfg.caps.duration || 60, 'Please avoid excessive caps.');
            }
        }
    }

    if (cfg.links && cfg.links.enabled) {
        if (!(cfg.links.allowSubs && isSub)) {
            if (/https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|net|org|io|tv|gg|me|co|uk|de|fr|ru|ly|to|sh)/i.test(message)) {
                return doAction(cfg.links.action || 'delete', cfg.links.duration || 60, 'Links are not allowed. Ask a mod first.');
            }
        }
    }

    if (cfg.spam && cfg.spam.enabled) {
        const now = Date.now();
        const window = (cfg.spam.seconds || 3) * 1000;
        const limit = cfg.spam.messages || 5;
        if (!spamTracker[username]) spamTracker[username] = [];
        spamTracker[username] = spamTracker[username].filter(t => now - t < window);
        spamTracker[username].push(now);
        if (spamTracker[username].length >= limit) {
            spamTracker[username] = [];
            return doAction(cfg.spam.action || 'timeout', cfg.spam.duration || 300, 'Please slow down!');
        }
    }

    return false;
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
}).catch(() => {});

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

replyServer.listen(9001, '127.0.0.1');

// ---- Auto $50/hr bank bonus ----
function giveHourlyBonus() {
    const memPath = path.join(dataDir, 'memory.json');
    if (!fs.existsSync(memPath)) return;
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync(memPath, 'utf8')); } catch(e) { return; }
    let changed = false;
    for (const user of activeUsers) {
        const key = 'bank_' + user;
        if (key in mem) {
            const current = parseInt(mem[key]) || 0;
            mem[key] = String(current + 50);
            changed = true;
        }
    }
    activeUsers.clear();
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

sendServer.listen(9002, '127.0.0.1');

// Users who have spoken since the last hourly bonus tick
const activeUsers = new Set();

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
    activeUsers.add((tags['display-name'] || tags.username || '').toLowerCase());
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
            fireOverlayCommand(command, args, username);
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
            fireOverlayCommand(command, args, username);
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
            fireOverlayCommand(command, args, username);
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
            fireOverlayCommand(command, args, username);
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

    const homeChannelForMod = config.channel.replace('#', '').toLowerCase();
    if (automodCheck(channel, username, message, tags, homeChannelForMod)) return;

    const commands = getCommands();
    const actions = getActions();
    const defaults = getDefaults();

    // ── !requestgif <url> <name> ─────────────────────────────────────────────
    if (command === '!requestgif') {
        const parts = args.trim().split(' ');
        const url = parts[0];
        const suggestedName = parts.slice(1).join(' ').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!url || !suggestedName) { client.say(channel, `@${username} Usage: !requestgif <url> <name>  e.g. !requestgif https://... hype`); return; }
        if (!url.startsWith('http')) { client.say(channel, `@${username} Please provide a valid URL.`); return; }
        const http2 = require('http');
        const body2 = JSON.stringify({ url, suggestedName, requestedBy: username });
        const opts2 = { hostname:'127.0.0.1', port:3000, path:'/api/gif-library/request', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body2)} };
        const req2 = http2.request(opts2, (res2) => {
            let d = ''; res2.on('data', c2 => d += c2); res2.on('end', () => {
                try { const j = JSON.parse(d); if (j.ok) client.say(channel, `@${username} GIF request submitted! A mod will review it.`); else client.say(channel, `@${username} ${j.error || 'Failed to submit request.'}`); } catch(e) {}
            });
        });
        req2.on('error', () => {}); req2.write(body2); req2.end();
        return;
    }

    // ── !removegif <name> ────────────────────────────────────────────────────
    if (command === '!removegif') {
        const isMod = tags.mod || tags.badges?.broadcaster || tags.badges?.moderator;
        if (!isMod) { client.say(channel, `@${username} Only mods can remove GIFs.`); return; }
        const gifName2 = args.trim().toLowerCase();
        if (!gifName2) { client.say(channel, `@${username} Usage: !removegif <name>`); return; }
        const http3 = require('http');
        const body3 = JSON.stringify({ name: gifName2 });
        const opts3 = { hostname:'127.0.0.1', port:3000, path:'/api/gif-library/remove', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body3)} };
        const req3 = http3.request(opts3, (res3) => {
            let d = ''; res3.on('data', c3 => d += c3); res3.on('end', () => {
                try { const j = JSON.parse(d); client.say(channel, `@${username} ${j.ok ? `GIF "${gifName2}" removed.` : (j.error || 'Not found.')}`); } catch(e) {}
            });
        });
        req3.on('error', () => {}); req3.write(body3); req3.end();
        return;
    }

    // Text commands (custom)
    if (commands[command]) {
        const c = commands[command];
        if (c.enabled === false) return;
        const cd = c.cooldown ?? 5;
        if (isOnCooldown(username, command, cd)) return;
        setCooldown(username, command);
        client.say(channel, c.response);
        fireOverlayCommand(command, args, username);
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
        fireOverlayCommand(command, args, username);
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
        fireOverlayCommand(command, args, username);
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
        fireOverlayCommand(command, args, username);
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

    // ---- SONG REQUESTS ----
    async function searchYouTube(query) {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%3D%3D';
            const opts = {
                hostname: 'www.youtube.com',
                path: '/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%3D%3D',
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 8000
            };
            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    const patterns = [
                        /"videoId":"([A-Za-z0-9_-]{11})"/,
                        /watch\?v=([A-Za-z0-9_-]{11})/
                    ];
                    for (const pat of patterns) {
                        const m = data.match(pat);
                        if (m) return resolve(m[1]);
                    }
                    reject(new Error('No results found'));
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });
    }

    // !sr — search by name or queue by URL
    if (command === '!sr') {
        if (defaults['!sr'] === false) return;
        const query = args.trim();
        if (!query) { client.say(channel, `@${username} Usage: !sr <song name or youtube url>`); return; }
        const urlMatch = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
        (async () => {
            try {
                const videoId = urlMatch ? urlMatch[1] : await searchYouTube(query);
                const http = require('http');
                const body = JSON.stringify({ videoId, requester: username });
                const req2 = http.request({
                    hostname: '127.0.0.1', port: 3000, path: '/api/songs/queue', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, (resp) => {
                    let data = '';
                    resp.on('data', d => data += d);
                    resp.on('end', () => {
                        try {
                            const d = JSON.parse(data);
                            if (d.ok) {
                                if (d.position === 0) client.say(channel, `🎵 Now playing: ${d.title} (requested by @${username})`);
                                else client.say(channel, `🎵 Added to queue at #${d.position}: ${d.title} (by @${username})`);
                            } else { client.say(channel, `@${username} Couldn't add that song.`); }
                        } catch(e) {}
                    });
                });
                req2.on('error', () => client.say(channel, `@${username} Failed to add song.`));
                req2.write(body); req2.end();
            } catch(e) {
                process.stdout.write('[sr error] ' + e.message + '\n');
                client.say(channel, `@${username} Couldn't find "${query.slice(0, 40)}" — try a YouTube URL instead.`);
            }
        })();
        return;
    }

    // !skip
    if (command === '!skip') {
        if (!tags.mod && username !== homeChannel && !isAdmin(username)) return;
        const http = require('http');
        const req2 = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/songs/skip', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, () => {});
        req2.on('error', () => {}); req2.write('{}'); req2.end();
        client.say(channel, '⏭ Skipped.');
        return;
    }

    // !currentsong / !song
    if (command === '!currentsong' || command === '!song') {
        const http = require('http');
        const req2 = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/songs/queue', method: 'GET' }, (resp) => {
            let data = '';
            resp.on('data', d => data += d);
            resp.on('end', () => {
                try {
                    const d = JSON.parse(data);
                    if (d.current) client.say(channel, `🎵 Now playing: ${d.current.title} (by @${d.current.requester})`);
                    else client.say(channel, 'No song currently playing.');
                } catch(e) {}
            });
        });
        req2.on('error', () => {}); req2.end();
        return;
    }

    // !queue
    if (command === '!queue') {
        const http = require('http');
        const req2 = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/songs/queue', method: 'GET' }, (resp) => {
            let data = '';
            resp.on('data', d => data += d);
            resp.on('end', () => {
                try {
                    const q = JSON.parse(data).queue || [];
                    if (!q.length) client.say(channel, 'Queue is empty — use !sr <song name> to add!');
                    else {
                        const preview = q.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' | ');
                        client.say(channel, `🎵 Up next: ${preview}${q.length > 3 ? ` (+${q.length-3} more)` : ''}`);
                    }
                } catch(e) {}
            });
        });
        req2.on('error', () => {}); req2.end();
        return;
    }

    // !removesong
    if (command === '!removesong') {
        const isMod = tags.mod || false;
        const isBroadcaster = username === homeChannel;
        const http = require('http');
        const req2 = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/songs/queue', method: 'GET' }, (resp) => {
            let data = '';
            resp.on('data', d => data += d);
            resp.on('end', () => {
                try {
                    const q = JSON.parse(data).queue || [];
                    let idx = -1;
                    if ((isMod || isBroadcaster || isAdmin(username)) && args.trim()) {
                        const pos = parseInt(args.trim()) - 1;
                        if (pos >= 0 && pos < q.length) idx = pos;
                    } else {
                        for (let i = q.length - 1; i >= 0; i--) { if (q[i].requester === username) { idx = i; break; } }
                    }
                    if (idx === -1) { client.say(channel, `@${username} No song found to remove.`); return; }
                    const delReq = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/songs/queue/' + idx, method: 'DELETE' }, () => {});
                    delReq.on('error', () => {}); delReq.end();
                    client.say(channel, `@${username} Removed from queue.`);
                } catch(e) {}
            });
        });
        req2.on('error', () => {}); req2.end();
        return;
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

guestControlServer.listen(9003, '127.0.0.1');