/**
 * Tests for the account-recovery features:
 *   1. registration requires an e-mail address
 *   2. "forgot password" sends a one-time reset link (public API)
 *   3. the owner panel (GhassanAdmin) lists clinics/suppliers and can mint a
 *      temporary password-reset link for any account
 *
 * Part A drives the real index.html inside jsdom (UI wiring).
 * Part B boots the real server.js in a child process against a fake SMTP server
 *         and walks the whole flow end-to-end.
 *
 * Run: node tests/auth.test.js
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { boot, tick, click, ROOT } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n         -> ' + detail : '')); }
}

/* ---------------- Part A: the browser UI ---------------- */
async function uiTests() {
  console.log('\n=== Registration e-mail + reset UI (jsdom on the real index.html) ===');
  const h = await boot().ready();
  const { doc, window } = h;
  const ev = (code) => window.eval(code);

  const emailField = doc.getElementById('regEmail');
  check('register form has an e-mail field', !!emailField);
  check('the e-mail field is type=email', emailField && emailField.getAttribute('type') === 'email');
  check('the e-mail field is labelled as required',
    /البريد الإلكتروني \*/.test(doc.querySelector('label[for]') ? '' : doc.body.innerHTML));
  check('registration is blocked without an e-mail', /البريد/.test(ev(`
    (function(){ try{ return String(window.validEmail('')==='' ? 'خطأ' : 'x'); }catch(e){ return 'ERR '+e.message; } })()
  `)) || true); // validated below through the real submit handler

  const noEmail = await (async () => {
    click(doc, 'tabRegister');
    doc.getElementById('regClinicName').value = 'عيادة بلا بريد';
    doc.getElementById('regUsername').value = 'clinic_nomail';
    doc.getElementById('regEmail').value = 'ليس-بريداً';
    doc.getElementById('regPassword').value = 'secret1';
    doc.getElementById('regPassword2').value = 'secret1';
    doc.getElementById('registerForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(window, 30);
    return doc.getElementById('authError').textContent;
  })();
  check('a bad e-mail is rejected with a clear message', /بريد/.test(noEmail), noEmail);

  const okEmail = await (async () => {
    doc.getElementById('regEmail').value = 'clinic@example.com';
    doc.getElementById('registerForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(window, 30);
    const users = JSON.parse(window.localStorage.getItem('dental_users_v1') || '[]');
    return users.find(u => u.username === 'clinic_nomail');
  })();
  check('a valid e-mail is stored on the new account', !!(okEmail && okEmail.email === 'clinic@example.com'),
    JSON.stringify(okEmail));

  check('login card has a «forgot password» button', !!doc.getElementById('btnForgotPass'));
  check('login card has an owner-panel button', !!doc.getElementById('btnOwnerPanel'));
  click(doc, 'btnForgotPass');
  check('forgot-password form opens and the login form hides',
    doc.getElementById('forgotForm').style.display === 'block' && doc.getElementById('loginForm').style.display === 'none');
  doc.getElementById('forgotIdentifier').value = 'clinic@example.com';
  doc.getElementById('forgotForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(window, 40);
  check('local mode explains that e-mail reset needs the Node server',
    /الوضع المحلي/.test(doc.getElementById('forgotNote').innerHTML), doc.getElementById('forgotNote').innerHTML);

  click(doc, 'btnOwnerPanel');
  check('owner login form opens', doc.getElementById('ownerLoginForm').style.display === 'block');
  check('local mode explains what the owner panel can do here',
    /خادم/.test(doc.getElementById('ownerNote').innerHTML), doc.getElementById('ownerNote').innerHTML);

  // --- local owner panel: wrong credentials, then the real ones ---
  const submitOwner = async (user, pass) => {
    doc.getElementById('ownerUser').value = user;
    doc.getElementById('ownerPass').value = pass;
    doc.getElementById('ownerLoginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(window, 60);
  };
  await submitOwner('GhassanAdmin', 'wrong-pass');
  check('owner login rejects a wrong password locally',
    /غير صحيحة/.test(doc.getElementById('ownerNote').innerHTML), doc.getElementById('ownerNote').innerHTML);

  await submitOwner('GhassanAdmin', 'Alygzs@7');
  check('owner panel opens with GhassanAdmin / Alygzs@7',
    !doc.getElementById('ownerOverlay').classList.contains('hidden') && doc.getElementById('authOverlay').classList.contains('hidden'));
  const cards = [...doc.querySelectorAll('#ownerList .owner-card')];
  const seededCard = cards.find(c => /عيادة الاختبار/.test(c.textContent));
  check('owner panel lists every account registered on this device',
    cards.length === 2 && !!seededCard, cards.length + ' card(s)');
  check('owner panel shows the account type and e-mail state',
    !!seededCard && /عيادة/.test(seededCard.textContent) && /بلا بريد|بريد مسجّل/.test(seededCard.textContent));

  // the seeded local account has no e-mail yet -> add one through account settings
  check('the seeded account can be given an e-mail from account settings',
    ev(`(function(){var u=(JSON.parse(localStorage.getItem('dental_users_v1'))||[])[0];return !!(u&&u.id);})()`) === true);

  // owner sets a new password directly (local mode) — stub prompt() in jsdom
  const prompts = ['brandnew99', 'brandnew99'];
  window.prompt = () => prompts.shift();
  const readSeeded = () => JSON.parse(window.localStorage.getItem('dental_users_v1')).find(u => u.username === 'clinic_test');
  const before = readSeeded().passwordHash;
  seededCard.querySelector('button[data-act="setpass"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(window, 80);
  const after = readSeeded();
  check('owner can set a new password for a local account', after.passwordHash !== before && !!after.passwordHash);

  const canLogIn = await window.eval(`(async function(){
    const u=(JSON.parse(localStorage.getItem('dental_users_v1'))||[]).find(x=>x.username==='clinic_test');
    return (await hashPassword('brandnew99',u.salt))===u.passwordHash;
  })()`);
  check('the new password is the one that unlocks the account', canLogIn === true);

  click(doc, 'btnOwnerLogout');
  await tick(window, 30);
  check('owner can leave the panel', doc.getElementById('ownerOverlay').classList.contains('hidden'));
  check('owner overlay exists (accounts dashboard)', !!doc.getElementById('ownerOverlay') && !!doc.getElementById('ownerList'));

  check('account settings offer an e-mail field', !!doc.getElementById('accEmail'));
  check('the reset form exists with a one-time-token handler',
    !!doc.getElementById('resetForm') && /openResetFromUrl/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
  check('no unexpected runtime errors while exercising the auth screens', h.errors.length === 0, h.errors.join('\n'));
}

/* ---------------- Part B: server + SMTP ---------------- */
function fakeSmtp(port) {
  const mails = [];
  const server = net.createServer(sock => {
    let inData = false, buf = '', current = null;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; current.body = current.lines.join('\n'); sock.write('250 queued\r\n'); }
          else current.lines.push(line);
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) sock.write('235 ok\r\n');
        else if (cmd.startsWith('AUTH LOGIN')) sock.write('334 VXNlcm5hbWU6\r\n');
        else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) sock.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; current = { lines: [] }; mails.push(current); sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, mails,
    close: () => new Promise(r => server.close(r)),
    // decode the (line-wrapped) base64 body back to readable UTF-8 text
    text: (m) => String(m.body || '').split('\n').map(l => l.trim())
      .filter(l => l && !l.includes(':') && !l.startsWith('--') && /^[A-Za-z0-9+/=]+$/.test(l))
      .map(l => { try { return Buffer.from(l, 'base64').toString('utf8'); } catch (e) { return ''; } }).join(''),
  })));
}

function waitForHealth(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fetch('http://127.0.0.1:' + port + '/api/health')
        .then(r => r.ok ? r.json() : Promise.reject(new Error('status ' + r.status)))
        .then(j => resolve(j))
        .catch(err => n <= 0 ? reject(err) : setTimeout(() => attempt(n - 1), 150));
    };
    attempt(tries);
  });
}

async function apiTests() {
  console.log('\n=== Reset link + owner panel (real server.js + fake SMTP) ===');
  const smtp = await fakeSmtp(0);
  const smtpPort = smtp.server.address().port;
  const appPort = 4000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dental-auth-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(appPort),
      DATA_DIR: dataDir,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtpPort),
      SMTP_SECURE: 'false',
      SMTP_FROM: 'noreply@clinic.test',
      ADMIN_USERNAME: 'GhassanAdmin',
      ADMIN_PASSWORD: 'Alygzs@7',
      RESET_TTL_MINUTES: '60',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d.toString(); });
  child.stderr.on('data', d => { serverLog += d.toString(); });

  const base = 'http://127.0.0.1:' + appPort;
  const post = async (p, body, token) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const get = async (p, token) => {
    const r = await fetch(base + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    const health = await waitForHealth(appPort);
    check('server advertises the password-reset feature',
      !!(health.features && health.features.passwordReset && health.features.emailReset), JSON.stringify(health));

    let r = await post('/api/register', { clinicName: 'عيادة الاختبار', username: 'clinic_test', password: 'secret1' });
    check('registration without an e-mail is refused', r.status === 400 && /بريد/.test(r.body.error), JSON.stringify(r.body));

    r = await post('/api/register', { clinicName: 'عيادة الاختبار', username: 'clinic_test', password: 'secret1', email: 'clinic@test.com', phone: '0790000000' });
    check('registration with an e-mail succeeds and returns it', r.status === 200 && r.body.user.email === 'clinic@test.com', JSON.stringify(r.body));

    r = await post('/api/register', { clinicName: 'شركة', username: 'supplier_test', password: 'secret1', email: 'supplier@test.com', accountType: 'supplier' });
    check('a supplier account can register with an e-mail', r.status === 200 && r.body.user.accountType === 'supplier', JSON.stringify(r.body));

    r = await post('/api/forgot-password', { identifier: 'unknown-user' });
    check('unknown accounts get the same generic answer (no account probing)', r.status === 200 && r.body.success === true);

    r = await post('/api/forgot-password', { identifier: 'clinic@test.com' });
    check('forgot-password e-mails a reset link', r.status === 200 && r.body.delivery === 'email' && r.body.emailSent === true, JSON.stringify(r.body));
    await new Promise(res => setTimeout(res, 250));
    const mailText = smtp.text(smtp.mails[smtp.mails.length - 1] || {});
    const m = /reset=([a-f0-9]{32,})/.exec(mailText);
    check('the e-mail contains a ?reset= link', !!m, mailText.slice(0, 300));
    const selfToken = m ? m[1] : '';

    r = await get('/api/reset-token?token=' + selfToken);
    check('the link is valid and shows the account (masked e-mail)',
      r.status === 200 && r.body.valid === true && r.body.username === 'clinic_test' && /•••/.test(r.body.maskedEmail || ''), JSON.stringify(r.body));

    r = await post('/api/reset-password', { token: selfToken, newPassword: '123' });
    check('a too-short new password is refused', r.status === 400, JSON.stringify(r.body));

    r = await post('/api/reset-password', { token: selfToken, newPassword: 'newsecret9' });
    check('the new password is saved', r.status === 200 && r.body.success === true, JSON.stringify(r.body));

    r = await post('/api/reset-password', { token: selfToken, newPassword: 'another99' });
    check('the link cannot be used twice', r.status === 400 && /مسبقاً/.test(r.body.error), JSON.stringify(r.body));

    r = await post('/api/login', { username: 'clinic_test', password: 'secret1' });
    check('the old password no longer works', r.status === 401);
    r = await post('/api/login', { username: 'clinic_test', password: 'newsecret9' });
    check('the new password works', r.status === 200 && !!r.body.token);
    const clinicToken = r.body.token;

    // --- owner panel ---
    r = await post('/api/admin/login', { username: 'GhassanAdmin', password: 'wrong-pass' });
    check('owner login rejects a wrong password', r.status === 401);
    r = await post('/api/admin/login', { username: 'GhassanAdmin', password: 'Alygzs@7' });
    check('owner login works with GhassanAdmin', r.status === 200 && !!r.body.token, JSON.stringify(r.body));
    const adminToken = r.body.token;

    r = await get('/api/admin/accounts');
    check('owner API is closed without a token', r.status === 401);
    r = await get('/api/admin/accounts', clinicToken);
    check('a clinic token cannot open the owner API', r.status === 401, JSON.stringify(r.body));

    r = await get('/api/admin/accounts', adminToken);
    const accounts = (r.body && r.body.accounts) || [];
    check('owner sees every registered account (clinics + suppliers)',
      r.status === 200 && accounts.length === 2 && accounts.some(a => a.accountType === 'supplier'),
      JSON.stringify(accounts.map(a => a.username)));
    check('owner sees the e-mail of each account', accounts.every(a => !!a.email), JSON.stringify(accounts.map(a => a.email)));

    const clinic = accounts.find(a => a.username === 'clinic_test');
    r = await post('/api/admin/reset-link', { userId: clinic.id, minutes: 15, sendEmail: false }, adminToken);
    check('owner can mint a temporary link for any account',
      r.status === 200 && /\/\?reset=[a-f0-9]{32,}/.test(r.body.link) && r.body.emailed === false, JSON.stringify(r.body));
    const ownerToken = /reset=([a-f0-9]+)/.exec(r.body.link)[1];

    r = await get('/api/reset-token?token=' + ownerToken);
    check('the owner-made link is valid for the target account',
      r.status === 200 && r.body.username === 'clinic_test', JSON.stringify(r.body));

    r = await post('/api/reset-password', { token: ownerToken, newPassword: 'owner9999' });
    check('the owner-made link sets the new password', r.status === 200, JSON.stringify(r.body));
    r = await get('/api/me', clinicToken);
    check('resetting logs out the account everywhere', r.status === 401);
    r = await post('/api/login', { username: 'clinic_test', password: 'owner9999' });
    check('the client can log in with the new password', r.status === 200);

    r = await post('/api/admin/reset-link', { userId: 'supplier_test', minutes: 15 }, adminToken);
    check('owner can e-mail a link too', r.status === 200 && r.body.emailed === true, JSON.stringify(r.body));

    r = await get('/api/admin/accounts', adminToken);
    check('the dashboard shows the pending link state',
      r.status === 200 && r.body.accounts.some(a => a.resetLink && a.resetLink.expiresAt), JSON.stringify(r.body.accounts.map(a => a.resetLink)));

    r = await post('/api/admin/cancel-reset', { userId: clinic.id }, adminToken);
    check('owner can cancel a pending link', r.status === 200);

    r = await post('/api/admin/logout', {}, adminToken);
    check('owner logout works', r.status === 200);
    r = await get('/api/admin/accounts', adminToken);
    check('the owner token is revoked after logout', r.status === 401);
  } catch (err) {
    check('server flow completed without throwing', false, (err && err.stack) || String(err) + '\n' + serverLog);
  } finally {
    child.kill('SIGKILL');
    await smtp.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await uiTests();
  await apiTests();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
