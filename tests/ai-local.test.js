'use strict';
// Tests of the optional AI providers' helpers: endpoint clean-up (Azure "Target URI", Foundry project endpoint, ...), the Azure CLI token
// source for Microsoft Entra ID sign-in (against a FAKE az.cmd), discovery of local model servers (mock servers on loopback) and the
// settings schema for the new providers.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeEndpoint } = require('../src/main/ai/endpoints');
const { createAzTokens, findAzCli, audiencesFor, AUDIENCES, SAFE_PATH_RE } = require('../src/main/ai/azcli');
const { discoverLocalServers, foundryCliPorts, findFoundryCli, parsePorts } = require('../src/main/ai/discover');
const { sanitize, AI_PROVIDERS, AI_AUTH } = require('../src/main/settings');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const OUT = path.join(__dirname, 'out', 'ai-local');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ endpoint clean-up */

test('endpoints: the Azure portal "Target URI" gives the resource address, the deployment name and the API version', () => {
  const r = normalizeEndpoint('azure', 'https://myres.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview', {});
  same(r, { url: 'https://myres.openai.azure.com', model: 'gpt-4o', apiVersion: '2025-01-01-preview' });
  const kept = normalizeEndpoint('azure', 'https://myres.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview', { model: 'mine', apiVersion: '2024-10-21' });
  same(kept, { url: 'https://myres.openai.azure.com', model: 'mine', apiVersion: '2024-10-21' }, 'values the user typed are never overwritten');
  same(normalizeEndpoint('azure', 'https://myres.openai.azure.com/openai/deployments/my%20dep/chat/completions', {}).model, 'my dep');
  same(normalizeEndpoint('azure', 'https://myres.openai.azure.com/openai', {}).url, 'https://myres.openai.azure.com');
  same(normalizeEndpoint('azure', 'https://myres.cognitiveservices.azure.com/', {}).url, 'https://myres.cognitiveservices.azure.com');
  same(normalizeEndpoint('azure', 'https://myres.openai.azure.com/openai/v1/', {}).url, 'https://myres.openai.azure.com/openai/v1');
  same(normalizeEndpoint('azure', 'https://myres.openai.azure.com/?foo=1#x', {}).url, 'https://myres.openai.azure.com');
});

test('endpoints: Foundry - project endpoint kept, full v1 URLs cut back to the v1 base, deployment picked up, no API version needed', () => {
  same(normalizeEndpoint('foundry', 'https://r.services.ai.azure.com/api/projects/p1', {}).url, 'https://r.services.ai.azure.com/api/projects/p1');
  same(normalizeEndpoint('foundry', 'https://r.services.ai.azure.com/api/projects/p1/', {}).url, 'https://r.services.ai.azure.com/api/projects/p1');
  same(normalizeEndpoint('foundry', 'https://r.openai.azure.com/openai/v1/chat/completions?api-version=preview', {}).url, 'https://r.openai.azure.com/openai/v1');
  same(normalizeEndpoint('foundry', 'https://r.services.ai.azure.com/api/projects/p1/openai/v1/responses', {}).url, 'https://r.services.ai.azure.com/api/projects/p1/openai/v1');
  const dep = normalizeEndpoint('foundry', 'https://r.openai.azure.com/openai/deployments/dsv3/chat/completions?api-version=2024-10-21', {});
  same(dep, { url: 'https://r.openai.azure.com', model: 'dsv3', apiVersion: '' }, 'api-version is an Azure OpenAI classic setting');
  same(normalizeEndpoint('foundry', 'https://r.services.ai.azure.com/models', {}).url, 'https://r.services.ai.azure.com/models');
});

test('endpoints: other providers - API paths are stripped, a local server gets /v1', () => {
  eq(normalizeEndpoint('openai', 'https://api.openai.com/v1/chat/completions', {}).url, 'https://api.openai.com/v1');
  eq(normalizeEndpoint('openai', 'https://openrouter.ai/api/v1/models/', {}).url, 'https://openrouter.ai/api/v1');
  eq(normalizeEndpoint('local', 'http://localhost:11434', {}).url, 'http://localhost:11434/v1');
  eq(normalizeEndpoint('local', 'http://127.0.0.1:1234/v1/chat/completions', {}).url, 'http://127.0.0.1:1234/v1');
  eq(normalizeEndpoint('local', 'http://127.0.0.1:8080/', {}).url, 'http://127.0.0.1:8080/v1');
  eq(normalizeEndpoint('anthropic', 'https://api.anthropic.com/v1/messages', {}).url, 'https://api.anthropic.com');
  eq(normalizeEndpoint('anthropic', 'https://api.anthropic.com/v1', {}).url, 'https://api.anthropic.com');
  eq(normalizeEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {}).url, 'https://generativelanguage.googleapis.com');
});

test('endpoints: empty, unparsable and dangerous input is returned untouched so that the strict URL policy can refuse it', () => {
  eq(normalizeEndpoint('foundry', '', {}).url, '');
  eq(normalizeEndpoint('foundry', '   ', {}).url, '');
  eq(normalizeEndpoint('foundry', 'not a url', {}).url, 'not a url');
  eq(normalizeEndpoint('foundry', 'ftp://example.com/openai/v1', {}).url, 'ftp://example.com/openai/v1');
  const creds = 'https://user:secret@r.openai.azure.com/openai/deployments/x/chat/completions';
  eq(normalizeEndpoint('azure', creds, {}).url, creds, 'credentials must reach the policy check, not be dropped silently');
  eq(normalizeEndpoint('openai', 'https://example.com/v1?key=1', {}).url, 'https://example.com/v1?key=1', 'a query on a non-Azure provider is still refused later');
});

/* ------------------------------------------------------------------ Azure CLI token source (fake az.cmd) */

const FAKE_TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJ0ZXN0LW5vdC1yZWFsIn0.c2lnbmF0dXJlLW5vdC1yZWFs';
const FAKE_DIR = path.join(OUT, 'fake az');
fs.mkdirSync(FAKE_DIR, { recursive: true });
const FAKE_AZ = path.join(FAKE_DIR, 'az.cmd');
const callsFile = path.join(FAKE_DIR, 'calls.log');
const marker = (name, on) => { const f = path.join(FAKE_DIR, 'mode-' + name); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split(/\r?\n/).filter(Boolean) : []);
const resetFake = () => { for (const m of ['login', 'fail', 'garbage', 'slow']) marker(m, false); fs.rmSync(callsFile, { force: true }); };
fs.writeFileSync(FAKE_AZ, [
  '@echo off',
  '>>"%~dp0calls.log" echo %*',
  'if exist "%~dp0mode-login" ( >&2 echo ERROR: Please run \'az login\' to setup account. & exit /b 1 )',
  'if exist "%~dp0mode-fail" ( >&2 echo ERROR: something else broke & exit /b 2 )',
  'if exist "%~dp0mode-garbage" ( echo not a token, has spaces!!! & exit /b 0 )',
  'if exist "%~dp0mode-slow" ( ping -n 8 127.0.0.1 >nul )',
  'echo ' + FAKE_TOKEN,
  '',
].join('\r\n'));

test('azcli: the fixed command runs through cmd.exe with a path containing spaces and returns the token; nothing else is passed', async () => {
  resetFake();
  const az = createAzTokens({ azPath: FAKE_AZ });
  ok(az.available(), 'the fake az must be found');
  const r = await az.getToken({ audience: AUDIENCES.foundry });
  ok(r.ok, JSON.stringify(r));
  eq(r.token, FAKE_TOKEN);
  same(calls(), ['account get-access-token --resource https://ai.azure.com --query accessToken --output tsv']);
  const r2 = await az.getToken({ audience: AUDIENCES.cognitive });
  ok(r2.ok);
  eq(calls()[1], 'account get-access-token --resource https://cognitiveservices.azure.com --query accessToken --output tsv');
});

test('azcli: tokens are cached for 10 minutes per audience, forgotten on request, and never reused after they expire', async () => {
  resetFake();
  let t = 1000000;
  const az = createAzTokens({ azPath: FAKE_AZ, now: () => t });
  await az.getToken({ audience: AUDIENCES.foundry });
  await az.getToken({ audience: AUDIENCES.foundry });
  eq(calls().length, 1, 'the second request must come from memory');
  az.forget(AUDIENCES.foundry);
  await az.getToken({ audience: AUDIENCES.foundry });
  eq(calls().length, 2, 'forget() drops the token');
  t += 10 * 60 * 1000 + 1;
  await az.getToken({ audience: AUDIENCES.foundry });
  eq(calls().length, 3, 'an expired cache entry is renewed');
  az.clear();
  await az.getToken({ audience: AUDIENCES.foundry });
  eq(calls().length, 4, 'clear() drops everything');
});

test('azcli: not signed in, any other failure, garbage output and a timeout/abort are told apart', async () => {
  resetFake();
  marker('login', true);
  let r = await createAzTokens({ azPath: FAKE_AZ }).getToken({ audience: AUDIENCES.foundry });
  eq(r.ok, false); eq(r.code, 'AZ_LOGIN'); ok(/az login/.test(r.detail), r.detail);
  resetFake();
  marker('fail', true);
  r = await createAzTokens({ azPath: FAKE_AZ }).getToken({ audience: AUDIENCES.foundry });
  eq(r.code, 'AZ_FAILED'); ok(/something else broke/.test(r.detail), r.detail);
  resetFake();
  marker('garbage', true);
  r = await createAzTokens({ azPath: FAKE_AZ }).getToken({ audience: AUDIENCES.foundry });
  eq(r.code, 'AZ_OUTPUT'); eq(r.detail, '');
  resetFake();
  marker('slow', true);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 400);
  const t0 = Date.now();
  r = await createAzTokens({ azPath: FAKE_AZ }).getToken({ audience: AUDIENCES.foundry, signal: ctl.signal });
  eq(r.code, 'ABORTED');
  ok(Date.now() - t0 < 4000, 'abort must not wait for az to finish');
  resetFake();
});

test('azcli: a missing az, an unsafe path and an unknown audience never run anything', async () => {
  resetFake();
  let ran = 0;
  const exec = () => { ran += 1; };
  for (const bad of ['C:\\x & calc\\az.cmd', 'C:\\x"y\\az.cmd', 'C:\\x%PATH%\\az.cmd', 'C:\\x^y\\az.cmd', 'relative\\az.cmd', 'C:\\x\\az.txt', 'C:\\x|y\\az.cmd']) {
    const az = createAzTokens({ azPath: bad, exec, exists: () => true }); // even if the file "exists", an unsafe path is refused
    eq(az.available(), false, bad);
    const r = await az.getToken({ audience: AUDIENCES.foundry });
    eq(r.code, 'AZ_NOT_FOUND', bad);
  }
  const missing = createAzTokens({ azPath: path.join(OUT, 'nowhere', 'az.cmd'), exec });
  eq(missing.available(), false, 'a safe path without a file');
  eq((await missing.getToken({ audience: AUDIENCES.foundry })).code, 'AZ_NOT_FOUND');
  const az = createAzTokens({ azPath: FAKE_AZ, exec });
  const r = await az.getToken({ audience: 'https://evil.example.com' });
  eq(r.ok, false);
  eq(ran, 0, 'no process may be started');
  ok(SAFE_PATH_RE.test(FAKE_AZ) && SAFE_PATH_RE.test('C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd'));
});

test('azcli: az is searched in the standard install folders ONLY (never in the PATH); Foundry and Azure OpenAI try their own audience first', () => {
  const root = path.join(OUT, 'pf');
  const wbin = path.join(root, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin');
  fs.mkdirSync(wbin, { recursive: true });
  fs.writeFileSync(path.join(wbin, 'az.cmd'), '@echo off\r\n');
  eq(findAzCli({ env: { ProgramFiles: root } }), path.join(wbin, 'az.cmd'));
  const bin2 = path.join(OUT, 'tools bin');
  fs.mkdirSync(bin2, { recursive: true });
  fs.writeFileSync(path.join(bin2, 'az.cmd'), '@echo off\r\n');
  eq(findAzCli({ env: { PATH: ['relative\\dir', '', bin2].join(path.delimiter) } }), '', 'an az.cmd in a PATH folder must NOT be used');
  eq(findAzCli({ env: { PATH: ['.', '..\\x'].join(path.delimiter) } }), '', 'relative PATH entries (the current folder!) are ignored');
  // Foundry Local: only the WindowsApps alias folder of the user
  const local = path.join(OUT, 'localappdata');
  const apps = path.join(local, 'Microsoft', 'WindowsApps');
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(path.join(apps, 'foundry.exe'), 'x');
  const planted = path.join(OUT, 'planted');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, 'foundry.exe'), 'x');
  eq(findFoundryCli({ LOCALAPPDATA: local, PATH: planted }), path.join(apps, 'foundry.exe'));
  eq(findFoundryCli({ PATH: planted }), '', 'a foundry.exe in a PATH folder must NOT be used');
  same(audiencesFor('foundry'), [AUDIENCES.foundry, AUDIENCES.cognitive]);
  same(audiencesFor('azure'), [AUDIENCES.cognitive, AUDIENCES.foundry]);
});

/* ------------------------------------------------------------------ local server discovery */

function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }) })));
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('discover: finds OpenAI-compatible servers and Foundry Local, ignores everything else (closed ports, web pages, huge answers)', async () => {
  const hits = [];
  const openai = await serve((req, res) => { hits.push(req.method + ' ' + req.url); if (req.url === '/v1/models') json(res, 200, { data: [{ id: 'm1' }, { id: 'm2' }, { object: 'x' }] }); else json(res, 404, {}); });
  const foundry = await serve((req, res) => {
    if (req.url === '/openai/status') json(res, 200, { Endpoints: ['http://localhost:5272'], ModelDirPath: 'C:\\models', PipeName: 'inference_agent' });
    else if (req.url === '/openai/models') json(res, 200, ['Phi-4-mini-instruct-generic-cpu', 'qwen2.5-0.5b-instruct-generic-cpu']);
    else json(res, 404, {});
  });
  const webpage = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); });
  const huge = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[' + '{"id":"x"},'.repeat(80000) + '{"id":"y"}]}'); });
  const closed = await serve((req, res) => res.end());
  const closedPort = closed.port;
  await closed.close();
  try {
    const found = await discoverLocalServers({ ports: [openai.port, foundry.port, webpage.port, huge.port, closedPort, 99999, -1, 1.5], timeoutMs: 1500 });
    eq(found.length, 2, JSON.stringify(found));
    const a = found.find((s) => s.url.includes(':' + openai.port));
    same(a, { name: 'OpenAI-compatible', url: 'http://127.0.0.1:' + openai.port + '/v1', models: ['m1', 'm2'] });
    const b = found.find((s) => s.url.includes(':' + foundry.port));
    same(b, { name: 'Foundry Local', url: 'http://127.0.0.1:' + foundry.port + '/v1', models: ['Phi-4-mini-instruct-generic-cpu', 'qwen2.5-0.5b-instruct-generic-cpu'] });
    ok(hits.every((h) => h.startsWith('GET ')), 'only GET requests: ' + hits.join(', '));
  } finally {
    await Promise.all([openai, foundry, webpage, huge].map((s) => s.close()));
  }
});

test('discover: Foundry Local 0.14 (/status, its whole catalogue at /v1/models) is recognised and left to its own settings option - it is not offered as a plain local server', async () => {
  const modern = await serve((req, res) => {
    if (req.url === '/status') json(res, 200, { artifact_qualified_model_management: true, endpoints: ['http://127.0.0.1:58943'], modelCachePath: 'C:\\m', pid: 5 });
    else if (req.url === '/v1/models') json(res, 200, { data: Array.from({ length: 101 }, (_, i) => ({ id: 'catalog-model-' + i + ':1' })) });
    else json(res, 404, {});
  });
  const other = await serve((req, res) => json(res, req.url === '/v1/models' ? 200 : 404, { data: [{ id: 'llama3' }] }));
  try {
    const found = await discoverLocalServers({ ports: [modern.port, other.port], timeoutMs: 1500 });
    same(found.map((f) => f.models), [['llama3']], 'only the other server is listed');
    const { probePort } = require('../src/main/ai/discover');
    const p = await probePort(modern.port, 1500);
    eq(p.foundry, true); eq(p.modern, true); same(p.models, []);
  } finally { await Promise.all([modern, other].map((s) => s.close())); }
});

test('discover: llama.cpp reports the model file as its id - only the file name is shown', async () => {
  const s = await serve((req, res) => json(res, req.url === '/v1/models' ? 200 : 404, { data: [{ id: 'C:\\Users\\me\\models\\qwen2.5-3b-instruct-q4_k_m.gguf' }, { id: '/home/u/m/phi-4-mini.gguf' }, { id: 'plain-name:7b' }] }));
  try {
    const found = await discoverLocalServers({ ports: [s.port], timeoutMs: 1500 });
    same(found[0].models, ['qwen2.5-3b-instruct-q4_k_m.gguf', 'phi-4-mini.gguf', 'plain-name:7b']);
  } finally { await s.close(); }
});

test('discover: a server that trickles bytes forever cannot hold the search (absolute deadline per request)', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const iv = setInterval(() => { try { res.write(' '); } catch (e) { clearInterval(iv); } }, 80);
    req.on('close', () => clearInterval(iv));
    res.on('close', () => clearInterval(iv));
  });
  try {
    const t0 = Date.now();
    same(await discoverLocalServers({ ports: [s.port], timeoutMs: 500 }), []);
    ok(Date.now() - t0 < 6000, 'the search took ' + (Date.now() - t0) + ' ms');
  } finally { await s.close(); }
});

test('discover: ports are read from the Foundry CLI status text (loopback only, >= 1024) and the CLI is only asked for its status', async () => {
  same(parsePorts('Foundry Local is running on http://127.0.0.1:41234/openai/status\nalso http://localhost:5273 and http://[::1]:7000/x'), [41234, 5273, 7000]);
  same(parsePorts('http://example.com:9999 http://127.0.0.1:80 http://127.0.0.1:70000 nothing'), [], 'foreign hosts and out-of-range ports are ignored');
  const seen = [];
  const fake = (file, args, opts, cb) => { seen.push({ file, args }); cb(null, 'Service: http://127.0.0.1:50321/\n', ''); };
  same(await foundryCliPorts({ cliPath: 'C:\\x\\foundry.exe', exec: fake }), [50321]);
  same(seen, [{ file: 'C:\\x\\foundry.exe', args: ['server', 'status'] }]);
  same(await foundryCliPorts({ cliPath: '' , exec: fake }), [], 'no CLI, no ports');
  same(await foundryCliPorts({ cliPath: 'C:\\x\\foundry.exe', exec: (f, a, o, cb) => cb(new Error('boom'), '', 'oops') }), [], 'a failing CLI is not an error');
});

/* ------------------------------------------------------------------ settings schema */

test('settings: the new providers are known; "auth" is key or entra, entra only for Azure OpenAI / Foundry; no secrets can be smuggled in', () => {
  same(AI_PROVIDERS, ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local', 'builtin', 'foundrylocal']);
  same(AI_AUTH, ['key', 'entra']);
  eq(sanitize({}).ai.auth, 'key');
  eq(sanitize({ ai: { provider: 'foundry', auth: 'entra' } }).ai.auth, 'entra');
  eq(sanitize({ ai: { provider: 'azure', auth: 'entra' } }).ai.auth, 'entra');
  eq(sanitize({ ai: { provider: 'openai', auth: 'entra' } }).ai.auth, 'key');
  eq(sanitize({ ai: { provider: 'local', auth: 'entra' } }).ai.auth, 'key');
  eq(sanitize({ ai: { provider: 'foundry', auth: 'password' } }).ai.auth, 'key');
  eq(sanitize({ ai: { provider: 'local' } }).ai.provider, 'local');
  eq(sanitize({ ai: { provider: 'builtin', auth: 'entra' } }).ai.auth, 'key');
  eq(sanitize({ ai: { provider: 'foundrylocal', auth: 'entra', model: 'qwen3.5-4b-generic-cpu:3' } }).ai.auth, 'key');
  eq(sanitize({ ai: { provider: 'foundrylocal', model: 'qwen3.5-4b-generic-cpu:3' } }).ai.provider, 'foundrylocal');
  eq(sanitize({ ai: { provider: 'nonsense' } }).ai.provider, 'builtin', 'an unknown provider falls back to the default (the built-in model)');
  const s = sanitize({ ai: { provider: 'foundry', apiKey: 'TEST_KEY_not_a_real_secret_0123456789', token: 'x', auth: 'entra' } });
  ok(!JSON.stringify(s).includes('TEST_KEY_not_a_real_secret'), 'a key in settings.json is dropped');
  ok(!('token' in s.ai) && !('apiKey' in s.ai));
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('PASS  ' + t.name); passed++; } catch (e) { console.log('FAIL  ' + t.name + '\n      ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')); failed++; }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('\n==== ai-local: ' + passed + '/' + (passed + failed) + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
