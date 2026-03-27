const net = require('net');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.CHATCOMMANDER_DATA_PATH || '.';
const memoryPath = path.join(dataDir, 'memory.json');
const actionsDir = path.join(dataDir, 'actions');

// ── MEMORY ────────────────────────────────────────────────────────────────────

function memoryGet(key) {
    try {
        if (!fs.existsSync(memoryPath)) return '';
        const mem = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
        return mem[key] !== undefined ? String(mem[key]) : '';
    } catch(e) { return ''; }
}

function memorySet(key, value) {
    try {
        let mem = {};
        if (fs.existsSync(memoryPath)) {
            try { mem = JSON.parse(fs.readFileSync(memoryPath, 'utf8')); } catch(e) {}
        }
        mem[key] = value;
        fs.writeFileSync(memoryPath, JSON.stringify(mem, null, 4));
    } catch(e) {}
}

// ── SEND TO BOT (port 9001) ───────────────────────────────────────────────────

function sendToBot(msg) {
    const socket = new net.Socket();
    socket.connect(9001, '127.0.0.1', () => {
        socket.write(msg);
        socket.end();
    });
    socket.on('error', () => {});
}

// ── COMPILE (validate JS syntax) ─────────────────────────────────────────────

function compileAction(name, code) {
    try {
        if (!fs.existsSync(actionsDir)) fs.mkdirSync(actionsDir, { recursive: true });
        // Validate syntax by wrapping in a function — catches syntax errors without running
        new Function('username', 'message', 'args', 'channel', 'memoryGet', 'memorySet', 'sendToBot', code);
        // Save the JS file
        const jsPath = path.join(actionsDir, name + '.js');
        fs.writeFileSync(jsPath, code);
        console.log('[reactor] Compiled JS action:', name);
        return 'OK';
    } catch(e) {
        console.log('[reactor] Compile error:', e.message);
        return 'COMPILE_ERROR:' + e.message;
    }
}

// ── RUN ACTION ────────────────────────────────────────────────────────────────

function runAction(name, username, message, args, channel) {
    const jsPath = path.join(actionsDir, name + '.js');
    if (!fs.existsSync(jsPath)) {
        console.log('[reactor] Action not found:', jsPath);
        return;
    }
    try {
        const code = fs.readFileSync(jsPath, 'utf8');
        const fn = new Function('username', 'message', 'args', 'channel', 'memoryGet', 'memorySet', 'sendToBot', code);
        fn(username, message, args, channel, memoryGet, memorySet, sendToBot);
        console.log('[reactor] Action ran:', name);
    } catch(e) {
        console.log('[reactor] Action error:', name, e.message);
    }
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────

function handleMessage(raw, socket) {
    // COMPILE:name:code
    if (raw.startsWith('COMPILE:')) {
        const rest = raw.slice(8);
        const sep = rest.indexOf(':');
        if (sep === -1) {
            const err = 'COMPILE_RESULT:COMPILE_ERROR:Bad format';
            socket.write(err);
            return;
        }
        const name = rest.slice(0, sep);
        const code = rest.slice(sep + 1);
        console.log('[reactor] Compiling action:', name);
        const result = compileAction(name, code);
        socket.write('COMPILE_RESULT:' + result);
        return;
    }

    // RUN:name:username:message:args:channel
    if (raw.startsWith('RUN:')) {
        const parts = raw.slice(4).split(':');
        const [name, username, message, args, channel] = parts;
        runAction(name, username || '', message || '', args || '', channel || '');
        return;
    }

    // COMMAND:name:username:message:args:channel
    if (raw.startsWith('COMMAND:')) {
        const rest = raw.slice(8);
        const parts = rest.split(':');
        const [command, username, message, args, channel] = parts;
        console.log('[reactor] Chat command:', command, 'from', username);
        runAction(command, username || '', message || '', args || '', channel || '');
        return;
    }

    // MEMORY_GET:key
    if (raw.startsWith('MEMORY_GET:')) {
        const key = raw.slice(11);
        const value = memoryGet(key);
        socket.write(value);
        console.log('[reactor] MEMORY_GET:', key, '=', value);
        return;
    }

    // MEMORY_SET:key:value
    if (raw.startsWith('MEMORY_SET:')) {
        const rest = raw.slice(11);
        const sep = rest.indexOf(':');
        if (sep !== -1) {
            const key = rest.slice(0, sep);
            const value = rest.slice(sep + 1);
            memorySet(key, value);
            socket.write('OK');
            console.log('[reactor] MEMORY_SET:', key, '=', value);
        }
        return;
    }

    console.log('[reactor] Unknown command:', raw.slice(0, 80));
}

// ── TCP SERVER (port 9000) ────────────────────────────────────────────────────

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
        const raw = data.trim();
        if (raw) handleMessage(raw, socket);
        socket.end();
    });
    socket.on('error', () => {});
});

server.listen(9000, '127.0.0.1', () => {
    console.log('JS Reactor running on port 9000');
    console.log('Actions directory:', actionsDir);
});