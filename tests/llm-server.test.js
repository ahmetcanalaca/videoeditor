'use strict';
// Tests of src/main/llm/server.js (+ runtime.js) with a fake llama-server run through node: loopback binding, the per-start key in the
// environment, no web page, idle stop, GPU -> CPU fallback, start time-out, crash recovery, clean-up of a leftover process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createLlamaServer, healthStatus, listenersOn } = require('../src/main/llm/server');
const { LlmError } = require('../src/main/llm/models');
const { parseDevices, resolveRuntime } = require('../src/main/llm/runtime');

const FAKE = path.join(__dirname, 'helpers', 'fake-llama-server.js');
let failures = 0;
let count = 0;
async function test(name, fn) {
  const t0 = Date.now();
  count++;
  try {
    const detail = await fn();
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)${detail ? '  ' + detail : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms)\n      ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || 'values differ') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };
const truthy = (c, m) => { if (!c) throw new Error(m || 'not true'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rejectsWith(promise, code) {
  try { await promise; } catch (e) { eq(e && e.code, code, 'error code (' + (e && e.message) + ')'); return e; }
  throw new Error('expected a rejection with ' + code);
}

const tracked = new Set();
const procs = { track(c) { tracked.add(c); c.once('exit', () => tracked.delete(c)); return c; } };
const MODEL = { id: 'm', paths: { model: 'C:\\models\\m.gguf', mmproj: 'C:\\models\\mm.gguf' }, bytes: 3 * 1024 * 1024 * 1024 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-llm-server-'));

function make(extra) {
  return createLlamaServer(Object.assign({
    runtime: { cpu: tmp, vk: tmp },
    getModel: () => MODEL,
    getBackend: () => 'auto',
    getIdleMs: () => 0,
    procs,
    pidFile: path.join(tmp, 'pid-' + Math.random().toString(36).slice(2) + '.json'),
    spawnSpec: () => ({ file: process.execPath, prefix: [FAKE], cwd: tmp }),
    pollMs: 20,
    threads: 4,
  }, extra));
}
async function call(ep, p, key, init) {
  const res = await fetch(ep.baseUrl.replace(/\/v1$/, '') + p, Object.assign({ headers: key === null ? {} : { authorization: 'Bearer ' + (key === undefined ? ep.key : key) } }, init));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function main() {
  await test('S01 starts on 127.0.0.1 with a per-start key that is NOT on the command line; the web page is off', async () => {
    process.env.LLAMA_ARG_SOMETHING = 'leaked-from-the-user-environment';
    const s = make();
    const ep = await s.ensure();
    truthy(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(ep.baseUrl), 'base url ' + ep.baseUrl);
    eq(s.info().phase, 'ready');
    const info = (await call(ep, '/_info')).body;
    eq(info.host, '127.0.0.1');
    truthy(info.argv.includes('--no-webui') && info.argv.includes('--no-slots') && info.argv.includes('--jinja'), 'flags missing: ' + info.argv.join(' '));
    eq(info.argv[info.argv.indexOf('-ngl') + 1], '99', 'auto picks the GPU build when it is available');
    truthy(!info.argv.some((a) => a === '--api-key' || a.includes(ep.key)), 'the key is on the command line');
    eq(JSON.stringify(info.llamaEnv), JSON.stringify(['LLAMA_API_KEY']), 'only the API key may be passed as a LLAMA_* variable');
    eq(info.argv[info.argv.indexOf('-m') + 1], MODEL.paths.model);
    truthy(ep.key.length >= 24 && /^[\x21-\x7e]+$/.test(ep.key), 'key format');
    await s.stop();
    delete process.env.LLAMA_ARG_SOMETHING;
  });

  await test('S02 requests need the key: none or a wrong one -> 401, the right one -> 200; /health is public', async () => {
    const s = make();
    const ep = await s.ensure();
    eq((await call(ep, '/v1/models', null)).status, 401);
    eq((await call(ep, '/v1/models', 'wrong')).status, 401);
    eq((await call(ep, '/v1/models')).status, 200);
    eq(await healthStatus(ep.port), 200);
    await s.stop();
  });

  await test('S03 concurrent ensure() calls share ONE process; a second start gets a new key and port', async () => {
    const s = make();
    const [a, b, c] = await Promise.all([s.ensure(), s.ensure(), s.ensure()]);
    eq(a.port, b.port); eq(b.port, c.port);
    eq(tracked.size, 1, 'processes');
    const oldKey = a.key;
    await s.stop();
    eq(await healthStatus(a.port), 0, 'the old server still answers');
    const d = await s.ensure();
    truthy(d.key !== oldKey, 'the key was reused');
    await s.stop();
  });

  await test('S04 idle stop: not while a request runs, afterwards yes; the next ensure() starts again', async () => {
    const s = make({ getIdleMs: () => 400 });
    let pid = 0;
    await s.use(async (ep) => {
      pid = (await call(ep, '/_info')).body.pid;
      await sleep(900); // longer than the idle time: must survive because it is in use
      eq(s.info().phase, 'ready', 'stopped while in use');
      truthy(alive(pid));
    });
    await sleep(900);
    eq(s.info().phase, 'stopped', 'idle stop did not happen');
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    truthy(!alive(pid), 'the process is still alive');
    const ep = await s.ensure();
    eq((await call(ep, '/v1/models')).status, 200);
    await s.stop();
  });

  await test('S05 the GPU build fails -> the CPU build takes over automatically and the info says so', async () => {
    process.env.FAKE_LLAMA_FAIL_GPU = '1';
    const s = make();
    const ep = await s.ensure();
    eq(s.info().backend, 'cpu'); eq(s.info().fallbackFrom, 'vk');
    const info = (await call(ep, '/_info')).body;
    eq(info.argv[info.argv.indexOf('-ngl') + 1], '0');
    // the decision is remembered for this session: no second failing attempt
    await s.stop();
    const t0 = Date.now();
    await s.ensure();
    eq(s.info().backend, 'cpu');
    await s.stop();
    delete process.env.FAKE_LLAMA_FAIL_GPU;
    return 'second start ' + (Date.now() - t0) + ' ms';
  });

  await test('S06 a GPU the user forced that fails is an error (no silent fallback); "cpu" never tries the GPU', async () => {
    process.env.FAKE_LLAMA_FAIL_GPU = '1';
    const forced = make({ getBackend: () => 'vk' });
    const e = await rejectsWith(forced.ensure(), 'LLM_START_FAILED');
    truthy(/vulkan|allocate/i.test(e.detail || ''), 'diagnostics missing: ' + e.detail);
    eq(forced.info().phase, 'stopped');
    const cpu = make({ getBackend: () => 'cpu' });
    const ep = await cpu.ensure();
    eq(cpu.info().backend, 'cpu'); eq(cpu.info().fallbackFrom, null);
    await cpu.stop();
    delete process.env.FAKE_LLAMA_FAIL_GPU;
    void ep;
  });

  await test('S07 a model that never finishes loading ends with LLM_START_TIMEOUT and no process is left', async () => {
    process.env.FAKE_LLAMA_HANG = '1';
    const before = tracked.size;
    const s = make({ startTimeoutMs: 700, getBackend: () => 'cpu' });
    await rejectsWith(s.ensure(), 'LLM_START_TIMEOUT');
    await sleep(300);
    eq(tracked.size, before, 'a process was left running');
    delete process.env.FAKE_LLAMA_HANG;
  });

  await test('S08 a model that is not installed / verified stops the start before any process exists', async () => {
    const before = tracked.size;
    const s = make({ getModel: () => { throw new LlmError('MODEL_NOT_READY', 'missing'); } });
    await rejectsWith(s.ensure(), 'MODEL_NOT_READY');
    eq(tracked.size, before);
    eq(s.info().phase, 'stopped');
  });

  await test('S09 a crash after start-up is noticed; the next ensure() brings it back', async () => {
    process.env.FAKE_LLAMA_EXIT_AFTER_MS = '300';
    const s = make();
    await s.ensure();
    delete process.env.FAKE_LLAMA_EXIT_AFTER_MS;
    for (let i = 0; i < 40 && s.info().phase === 'ready'; i++) await sleep(50);
    eq(s.info().phase, 'stopped', 'crash not noticed');
    eq(s.info().error, 'EXITED');
    const ep = await s.ensure();
    eq((await call(ep, '/v1/models')).status, 200);
    await s.stop();
  });

  await test('S10 stop() ends the process and removes the pid file', async () => {
    const pidFile = path.join(tmp, 's10.pid.json');
    const s = make({ pidFile });
    const ep = await s.ensure();
    const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    eq(rec.pid, (await call(ep, '/_info')).body.pid);
    await s.stop();
    truthy(!fs.existsSync(pidFile), 'pid file left');
    for (let i = 0; i < 20 && alive(rec.pid); i++) await sleep(100);
    truthy(!alive(rec.pid), 'process alive after stop');
  });

  await test('S11 a process left behind by a crash is stopped at the next start - but only if it really is that program', async () => {
    const strayPath = path.join(tmp, 's11.pid.json');
    const leftover = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    // recorded under the wrong name (e.g. the id was reused by another program): must not be touched
    fs.writeFileSync(strayPath, JSON.stringify({ pid: leftover.pid, exe: 'llama-server.exe', startedAt: 1 }));
    const s1 = make({ pidFile: strayPath });
    eq(await s1.cleanupStale(), false, 'killed a process with another name');
    truthy(alive(leftover.pid), 'innocent process was killed');
    // the program name is OURS (llama-server.exe), never taken from the file: a record that names another program stops nothing
    fs.writeFileSync(strayPath, JSON.stringify({ pid: leftover.pid, exe: 'node.exe', startedAt: 1 }));
    eq(await s1.cleanupStale(), false, 'the name in the pid file decided what was stopped');
    truthy(alive(leftover.pid), 'process killed on the word of the pid file');
    // recorded under its real name (the test runs a node process as the "server"): stopped
    fs.writeFileSync(strayPath, JSON.stringify({ pid: leftover.pid, exe: 'node.exe', startedAt: 1 }));
    const s2 = make({ pidFile: strayPath, exeName: 'node.exe' });
    eq(await s2.cleanupStale(), true, 'leftover not stopped');
    for (let i = 0; i < 30 && alive(leftover.pid); i++) await sleep(100);
    truthy(!alive(leftover.pid), 'leftover still alive');
    truthy(!fs.existsSync(strayPath), 'pid file kept');
    // garbage in the file is ignored
    fs.writeFileSync(strayPath, '{ not json');
    eq(await s2.cleanupStale(), false);
    fs.writeFileSync(strayPath, JSON.stringify({ pid: 1, exe: 'node.exe' }));
    eq(await s2.cleanupStale(), false, 'a system pid must never be killed');
  });

  await test('S11b system programs are started by their full path (no lookup in the working folder)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'llm', 'server.js'), 'utf8');
    truthy(!/execFile\(\s*'(tasklist|netstat)'/.test(src), 'a bare program name is still used');
    truthy(/System32/.test(src) && /tasklist\.exe/.test(src) && /netstat\.exe/.test(src), 'System32 paths missing');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    truthy(/NoDefaultCurrentDirectoryInExePath/.test(main), 'NoDefaultCurrentDirectoryInExePath is not set');
  });

  await test('S12 aborting the wait does not abort the start: the server comes up for the next caller', async () => {
    process.env.FAKE_LLAMA_LOAD_MS = '600';
    const s = make();
    const ac = new AbortController();
    const p = s.ensure({ signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await rejectsWith(p, 'ABORTED');
    const ep = await s.ensure();
    eq((await call(ep, '/v1/models')).status, 200);
    await s.stop();
    delete process.env.FAKE_LLAMA_LOAD_MS;
  });

  await test('S13 device list parsing and runtime lookup', async () => {
    const devs = parseDevices('ggml_vulkan: Found 1 Vulkan devices:\nAvailable devices:\n  Vulkan0: AMD Radeon(TM) Graphics (16269 MiB, 15456 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4070 Laptop GPU (8188 MiB, 7000 MiB free)\n');
    eq(devs.length, 2);
    eq(devs[0].name, 'AMD Radeon(TM) Graphics'); eq(devs[0].totalMiB, 16269); eq(devs[0].freeMiB, 15456);
    eq(parseDevices('Available devices:\n  (none)\n').length, 0);
    eq(parseDevices('').length, 0);
    const rt = resolveRuntime({ resourcesPath: path.join(tmp, 'nowhere') });
    const project = path.join(__dirname, '..', 'vendor', 'llama');
    if (fs.existsSync(path.join(project, 'cpu', 'llama-server.exe'))) truthy(rt.cpu && rt.vk, 'the development runtime was not found');
  });

  await test('S14 auto picks the CPU build when the graphics device has too little free memory, the GPU build when there is enough', async () => {
    const mk = (devices) => createLlamaServer({
      runtime: { cpu: tmp, vk: tmp }, getModel: () => MODEL, getBackend: () => 'auto', getIdleMs: () => 0, procs, pidFile: path.join(tmp, 's14.json'), pollMs: 20, threads: 2,
      spawnSpec: () => ({ file: process.execPath, prefix: [FAKE], cwd: tmp }), deviceLister: async () => devices,
    });
    const small = mk([{ id: 'Vulkan0', name: 'tiny GPU', totalMiB: 2048, freeMiB: 1800 }]);
    await small.ensure();
    eq(small.info().backend, 'cpu', 'tiny GPU');
    await small.stop();
    const none = mk([]);
    await none.ensure();
    eq(none.info().backend, 'cpu', 'no GPU');
    await none.stop();
    const big = mk([{ id: 'Vulkan0', name: 'AMD Radeon(TM) Graphics', totalMiB: 16269, freeMiB: 15456 }]);
    await big.ensure();
    eq(big.info().backend, 'vk', 'big GPU');
    eq(JSON.stringify(big.info().detectedGpu), JSON.stringify(['AMD Radeon(TM) Graphics']));
    await big.stop();
  });

  await test('S15 a program that cannot be started at all (deleted / quarantined exe) is reported at once, not after the start-up timeout', async () => {
    const t0 = Date.now();
    const s = make({ startTimeoutMs: 20000, getBackend: () => 'cpu', spawnSpec: () => ({ file: path.join(tmp, 'does-not-exist.exe'), prefix: [], cwd: tmp }) });
    const e = await rejectsWith(s.ensure(), 'LLM_START_FAILED');
    truthy(/ENOENT/.test(e.detail || ''), 'the reason is passed on: ' + e.detail);
    truthy(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
    eq(s.info().phase, 'stopped');
    return (Date.now() - t0) + ' ms';
  });

  await test('S16 stop() while the model is still loading ends the start at once: no process is left and the CPU build is NOT started afterwards', async () => {
    process.env.FAKE_LLAMA_HANG = '1';
    let spawns = 0;
    const s = createLlamaServer({
      runtime: { cpu: tmp, vk: tmp }, getModel: () => MODEL, getBackend: () => 'auto', getIdleMs: () => 0, procs, pidFile: path.join(tmp, 's16.json'), pollMs: 20, threads: 2, startTimeoutMs: 20000,
      spawnSpec: () => { spawns++; return { file: process.execPath, prefix: [FAKE], cwd: tmp }; },
      deviceLister: async () => [{ id: 'Vulkan0', name: 'big GPU', totalMiB: 16269, freeMiB: 15456 }],
    });
    const before = tracked.size;
    const starting = s.ensure().then(() => null, (e) => e);
    await sleep(500); // the (hanging) graphics build is loading
    eq(spawns, 1, 'the graphics build was not started');
    const t0 = Date.now();
    await s.stop();
    const e = await starting;
    eq(e && e.code, 'ABORTED');
    truthy(Date.now() - t0 < 3000, 'stop() waited for the start-up timeout');
    await sleep(300);
    eq(spawns, 1, 'another build was started during the stop');
    eq(tracked.size, before, 'a process was left running');
    eq(s.info().phase, 'stopped'); eq(s.info().error, null, 'stopping is not an error');
    delete process.env.FAKE_LLAMA_HANG;
  });

  await test('S17 the program that answers on the port must be the child that was started: a second listener on the port stops the start (LLM_PORT_TAKEN), no process is left', async () => {
    const before = tracked.size;
    const s = make({ getBackend: () => 'cpu', listenersOn: async (port) => [process.pid, port] }); // "somebody else" (not the child) is listening too
    const e = await rejectsWith(s.ensure(), 'LLM_PORT_TAKEN');
    truthy(/port/.test(e.detail || ''), 'detail: ' + e.detail);
    await sleep(300);
    eq(tracked.size, before, 'the child was left running');
    eq(s.info().phase, 'stopped');
    // an inconclusive answer (netstat could not run) does not block the start
    const ok = make({ getBackend: () => 'cpu', listenersOn: async () => null });
    await ok.ensure();
    eq(ok.info().phase, 'ready');
    await ok.stop();
  });

  await test('S18 listenersOn() reads the real netstat table: a port this test listens on belongs to this process; a free one to nobody', async () => {
    const srv = require('net').createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const owners = await listenersOn(port);
    srv.close();
    truthy(Array.isArray(owners) && owners.length === 1 && owners[0] === process.pid, 'owners: ' + JSON.stringify(owners));
    const none = await listenersOn(port);
    truthy(Array.isArray(none) && none.length === 0, 'a closed port still has an owner: ' + JSON.stringify(none));
    // and the check runs for real (netstat of System32) when a normal start is made
    const s = make({ getBackend: () => 'cpu' });
    await s.ensure();
    eq(s.info().phase, 'ready');
    await s.stop();
  });

  for (const c of Array.from(tracked)) { try { c.kill(); } catch (e) { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${count} FAILED` : `\nall ${count} server checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('crashed', e); process.exit(2); });
