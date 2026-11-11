'use strict';
// Runs the two VLM tests (natural photos + screen-recording frames) against several vision-capable local models, one llama-server at a time.
//   node vlm-all.js [config1,config2,...]      configs: q4b-cpu, g4e4b-cpu, q4b-vk, g4e4b-vk
//   env VLM_PER_KIND=1 (smoke test: one picture per kind), VLM_SCREEN=0 (skip the screen-recording frames)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer, waitReady } = require('./llm-srv');

const ROOT = __dirname;
const PORT = 18096;
const OUTDIR = path.join(ROOT, 'work', 'vlm');
fs.mkdirSync(OUTDIR, { recursive: true });
const M = (f) => path.join(ROOT, 'models', f);

const CONFIGS = {
  'q4b-cpu': { model: M('Qwen3.5-4B-Q4_K_M.gguf'), mmproj: M('Qwen3.5-4B-mmproj-F16.gguf'), backend: 'cpu', extra: '--parallel 1' },
  'g4e4b-cpu': { model: M('gemma-4-E4B-it-Q4_K_M.gguf'), mmproj: M('gemma-4-E4B-mmproj-F16.gguf'), backend: 'cpu', extra: '--parallel 1' },
  'q4b-vk': { model: M('Qwen3.5-4B-Q4_K_M.gguf'), mmproj: M('Qwen3.5-4B-mmproj-F16.gguf'), backend: 'vk', extra: '--parallel 1' },
  'g4e4b-vk': { model: M('gemma-4-E4B-it-Q4_K_M.gguf'), mmproj: M('gemma-4-E4B-mmproj-F16.gguf'), backend: 'vk', extra: '--parallel 1' },
};
const want = (process.argv[2] || 'q4b-cpu,g4e4b-cpu').split(',').filter(Boolean);
const SCREEN = process.env.VLM_SCREEN === '0' ? false : true;

function run(script, args, logName) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(path.join(OUTDIR, logName));
    const c = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT });
    c.stdout.on('data', (d) => { log.write(d); process.stdout.write(d); });
    c.stderr.on('data', (d) => { log.write(d); process.stdout.write(d); });
    c.on('close', () => { log.end(); resolve(); });
  });
}

(async () => {
  for (const name of want) {
    const cfg = CONFIGS[name];
    if (!cfg) { console.log('unknown config ' + name); continue; }
    console.log('\n################ ' + name + ' ################');
    const srv = startServer({ model: cfg.model, mmproj: cfg.mmproj, port: PORT, ctx: 8192, threads: 12, backend: cfg.backend, thinking: '0', extra: cfg.extra });
    try {
      const ms = await waitReady(srv, PORT, 300000);
      console.log('server ready in ' + (ms / 1000).toFixed(1) + ' s (pid ' + srv.child.pid + ')');
      await run('vlm-coco.js', [String(PORT), name, process.env.VLM_PER_KIND || '999'], name + '.coco.log');
      if (SCREEN) await run('vlm-test.js', [path.join(ROOT, 'rec', 'run2', 'rec.mp4'), path.join(ROOT, 'rec', 'run2', 'meta.json'), String(PORT), name, '1'], name + '.screen.log');
    } catch (e) {
      console.log('SERVER FAILED: ' + e.message);
    } finally {
      try { srv.child.kill(); } catch (e) { /* gone */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  console.log('\nALL DONE');
  process.exit(0);
})();
