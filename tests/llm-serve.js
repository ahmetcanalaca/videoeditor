'use strict';
// MANUAL tool: starts the built-in model exactly like the app does (same pinned runtime, same arguments, same private key) and keeps it running,
// so that the benchmarks (tests/local-llm-bench.js, tests/e2e-find.js) can talk to it.
//   node tests/llm-serve.js --models=<root> [--backend=auto|cpu|vk] [--out=<json file>] [--parallel=2] [--ctx=24576]
// Writes { baseUrl, key, backend, pid } to the --out file (default: tests/out/llm-serve.json) once the model is loaded. Stop it with Ctrl+C / by killing the PID.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CATALOG, DEFAULT_MODEL_ID } = require('../src/main/llm/catalog');
const { createModelStore } = require('../src/main/llm/models');
const { createLlamaServer } = require('../src/main/llm/server');
const { resolveRuntime } = require('../src/main/llm/runtime');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const root = arg('models', path.join(process.env.APPDATA || os.homedir(), 'VideoEditor', 'models'));
const backend = arg('backend', 'auto');
const out = arg('out', path.join(__dirname, 'out', 'llm-serve.json'));

(async () => {
  const store = createModelStore({ root, catalog: CATALOG, stateFile: path.join(os.tmpdir(), 've-llm-serve-verified.json'), fetch: () => { throw new Error('no network here'); } });
  let st = store.status(DEFAULT_MODEL_ID);
  if (st.state === 'unverified') st = await store.verify(DEFAULT_MODEL_ID);
  if (st.state !== 'ready') { console.error('the model is not ready: ' + st.state + ' in ' + root); process.exit(1); }
  const model = CATALOG.find((m) => m.id === DEFAULT_MODEL_ID);
  const srv = createLlamaServer({
    runtime: resolveRuntime({}), getBackend: () => backend, getIdleMs: () => 0, procs: { track() {} },
    parallel: Number(arg('parallel', 2)), ctx: Number(arg('ctx', 24576)),
    getModel: () => ({ id: model.id, paths: store.paths(model.id), bytes: model.files.reduce((s, f) => s + f.size, 0) }),
    log: (m) => console.log('[llm] ' + m),
  });
  const t0 = Date.now();
  const ep = await srv.ensure();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ baseUrl: ep.baseUrl, key: ep.key, backend: ep.backend, pid: process.pid }));
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)} s on ${ep.baseUrl} (${ep.backend}); info written to ${out}`);
  const stop = async () => { await srv.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error('FAILED', e.code || '', e.message, e.detail || ''); process.exit(1); });
