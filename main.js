const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
let mainWindow;
let botProcess = null;
let reactorProcess = null;
let chatWin = null;
let modWin = null;

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
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit+user:read:email+moderation:read+user:read:moderated_channels&state=streamer&force_verify=true`;
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
                    existing.token = `oauth:${accessToken}`;
                    existing.displayName = displayName;
                    existing.avatar = avatar;
                } else {
                    config.mods.push({
                        username,
                        displayName,
                        avatar,
                        token: `oauth:${accessToken}`,
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
                // Push the Electron app window to the next setup step
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
        config.setupComplete = false;
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

    // Open standalone chat window
    server.get('/api/chat/open', (req, res) => {
        if (chatWin && !chatWin.isDestroyed()) {
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
        chatWin.on('closed', () => { chatWin = null; });
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
        modWin.on('closed', () => { modWin = null; });
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
        if (chatWin && !chatWin.isDestroyed()) chatWin.close();
        if (modWin && !modWin.isDestroyed()) modWin.close();
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