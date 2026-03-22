/**
 * security.js
 * Security utilities for ChatCommander:
 *  - Token encryption/decryption (AES-256-GCM)
 *  - API session token (server auth middleware)
 *  - Key derivation from machine-specific path
 */

const crypto = require('crypto');
const path   = require('path');

// ── KEY DERIVATION ─────────────────────────────────────────────────────────────
// Derives a 32-byte key from the userData path — unique per machine/user account.
// Not a strong secret but prevents casual file inspection on another machine.

function deriveKey(userDataPath) {
    return crypto.createHash('sha256')
        .update('chatcommander-v1:' + userDataPath)
        .digest();
}

// ── TOKEN ENCRYPTION ───────────────────────────────────────────────────────────

function encryptToken(plainText, userDataPath) {
    if (!plainText) return '';
    // If already encrypted (has our prefix), return as-is
    if (plainText.startsWith('enc:')) return plainText;
    try {
        const key  = deriveKey(userDataPath);
        const iv   = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
        const tag  = cipher.getAuthTag();
        // Format: enc:<iv_hex>:<tag_hex>:<data_hex>
        return 'enc:' + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
    } catch(e) {
        console.error('[security] encrypt failed:', e.message);
        return plainText;
    }
}

function decryptToken(encrypted, userDataPath) {
    if (!encrypted) return '';
    // If not encrypted (plain text or oauth: prefix), return as-is
    if (!encrypted.startsWith('enc:')) return encrypted;
    try {
        const parts = encrypted.slice(4).split(':');
        if (parts.length !== 3) return encrypted;
        const key       = deriveKey(userDataPath);
        const iv        = Buffer.from(parts[0], 'hex');
        const tag       = Buffer.from(parts[1], 'hex');
        const data      = Buffer.from(parts[2], 'hex');
        const decipher  = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(data) + decipher.final('utf8');
    } catch(e) {
        console.error('[security] decrypt failed:', e.message);
        return '';
    }
}

// ── API SESSION TOKEN ──────────────────────────────────────────────────────────
// Generated once per app session, required on all API requests.
// Dashboard receives it via /api/session-token (localhost only).

let _sessionToken = null;

function generateSessionToken() {
    _sessionToken = crypto.randomBytes(32).toString('hex');
    return _sessionToken;
}

function getSessionToken() {
    if (!_sessionToken) generateSessionToken();
    return _sessionToken;
}

function apiAuthMiddleware(req, res, next) {
    // Allow localhost health check and session token endpoint through
    const open = ['/api/session-token', '/test', '/auth/', '/setup', '/onboarding'];
    if (open.some(p => req.path.startsWith(p))) return next();

    // Static files — no auth needed
    const ext = path.extname(req.path);
    if (ext && ext !== '.json') return next();

    const token = req.headers['x-cc-token'] || req.query._cct;
    if (token && token === _sessionToken) return next();

    // Allow requests from Electron renderer (no external origin)
    const origin = req.headers.origin || '';
    if (!origin || origin.startsWith('http://localhost')) return next();

    res.status(401).json({ error: 'Unauthorized' });
}

function registerSecurityRoutes(server) {
    // Only accessible from localhost — gives dashboard the session token
    server.get('/api/session-token', (req, res) => {
        const host = req.hostname || req.headers.host || '';
        if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        res.json({ token: getSessionToken() });
    });
}

module.exports = {
    encryptToken,
    decryptToken,
    generateSessionToken,
    getSessionToken,
    apiAuthMiddleware,
    registerSecurityRoutes
};