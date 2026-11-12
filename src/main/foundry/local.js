'use strict';
/*
 * Foundry Local (Microsoft's runtime for models on this computer) as the main process sees it: is it installed, is its server running and where, which models can be
 * used, download / load / unload a model, and the provider the assistant talks to it through.
 *
 * How it is reached (Foundry Local 0.14, checked against the real program):
 *   - The server is OpenAI-compatible (http://127.0.0.1:<port>/v1) but its port is dynamic. It is written to %USERPROFILE%\.foundry\daemon.json and answers GET /status.
 *     The file survives a crash of the server, so what it says is only believed after /status answered (with the same process id).
 *   - Models are managed ONLY through the command line (`foundry model list|download|load|unload -o json`, `foundry server start`): the server has no REST route for it, and it
 *     does not load a model on demand (a chat request for a model that is not loaded gets HTTP 400 "must be loaded before inference").
 *   - Its server sends no CORS headers: a web page can never reach it. Only this program (main process, no browser involved) can.
 *
 * Safety: the command line is the program the Windows app-execution alias points to in the USER's folder (the PATH is not searched), it is started without a shell and with
 * fixed arguments; the only variable argument is a model id that matches MODEL_ID_RE. Everything it prints or answers is untrusted text: sizes are capped, JSON is parsed
 * defensively, strings are cut. Only loopback addresses are accepted from daemon.json. The model download is done by Foundry Local itself (from Microsoft's catalogue) and
 * only when the user asks for it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { listenersOn } = require('../llm/server');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// what daemon.json may name: the literal loopback addresses (a name like "localhost" is resolved by something else)
const DAEMON_HOSTS = new Set(['127.0.0.1', '[::1]']);
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_JSON = 512 * 1024;
const MAX_CLI_OUTPUT = 4 * 1024 * 1024;
const MAX_MODELS = 400;
const STATUS_TIMEOUT_MS = 2500;
const START_TIMEOUT_MS = 4 * 60 * 1000;
const LIST_TIMEOUT_MS = 3 * 60 * 1000;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
// A server that THIS app started stops by itself after this many minutes without a request (Foundry Local's own option `--idle-timeout`): the memory of the model comes back
// and a server that takes no key is not left running for days. A server that the person started themselves is never touched.
const IDLE_TIMEOUT_MINUTES = 30;

// Where the person gets Foundry Local (official addresses only; the page can ask main to open exactly these).
const LINKS = {
  install: 'https://aka.ms/foundry-local-installer',
  docs: 'https://learn.microsoft.com/azure/foundry-local/get-started',
  repo: 'https://github.com/microsoft/Foundry-Local',
};
const INSTALL_COMMAND = 'winget install Microsoft.FoundryLocal';
// What suits a video assistant best (it has to look at pictures and follow tool instructions): shown first, with a hint.
const PREFERRED = ['qwen3.5-4b', 'qwen3.5-2b', 'qwen3.5-0.8b', 'qwen3-vl-4b-instruct', 'qwen3-vl-2b-instruct'];

class FoundryError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'FoundryError';
    this.code = code;
    this.detail = detail || '';
  }
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* ------------------------------------------------------------------ finding it */

// The command line is an app-execution alias in the user's WindowsApps folder; the folders of the PATH are NOT searched (a program that another user could plant in a shared
// tools folder would be run when the person presses a button). The alias is a reparse point that stat() cannot open (EACCES) and existsSync() calls missing: lstat sees it.
function findCli(env, fsApi) {
  const e = env || process.env;
  const f = fsApi || fs;
  const dirs = [];
  if (e.LOCALAPPDATA) dirs.push(path.join(e.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
  for (const d of dirs) {
    const p = path.join(d, 'foundry.exe');
    try { if (!f.lstatSync(p).isDirectory()) return p; } catch (err) { /* next */ }
  }
  return '';
}

function daemonFile(env) {
  const e = env || process.env;
  return path.join(e.USERPROFILE || os.homedir(), '.foundry', 'daemon.json');
}

// "http://127.0.0.1:58943" -> the origin, only for a loopback host (hosts: the accepted names) and a normal port
function loopbackOrigin(value, hosts) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'http:' || !(hosts || LOCAL_HOSTS).has(u.hostname) || u.username || u.password) return '';
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return '';
    return u.origin;
  } catch (e) {
    return '';
  }
}

// daemon.json -> { pid, urls[], version } or null
function parseDaemon(text) {
  if (typeof text !== 'string' || text.length > 64 * 1024) return null;
  let j;
  try { j = JSON.parse(text); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.web_urls)) return null;
  const urls = [];
  for (const u of j.web_urls.slice(0, 8)) { const o = loopbackOrigin(u, DAEMON_HOSTS); if (o && !urls.includes(o)) urls.push(o); }
  if (!urls.length) return null;
  return { pid: Number.isInteger(j.pid) ? j.pid : 0, urls, version: clean(j.daemon_version, 32) };
}

function readDaemon(env) {
  try {
    const f = daemonFile(env);
    if (fs.statSync(f).size > 64 * 1024) return null;
    return parseDaemon(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null;
  }
}

// GET <origin><path> -> parsed JSON or null. Loopback only (the caller passes a checked origin), a size cap and a hard time limit.
function getJson(origin, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let hard = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(hard); resolve(v); } };
    let u;
    try { u = new URL(origin); } catch (e) { finish(null); return; }
    const req = http.get({ host: u.hostname === '[::1]' ? '::1' : u.hostname, port: u.port, path: urlPath, timeout: timeoutMs, headers: { accept: 'application/json' }, agent: false }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(null); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_JSON) { req.destroy(); finish(null); } else chunks.push(c); });
      res.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(null); } });
      res.on('error', () => finish(null));
    });
    hard = setTimeout(() => { req.destroy(); finish(null); }, Math.max(timeoutMs * 2, 2000));
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

const isStatusShape = (s) => !!s && typeof s === 'object' && (Array.isArray(s.endpoints) || typeof s.modelCachePath === 'string');

/* ------------------------------------------------------------------ the command line */

// Runs the command line: { code, stdout, stderr, error: ''|'TIMEOUT'|'ABORTED'|'SPAWN' }. onLine(text) gets the lines of stdout while it runs (progress).
function defaultRun(cli, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli, args, { windowsHide: true, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: o.env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: clean(e && e.message, 200), error: 'SPAWN' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let carry = '';
    let error = '';
    const stop = (why) => { error = error || why; try { child.kill(); } catch (e) { /* already gone */ } };
    const timer = setTimeout(() => stop('TIMEOUT'), o.timeoutMs > 0 ? o.timeoutMs : 60000);
    const onAbort = () => stop('ABORTED');
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    const finish = (code) => {
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, error });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CLI_OUTPUT) stdout += chunk;
      if (typeof o.onLine === 'function') {
        carry += chunk;
        const parts = carry.split(/[\r\n]+/);
        carry = parts.pop().slice(-500);
        for (const line of parts) if (line) o.onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on('error', (e) => { stderr += clean(e && e.message, 200); error = error || 'SPAWN'; finish(-1); });
    child.on('close', (code) => { if (typeof o.onLine === 'function' && carry) o.onLine(carry); finish(code == null ? -1 : code); });
  });
}

// the model list of `foundry cache list -o json` / `foundry model list -o json` -> clean entries
function parseModelList(text, freeMb) {
  let j;
  try { j = JSON.parse(String(text || '').slice(0, 4 * 1024 * 1024)); } catch (e) { return []; }
  const list = j && Array.isArray(j.models) ? j.models : [];
  const out = [];
  for (const m of list.slice(0, MAX_MODELS)) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) continue;
    const alias = clean(m.alias, 80);
    const sizeMb = Number.isFinite(m.fileSizeMb) && m.fileSizeMb > 0 && m.fileSizeMb < 1e7 ? Math.round(m.fileSizeMb) : 0;
    const device = /^gpu$/i.test(m.device) ? 'GPU' : (/^npu$/i.test(m.device) ? 'NPU' : (/^cpu$/i.test(m.device) ? 'CPU' : ''));
    const typeName = clean(m.type, 20).toLowerCase();
    out.push({
      id: m.id,
      alias,
      name: clean(m.displayName || m.id, 120),
      device,
      sizeMb,
      // 'chat' / 'multimodal' models can be used by the assistant; speech, embedding and unknown types are listed by Foundry Local too
      kind: typeName === 'chat' || typeName === 'multimodal' ? typeName : 'other',
      cached: m.cached === true,
      // (Foundry Local reports "loaded" per alias, not per variant: it is only a hint, the assistant loads the exact model it needs)
      loaded: m.loaded === true,
      // pictures: the catalogue says "Multimodal" for the models that take them
      vision: typeName === 'multimodal',
      tools: m.supportsToolCalling === true,
      license: clean(m.license, 40),
      recommended: PREFERRED.includes(alias),
      fits: freeMb > 0 && sizeMb > 0 ? sizeMb * 1.3 < freeMb : null,
    });
  }
  return out;
}

const rank = (m) => {
  const i = PREFERRED.indexOf(m.alias);
  return [m.cached ? 0 : 1, i < 0 ? 99 : i, m.vision ? 0 : 1, m.alias, m.device];
};
function sortModels(models) {
  return models.slice().sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; }
    return 0;
  });
}

/* ------------------------------------------------------------------ the client */

// opts: { env?, cliPath?, run?(cli, args, { timeoutMs, signal, onLine }) -> Promise<{code,stdout,stderr,error}>, getJson?(origin, path, timeoutMs), freeMemMb?(), log? } (all but env: tests)
function createFoundryLocal(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const run = o.run || defaultRun;
  const probe = o.getJson || getJson;
  const freeMb = o.freeMemMb || (() => Math.round(os.freemem() / (1024 * 1024)));
  const log = typeof o.log === 'function' ? o.log : () => {};
  const listeners = o.listenersOn || listenersOn;
  const known = new Map(); // model id -> entry of the last list (the status of the assistant needs to know whether the model sees pictures)
  let startPromise = null;

  const cliPath = () => (o.cliPath !== undefined ? o.cliPath : findCli(env));

  // Is the server there? Reads daemon.json and asks /status (a file left behind by a crash does not count).
  // The server has no key, so whatever answers on the port is handed the prompts and the pictures of the video: it has to be THE process the file names. The process id in
  // /status and the owner of the port (netstat) are two independent proofs; one of them has to confirm it and neither may contradict it (a program that grabbed the
  // port of a crashed server, or one that answers without a process id, is not accepted). A file without a process id is not believed at all.
  async function status() {
    const cli = cliPath();
    const d = readDaemon(env);
    let running = false;
    let url = '';
    let pid = 0;
    if (d && d.pid) {
      for (const u of d.urls) {
        const s = await probe(u, '/status', STATUS_TIMEOUT_MS);
        if (!isStatusShape(s)) continue;
        if (s.pid !== undefined && s.pid !== d.pid) continue;
        const owners = await listeners(Number(new URL(u).port));
        const ownerKnown = Array.isArray(owners) && owners.length > 0;
        if (ownerKnown && owners.some((p) => p !== d.pid)) continue; // somebody else listens there too (a second listener may get the connections)
        if (s.pid !== d.pid && !ownerKnown) continue;
        running = true; url = u; pid = d.pid; break;
      }
    }
    return { installed: !!cli || running, cliFound: !!cli, running, url, pid, version: d ? d.version : '', freeMemMb: freeMb() };
  }

  // Starts the server (the command line does it; the first start of a new installation also fetches the execution providers: minutes).
  function start(sopts) {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const cli = cliPath();
      if (!cli) return { ok: false, code: 'FL_NOT_INSTALLED' };
      const r = await run(cli, ['server', 'start', '--idle-timeout', String(IDLE_TIMEOUT_MINUTES)], { timeoutMs: START_TIMEOUT_MS, signal: sopts && sopts.signal });
      if (r.error === 'ABORTED') return { ok: false, code: 'FL_ABORTED' };
      // the command may report before the discovery file is written: look for it for a few seconds
      for (let i = 0; i < 20; i++) {
        const s = await status();
        if (s.running) return { ok: true, url: s.url };
        await new Promise((resolve) => setTimeout(resolve, o.pollMs >= 0 ? o.pollMs : 500));
      }
      log('foundry server start: ' + clean(r.stdout + ' ' + r.stderr, 300));
      return { ok: false, code: 'FL_START_FAILED', detail: clean(r.stderr || r.stdout, 300) };
    })().finally(() => { startPromise = null; });
    return startPromise;
  }

  // The server is running, or is started: { ok, url } | { ok:false, code }
  async function ensureServer(sopts) {
    const s = await status();
    if (s.running) return { ok: true, url: s.url };
    if (!s.cliFound) return { ok: false, code: 'FL_NOT_INSTALLED' };
    return start(sopts);
  }

  // The models: what is on this computer (cached) and, with catalog: everything Foundry Local offers.
  async function listModels(lopts) {
    const cli = cliPath();
    if (!cli) return { ok: false, code: 'FL_NOT_INSTALLED' };
    const catalog = !!(lopts && lopts.catalog);
    const r = await run(cli, catalog ? ['model', 'list', '-o', 'json'] : ['cache', 'list', '-o', 'json'], { timeoutMs: LIST_TIMEOUT_MS, signal: lopts && lopts.signal });
    if (r.error === 'ABORTED') return { ok: false, code: 'FL_ABORTED' };
    if (r.code !== 0) return { ok: false, code: 'FL_CLI_FAILED', detail: clean(r.stderr || r.stdout, 300) };
    const models = sortModels(parseModelList(r.stdout, freeMb()));
    for (const m of models) known.set(m.id, m);
    return { ok: true, models };
  }

  const validId = (id) => typeof id === 'string' && MODEL_ID_RE.test(id);

  async function download(id, dopts) {
    if (!validId(id)) return { ok: false, code: 'FL_BAD_MODEL' };
    const cli = cliPath();
    if (!cli) return { ok: false, code: 'FL_NOT_INSTALLED' };
    const onProgress = dopts && typeof dopts.onProgress === 'function' ? dopts.onProgress : () => {};
    let last = -1;
    const r = await run(cli, ['model', 'download', id], {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      signal: dopts && dopts.signal,
      onLine: (line) => {
        const m = /(\d{1,3})%\s*$/.exec(line);
        if (m && Number(m[1]) <= 100 && Number(m[1]) !== last) { last = Number(m[1]); onProgress({ percent: last }); }
      },
    });
    if (r.error === 'ABORTED') return { ok: false, code: 'FL_ABORTED' };
    if (r.code !== 0) return { ok: false, code: /not found|no model matching/i.test(r.stdout + r.stderr) ? 'FL_BAD_MODEL' : 'FL_DOWNLOAD_FAILED', detail: clean(r.stderr || r.stdout, 300) };
    return { ok: true };
  }

  async function load(id, lopts) {
    if (!validId(id)) return { ok: false, code: 'FL_BAD_MODEL' };
    const cli = cliPath();
    if (!cli) return { ok: false, code: 'FL_NOT_INSTALLED' };
    const r = await run(cli, ['model', 'load', id], { timeoutMs: LOAD_TIMEOUT_MS, signal: lopts && lopts.signal });
    if (r.error === 'ABORTED') return { ok: false, code: 'FL_ABORTED' };
    if (r.code !== 0) {
      const said = r.stdout + ' ' + r.stderr;
      return { ok: false, code: /not found|no model matching/i.test(said) ? 'FL_BAD_MODEL' : (/not (?:downloaded|cached)|download/i.test(said) ? 'FL_NOT_DOWNLOADED' : 'FL_LOAD_FAILED'), detail: clean(said, 300) };
    }
    return { ok: true };
  }

  async function unload(id) {
    if (!validId(id)) return { ok: false, code: 'FL_BAD_MODEL' };
    const cli = cliPath();
    if (!cli) return { ok: false, code: 'FL_NOT_INSTALLED' };
    const r = await run(cli, ['model', 'unload', id], { timeoutMs: 2 * 60 * 1000 });
    return r.code === 0 ? { ok: true } : { ok: false, code: 'FL_CLI_FAILED', detail: clean(r.stderr || r.stdout, 300) };
  }

  return { status, start, ensureServer, listModels, download, load, unload, validId, info: (id) => known.get(id) || null };
}

// The provider of the assistant for a Foundry Local model. build(url) -> a provider (providers.js, kind "local", flavor "foundry") for that server address. What it adds to
// a plain provider is what Foundry Local needs and does not do itself:
//   - a model that is not loaded (a request gets HTTP 400 "must be loaded before inference") is loaded, and the request is repeated;
//   - a server that is gone (it crashed, or the person closed it: connection refused) is started again - its address changes - and the request is repeated, at most
//     maxRestarts times per run.
// o: { model, url, build(url), fl (createFoundryLocal), onPhase?(phase: 'starting'|'loading'), onUrl?(url), maxRestarts?, signal? }
function createFoundryProvider(o) {
  let inner = o.build(o.url);
  let restarts = 0;
  const maxRestarts = Number.isInteger(o.maxRestarts) ? o.maxRestarts : 2;
  const phase = (p) => { if (typeof o.onPhase === 'function') o.onPhase(p); };
  const notLoaded = (e) => !!e && /must be loaded/i.test(String(e.detail || '') + ' ' + String(e.message || ''));

  async function loadModel() {
    phase('loading');
    const r = await o.fl.load(o.model, { signal: o.signal });
    if (!r.ok) throw new FoundryError(r.code, 'Foundry Local could not load the model', r.detail);
  }

  async function guarded(fn) {
    let loads = 0;
    for (;;) {
      try {
        return await fn(inner);
      } catch (e) {
        if (e instanceof FoundryError || !e || e.code === 'ABORTED') throw e;
        if (notLoaded(e) && loads < 2) { loads++; await loadModel(); continue; }
        if (e.code === 'NETWORK' && restarts < maxRestarts) {
          restarts++;
          phase('starting');
          const s = await o.fl.ensureServer({ signal: o.signal });
          if (!s.ok) throw new FoundryError(s.code, 'Foundry Local is not running', s.detail);
          if (typeof o.onUrl === 'function') o.onUrl(s.url);
          inner = o.build(s.url);
          await loadModel();
          continue;
        }
        throw e;
      }
    }
  }

  return {
    kind: 'local',
    model: o.model,
    toolsEmulated: () => (typeof inner.toolsEmulated === 'function' ? inner.toolsEmulated() : false),
    chat: (req) => guarded((p) => p.chat(req)),
    listModels: (req) => guarded((p) => p.listModels(req)),
  };
}

module.exports = {
  createFoundryLocal, createFoundryProvider, FoundryError, parseDaemon, parseModelList, sortModels, loopbackOrigin, findCli, daemonFile, getJson, defaultRun,
  MODEL_ID_RE, LINKS, INSTALL_COMMAND, PREFERRED, IDLE_TIMEOUT_MINUTES,
};
