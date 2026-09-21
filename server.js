// Dental Inventory — zero-dependency Node server (multi-clinic edition)
// - Serves the static app
// - Multi-clinic accounts: register / login / per-clinic data sync (/api/*)
// - WhatsApp Cloud API proxy (POST /api/send-whatsapp) to avoid browser CORS
// Run: npm start   (or: node server.js)
// Data is stored in ./data (JSON files). See .gitignore.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CLINICS_DIR = path.join(DATA_DIR, 'clinics');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const MAX_DATA_BYTES = 12 * 1024 * 1024; // per-clinic data (includes images)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

/* ---------------- storage helpers ---------------- */
function ensureDirs() {
  fs.mkdirSync(CLINICS_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function loadUsers() {
  const u = readJson(USERS_FILE, []);
  return Array.isArray(u) ? u : [];
}
function saveUsers(users) { writeJsonAtomic(USERS_FILE, users); }
function loadSessions() {
  const s = readJson(SESSIONS_FILE, {});
  return s && typeof s === 'object' ? s : {};
}
function saveSessions(s) { writeJsonAtomic(SESSIONS_FILE, s); }
function clinicFile(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CLINICS_DIR, safe + '.json');
}

/* ---------------- auth helpers ---------------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newId(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function validUsername(u) { return /^[a-zA-Z0-9_.-]{3,30}$/.test(u || ''); }
function publicUser(u) {
  return { id: u.id, clinicName: u.clinicName, username: u.username, phone: u.phone || '', address: u.address || '', createdAt: u.createdAt };
}
function getBearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(h.trim());
  return m ? m[1] : '';
}
function authUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - (s.createdAt || 0) > SESSION_TTL_MS) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  const users = loadUsers();
  return users.find(u => u.id === s.userId) || null;
}

/* ---------------- http helpers ---------------- */
function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-cache' }, headers || {}));
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req, limit) {
  const max = limit || 1e6;
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', chunk => {
      data += chunk;
      if (data.length > max) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => (tooBig ? reject(new Error('البيانات كبيرة جداً')) : resolve(data)));
    req.on('error', reject);
  });
}
async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error('بيانات JSON غير صالحة');
  }
}

/* ---------------- WhatsApp proxy (unchanged behavior) ---------------- */
async function handleWhatsAppProxy(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'بيانات غير صالحة' });
  }
  const { phoneNumberId, accessToken, to, message } = body;
  if (!phoneNumberId || !accessToken || !to || !message) {
    return sendJson(res, 400, { error: 'بيانات ناقصة' });
  }
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { preview_url: false, body: message }
      })
    });
    const data = await metaRes.json();
    if (data.error) {
      return sendJson(res, 400, data);
    }
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

/* ---------------- API: accounts & data ---------------- */
async function handleApi(req, res, urlPath) {
  // Public: health
  if (req.method === 'GET' && urlPath === '/api/health') {
    return sendJson(res, 200, { ok: true, mode: 'multi-user', version: '2.0.0', time: new Date().toISOString() });
  }
  // Public: WhatsApp proxy
  if (req.method === 'POST' && urlPath === '/api/send-whatsapp') {
    return handleWhatsAppProxy(req, res);
  }
  // Public: register
  if (req.method === 'POST' && urlPath === '/api/register') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const clinicName = String(body.clinicName || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const phone = String(body.phone || '').trim();
    if (!clinicName) return sendJson(res, 400, { error: 'أدخل اسم العيادة' });
    if (!validUsername(username)) return sendJson(res, 400, { error: 'اسم المستخدم: 3-30 حرف إنجليزي/أرقام (بدون مسافات)' });
    if (!password || password.length < 6) return sendJson(res, 400, { error: 'كلمة المرور 6 أحرف على الأقل' });
    const users = loadUsers();
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: 'اسم المستخدم مسجل مسبقاً — اختر اسماً آخر' });
    }
    const salt = newSalt();
    const user = {
      id: newId('clinic'),
      clinicName, username, phone, address: '',
      salt, passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);
    const token = newToken();
    const sessions = loadSessions();
    sessions[token] = { userId: user.id, createdAt: Date.now() };
    saveSessions(sessions);
    return sendJson(res, 200, { token, user: publicUser(user) });
  }
  // Public: login
  if (req.method === 'POST' && urlPath === '/api/login') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const users = loadUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return sendJson(res, 401, { error: 'المستخدم غير موجود' });
    const h = hashPassword(password, user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.passwordHash, 'hex'))) {
      return sendJson(res, 401, { error: 'كلمة المرور غير صحيحة' });
    }
    const token = newToken();
    const sessions = loadSessions();
    sessions[token] = { userId: user.id, createdAt: Date.now() };
    saveSessions(sessions);
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  // ---- everything below requires auth ----
  const user = authUser(req);
  if (!user) return sendJson(res, 401, { error: 'غير مسجل الدخول' });

  if (req.method === 'GET' && urlPath === '/api/me') {
    return sendJson(res, 200, { user: publicUser(user) });
  }
  if (req.method === 'PUT' && urlPath === '/api/me') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const users = loadUsers();
    const u = users.find(x => x.id === user.id);
    if (!u) return sendJson(res, 404, { error: 'الحساب غير موجود' });
    if (body.clinicName !== undefined) u.clinicName = String(body.clinicName).trim() || u.clinicName;
    if (body.phone !== undefined) u.phone = String(body.phone).trim();
    if (body.address !== undefined) u.address = String(body.address).trim();
    saveUsers(users);
    return sendJson(res, 200, { user: publicUser(u) });
  }
  if (req.method === 'POST' && urlPath === '/api/change-password') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const users = loadUsers();
    const u = users.find(x => x.id === user.id);
    if (!u) return sendJson(res, 404, { error: 'الحساب غير موجود' });
    const cur = String(body.currentPassword || '');
    const nw = String(body.newPassword || '');
    if (nw.length < 6) return sendJson(res, 400, { error: 'كلمة المرور الجديدة 6 أحرف على الأقل' });
    const h = hashPassword(cur, u.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.passwordHash, 'hex'))) {
      return sendJson(res, 401, { error: 'كلمة المرور الحالية غير صحيحة' });
    }
    u.salt = newSalt();
    u.passwordHash = hashPassword(nw, u.salt);
    saveUsers(users);
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'POST' && urlPath === '/api/delete-account') {
    let users = loadUsers().filter(x => x.id !== user.id);
    saveUsers(users);
    try { fs.unlinkSync(clinicFile(user.id)); } catch (e) { /* no data yet */ }
    const sessions = loadSessions();
    Object.keys(sessions).forEach(t => { if (sessions[t].userId === user.id) delete sessions[t]; });
    saveSessions(sessions);
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'GET' && urlPath === '/api/data') {
    const file = clinicFile(user.id);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no-data' });
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return sendJson(res, 200, { data });
    } catch (e) {
      return sendJson(res, 500, { error: 'تعذر قراءة البيانات' });
    }
  }
  if (req.method === 'PUT' && urlPath === '/api/data') {
    let body;
    try { body = await readJsonBody(req, MAX_DATA_BYTES); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const data = body && body.data;
    if (!data || !Array.isArray(data.catalog) || !Array.isArray(data.units) || !Array.isArray(data.suppliers)) {
      return sendJson(res, 400, { error: 'بنية البيانات غير صالحة' });
    }
    try {
      writeJsonAtomic(clinicFile(user.id), data);
    } catch (e) {
      return sendJson(res, 500, { error: 'تعذر حفظ البيانات' });
    }
    return sendJson(res, 200, { success: true });
  }

  return sendJson(res, 404, { error: 'غير موجود' });
}

/* ---------------- server ---------------- */
ensureDirs();

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }

  // API routes
  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    return handleApi(req, res, urlPath).catch(err => {
      console.error('API error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'خطأ داخلي' });
    });
  }

  // Never serve the data directory
  if (urlPath === '/data' || urlPath.startsWith('/data/')) {
    return send(res, 403, 'Forbidden');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed');
  }

  // Static file serving with path-traversal protection
  let filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden');
  }
  if (urlPath.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback: unknown paths serve index.html
      return fs.readFile(path.join(ROOT, 'index.html'), (fallbackErr, html) => {
        if (fallbackErr) return send(res, 404, 'Not Found');
        send(res, 200, html, { 'Content-Type': MIME['.html'] });
      });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    send(res, 200, content, { 'Content-Type': type });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dental Inventory (multi-clinic) running on port ${PORT}`);
});
