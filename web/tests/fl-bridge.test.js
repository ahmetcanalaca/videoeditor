'use strict';
// The browser extension that carries Foundry Local to the web edition, in a real browser: the extension (test build: it also serves the local test site) is
// loaded into Chrome / Edge, a stand-in for Foundry Local (no CORS headers, like the real one) listens on this computer, and the page talks to it only
// through the extension. This file tests the protocol of the extension itself (raw messages); the page's client and the assistant are tested in fl-web.test.js.
//   node tests/fl-bridge.test.js        (VE_BROWSER=<chrome|edge exe>; VE_HEADED=1 shows the browser; VE_FL_LONG=0 skips the 36 s keep-alive test)
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { start } = require('../scripts/serve');
const pack = require('../scripts/pack-extension');
const { launch, sleep, waitUntil } = require('./lib/browser');
const { checker } = require('./lib/site');
const mock = require('./lib/mock-foundry');

const WEB = path.resolve(__dirname, '..');
const READY = "typeof VE !== 'undefined' && !!VE.actions && !!VE.exportUI";
const SW_URL = /^chrome-extension:\/\/([a-p]{32})\/background\.js$/;

(async () => {
  const check = checker('web foundry bridge (extension)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-fl-bridge-'));
  const extDir = path.join(tmp, 'ext');
  pack.buildFolder({ out: extDir, variant: 'test' });
  const srv = await start({ root: WEB, port: 0, base: '/' });
  const origin = 'http://127.0.0.1:' + srv.port;
  let mf = await mock.start();
  const app = await launch({ headless: process.env.VE_HEADED !== '1', extensions: [extDir], userData: path.join(tmp, 'profile') });
  let sw = null;
  let extId = '';
  const swTarget = async () => (await app.targets()).find((t) => t.type === 'service_worker' && SW_URL.test(t.url));
  const inSw = async (expr) => { const c = await app.attach(await swTarget()); try { return await c.evaluate(expr); } finally { c.close(); } };
  const stored = () => inSw('chrome.storage.local.get(null)');
  // a message of the page to the extension, as the page's client sends it (raw); `gesture` = the message is sent from a click
  const ask = (op, fields, gesture) => app.evaluate(`(() => new Promise((resolve) => {
    window.__ids = (window.__ids || 0) + 1;
    const id = window.__ids;
    const timer = setTimeout(() => resolve({ ok: false, code: 'TEST_TIMEOUT' }), ${op === 'discover' ? 120000 : 60000});
    const on = (e) => { if (e.source === window && e.data && e.data.source === 've-fl-ext' && e.data.type === 'reply' && e.data.id === id) { clearTimeout(timer); window.removeEventListener('message', on); resolve(e.data.reply); } };
    window.addEventListener('message', on);
    window.postMessage(Object.assign({ source: 've-fl-page', id, op: ${JSON.stringify(op)} }, (() => { const f = ${JSON.stringify(fields || {})}; if (f.body === '@big') f.body = 'x'.repeat(25 * 1024 * 1024); return f; })()), location.origin);
    window.__lastId = id;
  }))()`, gesture ? { userGesture: true } : undefined);
  const call = (route, fields, gesture) => ask('call', Object.assign({ route }, fields || {}), gesture);
  const body = (o) => JSON.stringify(Object.assign({ model: 'qwen3.5-4b-generic-cpu:3', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 3 }, o));
  const imgBody = (url) => body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url } }] }] });
  // another program on this computer that answers HTTP (never Foundry Local), and one that accepts a connection and says nothing; both write down what they were asked
  const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(server.wantedPort || 0, '127.0.0.1', () => resolve(server)); });
  const plainServer = async (wantedPort) => {
    const log = [];
    const server = http.createServer((req, res) => { log.push(req.method + ' ' + req.url); res.end('hello'); });
    server.wantedPort = wantedPort;
    await listen(server);
    return { port: server.address().port, log, close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) };
  };
  const silentServer = async (wantedPort) => {
    const log = [];
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
      sock.on('data', (d) => log.push(String(d).split('\r\n')[0]));
    });
    server.wantedPort = wantedPort;
    await listen(server);
    return { port: server.address().port, log, close: () => new Promise((r) => { server.close(() => r()); sockets.forEach((s) => s.destroy()); }) };
  };
  const consentTarget = async () => (await app.targets()).find((t) => t.url.startsWith('chrome-extension://' + extId + '/consent.html'));
  const answerConsent = async (allow) => {
    const t = await waitUntil(consentTarget, 15000, 'the approval window');
    const c = await app.attach(t);
    try {
      await waitUntil(() => c.evaluate("!document.getElementById('ask').hidden"), 10000, 'the approval window to fill');
      // `early`: in the first 1.4 s after the window was opened "Allow" is disabled (null = the window was too slow to tell)
      const shown = await c.evaluate("({ origin: document.getElementById('origin').textContent, title: document.getElementById('title').textContent, allow: document.getElementById('allow').textContent, early: performance.now() < 1400 ? document.getElementById('allow').disabled : null })");
      if (allow) await waitUntil(() => c.evaluate("!document.getElementById('allow').disabled"), 10000, 'the Allow button to be enabled');
      await c.evaluate("document.getElementById('" + (allow ? 'allow' : 'deny') + "').click(); true");
      return shown;
    } finally { c.close(); }
  };

  try {
    sw = await waitUntil(swTarget, 30000, 'the extension\'s service worker');
    extId = SW_URL.exec(sw.url)[1];
    await sleep(600);
    await app.navigate(origin + '/index.html?vetest', READY);

    /* ---- the page and the extension find each other ---- */
    check('01 the extension\'s content script is in the page (the signal is there before the page\'s own scripts run)', (await app.evaluate("document.documentElement.getAttribute('data-ve-fl-bridge')")) === '1.0.0');
    const hello = await ask('hello', { lang: 'en' });
    check('02 hello: version, protocol, not approved yet, nothing known about Foundry Local', hello.ok && hello.version === '1.0.0' && hello.protocol === 1 && hello.approved === false && hello.base === '', hello);
    const early = await call('models');
    check('03 before the user has approved the site no request is made: NOT_APPROVED, and Foundry Local saw nothing', !early.ok && early.code === 'NOT_APPROVED' && mf.log.length === 0, { early, seen: mf.log.length });
    const dis0 = await ask('discover', {});
    check('04 discovering is refused before the approval, too', !dis0.ok && dis0.code === 'NOT_APPROVED' && mf.log.length === 0, dis0);

    /* ---- the approval: only a click can open the window, and the window says which site asks ---- */
    const noClick = await ask('connect', { lang: 'en' }, false);
    await sleep(500);
    check('05 a page that asks without a click gets no window: NO_GESTURE', !noClick.ok && noClick.code === 'NO_GESTURE' && !(await consentTarget()), noClick);
    const pending = ask('connect', { lang: 'en' }, true);
    const shownDeny = await answerConsent(false);
    const denied = await pending;
    check('06 the approval window names the site that asks (taken from the browser, not from the page) and the question is in English', shownDeny.origin === origin && /wants to use Foundry Local/.test(shownDeny.title) && shownDeny.allow === 'Allow', shownDeny);
    check('06b "Allow" is disabled for the first moment (a click that was meant for the page does not approve)', shownDeny.early !== false, shownDeny);
    await waitUntil(async () => !(await consentTarget()), 10000, 'the approval window to close');
    check('07 "Deny": DENIED, the window is gone, nothing is stored', !denied.ok && denied.code === 'DENIED' && !(await stored()).approved, { denied, stored: await stored() });
    const pending2 = ask('connect', { lang: 'tr' }, true);
    const shownAllow = await answerConsent(true);
    const allowed = await pending2;
    check('08 "Allow": approved (and the window follows the language of the page: Turkish)', allowed.ok && allowed.approved === true && /kullanmak istiyor/.test(shownAllow.title) && shownAllow.allow === 'İzin ver', { allowed, shownAllow });
    check('09 the approval is kept for this origin only', JSON.stringify(Object.keys((await stored()).approved || {})) === JSON.stringify([origin]), await stored());
    const helloAfter = await ask('hello', { lang: 'en' });
    check('10 hello now says approved', helloAfter.ok && helloAfter.approved === true, helloAfter);

    /* ---- finding Foundry Local: the last port and 5272 (a page cannot name a port); only what describes itself as Foundry Local ---- */
    const none = await ask('discover', {});
    check('11 not on a known port: NOT_FOUND (no scan unless asked)', !none.ok && none.code === 'NOT_FOUND', none);
    const plain = await plainServer();
    const pickedPlain = await ask('discover', { port: plain.port });
    const pickedFl = await ask('discover', { port: mf.port });
    const setByPage = await ask('setPort', { port: mf.port });
    check('12 a page cannot choose a port: "discover" ignores a port in the message, "setPort" is no operation - nothing was requested at the port it named, Foundry Local\'s own included',
      !pickedPlain.ok && pickedPlain.code === 'NOT_FOUND' && !pickedFl.ok && pickedFl.code === 'NOT_FOUND' && !setByPage.ok && setByPage.code === 'BAD_REQUEST' && plain.log.length === 0 && mf.log.length === 0,
      { pickedPlain, pickedFl, setByPage, plainSaw: plain.log, flSaw: mf.log.length });
    await plain.close();
    // (the person types the port into the extension's own window, which stores it: see "the window of the extension")
    await inSw('chrome.storage.local.set({ port: ' + mf.port + ' })');
    const set = await ask('discover', {});
    check('15 the port the person gave the extension is taken: the answer of /status names exactly this address', set.ok && set.base === mf.url && set.port === mf.port, set);
    const again = await ask('discover', {});
    check('16 and is remembered: discover finds it again (last port)', again.ok && again.base === mf.url, again);

    /* ---- the four routes ---- */
    const models = await call('models');
    const ml = JSON.parse(models.text || 'null');
    check('18 models: the catalogue (' + mf.catalog.length + ' entries)', models.ok && models.status === 200 && ml.data.length === mf.catalog.length, models.status);
    const loaded0 = await call('loaded');
    check('19 loaded: nothing is loaded yet', loaded0.ok && loaded0.text === '[]', loaded0);
    const noLoad = await call('chat', { body: body() });
    check('20 a chat before the model is loaded: an HTTP 400 "must be loaded" is an answer, not an error of the bridge', noLoad.ok && noLoad.status === 400 && /must be loaded/.test(noLoad.text), noLoad);
    const load = await call('load', { modelId: 'qwen3.5-4b' });
    const lj = JSON.parse(load.text || 'null');
    check('21 load by alias: Foundry Local picks the variant that is on the disk and says which (qwen3.5-4b-generic-cpu:3)', load.ok && load.status === 200 && lj.model_id === 'qwen3.5-4b-generic-cpu:3' && lj.status === 'loaded', load);
    check('22 loaded: lists it', (await call('loaded')).text === '["qwen3.5-4b-generic-cpu:3"]');
    const chat = await call('chat', { body: body() });
    check('23 chat: the completion of the model', chat.ok && chat.status === 200 && JSON.parse(chat.text).choices[0].message.content === 'OK', chat);
    const pic = imgBody('data:image/jpeg;base64,AAAA');
    check('24 a picture (JPEG data, as the app sends them) to a model that sees pictures is accepted', (await call('chat', { body: pic })).status === 200);
    await call('load', { modelId: 'qwen2.5-1.5b' });
    const noVision = await call('chat', { body: body({ model: 'qwen2.5-1.5b-instruct-generic-gpu:4', messages: JSON.parse(pic).messages }) });
    check('25 a picture to a text model: Foundry Local\'s own refusal comes through (how the page learns that a model cannot see)', noVision.status === 400 && /multimodal/.test(noVision.text), noVision);
    const notCached = await call('load', { modelId: 'phi-4-mini' });
    const unknown = await call('load', { modelId: 'no-such-model' });
    check('26 a model that is not downloaded: HTTP 400 "not cached"; one that does not exist: 404', notCached.status === 400 && /not cached/i.test(notCached.text) && unknown.status === 404, { notCached: notCached.status, unknown: unknown.status });

    /* ---- what a page cannot do ---- */
    const seenBefore = mf.log.length;
    const refusals = [
      await call('shutdown'), await call('logs'), await call('constructor'), await call('catalogs/local'), await call('status'), await call('unload', { modelId: 'qwen3.5-4b-generic-cpu:3' }),
      await call('load', { modelId: '../shutdown' }), await call('load', { modelId: 'a/b' }), await call('load', { modelId: '' }),
      await call('chat', { body: body({ stream: true }) }), await call('chat', { body: '{' }), await call('chat', { body: body({ model: '../../x' }) }), await call('models', { body: '{}' }),
      // a picture that is an address (the model server could fetch it: file:, http:) or not a JPEG, a part that is neither text nor a picture
      await call('chat', { body: imgBody('file:///C:/Users/x/secret.png') }), await call('chat', { body: imgBody('http://127.0.0.1:1/x.jpg') }), await call('chat', { body: imgBody('data:image/png;base64,AAAA') }),
      await call('chat', { body: body({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }] }) }),
      await ask('call', { route: '/shutdown' }), await ask('nope', {}),
    ];
    const codes = refusals.map((r) => (r.ok ? 'ok:' + r.status : r.code));
    check('30 routes that are not offered (/shutdown, /status, unload ...), ids that could change the path, streams, bodies that are not chat requests, pictures that are addresses, an unknown operation: none of them reaches Foundry Local', mf.log.length === seenBefore && refusals.every((r) => !r.ok), codes);
    check('31 and the codes tell why (ROUTE_NOT_ALLOWED / BAD_REQUEST)', codes.slice(0, 6).every((c) => c === 'ROUTE_NOT_ALLOWED') && codes.slice(6, 17).every((c) => c === 'BAD_REQUEST') && codes[17] === 'ROUTE_NOT_ALLOWED' && codes[18] === 'BAD_REQUEST', codes);
    const beforeExtra = mf.log.length;
    const extra = await ask('call', { route: 'loaded', url: 'http://127.0.0.1:1/shutdown', method: 'POST', headers: { authorization: 'x' }, port: 1 });
    const extraSeen = mf.log.slice(beforeExtra);
    check('32 an address, a port, a method or headers made up by the page are dropped: the request is GET /models/loaded of the verified address, and nothing else', extra.ok && extra.status === 200 && extraSeen.length === 1 && extraSeen[0].method === 'GET' && extraSeen[0].path === '/models/loaded' && !extraSeen[0].headers.authorization, { extra, extraSeen: extraSeen.map((e) => e.method + ' ' + e.path) });
    const beforeBig = mf.log.length;
    const big = await call('chat', { body: '@big' });
    check('33 a request over 24 MB is refused before it leaves the browser: TOO_LARGE, Foundry Local saw nothing', !big.ok && big.code === 'TOO_LARGE' && mf.log.length === beforeBig, { big, seen: mf.log.length - beforeBig });
    const sentPaths = Array.from(new Set(mf.log.map((e) => e.method + ' ' + e.path.replace(/\/load\/.*/, '/load/*'))));
    check('33b over the whole run only the known routes were requested - never /shutdown, never /models/unload, never a path the page made up (GET /status is the extension\'s own look at who answers)', sentPaths.every((p) => /^(GET \/status|GET \/v1\/models|GET \/models\/loaded|GET \/models\/load\/\*|POST \/v1\/chat\/completions)$/.test(p)), sentPaths);
    const leaks = mf.log.filter((e) => e.headers.cookie || e.headers.referer || e.headers.authorization);
    check('34 no cookies, no referrer, no credentials go to Foundry Local', leaks.length === 0, leaks.map((e) => Object.keys(e.headers)));
    check('35 what is sent for a chat is exactly what the page asked: a JSON body with content-type set by the extension', mf.log.filter((e) => e.method === 'POST').every((e) => /^application\/json/.test(e.headers['content-type'] || '') && e.body && e.body.model), null);

    /* ---- time, abort, concurrency ---- */
    mf.setChatDelay(4000);
    const slow = call('chat', { body: body() });
    await sleep(500);
    const slowId = await app.evaluate('window.__lastId');
    await ask('abort', { target: slowId });
    const aborted = await slow;
    await sleep(300);
    const lastChat = mf.log.filter((e) => e.method === 'POST').pop();
    check('40 abort: the request stops (ABORTED) and the connection to Foundry Local is closed', !aborted.ok && aborted.code === 'ABORTED' && lastChat.closed === true, { aborted, closed: lastChat.closed });
    mf.setChatDelay(3000);
    const t0 = Date.now();
    const slow2 = await call('chat', { body: body(), timeoutMs: 1200 });
    check('41 a time limit of the page is kept (clamped to 1 s .. 10 min): TIMEOUT', !slow2.ok && slow2.code === 'TIMEOUT' && Date.now() - t0 < 2800, { slow2, ms: Date.now() - t0 });
    mf.setChatDelay(900);
    const t1 = Date.now();
    const four = await Promise.all([1, 2, 3, 4].map(() => call('chat', { body: body() })));
    check('42 at most two requests are open at the same time (four were sent: ' + (Date.now() - t1) + ' ms, most open at once: ' + mf.maxConcurrent + ')', four.every((r) => r.ok && r.status === 200) && mf.maxConcurrent === 2 && Date.now() - t1 >= 1700, { max: mf.maxConcurrent, ms: Date.now() - t1 });
    mf.setChatDelay(0);
    // a page that sends far more than the extension can answer: the surplus is refused (BUSY) instead of being held in memory
    mf.setChatDelay(400);
    const flood = await Promise.all(Array.from({ length: 26 }, () => call('chat', { body: body() })));
    const busy = flood.filter((r) => !r.ok && r.code === 'BUSY').length;
    const done = flood.filter((r) => r.ok && r.status === 200).length;
    check('42b 26 requests at once: the surplus gets BUSY (' + busy + '), the others are answered (' + done + ')', busy >= 1 && done >= 18 && busy + done === 26, flood.map((r) => (r.ok ? r.status : r.code)));
    mf.setChatDelay(0);
    if (process.env.VE_FL_LONG !== '0') {
      // the worker of an extension is stopped after 30 s without an event: a model that thinks for longer than that must not lose its answer
      mf.setChatDelay(36000);
      const t2 = Date.now();
      const long = await call('chat', { body: body() });
      check('43 a request that takes 36 s (longer than the 30 s after which the browser stops an idle extension worker) still gets its answer: the page keeps the worker alive', long.ok && long.status === 200 && Date.now() - t2 >= 35000, { long, ms: Date.now() - t2 });
      mf.setChatDelay(0);

      // Nobody uses Foundry Local for a while; it is stopped, and another program takes its port. The next request must not hand the user's prompt to it: the address is
      // looked at again first (GET /status), and only Foundry Local gets anything else.
      const port = mf.port;
      // (the worker is kept awake with harmless messages: a worker that sleeps is restarted without what it knew and looks for Foundry Local from scratch, which checks it just as
      // strictly - what is tested here is the check that a worker which is awake makes again after a quiet spell)
      const swBefore = (await swTarget()).id;
      for (let i = 0; i < 4; i++) { await sleep(8000); await ask('hello', {}); }
      await sleep(1000);
      check('43b the worker stayed awake during the quiet spell (so it still knows the address of Foundry Local, and for how long it has not looked at it)', (await swTarget()).id === swBefore, null);
      await mf.stop();
      // (a) a program that accepts the connection and says nothing: it is given a second, longer chance (4 s + 15 s) and then the request ends - the prompt is not sent
      const hole = await silentServer(port);
      const t4 = Date.now();
      const toHole = await call('chat', { body: body({ messages: [{ role: 'user', content: 'SECRET PROMPT of the user' }] }) });
      check('44 a program that says nothing on the old port gets NO prompt: TIMEOUT after the second, longer look (' + (Date.now() - t4) + ' ms); it was asked only "GET /status"', !toHole.ok && toHole.code === 'TIMEOUT' && Date.now() - t4 >= 18000 && hole.log.length >= 1 && hole.log.every((l) => /^GET \/status /.test(l)), { toHole, ms: Date.now() - t4, seen: hole.log });
      await hole.close();
      // (b) a program that answers, but not as Foundry Local does (what it says is public, so a program that copies it all is not recognised: see SECURITY.md)
      const squat = { log: [] };
      squat.server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          squat.log.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString('utf8') });
          const text = JSON.stringify({ endpoints: ['http://127.0.0.1:' + port], hello: 'squatter' });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
          res.end(text);
        });
      });
      await listen(Object.assign(squat.server, { wantedPort: port }));
      const toSquatter = await call('chat', { body: body({ messages: [{ role: 'user', content: 'SECRET PROMPT of the user' }] }) });
      check('45 another program on the old port that does not answer like Foundry Local gets NO prompt: NOT_FOUND, the program saw only "GET /status"', !toSquatter.ok && toSquatter.code === 'NOT_FOUND' && squat.log.length >= 1 && squat.log.every((e) => e.method === 'GET' && e.path === '/status') && !JSON.stringify(squat.log).includes('SECRET PROMPT'), { toSquatter, seen: squat.log.map((e) => e.method + ' ' + e.path) });
      await new Promise((resolve) => squat.server.close(resolve));
      mf = await mock.start({ port });
      const back = await ask('discover', {});
      check('46 when Foundry Local is back on that port it is found again (the stored port)', back.ok && back.base === 'http://127.0.0.1:' + port, back);
    }

    /* ---- a restart of the extension's worker, and of the whole extension ---- */
    await inSw('chrome.runtime.reload(), true').catch(() => {});
    await waitUntil(async () => { const t = await swTarget(); return t && t.id !== sw.id; }, 20000, 'the extension to restart');
    await sleep(800);
    // chrome.runtime.reload() makes the content script of the open page orphaned; the new worker puts a new one into the page
    const afterReload = await waitUntil(async () => { const r = await Promise.race([ask('hello', { lang: 'en' }), sleep(2500).then(() => null)]); return r && r.ok ? r : null; }, 20000, 'the page to reach the reloaded extension');
    check('50 after the extension was reloaded the open page is served again without a reload of the page (the worker injects the bridge), and the approval and the port were kept', afterReload.approved === true, afterReload);
    const st2 = await call('loaded');
    check('51 and Foundry Local is found again by the stored port', st2.ok && st2.status === 200, st2);

    /* ---- the window of the extension (toolbar) ---- */
    const popupTarget = await new Promise((resolve, reject) => {
      // (newer browsers want PUT for /json/new)
      const req = http.request('http://127.0.0.1:' + app.port + '/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/popup.html'), { method: 'PUT' }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
      req.on('error', reject);
      req.end();
    });
    const pop = await app.attach(popupTarget);
    try {
      await waitUntil(() => pop.evaluate("document.getElementById('stateText').textContent.length > 0 && !/Looking|aranıyor/.test(document.getElementById('stateText').textContent)"), 15000, 'the popup to show its state');
      const text = await pop.evaluate("({ state: document.getElementById('stateText').textContent, sites: Array.from(document.querySelectorAll('#sites .name')).map((n) => n.textContent), ver: document.getElementById('ver').textContent })");
      check('60 the toolbar window shows where Foundry Local is and which sites are allowed', text.state.includes('127.0.0.1:' + mf.port) && JSON.stringify(text.sites) === JSON.stringify([origin]) && text.ver === '1.0.0', text);
      // a port other than the ones it looks at is typed in here (not in the page): what is on it decides
      const usePort = async (n) => {
        await pop.evaluate("(() => { const i = document.getElementById('port'); i.value = " + JSON.stringify(String(n)) + "; document.getElementById('usePort').click(); return true; })()");
        await waitUntil(() => pop.evaluate("document.getElementById('msg').textContent.length > 0"), 15000, 'the answer to the port');
        return pop.evaluate("document.getElementById('msg').textContent");
      };
      const closedPort = await new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
      const other = await plainServer();
      const msgs = { badPort: await usePort(80), none: await usePort(closedPort), other: await usePort(other.port) };
      await other.close();
      check('62 the port that is typed in the toolbar window: below 1024 is refused, a port where nothing listens and a port where another program answers are not taken for Foundry Local',
        /Not a valid port/.test(msgs.badPort) && /not on this port/.test(msgs.none) && /Another program is on this port/.test(msgs.other), msgs);
      const okMsg = await usePort(mf.port);
      check('63 the port of the real thing is taken (the answer of /status names exactly this address) and remembered', /Connected/.test(okMsg) && (await stored()).port === mf.port, { okMsg, port: (await stored()).port });
      await pop.evaluate("document.querySelector('#sites button').click(); true");
      await waitUntil(() => pop.evaluate("document.querySelectorAll('#sites li').length === 0"), 10000, 'the site to be removed');
    } finally { pop.close(); }
    const afterRevoke = await call('loaded');
    check('61 "Remove" in the toolbar window withdraws the approval at once: NOT_APPROVED', !afterRevoke.ok && afterRevoke.code === 'NOT_APPROVED' && !Object.keys((await stored()).approved || {}).length, afterRevoke);

    /* ---- the scan of the dynamic ports: only when asked, only with a click ---- */
    const p3 = ask('connect', { lang: 'en' }, true);
    await answerConsent(true);
    await p3;
    await inSw("chrome.storage.local.remove('port')");
    await inSw('chrome.runtime.reload(), true').catch(() => {});
    await waitUntil(async () => { const t = await swTarget(); return t && t.id !== sw.id; }, 20000, 'the extension to restart');
    await sleep(800);
    await waitUntil(async () => { const r = await Promise.race([ask('hello', {}), sleep(2500).then(() => null)]); return r && r.ok ? r : null; }, 20000, 'the page to reach the extension');
    const inRange = mf.port >= 49152;
    if (!inRange) console.log('NOTE: the stand-in listens on port ' + mf.port + ', below the dynamic range: the scan is not tested');
    // (a click counts for about 5 seconds)
    await sleep(5500);
    const noScanClick = await ask('discover', { scan: true }, false);
    check('70 the scan needs a click: NO_GESTURE (and nothing was probed)', !noScanClick.ok && noScanClick.code === 'NO_GESTURE', noScanClick);
    if (inRange) {
      const seen = mf.log.length;
      const t3 = Date.now();
      const scanned = await ask('discover', { scan: true }, true);
      check('71 the scan finds Foundry Local in the dynamic range (' + (Date.now() - t3) + ' ms)', scanned.ok && scanned.base === mf.url, scanned);
      check('72 and the only thing it asked of what it found is GET /status', mf.log.slice(seen).every((e) => e.method === 'GET' && e.path === '/status') && mf.log.length > seen, mf.log.slice(seen).map((e) => e.method + ' ' + e.path));
      const again2 = await ask('discover', { scan: true }, true);
      check('73 a second scan right after the first is refused for a few seconds (BUSY): a page cannot make the extension sweep the ports over and over', !again2.ok && again2.code === 'BUSY', again2);
    }

    /* ---- a window that another page opened is not served: the opener could reach into it (same origin) and speak for it ---- */
    const own = await app.evaluate("document.documentElement.getAttribute('data-ve-fl-bridge')");
    check('81 a window that the person opened (an address, a bookmark) has the bridge', own === '1.0.0', own);
    const opened = await app.evaluate(`(async () => {
      const w = window.open(location.origin + '/index.html?vetest-child', '_blank');
      if (!w) return { error: 'no window' };
      const replies = [];
      for (let i = 0; i < 150 && !(w.location.href.includes('vetest-child') && w.document.readyState === 'complete' && w.VE && w.VE.actions); i++) await new Promise((r) => setTimeout(r, 100));
      w.addEventListener('message', (e) => { if (e.data && e.data.source === 've-fl-ext') replies.push(e.data); });
      await new Promise((r) => setTimeout(r, 500));
      w.postMessage({ source: 've-fl-page', id: 1, op: 'hello', lang: 'en' }, location.origin);
      await new Promise((r) => setTimeout(r, 2500));
      const out = { signal: w.document.documentElement.getAttribute('data-ve-fl-bridge'), replies: replies.length, hasOpener: !!w.opener };
      w.close();
      return out;
    })()`, { userGesture: true });
    check('82 a window that the page opened itself (window.open) gets no bridge, although it is the very site that is approved: no signal, no answer', opened && opened.hasOpener === true && opened.signal === null && opened.replies === 0, opened);

    /* ---- other pages ---- */
    await app.navigate('http://other.localhost:' + srv.port + '/index.html?vetest', READY);
    const sig = await app.evaluate("document.documentElement.getAttribute('data-ve-fl-bridge')");
    const helloOther = await Promise.race([ask('hello', {}), sleep(1500).then(() => 'timeout')]);
    check('80 a page of another site (the test manifest names 127.0.0.1 and localhost, not other.localhost) gets no bridge: no signal, no answer', sig === null && helloOther === 'timeout', { sig, helloOther });

    const unexpected = app.errors.filter((e) => !/Failed to load resource|net::ERR_/.test(String(e)));
    check('90 no console errors in the page', unexpected.length === 0, unexpected);
  } finally {
    await app.close();
    await mf.stop();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('fl-bridge test crashed:', e); process.exit(1); });
