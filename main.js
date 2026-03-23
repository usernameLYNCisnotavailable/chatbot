const { app, BrowserWindow, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { encryptToken, decryptToken, generateSessionToken, apiAuthMiddleware, registerSecurityRoutes } = require('./security');
const { registerSystemRoutes } = require('./system-commands');
const { registerPresetRoutes } = require('./presets');
let mainWindow;
let botProcess = null;
let reactorProcess = null;
let chatWin = null;
let modWin = null;
let overlayProcess = null;
let videoWin = null;
let videoWinMode = 'desktop';
let videoOverlayClients = []; // SSE clients
let videoPositions = {}; // id -> {x,y,w,h}
let textWin = null;
let textWinMode = 'desktop';
let textOverlayClients = []; // SSE clients
let songWin = null;
let songQueue = [];
let songCurrent = null;

app.commandLine.appendSwitch('max-connections-per-host', '20');

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

function getUserDataPath() {
    const base = app.getPath('userData');
    const flatConfig = path.join(base, 'config.json');
    try {
        if (fs.existsSync(flatConfig)) {
            const cfg = JSON.parse(fs.readFileSync(flatConfig, 'utf8'));
            const username = (cfg.streamerUsername || cfg.channel || '').replace('#', '').toLowerCase();
            if (username) {
                const userDir = path.join(base, username);
                if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
                return userDir;
            }
        }
    } catch(e) {}
    return base;
}

function getDataPath(file) {
    const userDataPath = getUserDataPath();
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
        ? path.join(process.resourcesPath, 'app.asar', 'reactor.js')
        : path.join(__dirname, 'reactor.js');

    if (!fs.existsSync(reactorPath)) {
        console.log('reactor.js not found at:', reactorPath);
        return;
    }

    reactorProcess = spawn(process.execPath, [reactorPath], {
    cwd: path.dirname(reactorPath),
    env: {
        ...process.env,
        CHATCOMMANDER_DATA_PATH: getUserDataPath(),
        ELECTRON_RUN_AS_NODE: '1',
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

        const decryptedToken = decryptToken(config.token || '', userDataPath);
    const decryptedStreamerToken = decryptToken(config.streamerToken || '', userDataPath);
    botProcess = spawn(process.execPath, [botPath], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            CHATCOMMANDER_DATA_PATH: userDataPath,
            CC_BOT_TOKEN: decryptedToken,
            CC_STREAMER_TOKEN: decryptedStreamerToken
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
        const msg = data.toString().trim();
        console.error('[bot error]', msg);
        if (msg.includes('Login authentication failed') || msg.includes('authentication failed')) {
            console.log('[bot] token invalid, clearing and triggering re-auth');
            try {
                const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
                cfg.streamerToken = ''; cfg.token = ''; cfg.loggedIn = false; cfg.setupComplete = false;
                fs.writeFileSync(getDataPath('config.json'), JSON.stringify(cfg, null, 4));
            } catch(e) {}
            if (botProcess) { botProcess.kill(); botProcess = null; }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('http://localhost:3000/setup');
        }
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

    // ── SECURITY ──────────────────────────────────────────────────────────────
    generateSessionToken();
    registerSecurityRoutes(server);
    server.use(apiAuthMiddleware);

    server.get('/test', (req, res) => res.send('working'));

    server.get('/dashboard/home.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'home.html'));
    });

    server.get('/dashboard/presets.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'presets.html'));
    });

    server.get('/dashboard/giveaway.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'giveaway.html'));
    });

    server.get('/dashboard/home.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'home.html'));
    });

    server.get('/', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        if (!config.setupComplete || !config.loggedIn) {
            res.redirect('/setup');
        } else if (!config.onboardingComplete) {
            res.sendFile(path.join(appDir, 'dashboard/onboarding.html'));
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
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit+user:read:email+moderation:read+user:read:moderated_channels+channel:read:subscriptions+bits:read+channel:read:redemptions+channel:read:hype_train+moderator:read:followers&state=streamer&force_verify=true`;
        shell.openExternal(url);
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#0a0a0a;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}h2{margin:0;font-size:1.1rem;}p{margin:0;color:rgba(255,255,255,0.4);font-size:0.75rem;text-align:center;}</style></head><body><h2>🌐 Opening in your browser...</h2><p>Sign in with Twitch in the browser window that just opened.<br>This page will update automatically when done.</p><script>const check=setInterval(async()=>{const cfg=await fetch('/api/config').then(r=>r.json()).catch(()=>({}));if(cfg.streamerUsername){clearInterval(check);window.location.replace('/setup?streamer_authed=true');}},1500);</script></body></html>`);
    });

    // Bot account OAuth — external browser, user must click 'Not you?' to switch accounts
    server.get('/auth/bot', (req, res) => {
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit&state=bot&force_verify=true`;
        shell.openExternal(url);
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#0a0a0a;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}h2{margin:0;font-size:1.1rem;}p{margin:0;color:rgba(255,255,255,0.4);font-size:0.75rem;text-align:center;}</style></head><body><h2>🌐 Waiting for bot authorization...</h2><p>Log in as your bot account in the browser.<br>This page will redirect automatically when done.</p><script>const t=setInterval(async()=>{const c=await fetch('/api/config').then(r=>r.json()).catch(()=>({}));if(c.botUsername&&c.botUsername!==c.streamerUsername){clearInterval(t);window.location.replace('/setup?bot_authed=true');}},1500);</script></body></html>`);
    });

    // Mod account OAuth
    server.get('/auth/mod', (req, res) => {
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit&state=mod`;
        res.redirect(url);
    });

    // Keep old /auth/twitch working just in case
    server.get('/auth/twitch', (req, res) => {
        res.redirect('/auth/streamer');
    });

    server.get('/auth/callback', async (req, res) => {
        const code = req.query.code;
        const state = req.query.state || 'bot'; // 'streamer', 'bot', or 'mod'
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
                config.streamerToken = encryptToken(`oauth:${accessToken}`, getUserDataPath());
                config.loggedIn = true;

                fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));

                if (botProcess) { botProcess.kill(); botProcess = null; }
                if (config.setupComplete) {
                    setTimeout(startBot, 1000);
                    if (mainWindow) mainWindow.loadURL('http://localhost:3000/');
                } else {
                    if (mainWindow) mainWindow.loadURL('http://localhost:3000/setup?streamer_authed=true');
                }
                res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#0a0a0a;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}h2{margin:0;font-size:1.1rem;}p{margin:0;color:rgba(255,255,255,0.4);font-size:0.75rem;text-align:center;}</style></head><body><h2>✅ Signed in!</h2><p>You can close this tab and go back to the app.</p></body></html>`);
            } else if (state === 'mod') {
                // Verify they are actually a mod in the streamer's channel
                const notModPage = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not a Mod</title><style>body{background:#0a0a0a;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}h2{margin:0;font-size:1.2rem;}p{margin:0;color:rgba(255,255,255,0.4);font-size:0.8rem;text-align:center;}</style></head><body><h2>❌ Not a mod</h2><p>You need to be a mod in ${config.channel || 'the streamer'}'s channel<br>to request bot access.</p></body></html>`;

                try {
                    // Get streamer's broadcaster ID
                    const streamerRes = await axios.get(`https://api.twitch.tv/helix/users?login=${config.channel || config.streamerUsername}`, {
                        headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
                    });
                    const broadcasterId = streamerRes.data.data[0]?.id;
                    const modUserId = twitchUser.id;

                    if (!broadcasterId) { res.send(notModPage); return; }

                    // Check if this user is a mod in that channel
                    // Use the streamer's token for this check as it requires broadcaster scope
                    const streamerToken = (config.streamerToken || '').replace('oauth:', '');
                    const modCheckRes = await axios.get(`https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${broadcasterId}&user_id=${modUserId}`, {
                        headers: { 'Authorization': `Bearer ${streamerToken}`, 'Client-Id': TWITCH_CLIENT_ID }
                    });

                    const isMod = modCheckRes.data.data.length > 0;
                    if (!isMod) { res.send(notModPage); return; }
                } catch (modCheckErr) {
                    // If check fails, deny by default
                    res.send(notModPage); return;
                }

                if (!config.mods) config.mods = [];
                const existing = config.mods.find(m => m.username === username);
                if (existing) {
                    existing.token = encryptToken(`oauth:${accessToken}`, getUserDataPath());
                    existing.displayName = displayName;
                    existing.avatar = avatar;
                } else {
                    config.mods.push({
                        username,
                        displayName,
                        avatar,
                        token: encryptToken(`oauth:${accessToken}`, getUserDataPath()),
                        approved: false,
                        commands: []
                    });
                }
                fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
                res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Request Sent</title><style>body{background:#0a0a0a;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}h2{margin:0;font-size:1.2rem;}p{margin:0;color:rgba(255,255,255,0.4);font-size:0.8rem;}</style></head><body><h2>✅ Request sent!</h2><p>The streamer will approve your request. You can close this tab.</p></body></html>`);
            } else {
                // This is the bot account being authorized
                config.botUsername = username;
                config.token = `oauth:${accessToken}`;
                config.usingMainAccount = false;
                fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
                if (botProcess) { botProcess.kill(); botProcess = null; }
                if (config.setupComplete) setTimeout(startBot, 1000);
                if (mainWindow) mainWindow.loadURL('http://localhost:3000/setup?bot_authed=true');
                // Show a done page in the browser
                res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#0a0a0a;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}h2{margin:0;font-size:1.1rem;}p{margin:0;color:rgba(255,255,255,0.4);font-size:0.75rem;text-align:center;}</style></head><body><h2>✅ Bot account connected!</h2><p>You can close this tab and go back to the app.</p></body></html>`);

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
        if (!config.onboardingComplete) {
            if (mainWindow) mainWindow.loadURL('http://localhost:3000/onboarding');
        }
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
        // Full wipe — clear all auth and restart setup flow
        const fresh = {
            loggedIn: false, setupComplete: false,
            streamerUsername: '', streamerDisplayName: '', streamerAvatar: '',
            streamerToken: '', botUsername: '', token: '',
            usingMainAccount: false, channel: '', admins: []
        };
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(fresh, null, 4));
        if (eventsubWs) { try { eventsubWs.close(); } catch(e) {} eventsubWs = null; }
        eventsubConnected = false; eventsubSessionId = null;
        try { if (global.stopBot) global.stopBot(); } catch(e) {}
        res.json({ success: true });
    });

    // Disconnect bot account only — streamer stays logged in
    server.post('/api/logout-bot', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        config.botUsername = '';
        config.token = '';
        config.usingMainAccount = false;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        try { if (global.stopBot) global.stopBot(); } catch(e) {}
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

    // ---- MODS ----
    server.get('/api/mods', (req, res) => {
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        // Never send tokens to the frontend
        const mods = (config.mods || []).map(m => ({
            username: m.username,
            displayName: m.displayName,
            avatar: m.avatar,
            approved: m.approved,
            commands: m.commands || []
        }));
        res.json(mods);
    });

    server.post('/api/mods/approve', (req, res) => {
        const { username } = req.body;
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        const mod = (config.mods || []).find(m => m.username === username);
        if (!mod) return res.status(404).json({ error: 'Mod not found' });
        mod.approved = true;
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        // Tell bot to join their channel
        const net2 = require('net');
        const s = new net2.Socket();
        s.connect(9003, '127.0.0.1', () => { s.write('JOIN:' + username); s.end(); });
        s.on('data', () => {});
        s.on('end', () => {});
        s.on('error', () => {});
        res.json({ success: true });
    });

    server.post('/api/mods/remove', (req, res) => {
        const { username } = req.body;
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        const mod = (config.mods || []).find(m => m.username === username);
        if (mod && mod.token) {
            const rawToken = mod.token.replace('oauth:', '');
            axios.post(`https://id.twitch.tv/oauth2/revoke?client_id=${TWITCH_CLIENT_ID}&token=${rawToken}`)
                .catch(() => {});
        }
        config.mods = (config.mods || []).filter(m => m.username !== username);
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        // Tell bot to leave their channel
        const net2 = require('net');
        const s = new net2.Socket();
        s.connect(9003, '127.0.0.1', () => { s.write('LEAVE:' + username); s.end(); });
        s.on('data', () => {});
        s.on('end', () => {});
        s.on('error', () => {});
        res.json({ success: true });
    });

    server.post('/api/mods/commands', (req, res) => {
        const { username, commands } = req.body;
        const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
        const mod = (config.mods || []).find(m => m.username === username);
        if (!mod) return res.status(404).json({ error: 'Mod not found' });
        mod.commands = commands || [];
        fs.writeFileSync(getDataPath('config.json'), JSON.stringify(config, null, 4));
        res.json({ success: true });
    });


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


    // ── CLIP COMMAND ──────────────────────────────────────────────────────────────
    server.post('/api/clip', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const token = (config.streamerToken || '').replace('oauth:', '');
            const channel = (config.channel || config.streamerUsername || '').replace('#', '');
            if (!token) return res.json({ ok: false, error: 'Not authenticated' });

            // Get broadcaster ID
            const brRes = await axios.get(`https://api.twitch.tv/helix/users?login=${channel}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            const broadcasterId = brRes.data.data[0]?.id;
            if (!broadcasterId) return res.json({ ok: false, error: 'Could not resolve broadcaster' });

            // Create clip
            const clipRes = await axios.post(
                `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`,
                {},
                { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID } }
            );
            const clipId = clipRes.data.data[0]?.id;
            if (!clipId) return res.json({ ok: false, error: 'Clip creation failed' });

            const clipUrl = `https://clips.twitch.tv/${clipId}`;

            // Get stream info for VOD timestamp offset
            let startedAt = null;
            let vodUrl = `https://www.twitch.tv/${channel}/videos`;
            try {
                const streamRes = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
                });
                const stream = streamRes.data.data[0];
                if (stream) {
                    startedAt = stream.started_at;
                    // Calculate offset from stream start
                    const offsetMs = Date.now() - new Date(startedAt).getTime();
                    const offsetSecs = Math.max(0, Math.floor(offsetMs / 1000) - 30); // 30s buffer
                    const h = Math.floor(offsetSecs / 3600);
                    const m = Math.floor((offsetSecs % 3600) / 60);
                    const s = offsetSecs % 60;
                    const tParam = h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
                    vodUrl = `https://www.twitch.tv/${channel}/videos?t=${tParam}`;
                }
            } catch(e) {}

            // Log the clip
            const clipsPath = getDataPath('clips.json');
            let clips = [];
            try { if (fs.existsSync(clipsPath)) clips = JSON.parse(fs.readFileSync(clipsPath, 'utf8')); } catch(e) {}
            const entry = {
                id: clipId,
                url: clipUrl,
                vodUrl,
                startedAt,
                triggeredAt: new Date().toISOString(),
                triggeredBy: req.body.username || 'unknown',
                offsetLabel: vodUrl.includes('?t=') ? vodUrl.split('?t=')[1] : null
            };
            clips.unshift(entry);
            if (clips.length > 100) clips = clips.slice(0, 100);
            fs.writeFileSync(clipsPath, JSON.stringify(clips, null, 2));

            res.json({ ok: true, clipUrl, vodUrl, entry });
        } catch(e) {
            console.error('[clip]', e.message);
            res.json({ ok: false, error: e.message });
        }
    });

    server.get('/api/clips', (req, res) => {
        try {
            const clipsPath = getDataPath('clips.json');
            if (!fs.existsSync(clipsPath)) return res.json([]);
            res.json(JSON.parse(fs.readFileSync(clipsPath, 'utf8')));
        } catch(e) { res.json([]); }
    });

    server.delete('/api/clips', (req, res) => {
        try {
            fs.writeFileSync(getDataPath('clips.json'), '[]');
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false }); }
    });


    // ── STREAM STATUS ──────────────────────────────────────────────────────────
    server.get('/api/stream-status', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const token = (config.streamerToken || '').replace('oauth:', '');
            const channel = (config.channel || config.streamerUsername || '').replace('#', '');
            if (!token || !channel) return res.json({ live: false, channel });
            const streamsRes = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            const stream = streamsRes.data.data && streamsRes.data.data[0];
            if (!stream) return res.json({ live: false, channel });
            res.json({ live: true, channel, viewers: stream.viewer_count, title: stream.title, game: stream.game_name || '', startedAt: stream.started_at });
        } catch(e) { res.json({ live: false, error: e.message }); }
    });

    // ── CLIP COMMAND ──────────────────────────────────────────────────────────
    server.post('/api/clip', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const token = (config.streamerToken || '').replace('oauth:', '');
            const channel = (config.channel || config.streamerUsername || '').replace('#', '');
            if (!token) return res.json({ ok: false, error: 'Not authenticated' });
            const brRes = await axios.get(`https://api.twitch.tv/helix/users?login=${channel}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            const broadcasterId = brRes.data.data[0]?.id;
            if (!broadcasterId) return res.json({ ok: false, error: 'Could not resolve broadcaster' });
            const clipRes = await axios.post(
                `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`, {},
                { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID } }
            );
            const clipId = clipRes.data.data[0]?.id;
            if (!clipId) return res.json({ ok: false, error: 'Clip creation failed' });
            const clipUrl = `https://clips.twitch.tv/${clipId}`;
            let vodUrl = `https://www.twitch.tv/${channel}/videos`;
            try {
                const streamRes = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
                });
                const stream = streamRes.data.data[0];
                if (stream) {
                    const offsetSecs = Math.max(0, Math.floor((Date.now() - new Date(stream.started_at).getTime()) / 1000) - 30);
                    const h = Math.floor(offsetSecs / 3600), m = Math.floor((offsetSecs % 3600) / 60), s = offsetSecs % 60;
                    vodUrl = `https://www.twitch.tv/${channel}/videos?t=${h > 0 ? h+'h' : ''}${m}m${s}s`;
                }
            } catch(e) {}
            const clipsPath = getDataPath('clips.json');
            let clips = [];
            try { if (fs.existsSync(clipsPath)) clips = JSON.parse(fs.readFileSync(clipsPath, 'utf8')); } catch(e) {}
            const entry = { id: clipId, url: clipUrl, vodUrl, triggeredAt: new Date().toISOString(), triggeredBy: req.body.username || 'unknown', offsetLabel: vodUrl.includes('?t=') ? vodUrl.split('?t=')[1] : null };
            clips.unshift(entry);
            if (clips.length > 100) clips = clips.slice(0, 100);
            fs.writeFileSync(clipsPath, JSON.stringify(clips, null, 2));
            res.json({ ok: true, clipUrl, vodUrl, entry });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.get('/api/clips', (req, res) => {
        try {
            const p = getDataPath('clips.json');
            if (!fs.existsSync(p)) return res.json([]);
            res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch(e) { res.json([]); }
    });

    server.delete('/api/clips', (req, res) => {
        try { fs.writeFileSync(getDataPath('clips.json'), '[]'); res.json({ ok: true }); } catch(e) { res.json({ ok: false }); }
    });

    // ── SYSTEM COMMANDS ──────────────────────────────────────────────────────
    registerSystemRoutes(server, getDataPath);

    // ── PRESET ROUTES ────────────────────────────────────────────────────────
    registerPresetRoutes(server, getDataPath);


    // ── STREAM INFO EDIT ──────────────────────────────────────────────────────
    server.patch('/api/stream-info', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const token = (config.streamerToken || '').replace('oauth:', '');
            const channel = (config.channel || config.streamerUsername || '').replace('#', '');

            // Get broadcaster ID
            const brRes = await axios.get(`https://api.twitch.tv/helix/users?login=${channel}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            const broadcasterId = brRes.data.data[0]?.id;
            if (!broadcasterId) return res.json({ ok: false, error: 'Could not resolve broadcaster' });

            const body = {};
            if (req.body.title !== undefined) body.title = req.body.title;
            if (req.body.gameId !== undefined) body.game_id = req.body.gameId;

            await axios.patch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`, body, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' }
            });
            res.json({ ok: true });
        } catch(e) {
            console.error('[stream-info]', e.message);
            res.json({ ok: false, error: e.message });
        }
    });

    // ── GAME SEARCH ───────────────────────────────────────────────────────────
    server.get('/api/search-games', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const token = (config.streamerToken || '').replace('oauth:', '');
            const q = req.query.q || '';
            if (!q) return res.json([]);
            const r = await axios.get(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(q)}&first=8`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            res.json(r.data.data || []);
        } catch(e) { res.json([]); }
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
            socket.end();
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

    // Open standalone chat window
    server.get('/api/chat/open', (req, res) => {
        if (chatWin && !chatWin.isDestroyed()) {
            chatWin.show();
            chatWin.focus();
            return res.json({ success: true });
        }
        chatWin = new BrowserWindow({
            width: 380,
            height: 620,
            minWidth: 260,
            minHeight: 200,
            frame: false,
            transparent: false,
            alwaysOnTop: true,
            resizable: true,
            skipTaskbar: true,
            title: 'Live Chat',
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        chatWin.loadURL('http://localhost:3000/chat.html');
        chatWin.on('close', (e) => {
            e.preventDefault();
            setImmediate(() => { if (chatWin && !chatWin.isDestroyed()) chatWin.hide(); });
        });
        chatWin.on('closed', () => { chatWin = null; });
        res.json({ success: true });
    });

    server.post('/api/chat/close', (req, res) => {
        if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
        res.json({ success: true });
    });

    server.post('/api/chat/always-on-top', (req, res) => {
        const { value } = req.body;
        if (chatWin && !chatWin.isDestroyed()) chatWin.setAlwaysOnTop(!!value);
        res.json({ success: true });
    });

    // Get channels the streamer is a mod in
    server.get('/api/mod/channels', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const token = (config.streamerToken || '').replace('oauth:', '');
            if (!token) return res.json({ channels: [] });

            // Get streamer's user ID first
            const userRes = await axios.get('https://api.twitch.tv/helix/users', {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            const userId = userRes.data.data[0]?.id;
            if (!userId) return res.json({ channels: [] });

            // Get channels they moderate
            const modRes = await axios.get(`https://api.twitch.tv/helix/moderation/channels?user_id=${userId}&first=100`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
            });
            const channels = modRes.data.data || [];

            // Fetch avatars for each channel
            if (channels.length) {
                const logins = channels.map(c => `login=${c.broadcaster_login}`).join('&');
                const avatarRes = await axios.get(`https://api.twitch.tv/helix/users?${logins}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
                });
                const avatarMap = {};
                (avatarRes.data.data || []).forEach(u => { avatarMap[u.login] = u.profile_image_url; });
                channels.forEach(c => { c.avatar = avatarMap[c.broadcaster_login] || ''; });
            }

            res.json({ channels: channels.map(c => ({
                username: c.broadcaster_login,
                displayName: c.broadcaster_name,
                avatar: c.avatar || ''
            }))});
        } catch (e) {
            res.json({ channels: [], error: e.message });
        }
    });

    // Open Mod View window for a specific channel
    server.get('/api/mod/open', (req, res) => {
        const channel = req.query.channel || '';
        const displayName = req.query.displayName || channel;
        const url = `http://localhost:3000/mod-view.html?channel=${encodeURIComponent(channel)}&displayName=${encodeURIComponent(displayName)}`;

        if (modWin && !modWin.isDestroyed()) {
            modWin.loadURL(url);
            modWin.show();
            modWin.focus();
            return res.json({ success: true });
        }
        modWin = new BrowserWindow({
            width: 1000,
            height: 700,
            minWidth: 700,
            minHeight: 500,
            frame: false,
            transparent: false,
            resizable: true,
            title: `Mod View — ${displayName}`,
            backgroundColor: '#111114',
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        modWin.loadURL(url);
        modWin.on('close', (e) => {
            e.preventDefault();
            setImmediate(() => { if (modWin && !modWin.isDestroyed()) modWin.hide(); });
        });
        modWin.on('closed', () => { modWin = null; });
        res.json({ success: true });
    });

    server.post('/api/mod/close', (req, res) => {
        if (modWin && !modWin.isDestroyed()) modWin.hide();
        res.json({ success: true });
    });

    server.broadcastChat = (data) => {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        chatClients.forEach(client => client.write(payload));
    };
// ---- MEDIA ALERTS ----
    const multer = require('multer');
    const alertsPath = getDataPath('alerts.json');
    const mediaDir = path.join(app.getPath('userData'), 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, mediaDir),
        filename: (req, file, cb) => {
            const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, Date.now() + '_' + safe);
        }
    });
    const upload = multer({ storage });

    function getAlerts() {
        try { return JSON.parse(fs.readFileSync(alertsPath, 'utf8')); } catch(e) { return {}; }
    }
    function saveAlerts(data) {
        fs.writeFileSync(alertsPath, JSON.stringify(data, null, 2));
    }

    // Serve uploaded media files
    server.use('/media', express.static(mediaDir));

    // Serve overlay page
    server.get('/alert-overlay', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'alert-overlay.html'));
    });

    server.get('/chat.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'chat.html'));
    });

    // GET all alerts
    server.get('/api/alerts', (req, res) => {
        res.json(getAlerts());
    });

    // POST create/update alert
    server.post('/api/alerts', upload.fields([{ name: 'image' }, { name: 'sound' }]), (req, res) => {
        const alerts = getAlerts();
        const { name, duration, access, volume } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!key) return res.status(400).json({ error: 'Invalid name' });

        const existing = alerts[key] || {};

        // if new files uploaded, delete old ones
        if (req.files?.image && existing.image) {
            const old = path.join(mediaDir, existing.image);
            if (fs.existsSync(old)) fs.unlinkSync(old);
        }
        if (req.files?.sound && existing.sound) {
            const old = path.join(mediaDir, existing.sound);
            if (fs.existsSync(old)) fs.unlinkSync(old);
        }

        alerts[key] = {
            name: key,
            image:    req.files?.image  ? req.files.image[0].filename  : (existing.image  || null),
            sound:    req.files?.sound  ? req.files.sound[0].filename  : (existing.sound  || null),
            duration: parseFloat(duration) || existing.duration || 5,
            volume:   parseFloat(volume)   || existing.volume   || 1.0,
            access:   access || existing.access || 'moderator',
            enabled:  existing.enabled !== false,
        };
        saveAlerts(alerts);
        res.json({ success: true, alert: alerts[key] });
    });

    // DELETE alert
    server.delete('/api/alerts/:name', (req, res) => {
        const alerts = getAlerts();
        const key = req.params.name;
        if (alerts[key]) {
            // clean up media files
            if (alerts[key].image) { const f = path.join(mediaDir, alerts[key].image); if (fs.existsSync(f)) fs.unlinkSync(f); }
            if (alerts[key].sound) { const f = path.join(mediaDir, alerts[key].sound); if (fs.existsSync(f)) fs.unlinkSync(f); }
            delete alerts[key];
            saveAlerts(alerts);
        }
        res.json({ success: true });
    });

    // TOGGLE alert enabled/disabled
    server.post('/api/alerts/:name/toggle', (req, res) => {
        const alerts = getAlerts();
        const key = req.params.name;
        if (!alerts[key]) return res.status(404).json({ error: 'Not found' });
        alerts[key].enabled = req.body.enabled !== false;
        saveAlerts(alerts);
        res.json({ success: true });
    });

    // SSE stream for overlay
    const alertOverlayClients = [];
    server.get('/api/alert/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        alertOverlayClients.push(res);
        req.on('close', () => {
            const i = alertOverlayClients.indexOf(res);
            if (i !== -1) alertOverlayClients.splice(i, 1);
        });
    });

    // TRIGGER alert — called by index.js when chat command fires
    server.post('/api/alerts/trigger/:name', (req, res) => {
        const alerts = getAlerts();
        const key = req.params.name;
        if (!alerts[key] || alerts[key].enabled === false) return res.json({ success: false });
        const payload = `event: alert\ndata: ${JSON.stringify(alerts[key])}\n\n`;
        alertOverlayClients.forEach(client => client.write(payload));
        res.json({ success: true });
    });

    // ---- GUEST CHANNELS ----
    server.get('/api/guest-channels', (req, res) => {
        const socket = new net.Socket();
        let data = '';
        socket.connect(9003, '127.0.0.1', () => { socket.write('LIST'); socket.end(); });
        socket.on('data', (chunk) => { data += chunk.toString(); });
        socket.on('end', () => { try { res.json(JSON.parse(data)); } catch(e) { res.json([]); } });
        socket.on('error', () => res.json([]));
    });

    server.post('/api/guest-channels/join', (req, res) => {
        const { channel } = req.body;
        if (!channel) return res.json({ success: false, error: 'No channel provided' });
        const socket = new net.Socket();
        let data = '';
        socket.connect(9003, '127.0.0.1', () => { socket.write('JOIN:' + channel); socket.end(); });
        socket.on('data', (chunk) => { data += chunk.toString(); });
        socket.on('end', () => { try { res.json(JSON.parse(data)); } catch(e) { res.json({ success: false, error: 'Bot not responding' }); } });
        socket.on('error', () => res.json({ success: false, error: 'Bot not running' }));
    });

    server.post('/api/guest-channels/leave', (req, res) => {
        const { channel } = req.body;
        if (!channel) return res.json({ success: false, error: 'No channel provided' });
        const socket = new net.Socket();
        let data = '';
        socket.connect(9003, '127.0.0.1', () => { socket.write('LEAVE:' + channel); socket.end(); });
        socket.on('data', (chunk) => { data += chunk.toString(); });
        socket.on('end', () => { try { res.json(JSON.parse(data)); } catch(e) { res.json({ success: false, error: 'Bot not responding' }); } });
        socket.on('error', () => res.json({ success: false, error: 'Bot not running' }));
    });

    // ---- MOD VIEW HTML ----
    server.get('/mod-view.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'mod-view.html'));
    });

    // ---- MOD ACTIONS (timeout / ban / unban / delete) ----
    async function modAction(type, body, config) {
        const token = (config.streamerToken || '').replace('oauth:', '');
        const clientId = TWITCH_CLIENT_ID;
        // Get broadcaster ID
        const brRes = await axios.get(`https://api.twitch.tv/helix/users?login=${config.channel || config.streamerUsername}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
        });
        const broadcasterId = brRes.data.data[0]?.id;
        if (!broadcasterId) throw new Error('Could not resolve broadcaster ID');

        if (type === 'timeout' || type === 'ban') {
            // Get target user ID
            const uRes = await axios.get(`https://api.twitch.tv/helix/users?login=${body.username}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
            });
            const userId = uRes.data.data[0]?.id;
            if (!userId) throw new Error('User not found');
            const payload = { data: { user_id: userId } };
            if (type === 'timeout') payload.data.duration = body.duration || 300;
            return axios.post(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`,
                payload, { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId } });
        }
        if (type === 'unban') {
            const uRes = await axios.get(`https://api.twitch.tv/helix/users?login=${body.username}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
            });
            const userId = uRes.data.data[0]?.id;
            if (!userId) throw new Error('User not found');
            return axios.delete(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}&user_id=${userId}`,
                { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId } });
        }
        if (type === 'delete') {
            return axios.delete(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}&message_id=${body.messageId}`,
                { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId } });
        }
    }

    server.post('/api/mod/timeout', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            await modAction('timeout', req.body, config);
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    });

    server.post('/api/mod/ban', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            await modAction('ban', req.body, config);
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    });

    server.post('/api/mod/unban', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            await modAction('unban', req.body, config);
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    });

    server.post('/api/mod/delete', async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            await modAction('delete', req.body, config);
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    });

    // ---- BANNED WORDS ----
    server.get('/api/banned-words', (req, res) => {
        try {
            const p = getDataPath('banned-words.json');
            const words = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
            res.json({ words });
        } catch { res.json({ words: [] }); }
    });

    server.post('/api/banned-words', (req, res) => {
        try {
            const { word, type } = req.body;
            if (!word) return res.json({ success: false, error: 'No word provided' });
            const p = getDataPath('banned-words.json');
            const words = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
            if (!words.find(w => w.word === word)) words.push({ word, type: type || 'exact' });
            fs.writeFileSync(p, JSON.stringify(words, null, 2));
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    });

    server.delete('/api/banned-words', (req, res) => {
        try {
            const { word } = req.body;
            const p = getDataPath('banned-words.json');
            const words = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
            const filtered = words.filter(w => w.word !== word);
            fs.writeFileSync(p, JSON.stringify(filtered, null, 2));
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    });

    // ---- ROUTES_HOTKEYS ----
    function getHotkeys() {
        try {
            const p = getDataPath('hotkeys.json');
            if (!fs.existsSync(p)) return [];
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch(e) { return []; }
    }

    function saveHotkeys(hotkeys) {
        fs.writeFileSync(getDataPath('hotkeys.json'), JSON.stringify(hotkeys, null, 2));
    }

    function registerHotkeys() {
        globalShortcut.unregisterAll();
        const hotkeys = getHotkeys();
        hotkeys.forEach(hk => {
            if (!hk.key || !hk.sourceId) return;
            try {
                globalShortcut.register(hk.key, () => {
                    try {
                        const sourcesPath = getDataPath('overlay-sources.json');
                        if (!fs.existsSync(sourcesPath)) return;
                        const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
                        const src = sources.find(s => String(s.id) === String(hk.sourceId));
                        if (!src) return;
                        const action = hk.action || 'trigger';
                        const axios2 = require('axios');
                        if (action === 'stop') {
                            if (src.path) axios2.post('http://localhost:3000/api/video-overlay/command', { cmd: 'CLEARIMG', id: src.id }).catch(()=>{});
                            if (src.videoPath) axios2.post('http://localhost:3000/api/video-overlay/command', { cmd: 'CLEARVID', id: src.id }).catch(()=>{});
                            if (src.soundPath) axios2.post('http://localhost:3000/api/video-overlay/command', { cmd: 'STOPSOUND', id: src.id }).catch(()=>{});
                            if (src.text) axios2.post('http://localhost:3000/api/text-overlay/command', { cmd: 'CLEARTEXT', id: src.id }).catch(()=>{});
                        } else {
                            // Trigger — use fire-source route which handles full source triggering by id
                            axios2.post('http://localhost:3000/api/overlay/fire-source', { sourceId: src.id }).catch(()=>{});
                        }
                    } catch(e) {}
                });
            } catch(e) { console.log('[hotkey] failed to register', hk.key, e.message); }
        });
    }

    server.get('/api/hotkeys', (req, res) => {
        res.json(getHotkeys());
    });

    server.post('/api/hotkeys', (req, res) => {
        try {
            saveHotkeys(req.body);
            registerHotkeys();
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // Dashboard calls this when a hotkey fires a trigger
    server.post('/api/overlay/hotkey-trigger', (req, res) => {
        // Broadcast to dashboard SSE so it can run overlayTriggerSource
        broadcastToDashboard({ type: 'hotkey-trigger', sourceId: req.body.sourceId });
        res.json({ ok: true });
    });

    // ---- PRESETS ----
    // /api/presets routes moved to presets.js

    // ---- ONBOARDING ----
    server.get('/onboarding', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard/onboarding.html'));
    });
    server.get('/api/onboarding/status', (req, res) => {
        try {
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            res.json({ complete: !!cfg.onboardingComplete, completed: cfg.onboardingCompleted || [] });
        } catch(e) { res.json({ complete: false, completed: [] }); }
    });
    server.post('/api/onboarding/complete', (req, res) => {
        try {
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            cfg.onboardingComplete = true;
            cfg.onboardingCompleted = req.body.completed || [];
            fs.writeFileSync(getDataPath('config.json'), JSON.stringify(cfg, null, 4));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });
    server.post('/api/onboarding/mark', (req, res) => {
        try {
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            if (!cfg.onboardingCompleted) cfg.onboardingCompleted = [];
            if (req.body.key && !cfg.onboardingCompleted.includes(req.body.key)) cfg.onboardingCompleted.push(req.body.key);
            fs.writeFileSync(getDataPath('config.json'), JSON.stringify(cfg, null, 4));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // ---- AUTOMOD ----
    function getAutomodDefaults() {
        return {
            enabled: false, bannedWords: [], bannedWords_action: 'timeout', bannedWords_duration: 300,
            caps: { enabled: true, threshold: 70, minLength: 10, action: 'warn', duration: 60 },
            links: { enabled: false, allowSubs: true, action: 'delete', duration: 60 },
            spam: { enabled: true, messages: 5, seconds: 3, action: 'timeout', duration: 300 },
            warnings: { enabled: true }, exemptMods: true, exemptSubs: false
        };
    }
    server.get('/api/automod', (req, res) => {
        const p = getDataPath('automod.json');
        if (!fs.existsSync(p)) return res.json(getAutomodDefaults());
        try { res.json(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch(e) { res.json(getAutomodDefaults()); }
    });
    server.post('/api/automod', (req, res) => {
        try {
            fs.writeFileSync(getDataPath('automod.json'), JSON.stringify(req.body, null, 2));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // ---- ROUTES_OVERLAY ----
    server.get('/api/overlay/sources', (req, res) => {
        try {
            const p = getDataPath('overlay-sources.json');
            if (!fs.existsSync(p)) return res.json([]);
            res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch(e) { res.json([]); }
    });
    server.post('/api/overlay/sources', (req, res) => {
        try {
            fs.writeFileSync(getDataPath('overlay-sources.json'), JSON.stringify(req.body, null, 2));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    let overlayCurrentMode = 'desktop';

    function launchOverlay(mode) {
        if (overlayProcess) return;
        overlayCurrentMode = mode || 'desktop';
        const overlayExePath = app.isPackaged
            ? path.join(process.resourcesPath, 'overlay.exe')
            : path.join(__dirname, 'overlay.exe');
        if (!fs.existsSync(overlayExePath)) { console.log('[overlay] overlay.exe not found'); return; }
        try {
            const overlayCmdPath = getDataPath('overlay-cmd.txt');
            try { fs.writeFileSync(overlayCmdPath, ''); } catch(e) {}
            const overlayPosPath = getDataPath('overlay-positions.json');
            overlayProcess = spawn(overlayExePath, [overlayCmdPath, overlayPosPath, overlayCurrentMode], { stdio: 'ignore', detached: false });
            overlayProcess.on('exit', (code) => { console.log('[overlay] exited:', code); overlayProcess = null; });
            overlayProcess.on('error', (err) => { console.error('[overlay] error:', err); overlayProcess = null; });
            console.log('[overlay] launched in', overlayCurrentMode, 'mode');
        } catch(e) { console.error('[overlay] launch error:', e.message); }
    }

    // ---- SONG ROUTES ----
    function launchSongPlayer() {
        if (songWin && !songWin.isDestroyed()) return;
        songWin = new BrowserWindow({
            width: 320, height: 500, minWidth: 260, minHeight: 300,
            frame: false, transparent: false, resizable: true, skipTaskbar: false,
            title: 'Song Requests', backgroundColor: '#0e0e10',
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        songWin.loadURL('http://localhost:3000/song-player.html');
        songWin.on('close', (e) => {
            e.preventDefault();
            setImmediate(() => { if (songWin && !songWin.isDestroyed()) songWin.hide(); });
        });
        songWin.on('closed', () => { songWin = null; });
    }

    async function fetchYouTubeTitle(videoId) {
        try {
            const resp = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { timeout: 4000 });
            return resp.data.title || videoId;
        } catch(e) { return videoId; }
    }

    function playNextSong() {
        if (songCurrent) return;
        if (!songQueue.length) return;
        songCurrent = songQueue.shift();
    }

    server.get('/api/songs/queue', (req, res) => {
        res.json({ current: songCurrent, queue: songQueue });
    });

    server.post('/api/songs/queue', async (req, res) => {
        try {
            const { videoId, requester } = req.body;
            if (!videoId) return res.json({ ok: false, error: 'No videoId' });
            const title = await fetchYouTubeTitle(videoId);
            const song = { videoId, title, requester, addedAt: Date.now() };
            songQueue.push(song);
            if (!songCurrent) playNextSong();
            res.json({ ok: true, title, position: songCurrent ? songQueue.length : 0 });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.post('/api/songs/skip', (req, res) => {
        songCurrent = null;
        setTimeout(playNextSong, 500);
        res.json({ ok: true });
    });

    server.post('/api/songs/done', (req, res) => {
        songCurrent = null;
        setTimeout(playNextSong, 1000);
        res.json({ ok: true });
    });

    server.delete('/api/songs/queue/:index', (req, res) => {
        const idx = parseInt(req.params.index);
        if (idx >= 0 && idx < songQueue.length) songQueue.splice(idx, 1);
        res.json({ ok: true });
    });

    server.post('/api/songs/clear', (req, res) => {
        songQueue = []; songCurrent = null;
        res.json({ ok: true });
    });

    server.get('/api/songs/open', (req, res) => {
        launchSongPlayer();
        if (songWin && !songWin.isDestroyed()) { songWin.show(); songWin.focus(); }
        res.json({ ok: true });
    });

    server.post('/api/songs/close', (req, res) => {
        if (songWin && !songWin.isDestroyed()) songWin.hide();
        res.json({ ok: true });
    });

    server.get('/song-player.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard', 'song-player.html'));
    });

    // Auto-launch overlays shortly after startup
    setTimeout(() => {
        if (!overlayProcess) launchOverlay('desktop');
        launchVideoOverlay('desktop');
        launchTextOverlay('desktop');
    }, 3000);

    server.get('/api/overlay/status', (req, res) => { res.json({ running: !!overlayProcess, mode: overlayCurrentMode }); });

    server.get('/stream-overlay.html', (req, res) => {
        res.sendFile(path.join(appDir, 'dashboard/stream-overlay.html'));
    });

    server.post('/api/overlay/setmode', (req, res) => {
        const mode = (req.body && req.body.mode) || 'desktop';
        overlayCurrentMode = mode; videoWinMode = mode; textWinMode = mode;
        if (videoWin && !videoWin.isDestroyed()) { videoWin.destroy(); videoWin = null; }
        if (textWin && !textWin.isDestroyed()) { textWin.destroy(); textWin = null; }
        launchVideoOverlay(mode);
        launchTextOverlay(mode);
        res.json({ ok: true, mode });
    });

    server.get('/api/overlay/obs-urls', (req, res) => {
        res.json({ streamOverlay: 'http://localhost:3000/stream-overlay.html' });
    });

    server.get('/api/displays', (req, res) => {
        const { screen } = require('electron');
        const displays = screen.getAllDisplays();
        const primary = screen.getPrimaryDisplay();
        res.json(displays.map((d, i) => ({
            index: i,
            id: d.id,
            label: `Display ${i + 1}${d.id === primary.id ? ' (primary)' : ''} — ${d.size.width}×${d.size.height}`,
            width: d.size.width,
            height: d.size.height,
            x: d.bounds.x,
            y: d.bounds.y,
            primary: d.id === primary.id
        })));
    });

    server.post('/api/overlay/display', (req, res) => {
        try {
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            cfg.overlayDisplay = req.body.index ?? 0;
            fs.writeFileSync(getDataPath('config.json'), JSON.stringify(cfg, null, 4));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.post('/api/overlay/launch', (req, res) => {
        const mode = (req.body && req.body.mode) || 'desktop';
        launchOverlay(mode);
        res.json({ ok: true, running: !!overlayProcess });
    });
    server.post('/api/overlay/stop', (req, res) => {
        if (overlayProcess) {
            try { 
                const overlayCmdPath = getDataPath('overlay-cmd.txt');
                fs.writeFileSync(overlayCmdPath, 'QUIT\n');
            } catch(e) {}
            setTimeout(() => { if (overlayProcess) { overlayProcess.kill(); overlayProcess = null; } }, 500);
        }
        res.json({ ok: true });
    });
    server.post('/api/overlay/command', (req, res) => {
        if (!overlayProcess) return res.json({ ok: false, error: 'overlay not running' });
        const { cmd, id, type, path: filePath, x, y, w, h, r, g, b, threshold } = req.body;
        console.log('[overlay cmd]', cmd, id, filePath);
        let line = '';
        if      (cmd === 'LOAD')   line = 'LOAD ' + id + ' ' + (req.body.loops || 1) + ' ' + filePath + '\n';
        else if (cmd === 'CLEAR')  line = 'CLEAR ' + id + '\n';
        else if (cmd === 'CHROMA') line = 'CHROMA ' + id + ' ' + r + ' ' + g + ' ' + b + ' ' + threshold + '\n';
        else if (cmd === 'MOVE')   line = 'MOVE ' + id + ' ' + x + ' ' + y + '\n';
        else if (cmd === 'SIZE')   line = 'SIZE ' + id + ' ' + w + ' ' + h + '\n';
        else if (cmd === 'REMOVE') line = 'REMOVE ' + id + '\n';
        else if (cmd === 'GIFLOOPS') line = 'GIFLOOPS ' + id + ' ' + (req.body.loops || 1) + '\n';
        else if (cmd === 'SOUND')  line = 'SOUND ' + (req.body.startMs || 0) + ' ' + (req.body.endMs || 0) + ' ' + filePath + '\n';
        else if (cmd === 'QUIT')   line = 'QUIT\n';
        if (line) { 
            try { 
                const overlayCmdPath = getDataPath('overlay-cmd.txt');
                const overlayCmdTmp = getDataPath('overlay-cmd.tmp');
                fs.writeFileSync(overlayCmdTmp, line);
                fs.renameSync(overlayCmdTmp, overlayCmdPath);
            } catch(e) { console.error('[overlay cmd error]', e.message); } 
        }
        res.json({ ok: true });
    });
    // Trigger overlay sources assigned to a chat command
    server.post('/api/overlay/fire-command', async (req, res) => {
        try {
            const { command, args } = req.body;
            if (!command) return res.json({ ok: false });
            const p = getDataPath('overlay-sources.json');
            if (!fs.existsSync(p)) return res.json({ ok: true, triggered: 0 });
            const sources = JSON.parse(fs.readFileSync(p, 'utf8'));
            const matches = sources.filter(s => s.assignedCommand === command);
            if (!matches.length) return res.json({ ok: true, triggered: 0 });

            // Resolve text — if src.text is '{message}', use user args instead
            function resolveText(src) {
                if (src.text === '{message}') return (args || '').trim() || src.text;
                return src.text;
            }

            const overlayCmdPath = getDataPath('overlay-cmd.txt');
            const overlayCmdTmp = getDataPath('overlay-cmd.tmp');

            function writeOverlayCmd(line) {
                try { fs.writeFileSync(overlayCmdTmp, line); fs.renameSync(overlayCmdTmp, overlayCmdPath); } catch(e) {}
            }

            for (const src of matches) {
                const hasImage = src.type === 'image' || src.type === 'image+sound';
                const hasSound = src.type === 'sound' || src.type === 'image+sound' || src.type === 'video+sound';
                const hasVideo = src.type === 'video' || src.type === 'video+sound';
                const hasText  = src.type === 'text' || !!(src.speak && src.text);
                const isGif = hasImage && src.path && src.path.toLowerCase().endsWith('.gif');

                if (hasText && (textWinMode === 'stream' ? textOverlayClients.length > 0 : (textWin && !textWin.isDestroyed()))) {
                    const clearMediaId = (src.clearWithTTS && (hasImage || hasVideo)) ? src.id : null;
                    const clearMediaKind = clearMediaId ? (hasImage ? 'image' : 'video') : null;
                    broadcastTextCmd({ cmd: 'ADDTEXT', id: src.id, text: resolveText(src),
                        x: src.x || 100, y: src.y || 100,
                        font: src.font, size: src.fontSize, color: src.color,
                        bold: src.bold, italic: src.italic, shadow: src.shadow,
                        animation: src.animation, animDuration: src.animDuration, maxW: src.maxW, maxH: src.maxH || 0,
                        speak: src.speak || false, voice: src.voice || null,
                        ttsRate: src.ttsRate || 1, ttsPitch: src.ttsPitch || 1, ttsVolume: src.ttsVolume ?? 1,
                        speakOnly: !!src.speakOnly,
                        clearMediaId, clearMediaKind });
                    const textSecs = src.displaySeconds || 0;
                    if (textSecs > 0 && !src.speak) {
                        setTimeout(() => broadcastTextCmd({ cmd: 'CLEARTEXT', id: src.id }), textSecs * 1000);
                    }
                }

                if (hasImage) {
                    const hasPositionData = src.mediaX !== undefined || src.mediaY !== undefined;
                    if (hasPositionData && (videoWinMode === 'stream' ? videoOverlayClients.length > 0 : (videoWin && !videoWin.isDestroyed()))) {
                        // Use video overlay PLAYIMG — supports position, size, clearWithTTS
                        const loops = src.clearWithTTS ? 0 : (isGif ? (src.gifLoops || 0) : 0);
                        const displaySeconds = src.clearWithTTS ? 0 : (src.displaySeconds || 5);
                        broadcastVideoCmd({ cmd: 'PLAYIMG', id: src.id, path: src.path, loops, displaySeconds,
                            x: src.mediaX || 0, y: src.mediaY || 0, w: src.mediaW || 960, h: src.mediaH || 540,
                            chromaKey: src.chromaKey || false, chromaColor: src.chromaColor || '#00ff00', chromaThreshold: src.chromaThreshold ?? 40 });
                    } else if (overlayProcess) {
                        // Legacy C++ overlay path
                        const loops = isGif ? (hasSound ? 0 : (src.gifLoops || 1)) : 1;
                        writeOverlayCmd('LOAD ' + src.id + ' ' + loops + ' ' + src.path + '\n');
                        if (!hasSound && !isGif && src.displaySeconds > 0) {
                            const ms = src.displaySeconds * 1000;
                            setTimeout(() => writeOverlayCmd('CLEAR ' + src.id + '\n'), ms);
                        }
                    }
                }

                if (hasVideo && (videoWinMode === 'stream' ? videoOverlayClients.length > 0 : (videoWin && !videoWin.isDestroyed()))) {
                    const loops = hasSound ? 0 : (src.videoLoops || 1);
                    let px, py, pw, ph;
                    if (videoPositions[src.id]) {
                        px = videoPositions[src.id].x; py = videoPositions[src.id].y;
                        pw = videoPositions[src.id].w; ph = videoPositions[src.id].h;
                    }
                    broadcastVideoCmd({ cmd: 'PLAYVID', id: src.id, path: src.videoPath, loops, videoStart: src.videoStart || 0, videoEnd: src.videoEnd || 0, x: px, y: py, w: pw, h: ph });
                }

                if (hasSound && overlayProcess) {
                    const startMs = Math.round((src.soundStart || 0) * 1000);
                    const endMs = Math.round((src.soundEnd || 0) * 1000);
                    writeOverlayCmd('SOUND ' + startMs + ' ' + endMs + ' ' + src.soundPath + '\n');
                    if ((hasImage || hasVideo) && endMs > startMs) {
                        const displayMs = endMs - startMs;
                        setTimeout(() => {
                            if (hasImage && overlayProcess) writeOverlayCmd('CLEAR ' + src.id + '\n');
                            if (hasVideo && videoWin && !videoWin.isDestroyed()) broadcastVideoCmd({ cmd: 'CLEARVID', id: src.id });
                        }, displayMs);
                    }
                }
            }
            res.json({ ok: true, triggered: matches.length });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // ── GIF Library ──────────────────────────────────────────────────────────
    function getGifLibrary() {
        const p = getDataPath('gif-library.json');
        if (!fs.existsSync(p)) return { approved: [], pending: [] };
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) { return { approved: [], pending: [] }; }
    }
    function saveGifLibrary(lib) {
        fs.writeFileSync(getDataPath('gif-library.json'), JSON.stringify(lib, null, 2));
    }

    server.get('/api/gif-library', (req, res) => {
        res.json(getGifLibrary());
    });

    server.post('/api/gif-library', (req, res) => {
        try {
            const lib = getGifLibrary();
            const { name, url } = req.body;
            if (!name || !url) return res.json({ ok: false, error: 'name and url required' });
            const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (lib.approved.find(g => g.name === safeName)) return res.json({ ok: false, error: 'Name already taken' });
            lib.approved.push({ name: safeName, url, addedBy: 'streamer', addedAt: Date.now() });
            saveGifLibrary(lib);
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.post('/api/gif-library/request', (req, res) => {
        try {
            const lib = getGifLibrary();
            const { url, suggestedName, requestedBy } = req.body;
            if (!url || !suggestedName) return res.json({ ok: false, error: 'url and name required' });
            if (lib.pending.length >= 50) return res.json({ ok: false, error: 'Too many pending requests' });
            const duplicate = lib.pending.find(g => g.url === url && g.requestedBy === requestedBy);
            if (duplicate) return res.json({ ok: false, error: 'You already have a pending request' });
            lib.pending.push({ id: Date.now(), url, suggestedName: suggestedName.toLowerCase().replace(/[^a-z0-9_-]/g, ''), requestedBy, requestedAt: Date.now() });
            saveGifLibrary(lib);
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.post('/api/gif-library/approve', (req, res) => {
        try {
            const lib = getGifLibrary();
            const { id, name } = req.body;
            const idx = lib.pending.findIndex(g => g.id === id);
            if (idx === -1) return res.json({ ok: false, error: 'Request not found' });
            const pending = lib.pending[idx];
            const safeName = (name || pending.suggestedName).toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (!safeName) return res.json({ ok: false, error: 'Invalid name' });
            if (lib.approved.find(g => g.name === safeName)) return res.json({ ok: false, error: 'Name already taken' });
            lib.approved.push({ name: safeName, url: pending.url, addedBy: pending.requestedBy, addedAt: Date.now() });
            lib.pending.splice(idx, 1);
            saveGifLibrary(lib);
            res.json({ ok: true, name: safeName });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.post('/api/gif-library/reject', (req, res) => {
        try {
            const lib = getGifLibrary();
            const { id } = req.body;
            lib.pending = lib.pending.filter(g => g.id !== id);
            saveGifLibrary(lib);
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.post('/api/gif-library/remove', (req, res) => {
        try {
            const lib = getGifLibrary();
            const { name } = req.body;
            const before = lib.approved.length;
            lib.approved = lib.approved.filter(g => g.name !== name);
            if (lib.approved.length === before) return res.json({ ok: false, error: 'GIF not found' });
            saveGifLibrary(lib);
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    let activeGifLibId = null;

    server.post('/api/gif-library/fire', async (req, res) => {
        try {
            const { gifName } = req.body;
            const lib = getGifLibrary();
            const gif = lib.approved.find(g => g.name === (gifName || '').toLowerCase());
            if (!gif) return res.json({ ok: false, error: 'GIF not found: ' + gifName });
            const posPath = getDataPath('gif-overlay-position.json');
            const pos = fs.existsSync(posPath) ? JSON.parse(fs.readFileSync(posPath, 'utf8')) : { x: 480, y: 270, w: 400, h: 300, duration: 5 };
            const id = 99000 + Math.floor(Math.random() * 999);
            activeGifLibId = id;
            if (videoWin && !videoWin.isDestroyed()) {
                // loops:0 = loop forever, displaySeconds:0 = never auto-clear — wait for TEXTDONE
                broadcastVideoCmd({ cmd: 'PLAYIMG', id, path: gif.url, loops: 0,
                    displaySeconds: 0,
                    x: pos.x || 480, y: pos.y || 270, w: pos.w || 400, h: pos.h || 300,
                    chromaKey: false, chromaColor: '#00ff00', chromaThreshold: 40 });
            }
            res.json({ ok: true, id });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.get('/api/gif-library/position', (req, res) => {
        try {
            const p = getDataPath('gif-overlay-position.json');
            res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { x: 480, y: 270, w: 400, h: 300, duration: 5 });
        } catch(e) { res.json({ x: 480, y: 270, w: 400, h: 300, duration: 5 }); }
    });

    server.post('/api/gif-library/position', (req, res) => {
        try {
            fs.writeFileSync(getDataPath('gif-overlay-position.json'), JSON.stringify(req.body, null, 2));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // Clear saved position for a source (overlay handles this on REMOVE)

    // ── EventSub Alert Config ─────────────────────────────────────────────────
    function getEventsubAlerts() {
        const p = getDataPath('eventsub-alerts.json');
        if (!fs.existsSync(p)) return {};
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) { return {}; }
    }
    function saveEventsubAlerts(data) {
        fs.writeFileSync(getDataPath('eventsub-alerts.json'), JSON.stringify(data, null, 2));
    }

    server.get('/api/eventsub/alerts', (req, res) => {
        res.json(getEventsubAlerts());
    });

    server.post('/api/eventsub/alert', (req, res) => {
        try {
            const { key, src } = req.body;
            if (!key || !src) return res.json({ ok: false, error: 'key and src required' });
            const alerts = getEventsubAlerts();
            alerts[key] = src;
            saveEventsubAlerts(alerts);
            // Reload eventsub so new alert is picked up immediately
            startEventSub();
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.get('/api/eventsub/status', (req, res) => {
        res.json({ connected: eventsubConnected, sessionId: eventsubSessionId || null });
    });

    // Internal route called by EventSub engine to fire an alert (keeps broadcast fns in scope)
    server.post('/api/eventsub/fire', (req, res) => {
        try {
            const src = req.body.eventsubSrc;
            if (!src) return res.json({ ok: false });
            const srcId = 88000 + Math.floor(Math.random() * 999);
            src.id = srcId;
            const hasImage = src.type === 'image' || src.type === 'image+sound';
            const hasVideo = src.type === 'video' || src.type === 'video+sound';
            const hasText  = !!(src.speak && src.text);
            const isGif = hasImage && src.path && src.path.toLowerCase().includes('.gif');
            if (hasImage && (videoWinMode === 'stream' ? videoOverlayClients.length > 0 : (videoWin && !videoWin.isDestroyed()))) {
                const loops = src.clearWithTTS ? 0 : (isGif ? 0 : 1);
                const displaySeconds = src.clearWithTTS ? 0 : (src.displaySeconds || 5);
                broadcastVideoCmd({ cmd: 'PLAYIMG', id: srcId, path: src.path, loops, displaySeconds,
                    x: src.mediaX ?? 480, y: src.mediaY ?? 270, w: src.mediaW || 960, h: src.mediaH || 540,
                    chromaKey: src.chromaKey || false, chromaColor: src.chromaColor || '#00ff00', chromaThreshold: src.chromaThreshold ?? 40 });
            }
            if (hasVideo && (videoWinMode === 'stream' ? videoOverlayClients.length > 0 : (videoWin && !videoWin.isDestroyed()))) {
                const loops = src.clearWithTTS ? 0 : (src.videoLoops || 1);
                broadcastVideoCmd({ cmd: 'PLAYVID', id: srcId, path: src.videoPath, loops,
                    videoStart: src.videoStart || 0, videoEnd: src.videoEnd || 0, volume: src.videoVolume ?? 1,
                    x: src.mediaX ?? 480, y: src.mediaY ?? 270, w: src.mediaW || 960, h: src.mediaH || 540,
                    chromaKey: src.chromaKey || false, chromaColor: src.chromaColor || '#00ff00', chromaThreshold: src.chromaThreshold ?? 40 });
            }
            if (hasText && (textWinMode === 'stream' ? textOverlayClients.length > 0 : (textWin && !textWin.isDestroyed()))) {
                const clearMediaId = src.clearWithTTS ? srcId : null;
                const clearMediaKind = clearMediaId ? (hasImage ? 'image' : 'video') : null;
                broadcastTextCmd({ cmd: 'ADDTEXT', id: srcId, text: src.text,
                    x: src.x || 100, y: src.y || 400,
                    font: src.font || 'Arial', size: src.fontSize || 48, color: src.color || '#ffffff',
                    bold: src.bold || false, italic: src.italic || false, shadow: src.shadow !== false,
                    animation: src.animation || 'fade', animDuration: src.animDuration || 1,
                    maxW: src.maxW || 1720, maxH: src.maxH || 200,
                    speak: true, voice: src.voice || null,
                    ttsRate: src.ttsRate || 1, ttsPitch: src.ttsPitch || 1, ttsVolume: src.ttsVolume ?? 1,
                    speakOnly: !!src.speakOnly,
                    clearMediaId, clearMediaKind });
            }
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });
    server.post('/api/overlay/clearpos', (req, res) => { res.json({ ok: true }); });
    // Get saved positions
    server.get('/api/overlay/positions', (req, res) => {
        try {
            const p = getDataPath('overlay-positions.json');
            if (!fs.existsSync(p)) return res.json([]);
            res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch(e) { res.json([]); }
    });
    server.get('/api/overlay/browse', async (req, res) => {
        try {
            const type = req.query.type || 'image';
            const filters = type === 'sound'
                ? [{ name: 'Audio Files', extensions: ['mp3', 'wav'] }, { name: 'All Files', extensions: ['*'] }]
                : type === 'video'
                ? [{ name: 'Video Files', extensions: ['mp4'] }, { name: 'All Files', extensions: ['*'] }]
                : [{ name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }, { name: 'All Files', extensions: ['*'] }];
            const result = await dialog.showOpenDialog(mainWindow, {
                title: type === 'sound' ? 'Select Audio File' : 'Select Image File',
                filters,
                properties: ['openFile']
            });
            if (result.canceled || !result.filePaths.length) return res.json({ path: null });
            res.json({ path: result.filePaths[0] });
        } catch (e) { res.json({ path: null, error: e.message }); }
    });

    server.get('/api/overlay/duration', (req, res) => {
        const filePath = req.query.path;
        if (!filePath) return res.json({ durationMs: 0 });
        try {
            const { execFileSync } = require('child_process');
            const os = require('os');
            const tmpScript = path.join(os.tmpdir(), 'cc_dur.ps1');
            const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MCI2 {
    [DllImport("winmm.dll", CharSet=CharSet.Unicode)]
    public static extern int mciSendString(string cmd, StringBuilder ret, int len, IntPtr cb);
}
"@
$sb = New-Object System.Text.StringBuilder 128
[MCI2]::mciSendString('open "${escaped}" type mpegvideo alias ccdur', $null, 0, [IntPtr]::Zero) | Out-Null
[MCI2]::mciSendString('set ccdur time format milliseconds', $null, 0, [IntPtr]::Zero) | Out-Null
[MCI2]::mciSendString('status ccdur length', $sb, 128, [IntPtr]::Zero) | Out-Null
[MCI2]::mciSendString('close ccdur', $null, 0, [IntPtr]::Zero) | Out-Null
Write-Output $sb.ToString().Trim()
`;
            fs.writeFileSync(tmpScript, script, 'utf8');
            const result = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript], { timeout: 6000 }).toString().trim();
            const ms = parseInt(result);
            if (!isNaN(ms) && ms > 0) return res.json({ durationMs: ms });
            res.json({ durationMs: 0 });
        } catch(e) {
            res.json({ durationMs: 0 });
        }
    });

    // Serve local files for video overlay (Electron security blocks file:/// in BrowserWindow)
    server.get('/api/localfile', (req, res) => {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).end();
        try {
            const stat = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mime = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'application/octet-stream';
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                const chunkSize = end - start + 1;
                const fileStream = fs.createReadStream(filePath, { start, end });
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': mime
                });
                fileStream.pipe(res);
            } else {
                res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
                fs.createReadStream(filePath).pipe(res);
            }
        } catch(e) {
            res.status(404).end();
        }
    });

    // ---- ROUTES_VIDEO_OVERLAY ----

    function launchVideoOverlay(mode) {
        videoWinMode = mode || 'desktop';
        if (videoWinMode === 'stream') {
            if (videoWin && !videoWin.isDestroyed()) { videoWin.destroy(); videoWin = null; }
            return;
        }
        if (videoWin && !videoWin.isDestroyed()) return;
        const { screen } = require('electron');
        const _vDisplays = screen.getAllDisplays();
        const _vCfg = (() => { try { return JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8')); } catch(e) { return {}; } })();
        const _vDisplay = _vDisplays[_vCfg.overlayDisplay ?? 0] || screen.getPrimaryDisplay();
        const { width, height } = _vDisplay.size;
        videoWin = new BrowserWindow({
            width, height,
            x: _vDisplay.bounds.x,
            y: _vDisplay.bounds.y,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            type: 'toolbar',
            skipTaskbar: true,
            resizable: false,
            focusable: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                offscreen: false
            }
        });
        videoWin.setAlwaysOnTop(true, 'screen-saver');
        videoWin.setVisibleOnAllWorkspaces(true);
        videoWin.setIgnoreMouseEvents(true, { forward: true });
        videoWin.loadURL('http://localhost:3000/media-overlay.html');
        videoWin.on('closed', () => { videoWin = null; });
        videoWin.webContents.on('did-finish-load', () => {
            console.log('[video-overlay] loaded, mode:', videoWinMode);
        });
    }

    server.get('/api/video-overlay/status', (req, res) => {
        res.json({ running: !!(videoWin && !videoWin.isDestroyed()), mode: videoWinMode });
    });

    server.post('/api/video-overlay/launch', (req, res) => {
        const mode = (req.body && req.body.mode) || 'desktop';
        launchVideoOverlay(mode);
        res.json({ ok: true });
    });

    server.post('/api/video-overlay/stop', (req, res) => {
        if (videoWin && !videoWin.isDestroyed()) videoWin.destroy();
        videoWin = null;
        res.json({ ok: true });
    });

    let videoDashboardClients = []; // dashboard listeners

    // SSE stream — video-overlay.html connects here to receive commands
    server.get('/api/video-overlay/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        // Only one video overlay window ever exists — clear stale connections
        videoOverlayClients.forEach(c => { try { c.end(); } catch(e) {} });
        videoOverlayClients = [res];
        res.write(': connected\n\n');
        const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 15000);
        req.on('close', () => {
            clearInterval(keepalive);
            videoOverlayClients = videoOverlayClients.filter(c => c !== res);
        });
        // Notify dashboard that video window is ready
        const readyMsg = 'data: ' + JSON.stringify({ cmd: 'READY' }) + '\n\n';
        videoDashboardClients.forEach(c => { try { c.write(readyMsg); } catch(e) {} });
    });

    // SSE events — dashboard connects here to receive READY and VIDDONE
    server.get('/api/video-overlay/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        videoDashboardClients.push(res);
        const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 15000);
        req.on('close', () => {
            clearInterval(keepalive);
            videoDashboardClients = videoDashboardClients.filter(c => c !== res);
        });
    });

    function broadcastVideoCmd(payload) {
        const data = 'data: ' + JSON.stringify(payload) + '\n\n';
        videoOverlayClients.forEach(c => { try { c.write(data); } catch(e) {} });
    }

    function broadcastVideoDashboard(payload) {
        const data = 'data: ' + JSON.stringify(payload) + '\n\n';
        videoDashboardClients.forEach(c => { try { c.write(data); } catch(e) {} });
    }

    server.post('/api/video-overlay/command', (req, res) => {
        const body = req.body;
        const { id, x, y, w, h } = body;
        let px = x, py = y, pw = w, ph = h;
        if (id && videoPositions[id] && x === undefined) {
            px = videoPositions[id].x; py = videoPositions[id].y;
            pw = videoPositions[id].w; ph = videoPositions[id].h;
        }
        broadcastVideoCmd(Object.assign({}, body, { x: px, y: py, w: pw, h: ph }));
        res.json({ ok: true });
    });

    server.post('/api/video-overlay/mouse', (req, res) => {
        if (videoWin && !videoWin.isDestroyed()) {
            const ignore = req.body.ignore !== false;
            videoWin.setIgnoreMouseEvents(ignore, { forward: true });
        }
        res.json({ ok: true });
    });
    server.post('/api/video-overlay/done', (req, res) => {
        const body = req.body;
        if (body.type === 'ready') {
            broadcastVideoDashboard({ cmd: 'READY' });
        } else {
            broadcastVideoDashboard({ cmd: body.cmd || 'VIDDONE', id: body.id });
            if (body.cmd === 'TEXTDONE') {
                // Clear media from event alerts (clearMediaId sent by text-overlay)
                if (body.clearMediaId && videoWin && !videoWin.isDestroyed()) {
                    const clearCmd = body.clearMediaKind === 'video' ? 'CLEARVID' : 'CLEARIMG';
                    broadcastVideoCmd({ cmd: clearCmd, id: body.clearMediaId });
                }
                // Also clear GIF library overlay if active
                if (activeGifLibId !== null) {
                    if (videoWin && !videoWin.isDestroyed()) broadcastVideoCmd({ cmd: 'CLEARIMG', id: activeGifLibId });
                    activeGifLibId = null;
                }
            }
        }
        res.json({ ok: true });
    });

    // Load video positions from disk on startup
    try {
        const vp = getDataPath('video-positions.json');
        if (fs.existsSync(vp)) videoPositions = JSON.parse(fs.readFileSync(vp, 'utf8'));
    } catch(e) {}

    // Save position from drag/resize in video-overlay.html
    server.post('/api/video-overlay/savepos', (req, res) => {
        const { id, x, y, w, h } = req.body;
        videoPositions[id] = { x, y, w, h };
        try { fs.writeFileSync(getDataPath('video-positions.json'), JSON.stringify(videoPositions)); } catch(e) {}
        res.json({ ok: true });
    });

    // ---- ROUTES_TEXT_OVERLAY ----

    function launchTextOverlay(mode) {
        textWinMode = mode || 'desktop';
        if (textWinMode === 'stream') {
            if (textWin && !textWin.isDestroyed()) { textWin.destroy(); textWin = null; }
            return;
        }
        if (textWin && !textWin.isDestroyed()) return;
        const { screen } = require('electron');
        const _tDisplays = screen.getAllDisplays();
        const _tCfg = (() => { try { return JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8')); } catch(e) { return {}; } })();
        const _tDisplay = _tDisplays[_tCfg.overlayDisplay ?? 0] || screen.getPrimaryDisplay();
        const { width, height } = _tDisplay.size;
        textWin = new BrowserWindow({
            width, height,
            x: _tDisplay.bounds.x,
            y: _tDisplay.bounds.y,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            type: 'toolbar',
            skipTaskbar: true,
            resizable: false,
            focusable: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                offscreen: false
            }
        });
        textWin.setAlwaysOnTop(true, 'screen-saver');
        textWin.setVisibleOnAllWorkspaces(true);
        textWin.setIgnoreMouseEvents(true, { forward: true });
        textWin.loadURL('http://localhost:3000/text-overlay.html');
        textWin.on('closed', () => { textWin = null; });
    }

    server.get('/api/text-overlay/status', (req, res) => {
        res.json({ running: !!(textWin && !textWin.isDestroyed()), mode: textWinMode });
    });

    server.post('/api/text-overlay/launch', (req, res) => {
        const mode = (req.body && req.body.mode) || 'desktop';
        launchTextOverlay(mode);
        res.json({ ok: true });
    });

    server.post('/api/text-overlay/stop', (req, res) => {
        if (textWin && !textWin.isDestroyed()) textWin.destroy();
        textWin = null;
        res.json({ ok: true });
    });

    server.get('/api/text-overlay/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        textOverlayClients.forEach(c => { try { c.end(); } catch(e) {} });
        textOverlayClients = [res];
        res.write(': connected\n\n');
        const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 15000);
        req.on('close', () => {
            clearInterval(keepalive);
            textOverlayClients = textOverlayClients.filter(c => c !== res);
        });
    });

    function broadcastTextCmd(payload) {
        const data = 'data: ' + JSON.stringify(payload) + '\n\n';
        textOverlayClients.forEach(c => { try { c.write(data); } catch(e) {} });
    }

    server.post('/api/text-overlay/command', (req, res) => {
        broadcastTextCmd(req.body);
        res.json({ ok: true });
    });

    let cachedVoices = [];
    server.post('/api/text-overlay/voices', (req, res) => {
        cachedVoices = req.body.voices || [];
        res.json({ ok: true });
    });
    server.get('/api/text-overlay/voices', (req, res) => {
        if (cachedVoices.length === 0 && textWin && !textWin.isDestroyed()) {
            broadcastTextCmd({ cmd: 'GETVOICES' });
        }
        res.json({ voices: cachedVoices });
    });

    // ---- ROUTES_TTS_MONSTER ----

    server.get('/api/tts/config', (req, res) => {
        try {
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            res.json({ configured: !!(cfg.ttsMonsterKey) });
        } catch(e) { res.json({ configured: false }); }
    });

    server.post('/api/tts/config', (req, res) => {
        try {
            const { key } = req.body;
            if (!key) return res.status(400).json({ ok: false, error: 'key required' });
            const p = getDataPath('config.json');
            const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
            cfg.ttsMonsterKey = key;
            fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
            res.json({ ok: true });
        } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    server.delete('/api/tts/config', (req, res) => {
        try {
            const p = getDataPath('config.json');
            const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
            delete cfg.ttsMonsterKey;
            fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
            res.json({ ok: true });
        } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    server.get('/api/tts/monster-voices', async (req, res) => {
        try {
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            if (!cfg.ttsMonsterKey) return res.json({ ok: false, voices: [], customVoices: [] });
            const https = require('https');
            const data = await new Promise((resolve, reject) => {
                const r = https.request('https://api.console.tts.monster/voices', {
                    method: 'POST',
                    headers: { 'Authorization': cfg.ttsMonsterKey }
                }, (resp) => {
                    let body = '';
                    resp.on('data', d => body += d);
                    resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
                });
                r.on('error', reject);
                r.end();
            });
            res.json({ ok: true, voices: data.voices || [], customVoices: data.customVoices || [] });
        } catch(e) { res.status(500).json({ ok: false, voices: [], customVoices: [], error: e.message }); }
    });

    server.post('/api/tts/speak', async (req, res) => {
        try {
            const { text, voice, ttsVolume, id, clearMediaId, clearMediaKind } = req.body;
            if (!text) return res.status(400).json({ ok: false, error: 'No text provided' });
            const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            if (!cfg.ttsMonsterKey) return res.status(503).json({ ok: false, error: 'TTS Monster not configured' });
            const https = require('https');
            const voiceId = (voice || '').replace(/^ttsm:/, '');
            const genBody = JSON.stringify({ voice_id: voiceId || undefined, message: text.slice(0, 500) });
            const genResult = await new Promise((resolve, reject) => {
                const r = https.request('https://api.console.tts.monster/generate', {
                    method: 'POST',
                    headers: { 'Authorization': cfg.ttsMonsterKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(genBody) }
                }, (resp) => {
                    let body = '';
                    resp.on('data', d => body += d);
                    resp.on('end', () => { try { resolve({ status: resp.statusCode, data: JSON.parse(body) }); } catch(e) { reject(new Error('Bad JSON: ' + body)); } });
                });
                r.on('error', reject);
                r.write(genBody);
                r.end();
            });
            if (genResult.status !== 200 || !genResult.data.url) {
                const msg = genResult.status === 401 ? 'TTS Monster: Invalid API key'
                          : genResult.status === 402 ? 'TTS Monster: Character quota exceeded'
                          : genResult.status === 429 ? 'TTS Monster: Rate limit hit'
                          : `TTS Monster error ${genResult.status}: ${JSON.stringify(genResult.data)}`;
                return res.status(500).json({ ok: false, error: msg });
            }
            const audioChunks = await new Promise((resolve, reject) => {
                https.get(genResult.data.url, (resp) => {
                    const chunks = [];
                    resp.on('data', d => chunks.push(d));
                    resp.on('end', () => resolve(chunks));
                }).on('error', reject);
            });
            const tmpDir = getDataPath('tts-tmp');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `tts_${Date.now()}.wav`);
            fs.writeFileSync(tmpFile, Buffer.concat(audioChunks));
            try {
                const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('tts_') && f.endsWith('.wav'))
                    .map(f => ({ f, t: fs.statSync(path.join(tmpDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
                files.slice(10).forEach(({ f }) => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch(e) {} });
            } catch(e) {}
            const volume = (ttsVolume !== undefined && !isNaN(ttsVolume)) ? Math.min(1, Math.max(0, ttsVolume)) : 1;
            if (videoWin && !videoWin.isDestroyed()) {
                broadcastVideoCmd({ cmd: 'PLAYSOUND', id: id ? String(id) : ('tts_' + Date.now()), path: tmpFile,
                    startMs: 0, endMs: 0, volume, isTTS: true, ttsSourceId: id ? String(id) : null,
                    clearMediaId: clearMediaId || null, clearMediaKind: clearMediaKind || null });
            }
            res.json({ ok: true });
        } catch(e) {
            console.error('[TTS Monster error]', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ---- GIVEAWAY ----
    let giveawayOpen = false;
    let giveawayEntries = [];
    let giveawayKeyword = '!enter';
    let giveawaySubOnly = false;
    let giveawayMessage = 'Wheel open! Type {keyword} to enter!';
    const giveawayClients = [];

    function gwLoad() {
        try {
            const p = getDataPath('giveaway.json');
            if (fs.existsSync(p)) {
                const d = JSON.parse(fs.readFileSync(p, 'utf8'));
                giveawayEntries = d.entries || [];
                giveawayKeyword = d.keyword || '!enter';
                giveawaySubOnly = !!d.subOnly;
                giveawayMessage = d.message || 'Wheel open! Type {keyword} to enter!';
                giveawayOpen = !!d.open;
            }
        } catch(e) {}
    }
    function gwSave() {
        try {
            const p = getDataPath('giveaway.json');
            fs.writeFileSync(p, JSON.stringify({ entries: giveawayEntries, keyword: giveawayKeyword, subOnly: giveawaySubOnly, message: giveawayMessage, open: giveawayOpen }, null, 2));
        } catch(e) {}
    }
    gwLoad();

    server.get('/api/giveaway/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        giveawayClients.push(res);
        req.on('close', () => {
            const i = giveawayClients.indexOf(res);
            if (i !== -1) giveawayClients.splice(i, 1);
        });
    });

    function broadcastGiveaway(data) {
        const payload = 'data: ' + JSON.stringify(data) + '\n\n';
        giveawayClients.forEach(c => c.write(payload));
    }

    server.post('/api/giveaway/toggle', (req, res) => {
        const { open, keyword, subOnly, message } = req.body;
        giveawayOpen = !!open;
        if (keyword) giveawayKeyword = keyword.trim();
        giveawaySubOnly = !!subOnly;
        if (message !== undefined) giveawayMessage = message;
        if (!giveawayOpen) {
            sendChatMessage('Entries are now closed!');
        } else {
            giveawayEntries = [];
            const chatMsg = giveawayMessage.replace(/\{keyword\}/g, giveawayKeyword);
            sendChatMessage(chatMsg);
        }
        gwSave();
        res.json({ ok: true });
    });

    server.post('/api/giveaway/enter', (req, res) => {
        const { username, isSub } = req.body;
        if (!giveawayOpen) return res.json({ ok: false, error: 'closed' });
        if (giveawaySubOnly && !isSub) return res.json({ ok: false, error: 'subs only' });
        const name = (username || '').toLowerCase().trim();
        if (!name) return res.json({ ok: false });
        if (giveawayEntries.includes(name)) return res.json({ ok: false, error: 'duplicate' });
        giveawayEntries.push(name);
        broadcastGiveaway({ type: 'entry', username: name });
        gwSave();
        res.json({ ok: true });
    });

    server.post('/api/giveaway/announce', (req, res) => {
        const { winner } = req.body;
        if (winner) sendChatMessage('The winner is @' + winner + '! Congratulations!');
        res.json({ ok: true });
    });

    server.post('/api/giveaway/reset', (req, res) => {
        giveawayOpen = false;
        giveawayEntries = [];
        giveawayKeyword = '!enter';
        giveawaySubOnly = false;
        giveawayMessage = 'Wheel open! Type {keyword} to enter!';
        gwSave();
        res.json({ ok: true });
    });

    function sendChatMessage(msg) {
        try {
            const net2 = require('net');
            const sock = new net2.Socket();
            sock.connect(9002, '127.0.0.1', () => { sock.write(msg); sock.destroy(); });
            sock.on('error', () => {});
        } catch(e) {}
    }

    server.get('/api/giveaway/status', (req, res) => {
        res.json({ open: giveawayOpen, keyword: giveawayKeyword, subOnly: giveawaySubOnly, entries: giveawayEntries, message: giveawayMessage });
    });


    // ---- STATIC (must be last) ----
    server.use(express.static(path.join(appDir, 'dashboard'), { index: false }));

    // Fire a specific source by id (used by hotkeys)
    server.post('/api/overlay/fire-source', async (req, res) => {
        try {
            const { sourceId } = req.body;
            const p = getDataPath('overlay-sources.json');
            if (!fs.existsSync(p)) return res.json({ ok: false });
            const sources = JSON.parse(fs.readFileSync(p, 'utf8'));
            const src = sources.find(s => String(s.id) === String(sourceId));
            if (!src) return res.json({ ok: false, error: 'source not found' });

            const hasImage = src.type === 'image' || src.type === 'image+sound';
            const hasSound = src.type === 'sound' || src.type === 'image+sound' || src.type === 'video+sound';
            const hasVideo = src.type === 'video' || src.type === 'video+sound';
            const hasText  = !!(src.text);
            const isGif = hasImage && src.path && src.path.toLowerCase().endsWith('.gif');

            const overlayCmdPath = getDataPath('overlay-cmd.txt');
            const overlayCmdTmp  = getDataPath('overlay-cmd.tmp');
            function writeOverlayCmd(line) {
                try { fs.writeFileSync(overlayCmdTmp, line); fs.renameSync(overlayCmdTmp, overlayCmdPath); } catch(e) {}
            }

            if (hasImage && (videoWinMode === 'stream' ? videoOverlayClients.length > 0 : (videoWin && !videoWin.isDestroyed()))) {
                const loops = src.clearWithTTS ? 0 : 0;
                const displaySeconds = src.clearWithTTS ? 0 : (isGif ? (src.gifLoops || 0) : (src.displaySeconds || 0));
                broadcastVideoCmd({ cmd: 'PLAYIMG', id: src.id, path: src.path, loops, displaySeconds,
                    x: src.mediaX || 0, y: src.mediaY || 0, w: src.mediaW || 400, h: src.mediaH || 300,
                    chromaKey: src.chromaKey || false, chromaColor: src.chromaColor || '#00ff00', chromaThreshold: src.chromaThreshold ?? 40 });
            }
            if (hasVideo && (videoWinMode === 'stream' ? videoOverlayClients.length > 0 : (videoWin && !videoWin.isDestroyed()))) {
                const loops = src.clearWithTTS ? 0 : (hasSound ? 0 : (src.videoLoops || 1));
                broadcastVideoCmd({ cmd: 'PLAYVID', id: src.id, path: src.videoPath, loops,
                    videoStart: src.videoStart || 0, videoEnd: src.videoEnd || 0, volume: src.videoVolume ?? 1,
                    x: src.mediaX || 0, y: src.mediaY || 0, w: src.mediaW || 400, h: src.mediaH || 300,
                    chromaKey: src.chromaKey || false, chromaColor: src.chromaColor || '#00ff00', chromaThreshold: src.chromaThreshold ?? 40 });
            }
            if (hasSound && videoWin && !videoWin.isDestroyed()) {
                const startMs = Math.round((src.soundStart || 0) * 1000);
                const endMs   = Math.round((src.soundEnd   || 0) * 1000);
                broadcastVideoCmd({ cmd: 'PLAYSOUND', id: src.id, path: src.soundPath, startMs, endMs, volume: src.soundVolume ?? 1 });
                if ((hasImage || hasVideo) && endMs > startMs) {
                    const displayMs = endMs - startMs;
                    setTimeout(() => {
                        if (hasImage) broadcastVideoCmd({ cmd: 'CLEARIMG', id: src.id });
                        if (hasVideo) broadcastVideoCmd({ cmd: 'CLEARVID', id: src.id });
                    }, displayMs);
                }
            }
            if (hasText && textWin && !textWin.isDestroyed()) {
                const clearMediaId = (src.clearWithTTS && (hasImage || hasVideo)) ? src.id : null;
                const clearMediaKind = clearMediaId ? (hasImage ? 'image' : 'video') : null;
                broadcastTextCmd({ cmd: 'ADDTEXT', id: src.id, text: src.text,
                    x: src.x || 100, y: src.y || 100, font: src.font, size: src.fontSize, color: src.color,
                    bold: src.bold, italic: src.italic, shadow: src.shadow, animation: src.animation,
                    animDuration: src.animDuration, maxW: src.maxW, maxH: src.maxH || 0,
                    speak: src.speak || false, voice: src.voice || null,
                    ttsRate: src.ttsRate || 1, ttsPitch: src.ttsPitch || 1, ttsVolume: src.ttsVolume ?? 1,
                    clearMediaId, clearMediaKind });
                if ((src.displaySeconds || 0) > 0 && !src.speak) {
                    setTimeout(() => broadcastTextCmd({ cmd: 'CLEARTEXT', id: src.id }), src.displaySeconds * 1000);
                }
            }
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    server.listen(3000, () => {
        console.log('Server running on port 3000');
        global.broadcastChat = server.broadcastChat;
        if (mainWindow) mainWindow.loadURL('http://localhost:3000');
        registerHotkeys();
        // Start EventSub if streamer is already authed
        setTimeout(() => {
            try {
                const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
                if (cfg.streamerToken && cfg.setupComplete) startEventSub();
            } catch(e) {}
        }, 3000);
    });
}

// ── EventSub WebSocket Engine ─────────────────────────────────────────────────
const axiosEventsub = require('axios');
let eventsubWs = null;
let eventsubConnected = false;
let eventsubSessionId = null;
let eventsubReconnectTimer = null;
let eventsubKeepaliveTimer = null;
let _eventsubClientId = null;
let _eventsubToken = null;

function getDataPathEventsub(file) {
    const { app } = require('electron');
    return require('path').join(app.getPath('userData'), file);
}

function startEventSub() {
    try {
        const cfg = JSON.parse(require('fs').readFileSync(getDataPathEventsub('config.json'), 'utf8'));
        const token = (cfg.streamerToken || '').replace('oauth:', '');
        if (!token) return;
        _eventsubToken = token;
        _eventsubClientId = process.env.TWITCH_CLIENT_ID || require('dotenv').config() && process.env.TWITCH_CLIENT_ID;
        // Re-read from env
        const envPath = require('path').join(process.resourcesPath || __dirname, '.env');
        if (require('fs').existsSync(envPath)) require('dotenv').config({ path: envPath });
        _eventsubClientId = process.env.TWITCH_CLIENT_ID;
        if (eventsubWs) { try { eventsubWs.close(); } catch(e) {} }
        if (eventsubReconnectTimer) { clearTimeout(eventsubReconnectTimer); eventsubReconnectTimer = null; }
        _eventsubConnect();
    } catch(e) { console.log('[eventsub] startEventSub error:', e.message); }
}

function _eventsubConnect() {
    const WebSocket = require('ws') || (() => { try { return require('ws'); } catch(e) { return null; } })();
    if (!WebSocket) { console.log('[eventsub] ws module not available'); return; }
    console.log('[eventsub] connecting...');
    eventsubWs = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

    eventsubWs.on('open', () => { console.log('[eventsub] connected'); });

    eventsubWs.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch(e) { return; }
        const type = msg.metadata?.message_type;

        if (type === 'session_welcome') {
            eventsubConnected = true;
            eventsubSessionId = msg.payload?.session?.id;
            console.log('[eventsub] session:', eventsubSessionId);
            await _eventsubSubscribeAll();
            // Keepalive: Twitch sends session_keepalive every 10s — restart timer on any message
            _eventsubResetKeepalive(msg.payload?.session?.keepalive_timeout_seconds || 10);
        }
        else if (type === 'session_keepalive') {
            _eventsubResetKeepalive(10);
        }
        else if (type === 'session_reconnect') {
            const url = msg.payload?.session?.reconnect_url;
            if (url) { eventsubWs.close(); _eventsubConnectTo(url); }
        }
        else if (type === 'notification') {
            _eventsubResetKeepalive(10);
            _eventsubHandleEvent(msg.payload?.subscription?.type, msg.payload?.event);
        }
        else if (type === 'revocation') {
            console.log('[eventsub] subscription revoked:', msg.payload?.subscription?.type);
        }
    });

    eventsubWs.on('close', () => {
        console.log('[eventsub] disconnected, reconnecting in 15s...');
        eventsubConnected = false; eventsubSessionId = null;
        if (eventsubKeepaliveTimer) { clearTimeout(eventsubKeepaliveTimer); eventsubKeepaliveTimer = null; }
        eventsubReconnectTimer = setTimeout(_eventsubConnect, 15000);
    });

    eventsubWs.on('error', (e) => { console.log('[eventsub] error:', e.message); });
}

function _eventsubConnectTo(url) {
    const WebSocket = require('ws');
    eventsubWs = new WebSocket(url);
    eventsubWs.on('open', () => {});
    eventsubWs.on('message', async (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch(e) { return; }
        if (msg.metadata?.message_type === 'session_welcome') {
            eventsubConnected = true; eventsubSessionId = msg.payload?.session?.id;
            await _eventsubSubscribeAll();
        } else if (msg.metadata?.message_type === 'notification') {
            _eventsubHandleEvent(msg.payload?.subscription?.type, msg.payload?.event);
        }
    });
    eventsubWs.on('close', () => { eventsubConnected = false; eventsubReconnectTimer = setTimeout(_eventsubConnect, 15000); });
    eventsubWs.on('error', (e) => { console.log('[eventsub] reconnect error:', e.message); });
}

function _eventsubResetKeepalive(secs) {
    if (eventsubKeepaliveTimer) clearTimeout(eventsubKeepaliveTimer);
    eventsubKeepaliveTimer = setTimeout(() => {
        console.log('[eventsub] keepalive timeout, reconnecting...');
        if (eventsubWs) try { eventsubWs.close(); } catch(e) {}
    }, (secs + 5) * 1000);
}

async function _eventsubSubscribeAll() {
    if (!eventsubSessionId || !_eventsubToken || !_eventsubClientId) return;
    let broadcasterId;
    try {
        const r = await axiosEventsub.get('https://api.twitch.tv/helix/users', {
            headers: { 'Authorization': `Bearer ${_eventsubToken}`, 'Client-Id': _eventsubClientId }
        });
        broadcasterId = r.data?.data?.[0]?.id;
    } catch(e) { console.log('[eventsub] failed to get broadcaster id:', e.message); return; }
    if (!broadcasterId) return;

    const subs = [
        { type: 'channel.follow',                                    version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
        { type: 'channel.subscribe',                                  version: '1', condition: { broadcaster_user_id: broadcasterId } },
        { type: 'channel.subscription.gift',                          version: '1', condition: { broadcaster_user_id: broadcasterId } },
        { type: 'channel.cheer',                                      version: '1', condition: { broadcaster_user_id: broadcasterId } },
        { type: 'channel.raid',                                       version: '1', condition: { to_broadcaster_user_id: broadcasterId } },
        { type: 'channel.channel_points_custom_reward_redemption.add',version: '1', condition: { broadcaster_user_id: broadcasterId } },
        { type: 'channel.hype_train.begin',                           version: '2', condition: { broadcaster_user_id: broadcasterId } },
    ];

    for (const sub of subs) {
        try {
            await axiosEventsub.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
                type: sub.type, version: sub.version, condition: sub.condition,
                transport: { method: 'websocket', session_id: eventsubSessionId }
            }, { headers: { 'Authorization': `Bearer ${_eventsubToken}`, 'Client-Id': _eventsubClientId, 'Content-Type': 'application/json' } });
            console.log('[eventsub] subscribed:', sub.type);
        } catch(e) {
            const msg = e.response?.data?.message || e.message;
            console.log('[eventsub] sub failed:', sub.type, msg);
        }
    }
}

function _eventsubHandleEvent(type, event) {
    if (!event) return;
    const alerts = (() => { try { return JSON.parse(fs.readFileSync(getDataPath('eventsub-alerts.json'), 'utf8')); } catch(e) { return {}; } })();

    const keyMap = {
        'channel.follow': 'follow',
        'channel.subscribe': 'sub',
        'channel.subscription.gift': 'giftsub',
        'channel.cheer': 'cheer',
        'channel.raid': 'raid',
        'channel.channel_points_custom_reward_redemption.add': 'redeem',
        'channel.hype_train.begin': 'hype',
    };
    const key = keyMap[type];
    console.log('[eventsub] event received:', type, '->', key, '| alerts keys:', Object.keys(alerts));

    if (key === 'redeem' && event.reward?.title) {
        const rewardTitle = event.reward.title.trim().toLowerCase();
        try {
            const sources = JSON.parse(fs.readFileSync(getDataPath('overlay-sources.json'), 'utf8'));
            const match = sources.find(s => s.channelPointName && s.channelPointName.trim().toLowerCase() === rewardTitle);
            if (match) {
                const src = Object.assign({}, match);
                if (src.text && event.user_input) src.text = src.text.replace('{message}', event.user_input);
                const body = JSON.stringify({ eventsubSrc: src });
                const http = require('http');
                const opts = { hostname: '127.0.0.1', port: 3000, path: '/api/eventsub/fire', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
                const req = http.request(opts, () => {}); req.on('error', () => {}); req.write(body); req.end();
                return;
            }
        } catch(e) {}
    }

    if (!key || !alerts[key]) { console.log('[eventsub] no alert configured for:', key); return; }

    const src = Object.assign({}, alerts[key]);

    // Resolve dynamic text variables
    if (src.text) {
        const vars = {
            '{username}': event.user_name || event.broadcaster_user_name || '',
            '{gifter}': event.user_name || '',
            '{count}': String(event.total || 1),
            '{bits}': String(event.bits || 0),
            '{raider}': event.from_broadcaster_user_name || '',
            '{viewers}': String(event.viewers || 0),
            '{reward}': event.reward?.title || '',
            '{message}': event.message?.text || event.user_input || '',
        };
        let text = src.text;
        Object.entries(vars).forEach(([k, v]) => { text = text.split(k).join(v); });
        src.text = text;
    }

    console.log('[eventsub] firing alert for:', key, '—', src.text || '(no text)');

    // Fire via the existing fire-source HTTP route so we stay in scope
    const body = JSON.stringify({ eventsubSrc: src });
    const http = require('http');
    const opts = { hostname: '127.0.0.1', port: 3000, path: '/api/eventsub/fire', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = http.request(opts, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
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
        if (chatWin && !chatWin.isDestroyed()) chatWin.destroy();
        if (modWin && !modWin.isDestroyed()) modWin.destroy();
        if (videoWin && !videoWin.isDestroyed()) videoWin.destroy();
        if (songWin && !songWin.isDestroyed()) songWin.destroy();
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

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    // Only quit if the main window is actually gone; child windows being hidden should not exit the app
    if (mainWindow && !mainWindow.isDestroyed()) return;
    if (botProcess) botProcess.kill();
    if (reactorProcess) reactorProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});