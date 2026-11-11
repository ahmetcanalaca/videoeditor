'use strict';
// Tests of the assistant's security-relevant plumbing that does not need Electron: API key storage, URL policy,
// the single-origin network allowlist, and the settings schema (no secret ever lands in settings.json).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KeyStore, validateKey } = require('../src/main/ai/secrets');
const { validateBaseUrl, createAiNet } = require('../src/main/ai/net');
const { sanitize, DEFAULTS } = require('../src/main/settings');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);

const FAKE_KEY = 'TEST_KEY_not_a_real_secret_0123456789';
const ORIGIN = 'https://api.example.com';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-ai-net-'));
const fileOf = (n) => path.join(tmp, n + '.json');

// A reversible stand-in for safeStorage: obviously not the real cipher, but the bytes differ from the plain text.
const fakeSafe = (available) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
});

test('validateKey: trims, rejects empty / spaces / control chars / non-ASCII / too long', () => {
  eq(validateKey('  ' + FAKE_KEY + '\n').key, FAKE_KEY);
  eq(validateKey('').code, 'KEY_EMPTY');
  eq(validateKey(null).code, 'KEY_EMPTY');
  eq(validateKey('abc def').code, 'KEY_INVALID');
  eq(validateKey('abc\u0000def').code, 'KEY_INVALID');
  eq(validateKey('anahtar-ı').code, 'KEY_INVALID');
  eq(validateKey('x'.repeat(5000)).code, 'KEY_TOO_LONG');
  eq(validateKey('Bearer abc').code, 'KEY_INVALID');
});

test('KeyStore: the key is encrypted on disk, never plain, and survives a restart', () => {
  const file = fileOf('k1');
  const s = new KeyStore({ file, safeStorage: fakeSafe(true) });
  eq(s.has(), false);
  eq(s.set(FAKE_KEY, ORIGIN).ok, true);
  const raw = fs.readFileSync(file, 'utf8');
  ok(!raw.includes(FAKE_KEY), 'plain key found in the file');
  ok(!raw.includes(FAKE_KEY.slice(0, 12)), 'key fragment found in the file');
  ok(!raw.includes('api.example.com'), 'the endpoint must be inside the encrypted record too');
  ok(!Buffer.from(JSON.parse(raw).data, 'base64').toString('utf8').includes(FAKE_KEY), 'ciphertext is the plain text');
  const again = new KeyStore({ file, safeStorage: fakeSafe(true) });
  eq(again.get(ORIGIN), FAKE_KEY);
  eq(again.origin(), ORIGIN);
  eq(again.info().persisted, true);
  eq(JSON.stringify(Object.keys(again.info()).sort()), JSON.stringify(['encryptionAvailable', 'hasKey', 'masked', 'persisted']));
});

test('KeyStore: the key is bound to its endpoint INSIDE the encrypted record and is only handed out for that origin', () => {
  const file = fileOf('k1b');
  const safe = fakeSafe(true);
  const s = new KeyStore({ file, safeStorage: safe });
  s.set(FAKE_KEY, ORIGIN);
  eq(s.get(ORIGIN), FAKE_KEY);
  eq(s.get('https://evil.example.org'), '', 'another origin gets nothing');
  eq(s.get(ORIGIN + '/'), '', 'the origin must match exactly');
  eq(s.get(''), '');
  eq(s.get(undefined), '');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq(doc.v, 2);
  const rec = JSON.parse(safe.decryptString(Buffer.from(doc.data, 'base64')));
  eq(JSON.stringify(rec), JSON.stringify({ k: FAKE_KEY, o: ORIGIN }), 'key and origin form ONE record');
  s.set(FAKE_KEY + 'B', 'https://other.example.net');
  const again = new KeyStore({ file, safeStorage: safe });
  eq(again.get('https://other.example.net'), FAKE_KEY + 'B');
  eq(again.get(ORIGIN), '', 'after a restart the key still belongs to the NEW endpoint only');
  s.clear();
  eq(s.origin(), '');
});

test('KeyStore: a failed write never leaves an older record on disk (it could come back paired with the wrong endpoint)', () => {
  const file = fileOf('k1c');
  let calls = 0;
  const flaky = Object.assign({}, fakeSafe(true), { encryptString: (x) => { calls += 1; if (calls === 2) throw new Error('disk full'); return fakeSafe(true).encryptString(x); } });
  const s = new KeyStore({ file, safeStorage: flaky });
  eq(s.set(FAKE_KEY, ORIGIN).ok, true);
  ok(fs.existsSync(file));
  eq(s.set(FAKE_KEY + 'B', 'https://other.example.net').ok, true, 'the new key still works for this session');
  eq(s.info().persisted, false);
  eq(s.get('https://other.example.net'), FAKE_KEY + 'B');
  eq(fs.existsSync(file), false, 'the old record must be gone');
  eq(new KeyStore({ file, safeStorage: fakeSafe(true) }).has(), false);
});

// A file system in which the key file can be "locked": deleting / overwriting / renaming it fails like an antivirus lock would.
function lockableFs(file, lock) {
  const locked = (what) => Object.assign(new Error('EPERM: operation not permitted, ' + what), { code: 'EPERM' });
  return Object.assign({}, fs, {
    rmSync: (p, o) => { if (p === file && lock.rm > 0) { lock.rm -= 1; throw locked('unlink'); } return fs.rmSync(p, o); },
    writeFileSync: (p, d, e) => { if (p === file && lock.write) throw locked('open'); return fs.writeFileSync(p, d, e); },
    renameSync: (a, b) => { if (b === file && lock.rename) throw locked('rename'); return fs.renameSync(a, b); },
  });
}

test('KeyStore: clear() retries a temporary lock, falls back to an empty marker, and REPORTS a record it could not get rid of', () => {
  // temporary lock: the third attempt works
  let file = fileOf('k1e'), lock = { rm: 0, write: false, rename: false };
  let s = new KeyStore({ file, safeStorage: fakeSafe(true), fs: lockableFs(file, lock), retryDelaysMs: [0, 0, 0] });
  s.set(FAKE_KEY, ORIGIN);
  lock.rm = 2;
  eq(s.clear().ok, true); eq(fs.existsSync(file), false); eq(s.has(), false);
  // permanent delete lock, but the file can still be overwritten: an empty marker replaces the record
  file = fileOf('k1f'); lock = { rm: Infinity, write: false, rename: false };
  s = new KeyStore({ file, safeStorage: fakeSafe(true), fs: lockableFs(file, lock), retryDelaysMs: [0, 0, 0] });
  s.set(FAKE_KEY, ORIGIN);
  eq(s.clear().ok, true, 'a neutralised record is as good as a deleted one');
  eq(new KeyStore({ file, safeStorage: fakeSafe(true) }).has(), false, 'the marker is never loaded as a key');
  // neither deleting nor overwriting works: the key is forgotten in memory, but the caller is told it is still on disk
  file = fileOf('k1g'); lock = { rm: Infinity, write: false, rename: false };
  s = new KeyStore({ file, safeStorage: fakeSafe(true), fs: lockableFs(file, lock), retryDelaysMs: [0, 0, 0] });
  s.set(FAKE_KEY, ORIGIN);
  lock.write = true;
  const r = s.clear();
  eq(r.ok, false); eq(r.code, 'KEY_DELETE_FAILED');
  eq(s.has(), false, 'never used again in this session');
  eq(new KeyStore({ file, safeStorage: fakeSafe(true) }).has(), true, 'this is exactly why the failure has to be reported');
});

test('KeyStore: a key that could be neither stored nor replace the older record changes nothing and says so', () => {
  const file = fileOf('k1h');
  const lock = { rm: 0, write: false, rename: false };
  const s = new KeyStore({ file, safeStorage: fakeSafe(true), fs: lockableFs(file, lock), retryDelaysMs: [0, 0, 0] });
  eq(s.set(FAKE_KEY, ORIGIN).ok, true);
  lock.rename = true; lock.rm = Infinity; lock.write = true;
  const r = s.set(FAKE_KEY + 'B', 'https://other.example.net');
  eq(r.ok, false); eq(r.code, 'KEY_STORE_FAILED');
  eq(s.get(ORIGIN), FAKE_KEY, 'the older key keeps working for its own endpoint'); eq(s.get('https://other.example.net'), '');
  eq(s.origin(), ORIGIN); eq(s.info().persisted, true);
  eq(new KeyStore({ file, safeStorage: fakeSafe(true) }).get(ORIGIN), FAKE_KEY);
  // a failed write that only needs the older record out of the way still works (covered above): the new key is memory-only
  lock.rm = 0; lock.write = false;
  eq(s.set(FAKE_KEY + 'C', 'https://other.example.net').ok, true);
  eq(s.info().persisted, false); eq(fs.existsSync(file), false);
});

test('KeyStore: a record in the old format (no endpoint) or without an endpoint field is not trusted', () => {
  const file = fileOf('k1d');
  const safe = fakeSafe(true);
  fs.writeFileSync(file, JSON.stringify({ v: 1, enc: 'safeStorage', data: safe.encryptString(FAKE_KEY).toString('base64') }));
  eq(new KeyStore({ file, safeStorage: safe }).has(), false, 'v1 has no binding');
  fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'safeStorage', data: safe.encryptString(JSON.stringify({ k: FAKE_KEY })).toString('base64') }));
  eq(new KeyStore({ file, safeStorage: safe }).has(), false, 'v2 without o');
  fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'safeStorage', data: safe.encryptString(JSON.stringify({ k: 'bad key', o: ORIGIN })).toString('base64') }));
  eq(new KeyStore({ file, safeStorage: safe }).has(), false, 'invalid key inside');
});

test('KeyStore: info() exposes only a mask (last 4 characters), never the key', () => {
  const s = new KeyStore({ file: fileOf('k2'), safeStorage: fakeSafe(true) });
  s.set(FAKE_KEY, ORIGIN);
  const info = JSON.stringify(s.info());
  ok(!info.includes(FAKE_KEY) && !info.includes(FAKE_KEY.slice(0, -4)), info);
  eq(s.info().masked, '••••' + FAKE_KEY.slice(-4));
  s.set('shortkey', ORIGIN);
  eq(s.info().masked, '••••');
});

test('KeyStore: without OS encryption the key stays in memory only and nothing is written', () => {
  const file = fileOf('k3');
  const s = new KeyStore({ file, safeStorage: fakeSafe(false) });
  eq(s.set(FAKE_KEY, ORIGIN).ok, true);
  eq(s.has(), true);
  eq(s.get(ORIGIN), FAKE_KEY);
  eq(s.info().persisted, false);
  eq(s.info().encryptionAvailable, false);
  eq(fs.existsSync(file), false);
  eq(new KeyStore({ file, safeStorage: fakeSafe(false) }).has(), false);
  eq(new KeyStore({ file, safeStorage: null }).has(), false);
});

test('KeyStore: clear() removes the file and the memory copy; corrupt or foreign files mean "no key"', () => {
  const file = fileOf('k4');
  const s = new KeyStore({ file, safeStorage: fakeSafe(true) });
  s.set(FAKE_KEY, ORIGIN);
  s.clear();
  eq(s.has(), false); eq(fs.existsSync(file), false);
  fs.writeFileSync(file, '{not json');
  eq(new KeyStore({ file, safeStorage: fakeSafe(true) }).has(), false);
  fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'safeStorage', data: 'AAAA' }));
  const throwing = { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('decrypt failed'); }, encryptString: (x) => Buffer.from(x) };
  eq(new KeyStore({ file, safeStorage: throwing }).has(), false);
  fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'plain', data: Buffer.from(JSON.stringify({ k: FAKE_KEY, o: ORIGIN })).toString('base64') }));
  eq(new KeyStore({ file, safeStorage: fakeSafe(true) }).has(), false, 'a non-safeStorage file must never be trusted');
});

test('KeyStore: invalid keys are rejected and do not replace a good one', () => {
  const s = new KeyStore({ file: fileOf('k5'), safeStorage: fakeSafe(true) });
  s.set(FAKE_KEY, ORIGIN);
  eq(s.set('bad key', 'https://other.example.net').ok, false);
  eq(s.get(ORIGIN), FAKE_KEY);
  eq(s.origin(), ORIGIN, 'a rejected key must not change the binding either');
});

test('validateBaseUrl: https anywhere, http only on this machine, no credentials/query/fragment', () => {
  eq(validateBaseUrl('https://api.openai.com/v1/').url, 'https://api.openai.com/v1');
  eq(validateBaseUrl('https://my-gateway.example.com/openai/v1').origin, 'https://my-gateway.example.com');
  eq(validateBaseUrl('http://localhost:11434/v1').ok, true);
  eq(validateBaseUrl('http://127.0.0.1:8080').local, true);
  eq(validateBaseUrl('http://[::1]:8080/v1').ok, true);
  eq(validateBaseUrl('http://api.openai.com/v1').code, 'URL_SCHEME');
  eq(validateBaseUrl('http://192.168.1.10:11434/v1').code, 'URL_SCHEME');
  eq(validateBaseUrl('ftp://example.com').code, 'URL_SCHEME');
  eq(validateBaseUrl('https://user:pw@example.com/v1').code, 'URL_CREDENTIALS');
  eq(validateBaseUrl('https://example.com/v1?key=abc').code, 'URL_INVALID');
  eq(validateBaseUrl('https://example.com/v1#x').code, 'URL_INVALID');
  eq(validateBaseUrl('not a url').code, 'URL_INVALID');
  eq(validateBaseUrl('').code, 'URL_EMPTY');
  eq(validateBaseUrl('https://example.com/' + 'a'.repeat(400)).code, 'URL_INVALID');
});

test('createAiNet: only the configured origin is reachable; redirects and cookies are disabled', async () => {
  const sent = [];
  let handler = null;
  const ses = {
    setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
    webRequest: { onBeforeRequest: (fn) => { handler = fn; } },
    fetch: (url, init) => { sent.push({ url, init }); return Promise.resolve({ ok: true }); },
  };
  let origin = 'https://api.example.com';
  const net = createAiNet({ ses, getOrigin: () => origin });
  await net.fetch('https://api.example.com/v1/chat/completions', { method: 'POST', headers: { a: 'b' } });
  eq(sent.length, 1);
  eq(sent[0].init.redirect, 'error'); eq(sent[0].init.credentials, 'omit'); eq(sent[0].init.method, 'POST');
  let blocked = false;
  await net.fetch('https://evil.example.org/x').catch(() => { blocked = true; });
  ok(blocked && sent.length === 1, 'a foreign origin must be blocked before anything is sent');
  await net.fetch('http://api.example.com/v1').catch(() => { blocked = 'http'; });
  eq(blocked, 'http');
  const verdict = (url) => { let r; handler({ url }, (x) => { r = x; }); return r.cancel; };
  eq(verdict('https://api.example.com/v1/x'), false);
  eq(verdict('https://api.example.com.evil.net/v1'), true);
  eq(verdict('wss://api.example.com/'), true);
  eq(verdict('file:///C:/secret.txt'), true);
  origin = '';
  eq(verdict('https://api.example.com/v1/x'), true, 'no configured origin means nothing is allowed');
});

test('settings: the ai section has safe defaults and never keeps unknown keys (no secret smuggling)', () => {
  const d = sanitize({});
  eq(d.ai.provider, 'builtin'); eq(d.ai.shareNames, true); eq(d.ai.model, ''); eq(d.ai.baseUrl, '');
  ok(!('keyFor' in d.ai), 'the key binding lives in the encrypted key record, not in settings.json');
  ok(!('keyFor' in sanitize({ ai: { keyFor: 'https://x.test' } }).ai), 'an old keyFor value is dropped');
  const s = sanitize({ ai: { provider: 'evil', baseUrl: 'https://x.test/v1\n', model: 'm'.repeat(500), apiKey: FAKE_KEY, token: 'x', shareNames: 0 } });
  eq(s.ai.provider, 'builtin', 'an unknown provider falls back to the default (the built-in model)');
  eq(s.ai.baseUrl, 'https://x.test/v1');
  eq(s.ai.model.length, 200);
  ok(!('apiKey' in s.ai) && !('token' in s.ai), 'unknown keys survived');
  ok(!JSON.stringify(s).includes(FAKE_KEY), 'secret in sanitized settings');
  eq(s.ai.shareNames, true);
  eq(sanitize({ ai: { shareNames: false } }).ai.shareNames, false);
  eq(sanitize({ ai: 'x' }).ai.provider, 'builtin', 'a non-object ai section falls back to defaults');
  eq(sanitize({ export: 5, window: 'x' }).window.width, DEFAULTS.window.width);
  eq(sanitize({ language: 'tr', ai: { provider: 'anthropic', model: 'claude' } }).ai.provider, 'anthropic');
});

test('settings (security review 3/11): unknown keys are dropped, the last-used folders must be local absolute folders, the page can only change its own few settings', () => {
  const s = sanitize({ evil: 'x'.repeat(10000), window: { width: 1000, height: 700, maximized: false, junk: 1 }, export: { quality: 'low', junk: 1 }, lastDirs: { open: '\\\\attacker\\share', project: 'C:\\Users\\x\\Documents', export: 'relative\\dir', other: 'C:\\x' } });
  ok(!('evil' in s), 'an unknown top-level key survived');
  ok(!('junk' in s.window) && !('junk' in s.export) && !('other' in s.lastDirs), 'unknown nested keys survived');
  eq(s.lastDirs.open, '', 'a network folder as the last-used folder would make Windows contact the share when a dialog opens');
  eq(s.lastDirs.project, 'C:\\Users\\x\\Documents');
  eq(s.lastDirs.export, '', 'a relative folder is not a folder to offer');
  const big = sanitize({ lastDirs: { open: 'C:\\' + 'a'.repeat(600) } });
  eq(big.lastDirs.open, '');
});

test('settings: the model folder must be a local, absolute folder (no network share, URL, device path or relative path)', () => {
  for (const bad of ['\\\\attacker\\share\\m', '//attacker/share/m', '..\\..\\Windows', 'https://x.test/m', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'models', 'C:rel', '\\\\?\\UNC\\attacker\\share']) {
    eq(sanitize({ llm: { modelDir: bad } }).llm.modelDir, '', 'kept: ' + bad);
  }
  eq(sanitize({ llm: { modelDir: 'D:\\Modeller\\ai' } }).llm.modelDir, 'D:\\Modeller\\ai');
  eq(sanitize({}).llm.modelDir, '');
});

// The IPC layer without Electron: a stub context collects the handlers.
function stubIpc(over) {
  const handlers = {};
  let settings = Object.assign({}, sanitize({ ai: { provider: 'local', model: 'm' } }));
  const ctx = Object.assign({
    handle: (ch, fn) => { handlers[ch] = fn; },
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    updateSettings: (patch) => { settings = sanitize(Object.assign({}, settings, { ai: Object.assign({}, settings.ai, patch.ai) })); return settings; },
    getMedia: (id) => (id.startsWith('m') ? { name: id + '.mp4', duration: 60, fps: 30, hasAudio: true, displayWidth: 1280, displayHeight: 720 } : null),
    send: () => {}, getLang: () => 'tr', userDataPath: fs.mkdtempSync(path.join(tmp, 'ud-')), safeStorage: fakeSafe(true),
    session: { fromPartition: () => { throw new Error('the network must not be touched in this test'); } },
    confirmEndpoint: async () => true, // the native "may the assistant's requests go to this address?" dialog: yes unless a test says otherwise
  }, over || {});
  const { registerAiIpc } = require('../src/main/ai/ipc');
  registerAiIpc(ctx);
  return { call: (ch, ...args) => handlers[ch]({}, ...args), ctx, userData: ctx.userDataPath };
}
const seg = (i, media) => ({ id: 's' + i, mediaId: media || 'm1', in: 0, out: 5, speed: 1, zoomFrom: 1, zoomTo: 1, fx: 0.5, fy: 0.5, volume: 1, mute: false, fadeIn: 0, fadeOut: 0 });

test('ai:run refuses a timeline that could not be passed on completely (its result replaces the whole timeline): nothing is sent', async () => {
  const ipc = stubIpc();
  eq((await ipc.call('ai:run', { prompt: 'x', snapshot: { segments: Array.from({ length: 501 }, (_, i) => seg(i)) } })).error.code, 'TOO_MANY_CLIPS');
  eq((await ipc.call('ai:run', { prompt: 'x', snapshot: { segments: [seg(1), seg(2, 'unknown-media'), seg(3)] } })).error.code, 'SNAPSHOT_INVALID', 'a clip whose media is unknown must not silently vanish');
  eq((await ipc.call('ai:run', { prompt: 'x', snapshot: { segments: [seg(1), { id: 5 }] } })).error.code, 'SNAPSHOT_INVALID');
  eq((await ipc.call('ai:run', { prompt: 'x', snapshot: { segments: [] } })).error.code, 'EMPTY_TIMELINE');
  eq((await ipc.call('ai:run', { prompt: 'x', snapshot: null })).error.code, 'EMPTY_TIMELINE');
  eq((await ipc.call('ai:run', { prompt: 'x' })).error.code, 'EMPTY_TIMELINE');
});

test('ai:save: the key is bound to the endpoint in the encrypted record; a new endpoint without a new key deletes it; Entra / delete clear it', async () => {
  const ipc = stubIpc();
  const KEY = FAKE_KEY;
  let r = await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: KEY });
  eq(r.ok, true); eq(r.status.hasKey, true); eq(r.status.keyMismatch, false); eq(r.status.ready, true);
  ok(!JSON.stringify(r).includes(KEY), 'the key must not appear in the reply');
  const file = path.join(ipc.userData, 'ai-key.json');
  ok(fs.existsSync(file));
  r = await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'other' });
  eq(r.keyCleared, false, 'same endpoint, no new key: the key stays'); eq(r.status.hasKey, true);
  r = await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm' });
  eq(r.keyCleared, true, 'another endpoint without a new key deletes the old key'); eq(r.status.hasKey, false); eq(r.status.needs, 'key');
  eq(fs.existsSync(file), false);
  r = await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: KEY });
  eq(r.status.ready, true);
  r = await ipc.call('ai:save', { provider: 'foundry', baseUrl: 'https://r.services.ai.azure.com/api/projects/p', model: 'd', auth: 'entra' });
  eq(r.status.credential, 'entra'); eq(r.status.hasKey, false, 'Entra ID keeps no key'); eq(fs.existsSync(file), false);
  await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: KEY });
  r = await ipc.call('ai:clear-key');
  eq(r.status.hasKey, false); eq(fs.existsSync(file), false);
});

test('Entra ID (security review 2): a token goes only to an endpoint the USER confirmed in a native dialog; declined = nothing saved, nothing remembered; an unconfirmed address in the settings never gets a token', async () => {
  const body = { provider: 'foundry', baseUrl: 'https://evil.example.org/api/projects/p', model: 'd', auth: 'entra' };
  const asked = [];
  const refused = stubIpc({ confirmEndpoint: async (origin, kind) => { asked.push(origin); eq(kind, 'entra'); return false; } });
  let r = await refused.call('ai:save', body);
  eq(r.ok, false); eq(r.error.code, 'ENTRA_NOT_CONFIRMED');
  same(asked, ['https://evil.example.org']);
  eq(refused.ctx.getSettings().ai.provider, 'local', 'the settings stay as they were');
  ok(!fs.existsSync(path.join(refused.userData, 'ai-entra-origins.json')), 'a refused address must not be remembered');

  const asked2 = [];
  const allowed = stubIpc({ confirmEndpoint: async (origin, kind) => { asked2.push(origin); eq(kind, 'entra'); return true; } });
  r = await allowed.call('ai:save', body);
  eq(r.ok, true); eq(r.status.credential, 'entra');
  r = await allowed.call('ai:save', Object.assign({}, body, { model: 'd2' }));
  eq(r.ok, true);
  same(asked2, ['https://evil.example.org'], 'the same address is asked only once');
  const list = JSON.parse(fs.readFileSync(path.join(allowed.userData, 'ai-entra-origins.json'), 'utf8')).origins;
  same(list, ['https://evil.example.org']);

  // another address is asked again
  r = await allowed.call('ai:save', Object.assign({}, body, { baseUrl: 'https://other.example.org/api/projects/p' }));
  eq(r.ok, true); eq(asked2.length, 2);

  // settings that were NOT saved through ai:save (hand-edited file, a script in the page that got a value into the settings): no request is made
  // and no token is asked for for an address that was not confirmed
  const sneaky = stubIpc({ confirmEndpoint: async () => false });
  sneaky.ctx.updateSettings({ ai: { provider: 'foundry', auth: 'entra', baseUrl: 'https://evil.example.org/api/projects/p', model: 'd' } });
  const t = await sneaky.call('ai:test');
  eq(t.ok, false); eq(t.error.code, 'ENTRA_NOT_CONFIRMED', JSON.stringify(t));
  const run = await sneaky.call('ai:run', { prompt: 'x', snapshot: { segments: [seg(1)] } });
  eq(run.ok, false); eq(run.error.code, 'ENTRA_NOT_CONFIRMED', JSON.stringify(run).slice(0, 200));
});

test('API-key providers (security review, second pass): the prompts and the key go only to the provider\'s own address, to this computer, or to an address the USER confirmed in a native dialog', async () => {
  const asked = [];
  const ipc = stubIpc({ confirmEndpoint: async (origin, kind) => { asked.push(kind + ' ' + origin); return true; } });
  // the provider's own well-known addresses and this computer: no question
  for (const body of [
    { provider: 'openai', baseUrl: '', model: 'm', apiKey: FAKE_KEY },
    { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: FAKE_KEY },
    { provider: 'anthropic', baseUrl: '', model: 'm', apiKey: FAKE_KEY },
    { provider: 'gemini', baseUrl: '', model: 'm', apiKey: FAKE_KEY },
    { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: FAKE_KEY },
    { provider: 'local', baseUrl: 'http://localhost:11434', model: 'm' },
  ]) eq((await ipc.call('ai:save', body)).ok, true, JSON.stringify(body));
  same(asked, [], 'no dialog for the provider\'s own address or this computer');

  // anything else is asked - once per address
  let r = await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: FAKE_KEY });
  eq(r.ok, true); same(asked, ['key https://gateway.example.com']);
  eq((await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm2', apiKey: FAKE_KEY })).ok, true);
  eq(asked.length, 1, 'the same address is asked only once');
  eq((await ipc.call('ai:save', { provider: 'azure', baseUrl: 'https://res.openai.azure.com', model: 'dep', apiKey: FAKE_KEY })).ok, true);
  eq(asked.length, 2, 'an Azure resource (anybody can create one under any name) is asked');
  eq((await ipc.call('ai:save', { provider: 'anthropic', baseUrl: 'https://api.openai.com', model: 'm', apiKey: FAKE_KEY })).ok, true);
  eq(asked.length, 3, 'the well-known address of ANOTHER provider is not "its own"');
  const list = JSON.parse(fs.readFileSync(path.join(ipc.userData, 'ai-endpoint-origins.json'), 'utf8')).origins;
  same(list, ['https://gateway.example.com', 'https://res.openai.azure.com', 'https://api.openai.com']);

  // declined: nothing is saved, nothing is remembered, the key is not stored
  const refused = stubIpc({ confirmEndpoint: async () => false });
  r = await refused.call('ai:save', { provider: 'openai', baseUrl: 'https://evil.example.org/v1', model: 'm', apiKey: FAKE_KEY });
  eq(r.ok, false); eq(r.error.code, 'ENDPOINT_NOT_CONFIRMED');
  eq(refused.ctx.getSettings().ai.provider, 'local', 'the settings stay as they were');
  ok(!fs.existsSync(path.join(refused.userData, 'ai-key.json')), 'the key must not be stored for an address that was refused');
  ok(!fs.existsSync(path.join(refused.userData, 'ai-endpoint-origins.json')), 'a refused address must not be remembered');
  // a context without the dialog (no way to ask) never confirms
  const mute = stubIpc({ confirmEndpoint: undefined });
  eq((await mute.call('ai:save', { provider: 'openai', baseUrl: 'https://evil.example.org/v1', model: 'm', apiKey: FAKE_KEY })).error.code, 'ENDPOINT_NOT_CONFIRMED');

  // only one dialog at a time: a script cannot pile them up
  let release; const gate = new Promise((res) => { release = res; });
  const slow = stubIpc({ confirmEndpoint: async () => { await gate; return true; } });
  const first = slow.call('ai:save', { provider: 'openai', baseUrl: 'https://one.example.org/v1', model: 'm', apiKey: FAKE_KEY });
  const second = await slow.call('ai:save', { provider: 'openai', baseUrl: 'https://two.example.org/v1', model: 'm', apiKey: FAKE_KEY });
  eq(second.ok, false); eq(second.error.code, 'BUSY');
  release();
  eq((await first).ok, true);

  // the two lists are separate: an address confirmed for a key is not confirmed for the Entra token, and the other way round
  const asked2 = [];
  const both = stubIpc({ confirmEndpoint: async (origin, kind) => { asked2.push(kind + ' ' + origin); return true; } });
  const foundry = 'https://r.services.ai.azure.com/api/projects/p';
  await both.call('ai:save', { provider: 'foundry', baseUrl: foundry, model: 'd', auth: 'entra' });
  await both.call('ai:save', { provider: 'foundry', baseUrl: foundry, model: 'd', apiKey: FAKE_KEY });
  same(asked2, ['entra https://r.services.ai.azure.com', 'key https://r.services.ai.azure.com']);

  // an upgrade: key and address were saved by an older version (nothing recorded as confirmed): the first use asks for the confirmation in the
  // settings and sends nothing (the test context has no network and would throw)
  const old = stubIpc();
  await old.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: FAKE_KEY });
  fs.rmSync(path.join(old.userData, 'ai-endpoint-origins.json'), { force: true });
  const upgraded = stubIpc({ userDataPath: old.userData, confirmEndpoint: async () => false });
  upgraded.ctx.updateSettings({ ai: { provider: 'openai', auth: 'key', baseUrl: 'https://gateway.example.com/v1', model: 'm' } });
  eq((await upgraded.call('ai:status')).ready, true, 'the saved key and address are in place');
  const t = await upgraded.call('ai:test');
  eq(t.ok, false); eq(t.error.code, 'ENDPOINT_NOT_CONFIRMED', JSON.stringify(t));
  const run = await upgraded.call('ai:run', { prompt: 'x', snapshot: { segments: [seg(1)] } });
  eq(run.ok, false); eq(run.error.code, 'ENDPOINT_NOT_CONFIRMED', JSON.stringify(run).slice(0, 200));
});

test('ai:save: a key is never stored without an endpoint to bind it to (Azure / Foundry have no default address)', async () => {
  const ipc = stubIpc();
  const file = path.join(ipc.userData, 'ai-key.json');
  for (const kind of ['azure', 'foundry']) {
    const r = await ipc.call('ai:save', { provider: kind, baseUrl: '', model: 'dep', apiKey: FAKE_KEY });
    eq(r.ok, false, kind); eq(r.error.code, 'URL_EMPTY', kind);
    eq(fs.existsSync(file), false, kind + ': nothing was written');
  }
  const good = await ipc.call('ai:save', { provider: 'azure', baseUrl: 'https://res.openai.azure.com', model: 'dep', apiKey: FAKE_KEY });
  eq(good.ok, true); eq(good.status.hasKey, true); eq(good.status.ready, true);
  ok(fs.existsSync(file));
});

test('ai:clear-key and the saves that have to remove a key report a key file that cannot be deleted - and then change no settings', async () => {
  const saved = () => ({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: FAKE_KEY });
  // the key file can neither be deleted nor overwritten: a non-empty directory sits in its place
  const lockFile = (ipc) => {
    const file = path.join(ipc.userData, 'ai-key.json');
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'x'), '1');
  };
  let ipc = stubIpc();
  eq((await ipc.call('ai:save', saved())).ok, true);
  lockFile(ipc);
  let r = await ipc.call('ai:clear-key');
  eq(r.ok, false); eq(r.error.code, 'KEY_DELETE_FAILED'); eq(r.status.hasKey, false, 'the key is not used any more in this session');

  ipc = stubIpc();
  await ipc.call('ai:save', saved());
  lockFile(ipc);
  r = await ipc.call('ai:save', { provider: 'foundry', baseUrl: 'https://r.services.ai.azure.com/api/projects/p', model: 'd', auth: 'entra' });
  eq(r.ok, false); eq(r.error.code, 'KEY_DELETE_FAILED');
  eq(ipc.ctx.getSettings().ai.provider, 'openai', 'switching to Entra ID did not happen: the settings stay as they were');

  ipc = stubIpc();
  await ipc.call('ai:save', saved());
  lockFile(ipc);
  r = await ipc.call('ai:save', { provider: 'openai', baseUrl: 'https://gateway.example.com/v1', model: 'm' });
  eq(r.ok, false); eq(r.error.code, 'KEY_DELETE_FAILED');
  eq(ipc.ctx.getSettings().ai.baseUrl, 'https://api.openai.com/v1', 'the endpoint was not changed either');
});

test('ai:save: a local model must be on this computer, with a clear reason for http://192.168.x.x and https://example.com', async () => {
  const ipc = stubIpc();
  for (const bad of ['http://192.168.1.20:11434/v1', 'https://example.com/v1', 'https://api.openai.com']) {
    eq((await ipc.call('ai:save', { provider: 'local', baseUrl: bad, model: 'm' })).error.code, 'URL_NOT_LOCAL', bad);
  }
  eq((await ipc.call('ai:save', { provider: 'local', baseUrl: 'ftp://localhost/x', model: 'm' })).error.code, 'URL_SCHEME', 'a bad scheme on a loopback host is a scheme problem');
  const ok1 = await ipc.call('ai:save', { provider: 'local', baseUrl: 'http://localhost:11434', model: 'qwen' });
  eq(ok1.status.baseUrl, 'http://localhost:11434/v1'); eq(ok1.status.ready, true); eq(ok1.status.credential, 'optional');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('PASS  ' + t.name); passed++; } catch (e) { console.log('FAIL  ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); failed++; }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n==== ai-net: ' + passed + '/' + (passed + failed) + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
