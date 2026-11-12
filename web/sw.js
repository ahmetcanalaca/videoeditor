'use strict';
// Service worker of the web edition. Four jobs:
//   1. offline: the application files (a fixed list written by scripts/build.js, with a hash of every file) are kept in a cache, so the editor
//      opens without a network connection after the first visit;
//   2. security headers: a static host such as GitHub Pages cannot send HTTP headers, so the worker adds them to the pages it serves
//      (a real Content-Security-Policy with frame-ancestors, which a <meta> tag cannot express, nosniff, a strict referrer policy, ...) and a
//      Content-Security-Policy of its own to the assistant's network worker (see NET_WORKER below);
//   3. updates: a new version waits until the page asks for it (the editor offers a reload), so files of two versions are never mixed;
//   4. integrity: nothing is served from the cache unless its SHA-256 is the one in the manifest, and the manifest has to be the one whose hash
//      scripts/build.js wrote into this script (see MANIFEST_SHA256). Browsers isolate by ORIGIN, not by path, and every GitHub Pages site of an account
//      shares one origin: a page of another repository of the same account could write into Cache Storage. It cannot change the script of an
//      installed worker, so a poisoned cache entry is detected, dropped and replaced by the file from the network. What is served is made again from the
//      bytes that were checked (the status and the headers of a stored entry are not covered by the hash), and a damaged cache is filled again (repair()).
// It never touches requests to other origins (the assistant's requests to a model server or a cloud API): those go from the network worker straight to the network.
const BUILD = '__BUILD_ID__'; // replaced by scripts/build.js; "dev" when served from the source tree
const MANIFEST_SHA256 = '__MANIFEST_SHA256__'; // replaced by scripts/build.js: SHA-256 of precache-manifest.json
// Only a source tree served from this computer ("dev": no manifest hash yet) runs without the checks. Anywhere else they are on, also when scripts/build.js
// did not run: the placeholder then matches no manifest, no worker installs and the site simply runs from the network.
const CHECK = /^[0-9a-f]{64}$/.test(MANIFEST_SHA256) || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
const CACHE_PREFIX = 've-shell-';
const CACHE = CACHE_PREFIX + BUILD;
const MANIFEST = 'precache-manifest.json';

// Same policy as the <meta> tag of index.html, plus what only a header can say. The page itself may talk to its own origin only: every request of the
// assistant goes through the network worker (js/web/ai/net-worker.js), which gets its own, per-user policy below.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');
const HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()',
};

// The network worker of the assistant. Its policy lists the providers' own addresses, this computer (a local model server) and the https origins the
// USER allowed in the assistant's settings (the page writes that list into the cache below before it starts the worker). Nothing else can be reached, even by
// a script that got into the worker's page.
const NET_WORKER = 'js/web/ai/net-worker.js';
const TRUST_CACHE = 've-trust';
const TRUST_FILE = 'trust.json';
const WELL_KNOWN = ['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com'];
// A policy cannot name an IPv6 address (the host-source grammar has no literal for it): this computer is 127.0.0.1 or localhost.
const LOOPBACK = ['http://127.0.0.1:*', 'http://localhost:*'];
const validOrigin = (o) => typeof o === 'string' && o.length <= 300 && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o);

async function workerCsp() {
  let user = [];
  try {
    const c = await caches.open(TRUST_CACHE);
    const r = await c.match(TRUST_FILE);
    const j = r ? await r.json() : null;
    user = j && Array.isArray(j.origins) ? j.origins.filter(validOrigin).slice(0, 50) : [];
  } catch (e) { user = []; }
  const origins = Array.from(new Set(WELL_KNOWN.concat(user)));
  return ["default-src 'none'", "script-src 'self'", 'connect-src ' + LOOPBACK.concat(origins).join(' ')].join('; ');
}

async function workerResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', await workerCsp());
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withHeaders(response) {
  const headers = new Headers(response.headers);
  Object.keys(HEADERS).forEach((k) => headers.set(k, HEADERS[k]));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* ------------------------------------------------------------------ integrity */

async function sha256Hex(buffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// url -> SHA-256 of the files this build may serve, or null when the cached manifest is not the one this worker was built with (the cache is then
// thrown away: nothing in it can be trusted). Read once per start of the worker.
let manifestPromise = null;
function trustedManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const cache = await caches.open(CACHE);
      const res = await cache.match(MANIFEST);
      if (!res) return null;
      const text = await res.text();
      if ((await sha256Hex(new TextEncoder().encode(text))) !== MANIFEST_SHA256) { await caches.delete(CACHE); return null; }
      const map = new Map();
      for (const f of (JSON.parse(text).files || [])) if (f && typeof f.url === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) map.set(f.url, f.sha256);
      return map;
    })().catch(() => null);
  }
  return manifestPromise;
}

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  ico: 'image/x-icon', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8',
};

// The cached file, made again from the bytes that were checked, or null when it is not exactly the file the manifest names (nothing is checked in a source
// tree). Never the stored object itself: only its body is covered by the hash, so a stored status or header (a 302 with a Location, a wrong Content-Type)
// could still make the browser follow a redirect to another page of this origin, or read the file as something else.
async function verified(rel, response) {
  const bytes = await response.arrayBuffer();
  if (CHECK) {
    const map = await trustedManifest();
    const want = map && map.get(rel);
    if (!want || (await sha256Hex(bytes)) !== want) return null;
  }
  const dot = rel.lastIndexOf('.');
  const type = TYPES[dot > 0 ? rel.slice(dot + 1).toLowerCase() : ''] || (/(^|\/)LICENSE$/.test(rel) ? TYPES.txt : 'application/octet-stream');
  return new Response(bytes, { status: 200, headers: { 'Content-Type': type } });
}

// Fetch every file of the manifest past the HTTP cache, compare it with its hash and keep it. One missing or different file, or a manifest that is not the
// one this worker was built with (a half-deployed site, or a stale copy on the way), fails the whole run.
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch(MANIFEST, { cache: 'no-store' });
  if (!res.ok) throw new Error('precache manifest: HTTP ' + res.status);
  const manifestText = await res.text();
  if (CHECK && (await sha256Hex(new TextEncoder().encode(manifestText))) !== MANIFEST_SHA256) throw new Error('precache manifest does not match this worker');
  const manifest = JSON.parse(manifestText);
  await Promise.all((manifest.files || []).map(async (f) => {
    const r = await fetch(f.url, { cache: 'reload' });
    if (!r.ok) throw new Error(f.url + ': HTTP ' + r.status);
    if (CHECK && (await sha256Hex(await r.clone().arrayBuffer())) !== f.sha256) throw new Error(f.url + ': does not match the manifest');
    await cache.put(f.url, r);
  }));
  await cache.put(MANIFEST, new Response(manifestText, { headers: { 'Content-Type': 'application/json' } }));
}

// A cache that was emptied, or that holds a file or a manifest that is not the checked one, is filled again from the network: without this an attack on the
// cache would cost the offline use until the next release. While it runs everything comes from the network; a run at most every 30 seconds.
let repairing = null;
let repairedAt = 0;
function repair() {
  if (!CHECK) return Promise.resolve();
  if (repairing) return repairing;
  if (Date.now() - repairedAt < 30000) return Promise.resolve();
  repairing = precache().then(() => { manifestPromise = null; }, () => { /* offline or half-deployed: the next start of the worker tries again */ }).then(() => { repairing = null; repairedAt = Date.now(); });
  return repairing;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  else if (event.data && event.data.type === 'VERSION' && event.source) event.source.postMessage({ type: 'VERSION', build: BUILD });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // model providers, local model servers: not ours
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  // the manifest itself is never served from (or deleted out of) the cache; the worker script is the browser's own business
  if (url.pathname === scope.pathname + MANIFEST || url.pathname === scope.pathname + 'sw.js') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // the editor is the only page: the scope root and index.html (any other address is left to the network and its 404)
    const isPage = req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html');
    const isNetWorker = url.pathname === scope.pathname + NET_WORKER;
    // the file as the manifest names it (no query string, relative to the scope), looked up by exactly that address: an entry that somebody added under a
    // query string is never looked at
    const rel = isPage ? 'index.html' : url.pathname.slice(scope.pathname.length);
    const key = new URL(rel, scope).href;
    const hit = await cache.match(key, { ignoreVary: true });
    const fresh = hit ? await verified(rel, hit) : null;
    if (fresh) return isPage ? withHeaders(fresh) : (isNetWorker ? workerResponse(fresh) : fresh);
    if (CHECK) {
      // not the checked file (or no checked manifest, or a file of the manifest that is missing): the entry goes, the cache is filled again, and this request is
      // answered from the network
      if (hit) { try { await cache.delete(key, { ignoreVary: true }); } catch (e) { /* the entry is not used anyway */ } }
      const map = await trustedManifest();
      if (hit || !map || map.has(rel)) event.waitUntil(repair());
    }
    try {
      // from the network: what the site itself serves (never kept in the cache here, only the install puts files there)
      const res = await fetch(req);
      return isPage ? withHeaders(res) : (isNetWorker && res.ok ? workerResponse(res) : res);
    } catch (e) {
      if (isPage) return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      throw e;
    }
  })());
});
