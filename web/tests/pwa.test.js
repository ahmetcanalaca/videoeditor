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
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document') docHeaders.push({ url: m.params.response.url, fromSw: !!m.params.response.fromServiceWorker, status: m.params.response.status, headers: m.params.response.headers });
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
    // the browser extension for Foundry Local is published next to the app (the settings dialog offers it): a zip with a .sha256 file that names it; it is only downloaded,
    // so it is not precached - but the worker must let the download through
    const zipFile = path.join(site, 'extension', 'video-editor-foundry-bridge.zip');
    const zipBytes = fs.readFileSync(zipFile);
    const zipSha = require('crypto').createHash('sha256').update(zipBytes).digest('hex');
    check('05b the extension zip is published under a fixed name with its SHA-256 next to it (the hash of the build report and of the file agree), and it is not in the precache list', zipSha === v1.extension.sha256 && fs.readFileSync(zipFile + '.sha256', 'utf8').trim() === v1.extension.sha256 + '  video-editor-foundry-bridge.zip' && !manifest.files.some((f) => /^extension\//.test(f.url)), { build: v1.extension, onDisk: zipSha });
    const viaWorker = await ev("fetch('extension/video-editor-foundry-bridge.zip').then(async (r) => { const b = new Uint8Array(await r.arrayBuffer()); const h = await crypto.subtle.digest('SHA-256', b); return { ok: r.ok, size: b.length, sha: Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, '0')).join(''), pk: b[0] === 0x50 && b[1] === 0x4b }; })");
    check('05c the page can download it through the service worker, byte for byte', viaWorker.ok && viaWorker.pk && viaWorker.size === zipBytes.length && viaWorker.sha === zipSha, viaWorker);

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

    /* ---- the in-browser assistant: libraries fetched on demand and checked, two workers with a policy of their own ---- */
    const hexOf = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
    const lazyWasm = 'vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm';
    const lazyJs = 'vendor/transformers/transformers.min.js';
    const lazyUrls = (manifest.lazy || []).map((f) => f.url).sort();
    check('09f the libraries of the in-browser assistant (transformers.js and ONNX Runtime Web with its 26 MB WebAssembly file, and their licence texts) are listed apart in the manifest ("lazy": address, SHA-256, size), and are neither in the precache list nor in the cache of this build', lazyUrls.join() === ['vendor/onnxruntime-web/COMMIT.txt', 'vendor/onnxruntime-web/LICENSE', 'vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs', lazyWasm, 'vendor/transformers/LICENSE', 'vendor/transformers/LICENSE-jinja', lazyJs].join() && manifest.lazy.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes === fs.statSync(path.join(site, f.url)).size && hexOf(fs.readFileSync(path.join(site, f.url))) === f.sha256) && lazyUrls.every((u) => !manifest.files.some((f) => f.url === u) && !cached.includes(BASE + u)), lazyUrls);
    const wasmDisk = fs.readFileSync(path.join(site, lazyWasm));
    const viaLazy = await ev(`fetch(${JSON.stringify(lazyWasm)}).then(async (r) => { const b = new Uint8Array(await r.arrayBuffer()); const h = await crypto.subtle.digest('SHA-256', b); return { status: r.status, type: r.headers.get('content-type'), size: b.length, sha: Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, '0')).join('') }; })`);
    const lazyKept = await ev("caches.open('ve-lazy').then((c) => c.keys()).then((k) => k.map((r) => new URL(r.url).pathname))");
    check('09g a lazy file is served by the worker: 200, the right type (application/wasm), byte for byte the file of the build; it is then kept in a cache of its own, not in the cache of the build', viaLazy.status === 200 && viaLazy.type === 'application/wasm' && viaLazy.size === wasmDisk.length && viaLazy.sha === hexOf(wasmDisk) && lazyKept.includes(BASE + lazyWasm) && (await ev(`caches.open('ve-shell-${v1.build}').then((c) => c.keys()).then((k) => k.some((r) => r.url.endsWith(${JSON.stringify(lazyWasm)})))`)) === false, { viaLazy, lazyKept });
    const jsDisk = fs.readFileSync(path.join(site, lazyJs));
    await ev(`caches.open('ve-lazy').then((c) => c.put(new URL(${JSON.stringify(lazyJs)}, document.baseURI).href, new Response('window.__poisoned = 3;', { headers: { 'Content-Type': 'text/javascript' } })))`);
    const lazyJsRes = await ev(`fetch(${JSON.stringify(lazyJs)}).then(async (r) => { const b = new Uint8Array(await r.arrayBuffer()); const h = await crypto.subtle.digest('SHA-256', b); return { status: r.status, type: r.headers.get('content-type'), sha: Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, '0')).join('') }; })`);
    const lazyJsKept = await ev(`caches.open('ve-lazy').then((c) => c.match(new URL(${JSON.stringify(lazyJs)}, document.baseURI).href)).then((r) => (r ? r.arrayBuffer() : null)).then((b) => (b ? crypto.subtle.digest('SHA-256', b) : null)).then((d) => (d ? Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('') : null))`);
    check('09h a poisoned entry of the lazy cache is not served: the genuine file comes from the network (right type), and replaces the bad entry', lazyJsRes.status === 200 && /^text\/javascript/.test(lazyJsRes.type) && lazyJsRes.sha === hexOf(jsDisk) && lazyJsKept === hexOf(jsDisk), { lazyJsRes, lazyJsKept });
    const ibHeaders = (f) => ev(`fetch(${JSON.stringify(f)}).then((r) => ({ csp: r.headers.get('content-security-policy') || '', corp: r.headers.get('cross-origin-resource-policy') || '', nosniff: r.headers.get('x-content-type-options') || '', type: r.headers.get('content-type') || '' }))`);
    const dlH = await ibHeaders('js/web/ai/inbrowser/ib-dl-worker.js');
    const enH = await ibHeaders('js/web/ai/inbrowser/ib-engine-worker.js');
    check('09i the download worker has a policy of its own: this site and Hugging Face (huggingface.co and its content network *.hf.co), nobody else; no WebAssembly, no workers of its own', dlH.csp === "default-src 'none'; script-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co; worker-src 'none'" && dlH.corp === 'same-origin' && dlH.nosniff === 'nosniff' && /^text\/javascript/.test(dlH.type), dlH);
    check('09j the engine worker has one too: it may compile WebAssembly (the model runs in it) but may talk to this site only - Hugging Face is not on its list - and has no workers of its own', enH.csp === "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'" && enH.corp === 'same-origin' && enH.nosniff === 'nosniff' && /^text\/javascript/.test(enH.type), enH);
    const coreH = await ibHeaders('js/web/ai/inbrowser/ib-core.js');
    check('09k only the two worker scripts carry such a policy (a module they import is an ordinary file), and the page\'s own policy still names neither Hugging Face nor WebAssembly', coreH.csp === '' && !/huggingface|hf\.co|wasm/.test(hd['content-security-policy'] || ''), { core: coreH.csp, page: hd['content-security-policy'] });
    const spelled = [
      'vendor/transformers/%74ransformers.min.js', 'Vendor/transformers/transformers.min.js', 'vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.%6djs', 'js/web/ai/inbrowser/ib%2Dengine-worker.js', 'js/web/ai/inbrowser/IB-ENGINE-WORKER.JS', 'js/web/ai/inbrowser/not-there.js',
      // the same files in the spellings that a static host (GitHub Pages) serves all the same: a doubled slash anywhere - also right behind the folder -, an escaped slash, an escaped ".." segment
      'js//web/ai/inbrowser/ib-engine-worker.js', 'js/web//ai/inbrowser/ib-engine-worker.js', 'js/web/ai//inbrowser/ib-dl-worker.js', 'vendor//transformers/transformers.min.js', 'vendor/transformers//transformers.min.js', 'vendor//onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm',
      'js%2Fweb/ai/inbrowser/ib-engine-worker.js', 'vendor%2Ftransformers/transformers.min.js', 'js/..%2Fjs/web/ai/inbrowser/ib-engine-worker.js', '%2Fjs/web/ai/inbrowser/ib-engine-worker.js', BASE + '/js/web/ai/inbrowser/ib-engine-worker.js',
      // ordinary files too: no address of this scope reaches a file around the checks of the worker
      'js//web/api.js', 'js%2Fweb/api.js', BASE + '/js/web/api.js', 'precache%2Dmanifest.json', 'sw%2Ejs', BASE + '/sw.js',
    ];
    const spelledStatus = await ev(`Promise.all(${JSON.stringify(spelled)}.map((u) => fetch(u).then((r) => r.status, () => 'error')))`);
    check('09l the code of the in-browser assistant and the libraries of its model are served only under the address of the manifest: the same files under another spelling (%-encoded, other letter case, a doubled or an escaped slash) and addresses of that folder that do not exist are a 404 from the worker, not a request to the network - and so is every ordinary file under such a spelling', spelledStatus.every((s) => s === 404), spelledStatus);
    // the page itself under such a spelling: refused too (the network's page would come without the headers the worker gives the real one)
    docHeaders.length = 0;
    const oddPageUrl = origin + BASE + '/';
    await app.navigate(oddPageUrl, "document.contentType === 'text/plain'");
    const oddPage = docHeaders.find((d) => d.url === oddPageUrl) || {};
    const oddText = await ev('document.body.textContent');
    await app.navigate(origin + BASE, "typeof VE !== 'undefined' && !!VE.actions");
    check('09m the page under a spelling that is not the plain one (a doubled slash behind the folder) is a 404 from the worker: not the network\'s page, which would come without the headers the worker gives the real one', oddPage.fromSw === true && oddPage.status === 404 && /Not found/.test(oddText) && !/frame-ancestors/.test(JSON.stringify(oddPage.headers || {})), { fromSw: oddPage.fromSw, status: oddPage.status, text: oddText });
    // (the 404s of the addresses that were asked for on purpose are logged by the browser as failed resources: expected, not errors of the page - and so is the favicon that the browser
    // asks for when it shows the plain-text 404 page)
    await sleep(800);
    const askedFor = spelled.map((u) => new URL(u, origin + BASE).href).concat([oddPageUrl, origin + '/favicon.ico']);
    for (let i = app.errors.length - 1; i >= 0; i--) if (/404/.test(app.errors[i]) && askedFor.some((u) => app.errors[i].includes(u))) app.errors.splice(i, 1);
    // no published file has a name that the rule would refuse, and the rule refuses the usual disguises and nothing plain (the rule is read out of the worker script, not copied here)
    const rule = new RegExp(/const NOT_PLAIN = \/(.+)\/;/.exec(fs.readFileSync(path.join(site, 'sw.js'), 'utf8'))[1]);
    const published = fs.readdirSync(site, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => fs.statSync(path.join(site, f)).isFile());
    // the worker sees an address as the browser writes it: a name that needs escaping (a space, a non-ASCII letter) arrives as %-escapes
    const asRequested = (f) => new URL(f, 'https://h/s/').pathname.slice('/s/'.length);
    check('09n every published file has a plain name (the rule of the worker refuses none of them, also as the browser writes the address), and the rule refuses doubled and escaped slashes, a backslash and dot segments but not an ordinary name', published.length > 50 && published.every((f) => asRequested(f) === f && !rule.test(f)) && ['js//a.js', '/js/a.js', 'js%2Fa.js', '%74.js', 'a\\b.js', 'a/../b.js', 'a/./b.js', '..', 'js//'].every((f) => rule.test(f)) && ['index.html', '', '.nojekyll', 'vendor/transformers/LICENSE-jinja', 'js/web/ai/inbrowser/ib-core.js', 'a.b/c..d.js'].every((f) => !rule.test(f)) && ['a b.png', 'ä.png', 'a#b.png'].every((f) => asRequested(f) !== f || rule.test(asRequested(f))), { published: published.length, refused: published.filter((f) => asRequested(f) !== f || rule.test(f)).slice(0, 5) });
    // the build refuses to publish such a name instead of publishing a file that the worker would answer with a 404
    const srcBad = path.join(work, 'src-bad');
    fs.cpSync(srcCopy, srcBad, { recursive: true });
    fs.writeFileSync(path.join(srcBad, 'assets', 'a b.png'), 'x');
    fs.writeFileSync(path.join(srcBad, 'assets', 'ä.png'), 'x');
    let buildBad = '';
    try { build({ root: srcBad, out: path.join(work, 'site-refused'), quiet: true }); buildBad = 'built'; } catch (e) { buildBad = String(e.message); }
    fs.rmSync(srcBad, { recursive: true, force: true });
    fs.rmSync(path.join(work, 'site-refused'), { recursive: true, force: true });
    check('09o the build refuses to publish a file whose name the worker would refuse (a space or a non-ASCII letter reaches it as %-escapes) - and names both', /would be refused by the service worker/.test(buildBad) && /assets\/a b\.png/.test(buildBad) && /assets\/ä\.png/.test(buildBad), buildBad.slice(0, 240));

    // offline: the server is gone
    await server.close();
    await app.navigate(origin + BASE, "typeof VE !== 'undefined' && !!VE.actions");
    check('10 with the server gone the editor still opens (from the cache)', (await ev("document.querySelector('.brand-name').textContent")) === 'Video Editör' && (await ev("getComputedStyle(document.body).backgroundColor")) !== '');
    const engine = await ev("import(new URL('js/web/engine/export.js', document.baseURI).href).then((m) => typeof m.runExport === 'function' && typeof m.buildPlan === 'function', (e) => String(e))");
    check('11 the export engine module loads offline (dynamic import from the cache)', engine === true, engine);
    const offlineLazy = await ev(`Promise.all([fetch(${JSON.stringify(lazyWasm)}).then((r) => r.status + ':' + r.headers.get('content-type'), () => 'error'), fetch('vendor/transformers/LICENSE').then((r) => String(r.status), () => 'error')])`);
    check('11a offline: a lazy file that was used before is served from its cache (checked again), one that never was is not available (503)', offlineLazy[0] === '200:application/wasm' && offlineLazy[1] === '503', offlineLazy);
    // (the 503 of the file that was asked for on purpose is logged by the browser as a failed resource: expected, not an error of the page)
    for (let i = app.errors.length - 1; i >= 0; i--) if (/503.*vendor\/transformers\/LICENSE/.test(app.errors[i])) app.errors.splice(i, 1);
    check('12 no console errors while offline', app.errors.length === 0, app.errors);

    // update: a new build is deployed
    fs.appendFileSync(path.join(srcCopy, 'css', 'web.css'), '\n/* v2-marker */\n');
    const v2 = build({ root: srcCopy, out: site, quiet: true });
    check('13 a changed file gives a new build id', v2.build !== v1.build, { v1: v1.build, v2: v2.build });
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
    // the same with the code of the in-browser assistant and the libraries of its model: with no checked manifest they are not passed on from the network (503) until the
    // cache is filled again, while an ordinary file still is
    await ev(`caches.delete(${cn})`);
    await app.cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(500);
    const noManifest = await ev(`Promise.all([${JSON.stringify(lazyJs)}, 'js/web/ai/inbrowser/ib-core.js', 'js/web/api.js'].map((u) => fetch(u).then((r) => r.status, () => 'error')))`);
    check('20c with no checked manifest the libraries of the model and the code of the assistant are not served from the network (503), an ordinary file is (200)', noManifest[0] === 503 && noManifest[1] === 503 && noManifest[2] === 200, noManifest);
    check('20d once the cache is filled again they are served as usual', await until(async () => (await ev(`fetch(${JSON.stringify(lazyJs)}).then((r) => r.status)`)) === 200 && (await ev("fetch('js/web/ai/inbrowser/ib-core.js').then((r) => r.status)")) === 200), null);
    for (let i = app.errors.length - 1; i >= 0; i--) if (/503/.test(app.errors[i]) && /transformers\.min\.js|ib-core\.js/.test(app.errors[i])) app.errors.splice(i, 1);
    // The network is not trusted for these files either: a cache entry that is not the checked one (or is missing) is no reason to pass on whatever the site answers. Two files of the
    // in-browser assistant, one of them a worker script (it must carry its policy also when it comes from the network).
    const ibCore = 'js/web/ai/inbrowser/ib-core.js';
    const ibEngine = 'js/web/ai/inbrowser/ib-engine-worker.js';
    const ibGood = { [ibCore]: fs.readFileSync(path.join(site, ibCore)), [ibEngine]: fs.readFileSync(path.join(site, ibEngine)) };
    const ibAnswer = (f) => ev(`fetch(${JSON.stringify(f)}).then(async (r) => { const b = await r.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); return { status: r.status, type: r.headers.get('content-type') || '', csp: r.headers.get('content-security-policy') || '', sha: Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join(''), head: new TextDecoder().decode(b.slice(0, 40)) }; })`);
    const ibPoison = (f) => ev(`caches.open(${cn}).then((c) => c.put(${JSON.stringify(f)}, new Response('self.__poisoned = 4;', { headers: { 'Content-Type': 'text/javascript' } })))`);
    const ibRestore = (f) => ev(`caches.open(${cn}).then((c) => c.put(${JSON.stringify(f)}, new Response(Uint8Array.from(atob(${JSON.stringify(ibGood[f].toString('base64'))}), (ch) => ch.charCodeAt(0)), { headers: { 'Content-Type': 'text/javascript' } })))`);
    const engineCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'";
    await ibPoison(ibCore);
    await ibPoison(ibEngine);
    const viaNet = { core: await ibAnswer(ibCore), engine: await ibAnswer(ibEngine) };
    check('20e a guarded file whose cache entry is not the checked one comes from the network, checked against the manifest (the right bytes, the right type) - the engine worker with the policy of its own as well - and the bad entry is gone', viaNet.core.status === 200 && viaNet.core.sha === sha256(ibGood[ibCore]) && /^text\/javascript/.test(viaNet.core.type) && viaNet.engine.status === 200 && viaNet.engine.sha === sha256(ibGood[ibEngine]) && viaNet.engine.csp === engineCsp && (await entrySha(ibCore)) !== sha256(Buffer.from('self.__poisoned = 4;')), viaNet);
    // ... and a site that answers with another file than the manifest's (half deployed, or somebody in between) is a 502: the code of the assistant is never passed on unchecked
    const halfDeployed = Buffer.concat([ibGood[ibCore], Buffer.from('\n/* half deployed */\n')]);
    let half = null;
    try {
      fs.writeFileSync(path.join(site, ibCore), halfDeployed);
      await ibPoison(ibCore);
      half = await ibAnswer(ibCore);
    } finally {
      fs.writeFileSync(path.join(site, ibCore), ibGood[ibCore]);
    }
    check('20f a site that answers with another file than the manifest\'s is a 502 for such a file: its bytes are not passed on', half && half.status === 502 && half.sha !== sha256(halfDeployed) && /^This file does not match/.test(half.head), half);
    await ibRestore(ibCore);
    await ibRestore(ibEngine);
    const after = { core: await ibAnswer(ibCore), engine: await ibAnswer(ibEngine) };
    check('20g with the site right again (and the cache entries put back) both files are served as before', after.core.status === 200 && after.core.sha === sha256(ibGood[ibCore]) && after.engine.status === 200 && after.engine.sha === sha256(ibGood[ibEngine]) && after.engine.csp === engineCsp, after);
    for (let i = app.errors.length - 1; i >= 0; i--) if (/502/.test(app.errors[i]) && /ib-core\.js/.test(app.errors[i])) app.errors.splice(i, 1);
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

    // a library of the in-browser assistant that is not the one of the manifest (a half-deployed site, somebody in between): the site installs (the library is not part of
    // the precache), but the worker never serves that file - HTTP 502 - and keeps nothing of it; the files that are the manifest's are served as usual
    const siteLazy = path.join(work, 'site-lazybad');
    fs.cpSync(site, siteLazy, { recursive: true });
    fs.appendFileSync(path.join(siteLazy, 'vendor', 'transformers', 'transformers.min.js'), '\n// not the file of the manifest\n');
    const lazyBad = await start({ root: siteLazy, port: 0, base: BASE });
    const app4 = await launch({ headless: true });
    try {
      const ready = "typeof VE !== 'undefined' && !!VE.actions";
      const lazyOrigin = 'http://127.0.0.1:' + lazyBad.port + BASE;
      await app4.navigate(lazyOrigin, ready);
      await app4.waitFor('navigator.serviceWorker.ready.then((r) => !!r.active)', 30000, 'service worker (half-deployed library)');
      await app4.navigate(lazyOrigin, ready);
      await app4.waitFor('!!navigator.serviceWorker.controller', 15000, 'controlled page');
      const bad = await app4.evaluate("fetch('vendor/transformers/transformers.min.js').then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 80) }))");
      const good = await app4.evaluate("fetch('vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs').then((r) => r.status)");
      const kept = await app4.evaluate("caches.open('ve-lazy').then((c) => c.keys()).then((k) => k.map((x) => new URL(x.url).pathname))");
      check('22a a lazy library that is not the one of the manifest is never served (502, with the reason) and nothing of it is kept; the other lazy files are served as usual', bad.status === 502 && /does not match the manifest/.test(bad.text) && good === 200 && kept.every((p) => !/transformers\.min\.js$/.test(p)) && kept.some((p) => /asyncify\.mjs$/.test(p)), { bad, good, kept });
    } finally {
      await app4.close();
      await lazyBad.close();
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
