'use strict';
// Starts, watches and stops the llama-server process of the built-in local assistant.
//
// Safety properties (all tested in tests/llm-server.test.js):
//   - the server listens on 127.0.0.1 only, on a free port chosen at start-up;
//   - every request needs a random per-start API key; the key travels in the child's ENVIRONMENT (LLAMA_API_KEY), not on its command line;
//   - the web page llama-server normally serves is switched off;
//   - arguments are an array (no shell); the model paths come from the verified model store;
//   - the process stops after a period without use, when the app quits, and a process left behind by a crash is cleaned up at the next start;
//   - if the graphics build cannot start (driver problem, too little video memory) the CPU build takes over automatically.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { LlmError } = require('./models');
const { listDevices, EXE } = require('./runtime');

const START_TIMEOUT_MS = 240 * 1000;
const LOG_KEEP = 64 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// System programs by their full path: a bare name is looked up in the working folder first (see also NoDefaultCurrentDirectoryInExePath in main.js).
const SYSTEM32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');
const NETSTAT = path.join(SYSTEM32, 'netstat.exe');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// GET /health on the loopback port; resolves with the HTTP status (0 = nobody answered).
function healthStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

// A process of this exact name still exists under this id (used to clean up after a crash; the name check keeps a reused id harmless).
function processIsNamed(pid, name, tasklist) {
  return new Promise((resolve) => {
    execFile(tasklist || TASKLIST, ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(!err && String(stdout).toLowerCase().includes('"' + name.toLowerCase() + '"'));
    });
  });
}

// Ids of the processes that LISTEN on this TCP port (netstat of System32), or null when that could not be found out. A listening row has the
// foreign address 0.0.0.0:0 / [::]:0 (the state word itself is translated by Windows, so it is not used).
function listenersOn(port, netstat) {
  return new Promise((resolve) => {
    execFile(netstat || NETSTAT, ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const pids = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^\s*TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/i.exec(line);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
      resolve([...pids]);
    });
  });
}

// opts: {
//   runtime: { cpu: dir|null, vk: dir|null }          getModel(): { id, paths: { model, mmproj }, bytes } (throws when the model is not ready)
//   getBackend(): 'auto' | 'cpu' | 'vk'               getIdleMs(): ms (0 = never stop)
//   procs: { track(child) }                           pidFile: path
//   spawnSpec(backend) -> { file, prefix[] }          (tests run a fake server through node)
//   inProcess: { start({ port, key, backend }) -> { close() } }   (UI tests; replaces the child process)
//   ctx, parallel, threads, log(message)
//   exeName (tests: the program name the pid file may carry, default llama-server.exe), tasklist / listenersOn(port) (tests inject fakes)
//   onStopped()                                       called when the model has stopped (stop(), idle time-out, crash): the screen follows
// }
function createLlamaServer(opts) {
  const o = opts;
  const state = { phase: 'stopped', backend: null, port: 0, key: '', child: null, inproc: null, error: null, fallbackFrom: null, startPromise: null, busy: 0, idleTimer: null, log: '', forceCpu: false, devices: null, startedAt: 0, expectExit: false, stopping: false };
  const log = (m) => { if (o.log) o.log(String(m)); };
  const stopped = () => { if (o.onStopped) { try { o.onStopped(); } catch (e) { /* the screen is told on a best-effort basis */ } } };
  const keepLog = (chunk) => { state.log = (state.log + chunk.toString()).slice(-LOG_KEEP); };
  const redact = (s) => (state.key ? String(s).split(state.key).join('***') : String(s));

  function spawnSpec(backend) {
    if (o.spawnSpec) return o.spawnSpec(backend);
    const dir = o.runtime[backend];
    if (!dir) throw new LlmError('RUNTIME_MISSING', 'The ' + backend + ' build of llama-server is not installed');
    return { file: path.join(dir, EXE), prefix: [], cwd: dir };
  }

  async function chooseBackend(model) {
    const pref = o.getBackend ? o.getBackend() : 'auto';
    const haveVk = !!(o.runtime.vk || o.spawnSpec || o.inProcess);
    if (pref === 'cpu' || !haveVk) return 'cpu';
    if (pref === 'vk') return 'vk'; // what the user chose is tried even after an automatic fallback earlier
    if (state.forceCpu) return 'cpu'; // auto mode: the graphics build failed before in this session
    if (o.inProcess) return 'vk';
    // auto: the graphics build only if the Vulkan driver reports a device with enough free memory (tests inject the device list)
    const lister = o.deviceLister || (o.spawnSpec ? null : (dir) => listDevices(dir, 25000));
    if (!lister) return 'vk';
    if (!state.devices) state.devices = await lister(o.runtime.vk);
    const needMiB = Math.ceil((model.bytes || 0) / 1048576) + 1500; // the model, its image encoder and the caches
    return state.devices.some((d) => d.freeMiB >= needMiB) ? 'vk' : 'cpu';
  }

  function llamaArgs(model, port, backend) {
    const threads = o.threads || Math.max(2, Math.min(12, Math.floor(os.cpus().length / 2)));
    return [
      '-m', model.paths.model, '--mmproj', model.paths.mmproj,
      '--host', '127.0.0.1', '--port', String(port),
      '-c', String(o.ctx || 24576), '--parallel', String(o.parallel || 2),
      '--jinja', '--no-webui', '--no-slots', '--cache-ram', '1024',
      '--chat-template-kwargs', '{"enable_thinking":false}',
      '-t', String(threads), '-ngl', backend === 'vk' ? '99' : '0',
    ];
  }

  function childEnv(key) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^LLAMA_/i.test(k)) env[k] = v;
    env.LLAMA_API_KEY = key;
    return env;
  }

  function writePid(child, file) {
    if (!o.pidFile) return;
    try {
      fs.mkdirSync(path.dirname(o.pidFile), { recursive: true });
      fs.writeFileSync(o.pidFile, JSON.stringify({ pid: child.pid, exe: path.basename(file), startedAt: Date.now() }), 'utf8');
    } catch (e) { /* only used for crash clean-up */ }
  }
  const clearPid = () => { if (o.pidFile) { try { fs.rmSync(o.pidFile, { force: true }); } catch (e) { /* ignore */ } } };

  function resetIdle() {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    const ms = o.getIdleMs ? o.getIdleMs() : 0;
    if (state.phase !== 'ready' || !(ms > 0)) return;
    state.idleTimer = setTimeout(() => {
      if (state.busy > 0) { resetIdle(); return; }
      log('stopping the local model after ' + Math.round(ms / 60000) + ' min without use');
      stop();
    }, ms);
    if (state.idleTimer.unref) state.idleTimer.unref();
  }

  async function launch(model, backend) {
    const port = await freePort();
    const key = crypto.randomBytes(24).toString('base64url');
    state.port = port; state.key = key; state.backend = backend; state.log = ''; state.expectExit = false;
    if (o.inProcess) {
      state.inproc = await o.inProcess.start({ port, key, backend, model });
    } else {
      const spec = spawnSpec(backend);
      const args = spec.prefix.concat(llamaArgs(model, port, backend));
      const child = spawn(spec.file, args, { cwd: spec.cwd, env: childEnv(key), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (o.procs) o.procs.track(child);
      state.child = child;
      child.stdout.on('data', keepLog);
      child.stderr.on('data', keepLog);
      child.on('error', (e) => {
        state.log += '\n' + String(e && e.message);
        // a program that could not even be started (deleted or quarantined exe, missing folder) is never followed by an 'exit' event: it is over now
        if (child.pid === undefined && state.child === child) { state.child = null; clearPid(); }
      });
      child.on('exit', (code) => {
        if (state.child !== child) return;
        log('llama-server exited (' + code + ')');
        state.child = null;
        if (state.phase === 'ready' || state.phase === 'starting') {
          const wasReady = state.phase === 'ready';
          state.phase = 'stopped';
          if (!state.expectExit) state.error = 'EXITED';
          if (wasReady) stopped();
        }
        clearPid();
      });
      if (child.pid) writePid(child, spec.file);
    }
    // wait until the model is loaded
    const t0 = Date.now();
    for (;;) {
      if (state.stopping) throw new LlmError('ABORTED', 'The model was stopped while it was starting');
      if (state.child === null && !state.inproc) throw new LlmError('LLM_START_FAILED', 'llama-server stopped while loading the model', { detail: redact(state.log).slice(-1200) });
      if ((await healthStatus(port)) === 200) { await verifyOwner(port); return; }
      if (Date.now() - t0 > (o.startTimeoutMs || START_TIMEOUT_MS)) throw new LlmError('LLM_START_TIMEOUT', 'The model did not finish loading in time', { detail: redact(state.log).slice(-1200) });
      await sleep(o.pollMs || 250);
    }
  }

  // Whoever answers on the port has to be the child that was started: a local program that grabbed the port first would otherwise be handed the
  // key, the prompts and the pictures of the video. Only a clear contradiction stops the start (a second listener, a dead child); when netstat
  // cannot tell, the start goes on.
  async function verifyOwner(port) {
    if (o.inProcess) return;
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) throw new LlmError('LLM_START_FAILED', 'llama-server stopped while loading the model', { detail: redact(state.log).slice(-1200) });
    const owners = await (o.listenersOn || listenersOn)(port);
    if (owners && owners.some((pid) => pid !== child.pid)) throw new LlmError('LLM_PORT_TAKEN', 'Another program is listening on the port of the local model', { detail: 'port ' + port + ', pid ' + owners.join(', ') });
  }

  async function teardown() {
    const child = state.child;
    const inproc = state.inproc;
    state.child = null; state.inproc = null; state.expectExit = true;
    if (inproc) { try { await inproc.close(); } catch (e) { /* ignore */ } }
    if (child) {
      // a child that never started or is gone has no 'exit' to wait for
      const gone = child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
      if (gone) { try { child.kill(); } catch (e) { /* ignore */ } } else {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 4000);
          child.once('exit', () => { clearTimeout(t); resolve(); });
          try { child.kill(); } catch (e) { clearTimeout(t); resolve(); }
        });
      }
    }
    clearPid();
  }

  async function startUp() {
    const model = o.getModel(); // throws MODEL_NOT_READY when the files are missing or not verified
    state.phase = 'starting'; state.error = null; state.fallbackFrom = null;
    let backend = await chooseBackend(model);
    try {
      if (state.stopping) throw new LlmError('ABORTED', 'The model was stopped while it was starting');
      await launch(model, backend);
    } catch (e) {
      await teardown();
      if (state.stopping) throw new LlmError('ABORTED', 'The model was stopped while it was starting'); // a stop in progress must not start the CPU build
      if (backend !== 'vk' || (o.getBackend && o.getBackend() === 'vk') || e.code === 'RUNTIME_MISSING') throw e;
      // the graphics build could not start: fall back to the CPU build and remember it for this session
      log('GPU start failed (' + e.code + '), using the CPU build');
      state.forceCpu = true; state.fallbackFrom = 'vk';
      backend = 'cpu';
      await launch(model, backend);
    }
    state.phase = 'ready';
    state.startedAt = Date.now();
    resetIdle();
    log('llama-server ready on 127.0.0.1:' + state.port + ' (' + backend + ')');
  }

  function ready() {
    return { baseUrl: 'http://127.0.0.1:' + state.port + '/v1', origin: 'http://127.0.0.1:' + state.port, key: state.key, backend: state.backend, port: state.port };
  }

  async function ensure(eopts) {
    const signal = eopts && eopts.signal;
    if (signal && signal.aborted) throw new LlmError('ABORTED', 'Cancelled');
    if (state.phase === 'ready') {
      if ((await healthStatus(state.port)) === 200) { resetIdle(); return ready(); }
      await teardown(); state.phase = 'stopped'; // it died or hangs: start again
    }
    if (!state.startPromise) {
      state.startPromise = startUp().then(() => ready(), async (e) => {
        state.phase = 'stopped'; state.error = e.code === 'ABORTED' ? null : (e.code || 'LLM_START_FAILED');
        await teardown();
        throw e instanceof LlmError ? e : new LlmError('LLM_START_FAILED', String((e && e.message) || e), { detail: redact(state.log).slice(-1200) });
      }).finally(() => { state.startPromise = null; });
    }
    if (!signal) return state.startPromise;
    return Promise.race([state.startPromise, new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new LlmError('ABORTED', 'Cancelled')), { once: true }); })]);
  }

  // Runs fn(endpoint) while the server is guaranteed not to be stopped for being idle.
  async function use(fn, eopts) {
    const ep = await ensure(eopts);
    state.busy++;
    try { return await fn(ep); } finally { state.busy--; resetIdle(); }
  }

  async function stop() {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    if (state.startPromise) {
      // a start in progress ends now: the loading child is killed at once and no other build is tried afterwards (quitting the app must not
      // leave a freshly started llama-server behind)
      state.stopping = true;
      state.expectExit = true;
      try { if (state.child) state.child.kill(); } catch (e) { /* ignore */ }
      try { await state.startPromise; } catch (e) { /* ignore */ }
      state.stopping = false;
    }
    await teardown();
    state.phase = 'stopped';
    stopped();
  }

  // At app start: a llama-server this app started earlier and that outlived a crash is stopped.
  async function cleanupStale() {
    if (!o.pidFile) return false;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(o.pidFile, 'utf8')); } catch (e) { return false; }
    clearPid();
    // the program name comes from here, not from the file: whatever the file says, only a process with the name of OUR server is ever stopped
    const expected = o.exeName || EXE;
    if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 4 || rec.exe !== expected) return false;
    if (!(await processIsNamed(rec.pid, expected, o.tasklist))) return false;
    try { process.kill(rec.pid); log('stopped a leftover llama-server (pid ' + rec.pid + ')'); return true; } catch (e) { return false; }
  }

  return {
    ensure, use, stop, cleanupStale,
    touch: resetIdle,
    // the user changed the mode: the graphics build gets a new chance in automatic mode
    forgetFallback() { state.forceCpu = false; state.fallbackFrom = null; },
    info() {
      return { phase: state.phase, backend: state.backend, port: state.phase === 'ready' ? state.port : 0, error: state.error, fallbackFrom: state.fallbackFrom, busy: state.busy, startedAt: state.startedAt, detectedGpu: state.devices ? state.devices.map((d) => d.name) : null };
    },
    isRunning: () => state.phase === 'ready',
    LlmError,
  };
}

module.exports = { createLlamaServer, freePort, healthStatus, listenersOn };
