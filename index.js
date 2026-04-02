const express = require('express');
const cors = require('cors');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const AUTH_DIR = path.join(__dirname, 'auth_state');

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open (dev mode)
  const token = req.headers['x-api-key'] || req.query.key;
  if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- State ---
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | qr | connected

// --- Supabase auth persistence ---
async function saveAuthToSupabase() {
  if (!supabase) return;
  try {
    const files = ['creds.json'];
    const authDir = AUTH_DIR;
    if (!fs.existsSync(authDir)) return;

    // Also save app-state-sync files
    const allFiles = fs.readdirSync(authDir);
    for (const file of allFiles) {
      const content = fs.readFileSync(path.join(authDir, file), 'utf-8');
      await supabase.from('whatsapp_auth').upsert({
        key: file,
        value: content,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    }
    console.log(`[auth] Saved ${allFiles.length} auth files to Supabase`);
  } catch (err) {
    console.error('[auth] Failed to save to Supabase:', err.message);
  }
}

async function loadAuthFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('whatsapp_auth').select('key, value');
    if (error || !data || data.length === 0) {
      console.log('[auth] No auth state in Supabase');
      return;
    }
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const row of data) {
      fs.writeFileSync(path.join(AUTH_DIR, row.key), row.value, 'utf-8');
    }
    console.log(`[auth] Restored ${data.length} auth files from Supabase`);
  } catch (err) {
    console.error('[auth] Failed to load from Supabase:', err.message);
  }
}

// --- WhatsApp connection ---
async function connectWhatsApp() {
  if (sock) {
    try { sock.end(); } catch {}
    sock = null;
  }

  connectionStatus = 'connecting';
  qrCode = null;

  await loadAuthFromSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Gestão Reforma', 'Chrome', '22.0'],
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveAuthToSupabase();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionStatus = 'qr';
      console.log('[wa] QR code generated');
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCode = null;
      console.log('[wa] Connected!');
      await saveAuthToSupabase();
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[wa] Disconnected (code: ${statusCode}), reconnect: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.loggedOut) {
        // Clear auth state
        connectionStatus = 'disconnected';
        qrCode = null;
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        if (supabase) {
          await supabase.from('whatsapp_auth').delete().neq('key', '');
        }
      } else if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000);
      }
    }
  });
}

// --- Routes ---

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/status', requireAuth, (req, res) => {
  res.json({
    status: connectionStatus,
    configured: true,
    qr: qrCode,
  });
});

app.post('/connect', requireAuth, async (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ success: true, message: 'Already connected' });
  }
  connectWhatsApp();
  res.json({ success: true, message: 'Connecting...' });
});

app.post('/disconnect', requireAuth, async (req, res) => {
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  qrCode = null;
  // Clear auth
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  if (supabase) {
    await supabase.from('whatsapp_auth').delete().neq('key', '');
  }
  res.json({ success: true, message: 'Disconnected and logged out' });
});

app.post('/send', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message required' });
  }

  const jid = formatJid(phone);
  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, messageId: Date.now().toString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-image', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }
  const { phone, imageUrl, caption } = req.body;
  if (!phone || !imageUrl) {
    return res.status(400).json({ success: false, error: 'phone and imageUrl required' });
  }

  const jid = formatJid(phone);
  try {
    await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-document', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }
  const { phone, documentUrl, fileName, caption } = req.body;
  if (!phone || !documentUrl || !fileName) {
    return res.status(400).json({ success: false, error: 'phone, documentUrl and fileName required' });
  }

  const jid = formatJid(phone);
  try {
    await sock.sendMessage(jid, {
      document: { url: documentUrl },
      fileName,
      caption: caption || '',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Helpers ---
function formatJid(phone) {
  let digits = phone.replace(/\D/g, '');
  if (!digits.startsWith('55') && digits.length >= 10 && digits.length <= 11) {
    digits = '55' + digits;
  }
  return digits + '@s.whatsapp.net';
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`[server] WhatsApp service running on port ${PORT}`);
  // Auto-connect if auth state exists
  if (supabase) {
    loadAuthFromSupabase().then(() => {
      if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.log('[server] Auth found, auto-connecting...');
        connectWhatsApp();
      }
    });
  }
});
