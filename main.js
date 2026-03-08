const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
let mainWindow;
let botProcess = null;
let reactorProcess = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function getDataPath(file) {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, file);
    if (!fs.existsSync(filePath)) {
        const defaultPath = path.join(__dirname, file);
        if (fs.existsSync(defaultPath)) {
            fs.copyFileSync(defaultPath, filePath);
        }
    }
    return filePath;
}

function startReactor() {
    const reactorPath = app.isPackaged
        ? path.join(process.resourcesPath, 'reactor.exe')
        : path.join(__dirname, 'reactor.exe');

    if (!fs.existsSync(reactorPath)) {
        console.log('reactor.exe not found at:', reactorPath);
        return;
    }

    reactorProcess = spawn(reactorPath, [], {
    cwd: path.dirname(reactorPath),
    env: {
        ...process.env,
        CHATCOMMANDER_DATA_PATH: app.getPath('userData')
    },
    stdio: 'pipe'
});

    reactorProcess.stdout.on('data', (data) => {
        console.log('[reactor]', data.toString().trim());
    });

    reactorProcess.stderr.on('data', (data) => {
        console.error('[reactor error]', data.toString().trim());
    });

    reactorProcess.on('exit', (code) => {
        console.log('[reactor] exited with code', code);
        reactorProcess = null;
    });

    console.log('Reactor started.');
}

function startBot() {
    console.log('startBot called');
    const botPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'index.js')
        : path.join(__dirname, 'index.js');

    const userDataPath = app.getPath('userData');

    getDataPath('config.json');
    getDataPath('commands.json');

    const config = JSON.parse(fs.readFileSync(path.join(userDataPath, 'config.json'), 'utf8'));
    console.log('Config at startBot:', JSON.stringify(config));
    if (!config.setupComplete) {
        console.log('Setup not complete, bot will not start yet.');
        return;
    }

    botProcess = spawn(process.execPath, [botPath], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            CHATCOMMANDER_DATA_PATH: userDataPath
        },
        stdio: 'pipe'
    });

    // ── SECTION: BOT_STDOUT_BUFFER ───────────────────────────────────────────
    let botStdoutBuf = '';
    botProcess.stdout.on('data', (data) => {
        botStdoutBuf += data.toString();
        let nl;
        while ((nl = botStdoutBuf.indexOf('\n')) !== -1) {
            const line = botStdoutBuf.slice(0, nl).trim();
            botStdoutBuf = botStdoutBuf.slice(nl + 1);
            if (!line) continue;
            if (line.startsWith('CHAT_MSG:')) {
                try {
                    const parsed = JSON.parse(line.slice(9));
                    if (global.broadcastChat) global.broadcastChat(parsed);
                } catch (e) {}
            } else {
                console.log('[bot]', line);
            }
        }
    });

    botProcess.stderr.on('data', (data) => {
        console.error('[bot error]', data.toString().trim());
    });

    botProcess.on('exit', (code) => {
        console.log('[bot] exited with code', code);
        fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'),
            `BOT EXIT: code=${code} at ${new Date().toISOString()}\n`);
        botProcess = null;
    });

    console.log('Bot started.');
}

function startServer(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI) {
    const express = require('express');
    const axios = require('axios');
    const net = require('net');
    const appDir = __dirname;

    const server = express();
    server.use(express.json({ limit: '10mb' }));

    server.get('/test', (req, res) => res.send('working'));

    server.get('/', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        if (!config.setupComplete || !config.loggedIn) {
            res.redirect('/setup');
        } else {
            res.sendFile(path.join(appDir, 'dashboard/index.html'));
        }
    });

    server.get('/setup', (req, res) => {
        res.sendFile(path.join(appDir, 'setup.html'));
    });

    // ---- AUTH ----
    // Streamer signs in with their main Twitch account
    server.get('/auth/streamer', (req, res) => {
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit+user:read:email&state=streamer`;
        res.redirect(url);
    });

    // Bot account OAuth (separate account flow)
    server.get('/auth/bot', (req, res) => {
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit&state=bot`;
        res.redirect(url);
    });

    // Keep old /auth/twitch working just in case
    server.get('/auth/twitch', (req, res) => {
        res.redirect('/auth/streamer');
    });

    server.get('/auth/callback', async (req, res) => {
        const code = req.query.code;
        const state = req.query.state || 'bot'; // 'streamer' or 'bot'
        fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'),
            `AUTH CALLBACK: state=${state} code=${code}\n`);
        try {
            const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
                params: {
                    client_id: TWITCH_CLIENT_ID,
                    client_secret: TWITCH_CLIENT_SECRET,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: TWITCH_REDIRECT_URI
                }
            });
            const accessToken = response.data.access_token;
            const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': TWITCH_CLIENT_ID
                }
            });
            const twitchUser = userResponse.data.data[0];
            const username = twitchUser.login;
            const displayName = twitchUser.display_name;
            const avatar = twitchUser.profile_image_url;

            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));

            if (state === 'streamer') {
                // This is the streamer logging in with their main account
                config.streamerUsername = username;
                config.streamerDisplayName = displayName;
                config.streamerAvatar = avatar;
                config.streamerToken = `oauth:${accessToken}`;
                config.loggedIn = true;

                // If no separate bot account yet, default bot to main account
                if (!config.botUsername) {
                    config.botUsername = username;
                    config.token = `oauth:${accessToken}`;
                    config.usingMainAccount = true;
                }

                fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));

                if (config.setupComplete) {
                    res.redirect('/');
                } else {
                    res.redirect('/setup?streamer_authed=true');
                }
            } else {
                // This is the bot account being authorized
                config.botUsername = username;
                config.token = `oauth:${accessToken}`;
                config.usingMainAccount = false;
                fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
                res.redirect('/setup?bot_authed=true');
            }
        } catch (err) {
            fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'),
                `AUTH ERROR: ${err.message}\n`);
            console.error(err);
            res.send('Authentication failed. Please try again.');
        }
    });

    // Use main account as bot (skip separate bot auth)
    server.post('/api/setup-bot-main', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.botUsername = config.streamerUsername;
        config.token = config.streamerToken;
        config.usingMainAccount = true;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });

    // Save channel and complete setup
    server.post('/api/setup-channel', (req, res) => {
        const { channel } = req.body;
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.channel = channel;
        config.setupComplete = true;
        config.loggedIn = true;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        if (!botProcess) setTimeout(startBot, 1000);
        res.json({ success: true });
    });

    // Session — who is logged in
    server.get('/api/session', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        res.json({
            loggedIn: config.loggedIn || false,
            role: config.currentRole || 'streamer',
            streamerUsername: config.streamerUsername || null,
            streamerDisplayName: config.streamerDisplayName || null,
            streamerAvatar: config.streamerAvatar || null,
            botUsername: config.botUsername || null,
            usingMainAccount: config.usingMainAccount || false,
            channel: config.channel || null,
            activeUsername: config.activeUsername || config.streamerUsername || null
        });
    });

    // Switch to admin role (called when admin enters their username)
    server.post('/api/session/switch', (req, res) => {
        const { username } = req.body;
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        const admins = config.admins || [];
        if (username === config.streamerUsername) {
            config.currentRole = 'streamer';
            config.activeUsername = username;
            fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
            return res.json({ success: true, role: 'streamer' });
        }
        if (admins.map(a => a.toLowerCase()).includes(username.toLowerCase())) {
            config.currentRole = 'admin';
            config.activeUsername = username;
            fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
            return res.json({ success: true, role: 'admin' });
        }
        res.json({ success: false, error: 'Not an admin' });
    });

    // Switch back to streamer
    server.post('/api/session/streamer', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.currentRole = 'streamer';
        config.activeUsername = config.streamerUsername;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });

    // ---- MEMORY / ECONOMY ----
    server.get('/api/memory', (req, res) => {
        const p = getDataPath('memory.json');
        if (!fs.existsSync(p)) return res.json({});
        try { res.json(JSON.parse(fs.readFileSync(p, 'utf8'))); }
        catch(e) { res.json({}); }
    });

    server.post('/api/memory/reset-user', (req, res) => {
        const { username } = req.body;
        const p = getDataPath('memory.json');
        if (!fs.existsSync(p)) return res.json({ success: false });
        const mem = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Clear all keys for this user
        Object.keys(mem).forEach(k => {
            if (k.endsWith('_' + username)) delete mem[k];
        });
        fs.writeFileSync(p, JSON.stringify(mem, null, 4));
        res.json({ success: true });
    });

    server.post('/api/memory/unjail', (req, res) => {
        const { username } = req.body;
        const p = getDataPath('memory.json');
        if (!fs.existsSync(p)) return res.json({ success: false });
        const mem = JSON.parse(fs.readFileSync(p, 'utf8'));
        delete mem['jail_' + username];
        delete mem['jailtime_' + username];
        fs.writeFileSync(p, JSON.stringify(mem, null, 4));
        res.json({ success: true });
    });

    server.post('/api/memory/set-balance', (req, res) => {
        const { username, bank, cash } = req.body;
        const p = getDataPath('memory.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
        const mem = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (bank !== undefined) mem['bank_' + username] = String(bank);
        if (cash !== undefined) mem['cash_' + username] = String(cash);
        fs.writeFileSync(p, JSON.stringify(mem, null, 4));
        res.json({ success: true });
    });

    // Logout streamer
    server.post('/api/logout', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.loggedIn = false;
        config.streamerToken = '';
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });

    // Disconnect bot account (revert to main account)
    server.post('/api/logout-bot', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.botUsername = config.streamerUsername;
        config.token = config.streamerToken;
        config.usingMainAccount = true;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });

    // ---- ADMINS ----
    server.get('/api/admins', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        res.json(config.admins || []);
    });

    server.post('/api/admins', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.admins = req.body.admins || [];
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });

    // ---- SETUP ----
    server.post('/api/setup', (req, res) => {
        const { botUsername, token, channel, setupComplete } = req.body;
        const config = { botUsername, token, channel, setupComplete };
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        if (setupComplete && !botProcess) {
            setTimeout(startBot, 1000);
        }
        res.json({ success: true });
    });

    server.get('/api/config', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        res.json(config);
    });

    // ---- OBS SETTINGS ----
    server.get('/api/obs-settings', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        res.json({
            obsHost: config.obsHost || 'localhost',
            obsPort: config.obsPort || '4455',
            obsPassword: config.obsPassword || '',
            obsAutoConnect: config.obsAutoConnect || false
        });
    });

    server.post('/api/obs-settings', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.obsHost = req.body.obsHost || 'localhost';
        config.obsPort = req.body.obsPort || '4455';
        config.obsPassword = req.body.obsPassword || '';
        config.obsAutoConnect = true;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });

    // ---- COMMANDS ----
    server.get('/api/commands', (req, res) => {
        const commands = JSON.parse(fs.readFileSync(getDataPath('commands.json'), 'utf8'));
        res.json(commands);
    });

    server.post('/api/commands', (req, res) => {
        const { command, response, cooldown, access, enabled } = req.body;
        const commands = JSON.parse(fs.readFileSync(getDataPath('commands.json'), 'utf8'));
        commands[command] = {
            response,
            cooldown: cooldown ?? commands[command]?.cooldown ?? 5,
            access: access ?? commands[command]?.access ?? 'everyone',
            enabled: enabled !== undefined ? enabled : (commands[command]?.enabled !== false)
        };
        fs.writeFileSync(getDataPath('commands.json'), JSON.stringify(commands, null, 4));
        res.json({ success: true });
    });

    server.delete('/api/commands/:command', (req, res) => {
        const command = decodeURIComponent(req.params.command);
        const commands = JSON.parse(fs.readFileSync(getDataPath('commands.json'), 'utf8'));
        delete commands[command];
        fs.writeFileSync(getDataPath('commands.json'), JSON.stringify(commands, null, 4));
        res.json({ success: true });
    });

    // ---- DEFAULTS ----
    server.get('/api/defaults', (req, res) => {
        const p = getDataPath('defaults.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
        res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    });

    server.post('/api/defaults', (req, res) => {
        const p = getDataPath('defaults.json');
        fs.writeFileSync(p, JSON.stringify(req.body, null, 4));
        res.json({ success: true });
    });

    // ---- BOT STATUS ----
    server.get('/api/bot-status', (req, res) => {
        res.json({ running: botProcess !== null });
    });

    server.post('/api/bot-start', (req, res) => {
        if (botProcess) return res.json({ success: false, message: 'Bot already running' });
        startBot();
        res.json({ success: true });
    });

    server.post('/api/bot-stop', (req, res) => {
        if (botProcess) {
            botProcess.kill();
            botProcess = null;
        }
        res.json({ success: true });
    });

    // ---- ACTIONS ----
    server.get('/api/actions', (req, res) => {
        const p = getDataPath('actions.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
        res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    });

    server.post('/api/actions/compile', (req, res) => {
        const { name, code } = req.body;
        const socket = new net.Socket();
        let result = '';
        socket.connect(9000, '127.0.0.1', () => {
            socket.write(`COMPILE:${name}:${code}`);
        });
        socket.on('data', (data) => { result += data.toString(); });
        socket.on('close', () => {
            const p = getDataPath('actions.json');
            const actions = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (actions[name]) {
                const success = result.includes('COMPILE_RESULT:OK');
                actions[name].compiled = success;
                actions[name].code = code;
                fs.writeFileSync(p, JSON.stringify(actions, null, 4));
                if (success) {
                    res.json({ success: true });
                } else {
                    const err = result.replace('COMPILE_RESULT:', '').replace('COMPILE_ERROR:', '');
                    res.json({ success: false, error: err });
                }
            } else {
                res.json({ success: false, error: 'Action not found' });
            }
        });
        socket.on('error', () => {
            res.json({ success: false, error: 'Reactor not running' });
        });
    });

    server.post('/api/actions/run', (req, res) => {
        const { name, username, message, args } = req.body;
        const socket = new net.Socket();
        socket.connect(9000, '127.0.0.1', () => {
            socket.write(`RUN:${name}:${username}:${message}:${args}`);
            socket.destroy();
        });
        socket.on('error', () => {});
        res.json({ success: true });
    });

    server.post('/api/actions', (req, res) => {
        const { name, trigger, code, compiled } = req.body;
        const p = getDataPath('actions.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
        const actions = JSON.parse(fs.readFileSync(p, 'utf8'));
        actions[name] = { trigger, code, compiled: false };
        fs.writeFileSync(p, JSON.stringify(actions, null, 4));
        res.json({ success: true });
    });

    server.put('/api/actions/:name', (req, res) => {
        const name = decodeURIComponent(req.params.name);
        const p = getDataPath('actions.json');
        const actions = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (actions[name]) {
            if (req.body.code !== undefined)         actions[name].code         = req.body.code;
            if (req.body.enabled !== undefined)      actions[name].enabled      = req.body.enabled;
            if (req.body.cooldown !== undefined)     actions[name].cooldown     = req.body.cooldown;
            if (req.body.access !== undefined)       actions[name].access       = req.body.access;
            if (req.body.subCooldowns !== undefined) actions[name].subCooldowns = req.body.subCooldowns;
        }
        fs.writeFileSync(p, JSON.stringify(actions, null, 4));
        res.json({ success: true });
    });

    server.delete('/api/actions/:name', (req, res) => {
        const name = decodeURIComponent(req.params.name);
        const p = getDataPath('actions.json');
        const actions = JSON.parse(fs.readFileSync(p, 'utf8'));
        delete actions[name];
        fs.writeFileSync(p, JSON.stringify(actions, null, 4));
        res.json({ success: true });
    });

    // ---- GROUPS ----
    server.get('/api/groups', (req, res) => {
        const p = getDataPath('groups.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
        res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    });

    server.post('/api/groups', (req, res) => {
        const { name, actions } = req.body;
        const p = getDataPath('groups.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
        const groups = JSON.parse(fs.readFileSync(p, 'utf8'));
        groups[name] = { actions: actions || [] };
        fs.writeFileSync(p, JSON.stringify(groups, null, 4));
        res.json({ success: true });
    });

    server.put('/api/groups/:name', (req, res) => {
        const name = decodeURIComponent(req.params.name);
        const p = getDataPath('groups.json');
        const groups = JSON.parse(fs.readFileSync(p, 'utf8'));
        groups[name] = req.body;
        fs.writeFileSync(p, JSON.stringify(groups, null, 4));
        res.json({ success: true });
    });

    server.delete('/api/groups/:name', (req, res) => {
        const name = decodeURIComponent(req.params.name);
        const p = getDataPath('groups.json');
        const groups = JSON.parse(fs.readFileSync(p, 'utf8'));
        delete groups[name];
        fs.writeFileSync(p, JSON.stringify(groups, null, 4));
        res.json({ success: true });
    });

    // ---- CHAT STREAM (SSE) ----
    const chatClients = [];

    server.get('/api/chat/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        chatClients.push(res);
        req.on('close', () => {
            const i = chatClients.indexOf(res);
            if (i !== -1) chatClients.splice(i, 1);
        });
    });

    server.post('/api/chat/send', (req, res) => {
        const { message } = req.body;
        if (!message || !botProcess) return res.json({ success: false });
        const net = require('net');
        const socket = new net.Socket();
        socket.connect(9002, '127.0.0.1', () => {
            socket.write(message);
            socket.destroy();
        });
        socket.on('error', () => {});
        res.json({ success: true });
    });

    server.broadcastChat = (data) => {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        chatClients.forEach(client => client.write(payload));
    };

    // ---- STATIC (must be last) ----
    server.use(express.static(path.join(appDir, 'dashboard'), { index: false }));

    server.listen(3000, () => {
        console.log('Server running on port 3000');
        global.broadcastChat = server.broadcastChat;
        if (mainWindow) mainWindow.loadURL('http://localhost:3000');
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        backgroundColor: '#020408',
        title: 'ChatCommander',
        center: true,
        frame: true
    });

    setTimeout(() => {
        if (!mainWindow.webContents.getURL().includes('localhost:3000')) {
            mainWindow.loadURL('http://localhost:3000');
        }
    }, 4000);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    require('dotenv').config({
        path: app.isPackaged
            ? path.join(process.resourcesPath, '.env')
            : path.join(__dirname, '.env')
    });

    fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'),
        `ENV: CLIENT_ID=${process.env.TWITCH_CLIENT_ID} PATH=${path.join(process.resourcesPath, '.env')}\n`);

    const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
    const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
    const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI;

    startServer(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI);
    startReactor();
    startBot();
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();
});

app.on('window-all-closed', () => {
    if (botProcess) botProcess.kill();
    if (reactorProcess) reactorProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});