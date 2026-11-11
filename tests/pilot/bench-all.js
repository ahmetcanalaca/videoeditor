'use strict';
// Runs tests/local-llm-bench.js against several local models, one llama-server at a time (CPU), and prints a comparison.
//   node bench-all.js [name1,name2,...]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer, waitReady } = require('./llm-srv');

const ROOT = __dirname;
const PROJECT = path.resolve(__dirname, '..', '..');
const OUTDIR = path.join(ROOT, 'work', 'bench');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 18095;

const MODELS = [
  { name: 'qwen3.5-4b', file: 'Qwen3.5-4B-Q4_K_M.gguf' },
  { name: 'qwen3.5-2b', file: 'Qwen3.5-2B-Q4_K_M.gguf' },
  { name: 'qwen2.5-3b', file: 'qwen2.5-3b-instruct-q4_k_m.gguf' },
  { name: 'phi-4-mini', file: 'Phi-4-mini-Q4_K_M.gguf' },
  { name: 'gemma-4-e4b', file: 'gemma-4-E4B-it-Q4_K_M.gguf' },
  { name: 'qwen3.5-9b', file: 'Qwen3.5-9B-Q4_K_M.gguf', langs: 'en' },
];
const want = (process.argv[2] || '').split(',').filter(Boolean);

function runBench(m) {
  return new Promise((resolve) => {
    const out = path.join(OUTDIR, m.name + '.json');
    const log = fs.createWriteStream(path.join(OUTDIR, m.name + '.log'));
    const env = Object.assign({}, process.env, { VE_LOCAL_URL: 'http://127.0.0.1:' + PORT + '/v1', VE_LOCAL_MODEL: m.name, VE_BENCH_OUT: out, VE_BENCH_LANGS: m.langs || 'en,tr' });
    const c = spawn(process.execPath, [path.join(PROJECT, 'tests', 'local-llm-bench.js')], { cwd: PROJECT, env });
    c.stdout.on('data', (d) => { log.write(d); process.stdout.write(d); });
    c.stderr.on('data', (d) => { log.write(d); process.stdout.write(d); });
    c.on('close', () => { log.end(); resolve(out); });
  });
}

(async () => {
  for (const m of MODELS) {
    if (want.length && !want.includes(m.name)) continue;
    console.log('\n################ ' + m.name + ' ################');
    const srv = startServer({ model: path.join(ROOT, 'models', m.file), port: PORT, ctx: 8192, threads: 12, backend: 'cpu', thinking: '0', extra: '--parallel 1' });
    try {
      const ms = await waitReady(srv, PORT, 300000);
      console.log('server ready in ' + (ms / 1000).toFixed(1) + ' s (pid ' + srv.child.pid + ')');
      await runBench(m);
    } catch (e) {
      console.log('SERVER FAILED: ' + e.message);
    } finally {
      try { srv.child.kill(); } catch (e) { /* gone */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  // summary
  const rows = [];
  for (const m of MODELS) {
    const f = path.join(OUTDIR, m.name + '.json');
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const g = (set, lang) => { const x = j.rows.filter((r) => r.set === set && r.lang === lang); return x.length ? x.filter((r) => r.pass).length + '/' + x.length : '-'; };
    const avg = j.rows.reduce((a, r) => a + r.secs, 0) / j.rows.length;
    rows.push(`${m.name.padEnd(12)} core EN ${g('core', 'en').padEnd(6)} core TR ${g('core', 'tr').padEnd(6)} facts EN ${g('facts', 'en').padEnd(5)} facts TR ${g('facts', 'tr').padEnd(5)} avg ${avg.toFixed(1)} s/command`);
  }
  console.log('\n==== SUMMARY ====\n' + rows.join('\n'));
  process.exit(0);
})();
