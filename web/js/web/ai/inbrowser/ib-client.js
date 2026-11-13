// Page side of the in-browser assistant: an AI model that runs in this tab, on the computer's graphics card (WebGPU), with nothing to install.
//   support()                       can this browser and this graphics card run it? (WebGPU with 16-bit shaders)
//   catalog()                       the models that can be downloaded: name, size, licence (ib-models.js)
//   createClient(opts)              the connection to the two workers:
//     .status()                     what is stored in the browser's storage
//     .install(key, { onProgress, signal })    download a model (checked against its SHA-256 while it is stored; ib-dl-worker.js)
//     .remove(key)                  delete it again
//     .fetchFor(key, { AiError, onPhase })     a fetch() for the provider adapters of the assistant: the two requests they make (POST /v1/chat/completions, GET /v1/models)
//                                              are answered by the model in this tab - no network is involved (ib-engine-worker.js)
//     .unload()                     free the memory the model uses (the engine worker is ended)
// The page itself may not talk to anybody but its own origin (CSP connect-src 'self'); the files come through the download worker, whose policy (sw.js) allows Hugging
// Face, and the model runs in the engine worker, whose policy allows nobody.
import { MODELS } from './ib-models.js';
import { IbError, LIMITS, findModel, totalBytes, routeOf, toEngineRequest, completionBody, modelsBody, followThrough } from './ib-core.js';

const IDLE_MS = 10 * 60 * 1000; // the model is taken out of memory after this long without a request (a computer that is slow for no visible reason is no good)
const MIN_BUFFER = 1024 * 1024 * 1024;

/* ------------------------------------------------------------------ can this computer do it? */

// -> { ok, code?, f16, maxBuffer, gpu: { vendor, architecture, description }, memoryGB } ; code: IB_INSECURE | IB_NO_WEBGPU | IB_NO_F16 | IB_NO_SW
export async function support() {
  const memoryGB = Number(navigator.deviceMemory) || 0; // Chrome rounds this down to at most 8
  if (!globalThis.isSecureContext) return { ok: false, code: 'IB_INSECURE', memoryGB };
  if (!navigator.gpu) return { ok: false, code: 'IB_NO_WEBGPU', memoryGB };
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { adapter = null; }
  if (!adapter) return { ok: false, code: 'IB_NO_WEBGPU', memoryGB };
  const info = adapter.info || {};
  const gpu = { vendor: String(info.vendor || ''), architecture: String(info.architecture || ''), description: String(info.description || info.device || '') };
  const f16 = adapter.features.has('shader-f16');
  const maxBuffer = Number(adapter.limits && adapter.limits.maxBufferSize) || 0;
  if (!f16) return { ok: false, code: 'IB_NO_F16', f16, maxBuffer, gpu, memoryGB };
  if (maxBuffer < MIN_BUFFER) return { ok: false, code: 'IB_NO_WEBGPU', f16, maxBuffer, gpu, memoryGB };
  if (!(await serviceWorkerInControl())) return { ok: false, code: 'IB_NO_SW', f16, maxBuffer, gpu, memoryGB };
  return { ok: true, f16, maxBuffer, gpu, memoryGB };
}

// The policies that keep the two workers where they belong (the engine without a network, the downloads at Hugging Face only) and the check of the vendored libraries
// are given by the service worker (sw.js), not by the files themselves. Without one in control of this page (a private window of a browser that has none, a policy that
// switches them off, an unregistered worker) the model is not used. The first visit is under control a moment after the page has loaded, so that is waited for.
async function serviceWorkerInControl() {
  const sw = globalThis.navigator && navigator.serviceWorker;
  if (!sw) return false;
  if (sw.controller) return true;
  const within = (ms, p) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);
  try { await within(8000, sw.ready); } catch (e) { return false; }
  if (!sw.controller) await within(3000, new Promise((resolve) => sw.addEventListener('controllerchange', resolve, { once: true })));
  return !!sw.controller;
}

// the model that is offered first: the balanced one (the best one needs about twice the memory; a computer that reports little memory is warned in the panel instead)
export function recommend() {
  return 'qwen3.5-2b';
}

export const catalog = () => MODELS.map((m) => ({ key: m.key, name: m.name, tier: m.tier, bytes: totalBytes(m), vision: !!m.vision, license: m.license, repo: m.repo, revision: m.revision }));
export const known = (key) => !!findModel(MODELS, key);
export { IbError, followThrough };

/* ------------------------------------------------------------------ one worker, asked one thing at a time or many */

function rpc(spawn) {
  let worker = null;
  let seq = 0;
  const jobs = new Map();

  function failAll(err) {
    for (const job of jobs.values()) job.reject(err);
    jobs.clear();
  }
  function stop(err) {
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
    worker = null;
    failAll(err || new IbError('ABORTED', 'Cancelled'));
  }
  function onMessage(event) {
    const m = event.data;
    const job = m && jobs.get(m.id);
    if (!job) return;
    if (m.t === 'progress') { if (job.onProgress) job.onProgress(m); return; }
    jobs.delete(m.id);
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (m.t === 'error') job.reject(new IbError(String(m.code || 'IB_ENGINE'), String(m.message || ''), String(m.detail || '')));
    else job.resolve(m);
  }
  function ensure() {
    if (worker) return worker;
    let w;
    try { w = spawn(); } catch (e) { throw e instanceof IbError ? e : new IbError('IB_WORKER', 'The worker could not start', String((e && e.message) || e).slice(0, 200)); }
    w.onmessage = onMessage;
    w.onerror = (e) => {
      if (worker !== w) return;
      stop(new IbError('IB_WORKER', 'The worker could not run', String((e && e.message) || '').slice(0, 200)));
    };
    worker = w;
    return w;
  }
  // msg: { t, ... } -> the worker's answer; opts: { onProgress(m), signal, transfer }
  function call(msg, opts) {
    const o = opts || {};
    if (o.signal && o.signal.aborted) return Promise.reject(new IbError('ABORTED', 'Cancelled'));
    let w;
    try { w = ensure(); } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const job = { resolve, reject, onProgress: o.onProgress, signal: o.signal, onAbort: null };
      jobs.set(id, job);
      if (o.signal) {
        job.onAbort = () => {
          if (!jobs.has(id)) return;
          jobs.delete(id);
          try { w.postMessage({ t: 'abort', target: id }); } catch (e) { /* the worker is gone */ }
          reject(new IbError('ABORTED', 'Cancelled'));
        };
        o.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      try { w.postMessage(Object.assign({ id }, msg), o.transfer || []); } catch (e) { jobs.delete(id); reject(new IbError('IB_WORKER', 'The worker did not take the request', String((e && e.message) || e).slice(0, 200))); }
    });
  }
  return { call, stop, running: () => !!worker };
}

/* ------------------------------------------------------------------ the client */

function defaultSpawn(kind) {
  // (see serviceWorkerInControl: the policy of the worker comes with its script from the service worker)
  if (!(globalThis.navigator && navigator.serviceWorker && navigator.serviceWorker.controller)) throw new IbError('IB_NO_SW', 'No service worker is in control of this page');
  const file = kind === 'dl' ? './ib-dl-worker.js' : './ib-engine-worker.js';
  return new Worker(new URL(file, import.meta.url), { type: 'module', name: 've-ib-' + kind });
}

// opts: { spawn(kind: 'dl' | 'engine') -> Worker-like (tests), idleMs, onState() }
export function createClient(opts) {
  const o = opts || {};
  const spawn = o.spawn || defaultSpawn;
  const dl = rpc(() => spawn('dl'));
  const engine = rpc(() => spawn('engine'));
  const idleMs = o.idleMs > 0 ? o.idleMs : IDLE_MS;
  let loaded = '';
  let loading = null; // { key, promise }
  let idle = null;
  let counter = 0;

  const changed = () => { if (typeof o.onState === 'function') { try { o.onState(); } catch (e) { /* a listener's problem */ } } };
  const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { unload(); }, idleMs); };

  function unload() {
    clearTimeout(idle);
    const had = loaded || (loading && loading.key);
    engine.stop();
    loaded = '';
    loading = null;
    if (had) changed();
  }

  async function status() {
    const r = await dl.call({ t: 'status' });
    return { models: r.models || [], storage: r.storage || { usage: 0, quota: 0, persisted: false }, installing: r.installing || '', loaded };
  }

  async function install(key, io) {
    if (!findModel(MODELS, key)) throw new IbError('IB_BAD_MODEL', 'Unknown model');
    const x = io || {};
    const r = await dl.call({ t: 'install', model: key }, { signal: x.signal, onProgress: x.onProgress ? (m) => x.onProgress({ loaded: m.loaded, total: m.total, file: m.file, index: m.index, count: m.count }) : undefined });
    changed();
    return r;
  }

  async function remove(key) {
    if (!findModel(MODELS, key)) throw new IbError('IB_BAD_MODEL', 'Unknown model');
    if (loaded === key || (loading && loading.key === key)) unload();
    const r = await dl.call({ t: 'remove', model: key });
    changed();
    return r;
  }

  // Makes sure this model is in the engine's memory (reads the files, makes the GPU programs: a minute on the first use, as long as the tab lives). io: { onProgress, signal }
  function ensureLoaded(key, io) {
    if (loaded === key) return Promise.resolve();
    if (loading && loading.key === key) return loading.promise;
    const x = io || {};
    if (loaded || loading) unload(); // another model: its memory goes first
    const promise = (async () => {
      try {
        await engine.call({ t: 'load', model: key }, { signal: x.signal, onProgress: x.onProgress ? (m) => x.onProgress({ phase: m.phase, loaded: m.loaded, total: m.total }) : undefined });
        loaded = key;
        changed();
      } catch (e) {
        // a worker that failed to load is in no state to be used again: the next try starts a new one
        if (!(e instanceof IbError) || e.code !== 'ABORTED') { engine.stop(); loaded = ''; }
        if (e instanceof IbError && e.code === 'IB_ENGINE') throw new IbError('IB_LOAD_FAILED', 'The model could not be loaded', e.detail);
        throw e;
      } finally {
        loading = null;
      }
    })();
    loading = { key, promise };
    return promise;
  }

  // req: the result of toEngineRequest; -> { text, promptTokens, completionTokens, finish, reused, firstMs, ms }
  async function chat(key, req, io) {
    const x = io || {};
    clearTimeout(idle);
    await ensureLoaded(key, { signal: x.signal, onProgress: x.onProgress });
    clearTimeout(idle);
    if (x.onProgress) x.onProgress({ phase: 'ready' }); // (the model is in memory: whatever the screen said about loading is over)
    try {
      const r = await engine.call({ t: 'chat', messages: req.messages, images: req.images.map((u8) => u8.buffer), maxNewTokens: req.maxNewTokens }, { signal: x.signal, transfer: req.images.map((u8) => u8.buffer) });
      return r.result;
    } catch (e) {
      if (e instanceof IbError && e.code !== 'ABORTED' && e.code !== 'BAD_REQUEST') { engine.stop(); loaded = ''; changed(); } // after a failure of the GPU the worker starts again
      throw e;
    } finally {
      if (loaded) armIdle();
    }
  }

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failure = (status, message, code) => json(status, { error: { message, type: 'invalid_request_error', code: code || 'ib_error' } });

  // opts: { AiError (the adapters' error class), onPhase(phase) }
  function fetchFor(key, f) {
    const x = f || {};
    return async function inBrowserFetch(url, init) {
      const i = init || {};
      const method = String(i.method || 'GET').toUpperCase();
      const route = routeOf(url, method);
      if (!route) throw new TypeError('This request is not served');
      if (route === 'models') return json(200, modelsBody([key]));
      if (i.signal && i.signal.aborted) throw new DOMException('The request was cancelled', 'AbortError');
      if (typeof i.body !== 'string' || i.body.length > LIMITS.bodyBytes) return failure(413, 'The request is too large');
      let req;
      try { req = toEngineRequest(JSON.parse(i.body)); } catch (e) { return failure(400, e instanceof IbError ? e.message : 'The request is not valid JSON'); }
      try {
        const phase = (p) => { if (typeof x.onPhase === 'function') x.onPhase(p); };
        const r = await chat(key, req, { signal: i.signal, onProgress: (m) => phase({ step: m.phase, loaded: m.loaded, total: m.total }) });
        return json(200, completionBody({ id: ++counter, model: key, text: r.text, finish: r.finish, promptTokens: r.promptTokens, completionTokens: r.completionTokens }));
      } catch (e) {
        if (e instanceof IbError) {
          if (e.code === 'ABORTED') throw new DOMException('The request was cancelled', 'AbortError');
          if (e.code === 'BAD_REQUEST') return failure(400, e.message);
          if (x.AiError) throw new x.AiError(e.code, e.message, { detail: e.detail });
        }
        throw e;
      }
    };
  }

  return {
    status, install, remove, ensureLoaded, chat, fetchFor, unload,
    loaded: () => loaded,
    loading: () => (loading ? loading.key : ''),
    dispose() { clearTimeout(idle); dl.stop(); engine.stop(); loaded = ''; loading = null; },
  };
}
