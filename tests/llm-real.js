'use strict';
// MANUAL check of the built-in local model with the REAL runtime and the REAL model files (not part of `npm test`: it needs ~3.4 GB of model files).
//   node tests/llm-real.js [--models=<root>] [--backend=auto|cpu|vk]
// <root> must contain  qwen3.5-4b\Qwen3.5-4B-Q4_K_M.gguf  and  qwen3.5-4b\Qwen3.5-4B-mmproj-F16.gguf  (default: %APPDATA%\Video Editör models folder of the app,
// i.e. what the app's own "Download" produced). Prints the start-up time, the backend that was chosen and the speed of a text and an image request.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CATALOG, DEFAULT_MODEL_ID } = require('../src/main/llm/catalog');
const { createModelStore } = require('../src/main/llm/models');
const { createLlamaServer } = require('../src/main/llm/server');
const { resolveRuntime } = require('../src/main/llm/runtime');
const { inputArgs } = require('../src/main/media-guard');
const { resolveBinaries } = require('../src/main/ffmpeg-paths');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const root = arg('models', path.join(process.env.APPDATA || os.homedir(), 'VideoEditor', 'models'));
const backend = arg('backend', 'auto');

(async () => {
  const store = createModelStore({ root, catalog: CATALOG, stateFile: path.join(os.tmpdir(), 've-llm-real-verified.json'), fetch: () => { throw new Error('no network in this check'); } });
  let st = store.status(DEFAULT_MODEL_ID);
  console.log('model state: ' + st.state + ' (' + root + ')');
  if (st.state === 'unverified') {
    const t0 = Date.now();
    st = await store.verify(DEFAULT_MODEL_ID);
    console.log('verified in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s -> ' + st.state);
  }
  if (st.state !== 'ready') { console.log('the model is not ready: nothing to test'); process.exit(1); }
  const model = CATALOG[0];
  const srv = createLlamaServer({
    runtime: resolveRuntime({}), getBackend: () => backend, getIdleMs: () => 0, procs: { track() {} },
    getModel: () => ({ id: model.id, paths: store.paths(model.id), bytes: model.files.reduce((s, f) => s + f.size, 0) }),
    log: (m) => console.log('  [llm] ' + m),
  });
  const t0 = Date.now();
  const ep = await srv.ensure();
  console.log(`server ready in ${((Date.now() - t0) / 1000).toFixed(1)} s on ${ep.baseUrl} (${ep.backend}); GPU list: ${JSON.stringify(srv.info().detectedGpu)}`);
  const post = async (body) => {
    const t = Date.now();
    const res = await fetch(ep.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ep.key }, body: JSON.stringify(body) });
    const j = await res.json();
    return { secs: (Date.now() - t) / 1000, j, status: res.status };
  };
  const a = await post({ model: 'x', max_tokens: 24, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
  console.log(`text   : ${a.status} "${String((a.j.choices && a.j.choices[0].message.content) || '').trim()}" in ${a.secs.toFixed(1)} s`);
  const photo = arg('photo', path.join(__dirname, 'pilot', 'coco_vlm', '000000224200.jpg'));
  if (fs.existsSync(photo)) {
    const b64 = fs.readFileSync(photo).toString('base64');
    for (let i = 0; i < 2; i++) {
      const b = await post({ model: 'x', max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }, { type: 'text', text: 'Is there a dog in this image? Answer with one word: YES or NO.' }] }] });
      console.log(`vision : ${b.status} "${String((b.j.choices && b.j.choices[0].message.content) || '').trim()}" in ${b.secs.toFixed(1)} s (${b.j.usage ? b.j.usage.prompt_tokens : '?'} prompt tokens)`);
    }
  } else console.log('vision : skipped (no photo at ' + photo + ')');
  void inputArgs; void resolveBinaries;
  await srv.stop();
  console.log('stopped.');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.code || '', e.message, e.detail || ''); process.exit(1); });
