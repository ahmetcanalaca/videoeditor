'use strict';
// The rules of the browser extension that carries Foundry Local to the web edition (web/extension/): what a page may ask for, how Foundry Local is recognised,
// which pages are served, and what the package (manifest, files, zip) may contain. No browser needed: policy.js is pure, the manifest and the sources are read.
//   node tests/ext-policy.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { checker } = require('./lib/check');

const WEB = path.resolve(__dirname, '..');
const EXT = path.join(WEB, 'extension');
const P = require(path.join(EXT, 'policy.js'));
const pack = require(path.join(WEB, 'scripts', 'pack-extension.js'));
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');

const check = checker('extension policy');
const body = (o) => JSON.stringify(Object.assign({ model: 'qwen3.5-4b-generic-cpu:3', messages: [{ role: 'user', content: 'hi' }] }, o));
const code = (r) => (r.ok ? 'ok' : r.code);

/* ---- what a page may ask for ---- */
for (const r of ['models', 'loaded']) {
  const c = P.checkCall({ route: r });
  check('01 route "' + r + '" is a GET without a body: ' + (c.ok ? c.method + ' ' + c.path : c.code), c.ok && c.method === 'GET' && c.body === undefined && ['/v1/models', '/models/loaded'].includes(c.path), c);
}
check('02 a body on a GET route is refused', code(P.checkCall({ route: 'models', body: '{}' })) === 'BAD_REQUEST');
const ids = ['qwen3.5-4b-generic-cpu:3', 'qwen3.5-4b', 'Phi-4-mini-instruct-generic-gpu:5', 'DeepSeek-R1-Distill-Qwen-7B-vitis-npu:2'];
check('03 load takes a model id or alias and builds the path from it', ids.every((id) => {
  const l = P.checkCall({ route: 'load', modelId: id });
  return l.ok && l.path === '/models/load/' + encodeURIComponent(id) && l.method === 'GET';
}), ids);
const badIds = ['', '..', '../shutdown', 'a/b', 'a\\b', 'a b', 'a?b=1', 'a#b', '%2e%2e', 'x'.repeat(121), ' qwen', 'qwen\n', '-qwen', 'a%2Fb', 42, null, {}, ['a']];
check('04 an id that could change the path or add a query is refused (no request is made)', badIds.every((id) => code(P.checkCall({ route: 'load', modelId: id })) === 'BAD_REQUEST'), badIds.filter((id) => P.checkCall({ route: 'load', modelId: id }).ok));
const badRoutes = ['shutdown', 'logs', 'status', 'unload', '/status', 'status ', 'STATUS', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '', 'catalogs/local', 'responses', 'embeddings', 7, null, undefined, {}, ['models']];
check('05 any other route - /shutdown, /status, unload, the other services of Foundry Local, names of Object.prototype - is refused, and so is a message that is not an object', Object.keys(P.ROUTES).sort().join() === 'chat,load,loaded,models' && badRoutes.every((r) => code(P.checkCall({ route: r, modelId: 'qwen3.5-4b' })) === 'ROUTE_NOT_ALLOWED') && [null, undefined, 'x', [], 1].every((m) => code(P.checkCall(m)) === 'ROUTE_NOT_ALLOWED'), badRoutes.filter((r) => code(P.checkCall({ route: r })) !== 'ROUTE_NOT_ALLOWED'));
const okChat = P.checkCall({ route: 'chat', body: body(), timeoutMs: 5000 });
check('06 a chat request: POST /v1/chat/completions with the body that was checked (written again, same content), timeout kept', okChat.ok && okChat.method === 'POST' && okChat.path === '/v1/chat/completions' && okChat.timeoutMs === 5000 && okChat.body === body(), okChat);
const jpeg = (url) => body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: 'what is this' }] }] });
const chatCases = [
  ['no body', { route: 'chat' }, 'BAD_REQUEST'],
  ['not JSON', { route: 'chat', body: '{oops' }, 'BAD_REQUEST'],
  ['a JSON array', { route: 'chat', body: '[]' }, 'BAD_REQUEST'],
  ['no model', { route: 'chat', body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) }, 'BAD_REQUEST'],
  ['a model that is not an id', { route: 'chat', body: body({ model: '../x' }) }, 'BAD_REQUEST'],
  ['no messages', { route: 'chat', body: body({ messages: [] }) }, 'BAD_REQUEST'],
  ['messages that are not a list', { route: 'chat', body: body({ messages: 'hi' }) }, 'BAD_REQUEST'],
  ['a message that is not an object', { route: 'chat', body: body({ messages: ['hi'] }) }, 'BAD_REQUEST'],
  ['too many messages', { route: 'chat', body: body({ messages: Array.from({ length: P.LIMITS.messages + 1 }, () => ({ role: 'user', content: 'x' })) }) }, 'BAD_REQUEST'],
  ['a stream (the bridge hands over whole answers)', { route: 'chat', body: body({ stream: true }) }, 'BAD_REQUEST'],
  ['a stream written as a string', { route: 'chat', body: body({ stream: 'true' }) }, 'BAD_REQUEST'],
  ['a picture that is a file address', { route: 'chat', body: jpeg('file:///C:/Users/x/secret.png') }, 'BAD_REQUEST'],
  ['a picture that is a web address', { route: 'chat', body: jpeg('http://127.0.0.1:1/x.jpg') }, 'BAD_REQUEST'],
  ['a picture that is not JPEG data', { route: 'chat', body: jpeg('data:image/png;base64,AAAA') }, 'BAD_REQUEST'],
  ['a picture whose address is not a string', { route: 'chat', body: body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 5 } }] }] }) }, 'BAD_REQUEST'],
  ['a content part that is neither text nor a picture', { route: 'chat', body: body({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }] }) }, 'BAD_REQUEST'],
  ['a content part that is not an object', { route: 'chat', body: body({ messages: [{ role: 'user', content: ['hi'] }] }) }, 'BAD_REQUEST'],
  ['a body over the limit', { route: 'chat', body: 'x'.repeat(P.LIMITS.requestChars + 1) }, 'TOO_LARGE'],
];
chatCases.forEach(([name, msg, want], i) => check('07.' + (i + 1) + ' chat: ' + name + ' -> ' + want, code(P.checkCall(msg)) === want, P.checkCall(msg)));
check('08 "stream": false, text and JPEG pictures, a tool call without content, a tool answer are fine', [
  body({ stream: false }), jpeg('data:image/jpeg;base64,/9j/4AAQ'),
  body({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] }),
].every((b) => P.checkCall({ route: 'chat', body: b }).ok === true));
// a body that names a key twice is read differently by different parsers (the first, the last): what is sent is the object that was checked
const twice = '{"model":"../../x","model":"qwen3.5-4b-generic-cpu:3","messages":[{"role":"user","content":"x"}],"stream":true,"stream":false}';
const twiceCall = P.checkCall({ route: 'chat', body: twice });
check('08b a key that is there twice is sent once, with the value that was checked', twiceCall.ok && JSON.parse(twiceCall.body).model === 'qwen3.5-4b-generic-cpu:3' && (twiceCall.body.match(/"model"/g) || []).length === 1 && !twiceCall.body.includes('../../x') && !/"stream":true/.test(twiceCall.body), twiceCall);
check('09 timeouts are clamped to 1 s .. 10 min, a missing or odd value gets the default', P.clampTimeout(5) === 1000 && P.clampTimeout(1e9) === 600000 && P.clampTimeout(NaN) === P.LIMITS.timeoutDefault && P.clampTimeout('x') === P.LIMITS.timeoutDefault && P.clampTimeout(-5) === P.LIMITS.timeoutDefault && P.clampTimeout(45000) === 45000, null);

/* ---- how Foundry Local is recognised ---- */
const BASE = 'http://127.0.0.1:65416';
const REAL = { artifact_qualified_model_management: true, endpoints: [BASE], modelCachePath: 'C:\\Users\\x/.foundry/cache/models', pid: 46072 };
check('10 the answer of the real service (GET /status) is accepted for the address that was asked', P.isFoundryStatus(REAL, BASE));
const notFoundry = [
  ['another port in the answer', Object.assign({}, REAL, { endpoints: ['http://127.0.0.1:1111'] })],
  ['another host in the answer', Object.assign({}, REAL, { endpoints: ['http://evil.example:65416'] })],
  ['no endpoints', Object.assign({}, REAL, { endpoints: [] })],
  ['endpoints that are not a list', Object.assign({}, REAL, { endpoints: BASE })],
  ['endpoints with a non-string', Object.assign({}, REAL, { endpoints: [BASE, 5] })],
  ['too many endpoints', Object.assign({}, REAL, { endpoints: Array.from({ length: 9 }, () => BASE) })],
  ['no model cache path', Object.assign({}, REAL, { modelCachePath: '' })],
  ['a pid that is not a number', Object.assign({}, REAL, { pid: '46072' })],
  ['a pid of 0', Object.assign({}, REAL, { pid: 0 })],
  ['an array', [REAL]], ['null', null], ['a string', 'ok'],
];
notFoundry.forEach(([name, json], i) => check('11.' + (i + 1) + ' not Foundry Local: ' + name, !P.isFoundryStatus(json, BASE)));
check('12 ports: 1024..65535 only', P.validPort(5272) && P.validPort(65535) && P.validPort(1024) && !P.validPort(1023) && !P.validPort(65536) && !P.validPort(0) && !P.validPort('5272') && !P.validPort(52.5) && !P.validPort(NaN) && P.baseOf(5272) === 'http://127.0.0.1:5272', null);

/* ---- which pages are served ---- */
const manifest = JSON.parse(read('manifest.json'));
const MATCH = manifest.content_scripts[0].matches;
const SITE = 'https://ahmetcanalaca.github.io/videoeditor/';
const served = [SITE, SITE + 'index.html', SITE + 'index.html?vetest', SITE + 'a/b/c.html'];
const refused = [
  'https://ahmetcanalaca.github.io/videoeditor', 'https://ahmetcanalaca.github.io/', 'https://ahmetcanalaca.github.io/videoeditor-evil/', 'https://ahmetcanalaca.github.io/other/videoeditor/',
  'http://ahmetcanalaca.github.io/videoeditor/', 'https://ahmetcanalaca.github.io.evil.example/videoeditor/', 'https://evil.example/ahmetcanalaca.github.io/videoeditor/',
  'https://evil.example/?https://ahmetcanalaca.github.io/videoeditor/', 'https://user:pw@ahmetcanalaca.github.io/videoeditor/', 'https://sub.ahmetcanalaca.github.io/videoeditor/',
  'https://AHMETCANALACA.evil/videoeditor/', 'file:///videoeditor/', 'chrome-extension://abc/videoeditor/', 'javascript:alert(1)', 'not a url', '', null, 42,
];
check('13 the published site (and only it) is served: ' + MATCH.join(', '), served.every((u) => P.originAllowed(u, MATCH) === 'https://ahmetcanalaca.github.io') && refused.every((u) => P.originAllowed(u, MATCH) === ''), { notServed: served.filter((u) => !P.originAllowed(u, MATCH)), served: refused.filter((u) => P.originAllowed(u, MATCH)) });
check('14 a host with a "*." wildcard matches subdomains and the host itself, nothing else', P.matchesPattern('https://a.b.example.com/x', 'https://*.example.com/*') && P.matchesPattern('https://example.com/x', 'https://*.example.com/*') && !P.matchesPattern('https://badexample.com/x', 'https://*.example.com/*') && !P.matchesPattern('https://example.com.evil/x', 'https://*.example.com/*'), null);
check('15 the port of a page does not matter to a pattern (as in the browser): http://127.0.0.1/* serves every port of the test server', P.matchesPattern('http://127.0.0.1:8123/index.html', 'http://127.0.0.1/*') && !P.matchesPattern('http://127.0.0.2:8123/index.html', 'http://127.0.0.1/*'), null);

/* ---- the manifest ---- */
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
check('20 manifest v3, version 1.x.y, a service worker, no other background', manifest.manifest_version === 3 && /^\d+\.\d+\.\d+$/.test(manifest.version) && manifest.background && manifest.background.service_worker === 'background.js' && Object.keys(manifest.background).length === 1, manifest.background);
check('21 permissions: storage and scripting only (scripting: to put the bridge into the open pages of the site after installing)', JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'scripting']) && !manifest.optional_permissions && !manifest.optional_host_permissions, manifest.permissions);
check('22 host permissions: this computer (http://127.0.0.1/*) and the published site, nothing else', JSON.stringify(manifest.host_permissions) === JSON.stringify(['http://127.0.0.1/*', 'https://ahmetcanalaca.github.io/videoeditor/*']), manifest.host_permissions);
check('23 one content script, only on the published site, top frame only, no <all_urls>', manifest.content_scripts.length === 1 && JSON.stringify(MATCH) === JSON.stringify(['https://ahmetcanalaca.github.io/videoeditor/*']) && manifest.content_scripts[0].all_frames === false && JSON.stringify(manifest.content_scripts[0].js) === JSON.stringify(['content.js']) && !JSON.stringify(manifest).includes('<all_urls>') && !JSON.stringify(manifest).includes('*://'), manifest.content_scripts);
const forbidden = ['externally_connectable', 'web_accessible_resources', 'nativeMessaging', 'webRequest', 'webRequestBlocking', 'declarativeNetRequest', 'cookies', 'tabs', 'history', 'downloads', 'debugger', 'proxy', 'management', 'identity', 'clipboardRead', 'clipboardWrite', 'activeTab', 'sidePanel', 'offscreen', 'unlimitedStorage', 'background_page', 'update_url', 'key', 'oauth2', 'sandbox', 'content_security_policy_sandbox'];
check('24 nothing that would open the extension to other pages or widen its reach: ' + forbidden.length + ' keys / permissions are absent', forbidden.every((k) => !hasKey(manifest, k) && !(manifest.permissions || []).includes(k) && !(manifest.host_permissions || []).includes(k)), forbidden.filter((k) => hasKey(manifest, k) || (manifest.permissions || []).includes(k)));
const csp = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
check('25 the extension pages have a strict CSP: nothing but themselves by default, own scripts only, no eval / inline, connect only to itself and 127.0.0.1', typeof csp === 'string' && /^default-src 'self';/.test(csp) && /script-src 'self'(;|$)/.test(csp) && !/unsafe-(eval|inline)|wasm-unsafe-eval|https?:\/\/(?!127\.0\.0\.1)/.test(csp) && /object-src 'none'/.test(csp) && /connect-src 'self' http:\/\/127\.0\.0\.1:\*/.test(csp), csp);
const refs = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), ...manifest.content_scripts[0].js, 'consent.html', 'policy.js', 'ui.css', 'ui-i18n.js'];
check('26 every file the manifest (and the pages) refer to exists', refs.every((f) => fs.existsSync(path.join(EXT, f))), refs.filter((f) => !fs.existsSync(path.join(EXT, f))));
const loc = (l) => JSON.parse(read('_locales/' + l + '/messages.json'));
const en = loc('en');
const tr = loc('tr');
check('27 the name (45 characters at most) and the description (132 at most) exist in English and Turkish', JSON.stringify(Object.keys(en)) === JSON.stringify(Object.keys(tr)) && [en, tr].every((l) => l.extName.message.length <= 45 && l.extDesc.message.length <= 132) && manifest.default_locale === 'en' && manifest.name === '__MSG_extName__' && manifest.description === '__MSG_extDesc__', { en: [en.extName.message.length, en.extDesc.message.length], tr: [tr.extName.message.length, tr.extDesc.message.length] });
const uiText = read('ui-i18n.js');
const keysOf = (lang) => { const m = new RegExp(lang + ': \\{([\\s\\S]*?)\\n    \\},').exec(uiText); return m ? Array.from(m[1].matchAll(/'([a-z.A-Z]+)':/g)).map((x) => x[1]) : []; };
check('28 the windows of the extension have the same texts in Turkish and English', keysOf('tr').length > 20 && JSON.stringify(keysOf('tr')) === JSON.stringify(keysOf('en')), { tr: keysOf('tr').length, en: keysOf('en').length });

/* ---- the sources: what they may not do ---- */
const js = ['background.js', 'content.js', 'policy.js', 'popup.js', 'consent.js', 'ui-i18n.js'].map((f) => [f, read(f)]);
const banned = [/\beval\s*\(/, /new Function\b/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /XMLHttpRequest/, /WebSocket/, /importScripts\s*\(\s*['"]https?:/, /\bimport\s*\(/, /sendBeacon/, /localStorage|sessionStorage|indexedDB/, /chrome\.cookies|chrome\.history|chrome\.downloads|chrome\.webRequest|chrome\.proxy/, /console\.(log|info|debug)\s*\(/];
check('30 no eval, no HTML injection, no other network API, no web storage, no logging of what passes through', js.every(([, src]) => banned.every((re) => !re.test(src))), js.flatMap(([f, src]) => banned.filter((re) => re.test(src)).map((re) => f + ' ' + re)));
const fetches = js.flatMap(([f, src]) => src.split('\n').map((line, i) => [f, i + 1, line]).filter(([, , line]) => /\bfetch\s*\(/.test(line) && !/^\s*\/\//.test(line)));
check('31 the only fetch() calls are the two in background.js, and both go to the address of Foundry Local that was verified (base + a fixed path / the route table)', fetches.length === 2 && fetches.every(([f, , line]) => f === 'background.js' && (/fetch\(base \+ '\/status'/.test(line) || /fetch\(base \+ c\.path/.test(line))), fetches);
check('32 chrome.runtime.sendMessage is used by the windows of the extension only, never to pass a page\'s data on', js.filter(([, src]) => /chrome\.runtime\.sendMessage/.test(src)).map(([f]) => f).sort().join() === 'consent.js,popup.js', null);
const contentJs = read('content.js');
const opsBlock = /const ops = \{([\s\S]*?)\n  \};/.exec(contentJs);
check('34 the page chooses neither an address nor a port: of its messages only the known fields are passed on, and there is no operation that sets a port', !!opsBlock && !/\bport\b|setPort|\burl\b|\bbase\b/.test(opsBlock[1]) && ['hello', 'connect', 'discover', 'call', 'abort'].every((k) => new RegExp('\\n    ' + k + ': ').test(opsBlock[1])) && (opsBlock[1].match(/\n    \w+: /g) || []).length === 5, opsBlock && opsBlock[1]);
check('35 a window that another page opened (window.opener) is not served', /if \(window\.opener\) return;/.test(contentJs) && contentJs.indexOf('window.opener') < contentJs.indexOf('window.__veFlBridge = true'), null);
const bg = read('background.js');
check('36 the approvals are readable by the extension\'s own contexts only (storage.local access level), and the page-driven requests wait in a short queue (BUSY above it)', /chrome\.storage\.local\.setAccessLevel\(\{ accessLevel: 'TRUSTED_CONTEXTS' \}\)/.test(bg) && /state\.waiters\.length >= MAX_WAITING\) return \{ ok: false, code: 'BUSY' \}/.test(bg), null);
const html = ['popup.html', 'consent.html'].map((f) => read(f));
check('33 the windows load their own scripts only (no inline script or style, no remote file)', html.every((h) => !/<script(?![^>]*\ssrc=)[^>]*>/i.test(h) && !/\son\w+\s*=/i.test(h) && !/\sstyle\s*=/i.test(h) && !/https?:\/\//i.test(h)), null);

/* ---- the package ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-ext-pack-'));
try {
  const z1 = pack.buildZip({ zip: path.join(tmp, 'a.zip') });
  const z2 = pack.buildZip({ zip: path.join(tmp, 'b.zip') });
  check('40 the zip is reproducible (same sources, same bytes)', z1.sha256 === z2.sha256 && z1.bytes === z2.bytes, [z1.sha256, z2.sha256]);
  const onDisk = crypto.createHash('sha256').update(fs.readFileSync(z1.zip)).digest('hex');
  check('41 the .sha256 file names the zip and its hash', fs.readFileSync(z1.zip + '.sha256', 'utf8').trim() === onDisk + '  a.zip' && onDisk === z1.sha256, null);
  const allowed = new Set(pack.FILES);
  check('42 the zip holds the extension and nothing else (no tests, no notes)', z1.files.every((f) => allowed.has(f) || pack.DIRS.some((d) => f.startsWith(d + '/'))) && z1.files.includes('manifest.json') && z1.version === manifest.version && z1.bytes < 200 * 1024, z1.files);
  const prod = pack.buildFolder({ out: path.join(tmp, 'prod'), variant: 'prod' });
  const test = pack.buildFolder({ out: path.join(tmp, 'test'), variant: 'test' });
  const mp = JSON.parse(fs.readFileSync(path.join(prod.out, 'manifest.json'), 'utf8'));
  const mt = JSON.parse(fs.readFileSync(path.join(test.out, 'manifest.json'), 'utf8'));
  check('43 the production folder has the manifest as it is', JSON.stringify(mp) === JSON.stringify(manifest), null);
  const strip = (m) => { const c = JSON.parse(JSON.stringify(m)); c.content_scripts[0].matches = []; c.host_permissions = []; c.name = ''; return JSON.stringify(c); };
  check('44 the test manifest differs only in the pages it serves (127.0.0.1 and localhost are added) and its name', strip(mp) === strip(mt) && mt.content_scripts[0].matches.includes('http://127.0.0.1/*') && mt.content_scripts[0].matches.includes('http://localhost/*') && mt.content_scripts[0].matches.includes(SITE + '*') && mt.host_permissions.includes('http://localhost/*'), mt.content_scripts[0].matches);
  check('45 every other file of the test folder is the production file', prod.files.every((f) => f === 'manifest.json' || fs.readFileSync(path.join(prod.out, f)).equals(fs.readFileSync(path.join(test.out, f)))), null);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exitCode = check.summary() ? 0 : 1;
