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
//      bytes that were checked (the status and the headers of a stored entry are not covered by the hash), and a damaged cache is filled again (repair()). The code of
//      the in-browser model feature (js/web/ai/inbrowser/) and the libraries that run its model are guarded further (see GUARDED): they are served only with the manifest's
//      bytes, from the cache and from the network alike, and an address of this scope that is not written the plain way is a 404 for every file (see NOT_PLAIN).
// It never touches requests to other origins (the assistant's requests to a model server or a cloud API): those go from the network worker straight to the network.
const BUILD = '__BUILD_ID__'; // replaced by scripts/build.js; "dev" when served from the source tree
const MANIFEST_SHA256 = '__MANIFEST_SHA256__'; // replaced by scripts/build.js: SHA-256 of precache-manifest.json
// Only a source tree served from this computer ("dev": no manifest hash yet) runs without the checks. Anywhere else they are on, also when scripts/build.js
// did not run: the placeholder then matches no manifest, no worker installs and the site simply runs from the network.
const CHECK = /^[0-9a-f]{64}$/.test(MANIFEST_SHA256) || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
const CACHE_PREFIX = 've-shell-';
const CACHE = CACHE_PREFIX + BUILD;
const MANIFEST = 'precache-manifest.json';
// The libraries of the in-browser assistant (a WebAssembly file of 26 MB among them) are listed in the manifest apart ("lazy"): they are not fetched when the site is
// installed, but the first time a page asks for them, checked against the manifest's SHA-256 and kept here (one cache for all builds: every use checks the hash again).
const LAZY_CACHE = 've-lazy';

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

// The two workers of the in-browser assistant, each with a policy of its own (a worker's policy is the one its script came with):
//  - the download worker fetches the model files: this site and Hugging Face (huggingface.co, and the content network *.hf.co the files are redirected to), nothing
//    else, and no WebAssembly - it runs no model and no library;
//  - the engine worker runs the model (the vendored transformers.js and ONNX Runtime Web: WebAssembly): this site only, so that nothing it runs can talk to anybody,
//    and no further workers.
const IB_DIR = 'js/web/ai/inbrowser/';
const IB_WORKERS = {
  [IB_DIR + 'ib-dl-worker.js']: ["default-src 'none'", "script-src 'self'", "connect-src 'self' https://huggingface.co https://*.hf.co", "worker-src 'none'"].join('; '),
  [IB_DIR + 'ib-engine-worker.js']: ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "worker-src 'none'"].join('; '),
};
// The code of the in-browser model feature (js/web/ai/inbrowser/) and the libraries that run the model are only ever served as the manifest names them: under exactly the address it names and with
// exactly its bytes - from the cache, and from the network too (a cache entry that is missing or not the checked one is no reason to pass on whatever the network says).
// Another letter case of such an address is a 404, and while there is no checked manifest (the cache was emptied or damaged) they are not served from the network at all:
// the cache is filled again first (repair()).
const GUARDED = ['vendor/transformers/', 'vendor/onnxruntime-web/', IB_DIR];
function guarded(rel) {
  let plain;
  try { plain = decodeURIComponent(rel).toLowerCase(); } catch (e) { return true; }
  return GUARDED.some((p) => plain.startsWith(p));
}
const plainResponse = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
// A static host serves one file under more than one spelling of its address: a doubled slash (js//app.js - also right behind the scope: //js/app.js), a %-escape (js%2Fapp.js,
// ..%2F), a backslash. Everything this worker decides is tied to the plain address (the policy of a worker script, the manifest check, GUARDED), so a request of this scope
// whose address is not written the plain way is answered with a 404 here - for every file and for the page - instead of being handed to the network: nothing inside the scope can
// be reached around its checks. (An address outside the scope, such as a doubled slash in front of the folder name, is not this worker's request at all.) No published file has
// such a name (scripts/build.js refuses to publish one).
const NOT_PLAIN = /%|\\|\/\/|^\/|(^|\/)\.{1,2}(\/|$)/;

function ibWorkerResponse(response, csp) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', csp);
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

// url -> SHA-256 of the files this build may serve (and, apart, of the lazy ones), or null when the cached manifest is not the one this worker was built with (the
// cache is then thrown away: nothing in it can be trusted). Read once per start of the worker. -> { files: Map(url -> sha256), lazy: Map(url -> { sha256, bytes }) }
let manifestPromise = null;
function trustedManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const cache = await caches.open(CACHE);
      const res = await cache.match(MANIFEST);
      if (!res) return null;
      const text = await res.text();
      if ((await sha256Hex(new TextEncoder().encode(text))) !== MANIFEST_SHA256) { await caches.delete(CACHE); return null; }
      const parsed = JSON.parse(text);
      const files = new Map();
      for (const f of (parsed.files || [])) if (f && typeof f.url === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) files.set(f.url, f.sha256);
      const lazy = new Map();
      for (const f of (parsed.lazy || [])) if (f && typeof f.url === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes > 0) lazy.set(f.url, { sha256: f.sha256, bytes: f.bytes });
      return { files, lazy };
    })().catch(() => null);
  }
  return manifestPromise;
}

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  ico: 'image/x-icon', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8',
};

// A fresh response of the right type made from bytes that were checked (never the stored object itself: only its body is covered by the hash, so a stored status or
// header - a 302 with a Location, a wrong Content-Type - could still make the browser follow a redirect to another page of this origin, or read the file as something else).
function typed(rel, bytes) {
  const dot = rel.lastIndexOf('.');
  const type = TYPES[dot > 0 ? rel.slice(dot + 1).toLowerCase() : ''] || (/(^|\/)LICENSE$/.test(rel) ? TYPES.txt : 'application/octet-stream');
  return new Response(bytes, { status: 200, headers: { 'Content-Type': type } });
}

// The cached file, made again from the bytes that were checked, or null when it is not exactly the file the manifest names (nothing is checked in a source tree).
async function verified(rel, response) {
  const bytes = await response.arrayBuffer();
  if (CHECK) {
    const m = await trustedManifest();
    const want = m && m.files.get(rel);
    if (!want || (await sha256Hex(bytes)) !== want) return null;
  }
  return typed(rel, bytes);
}

// A guarded file whose cache entry was missing or not the checked one (see GUARDED): what the network answers is served only when it is the manifest's file, made again from
// the bytes that were checked; anything else (a half-deployed site, somebody in between) is a 502, as for a lazy file.
async function guardedFromNetwork(rel, res) {
  const m = await trustedManifest();
  const want = m && m.files.get(rel);
  const bytes = await res.arrayBuffer();
  if (!want || (await sha256Hex(bytes)) !== want) return plainResponse(502, 'This file does not match the manifest of this build');
  return typed(rel, bytes);
}

// A lazy file (see LAZY_CACHE): from the cache when its bytes are the manifest's, else from the network - and kept only when they are. A file that is not the
// manifest's (a half-deployed site, a poisoned entry, somebody in between) is never served: the answer is a 502.
async function lazyAsset(rel, info, key) {
  const cache = await caches.open(LAZY_CACHE);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (bytes.byteLength === info.bytes && (await sha256Hex(bytes)) === info.sha256) return typed(rel, bytes);
    try { await cache.delete(key, { ignoreVary: true }); } catch (e) { /* replaced below */ }
  }
  let res;
  try { res = await fetch(key, { cache: 'reload' }); } catch (e) { return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
  if (!res.ok) return new Response('HTTP ' + res.status, { status: 502, headers: { 'Content-Type': 'text/plain' } });
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength !== info.bytes || (await sha256Hex(bytes)) !== info.sha256) return new Response('This file does not match the manifest of this build', { status: 502, headers: { 'Content-Type': 'text/plain' } });
  try { await cache.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) { /* no room: served, not kept */ }
  return typed(rel, bytes);
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
    // lazy files this build does not list any more (an older version of a library) are dropped
    try {
      const m = await trustedManifest();
      if (m) {
        const lazyCache = await caches.open(LAZY_CACHE);
        const base = new URL(self.registration.scope).pathname;
        for (const req of await lazyCache.keys()) if (!m.lazy.has(new URL(req.url).pathname.slice(base.length))) await lazyCache.delete(req);
      }
    } catch (e) { /* cleaned up at the next update */ }
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
  const plain = url.pathname.slice(scope.pathname.length);
  if (NOT_PLAIN.test(plain)) { event.respondWith(plainResponse(404, 'Not found')); return; }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // the editor is the only page: the scope root and index.html (any other address is left to the network and its 404)
    const isPage = req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html');
    const isNetWorker = url.pathname === scope.pathname + NET_WORKER;
    // the file as the manifest names it (no query string, relative to the scope), looked up by exactly that address: an entry that somebody added under a
    // query string is never looked at
    const rel = isPage ? 'index.html' : plain;
    const key = new URL(rel, scope).href;
    // the workers of the in-browser assistant carry a policy of their own
    const ibCsp = Object.prototype.hasOwnProperty.call(IB_WORKERS, rel) ? IB_WORKERS[rel] : '';
    const forScript = (res) => (isNetWorker ? workerResponse(res) : (ibCsp ? ibWorkerResponse(res, ibCsp) : res));
    // a file of the lazy list: not in the precache, checked against the manifest when it is first used (never for a source tree, which has no manifest); and the files of the
    // in-browser assistant that are guarded (see GUARDED) are served in no other way
    if (CHECK && !isPage) {
      const m = await trustedManifest();
      const info = m && m.lazy.get(rel);
      if (info) return lazyAsset(rel, info, key);
      if (guarded(rel)) {
        if (!m) { event.waitUntil(repair()); return plainResponse(503, 'Not available right now'); }
        if (!m.files.has(rel)) return plainResponse(404, 'Not found');
      }
    }
    const hit = await cache.match(key, { ignoreVary: true });
    const fresh = hit ? await verified(rel, hit) : null;
    if (fresh) return isPage ? withHeaders(fresh) : forScript(fresh);
    if (CHECK) {
      // not the checked file (or no checked manifest, or a file of the manifest that is missing): the entry goes, the cache is filled again, and this request is
      // answered from the network
      if (hit) { try { await cache.delete(key, { ignoreVary: true }); } catch (e) { /* the entry is not used anyway */ } }
      const m = await trustedManifest();
      if (hit || !m || m.files.has(rel)) event.waitUntil(repair());
    }
    try {
      // from the network: what the site itself serves (never kept in the cache here, only the install puts files there)
      const res = await fetch(req);
      if (CHECK && !isPage && res.ok && guarded(rel)) {
        const checked = await guardedFromNetwork(rel, res);
        return checked.ok ? forScript(checked) : checked;
      }
      return isPage ? withHeaders(res) : (res.ok ? forScript(res) : res);
    } catch (e) {
      if (isPage) return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      throw e;
    }
  })());
});
