require('dotenv').config();
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

app.get('/test', (req, res) => {
    res.send('working');
});

app.get('/', (req, res) => {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    if (!config.setupComplete) {
        res.redirect('/setup');
    } else {
        res.sendFile(path.join(__dirname, 'dashboard/index.html'));
    }
});

app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, 'setup.html'));
});

app.get('/auth/twitch', (req, res) => {
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.TWITCH_REDIRECT_URI
            }
        });
        const accessToken = response.data.access_token;
        const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const botUsername = userResponse.data.data[0].login;
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        config.token = `oauth:${accessToken}`;
        config.botUsername = botUsername;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
        res.redirect('/setup?authenticated=true');
    } catch (err) {
        console.error(err);
        res.send('Authentication failed. Please try again.');
    }
});

app.post('/api/setup', (req, res) => {
    const { botUsername, token, channel, setupComplete } = req.body;
    const config = { botUsername, token, channel, setupComplete };
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
    res.json({ success: true });
});
// OBS Settings
app.get('/api/obs-settings', (req, res) => {
    const cfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
    res.json({
        obsHost: cfg.obsHost || 'localhost',
        obsPort: cfg.obsPort || '4455',
        obsPassword: cfg.obsPassword || '',
        obsAutoConnect: cfg.obsAutoConnect || false
    });
});

app.post('/api/obs-settings', express.json(), (req, res) => {
    const cfgPath = getDataPath('config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.obsHost = req.body.obsHost || 'localhost';
    cfg.obsPort = req.body.obsPort || '4455';
    cfg.obsPassword = req.body.obsPassword || '';
    cfg.obsAutoConnect = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4));
    res.json({ ok: true });
});
app.get('/api/commands', (req, res) => {
    const commands = JSON.parse(fs.readFileSync('./commands.json', 'utf8'));
    res.json(commands);
});

app.post('/api/commands', (req, res) => {
    const { command, response } = req.body;
    const commands = JSON.parse(fs.readFileSync('./commands.json', 'utf8'));
    commands[command] = { response };
    fs.writeFileSync('./commands.json', JSON.stringify(commands, null, 4));
    res.json({ success: true });
});

app.delete('/api/commands/:command', (req, res) => {
    const command = decodeURIComponent(req.params.command);
    const commands = JSON.parse(fs.readFileSync('./commands.json', 'utf8'));
    delete commands[command];
    fs.writeFileSync('./commands.json', JSON.stringify(commands, null, 4));
    res.json({ success: true });
});
app.get('/api/config', (req, res) => {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    res.json(config);
});
app.use(express.static('dashboard'));
console.log('About to start listening...');
app.listen(3000, '0.0.0.0', () => {
    console.log('Dashboard running at http://localhost:3000');
}).on('error', (err) => {
    console.error('Server error:', err);
});
process.on('uncaughtException', (err) => {
    console.error('Error:', err);
});