'use strict';
// Second round of the vision experiments (run AFTER vlm-all.js):  left/right referring expressions + TR/EN query hand-over,
// one llama-server per model. The box format comes from the first round (work/vlm/<name>.coco.json).
//   node vlm-extra.js [config1,config2,...]          env VLM_EXTRA_STEPS=refer,translate,translate2 (default refer,translate)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer, waitReady } = require('./llm-srv');

const ROOT = __dirname;
const PORT = 18097;
const OUTDIR = path.join(ROOT, 'work', 'vlm');
fs.mkdirSync(OUTDIR, { recursive: true });
const M = (f) => path.join(ROOT, 'models', f);
const CONFIGS = {
  'q4b-cpu': { model: M('Qwen3.5-4B-Q4_K_M.gguf'), mmproj: M('Qwen3.5-4B-mmproj-F16.gguf'), backend: 'cpu' },
  'g4e4b-cpu': { model: M('gemma-4-E4B-it-Q4_K_M.gguf'), mmproj: M('gemma-4-E4B-mmproj-F16.gguf'), backend: 'cpu' },
  'q4b-vk': { model: M('Qwen3.5-4B-Q4_K_M.gguf'), mmproj: M('Qwen3.5-4B-mmproj-F16.gguf'), backend: 'vk' },
  'g4e4b-vk': { model: M('gemma-4-E4B-it-Q4_K_M.gguf'), mmproj: M('gemma-4-E4B-mmproj-F16.gguf'), backend: 'vk' },
};
const want = (process.argv[2] || 'q4b-cpu,g4e4b-cpu').split(',').filter(Boolean);

function run(script, args, logName, env) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(path.join(OUTDIR, logName));
    const c = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, env: Object.assign({}, process.env, env || {}) });
    c.stdout.on('data', (d) => { log.write(d); process.stdout.write(d); });
    c.stderr.on('data', (d) => { log.write(d); process.stdout.write(d); });
    c.on('close', () => { log.end(); resolve(); });
  });
}

(async () => {
  for (const name of want) {
    const cfg = CONFIGS[name];
    if (!cfg) continue;
    let format = 'k1000';
    try { format = JSON.parse(fs.readFileSync(path.join(OUTDIR, name + '.coco.json'), 'utf8')).summary.ground.bestConvention; } catch (e) { /* default */ }
    console.log('\n################ ' + name + ' (box format ' + format + ') ################');
    const srv = startServer({ model: cfg.model, mmproj: cfg.mmproj, port: PORT, ctx: 8192, threads: 12, backend: cfg.backend, thinking: '0', extra: '--parallel 1' });
    try {
      const ms = await waitReady(srv, PORT, 300000);
      console.log('server ready in ' + (ms / 1000).toFixed(1) + ' s (pid ' + srv.child.pid + ')');
      const steps = (process.env.VLM_EXTRA_STEPS || 'refer,translate').split(',');
      if (steps.includes('refer')) await run('vlm-refer.js', [String(PORT), name, format], name + '.refer.log');
      if (steps.includes('translate')) await run('translate-test.js', [String(PORT), name], name + '.translate.log');
      if (steps.includes('translate2')) await run('translate-test2.js', [String(PORT), name], name + '.translate2.log');
    } catch (e) {
      console.log('SERVER FAILED: ' + e.message);
    } finally {
      try { srv.child.kill(); } catch (e) { /* gone */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  console.log('\nEXTRA DONE');
  process.exit(0);
})();
