'use strict';
// Drives the real Electron app (dev or packaged) through the Chrome DevTools Protocol for automated UI verification.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw new Error('Timed out waiting for ' + (label || 'condition') + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    const api = {
      send(method, params) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          // a closed socket would otherwise leave the call (and the whole test) hanging for ever
          if (ws.readyState !== 1) { rej(new Error(method + ': CDP websocket is closed')); return; }
          pending.set(id, { res, rej, method });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      onEvent(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    };
    ws.onopen = () => resolve(api);
    ws.onerror = (e) => reject(new Error('CDP websocket error'));
    ws.onclose = () => {
      pending.forEach((p) => p.rej(new Error(p.method + ': CDP websocket closed')));
      pending.clear();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(p.method + ': ' + JSON.stringify(msg.error)));
        else p.res(msg.result);
      } else {
        listeners.forEach((fn) => fn(msg));
      }
    };
  });
}

// opts: { exe?, userData, files?, env?, port?, args?, keepUserData? }
async function launch(opts) {
  const port = opts.port || 9333;
  if (!opts.keepUserData) fs.rmSync(opts.userData, { recursive: true, force: true });
  fs.mkdirSync(opts.userData, { recursive: true });
  const env = Object.assign({}, process.env, { VE_TEST_MODE: '1' }, opts.env || {});
  delete env.ELECTRON_RUN_AS_NODE;
  let exe = opts.exe || process.env.VE_EXE; // VE_EXE: run the suites against the packaged application
  const args = [];
  if (!exe) {
    exe = require(path.join(ROOT, 'node_modules', 'electron'));
    args.push(ROOT);
  }
  args.push('--remote-debugging-port=' + port, '--user-data-dir=' + opts.userData);
  (opts.args || []).forEach((a) => args.push(a));
  (opts.files || []).forEach((f) => args.push(f));

  const child = spawn(exe, args, { cwd: opts.cwd || ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { out: '', err: '' };
  child.stdout.on('data', (d) => { log.out += d.toString(); });
  child.stderr.on('data', (d) => { log.err += d.toString(); });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const target = await waitUntil(async () => {
    if (exited !== null) throw new Error('app exited early with code ' + exited + '\n' + log.err);
    const list = await getJson('http://127.0.0.1:' + port + '/json');
    return list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  }, 30000, 'app window');

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const errors = [];
  const consoleLog = [];
  cdp.onEvent((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('exception: ' + ((d.exception && d.exception.description) || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value !== undefined ? a.value : (a.description || '')).join(' ');
      consoleLog.push(msg.params.type + ': ' + text);
      if (msg.params.type === 'error') errors.push('console.error: ' + text);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') errors.push('log.' + e.source + ': ' + e.text + ' ' + (e.url || ''));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  // The DOM exists before the scripts have run: wait until the app has fully initialised.
  await waitUntil(async () => {
    const r = await cdp.send('Runtime.evaluate', { expression: "document.readyState === 'complete' && typeof VE !== 'undefined' && !!VE.actions && !!VE.exportUI", returnByValue: true });
    return r.result && r.result.value === true;
  }, 30000, 'renderer initialisation');

  const app = {
    port, child, cdp, errors, consoleLog, log, target,
    async evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('evaluate failed: ' + ((d.exception && d.exception.description) || d.text) + '\n' + expression.slice(0, 200));
      }
      return r.result.value;
    },
    async waitFor(expression, timeoutMs, label) {
      return waitUntil(() => app.evaluate(expression), timeoutMs || 15000, label || expression.slice(0, 80));
    },
    async screenshot(file, clip) {
      const params = { format: 'png', fromSurface: true };
      if (clip) params.clip = Object.assign({ scale: 1 }, clip);
      // A minimised or fully occluded window never produces a frame, so the request would hang forever:
      // time out, bring the window back and retry before giving up.
      let r = null;
      for (let attempt = 0; attempt < 3 && !r; attempt++) {
        r = await Promise.race([cdp.send('Page.captureScreenshot', params), sleep(attempt === 0 ? 20000 : 10000).then(() => null)]);
        if (!r) await Promise.race([cdp.send('Page.bringToFront').catch(() => {}), sleep(2000)]);
      }
      if (!r) throw new Error('screenshot timed out (is the app window minimised?)');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async rect(selector) {
      return app.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    },
    async mouse(type, x, y, extra) {
      await cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, extra || {}));
    },
    async clickAt(x, y) {
      await app.mouse('mouseMoved', x, y);
      await app.mouse('mousePressed', x, y, { buttons: 1 });
      await app.mouse('mouseReleased', x, y);
    },
    async click(selector) {
      await app.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); })()`);
      const r = await app.rect(selector);
      if (!r) throw new Error('click: no element ' + selector);
      await app.clickAt(r.x + r.w / 2, r.y + r.h / 2);
    },
    async drag(from, to, steps) {
      const n = steps || 12;
      await app.mouse('mouseMoved', from.x, from.y);
      await app.mouse('mousePressed', from.x, from.y, { buttons: 1 });
      for (let i = 1; i <= n; i++) {
        await app.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n, { buttons: 1 });
        await sleep(12);
      }
      await app.mouse('mouseReleased', to.x, to.y);
    },
    async key(key, mods) {
      const m = mods || {};
      const modifiers = (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.shift ? 8 : 0);
      const codes = { ' ': ['Space', 32], Delete: ['Delete', 46], Backspace: ['Backspace', 8], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Home: ['Home', 36], End: ['End', 35], Escape: ['Escape', 27] };
      const c = codes[key] || ['Key' + key.toUpperCase(), key.toUpperCase().charCodeAt(0)];
      const base = { key, code: c[0], windowsVirtualKeyCode: c[1], modifiers };
      const printable = key.length === 1 && !m.ctrl && !m.alt;
      await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: printable ? 'keyDown' : 'rawKeyDown' }, base, printable ? { text: key } : {}));
      await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    },
    async dropFiles(files, x, y) {
      const data = { items: [], files, dragOperationsMask: 1 };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    },
    async resize(w, h) {
      const { windowId } = await cdp.send('Browser.getWindowForTarget').catch(() => ({}));
      if (windowId) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } });
    },
    async close() {
      cdp.close();
      if (exited === null && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      await sleep(300);
    },
    exited: () => exited,
  };
  return app;
}

module.exports = { launch, sleep, waitUntil, ROOT };
