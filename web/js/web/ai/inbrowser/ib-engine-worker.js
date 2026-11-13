// The engine worker of the in-browser assistant: it runs the model. The service worker gives this script a Content-Security-Policy of its own (sw.js): it may load code
// from this site and compile WebAssembly, and it may NOT talk to anybody - a request that left this worker would be blocked by the browser, whatever the code in it tried.
// What it runs: the transformers.js library and the ONNX Runtime Web files that are vendored with the site (pinned by SHA-256, vendor/vendor-lock.json), on the
// model files that the download worker stored (every block of them is checked again against the catalogue, ib-models.js, when it is read here).
//
// The page names a model by its key in the catalogue and nothing else. Requests are served one after the other.
import { HOST, CHUNK, DTYPE, MODELS } from './ib-models.js';
import { IbError, CACHE_NAME, findModel, fileUrl, turnStarts, snapshotBounds, longestPrefix, evictSnapshots, repeatLoop, assertSealed } from './ib-core.js';
import * as store from './ib-store.js';

const post = (m) => self.postMessage(m);
const LIB_URL = new URL('../../../../vendor/transformers/transformers.min.js', import.meta.url).href;
const ORT_MJS = new URL('../../../../vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href;
const ORT_WASM = new URL('../../../../vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href;
const SNAPSHOTS = { maxCount: 6, maxBytes: 768 * 1024 * 1024 };
const PROGRESS_EVERY_MS = 250;

let T = null; // the library
let processor = null;
let model = null;
let loadedKey = '';
let sealed = false; // this worker has shown that it cannot reach the network (assertSealed)
let corrupt = null; // { url, error } of the last block that did not match its hash
let tick = 0;
const snaps = []; // saved decoder states: { ids: Int32Array, tensors, bytes, used }
const running = new Map(); // request id -> { stop, aborted }
let queue = Promise.resolve();

function errorInfo(e) {
  if (e instanceof IbError) return { code: e.code, message: String(e.message).slice(0, 300), detail: String(e.detail || '').slice(0, 300) };
  const text = String((e && e.message) || e);
  if (/not found locally|allowRemoteModels/i.test(text)) return { code: 'IB_NOT_INSTALLED', message: 'The model is not downloaded', detail: text.slice(0, 200) };
  return { code: 'IB_ENGINE', message: 'The model failed', detail: text.slice(0, 300) };
}

/* ------------------------------------------------------------------ the library */

async function library() {
  if (T) return T;
  if (!self.navigator || !self.navigator.gpu) throw new IbError('IB_NO_WEBGPU', 'This browser has no WebGPU in workers');
  T = await import(LIB_URL);
  const { env } = T;
  // The library refuses to look for files at all when both local and remote models are off, so local ones are "on" - and there are none: its fetch answers 404 to
  // everything, so it can never reach out (the files come from the cache below, which is looked at first). Remote models stay off.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = '/ve-ib-no-local-files/';
  env.fetch = () => Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = true;
  env.backends.onnx.wasm.wasmPaths = { mjs: ORT_MJS, wasm: ORT_WASM };
  env.backends.onnx.wasm.numThreads = 1; // no SharedArrayBuffer (and so no cross-origin isolation) needed
  try { if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = 'high-performance'; } catch (e) { /* the browser chooses */ }
  return T;
}

// the "cache" the library reads its files from: only the files of this model, only as stored by the download worker, and checked block by block while they are read
function modelCache(entry) {
  const files = new Map();
  for (const f of entry.files) {
    const pinned = fileUrl(HOST, entry, f);
    files.set(pinned, { url: pinned, file: f });
    // the library asks about some files (is there a tokenizer? is there a preprocessor configuration?) without naming the revision, i.e. as "main": here that is the commit
    // the catalogue pins - the same bytes, checked the same way
    files.set(HOST + '/' + entry.repo + '/resolve/main/' + f.path, { url: pinned, file: f });
  }
  return {
    async match(key) {
      const hit = files.get(key);
      if (!hit) return undefined;
      return store.readVerified(await caches.open(CACHE_NAME), hit.url, hit.file, { chunk: CHUNK, onCorrupt: (error, url) => { corrupt = { url, error }; } });
    },
    async put() { throw new Error('The model files are written by the download worker only'); },
    async delete() { return false; },
  };
}

/* ------------------------------------------------------------------ the saved decoder state (prefix cache) */

async function snapshotOf(cache, ids) {
  const tensors = [];
  let bytes = 0;
  for (const name of Object.keys(cache)) {
    const t = cache[name];
    const data = t.location === 'cpu' ? t.data : await t.ort_tensor.getData();
    const copy = data.slice();
    bytes += copy.byteLength;
    tensors.push({ name, type: t.type, dims: t.dims.slice(), data: copy });
  }
  return { ids: Int32Array.from(ids), tensors, bytes, used: ++tick };
}

function restore(snap) {
  const entries = {};
  for (const x of snap.tensors) entries[x.name] = new T.Tensor(x.type, x.data.slice(), x.dims);
  return new T.DynamicCache(entries);
}

const idsTensor = (ids, n) => new T.Tensor('int64', BigInt64Array.from(ids.slice(0, n), BigInt), [1, n]);
const onesTensor = (n) => new T.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);

/* ------------------------------------------------------------------ load / unload */

async function unload() {
  snaps.length = 0;
  const m = model;
  model = null;
  processor = null;
  loadedKey = '';
  if (m && typeof m.dispose === 'function') { try { await m.dispose(); } catch (e) { /* gone with the worker anyway */ } }
}

async function load(key, id) {
  const entry = findModel(MODELS, key);
  if (!entry) throw new IbError('IB_BAD_MODEL', 'Unknown model');
  if (model && loadedKey === key) return { already: true };
  // The policy that keeps this worker off the network comes with its script (sw.js). Before the model is read, that is tested here, not taken for granted: the two requests
  // below (to a data: address, which needs no network, and to huggingface.co) have to be refused, and the browser then writes two lines about each blocked request into the
  // console - expected, it is the test.
  if (!sealed) {
    try { console.info('[ve-ib] network test: a request to a data: address and one to huggingface.co from this worker must be blocked; the "violates the Content Security Policy" lines that follow are expected'); } catch (e) { /* no console */ }
    await assertSealed((u, i) => self.fetch(u, i));
    sealed = true;
  }
  await unload();
  const t0 = performance.now();
  const stored = (await store.status(await caches.open(CACHE_NAME), [entry], { host: HOST }))[0];
  if (!stored.installed) throw new IbError('IB_NOT_INSTALLED', 'The model is not downloaded');
  const lib = await library();
  corrupt = null;
  lib.env.customCache = modelCache(entry);

  const per = new Map();
  let last = 0;
  const total = entry.files.reduce((s, f) => s + f.bytes, 0);
  const progress_callback = (p) => {
    if (!p || typeof p.loaded !== 'number' || !p.file) return;
    per.set(p.file, p.loaded);
    const now = performance.now();
    if (now - last < PROGRESS_EVERY_MS) return;
    last = now;
    let loaded = 0;
    per.forEach((v) => { loaded += v; });
    post({ t: 'progress', id, phase: 'read', loaded: Math.min(loaded, total), total });
  };
  try {
    processor = await lib.AutoProcessor.from_pretrained(entry.repo, { revision: entry.revision, progress_callback });
    model = await lib.Qwen3_5ForConditionalGeneration.from_pretrained(entry.repo, { revision: entry.revision, dtype: entry.dtype || DTYPE, device: 'webgpu', progress_callback: (p) => { progress_callback(p); if (p && p.status === 'ready') post({ t: 'progress', id, phase: 'init' }); } });
  } catch (e) {
    const bad = corrupt;
    await unload();
    if (bad) {
      try { await (await caches.open(CACHE_NAME)).delete(bad.url); } catch (x) { /* the next start of the download notices */ }
      throw new IbError('IB_CORRUPT', 'A stored model file does not match its hash and was removed', String(bad.url).split('/resolve/')[1] || '');
    }
    throw e;
  }
  // The library sets the picture inputs to null for a continuation from a saved state and then runs the vision encoder on them (a multi-token suffix); text-only
  // continuations are what the prefix cache does, so the empty inputs are dropped.
  const orig = model.prepare_inputs_for_generation.bind(model);
  model.prepare_inputs_for_generation = (ids, inputs, cfg) => {
    const r = orig(ids, inputs, cfg);
    if (r) for (const k of ['pixel_values', 'pixel_values_videos', 'image_grid_thw', 'video_grid_thw']) if (r[k] == null) delete r[k];
    return r;
  };
  loadedKey = key;
  return { already: false, ms: Math.round(performance.now() - t0) };
}

// The first long prompt of a session costs about ten seconds more than the following ones (the GPU programs are made on first use): that is paid here, while the person is
// told the assistant is getting ready, not at their first request.
async function warmUp() {
  const t0 = performance.now();
  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(70);
  const text = processor.apply_chat_template([{ role: 'user', content: filler }], { add_generation_prompt: true, enable_thinking: false });
  const inputs = await processor(text, null);
  await model.generate(Object.assign({}, inputs, { max_new_tokens: 2, do_sample: false }));
  return Math.round(performance.now() - t0);
}

/* ------------------------------------------------------------------ chat */

const abortCheck = (run) => { if (run.aborted) throw new IbError('ABORTED', 'Cancelled'); };

// the model's answer to this prompt: { out (token ids of prompt + answer), reused (tokens read from a saved state), firstMs }
async function generateOnce(inputs, ids, req, run, useCache) {
  const t0 = performance.now();
  let firstMs = -1;
  let puts = 0;
  const written = [];
  // put() gets the prompt first, then every token as it is written ([[id]], see TextStreamer); a loop (repeatLoop) ends the answer: the stopping check follows right after put()
  const streamer = {
    put(value) {
      if (++puts === 2) firstMs = Math.round(performance.now() - t0);
      if (puts < 2) return;
      const row = value && value[0];
      if (row && row.length === 1) {
        written.push(Number(row[0]));
        if (written.length % 4 === 0 && repeatLoop(written)) { run.looped = true; run.stop.interrupt(); }
      }
    },
    end() {},
  };
  const stopping_criteria = run.stop;
  let cache = null;
  let reused = 0;
  try {
    if (useCache) {
      const startId = Number(processor.tokenizer.convert_tokens_to_ids(['<|im_start|>'])[0]);
      const bounds = snapshotBounds(turnStarts(ids, startId));
      const snap = longestPrefix(snaps, ids);
      let cur = 0;
      if (snap) { cache = restore(snap); cur = snap.ids.length; reused = cur; snap.used = ++tick; }
      for (const b of bounds) {
        if (b <= cur) continue;
        abortCheck(run);
        const r = await model.generate({ input_ids: idsTensor(ids, b), attention_mask: onesTensor(b), past_key_values: cache || new T.DynamicCache(), max_new_tokens: 1, do_sample: false, return_dict_in_generate: true });
        cache = r.past_key_values;
        cur = b;
        const s = await snapshotOf(cache, ids.slice(0, b));
        snaps.push(s);
        evictSnapshots(snaps, SNAPSHOTS, s);
      }
      abortCheck(run);
    }
    const opts = { input_ids: inputs.input_ids, attention_mask: inputs.attention_mask, max_new_tokens: req.maxNewTokens, do_sample: false, streamer, stopping_criteria };
    if (inputs.pixel_values) { opts.pixel_values = inputs.pixel_values; opts.image_grid_thw = inputs.image_grid_thw; }
    if (cache) opts.past_key_values = cache;
    const out = await model.generate(opts);
    return { out, reused, firstMs };
  } finally {
    if (cache) { try { await cache.dispose(); } catch (e) { /* freed with the model */ } }
  }
}

async function chat(req, id) {
  if (!model) throw new IbError('IB_NOT_LOADED', 'The model is not loaded');
  const run = { stop: new T.InterruptableStoppingCriteria(), aborted: false };
  running.set(id, run);
  try {
    const t0 = performance.now();
    const text = processor.apply_chat_template(req.messages, { add_generation_prompt: true, enable_thinking: false });
    let images = null;
    if (req.images && req.images.length) images = await Promise.all(req.images.map((buf) => T.RawImage.fromBlob(new Blob([buf], { type: 'image/jpeg' }))));
    const inputs = await processor(text, images);
    const ids = Array.from(inputs.input_ids.data, Number);
    const N = ids.length;
    abortCheck(run);
    let r;
    // a prompt without pictures goes through the saved decoder states; if that fails for any reason the plain way is taken (and the saved states are dropped)
    if (!images) {
      try {
        r = await generateOnce(inputs, ids, req, run, true);
      } catch (e) {
        if (run.aborted || (e instanceof IbError && e.code === 'ABORTED')) throw e;
        snaps.length = 0;
        r = await generateOnce(inputs, ids, req, run, false);
      }
    } else {
      r = await generateOnce(inputs, ids, req, run, false);
    }
    const generated = Array.from(r.out.data, Number).slice(N);
    const answer = processor.batch_decode(r.out.slice(null, [N, null]), { skip_special_tokens: true })[0];
    abortCheck(run);
    const eos = [].concat((model.generation_config && model.generation_config.eos_token_id) != null ? model.generation_config.eos_token_id : []);
    const finish = generated.length >= req.maxNewTokens && !eos.includes(generated[generated.length - 1]) ? 'length' : 'stop';
    return { text: String(answer || ''), promptTokens: N, completionTokens: generated.length, finish, reused: r.reused, firstMs: r.firstMs, ms: Math.round(performance.now() - t0), looped: !!run.looped };
  } finally {
    running.delete(id);
  }
}

/* ------------------------------------------------------------------ messages */

self.onmessage = (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  const id = Number.isSafeInteger(m.id) ? m.id : 0;
  if (m.t === 'abort') {
    const run = running.get(m.target);
    if (run) { run.aborted = true; try { run.stop.interrupt(); } catch (e) { /* not generating right now */ } }
    return;
  }
  queue = queue.then(async () => {
    try {
      if (m.t === 'hello') {
        post({ t: 'done', id, loaded: loadedKey, models: MODELS.map((x) => x.key) });
      } else if (m.t === 'load') {
        const r = await load(String(m.model || ''), id);
        let warmMs = 0;
        if (!r.already && m.warm !== false) {
          post({ t: 'progress', id, phase: 'warm' });
          warmMs = await warmUp();
        }
        post({ t: 'done', id, loaded: loadedKey, loadMs: r.ms || 0, warmMs });
      } else if (m.t === 'chat') {
        post({ t: 'done', id, result: await chat({ messages: m.messages, images: m.images, maxNewTokens: m.maxNewTokens }, id) });
      } else if (m.t === 'unload') {
        await unload();
        post({ t: 'done', id });
      } else {
        throw new IbError('BAD_REQUEST', 'Unknown request');
      }
    } catch (e) {
      post(Object.assign({ t: 'error', id }, errorInfo(e)));
    }
  });
};
