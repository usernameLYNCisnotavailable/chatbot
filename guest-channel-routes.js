// ---- GUEST CHANNELS API ----
// Add these routes to main.js alongside your other /api/ routes.
// The bot process (index.js) manages the actual tmi.js join/part.
// These routes just relay commands to index.js via a new port (9003).

// In index.js, add a listener on port 9003 that handles join/leave commands.
// See index.js output for full implementation — these routes call that listener.

app.get('/api/guest-channels', (req, res) => {
  // Ask index.js for current guest channel list
  const net = require('net');
  const client = new net.Socket();
  let data = '';
  client.connect(9003, '127.0.0.1', () => {
    client.write('LIST');
  });
  client.on('data', (chunk) => { data += chunk.toString(); });
  client.on('end', () => {
    try { res.json(JSON.parse(data)); }
    catch(e) { res.json([]); }
  });
  client.on('error', () => res.json([]));
});

app.post('/api/guest-channels/join', express.json(), (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.json({ success: false, error: 'No channel provided' });
  const net = require('net');
  const client = new net.Socket();
  let data = '';
  client.connect(9003, '127.0.0.1', () => {
    client.write('JOIN:' + channel);
  });
  client.on('data', (chunk) => { data += chunk.toString(); });
  client.on('end', () => {
    try { res.json(JSON.parse(data)); }
    catch(e) { res.json({ success: false, error: 'Bot not responding' }); }
  });
  client.on('error', () => res.json({ success: false, error: 'Bot not running' }));
});

app.post('/api/guest-channels/leave', express.json(), (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.json({ success: false, error: 'No channel provided' });
  const net = require('net');
  const client = new net.Socket();
  let data = '';
  client.connect(9003, '127.0.0.1', () => {
    client.write('LEAVE:' + channel);
  });
  client.on('data', (chunk) => { data += chunk.toString(); });
  client.on('end', () => {
    try { res.json(JSON.parse(data)); }
    catch(e) { res.json({ success: false, error: 'Bot not responding' }); }
  });
  client.on('error', () => res.json({ success: false, error: 'Bot not running' }));
});