// Dental Inventory — zero-dependency Node server
// Serves the static app and provides an optional WhatsApp Cloud API proxy
// (POST /api/send-whatsapp) to avoid browser CORS issues.
// Run: npm start   (or: node server.js)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

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

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-cache' }, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB limit
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleWhatsAppProxy(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return send(res, 400, JSON.stringify({ error: 'بيانات غير صالحة' }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
  const { phoneNumberId, accessToken, to, message } = body;
  if (!phoneNumberId || !accessToken || !to || !message) {
    return send(res, 400, JSON.stringify({ error: 'بيانات ناقصة' }), { 'Content-Type': 'application/json; charset=utf-8' });
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
      return send(res, 400, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
    }
    send(res, 200, JSON.stringify({ success: true, data }), { 'Content-Type': 'application/json; charset=utf-8' });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }

  // Optional WhatsApp Cloud API proxy endpoint
  if (req.method === 'POST' && urlPath === '/api/send-whatsapp') {
    return handleWhatsAppProxy(req, res);
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
  console.log(`Dental Inventory running on port ${PORT}`);
});
