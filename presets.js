/**
 * presets.js
 * All preset-related Express routes for ChatCommander.
 * Required by main.js via registerPresetRoutes(server, getDataPath).
 *
 * Covers:
 *  - /api/presets          — preset config storage
 *  - /api/mentions/*       — @ mention alert config + webhook firing
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

// ── COOLDOWN MAP (in-memory, resets on restart) ───────────────────────────────
const _mentionCdMap = {};

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

function registerPresetRoutes(server, getDataPath) {

    // ── PRESETS CONFIG ────────────────────────────────────────────────────────

    server.get('/api/presets', (req, res) => {
        const p = getDataPath('presets.json');
        try { res.json(JSON.parse(fs.readFileSync(p, 'utf8'))); }
        catch(e) { res.json({}); }
    });

    server.post('/api/presets', (req, res) => {
        try {
            fs.writeFileSync(getDataPath('presets.json'), JSON.stringify(req.body, null, 2));
            res.json({ ok: true });
        } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // ── MENTION ALERTS CONFIG ─────────────────────────────────────────────────

    server.get('/api/mentions/config', (req, res) => {
        res.json(getMentionConfig(getDataPath));
    });

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

    // ── MENTION ALERTS FIRE ───────────────────────────────────────────────────

    server.post('/api/mentions/fire', async (req, res) => {
        try {
            const { mentionedUser, channel } = req.body;
            const cfg = getMentionConfig(getDataPath);

            if (!cfg.enabled) return res.json({ ok: false, reason: 'disabled' });
            if (!cfg.webhook) return res.json({ ok: false, reason: 'no webhook' });

            // Per-user cooldown
            const now     = Date.now();
            const cdMs    = (cfg.cooldown ?? 300) * 1000;
            const lastKey = 'mention_cd_' + (mentionedUser || '').toLowerCase();
            const last    = _mentionCdMap[lastKey] || 0;
            if (now - last < cdMs) return res.json({ ok: false, reason: 'cooldown' });
            _mentionCdMap[lastKey] = now;

            // Build and send message
            const streamCfg  = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
            const channelName = (channel || streamCfg.channel || '').replace('#', '');
            const template   = cfg.message || '@{mentioned} you were mentioned in chat!';
            const text       = template.replace(/\{mentioned\}/g, mentionedUser)
                             + '\nhttps://twitch.tv/' + channelName;

            await axios.post(cfg.webhook, { content: text });
            console.log('[mentions] fired for:', mentionedUser);
            res.json({ ok: true });
        } catch(e) {
            console.error('[mentions]', e.message);
            res.json({ ok: false, error: e.message });
        }
    });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getMentionConfig(getDataPath) {
    const p = getDataPath('mention-config.json');
    const defaults = {
        enabled:  false,
        webhook:  '',
        message:  '@{mentioned} you were mentioned in chat!',
        cooldown: 300,
        access:   'everyone'
    };
    if (!fs.existsSync(p)) return defaults;
    try { return Object.assign({}, defaults, JSON.parse(fs.readFileSync(p, 'utf8'))); }
    catch(e) { return defaults; }
}

function saveMentionConfig(getDataPath, cfg) {
    fs.writeFileSync(getDataPath('mention-config.json'), JSON.stringify(cfg, null, 2));
}

module.exports = { registerPresetRoutes, getMentionConfig };