'use strict';
// Foundry Local (src/main/foundry): finding it (daemon.json, /status, the command line), the model list, download / load / start, the provider that loads the model
// on demand and restarts a crashed server, and the IPC handlers behind the settings panel. The program is replaced by a fake `run`, its server by a mock on loopback.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FL = require('../src/main/foundry/local');
const { registerFoundryIpc } = require('../src/main/foundry/ipc');
const { createProvider, AiError } = require('../src/main/ai/providers');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const OUT = path.join(__dirname, 'out', 'foundry-local');
fs.rmSync(OUT, { recursive: true, force: true });
const HOME = path.join(OUT, 'home');
const LOCAL = path.join(OUT, 'local');
fs.mkdirSync(path.join(HOME, '.foundry'), { recursive: true });
fs.mkdirSync(path.join(LOCAL, 'Microsoft', 'WindowsApps'), { recursive: true });
fs.writeFileSync(path.join(LOCAL, 'Microsoft', 'WindowsApps', 'foundry.exe'), '');
const ENV = { USERPROFILE: HOME, LOCALAPPDATA: LOCAL, PATH: '' };
const CLI = path.join(LOCAL, 'Microsoft', 'WindowsApps', 'foundry.exe');
const writeDaemon = (urls, pid) => fs.writeFileSync(path.join(HOME, '.foundry', 'daemon.json'), JSON.stringify({ pid, web_urls: urls, daemon_version: '0.14.0' }));
const noDaemon = () => fs.rmSync(path.join(HOME, '.foundry', 'daemon.json'), { force: true });

// a mock Foundry Local server: /status and whatever `extra(req, res)` handles
function fakeServer(pid, extra) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ endpoints: ['x'], modelCachePath: 'C:\\m', pid })); return; }
    if (extra && extra(req, res)) return;
    res.writeHead(404); res.end('no');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}

const MODELS_JSON = JSON.stringify({ models: [
  { alias: 'qwen2.5-1.5b', id: 'qwen2.5-1.5b-instruct-generic-gpu:4', displayName: 'qwen2.5-1.5b-instruct-generic-gpu', type: 'Chat', device: 'Gpu', fileSizeMb: 1546, cached: true, loaded: false, license: 'apache-2.0', supportsToolCalling: true },
  { alias: 'qwen3.5-4b', id: 'qwen3.5-4b-generic-gpu:4', displayName: 'qwen3.5-4b-generic-gpu', type: 'Multimodal', device: 'Gpu', fileSizeMb: 4185, cached: false, loaded: false, license: 'apache-2.0', supportsToolCalling: true },
  { alias: 'qwen3.5-4b', id: 'qwen3.5-4b-generic-cpu:3', displayName: 'qwen3.5-4b-generic-cpu', type: 'Multimodal', device: 'Cpu', fileSizeMb: 3085, cached: true, loaded: true, license: 'apache-2.0', supportsToolCalling: true },
  { alias: 'whisper-tiny', id: 'openai-whisper-tiny-generic-cpu:2', displayName: 'whisper', type: 'Speech', device: 'Cpu', fileSizeMb: 300, cached: false },
  { alias: 'bad', id: 'bad id; calc.exe', displayName: 'x', type: 'Chat', fileSizeMb: 1 },
  { alias: 'bad2', id: '--help', displayName: 'x', type: 'Chat', fileSizeMb: 1 },
  { alias: 'huge', id: 'huge-model:1', displayName: 'h'.repeat(5000), type: 'Chat', device: 'Npu', fileSizeMb: 'lots', cached: 'yes' },
  null, 7, 'x',
] });

// a fake command line: records the calls, answers by arguments. behaviour(args) -> { code, stdout, stderr, error }
function fakeRun(behaviour) {
  const calls = [];
  const run = async (cli, args, opts) => {
    calls.push({ cli, args: args.slice() });
    const r = await behaviour(args, opts || {}, calls);
    return Object.assign({ code: 0, stdout: '', stderr: '', error: '' }, r);
  };
  run.calls = calls;
  return run;
}
const make = (run, extra) => FL.createFoundryLocal(Object.assign({ env: ENV, run, pollMs: 5, freeMemMb: () => 4000, listenersOn: async () => null }, extra || {}));

/* ------------------------------------------------------------------ finding it */

test('parseDaemon: the literal loopback addresses with normal ports only; everything else is dropped (a name like localhost too)', () => {
  same(FL.parseDaemon(JSON.stringify({ pid: 7, web_urls: ['http://127.0.0.1:58943'], daemon_version: '0.14.0' })), { pid: 7, urls: ['http://127.0.0.1:58943'], version: '0.14.0' });
  same(FL.parseDaemon(JSON.stringify({ web_urls: ['http://localhost:5272/v1', 'http://[::1]:6000', 'http://127.0.0.1:58943', 'http://127.0.0.1:58943'] })).urls, ['http://[::1]:6000', 'http://127.0.0.1:58943']);
  eq(FL.parseDaemon(JSON.stringify({ web_urls: ['http://localhost:5272'] })), null, 'localhost alone -> nothing usable');
  eq(FL.parseDaemon(JSON.stringify({ web_urls: ['http://10.0.0.5:5000', 'https://127.0.0.1:5000', 'http://127.0.0.1:80', 'http://user:pw@127.0.0.1:5000', 'http://evil.example.com:5000', 'file:///c:/x', 'javascript:alert(1)', 5, null] })), null, 'nothing usable -> null');
  eq(FL.parseDaemon('not json'), null);
  eq(FL.parseDaemon(JSON.stringify({ pid: 1 })), null);
  eq(FL.parseDaemon(JSON.stringify({ web_urls: 'http://127.0.0.1:5000' })), null);
  eq(FL.parseDaemon('{"web_urls":["http://127.0.0.1:5000"],"x":"' + 'a'.repeat(70000) + '"}'), null, 'oversized file');
  eq(FL.parseDaemon(null), null);
});

test('findCli: only the user\'s WindowsApps alias folder; the PATH is not searched', () => {
  eq(FL.findCli(ENV), CLI);
  const planted = path.join(OUT, 'planted');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, 'foundry.exe'), '');
  eq(FL.findCli({ LOCALAPPDATA: path.join(OUT, 'nothing'), PATH: planted }), '', 'a foundry.exe in a PATH folder is not used');
  eq(FL.findCli({}), '');
});

test('findCli: the app-execution alias of the real Windows app is a reparse point - stat() fails with EACCES, lstat() sees it; a folder of that name is not a program', () => {
  const eacces = () => { const e = new Error('EACCES: permission denied, stat'); e.code = 'EACCES'; throw e; };
  const alias = { statSync: eacces, existsSync: () => false, lstatSync: () => ({ isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false }) };
  eq(FL.findCli(ENV, alias), CLI, 'found through lstat');
  eq(FL.findCli(ENV, { lstatSync: () => ({ isDirectory: () => true }) }), '', 'a folder named foundry.exe');
  eq(FL.findCli(ENV, { lstatSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }), '', 'nothing there');
});

test('status: running only when /status answers like Foundry Local and the process id matches (a file left by a crash does not count)', async () => {
  const s = await fakeServer(4242);
  try {
    writeDaemon([s.url], 4242);
    const st = await make(fakeRun(() => ({}))).status();
    eq(st.running, true); eq(st.installed, true); eq(st.url, s.url); eq(st.pid, 4242); eq(st.version, '0.14.0'); eq(st.freeMemMb, 4000);
    writeDaemon([s.url], 1111); // another process wrote the file
    eq((await make(fakeRun(() => ({}))).status()).running, false, 'pid mismatch');
    writeDaemon(['http://127.0.0.1:9'], 4242); // nobody listens (crash)
    const dead = await make(fakeRun(() => ({}))).status();
    eq(dead.running, false); eq(dead.installed, true, 'the command line is still there'); eq(dead.url, '');
    noDaemon();
    eq((await make(fakeRun(() => ({}))).status()).running, false);
    eq((await make(fakeRun(() => ({})), { cliPath: '' }).status()).installed, false, 'no command line, no server: not installed');
  } finally { await s.close(); }
});

test('status: the server has to be THE process of daemon.json: /status carries that process id (or the port is owned by it); a program that took over the port of a dead server is refused', async () => {
  const noPid = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ endpoints: ['x'], modelCachePath: 'C:\\m' })); });
  await new Promise((r) => noPid.listen(0, '127.0.0.1', r));
  const noPidUrl = 'http://127.0.0.1:' + noPid.address().port;
  const s = await fakeServer(4242);
  try {
    // an answer without a process id proves nothing by itself ...
    writeDaemon([noPidUrl], 4242);
    eq((await make(fakeRun(() => ({}))).status()).running, false, 'no pid in /status and netstat cannot tell');
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => [] }).status()).running, false, 'no pid in /status and nobody found on the port');
    // ... unless the owner of the port is the process of the file
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => [4242] }).status()).running, true, 'the owner of the port is the process of the file');
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => [999] }).status()).running, false, 'another program listens on the port');
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => [4242, 999] }).status()).running, false, 'a second listener next to the daemon');
    // the right process id in /status is contradicted by a foreign owner of the port
    writeDaemon([s.url], 4242);
    let asked = 0;
    eq((await make(fakeRun(() => ({})), { listenersOn: async (port) => { asked = port; return [4242]; } }).status()).running, true);
    eq(asked, Number(new URL(s.url).port), 'it asks about the port of the address it checks');
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => [999] }).status()).running, false, 'right pid in /status, but somebody else owns the port');
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => null }).status()).running, true, 'netstat cannot tell: the process id in /status stands');
    // a file without a process id is not believed
    fs.writeFileSync(path.join(HOME, '.foundry', 'daemon.json'), JSON.stringify({ web_urls: [s.url], daemon_version: '0.14.0' }));
    eq((await make(fakeRun(() => ({})), { listenersOn: async () => [4242] }).status()).running, false, 'daemon.json without a pid');
    // an impostor is "not running": Foundry Local is asked to start instead of the impostor being used
    writeDaemon([noPidUrl], 4242);
    const run = fakeRun(() => ({}));
    const ensured = await make(run, { listenersOn: async () => [999] }).ensureServer();
    ok(!ensured.ok && run.calls.some((c) => c.args.slice(0, 2).join(' ') === 'server start'), 'the impostor is not used: ' + JSON.stringify(ensured));
  } finally {
    noDaemon();
    await s.close();
    noPid.closeAllConnections();
    await new Promise((r) => noPid.close(r));
  }
});

test('status: a server that is not Foundry Local (a web page, JSON of another shape, a huge answer) is not taken for it', async () => {
  const other = await fakeServer(1, (req, res) => false);
  const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); });
  const huge = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":"' + 'x'.repeat(900000) + '"}'); });
  await Promise.all([page, huge].map((srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))));
  try {
    for (const srv of [page, huge]) {
      writeDaemon(['http://127.0.0.1:' + srv.address().port], 0);
      eq((await make(fakeRun(() => ({}))).status()).running, false);
    }
  } finally {
    noDaemon();
    await other.close();
    for (const srv of [page, huge]) { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  }
});

/* ------------------------------------------------------------------ the model list */

test('listModels: fixed arguments, clean entries (ids that could be an option or a command are dropped), kinds, cached first, recommended first, memory fit', async () => {
  const run = fakeRun(() => ({ stdout: MODELS_JSON }));
  const fl = make(run);
  const r = await fl.listModels({ catalog: true });
  eq(r.ok, true);
  same(run.calls[0], { cli: CLI, args: ['model', 'list', '-o', 'json'] });
  same(r.models.map((m) => m.id), ['qwen3.5-4b-generic-cpu:3', 'qwen2.5-1.5b-instruct-generic-gpu:4', 'qwen3.5-4b-generic-gpu:4', 'huge-model:1', 'openai-whisper-tiny-generic-cpu:2']);
  const cpu = r.models[0];
  eq(cpu.vision, true); eq(cpu.tools, true); eq(cpu.device, 'CPU'); eq(cpu.kind, 'multimodal'); eq(cpu.recommended, true); eq(cpu.cached, true); eq(cpu.sizeMb, 3085);
  eq(cpu.fits, false, '3085 MB * 1.3 > 4000 MB free: does not fit');
  eq(r.models[1].fits, true);
  eq(r.models[1].vision, false); eq(r.models[1].kind, 'chat');
  const huge = r.models.find((m) => m.id === 'huge-model:1');
  ok(huge.name.length <= 120, 'names are cut'); eq(huge.sizeMb, 0); eq(huge.cached, false, 'only a real true counts'); eq(huge.device, 'NPU');
  eq(r.models.find((m) => m.id.startsWith('openai-whisper')).kind, 'other', 'speech models are marked');
  eq(fl.info('qwen3.5-4b-generic-cpu:3').vision, true, 'the status of the assistant can ask whether a model sees pictures');
  eq(fl.info('nothing'), null);
  await fl.listModels({});
  same(run.calls[1].args, ['cache', 'list', '-o', 'json'], 'without the catalogue only what is on this computer');
});

test('listModels: no command line -> FL_NOT_INSTALLED; a failing command -> FL_CLI_FAILED; broken JSON -> an empty list', async () => {
  eq((await make(fakeRun(() => ({})), { cliPath: '' }).listModels({})).code, 'FL_NOT_INSTALLED');
  const failing = await make(fakeRun(() => ({ code: 1, stderr: 'boom ' + 'x'.repeat(2000) }))).listModels({});
  eq(failing.code, 'FL_CLI_FAILED'); ok(failing.detail.length <= 300);
  same((await make(fakeRun(() => ({ stdout: '{nope' }))).listModels({})).models, []);
  same((await make(fakeRun(() => ({ stdout: JSON.stringify({ models: 'x' }) }))).listModels({})).models, []);
});

test('parseModelList: at most 400 entries', () => {
  const many = { models: Array.from({ length: 1000 }, (_, i) => ({ alias: 'a' + i, id: 'model-' + i + ':1', type: 'Chat', fileSizeMb: 10 })) };
  eq(FL.parseModelList(JSON.stringify(many), 0).length, 400);
});

/* ------------------------------------------------------------------ download / load / unload / start */

test('download: progress lines become percentages; the model id is checked before anything is run; the failure codes', async () => {
  const run = fakeRun((args, opts) => {
    if (args[2] === 'qwen3.5-4b-generic-cpu:3') {
      for (const l of ['■ Downloading model (qwen3.5-4b-generic-cpu:3, 3.0 GB)', 'qwen3.5-4b-generic-cpu:3: 0%', 'qwen3.5-4b-generic-cpu:3: 25%', 'qwen3.5-4b-generic-cpu:3: 25%', 'qwen3.5-4b-generic-cpu:3: 99%', 'qwen3.5-4b-generic-cpu:3: 100%', '● success: Downloaded']) opts.onLine(l);
      return {};
    }
    return { code: 3, stdout: "● error: No model matching 'nosuch' was found in the catalog." };
  });
  const fl = make(run);
  const seen = [];
  const r = await fl.download('qwen3.5-4b-generic-cpu:3', { onProgress: (p) => seen.push(p.percent) });
  eq(r.ok, true);
  same(seen, [0, 25, 99, 100], 'every new percentage once');
  same(run.calls[0].args, ['model', 'download', 'qwen3.5-4b-generic-cpu:3']);
  eq((await fl.download('nosuch')).code, 'FL_BAD_MODEL');
  const before = run.calls.length;
  for (const bad of ['', '--force', 'a b', 'x;y', '../x', 'a'.repeat(200), null, 5, 'a&b']) eq((await fl.download(bad)).code, 'FL_BAD_MODEL', JSON.stringify(bad));
  eq(run.calls.length, before, 'no command was started for a bad id');
  eq((await make(fakeRun(() => ({ code: 1, stdout: 'network down' }))).download('some-model:1')).code, 'FL_DOWNLOAD_FAILED');
  eq((await make(fakeRun(() => ({ error: 'ABORTED' }))).download('some-model:1')).code, 'FL_ABORTED');
});

test('load / unload: fixed arguments, the failure codes (not downloaded, unknown, memory)', async () => {
  const run = fakeRun((args) => (args[1] === 'load' ? { code: 0 } : { code: 0 }));
  const fl = make(run);
  eq((await fl.load('m:1')).ok, true);
  same(run.calls[0].args, ['model', 'load', 'm:1']);
  eq((await fl.unload('m:1')).ok, true);
  same(run.calls[1].args, ['model', 'unload', 'm:1']);
  eq((await make(fakeRun(() => ({ code: 3, stdout: "No model matching 'x' was found" }))).load('x:1')).code, 'FL_BAD_MODEL');
  eq((await make(fakeRun(() => ({ code: 1, stderr: 'model is not downloaded' }))).load('x:1')).code, 'FL_NOT_DOWNLOADED');
  eq((await make(fakeRun(() => ({ code: 1, stderr: 'out of memory' }))).load('x:1')).code, 'FL_LOAD_FAILED');
  eq((await fl.load('--x')).code, 'FL_BAD_MODEL');
  eq((await fl.unload('a b')).code, 'FL_BAD_MODEL');
});

test('ensureServer: nothing to do when it runs; the command line starts it when it does not (the new port is read from daemon.json); not installed / not started are told apart', async () => {
  const s = await fakeServer(777);
  try {
    writeDaemon([s.url], 777);
    const run = fakeRun(() => ({}));
    const fl = make(run);
    same(await fl.ensureServer(), { ok: true, url: s.url });
    eq(run.calls.length, 0, 'a running server is not started again');
    noDaemon();
    const startRun = fakeRun((args) => { if (args[0] === 'server') writeDaemon([s.url], 777); return {}; });
    same(await make(startRun).ensureServer(), { ok: true, url: s.url });
    same(startRun.calls[0].args, ['server', 'start', '--idle-timeout', String(FL.IDLE_TIMEOUT_MINUTES)]);
    noDaemon();
    eq((await make(fakeRun(() => ({})), { cliPath: '' }).ensureServer()).code, 'FL_NOT_INSTALLED');
    const never = await make(fakeRun(() => ({ code: 1, stderr: 'cannot bind' }))).ensureServer();
    eq(never.code, 'FL_START_FAILED'); eq(never.detail, 'cannot bind');
    // two callers at once start it once
    noDaemon();
    let starts = 0;
    const slow = fakeRun(async (args) => { starts++; await new Promise((r) => setTimeout(r, 30)); writeDaemon([s.url], 777); return {}; });
    const f2 = make(slow);
    const both = await Promise.all([f2.ensureServer(), f2.ensureServer()]);
    eq(starts, 1); ok(both.every((x) => x.ok));
  } finally { noDaemon(); await s.close(); }
});

/* ------------------------------------------------------------------ the provider of the assistant */

const loadedErr = () => new AiError('BAD_REQUEST', 'The provider rejected the request (HTTP 400)', { status: 400, detail: "Model not loaded: Model 'x' must be loaded before inference" });

test('createFoundryProvider: a model that is not loaded is loaded, then the request is repeated', async () => {
  const loads = [];
  const phases = [];
  let calls = 0;
  const inner = { chat: async () => { calls++; if (calls === 1) throw loadedErr(); return { text: 'hi', toolCalls: [] }; }, listModels: async () => ['a'], toolsEmulated: () => true };
  const p = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build: () => inner, fl: { load: async (id) => { loads.push(id); return { ok: true }; }, ensureServer: async () => ({ ok: false }) }, onPhase: (x) => phases.push(x) });
  eq((await p.chat({})).text, 'hi');
  same(loads, ['x:1']); same(phases, ['loading']); eq(calls, 2); eq(p.toolsEmulated(), true); eq(p.kind, 'local');
});

test('createFoundryProvider: a server that is gone is started again (its address changes) and the request is repeated, at most twice per run', async () => {
  const built = [];
  const phases = [];
  const urls = [];
  let n = 0;
  const net = () => new AiError('NETWORK', 'Network error', { detail: 'fetch failed' });
  const build = (url) => { built.push(url); return { chat: async () => { n++; if (url === 'http://127.0.0.1:5000' || n === 99) throw net(); return { text: 'back at ' + url, toolCalls: [] }; } }; };
  const p = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build, fl: { load: async () => ({ ok: true }), ensureServer: async () => ({ ok: true, url: 'http://127.0.0.1:6000' }) }, onPhase: (x) => phases.push(x), onUrl: (u) => urls.push(u) });
  eq((await p.chat({})).text, 'back at http://127.0.0.1:6000');
  same(built, ['http://127.0.0.1:5000', 'http://127.0.0.1:6000']); same(urls, ['http://127.0.0.1:6000']); same(phases, ['starting', 'loading']);
  // a server that keeps disappearing: two restarts, then the error
  let restarts = 0;
  const always = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build: () => ({ chat: async () => { throw net(); } }), fl: { load: async () => ({ ok: true }), ensureServer: async () => { restarts++; return { ok: true, url: 'http://127.0.0.1:7000' }; } } });
  let err = null;
  try { await always.chat({}); } catch (e) { err = e; }
  ok(err && err.code === 'NETWORK', 'the network error is reported after the restarts: ' + (err && err.code));
  eq(restarts, 2);
});

test('createFoundryProvider: other errors pass through untouched; a model that cannot be loaded or a server that cannot be started is a FoundryError with its code; aborting is not retried', async () => {
  const bad = new AiError('AUTH', 'no', { status: 401 });
  const p1 = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build: () => ({ chat: async () => { throw bad; } }), fl: {} });
  let e1 = null; try { await p1.chat({}); } catch (e) { e1 = e; }
  eq(e1, bad);
  const p2 = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build: () => ({ chat: async () => { throw loadedErr(); } }), fl: { load: async () => ({ ok: false, code: 'FL_LOAD_FAILED', detail: 'oom' }) } });
  let e2 = null; try { await p2.chat({}); } catch (e) { e2 = e; }
  eq(e2.name, 'FoundryError'); eq(e2.code, 'FL_LOAD_FAILED'); eq(e2.detail, 'oom');
  const p3 = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build: () => ({ chat: async () => { throw new AiError('NETWORK', 'n'); } }), fl: { ensureServer: async () => ({ ok: false, code: 'FL_START_FAILED' }) } });
  let e3 = null; try { await p3.chat({}); } catch (e) { e3 = e; }
  eq(e3.code, 'FL_START_FAILED');
  let calls = 0;
  const p4 = FL.createFoundryProvider({ model: 'x:1', url: 'http://127.0.0.1:5000', build: () => ({ chat: async () => { calls++; throw new AiError('ABORTED', 'Cancelled'); } }), fl: { ensureServer: async () => ({ ok: true, url: 'u' }), load: async () => ({ ok: true }) } });
  try { await p4.chat({}); } catch (e) { /* expected */ }
  eq(calls, 1);
});

test('end to end with a real provider on a mock server: "not loaded" -> load -> the request goes through', async () => {
  let loaded = false;
  const s = await fakeServer(5, (req, res) => {
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        if (!loaded) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: "Model not loaded: Model 'x:1' must be loaded before inference", type: 'invalid_request_error' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
      });
      return true;
    }
    return false;
  });
  try {
    const p = FL.createFoundryProvider({
      model: 'x:1', url: s.url,
      build: (url) => createProvider({ kind: 'local', baseUrl: url + '/v1', model: 'x:1', apiKey: '', fetch: globalThis.fetch, flavor: 'foundry', sleep: () => Promise.resolve() }),
      fl: { load: async () => { loaded = true; return { ok: true }; }, ensureServer: async () => ({ ok: false }) },
    });
    eq((await p.chat({ system: 's', messages: [{ role: 'user', content: 'ping' }], tools: [] })).text, 'OK');
    eq(loaded, true);
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------ the IPC behind the settings panel */

function fakeCtx(client) {
  const handlers = new Map();
  const sent = [];
  const opened = [];
  const ctx = { handle: (ch, fn) => handlers.set(ch, fn), send: (ch, payload) => sent.push([ch, payload]), openExternal: async (u) => { opened.push(u); }, client };
  registerFoundryIpc(ctx);
  return { call: (ch, ...args) => handlers.get(ch)({}, ...args), sent, opened, handlers };
}

test('ipc: status carries the links and the memory; models need the command line; the page cannot start anything but these jobs', async () => {
  const s = await fakeServer(9);
  try {
    writeDaemon([s.url], 9);
    const client = make(fakeRun(() => ({ stdout: MODELS_JSON })));
    const c = fakeCtx(client);
    const st = await c.call('fl:status');
    eq(st.ok, true); eq(st.status.running, true); eq(st.status.links.install, 'https://aka.ms/foundry-local-installer'); eq(st.status.installCommand, 'winget install Microsoft.FoundryLocal'); ok(st.status.totalMemMb > 0);
    const m = await c.call('fl:models', { catalog: true });
    eq(m.ok, true); ok(m.models.length >= 3);
    const none = fakeCtx(make(fakeRun(() => ({})), { cliPath: '' }));
    noDaemon();
    eq((await none.call('fl:models', {})).error.code, 'FL_NOT_INSTALLED');
  } finally { noDaemon(); await s.close(); }
});

test('ipc: open-link opens exactly the three official addresses and nothing else', async () => {
  const c = fakeCtx(make(fakeRun(() => ({}))));
  eq(await c.call('fl:open-link', { key: 'install' }), true);
  eq(await c.call('fl:open-link', { key: 'docs' }), true);
  eq(await c.call('fl:open-link', { key: 'repo' }), true);
  same(c.opened, ['https://aka.ms/foundry-local-installer', 'https://learn.microsoft.com/azure/foundry-local/get-started', 'https://github.com/microsoft/Foundry-Local']);
  for (const key of ['https://evil.example.com', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, 5, { toString() { return 'install'; } }]) eq(await c.call('fl:open-link', { key }), false, JSON.stringify(key));
  eq(await c.call('fl:open-link', null), false);
  eq(c.opened.length, 3);
});

test('ipc: download reports progress, takes one job at a time, can be cancelled, and refuses a bad id', async () => {
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const run = fakeRun(async (args, opts) => {
    if (args[1] === 'download') {
      opts.onLine('m:1: 40%');
      await Promise.race([gate, new Promise((r) => { if (opts.signal) opts.signal.addEventListener('abort', r, { once: true }); })]);
      return opts.signal && opts.signal.aborted ? { error: 'ABORTED' } : {};
    }
    return {};
  });
  const c = fakeCtx(make(run));
  eq((await c.call('fl:download', { id: '--x' })).error.code, 'FL_BAD_MODEL');
  eq((await c.call('fl:download', null)).error.code, 'FL_BAD_MODEL');
  const first = c.call('fl:download', { id: 'm:1' });
  await new Promise((r) => setTimeout(r, 20));
  eq((await c.call('fl:download', { id: 'm:2' })).error.code, 'FL_BUSY', 'one job at a time');
  eq((await c.call('fl:load', { id: 'm:2' })).error.code, 'FL_BUSY');
  const busy = (await c.call('fl:status')).status;
  eq(busy.busy, 'download'); eq(busy.busyId, 'm:1');
  await c.call('fl:cancel');
  eq((await first).error.code, 'FL_ABORTED');
  const phases = c.sent.filter((x) => x[0] === 'fl:progress').map((x) => x[1].phase + (x[1].percent !== undefined ? ':' + x[1].percent : ''));
  same(phases.slice(0, 3), ['start', 'progress:40', 'end']);
  release();
  eq((await c.call('fl:download', { id: 'm:1' })).ok, true, 'the job slot is free again');
});

test('ipc: load starts the server first; unload and load validate the id', async () => {
  const s = await fakeServer(11);
  try {
    noDaemon();
    const run = fakeRun((args) => { if (args[0] === 'server') writeDaemon([s.url], 11); return {}; });
    const c = fakeCtx(make(run));
    eq((await c.call('fl:load', { id: 'qwen3.5-4b-generic-cpu:3' })).ok, true);
    same(run.calls.map((x) => x.args.slice(0, 2).join(' ')), ['server start', 'model load']);
    eq((await c.call('fl:unload', { id: 'a b' })).error.code, 'FL_BAD_MODEL');
    eq((await c.call('fl:unload', { id: 'qwen3.5-4b-generic-cpu:3' })).ok, true);
  } finally { noDaemon(); await s.close(); }
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('PASS  ' + t.name); passed++; } catch (e) { console.log('FAIL  ' + t.name + '\n      ' + String(e.stack || e.message).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n==== foundry-local: ' + passed + '/' + (passed + failed) + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
