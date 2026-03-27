/**
 * system-commands.js
 * Hardcoded system commands for ChatCommander.
 * Required by main.js via registerSystemRoutes(server, getDataPath).
 *
 * Each hardcoded command gets its own section here.
 * API routes for these commands live in presets.js.
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

function registerSystemRoutes(server, getDataPath) {

    // ── @USER MENTIONS ────────────────────────────────────────────────────────
    // Config + fire routes are in presets.js
    // This file handles any server-side logic needed beyond the API routes

}

// ── MENTION HELPERS (used by presets.js and index.js) ─────────────────────────

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

module.exports = { registerSystemRoutes, getMentionConfig };