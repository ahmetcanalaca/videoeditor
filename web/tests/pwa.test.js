'use strict';
// Offline / update behaviour of the PUBLISHED build (scripts/build.js output, served under a sub-path like a GitHub project site):
// service worker installs, every file is cached, the page gets real security headers (frame-ancestors ...), the editor opens with the server
// gone, and a new build is offered, applied and the old cache removed.
//   node tests/pwa.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../scripts/serve');
const { build } = require('../scripts/build');
const { launch, sleep } = require('./lib/browser');
const { checker } = require('./lib/site');

const WEB = path.join(__dirname, '..');
const BASE = '/videoeditor/';

(async () => {
  const check = checker('web pwa');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 've-web-pwa-'));
  const srcCopy = path.join(work, 'src');
  const site = path.join(work, 'site');
  fs.cpSync(WEB, srcCopy, { recursive: true, filter: (p) => !/[\\/](_site|tests|node_modules)([\\/]|$)/.test(path.relative(WEB, p)) });
  const v1 = build({ root: srcCopy, out: site, quiet: true });
  let server = await start({ root: site, port: 0, base: BASE });
  const port = server.port;
  const origin = 'http://127.0.0.1:' + port;
  const app = await launch({ headless: true });
  const docHeaders = [];
  app.cdp.onEvent((m) => {
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document') docHeaders.push({ url: m.params.response.url, fromSw: !!m.params.response.fromServiceWorker, headers: m.params.response.headers });
  });
  const ev = (e) => app.evaluate(e);
  try {
    await app.navigate(origin + BASE, "typeof VE !== 'undefined' && !!VE.actions");
    check('01 the published build loads under a sub-path (relative URLs only), no console errors', app.errors.length === 0, app.errors);
    check('02 title and defaults (Turkish, dark)', (await ev("document.querySelector('.brand-name').textContent")) === 'Video Editör' && (await ev('document.documentElement.lang')) === 'tr');
    await app.waitFor("navigator.serviceWorker.ready.then((r) => !!r.active)", 30000, 'service worker active');
    const keys = await ev('caches.keys()');
    const manifest = JSON.parse(fs.readFileSync(path.join(site, 'precache-manifest.json'), 'utf8'));
    check('03 the cache of this build exists', keys.includes('ve-shell-' + v1.build), keys);
    const cached = await ev("(async () => { const c = await caches.open('ve-shell-" + v1.build + "'); return (await c.keys()).map((r) => new URL(r.url).pathname); })()");
    const missing = manifest.files.filter((f) => !cached.includes(BASE + f.url));
    check('04 every file of the precache list is cached', missing.length === 0 && manifest.files.length > 30, { files: manifest.files.length, missing: missing.slice(0, 5).map((f) => f.url) });
    check('05 the AI libraries (optional, large) are NOT part of the precache', !manifest.files.some((f) => /^vendor\/(webllm|transformers|models)\//.test(f.url)));

    // a reload is controlled by the worker and gets the real headers
    docHeaders.length = 0;
    await app.navigate(origin + BASE, "typeof VE !== 'undefined' && !!VE.actions");
    check('06 after a reload the worker controls the page', (await ev('!!navigator.serviceWorker.controller')) === true);
    const doc = docHeaders.find((d) => d.url === origin + BASE) || docHeaders[docHeaders.length - 1] || { headers: {} };
    const hd = Object.fromEntries(Object.entries(doc.headers).map(([k, val]) => [k.toLowerCase(), val]));
    check('07 the page comes from the worker with a real Content-Security-Policy incl. frame-ancestors; the page itself may only talk to its own origin', doc.fromSw && /frame-ancestors 'none'/.test(hd['content-security-policy'] || '') && /script-src 'self';/.test(hd['content-security-policy'] || '') && /connect-src 'self';/.test(hd['content-security-policy'] || '') && !/unsafe|wasm/.test(hd['content-security-policy'] || ''), { fromSw: doc.fromSw, csp: hd['content-security-policy'] });
    check('08 plus nosniff, no referrer, opener isolation, permissions policy', hd['x-content-type-options'] === 'nosniff' && hd['referrer-policy'] === 'no-referrer' && hd['cross-origin-opener-policy'] === 'same-origin' && /camera=\(\)/.test(hd['permissions-policy'] || ''), hd);
    // the header policy and the <meta> policy must say the same about scripts, connections, workers
    const meta = await ev("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content");
    const norm = (s) => s.split(';').map((x) => x.trim()).filter((x) => x && !/^frame-ancestors/.test(x)).sort().join(' | ');
    check('09 header CSP = <meta> CSP (apart from frame-ancestors)', norm(hd['content-security-policy'] || '') === norm(meta), { header: norm(hd['content-security-policy'] || ''), meta: norm(meta) });

    // the assistant's network worker has a policy of its own: the providers' addresses, this computer, and what the user allowed (and nothing a script could inject)
    const workerCsp = () => ev("fetch('js/web/ai/net-worker.js').then((r) => r.headers.get('content-security-policy') || '')");
    const w1 = await workerCsp();
    const w1c = (w1.split(';').find((x) => /connect-src/.test(x)) || '').trim();
    check('09a the network worker script carries a policy of its own: connections to this computer and the providers only', /^connect-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\* https:\/\/api\.openai\.com https:\/\/api\.anthropic\.com https:\/\/generativelanguage\.googleapis\.com$/.test(w1c) && /default-src 'none'/.test(w1) && /script-src 'self'/.test(w1), w1);
    await ev("VE.web.net.trust.add('https://myres.services.ai.azure.com')");
    const w2 = await workerCsp();
    check('09b an address the user allowed is added to it (a new worker gets the new list)', w2.includes('https://myres.services.ai.azure.com') && w2.includes('https://api.openai.com'), w2);
    await ev("caches.open('ve-trust').then((c) => c.put('trust.json', new Response(JSON.stringify({ origins: ['https://ok.example.com', 'https://x.com; script-src *', 'http://insecure.example.com', 'https://*.wild.com', 'https://a.com/path'] }), { headers: { 'Content-Type': 'application/json' } })))");
    const w3 = await workerCsp();
    check('09c junk in that list (wildcards, http, paths, policy text) cannot get into the policy', w3.includes('https://ok.example.com') && !/script-src \*/.test(w3) && !w3.includes('insecure') && !w3.includes('wild') && !w3.includes('/path') && (w3.match(/script-src/g) || []).length === 1, w3);
    await ev('VE.web.net.trust.clear()');
    const w4 = await workerCsp();
    check('09d clearing the list takes the address out again', !w4.includes('ok.example.com') && !w4.includes('myres'), w4);
    // the worker really refuses an address that is not allowed (code check, the second layer behind the policy)
    const denied = await ev("VE.web.net.fetch('https://not-allowed.example.com/v1/models').then(() => 'fetched', (e) => e.name + ': ' + e.message)");
    check('09e a request to an address the user did not allow is refused by the worker before it leaves', /^NotAllowed/.test(denied), denied);

    // the Local AI helper is a download next to the app: published, checkable, and never cached by the worker (a stale hash would mislead)
    const info = JSON.parse(fs.readFileSync(path.join(site, 'local-ai', 'info.json'), 'utf8'));
    const li = await ev("(async () => { const r = await fetch('local-ai/info.json'); const j = await r.json(); const z = await (await fetch('local-ai/' + j.zip.name)).arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', z); const hex = Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join(''); let cachedAny = false; for (const k of await caches.keys()) { const c = await caches.open(k); for (const q of await c.keys()) if (/\\/local-ai\\//.test(q.url)) cachedAny = true; } return { sha: j.zip.sha256, hex, bytes: j.zip.bytes, len: z.byteLength, cachedAny }; })()");
    check('08b the Local AI helper download is published: info.json matches the zip byte for byte, the worker never caches it, and it is not part of the precache', li.sha === li.hex && li.sha === info.zip.sha256 && li.bytes === li.len && !li.cachedAny && !manifest.files.some((f) => /^local-ai\//.test(f.url)) && fs.existsSync(path.join(site, 'local-ai', 'local-ai.ps1')) && fs.existsSync(path.join(site, 'local-ai', 'Start-Local-AI.cmd')), li);

    // offline: the server is gone
    await server.close();
    await app.navigate(origin + BASE, "typeof VE !== 'undefined' && !!VE.actions");
    check('10 with the server gone the editor still opens (from the cache)', (await ev("document.querySelector('.brand-name').textContent")) === 'Video Editör' && (await ev("getComputedStyle(document.body).backgroundColor")) !== '');
    const engine = await ev("import(new URL('js/web/engine/export.js', document.baseURI).href).then((m) => typeof m.runExport === 'function' && typeof m.buildPlan === 'function', (e) => String(e))");
    check('11 the export engine module loads offline (dynamic import from the cache)', engine === true, engine);
    check('12 no console errors while offline', app.errors.length === 0, app.errors);

    // update: a new build is deployed
    fs.appendFileSync(path.join(srcCopy, 'css', 'web.css'), '\n/* v2-marker */\n');
    const v2 = build({ root: srcCopy, out: site, quiet: true });
    check('13 a changed file gives a new build id', v2.build !== v1.build, { v1: v1.build, v2: v2.build });
    // a change of the helper alone is a new build too (its hash is shown by the page)
    fs.appendFileSync(path.join(srcCopy, 'local-ai', 'README.txt'), '\nchanged\n');
    const v2b = build({ root: srcCopy, out: path.join(work, 'site-helper'), quiet: true });
    check('13b a change of the Local AI helper alone gives a new build id', v2b.build !== v2.build, { v2: v2.build, v2b: v2b.build });
    server = await start({ root: site, port, base: BASE });
    await ev("window.__veSw.update().then(() => true)");
    await app.waitFor("!!window.__veSw.waiting || !!document.querySelector('dialog.ve-msgbox')", 30000, 'update found');
    await app.waitFor("!!document.querySelector('dialog.ve-msgbox')", 15000, 'update dialog');
    const msg = await ev("document.querySelector('dialog.ve-msgbox').textContent");
    check('14 the editor offers the new version (it is not applied behind the back)', /yeni bir sürümü hazır/i.test(msg), msg);
    check('15 until the user agrees the old cache is still the active one', (await ev('caches.keys()')).includes('ve-shell-' + v1.build));
    await app.click('dialog.ve-msgbox .btn.primary');
    await app.waitFor("typeof VE !== 'undefined' && !!VE.actions && !document.querySelector('dialog.ve-msgbox')", 30000, 'reloaded');
    await app.waitFor("caches.keys().then((k) => { const shell = k.filter((n) => n.startsWith('ve-shell-')); return shell.length === 1 && shell[0] === 've-shell-" + v2.build + "'; })", 30000, 'old cache removed');
    const css = await ev("fetch('css/web.css').then((r) => r.text())");
    check('16 after "reload" the new version runs and only its cache is left', /v2-marker/.test(css), css.slice(-60));
    check('17 no console errors during the update', app.errors.length === 0, app.errors);

    /* ---------------- integrity: what another page of the same origin could do to the cache ---------------- */
    // (every GitHub Pages site of an account shares one origin: such a page can write into Cache Storage; it cannot change the installed worker script)
    const crypto = require('crypto');
    const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const swText = fs.readFileSync(path.join(site, 'sw.js'), 'utf8');
    const manifestSha = sha256(fs.readFileSync(path.join(site, 'precache-manifest.json')));
    check('18 the worker script carries the SHA-256 of the manifest it was built with (and the build id)', swText.includes('"' + manifestSha + '"') && swText.includes('"' + v2.build + '"') && !swText.includes('__MANIFEST_SHA256__'), manifestSha);
    const genuineBuf = fs.readFileSync(path.join(site, 'js', 'web', 'api.js'));
    const genuine = genuineBuf.toString('utf8');
    const genuineSha = sha256(genuineBuf);
    const cacheName = 've-shell-' + v2.build;
    const cn = JSON.stringify(cacheName);
    // SHA-256 of what the cache holds for a file (null = nothing there)
    const entrySha = (name) => ev(`caches.open(${cn}).then((c) => c.match(${JSON.stringify(name)})).then((r) => (r ? r.arrayBuffer() : null)).then((b) => (b ? crypto.subtle.digest('SHA-256', b) : null)).then((d) => (d ? Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('') : null))`);
    const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > (ms || 20000)) return false; await sleep(250); } };
    await ev(`caches.open(${cn}).then((c) => c.put('js/web/api.js', new Response('window.__poisoned = 1;', { headers: { 'Content-Type': 'text/javascript' } })))`);
    const served1 = await ev("fetch('js/web/api.js').then((r) => r.text())");
    const left1 = await entrySha('js/web/api.js');
    check('19 a poisoned cache entry is not served: the genuine file comes instead, and the bad entry never stays', served1 === genuine && (left1 === null || left1 === genuineSha), { served: served1.slice(0, 40), left: left1 });
    check('19a the damaged cache fills itself again with the checked file (the offline use is back)', await until(async () => (await entrySha('js/web/api.js')) === genuineSha), await entrySha('js/web/api.js'));
    // only the body of an entry is covered by the hash: a genuine body stored with a 302 (a redirect to another page of this origin) and a wrong type must not be served as stored
    await ev(`caches.open(${cn}).then(async (c) => { const b = await (await c.match('js/web/api.js')).arrayBuffer(); await c.put('js/web/api.js', new Response(b, { status: 302, headers: { Location: 'index.html', 'Content-Type': 'text/html' } })); })`);
    const served1b = await ev("fetch('js/web/api.js', { redirect: 'manual' }).then(async (r) => ({ status: r.status, type: r.type, ct: r.headers.get('content-type'), text: await r.text() }))");
    check('19b a stored entry with the genuine body but a 302 and a wrong Content-Type is served as a plain 200 of the right type, not as it was stored', served1b.status === 200 && served1b.type !== 'opaqueredirect' && /^text\/javascript/.test(served1b.ct) && served1b.text === genuine, { status: served1b.status, type: served1b.type, ct: served1b.ct });
    // the same with a forged manifest next to it (the worker is stopped first: it reads the manifest once per start)
    await ev(`caches.open(${JSON.stringify(cacheName)}).then(async (c) => {
      const m = await (await c.match('precache-manifest.json')).json();
      const bad = new TextEncoder().encode('window.__poisoned = 2;');
      const digest = await crypto.subtle.digest('SHA-256', bad);
      m.files.find((f) => f.url === 'js/web/api.js').sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      await c.put('precache-manifest.json', new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
      await c.put('js/web/api.js', new Response(bad, { headers: { 'Content-Type': 'text/javascript' } }));
    })`);
    await app.cdp.send('ServiceWorker.enable');
    await app.cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(500);
    const served2 = await ev("fetch('js/web/api.js').then((r) => r.text())");
    check('20 a forged manifest does not help: it is not the one the worker was built with, so nothing of that cache is trusted and the genuine file is served', served2 === genuine, served2.slice(0, 40));
    check('20a that cache is thrown away and filled again with the checked files and the genuine manifest', await until(async () => (await entrySha('js/web/api.js')) === genuineSha && (await entrySha('precache-manifest.json')) === manifestSha), { api: await entrySha('js/web/api.js'), manifest: await entrySha('precache-manifest.json') });
    // another page deletes the whole cache: the next start of the worker fills it again
    const filesInSite = JSON.parse(fs.readFileSync(path.join(site, 'precache-manifest.json'), 'utf8')).files.length;
    await ev(`caches.delete(${cn})`);
    await app.cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(500);
    const served3 = await ev("fetch('js/web/api.js').then((r) => r.text())");
    check('20b a deleted cache is filled again (and the file comes from the network meanwhile)', served3 === genuine && (await until(async () => (await ev(`caches.open(${cn}).then((c) => c.keys()).then((k) => k.length)`)) === filesInSite + 1)), served3.slice(0, 40));
    check('21 no console errors while the cache was attacked', app.errors.length === 0, app.errors);

    // a half-deployed site (a file that is not the one the manifest names) does not install at all: the editor still works from the network
    const siteBad = path.join(work, 'site-bad');
    fs.cpSync(site, siteBad, { recursive: true });
    fs.appendFileSync(path.join(siteBad, 'js', 'web', 'api.js'), '\n/* not the file of the manifest */\n');
    const bad = await start({ root: siteBad, port: 0, base: BASE });
    const app2 = await launch({ headless: true });
    try {
      await app2.navigate('http://127.0.0.1:' + bad.port + BASE, "typeof VE !== 'undefined' && !!VE.actions");
      await sleep(4000);
      const regs = await app2.evaluate('navigator.serviceWorker.getRegistrations().then((r) => r.filter((x) => x.active).length)');
      check('22 a file that does not match the manifest fails the install: no worker becomes active, the editor works from the network', regs === 0 && (await app2.evaluate("document.querySelector('.brand-name').textContent")) === 'Video Editör', regs);
    } finally {
      await app2.close();
      await bad.close();
    }

    // a worker that did not go through scripts/build.js (the placeholder where the manifest hash belongs) checks nothing only on this computer; anywhere else
    // it fails closed: no worker becomes active, the site runs from the network
    const siteRaw = path.join(work, 'site-raw');
    fs.cpSync(site, siteRaw, { recursive: true });
    fs.copyFileSync(path.join(WEB, 'sw.js'), path.join(siteRaw, 'sw.js'));
    const raw = await start({ root: siteRaw, port: 0, base: BASE });
    const remoteHost = 'unbuilt.test';
    const app3 = await launch({ headless: true, args: ['--host-resolver-rules=MAP ' + remoteHost + ' 127.0.0.1', '--unsafely-treat-insecure-origin-as-secure=http://' + remoteHost + ':' + raw.port] });
    try {
      const ready = "typeof VE !== 'undefined' && !!VE.actions";
      const activeWorkers = 'navigator.serviceWorker.getRegistrations().then((r) => r.filter((x) => x.active).length)';
      await app3.navigate('http://' + remoteHost + ':' + raw.port + BASE, ready);
      const secure = await app3.evaluate('window.isSecureContext');
      await sleep(4000);
      const regsRemote = await app3.evaluate(activeWorkers);
      await app3.navigate('http://127.0.0.1:' + raw.port + BASE, ready);
      await app3.waitFor(activeWorkers + '.then((n) => n === 1)', 30000, 'worker on this computer').catch(() => {});
      const regsLocal = await app3.evaluate(activeWorkers);
      check('22b a worker without the manifest hash fails closed anywhere but on this computer (no worker there; on 127.0.0.1 a source tree still works)', secure === true && regsRemote === 0 && regsLocal === 1, { secure, regsRemote, regsLocal });
    } finally {
      await app3.close();
      await raw.close();
    }
  } catch (e) {
    check('pwa test ran to the end', false, String((e && e.stack) || e));
  } finally {
    await app.close();
    await server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  process.exitCode = check.summary() ? process.exitCode : 1;
})();
