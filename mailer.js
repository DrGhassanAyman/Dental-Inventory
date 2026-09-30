// Dental Inventory — minimal zero-dependency SMTP mailer.
// Used to send password-reset links. If SMTP is not configured, sendMail()
// resolves with { sent:false, skipped:true } and the caller falls back to a
// link the owner can copy from the admin panel.
//
// Configuration (environment variables):
//   SMTP_HOST   e.g. smtp.gmail.com
//   SMTP_PORT   465 (implicit TLS) or 587 (STARTTLS) — default 587
//   SMTP_SECURE 'true' | 'false' — default: true when port is 465
//   SMTP_USER   login user (usually the full e-mail address)
//   SMTP_PASS   login password / app password
//   SMTP_FROM   From header — default SMTP_USER
//   SMTP_REPLY_TO  optional
//
// All variables may also be provided with a MAIL_ prefix (MAIL_HOST, ...), so
// either naming style works on the hosting dashboard.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const TIMEOUT_MS = Math.max(3000, parseInt(process.env.SMTP_TIMEOUT_MS || '15000', 10) || 15000);

function env(name) {
  const a = process.env['SMTP_' + name];
  const b = process.env['MAIL_' + name];
  const v = (a !== undefined && a !== '') ? a : b;
  return v === undefined ? '' : String(v).trim();
}

function getConfig() {
  const host = env('HOST');
  const port = parseInt(env('PORT') || '587', 10) || 587;
  const user = env('USER');
  const pass = env('PASS');
  const secureRaw = env('SECURE');
  const secure = secureRaw ? /^(1|true|yes|on)$/i.test(secureRaw) : port === 465;
  const from = env('FROM') || user;
  const replyTo = env('REPLY_TO');
  return { host, port, secure, user, pass, from, replyTo };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.host && c.from);
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

// Arabic-safe header encoding (RFC 2047)
function encodeHeader(value) {
  const v = String(value || '');
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return '=?UTF-8?B?' + b64(v) + '?=';
}

function buildMessage({ from, to, replyTo, subject, text, html }) {
  const boundary = 'dental_' + crypto.randomBytes(10).toString('hex');
  const headers = [
    'From: ' + encodeHeader(from),
    'To: ' + encodeHeader(to),
    'Subject: ' + encodeHeader(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@dental-inventory>',
    'MIME-Version: 1.0'
  ];
  if (replyTo) headers.push('Reply-To: ' + encodeHeader(replyTo));

  if (html) {
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    const body = [
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(text || '')),
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(html)),
      '--' + boundary + '--',
      ''
    ];
    return headers.join('\r\n') + '\r\n' + body.join('\r\n');
  }

  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: base64');
  return headers.join('\r\n') + '\r\n\r\n' + wrap76(b64(text || '')) + '\r\n';
}

function wrap76(b64str) {
  return (b64str.match(/.{1,76}/g) || []).join('\r\n');
}

/* ---------------- tiny SMTP conversation ---------------- */

function smtpSession(cfg) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let buffer = '';
    let lines = [];
    let waiter = null;
    let finished = false;
    let step = 0;

    const timer = setTimeout(() => fail(new Error('انتهت مهلة الاتصال بخادم البريد')), TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      if (socket && !socket.destroyed) { try { socket.end(); } catch (e) { /* ignore */ } }
    }
    function fail(err) {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    }
    function done(result) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    }

    // Reads one (possibly multi-line) SMTP reply: "250-..." lines then "250 ..."
    function readReply() {
      if (waiter) throw new Error('readReply re-entered');
      return new Promise((res, rej) => { waiter = { res, rej }; pump(); });
    }
    function pump() {
      if (!waiter) return;
      if (!buffer) return;
      const nl = buffer.indexOf('\r\n') >= 0 ? buffer.indexOf('\r\n') : buffer.indexOf('\n');
      if (nl < 0) return;
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1));
      lines.push(raw);
      const isLast = /^\d{3}(\s|$)/.test(raw);
      if (isLast) {
        const w = waiter; waiter = null;
        const code = parseInt(raw.slice(0, 3), 10);
        w.res({ code, lines });
        lines = [];
      } else {
        pump();
      }
    }
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      pump();
    }

    function send(cmd) {
      return new Promise((res, rej) => {
        if (!socket || socket.destroyed) return rej(new Error('الاتصال مغلق'));
        socket.write(cmd + '\r\n', 'utf8', err => err ? rej(err) : res());
      });
    }
    async function cmd(line, expect) {
      await send(line);
      const r = await readReply();
      if (expect && r.code !== expect) {
        const detail = r.lines.join(' ').slice(0, 300);
        throw new Error('خادم البريد رفض الأمر (' + r.code + '): ' + detail);
      }
      return r;
    }

    function attach(sock) {
      socket = sock;
      socket.setTimeout(TIMEOUT_MS, () => fail(new Error('انتهت مهلة الاتصال بخادم البريد')));
      socket.on('data', onData);
      socket.on('error', fail);
      socket.on('close', () => { if (!finished && step < 99) fail(new Error('أُغلق الاتصال بخادم البريد')); });
    }

    function start() {
      attach(cfg.secure
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : net.connect({ host: cfg.host, port: cfg.port }));
    }

    async function upgradeToTls() {
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.removeAllListeners('timeout');
      const plain = socket;
      const secure = await new Promise((res, rej) => {
        const s = tls.connect({ socket: plain, servername: cfg.host }, () => res(s));
        s.once('error', rej);
      });
      attach(secure);
    }

    async function auth() {
      if (!cfg.user) return; // no auth requested (relay allows anonymous)
      const ehlo = await cmd('EHLO dental-inventory.local', 250);
      const caps = ehlo.lines.join(' ').toUpperCase();
      if (caps.includes('AUTH') && /AUTH[^\n]*(PLAIN)/.test(caps)) {
        await cmd('AUTH PLAIN ' + b64('\u0000' + cfg.user + '\u0000' + cfg.pass), 235);
      } else {
        await cmd('AUTH LOGIN', 334);
        await cmd(b64(cfg.user), 334);
        await cmd(b64(cfg.pass), 235);
      }
    }

    async function run() {
      start();
      const greeting = await readReply();
      if (greeting.code !== 220 && greeting.code !== 250) {
        throw new Error('تعذّر الاتصال بخادم البريد (' + greeting.code + ')');
      }
      step = 1;

      if (!cfg.secure) {
        const ehlo = await cmd('EHLO dental-inventory.local', 250);
        const caps = ehlo.lines.join(' ').toUpperCase();
        if (/STARTTLS/.test(caps)) {
          await cmd('STARTTLS', 220);
          await upgradeToTls();
        }
      }
      await auth();

      const mail = cfg.message;
      await cmd('MAIL FROM:<' + cfg.from + '>', 250);
      await cmd('RCPT TO:<' + mail.to + '>', 250);
      await cmd('DATA', 354);
      // dot-stuffing + terminator
      const payload = mail.raw.replace(/\r\n\./g, '\r\n..');
      await send(payload + '\r\n.');
      const afterData = await readReply();
      if (afterData.code !== 250) throw new Error('رفض خادم البريد الرسالة (' + afterData.code + ')');
      step = 99;
      try { await send('QUIT'); } catch (e) { /* ignore */ }
      done({ sent: true });
    }

    run().catch(fail);
  });
}

/**
 * Send one e-mail. Never throws: resolves with a status object so callers can
 * degrade gracefully.
 * @returns {Promise<{sent:boolean, skipped?:boolean, error?:string}>}
 */
async function sendMail({ to, subject, text, html }) {
  const cfg = getConfig();
  if (!cfg.host || !cfg.from) return { sent: false, skipped: true, error: 'SMTP غير مُعدّ' };
  if (!to) return { sent: false, error: 'لا يوجد بريد للمستلم' };
  try {
    cfg.message = { to, raw: buildMessage({ from: cfg.from, to, replyTo: cfg.replyTo, subject, text, html }) };
    const r = await smtpSession(cfg);
    return { sent: !!(r && r.sent) };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { sendMail, isConfigured, getConfig, buildMessage };
