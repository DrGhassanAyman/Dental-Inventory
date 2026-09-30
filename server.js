// Dental Inventory — zero-dependency Node server (multi-clinic edition)
// - Serves the static app
// - Multi-clinic accounts: register / login / per-clinic data sync (/api/*)
// - E-mail accounts + password reset links (owner panel can also mint links)
// - WhatsApp Cloud API proxy (POST /api/send-whatsapp) to avoid browser CORS
// Run: npm start   (or: node server.js)
// Data is stored in ./data (JSON files). See .gitignore.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const CLINICS_DIR = path.join(DATA_DIR, 'clinics');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const RESETS_FILE = path.join(DATA_DIR, 'resets.json');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const MAX_DATA_BYTES = 12 * 1024 * 1024; // per-clinic data (includes images)

/* ---------------- owner (admin) panel config ----------------
 * Set these on the hosting dashboard (Render → Environment) to keep them out of
 * the code: ADMIN_USERNAME / ADMIN_PASSWORD.
 * If ADMIN_PASSWORD is not set, a built-in default is used (see ADMIN_PASSWORD_HASH)
 * so the panel works out of the box — CHANGE IT on any public deployment.
 */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'GhassanAdmin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD
  ? null // plain env value wins (compared below)
  : hashPassword('Alygzs@7', 'dental-owner-default');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const ADMIN_SESSION_TTL_MS = 12 * 3600 * 1000; // 12 hours
const RESET_TTL_MS = (parseInt(process.env.RESET_TTL_MINUTES || '60', 10) || 60) * 60 * 1000;
const DEFAULT_BASE_URL = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

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
  if (!fs.existsSync(RESETS_FILE)) fs.writeFileSync(RESETS_FILE, '{}');
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

/* ---------------- password-reset tokens ---------------- */
function loadResets() {
  const r = readJson(RESETS_FILE, {});
  return r && typeof r === 'object' ? r : {};
}
function saveResets(r) { writeJsonAtomic(RESETS_FILE, r); }
// Drops expired/used-and-old tokens so the file cannot grow forever.
function pruneResets(resets) {
  const now = Date.now();
  let changed = false;
  Object.keys(resets).forEach(t => {
    const r = resets[t] || {};
    const expired = !r.expiresAt || r.expiresAt < now;
    const staleUsed = r.usedAt && (now - r.usedAt) > 7 * 24 * 3600 * 1000;
    if (expired || staleUsed) { delete resets[t]; changed = true; }
  });
  return changed;
}
function createResetToken(userId, createdBy, ttlMs) {
  const resets = loadResets();
  pruneResets(resets);
  const token = newToken();
  const ttl = Math.min(Math.max(parseInt(ttlMs, 10) || RESET_TTL_MS, 5 * 60 * 1000), 7 * 24 * 3600 * 1000);
  resets[token] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    usedAt: null,
    createdBy: createdBy || 'self'
  };
  saveResets(resets);
  return { token, expiresAt: resets[token].expiresAt };
}
// A user may only have a couple of live links at a time.
function invalidateUserResets(userId, keepToken) {
  const resets = loadResets();
  let changed = false;
  Object.keys(resets).forEach(t => {
    if (resets[t].userId === userId && t !== keepToken) { delete resets[t]; changed = true; }
  });
  if (changed) saveResets(resets);
}
function resetTokenInfo(token) {
  const resets = loadResets();
  const r = resets[String(token || '')];
  if (!r) return { ok: false, reason: 'notfound' };
  if (r.usedAt) return { ok: false, reason: 'used' };
  if (!r.expiresAt || r.expiresAt < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, record: r };
}
function lastActiveReset(userId) {
  const resets = loadResets();
  const now = Date.now();
  let best = null;
  Object.keys(resets).forEach(t => {
    const r = resets[t];
    if (r.userId !== userId || r.usedAt || !r.expiresAt || r.expiresAt < now) return;
    if (!best || r.createdAt > best.createdAt) {
      best = { token: t, createdAt: r.createdAt, expiresAt: r.expiresAt, createdBy: r.createdBy };
    }
  });
  return best;
}
// Ends every logged-in session of a user (used right after a password reset).
function dropUserSessions(userId) {
  const sessions = loadSessions();
  let changed = false;
  Object.keys(sessions).forEach(t => {
    if (sessions[t].userId === userId) { delete sessions[t]; changed = true; }
  });
  if (changed) saveSessions(sessions);
}
function clinicFile(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CLINICS_DIR, safe + '.json');
}
function suppliersDir() {
  const dir = path.join(DATA_DIR, 'suppliers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function supplierProductsFile(supplierId) {
  const safe = String(supplierId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(suppliersDir(), safe + '_products.json');
}
function supplierOffersFile(supplierId) {
  const safe = String(supplierId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(suppliersDir(), safe + '_offers.json');
}
function offersFile() {
  return path.join(DATA_DIR, 'offers.json');
}
function ordersFile() {
  return path.join(DATA_DIR, 'orders.json');
}
function notificationsFile() {
  return path.join(DATA_DIR, 'notifications.json');
}
function loadOffers() {
  const file = offersFile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  return readJson(file, []);
}
function saveOffers(offers) { writeJsonAtomic(offersFile(), offers); }
function loadOrders() {
  const file = ordersFile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  return readJson(file, []);
}
function saveOrders(orders) { writeJsonAtomic(ordersFile(), orders); }
function loadNotifications() {
  const file = notificationsFile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  return readJson(file, []);
}
function saveNotifications(n) { writeJsonAtomic(notificationsFile(), n); }
function addNotification(userId, type, title, message, metadata) {
  const notifs = loadNotifications();
  const notif = {
    id: newId('notif'),
    userId: userId,
    type: type,
    title: title,
    message: message,
    metadata: metadata || {},
    read: false,
    createdAt: new Date().toISOString()
  };
  notifs.unshift(notif);
  if (notifs.length > 200) notifs.length = 200;
  saveNotifications(notifs);
  return notif;
}

/* ---------------- auth helpers ---------------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newId(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function validUsername(u) { return /^[a-zA-Z0-9_.-]{3,30}$/.test(u || ''); }
function validEmail(e) { return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(e || '').trim()); }
function publicUser(u) {
  return { id: u.id, clinicName: u.clinicName, username: u.username, email: u.email || '', phone: u.phone || '', address: u.address || '', accountType: u.accountType || 'clinic', createdAt: u.createdAt };
}
function publicAdmin() { return { username: ADMIN_USERNAME, role: 'owner' }; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return '';
  const name = e.slice(0, at);
  const domain = e.slice(at);
  const shown = name.length <= 2 ? name[0] : name.slice(0, 2);
  return shown + '•••' + domain;
}
function checkAdminCredentials(username, password) {
  const okUser = String(username || '').trim().toLowerCase() === ADMIN_USERNAME.toLowerCase();
  if (!okUser) return false;
  const supplied = String(password || '');
  if (ADMIN_PASSWORD) {
    const a = crypto.createHash('sha256').update('admin::' + supplied).digest();
    const b = crypto.createHash('sha256').update('admin::' + ADMIN_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const h = hashPassword(supplied, 'dental-owner-default');
  const expected = Buffer.from(ADMIN_PASSWORD_HASH, 'hex');
  const got = Buffer.from(h, 'hex');
  return expected.length === got.length && crypto.timingSafeEqual(got, expected);
}
// Bearer token that belongs to an owner session (not a clinic/supplier account)
function authAdmin(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s || s.role !== 'admin') return null;
  if (Date.now() - (s.createdAt || 0) > ADMIN_SESSION_TTL_MS) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  return s;
}
// Best-effort public base URL, so reset links work on any host (Render, localhost…)
function baseUrl(req) {
  if (DEFAULT_BASE_URL) return DEFAULT_BASE_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
  return proto + '://' + String(host).split(',')[0].trim();
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

/* ---------------- API: owner (admin) panel ----------------
 * Only reachable with an owner session token. Lets the site owner list every
 * registered clinic/supplier account and mint a one-time password-reset link.
 */
async function handleAdminApi(req, res, urlPath, admin) {
  if (req.method === 'GET' && urlPath === '/api/admin/me') {
    return sendJson(res, 200, {
      admin: publicAdmin(),
      smtpConfigured: mailer.isConfigured(),
      resetTtlMinutes: Math.round(RESET_TTL_MS / 60000)
    });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/logout') {
    const token = getBearerToken(req);
    const sessions = loadSessions();
    if (sessions[token]) { delete sessions[token]; saveSessions(sessions); }
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'GET' && urlPath === '/api/admin/accounts') {
    const users = loadUsers();
    const accounts = users.map(u => {
      const file = clinicFile(u.id);
      let dataBytes = 0, dataUpdatedAt = null;
      try {
        const st = fs.statSync(file);
        dataBytes = st.size;
        dataUpdatedAt = st.mtime.toISOString();
      } catch (e) { /* no data yet */ }
      const active = lastActiveReset(u.id);
      return Object.assign(publicUser(u), {
        hasData: dataBytes > 0,
        dataBytes,
        dataUpdatedAt,
        hasPassword: !!u.passwordHash,
        resetLink: active ? { expiresAt: active.expiresAt, createdAt: active.createdAt, createdBy: active.createdBy } : null
      });
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return sendJson(res, 200, {
      accounts,
      smtpConfigured: mailer.isConfigured(),
      resetTtlMinutes: Math.round(RESET_TTL_MS / 60000)
    });
  }
  // Mint a one-time link for any account (clinic or supplier)
  if (req.method === 'POST' && urlPath === '/api/admin/reset-link') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const userId = String(body.userId || '');
    const minutes = parseInt(body.minutes, 10);
    const users = loadUsers();
    const u = users.find(x => x.id === userId || x.username.toLowerCase() === userId.toLowerCase());
    if (!u) return sendJson(res, 404, { error: 'الحساب غير موجود' });
    invalidateUserResets(u.id);
    const ttl = isNaN(minutes) ? RESET_TTL_MS : minutes * 60 * 1000;
    const { token, expiresAt } = createResetToken(u.id, 'owner', ttl);
    const link = baseUrl(req) + '/?reset=' + encodeURIComponent(token);
    let emailed = false, mailError = null;
    if (body.sendEmail !== false && u.email) {
      const m = await mailer.sendMail({
        to: u.email,
        subject: 'إعادة تعيين كلمة المرور — نظام جرد عيادات الأسنان',
        text: 'مرحباً ' + u.clinicName + '،\n\n' +
          'قام مدير النظام بإنشاء رابط لإعادة تعيين كلمة المرور لحسابك (' + u.username + ').\n' +
          'افتح الرابط التالي:\n' + link + '\n\n' +
          'الرابط صالح لمدة ' + Math.round((expiresAt - Date.now()) / 60000) + ' دقيقة ويُستخدم مرة واحدة فقط.\n'
      });
      emailed = !!m.sent;
      mailError = m.sent ? null : (m.error || null);
    }
    return sendJson(res, 200, {
      success: true,
      link,
      expiresAt,
      username: u.username,
      clinicName: u.clinicName,
      accountType: u.accountType || 'clinic',
      email: u.email || '',
      maskedEmail: maskEmail(u.email),
      emailed,
      mailError
    });
  }
  // Cancel any pending link for an account
  if (req.method === 'POST' && urlPath === '/api/admin/cancel-reset') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const u = loadUsers().find(x => x.id === String(body.userId || ''));
    if (!u) return sendJson(res, 404, { error: 'الحساب غير موجود' });
    invalidateUserResets(u.id);
    return sendJson(res, 200, { success: true });
  }
  return sendJson(res, 404, { error: 'غير موجود' });
}

/* ---------------- API: accounts & data ---------------- */
async function handleApi(req, res, urlPath) {
  // Public: health
  if (req.method === 'GET' && urlPath === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      mode: 'multi-user',
      version: '2.1.0',
      time: new Date().toISOString(),
      features: { passwordReset: true, emailReset: mailer.isConfigured(), ownerPanel: true }
    });
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
    const email = String(body.email || '').trim().toLowerCase();
    const accountType = (body.accountType === 'supplier' || body.accountType === 'clinic') ? body.accountType : 'clinic';
    if (!clinicName) return sendJson(res, 400, { error: accountType === 'supplier' ? 'أدخل اسم الشركة' : 'أدخل اسم العيادة' });
    if (!validUsername(username)) return sendJson(res, 400, { error: 'اسم المستخدم: 3-30 حرف إنجليزي/أرقام (بدون مسافات)' });
    if (!validEmail(email)) return sendJson(res, 400, { error: 'أدخل بريداً إلكترونياً صالحاً (مطلوب لاستعادة كلمة المرور)' });
    if (!password || password.length < 6) return sendJson(res, 400, { error: 'كلمة المرور 6 أحرف على الأقل' });
    const users = loadUsers();
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: 'اسم المستخدم مسجل مسبقاً — اختر اسماً آخر' });
    }
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
      return sendJson(res, 409, { error: 'اسم المستخدم محجوز — اختر اسماً آخر' });
    }
    if (users.some(u => String(u.email || '').toLowerCase() === email)) {
      return sendJson(res, 409, { error: 'هذا البريد مسجل مسبقاً — استخدم بريداً آخر أو استعد كلمة المرور' });
    }
    const salt = newSalt();
    const user = {
      id: newId(accountType),
      clinicName, username, email, phone, address: '',
      accountType: accountType,
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

  /* ---------------- public: password reset ---------------- */

  // Step 1: user forgot the password → we e-mail a one-time link (if SMTP is set up).
  if (req.method === 'POST' && urlPath === '/api/forgot-password') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const identifier = String(body.identifier || body.username || body.email || '').trim().toLowerCase();
    // Always answer the same way, so nobody can probe which accounts exist.
    const generic = { success: true, smtpConfigured: mailer.isConfigured() };
    if (!identifier) return sendJson(res, 200, generic);
    const users = loadUsers();
    const u = users.find(x => x.username.toLowerCase() === identifier || String(x.email || '').toLowerCase() === identifier);
    if (!u) return sendJson(res, 200, generic);
    if (!u.email) return sendJson(res, 200, Object.assign({}, generic, { delivery: 'manual', reason: 'no-email' }));
    const { token, expiresAt } = createResetToken(u.id, 'self');
    const link = baseUrl(req) + '/?reset=' + encodeURIComponent(token);
    const minutes = Math.round((expiresAt - Date.now()) / 60000);
    const sent = await mailer.sendMail({
      to: u.email,
      subject: 'استعادة كلمة المرور — نظام جرد عيادات الأسنان',
      text: 'مرحباً ' + u.clinicName + '،\n\n' +
        'وصلنا طلب لإعادة تعيين كلمة المرور لحسابك (' + u.username + ').\n' +
        'افتح الرابط التالي لتعيين كلمة مرور جديدة:\n' + link + '\n\n' +
        'الرابط صالح لمدة ' + minutes + ' دقيقة، ويُستخدم مرة واحدة فقط.\n' +
        'إذا لم تطلب ذلك، تجاهل هذه الرسالة — كلمة مرورك الحالية تبقى كما هي.\n',
      html: '<div dir="rtl" style="font-family:Arial,Tahoma,sans-serif;line-height:1.9;color:#0f172a">' +
        '<h2 style="color:#0f766e">🦷 إعادة تعيين كلمة المرور</h2>' +
        '<p>مرحباً <b>' + escapeHtml(u.clinicName) + '</b>،</p>' +
        '<p>وصلنا طلب لإعادة تعيين كلمة المرور لحسابك <code dir="ltr">' + escapeHtml(u.username) + '</code>.</p>' +
        '<p style="text-align:center;margin:22px 0"><a href="' + link + '" style="background:#0d9488;color:#fff;text-decoration:none;padding:12px 26px;border-radius:10px;font-weight:bold;display:inline-block">تعيين كلمة مرور جديدة</a></p>' +
        '<p style="font-size:12px;color:#64748b">الرابط صالح لمدة ' + minutes + ' دقيقة ويُستخدم مرة واحدة فقط.<br>' +
        'إذا لم يعمل الزر، انسخ هذا الرابط: <span dir="ltr">' + link + '</span></p>' +
        '<p style="font-size:12px;color:#64748b">إذا لم تطلب ذلك، تجاهل هذه الرسالة — كلمة مرورك الحالية تبقى كما هي.</p></div>'
    });
    return sendJson(res, 200, Object.assign({}, generic, {
      delivery: sent.sent ? 'email' : 'manual',
      emailSent: !!sent.sent,
      maskedEmail: maskEmail(u.email),
      error: sent.sent ? undefined : sent.error
    }));
  }

  // Step 2: the page opened from the e-mail link asks whether the token is still valid.
  if (req.method === 'GET' && urlPath === '/api/reset-token') {
    let token = '';
    try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch (e) { /* ignore */ }
    const info = resetTokenInfo(token);
    if (!info.ok) {
      const msg = info.reason === 'used' ? 'هذا الرابط مستخدم مسبقاً — اطلب رابطاً جديداً'
        : info.reason === 'expired' ? 'انتهت صلاحية الرابط — اطلب رابطاً جديداً'
        : 'الرابط غير صالح';
      return sendJson(res, 400, { valid: false, error: msg });
    }
    const u = loadUsers().find(x => x.id === info.record.userId);
    if (!u) return sendJson(res, 400, { valid: false, error: 'الرابط غير صالح' });
    return sendJson(res, 200, {
      valid: true,
      username: u.username,
      clinicName: u.clinicName,
      maskedEmail: maskEmail(u.email),
      expiresAt: info.record.expiresAt
    });
  }

  // Step 3: save the new password (single use, and it logs the account out everywhere).
  if (req.method === 'POST' && urlPath === '/api/reset-password') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const token = String(body.token || '');
    const nw = String(body.newPassword || '');
    if (nw.length < 6) return sendJson(res, 400, { error: 'كلمة المرور الجديدة 6 أحرف على الأقل' });
    const info = resetTokenInfo(token);
    if (!info.ok) {
      const msg = info.reason === 'used' ? 'هذا الرابط مستخدم مسبقاً — اطلب رابطاً جديداً'
        : info.reason === 'expired' ? 'انتهت صلاحية الرابط — اطلب رابطاً جديداً'
        : 'الرابط غير صالح';
      return sendJson(res, 400, { error: msg });
    }
    const users = loadUsers();
    const u = users.find(x => x.id === info.record.userId);
    if (!u) return sendJson(res, 400, { error: 'الحساب غير موجود' });
    u.salt = newSalt();
    u.passwordHash = hashPassword(nw, u.salt);
    saveUsers(users);
    const resets = loadResets();
    if (resets[token]) { resets[token].usedAt = Date.now(); saveResets(resets); }
    invalidateUserResets(u.id, token);
    dropUserSessions(u.id);
    return sendJson(res, 200, { success: true, username: u.username });
  }

  /* ---------------- public: owner (admin) ---------------- */

  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!checkAdminCredentials(username, password)) {
      return sendJson(res, 401, { error: 'بيانات دخول المالك غير صحيحة' });
    }
    const token = newToken();
    const sessions = loadSessions();
    sessions[token] = { role: 'admin', username: ADMIN_USERNAME, createdAt: Date.now() };
    saveSessions(sessions);
    return sendJson(res, 200, { token, admin: publicAdmin() });
  }

  // ---- everything below requires auth ----
  const admin = authAdmin(req);
  if (admin) return handleAdminApi(req, res, urlPath, admin);
  if (urlPath.startsWith('/api/admin/')) return sendJson(res, 401, { error: 'صلاحية المالك مطلوبة' });

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
    if (body.email !== undefined) {
      const email = String(body.email).trim().toLowerCase();
      if (!validEmail(email)) return sendJson(res, 400, { error: 'أدخل بريداً إلكترونياً صالحاً' });
      if (users.some(x => x.id !== u.id && String(x.email || '').toLowerCase() === email)) {
        return sendJson(res, 409, { error: 'هذا البريد مستخدم في حساب آخر' });
      }
      u.email = email;
    }
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
    // For suppliers, return supplier-specific data instead of clinic data
    if (user.accountType === 'supplier') {
      const file = clinicFile(user.id);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no-data' });
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return sendJson(res, 200, { data });
      } catch (e) {
        return sendJson(res, 500, { error: 'تعذر قراءة البيانات' });
      }
    }
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
    if (user.accountType === 'supplier') {
      // For suppliers, accept supplier-specific data structure
      if (!data || !data.products) {
        return sendJson(res, 400, { error: 'بنية البيانات غير صالحة' });
      }
      try {
        writeJsonAtomic(clinicFile(user.id), data);
      } catch (e) {
        return sendJson(res, 500, { error: 'تعذر حفظ البيانات' });
      }
      return sendJson(res, 200, { success: true });
    }
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

  // ---- Supplier Portal APIs ----

  // Supplier: Get all registered suppliers (for clinics)
  if (req.method === 'GET' && urlPath === '/api/suppliers/list') {
    const users = loadUsers().filter(u => u.accountType === 'supplier');
    const list = users.map(u => ({
      id: u.id,
      companyName: u.clinicName,
      phone: u.phone || '',
      address: u.address || '',
      username: u.username,
      createdAt: u.createdAt
    }));
    return sendJson(res, 200, { suppliers: list });
  }

  // Supplier: Add/update products
  if (req.method === 'POST' && urlPath === '/api/supplier/products') {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const file = clinicFile(user.id);
    let data;
    try {
      data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { products: [], offers: [] };
    } catch (e) {
      data = { products: [], offers: [] };
    }
    if (!Array.isArray(data.products)) data.products = [];
    
    const product = {
      id: body.id || newId('prod'),
      name: String(body.name || '').trim(),
      category: String(body.category || '').trim(),
      description: String(body.description || '').trim(),
      price: parseFloat(body.price) || 0,
      unit: String(body.unit || 'قطعة').trim(),
      image: String(body.image || '').trim(),
      inStock: body.inStock !== false,
      minOrder: parseInt(body.minOrder) || 1,
      updatedAt: new Date().toISOString()
    };
    
    if (!product.name) return sendJson(res, 400, { error: 'اسم المنتج مطلوب' });
    if (product.price <= 0) return sendJson(res, 400, { error: 'السعر يجب أن يكون أكبر من صفر' });
    
    const existingIdx = data.products.findIndex(p => p.id === product.id);
    if (existingIdx >= 0) {
      data.products[existingIdx] = product;
    } else {
      data.products.push(product);
    }
    
    try {
      writeJsonAtomic(file, data);
    } catch (e) {
      return sendJson(res, 500, { error: 'تعذر حفظ المنتج' });
    }
    return sendJson(res, 200, { success: true, product });
  }

  // Supplier: Delete product
  if (req.method === 'DELETE' && urlPath.match(/^\/api\/supplier\/products\/(.+)$/)) {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    const productId = urlPath.split('/').pop();
    const file = clinicFile(user.id);
    let data;
    try {
      data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { products: [], offers: [] };
    } catch (e) {
      return sendJson(res, 404, { error: 'المنتج غير موجود' });
    }
    if (!Array.isArray(data.products)) data.products = [];
    
    data.products = data.products.filter(p => p.id !== productId);
    try {
      writeJsonAtomic(file, data);
    } catch (e) {
      return sendJson(res, 500, { error: 'تعذر حذف المنتج' });
    }
    return sendJson(res, 200, { success: true });
  }

  // Supplier: Get all clinic requests (low stock items visible to suppliers)
  if (req.method === 'GET' && urlPath === '/api/supplier/requests') {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    const users = loadUsers();
    const clinics = users.filter(u => u.accountType === 'clinic');
    const requests = [];
    
    clinics.forEach(clinic => {
      const file = clinicFile(clinic.id);
      if (!fs.existsSync(file)) return;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Only show low stock items if clinic has visibility enabled
        if (!data.settings || !data.settings.supplierVisibility) return;
        
        const lowStockItems = [];
        (data.units || []).forEach(unit => {
          (unit.items || []).forEach(item => {
            const cat = (data.catalog || []).find(c => c.id === item.catalogId);
            if (!cat) return;
            const threshold = item.minThreshold || cat.minThreshold || 3;
            if (item.qty <= threshold) {
              lowStockItems.push({
                itemId: item.id,
                unitId: unit.id,
                materialName: cat.name,
                category: cat.category,
                currentQty: item.qty,
                threshold: threshold,
                clinicId: clinic.id,
                clinicName: clinic.clinicName,
                clinicPhone: clinic.phone || '',
                clinicAddress: clinic.address || ''
              });
            }
          });
        });
        
        if (lowStockItems.length > 0) {
          requests.push({
            clinic: {
              id: clinic.id,
              name: clinic.clinicName,
              phone: clinic.phone || '',
              address: clinic.address || ''
            },
            items: lowStockItems
          });
        }
      } catch (e) {
        // Skip this clinic
      }
    });
    
    return sendJson(res, 200, { requests });
  }

  // Supplier: Send offer to clinic
  if (req.method === 'POST' && urlPath === '/api/supplier/offers') {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    
    const clinicId = String(body.clinicId || '').trim();
    const items = Array.isArray(body.items) ? body.items : [];
    const notes = String(body.notes || '').trim();
    const validDays = parseInt(body.validDays) || 7;
    
    if (!clinicId) return sendJson(res, 400, { error: 'معرف العيادة مطلوب' });
    if (!items.length) return sendJson(res, 400, { error: 'يجب إضافة مواد للعرض' });
    
    // Verify clinic exists
    const users = loadUsers();
    const clinic = users.find(u => u.id === clinicId && u.accountType === 'clinic');
    if (!clinic) return sendJson(res, 404, { error: 'العيادة غير موجودة' });
    
    const offer = {
      id: newId('offer'),
      supplierId: user.id,
      supplierName: user.clinicName,
      supplierPhone: user.phone || '',
      clinicId: clinicId,
      clinicName: clinic.clinicName,
      items: items.map(item => ({
        materialName: String(item.materialName || '').trim(),
        quantity: parseInt(item.quantity) || 1,
        unitPrice: parseFloat(item.unitPrice) || 0,
        totalPrice: (parseInt(item.quantity) || 1) * (parseFloat(item.unitPrice) || 0),
        notes: String(item.notes || '').trim()
      })),
      totalAmount: items.reduce((sum, item) => sum + ((parseInt(item.quantity) || 1) * (parseFloat(item.unitPrice) || 0)), 0),
      notes: notes,
      status: 'pending', // pending, accepted, rejected, expired
      validUntil: new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    };
    
    const offers = loadOffers();
    offers.unshift(offer);
    if (offers.length > 500) offers.length = 500;
    saveOffers(offers);
    
    // Add notification for clinic
    addNotification(
      clinicId,
      'new_offer',
      'عرض جديد من ' + user.clinicName,
      'عرض أسعار جديد لـ ' + items.length + ' مادة',
      { offerId: offer.id, supplierId: user.id, supplierName: user.clinicName }
    );
    
    return sendJson(res, 200, { success: true, offer });
  }

  // Supplier: Get offers sent by this supplier
  if (req.method === 'GET' && urlPath === '/api/supplier/offers') {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    const offers = loadOffers().filter(o => o.supplierId === user.id);
    return sendJson(res, 200, { offers });
  }

  // Clinic: Toggle supplier visibility
  if (req.method === 'PUT' && urlPath === '/api/clinic/visibility') {
    if (user.accountType !== 'clinic') return sendJson(res, 403, { error: 'هذا الحساب ليس عيادة' });
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    
    const visible = !!body.visible;
    const file = clinicFile(user.id);
    let data;
    try {
      data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { catalog: [], units: [], suppliers: [] };
    } catch (e) {
      data = { catalog: [], units: [], suppliers: [] };
    }
    
    if (!data.settings) data.settings = {};
    data.settings.supplierVisibility = visible;
    
    try {
      writeJsonAtomic(file, data);
    } catch (e) {
      return sendJson(res, 500, { error: 'تعذر حفظ الإعداد' });
    }
    
    // If enabling visibility, notify all suppliers about this clinic's low stock items
    if (visible) {
      const suppliers = loadUsers().filter(u => u.accountType === 'supplier');
      let lowStockCount = 0;
      (data.units || []).forEach(unit => {
        (unit.items || []).forEach(item => {
          const cat = (data.catalog || []).find(c => c.id === item.catalogId);
          if (!cat) return;
          const threshold = item.minThreshold || cat.minThreshold || 3;
          if (item.qty <= threshold) lowStockCount++;
        });
      });
      
      if (lowStockCount > 0) {
        suppliers.forEach(supplier => {
          addNotification(
            supplier.id,
            'clinic_visible',
            'عيادة جديدة تحتاج مواد',
            user.clinicName + ' لديها ' + lowStockCount + ' مادة وصلت حد التنبيه',
            { clinicId: user.id, clinicName: user.clinicName, lowStockCount }
          );
        });
      }
    }
    
    return sendJson(res, 200, { success: true, visible });
  }

  // Clinic: Get offers received
  if (req.method === 'GET' && urlPath === '/api/clinic/offers') {
    if (user.accountType !== 'clinic') return sendJson(res, 403, { error: 'هذا الحساب ليس عيادة' });
    const offers = loadOffers().filter(o => o.clinicId === user.id);
    return sendJson(res, 200, { offers });
  }

  // Clinic: Accept offer
  if (req.method === 'POST' && urlPath.match(/^\/api\/clinic\/offers\/([^\/]+)\/accept$/)) {
    if (user.accountType !== 'clinic') return sendJson(res, 403, { error: 'هذا الحساب ليس عيادة' });
    const offerId = urlPath.split('/').slice(-2, -1)[0];
    
    const offers = loadOffers();
    const offer = offers.find(o => o.id === offerId && o.clinicId === user.id);
    if (!offer) return sendJson(res, 404, { error: 'العرض غير موجود' });
    if (offer.status !== 'pending') return sendJson(res, 400, { error: 'العرض ليس قيد الانتظار' });
    
    // Check if offer is still valid
    if (new Date(offer.validUntil) < new Date()) {
      offer.status = 'expired';
      saveOffers(offers);
      return sendJson(res, 400, { error: 'العرض منتهي الصلاحية' });
    }
    
    offer.status = 'accepted';
    offer.acceptedAt = new Date().toISOString();
    saveOffers(offers);
    
    // Create order
    const orders = loadOrders();
    const order = {
      id: newId('order'),
      offerId: offer.id,
      supplierId: offer.supplierId,
      supplierName: offer.supplierName,
      supplierPhone: offer.supplierPhone,
      clinicId: user.id,
      clinicName: user.clinicName,
      items: offer.items,
      totalAmount: offer.totalAmount,
      status: 'confirmed', // confirmed, shipped, delivered, cancelled
      createdAt: new Date().toISOString()
    };
    orders.unshift(order);
    if (orders.length > 500) orders.length = 500;
    saveOrders(orders);
    
    // Notify supplier
    addNotification(
      offer.supplierId,
      'offer_accepted',
      'تم قبول عرضك',
      user.clinicName + ' قبلت عرضك',
      { offerId: offer.id, orderId: order.id, clinicId: user.id, clinicName: user.clinicName }
    );
    
    return sendJson(res, 200, { success: true, order });
  }

  // Clinic: Reject offer
  if (req.method === 'POST' && urlPath.match(/^\/api\/clinic\/offers\/([^\/]+)\/reject$/)) {
    if (user.accountType !== 'clinic') return sendJson(res, 403, { error: 'هذا الحساب ليس عيادة' });
    const offerId = urlPath.split('/').slice(-2, -1)[0];
    
    const offers = loadOffers();
    const offer = offers.find(o => o.id === offerId && o.clinicId === user.id);
    if (!offer) return sendJson(res, 404, { error: 'العرض غير موجود' });
    if (offer.status !== 'pending') return sendJson(res, 400, { error: 'العرض ليس قيد الانتظار' });
    
    offer.status = 'rejected';
    offer.rejectedAt = new Date().toISOString();
    saveOffers(offers);
    
    // Notify supplier
    addNotification(
      offer.supplierId,
      'offer_rejected',
      'تم رفض عرضك',
      user.clinicName + ' رفضت عرضك',
      { offerId: offer.id, clinicId: user.id, clinicName: user.clinicName }
    );
    
    return sendJson(res, 200, { success: true });
  }

  // Clinic: Get orders
  if (req.method === 'GET' && urlPath === '/api/clinic/orders') {
    if (user.accountType !== 'clinic') return sendJson(res, 403, { error: 'هذا الحساب ليس عيادة' });
    const orders = loadOrders().filter(o => o.clinicId === user.id);
    return sendJson(res, 200, { orders });
  }

  // Supplier: Get orders received
  if (req.method === 'GET' && urlPath === '/api/supplier/orders') {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    const orders = loadOrders().filter(o => o.supplierId === user.id);
    return sendJson(res, 200, { orders });
  }

  // Supplier: Update order status
  if (req.method === 'PUT' && urlPath.match(/^\/api\/supplier\/orders\/([^\/]+)\/status$/)) {
    if (user.accountType !== 'supplier') return sendJson(res, 403, { error: 'هذا الحساب ليس مورد' });
    const orderId = urlPath.split('/').slice(-2, -1)[0];
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    
    const status = String(body.status || '').trim();
    if (!['confirmed', 'shipped', 'delivered', 'cancelled'].includes(status)) {
      return sendJson(res, 400, { error: 'حالة غير صالحة' });
    }
    
    const orders = loadOrders();
    const order = orders.find(o => o.id === orderId && o.supplierId === user.id);
    if (!order) return sendJson(res, 404, { error: 'الطلب غير موجود' });
    
    order.status = status;
    order.updatedAt = new Date().toISOString();
    saveOrders(orders);
    
    // Notify clinic
    const statusMessages = {
      'confirmed': 'تم تأكيد طلبك',
      'shipped': 'تم شحن طلبك',
      'delivered': 'تم توصيل طلبك',
      'cancelled': 'تم إلغاء طلبك'
    };
    addNotification(
      order.clinicId,
      'order_status',
      statusMessages[status] || 'تحديث حالة الطلب',
      'طلبك من ' + user.clinicName + ': ' + (statusMessages[status] || status),
      { orderId: order.id, supplierId: user.id, supplierName: user.clinicName, status }
    );
    
    return sendJson(res, 200, { success: true, order });
  }

  // Notifications: Get user notifications
  if (req.method === 'GET' && urlPath === '/api/notifications') {
    const notifications = loadNotifications().filter(n => n.userId === user.id);
    return sendJson(res, 200, { notifications });
  }

  // Notifications: Mark as read
  if (req.method === 'POST' && urlPath === '/api/notifications/read') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    
    const notificationIds = Array.isArray(body.notificationIds) ? body.notificationIds : [];
    const markAll = !!body.markAll;
    
    const notifications = loadNotifications();
    if (markAll) {
      notifications.forEach(n => {
        if (n.userId === user.id) n.read = true;
      });
    } else {
      notifications.forEach(n => {
        if (n.userId === user.id && notificationIds.includes(n.id)) n.read = true;
      });
    }
    saveNotifications(notifications);
    
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
