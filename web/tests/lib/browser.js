'use strict';
// Drives a real Chrome / Edge through the Chrome DevTools Protocol (no test framework, no dependencies; Node 22+ has a global WebSocket).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  if (process.env.VE_BROWSER && fs.existsSync(process.env.VE_BROWSER)) return process.env.VE_BROWSER;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('No Chrome / Edge found. Set VE_BROWSER to the browser executable.');
  return found;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
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
    await sleep(100);
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
          if (ws.readyState !== 1) { rej(new Error(method + ': CDP websocket is closed')); return; }
          pending.set(id, { res, rej, method });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      onEvent(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('CDP websocket error'));
    ws.onclose = () => { pending.forEach((p) => p.rej(new Error(p.method + ': CDP websocket closed'))); pending.clear(); };
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

// opts: { url, userData?, headless?, width?, height?, args?, ready? (expression that must become truthy) }
async function launch(opts) {
  const o = opts || {};
  const port = await freePort();
  const userData = o.userData || fs.mkdtempSync(path.join(os.tmpdir(), 've-web-'));
  const exe = findBrowser();
  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate,msEdgeSidebar,EdgeFirstRunExperience',
    '--window-size=' + (o.width || 1366) + ',' + (o.height || 820),
  ];
  if (o.headless !== false) args.push('--headless=new');
  // extra flags for the environment (CI: VE_BROWSER_FLAGS=--no-sandbox, a hosted runner does not allow the browser's own sandbox)
  (process.env.VE_BROWSER_FLAGS || '').split(/\s+/).filter(Boolean).forEach((a) => args.push(a));
  (o.args || []).forEach((a) => args.push(a));
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
  const log = { err: '' };
  child.stderr.on('data', (d) => { log.err += d.toString(); });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const target = await waitUntil(async () => {
    if (exited !== null) throw new Error('browser exited early with code ' + exited + '\n' + log.err.slice(-2000));
    const list = await getJson('http://127.0.0.1:' + port + '/json');
    return list.find((t) => t.type === 'page');
  }, 30000, 'browser page');

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const errors = [];
  const consoleLog = [];
  const requests = [];
  cdp.onEvent((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('exception: ' + ((d.exception && d.exception.description) || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => (a.value !== undefined ? a.value : (a.description || ''))).join(' ');
      consoleLog.push(msg.params.type + ': ' + text);
      if (msg.params.type === 'error') errors.push('console.error: ' + text);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') errors.push('log.' + e.source + ': ' + e.text + ' ' + (e.url || ''));
    } else if (msg.method === 'Network.requestWillBeSent') {
      requests.push(msg.params.request.url);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const app = {
    port, child, cdp, errors, consoleLog, requests, userData, log, exe,
    async evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('evaluate failed: ' + ((d.exception && d.exception.description) || d.text) + '\n' + expression.slice(0, 300));
      }
      return r.result.value;
    },
    async waitFor(expression, timeoutMs, label) {
      return waitUntil(() => app.evaluate(expression), timeoutMs || 15000, label || expression.slice(0, 80));
    },
    async navigate(url, ready) {
      await cdp.send('Page.navigate', { url });
      await waitUntil(async () => (await app.evaluate("document.readyState === 'complete'")) === true, 30000, 'page load');
      if (ready) await app.waitFor(ready, 30000, 'app ready');
    },
    async screenshot(file, clip) {
      const params = { format: 'png', fromSurface: true };
      if (clip) params.clip = Object.assign({ scale: 1 }, clip);
      let r = null;
      for (let attempt = 0; attempt < 3 && !r; attempt++) {
        r = await Promise.race([cdp.send('Page.captureScreenshot', params), sleep(attempt === 0 ? 20000 : 10000).then(() => null)]);
        if (!r) await Promise.race([cdp.send('Page.bringToFront').catch(() => {}), sleep(2000)]);
      }
      if (!r) throw new Error('screenshot timed out');
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
    async close() {
      cdp.close();
      if (exited === null && child.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      }
      await sleep(400);
      if (!o.userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* leftovers are in TEMP */ } }
    },
    exited: () => exited,
  };
  if (o.url) await app.navigate(o.url, o.ready);
  return app;
}

module.exports = { launch, sleep, waitUntil, findBrowser };
