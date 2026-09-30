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
function publicUser(u) {
  return { id: u.id, clinicName: u.clinicName, username: u.username, phone: u.phone || '', address: u.address || '', accountType: u.accountType || 'clinic', createdAt: u.createdAt };
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
    const accountType = (body.accountType === 'supplier' || body.accountType === 'clinic') ? body.accountType : 'clinic';
    if (!clinicName) return sendJson(res, 400, { error: accountType === 'supplier' ? 'أدخل اسم الشركة' : 'أدخل اسم العيادة' });
    if (!validUsername(username)) return sendJson(res, 400, { error: 'اسم المستخدم: 3-30 حرف إنجليزي/أرقام (بدون مسافات)' });
    if (!password || password.length < 6) return sendJson(res, 400, { error: 'كلمة المرور 6 أحرف على الأقل' });
    const users = loadUsers();
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: 'اسم المستخدم مسجل مسبقاً — اختر اسماً آخر' });
    }
    const salt = newSalt();
    const user = {
      id: newId(accountType),
      clinicName, username, phone, address: '',
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
