'use strict';
// The ONLY place of the web edition that talks to a server other than the site itself: every request of the assistant (a cloud API, a model server
// on this computer, Azure Content Understanding) goes through this worker. The page itself has `connect-src 'self'`, so the page's own scripts cannot
// reach anything else; this worker is created with a Content-Security-Policy header (added by sw.js) whose connect-src lists exactly the addresses the
// user has allowed. Two layers on purpose: the policy (enforced by the browser) and the check below (the same list, enforced by this code).
//
// Protocol (postMessage):
//   page -> worker  { t:'init', origins:[https origins the user allowed] }
//                   { t:'fetch', id, url, method, headers:[[name, value]], body }      body: string | ArrayBuffer | Uint8Array | Blob | undefined
//                   { t:'abort', id }
//   worker -> page  { t:'head', id, status, statusText, headers:[[name, value]] }
//                   { t:'chunk', id, chunk: ArrayBuffer }  ...  { t:'end', id }
//                   { t:'error', id, name, message }
const LOOPBACK = new Set(['127.0.0.1', 'localhost']); // (the policy of this worker cannot name an IPv6 address, see sw.js)
const MAX_HEADER_VALUE = 8192;
let allowed = new Set();
const jobs = new Map();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// An address this worker may talk to: this computer over http or https, or an https origin the user allowed.
function permitted(u) {
  if (u.username || u.password) return false;
  if (LOOPBACK.has(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
  return u.protocol === 'https:' && allowed.has(u.origin);
}

function cleanHeaders(list) {
  const out = {};
  for (const pair of Array.isArray(list) ? list : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const name = String(pair[0]);
    const value = String(pair[1]);
    // header names are tokens, values never contain line breaks (no header injection from a pasted key)
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name) || /[\r\n\0]/.test(value) || value.length > MAX_HEADER_VALUE) continue;
    out[name] = value;
  }
  return out;
}

async function run(m) {
  const id = m.id;
  const controller = new AbortController();
  jobs.set(id, controller);
  try {
    let u;
    try { u = new URL(String(m.url)); } catch (e) { throw Object.assign(new Error('Invalid address'), { name: 'NotAllowed' }); }
    if (!permitted(u)) throw Object.assign(new Error('This address was not allowed: ' + u.origin), { name: 'NotAllowed' });
    const method = String(m.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') throw Object.assign(new Error('Method not allowed'), { name: 'NotAllowed' });
    // redirect:'error' - a redirect could carry the key header to another host; credentials:'omit' - no cookies; no referrer
    const res = await fetch(u.href, { method, headers: cleanHeaders(m.headers), body: method === 'GET' ? undefined : m.body, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
    post({ t: 'head', id, status: res.status, statusText: res.statusText, headers: Array.from(res.headers.entries()) });
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const copy = value.buffer.byteLength === value.byteLength ? value.buffer : value.slice().buffer;
        post({ t: 'chunk', id, chunk: copy }, [copy]);
      }
    }
    post({ t: 'end', id });
  } catch (e) {
    post({ t: 'error', id, name: (e && e.name) || 'Error', message: String((e && e.message) || e).slice(0, 300) });
  } finally {
    jobs.delete(id);
  }
}

self.onmessage = (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'init') {
    allowed = new Set((Array.isArray(m.origins) ? m.origins : []).filter((o) => typeof o === 'string' && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o)));
  } else if (m.t === 'abort') {
    const c = jobs.get(m.id);
    if (c) c.abort();
  } else if (m.t === 'fetch') {
    run(m);
  }
};
