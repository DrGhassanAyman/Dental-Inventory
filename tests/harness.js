/**
 * jsdom harness: boots the real index.html app, gets past the auth screen,
 * and exposes helpers for clicking real buttons / inspecting the real DOM.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');

function boot(opts = {}) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // seed a local clinic account + session so bootApp() skips the login screen
      const user = { id: 'u_test', clinicName: 'عيادة الاختبار', username: 'clinic_test', phone: '0790000000', address: '' };
      window.localStorage.setItem('dental_users_v1', JSON.stringify([user]));
      window.localStorage.setItem('dental_session_v1', 'u_test');
      window.confirm = () => true;          // auto-accept confirm() dialogs
      window.alert = (m) => { window.__alerts.push(m); };
      window.__alerts = [];
      window.open = () => null;
      window.print = () => {};
      // jsdom has no layout: give every getBoundingClientRect a stable size
      window.Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON(){} };
      };
      if (!window.PointerEvent) {
        window.PointerEvent = class PointerEvent extends window.MouseEvent {
          constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId || 1; }
        };
      }
      if (!window.HTMLElement.prototype.setPointerCapture) {
        window.HTMLElement.prototype.setPointerCapture = function () {};
        window.HTMLElement.prototype.releasePointerCapture = function () {};
      }
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { drawImage() {}, fillRect() {}, clearRect() {}, putImageData() {}, createImageData() { return []; } };
      };
      window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,AAA'; };
      // jsdom does not implement these; the app's export/print paths need them to exist
      window.URL.createObjectURL = function () { return 'blob:stub'; };
      window.URL.revokeObjectURL = function () {};
      // jsdom never decodes images; emulate the load so image-aspect code paths actually run
      const RealImage = window.Image;
      window.Image = function FakeImage() {
        const self = this;
        self.naturalWidth = 0; self.naturalHeight = 0; self.width = 0; self.height = 0;
        let _src = '';
        Object.defineProperty(self, 'src', {
          get() { return _src; },
          set(v) {
            _src = v;
            if (!v) return;
            window.setTimeout(() => {
              // pretend every photo is 800x400 unless the test says otherwise
              self.naturalWidth = window.__imgW || 800;
              self.naturalHeight = window.__imgH || 400;
              self.width = self.naturalWidth; self.height = self.naturalHeight;
              if (typeof self.onload === 'function') self.onload();
            }, 0);
          },
        });
        return self;
      };
      void RealImage;
    },
  });

  const { window } = dom;
  const doc = window.document;

  return {
    dom, window, doc, errors,
    /** wait until the app finished booting (initAppUI ran) */
    async ready() {
      for (let i = 0; i < 200 && !window.__appReady; i++) await tick(window, 10);
      if (!window.__appReady) throw new Error('app never became ready; errors: ' + errors.join('\n'));
      return this;
    },
  };
}

function tick(window, ms = 0) { return new Promise((r) => window.setTimeout(r, ms)); }

const $ = (doc, sel) => doc.querySelector(sel);
const isVisible = (el) => !!el && !el.classList.contains('hidden');
function click(doc, id) {
  const el = doc.getElementById(id);
  if (!el) throw new Error('no element with id ' + id);
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
}

module.exports = { boot, tick, click, isVisible, ROOT };
