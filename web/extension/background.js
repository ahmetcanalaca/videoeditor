'use strict';
// The bridge between the Video Editor web page and Foundry Local on this computer. Foundry Local's server sends no CORS headers, so a web page cannot read its
// answers; an extension with host permission for 127.0.0.1 can. This service worker is the only place that talks to Foundry Local:
//   - it serves the pages the manifest names (content.js relays the page's messages here) and nobody else;
//   - the user has to approve a site once (a window of this extension, not of the page);
//   - a page can ask for four routes of Foundry Local, by name, with a checked model id / body (policy.js) - never for an address, a port or a path;
//   - the address of Foundry Local is found here (last port, 5272, or - only when the user asks - a scan of the dynamic port range) and checked: what
//     answers must describe itself as Foundry Local at exactly that address (GET /status), and is looked at again after a quiet spell.
// No data is kept except: the approved sites, the last port, the language of the page. Prompts, pictures and answers pass through and are not stored.
importScripts('policy.js');

const P = self.VEPolicy;
const MANIFEST = chrome.runtime.getManifest();
const VERSION = MANIFEST.version;
const MATCHES = (MANIFEST.content_scripts || []).reduce((all, c) => all.concat(c.matches || []), []);
const SELF = chrome.runtime.getURL('');
const CONSENT_URL = chrome.runtime.getURL('consent.html');
const SCAN_WORKERS = 96;
const SCAN_PROBE_MS = 700;
const SCAN_COOLDOWN_MS = 4000;
const CONSENT_TIMEOUT_MS = 3 * 60 * 1000;
// What answered as Foundry Local a while ago may not be there any more (it was stopped, and another program took the port): after this long without a request the
// address is looked at again - GET /status, a few bytes - before anything of the user's is sent to it. A program that says nothing is given a second, longer chance
// (Foundry Local may be busy with another program) and then gets nothing - unless another request of ours is running, which explains a slow answer.
const VERIFY_IDLE_MS = 30000;
const VERIFY_PROBE_MS = 4000;
const VERIFY_RETRY_MS = 15000;
// requests of pages that wait for one of the two places: more are refused (BUSY) instead of being held in memory
const MAX_WAITING = 16;

const state = { base: '', verifiedAt: 0, scanning: null, lastScan: 0, running: 0, waiters: [], consent: null };

// the approvals are not for the content script (it runs inside the page's process, in the page's company): only the pages and the worker of the extension read them
try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => { /* refused: the content script does not use storage anyway */ }); } catch (e) { /* an older browser */ }

/* ------------------------------------------------------------------ storage: approved sites, last port, language */

const store = {
  async approved() { const r = await chrome.storage.local.get('approved'); return r.approved && typeof r.approved === 'object' ? r.approved : {}; },
  async isApproved(origin) { return Object.prototype.hasOwnProperty.call(await store.approved(), origin); },
  async approve(origin) { const a = await store.approved(); a[origin] = { at: new Date().toISOString() }; await chrome.storage.local.set({ approved: a }); },
  async revoke(origin) { const a = await store.approved(); delete a[origin]; await chrome.storage.local.set({ approved: a }); },
  async port() { const r = await chrome.storage.local.get('port'); return P.validPort(r.port) ? r.port : 0; },
  async setPort(port) { await chrome.storage.local.set({ port }); },
  async lang() { const r = await chrome.storage.local.get('lang'); return P.cleanLang(r.lang) || (/^tr/i.test(chrome.i18n.getUILanguage()) ? 'tr' : 'en'); },
  async setLang(lang) { if (P.cleanLang(lang)) await chrome.storage.local.set({ lang }); },
};

/* ------------------------------------------------------------------ talking to Foundry Local */

// Plain GET/POST to the fixed address: no cookies, no referrer, no redirects (a redirect could lead somewhere else), no cache.
const initOf = (method, signal, body) => {
  const init = { method, signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { accept: 'application/json' } };
  if (body !== undefined) { init.body = body; init.headers['content-type'] = 'application/json'; }
  return init;
};

class TooLarge extends Error {}

// the body of a response as text, never more than `max` bytes
async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new TooLarge('too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch (e) { /* gone */ } throw new TooLarge('too large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

// Is Foundry Local listening on this port? -> { ok: true, status } | { ok: false, code: 'NOT_FOUND' (nothing there) | 'NOT_FOUNDRY' (something else) | 'SLOW' (no answer in time) }
async function probe(port, ms) {
  const base = P.baseOf(port);
  const ctl = new AbortController();
  let slow = false;
  const timer = setTimeout(() => { slow = true; ctl.abort(); }, ms);
  let text;
  try {
    const res = await fetch(base + '/status', initOf('GET', ctl.signal));
    if (!res.ok) return { ok: false, code: 'NOT_FOUNDRY' };
    text = await readCapped(res, P.LIMITS.statusBytes);
  } catch (e) {
    return { ok: false, code: e instanceof TooLarge ? 'NOT_FOUNDRY' : (slow ? 'SLOW' : 'NOT_FOUND') };
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return P.isFoundryStatus(json, base) ? { ok: true, status: json } : { ok: false, code: 'NOT_FOUNDRY' };
}

async function adopt(port) {
  state.base = P.baseOf(port);
  state.verifiedAt = Date.now();
  await store.setPort(port);
  return { base: state.base, port };
}

// every port of the dynamic range, only when the user asked for it (a button), never in the background
function scan() {
  if (state.scanning) return state.scanning;
  const [lo, hi] = P.SCAN_RANGE;
  let next = lo;
  let found = 0;
  const worker = async () => {
    while (!found && next <= hi) {
      const port = next++;
      const r = await probe(port, SCAN_PROBE_MS);
      if (r.ok && !found) found = port;
    }
  };
  state.scanning = Promise.all(Array.from({ length: SCAN_WORKERS }, worker)).then(() => found).finally(() => { state.scanning = null; state.lastScan = Date.now(); });
  return state.scanning;
}

// -> { base, port } or null. The ports tried first: the last one that worked, the one that the guide recommends fixing; then - only when asked - the whole range.
async function discover(opts) {
  const o = opts || {};
  const order = [];
  for (const p of [await store.port(), ...P.DEFAULT_PORTS]) if (P.validPort(p) && !order.includes(p)) order.push(p);
  const results = await Promise.all(order.map((p) => probe(p, 1500)));
  const at = results.findIndex((r) => r.ok);
  if (at >= 0) return adopt(order[at]);
  if (o.scan) {
    const port = await scan();
    if (port) return adopt(port);
  }
  state.base = '';
  return null;
}

function acquire() {
  return new Promise((resolve) => {
    if (state.running < P.LIMITS.concurrent) { state.running++; resolve(); } else state.waiters.push(resolve);
  });
}
function release() {
  state.running--;
  const next = state.waiters.shift();
  if (next) { state.running++; next(); }
}

// One request of a page to Foundry Local (c = checkCall()'s result). Resolves with the answer as it is - an HTTP error of Foundry Local is an answer, too.
async function callFoundry(conn, id, c) {
  // a page that sends more than can be answered is told so; the extension does not hold everything it is sent
  if (state.waiters.length >= MAX_WAITING) return { ok: false, code: 'BUSY' };
  const ctl = new AbortController();
  conn.controllers.set(id, ctl);
  await acquire();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, c.timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (ctl.signal.aborted) return { ok: false, code: 'ABORTED' };
      let base = state.base;
      if (!base) { const found = await discover({}); base = found ? found.base : ''; }
      if (!base) return { ok: false, code: 'NOT_FOUND' };
      // Nobody asked for a while: is it still Foundry Local there? Another answer, or no one listening, ends it; no answer at all is only accepted while a request
      // of ours is running (that is what keeps Foundry Local busy) - otherwise it gets one more, longer chance, and then nothing is sent.
      if (Date.now() - state.verifiedAt > VERIFY_IDLE_MS) {
        const port = Number(new URL(base).port);
        let v = await probe(port, VERIFY_PROBE_MS);
        if (v.code === 'SLOW' && state.running <= 1) v = await probe(port, VERIFY_RETRY_MS);
        if (ctl.signal.aborted) return { ok: false, code: timedOut ? 'TIMEOUT' : 'ABORTED' };
        if (v.ok) state.verifiedAt = Date.now();
        else if (v.code === 'SLOW') { if (state.running <= 1) return { ok: false, code: 'TIMEOUT' }; }
        else { state.base = ''; continue; }
      }
      try {
        const res = await fetch(base + c.path, initOf(c.method, ctl.signal, c.body));
        const text = await readCapped(res, P.LIMITS.responseBytes);
        state.verifiedAt = Date.now();
        return { ok: true, status: res.status, text };
      } catch (e) {
        if (e instanceof TooLarge) return { ok: false, code: 'TOO_LARGE' };
        if (ctl.signal.aborted) return { ok: false, code: timedOut ? 'TIMEOUT' : 'ABORTED' };
        // not reachable: Foundry Local may have been restarted on another port - look once more, then give up
        state.base = '';
        if (attempt === 1) return { ok: false, code: 'NETWORK' };
      }
    }
    return { ok: false, code: 'NETWORK' };
  } finally {
    clearTimeout(timer);
    conn.controllers.delete(id);
    release();
  }
}

/* ------------------------------------------------------------------ the user's approval (a window of this extension) */

function finishConsent(allow) {
  const c = state.consent;
  if (!c) return;
  state.consent = null;
  clearTimeout(c.timer);
  chrome.storage.session.remove('consent').catch(() => {});
  if (c.windowId) chrome.windows.remove(c.windowId).catch(() => {});
  c.resolve(allow);
}

async function askConsent(origin, lang) {
  if (state.consent) return state.consent.origin === origin ? state.consent.done : false;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const c = { origin, resolve, done, windowId: 0, timer: setTimeout(() => finishConsent(false), CONSENT_TIMEOUT_MS) };
  state.consent = c;
  try {
    await chrome.storage.session.set({ consent: { origin, lang } });
    const win = await chrome.windows.create({ url: CONSENT_URL, type: 'popup', width: 480, height: 440, focused: true });
    c.windowId = win && win.id ? win.id : 0;
  } catch (e) {
    finishConsent(false);
  }
  return done;
}

chrome.windows.onRemoved.addListener((id) => { if (state.consent && state.consent.windowId === id) finishConsent(false); });

/* ------------------------------------------------------------------ the pages: a Port per page (content.js) */

async function onPageMessage(conn, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'ping') { try { conn.port.postMessage({ t: 'pong' }); } catch (e) { /* closed */ } return; }
  if (!Number.isSafeInteger(m.id)) return;
  const reply = (r) => { try { conn.port.postMessage({ id: m.id, reply: r }); } catch (e) { /* the page is gone */ } };
  try {
    const approved = await store.isApproved(conn.origin);
    switch (m.op) {
      case 'hello': {
        await store.setLang(m.lang);
        return reply({ ok: true, version: VERSION, protocol: P.PROTOCOL, approved, base: approved ? state.base : '' });
      }
      case 'connect': {
        if (approved) return reply({ ok: true, approved: true });
        // the window may only open for a click (content.js says whether there is one): a page cannot make windows appear on its own
        if (m.gesture !== true) return reply({ ok: false, code: 'NO_GESTURE' });
        const allow = await askConsent(conn.origin, P.cleanLang(m.lang) || await store.lang());
        if (allow) await store.approve(conn.origin);
        return reply(allow ? { ok: true, approved: true } : { ok: false, code: 'DENIED' });
      }
      case 'discover': {
        if (!approved) return reply({ ok: false, code: 'NOT_APPROVED' });
        const wantsScan = m.scan === true;
        if (wantsScan && m.gesture !== true) return reply({ ok: false, code: 'NO_GESTURE' });
        if (wantsScan && !state.scanning && Date.now() - state.lastScan < SCAN_COOLDOWN_MS) return reply({ ok: false, code: 'BUSY' });
        const found = await discover({ scan: wantsScan });
        return reply(found ? { ok: true, base: found.base, port: found.port } : { ok: false, code: 'NOT_FOUND' });
      }
      case 'call': {
        if (!approved) return reply({ ok: false, code: 'NOT_APPROVED' });
        const c = P.checkCall(m);
        if (!c.ok) return reply({ ok: false, code: c.code, detail: c.detail });
        return reply(await callFoundry(conn, m.id, c));
      }
      case 'abort': {
        const ctl = conn.controllers.get(m.target);
        if (ctl) ctl.abort();
        return reply({ ok: true });
      }
      default:
        return reply({ ok: false, code: 'BAD_REQUEST' });
    }
  } catch (e) {
    return reply({ ok: false, code: 'INTERNAL' });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  const s = port.sender || {};
  // only the content script of this extension, in the top frame of a tab, on a page the manifest names
  const origin = port.name === 've-fl-bridge' && s.id === chrome.runtime.id && s.frameId === 0 && s.tab ? P.originAllowed(s.url, MATCHES) : '';
  if (!origin) { port.disconnect(); return; }
  const conn = { port, origin, controllers: new Map() };
  port.onMessage.addListener((m) => { onPageMessage(conn, m); });
  port.onDisconnect.addListener(() => { for (const ctl of conn.controllers.values()) ctl.abort(); });
});

// Content scripts only reach pages that are loaded after the extension: so that the person does not have to reload the editor (and lose an unsaved project)
// after installing or updating the extension, it is put into the pages of the named sites that are already open.
async function injectIntoOpenPages() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: MATCHES }); } catch (e) { return; }
  for (const tab of tabs) {
    if (!tab.id || tab.discarded) continue;
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch (e) { /* a page that cannot be scripted (an error page, a closed tab) */ }
  }
}
chrome.runtime.onInstalled.addListener(() => { injectIntoOpenPages(); });

/* ------------------------------------------------------------------ the pages of this extension (popup, approval window) */

async function popupState() {
  const approved = Object.keys(await store.approved());
  return { version: VERSION, base: state.base, port: await store.port(), approved, lang: await store.lang(), scanning: !!state.scanning };
}

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  // a content script's messages carry the address of the web page; only pages of this extension are served here
  const url = String((sender && sender.url) || '');
  if (!sender || sender.id !== chrome.runtime.id || !url.startsWith(SELF) || !m || typeof m !== 'object') return false;
  (async () => {
    switch (m.t) {
      case 'consent:get': {
        if (!url.startsWith(CONSENT_URL)) return null;
        const r = await chrome.storage.session.get('consent');
        return r.consent ? { origin: r.consent.origin, lang: r.consent.lang } : null;
      }
      case 'consent:decide': {
        if (!url.startsWith(CONSENT_URL)) return null;
        // the answer is for the site that asked (kept in session storage, so that it also works after the worker was restarted)
        const r = await chrome.storage.session.get('consent');
        if (m.allow === true && r.consent && typeof r.consent.origin === 'string') await store.approve(r.consent.origin);
        finishConsent(m.allow === true);
        return { ok: true };
      }
      case 'popup:state': return popupState();
      case 'popup:check': await discover({}); return popupState();
      case 'popup:scan': {
        if (!state.scanning && Date.now() - state.lastScan < SCAN_COOLDOWN_MS) return popupState();
        await discover({ scan: true });
        return popupState();
      }
      case 'popup:setPort': {
        if (!P.validPort(m.port)) return { ok: false, code: 'BAD_REQUEST', state: await popupState() };
        const r = await probe(m.port, 2500);
        if (r.ok) await adopt(m.port);
        return { ok: r.ok, code: r.ok ? '' : r.code, state: await popupState() };
      }
      case 'popup:revoke': {
        if (typeof m.origin === 'string') await store.revoke(m.origin);
        return popupState();
      }
      default: return null;
    }
  })().then(sendResponse, () => sendResponse(null));
  return true;
});
