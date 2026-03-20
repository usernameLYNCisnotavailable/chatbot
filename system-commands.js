/**
 * mention-command.js
 * Hardcoded system command: @user Mentions → Discord webhook notification
 * Registers all /api/mentions/* routes onto the Express server
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const MENTION_KEY = '@mentions';

function registerMentionRoutes(server, getDataPath) {

    // ── GET config ────────────────────────────────────────────────────────────
    server.get('/api/mentions/config', (req, res) => {
        res.json(getMentionConfig(getDataPath));
    });

    // ── SAVE config ───────────────────────────────────────────────────────────
    server.post('/api/mentions/config', (req, res) => {
        try {
            const existing = getMentionConfig(getDataPath);
            const updated  = Object.assign({}, existing, req.body);
            saveMentionConfig(getDataPath, updated);
            res.json({ ok: true });
        } catch(e) {
            res.json({ ok: false, error: e.message });
        }
    });

    // ── FIRE (called by index.js when @mention detected) ──────────────────────
    server.post('/api/mentions/fire', async (req, res) => {
        try {
            const { mentionedUser, channel } = req.body;
            const cfg = getMentionConfig(getDataPath);

            if (!cfg.enabled)  return res.json({ ok: false, reason: 'disabled' });
            if (!cfg.webhook)  return res.json({ ok: false, reason: 'no webhook' });

            // Per-user cooldown
            const now     = Date.now();
            const cdMs    = (cfg.cooldown ?? 300) * 1000;
            const lastKey = 'mention_cd_' + (mentionedUser || '').toLowerCase();
            if (!registerMentionRoutes._cdMap) registerMentionRoutes._cdMap = {};
            const last = registerMentionRoutes._cdMap[lastKey] || 0;
            if (now - last < cdMs) return res.json({ ok: false, reason: 'cooldown' });
            registerMentionRoutes._cdMap[lastKey] = now;

            // Build message
            const streamCfg = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const channelName = (channel || streamCfg.channel || '').replace('#', '');
            const template = cfg.message || '@{mentioned} you were mentioned in chat!';
            const text = template.replace(/\{mentioned\}/g, mentionedUser)
                + '\nhttps://twitch.tv/' + channelName;

            await axios.post(cfg.webhook, { content: text });
            res.json({ ok: true });
        } catch(e) {
            console.error('[mention]', e.message);
            res.json({ ok: false, error: e.message });
        }
    });
}

function getMentionConfig(getDataPath) {
    const p = getDataPath('mention-config.json');
    if (!fs.existsSync(p)) {
        return {
            enabled:  false,
            webhook:  '',
            message:  '@{mentioned} you were mentioned in chat!',
            cooldown: 300,
            access:   'everyone'
        };
    }
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {
        return { enabled: false, webhook: '', message: '@{mentioned} you were mentioned in chat!', cooldown: 300, access: 'everyone' };
    }
}

function saveMentionConfig(getDataPath, cfg) {
    fs.writeFileSync(getDataPath('mention-config.json'), JSON.stringify(cfg, null, 2));
}

module.exports = { registerMentionRoutes, getMentionConfig };