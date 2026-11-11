'use strict';
// IPC of the built-in local model: status, the one-click download (only when the user asks), verifying files that were put there by hand,
// removing, the folder / graphics-or-CPU settings, and the managed llama-server (see server.js).
//
// Network: the ONLY thing in the app that downloads anything. It runs in its own in-memory Chromium session (so the Windows proxy settings and
// certificate store of a company network apply) whose requests are limited by onBeforeRequest to the pinned model hosts (catalog.js), https only.
const os = require('os');
const path = require('path');
const { CATALOG, DEFAULT_MODEL_ID, isAllowedDownloadUrl, findModel, totalBytes } = require('./catalog');
const { createModelStore, LlmError } = require('./models');
const { createLlamaServer } = require('./server');
const { resolveRuntime } = require('./runtime');
const { assertLocalMediaPath } = require('../media-guard');

const BACKENDS = ['auto', 'cpu', 'vk'];

const errInfo = (e) => ({
  code: e && e.code ? String(e.code) : 'INTERNAL',
  message: String((e && e.message) || e).slice(0, 300),
  detail: e && e.detail ? String(e.detail).slice(0, 600) : '',
  needed: e && Number.isFinite(e.needed) ? e.needed : undefined,
  free: e && Number.isFinite(e.free) ? e.free : undefined,
});
const fail = (code, message) => ({ ok: false, error: { code, message: message || '', detail: '' } });

// ctx: { handle, getSettings, updateSettings, send, userDataPath, resourcesPath, appRoot, procs, session, pickDirectory(), log, test? }
// ctx.test (only with VE_TEST_MODE): { catalog, extraHosts, inProcess, stallMs, runtime }
function registerLlmIpc(ctx) {
  const test = ctx.test || {};
  const catalog = test.catalog || CATALOG;
  const model = findModel(DEFAULT_MODEL_ID, catalog) || catalog[0];
  const extraHosts = test.extraHosts || [];
  const defaultRoot = path.join(ctx.userDataPath, 'models');
  const rootNow = () => ctx.getSettings().llm.modelDir || defaultRoot;
  const log = (m) => { if (ctx.log) ctx.log(String(m)); };

  let dlSession = null;
  function downloadFetch(url, init) {
    if (!isAllowedDownloadUrl(url, extraHosts)) return Promise.reject(new Error('Blocked: not a model download host'));
    if (!dlSession) {
      dlSession = ctx.session.fromPartition('llm-download'); // in memory: no cookies, nothing stored
      dlSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));
      dlSession.setPermissionCheckHandler(() => false);
      // every hop of a redirect (the repository hands the file over to its CDN) is checked again
      dlSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedDownloadUrl(details.url, extraHosts) }));
    }
    return dlSession.fetch(url, { method: 'GET', headers: init.headers, signal: init.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
  }

  const store = createModelStore({
    root: rootNow(),
    catalog,
    stateFile: path.join(ctx.userDataPath, 'llm-verified.json'),
    fetch: downloadFetch,
    stallMs: test.stallMs,
  });
  const runtime = test.runtime || resolveRuntime({ resourcesPath: ctx.resourcesPath, appRoot: ctx.appRoot });
  const server = createLlamaServer({
    runtime,
    getModel: () => ({ id: model.id, paths: store.paths(model.id), bytes: totalBytes(model) }),
    getBackend: () => ctx.getSettings().llm.backend,
    getIdleMs: () => ctx.getSettings().llm.idleMinutes * 60000,
    procs: ctx.procs,
    pidFile: path.join(ctx.userDataPath, 'llama-server.json'),
    inProcess: test.inProcess,
    onStopped: () => ctx.send('llm:progress', { phase: 'stopped' }), // idle time-out, crash or "Stop model": the screen follows
    log,
  });
  server.cleanupStale().catch(() => {});

  const emit = (p) => ctx.send('llm:progress', p);

  function status() {
    const st = store.status(model.id);
    const s = ctx.getSettings().llm;
    const info = server.info();
    return {
      model: {
        id: model.id, name: model.name, license: model.license, licenseUrl: model.licenseUrl, source: model.source, vision: !!model.vision,
        state: st.state, have: st.have, total: st.total, files: st.files, busy: st.busy, progress: st.progress, needsRamGb: model.needsRamGb,
      },
      dir: store.getRoot(),
      defaultDir: defaultRoot,
      customDir: !!s.modelDir,
      runtime: { cpu: !!runtime.cpu, vk: !!runtime.vk },
      backend: s.backend,
      idleMinutes: s.idleMinutes,
      server: { phase: info.phase, backend: info.backend, error: info.error, fallbackFrom: info.fallbackFrom, busy: info.busy, detectedGpu: info.detectedGpu },
      ramGb: Math.round(os.totalmem() / 1073741824),
    };
  }

  // Files that were copied there by hand (or by IT) have to pass the SHA-256 check once before they are used.
  // A model folder the USER chose (shared, copied by IT, another drive) can be written by other people or programs, so its files are hashed again
  // once per app session before the first use; the app's own folder is private to the user (as private as the app itself) and keeps its record.
  let preparing = null;
  let rehashedRoot = '';
  function prepare() {
    if (!preparing) preparing = doPrepare().finally(() => { preparing = null; });
    return preparing;
  }
  async function doPrepare() {
    const custom = !!ctx.getSettings().llm.modelDir;
    if (custom && rehashedRoot !== store.getRoot() && store.status(model.id).state === 'ready') store.invalidate(model.id);
    let st = store.status(model.id);
    if (st.state === 'unverified') {
      emit({ phase: 'verify', done: 0, total: st.total });
      st = await store.verify(model.id, { onProgress: emit });
    }
    if (st.state !== 'ready') throw new LlmError('MODEL_NOT_READY', 'The local model is not installed (' + st.state + ')');
    if (custom) rehashedRoot = store.getRoot();
  }

  async function ensureServer(signal) {
    await prepare();
    const wasRunning = server.isRunning();
    if (!wasRunning) emit({ phase: 'loading' });
    try {
      const ep = await server.ensure({ signal });
      if (!wasRunning) emit({ phase: 'loaded', backend: ep.backend });
      return ep;
    } catch (e) {
      if (!wasRunning) {
        // a start that was stopped on purpose is not an error; a wait that was only abandoned leaves the start running (the banner keeps saying so)
        if (e && e.code === 'ABORTED') { if (server.info().phase !== 'starting') emit({ phase: 'stopped' }); } else emit({ phase: 'load-error', error: errInfo(e) });
      }
      throw e;
    }
  }

  ctx.handle('llm:status', () => status());

  // the user's click on "Stop model": the model is unloaded and its memory is released; the next use starts it again by itself
  ctx.handle('llm:stop', async () => {
    if (server.info().busy > 0) return { ok: false, error: errInfo(new LlmError('BUSY', 'A request is still running')), status: status() };
    try {
      await server.stop(); // tells the screen itself (onStopped)
      return { ok: true, status: status() };
    } catch (e) {
      return { ok: false, error: errInfo(e), status: status() };
    }
  });

  // the user's click on "Download": the only moment anything is fetched
  ctx.handle('llm:install', async () => {
    try {
      await store.download(model.id, { onProgress: emit });
      emit({ phase: 'done' });
      return { ok: true, status: status() };
    } catch (e) {
      const error = errInfo(e);
      emit({ phase: 'error', error });
      return { ok: false, error, status: status() };
    }
  });

  ctx.handle('llm:cancel', () => ({ ok: true, cancelled: store.cancel() }));

  ctx.handle('llm:remove', async () => {
    try {
      await server.stop();
      store.remove(model.id);
      return { ok: true, status: status() };
    } catch (e) {
      return { ok: false, error: errInfo(e), status: status() };
    }
  });

  // { modelDir?: '' | absolute local folder, backend?: 'auto'|'cpu'|'vk', idleMinutes?: 0..240 }
  ctx.handle('llm:set', async (e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    const patch = {};
    if (r.backend !== undefined) {
      if (!BACKENDS.includes(r.backend)) return fail('BAD_ARGS', 'backend');
      patch.backend = r.backend;
    }
    if (r.idleMinutes !== undefined) {
      const n = Math.round(Number(r.idleMinutes));
      if (!Number.isFinite(n)) return fail('BAD_ARGS', 'idleMinutes');
      patch.idleMinutes = Math.min(240, Math.max(0, n));
    }
    let newRoot = null;
    if (r.modelDir !== undefined) {
      if (store.busy()) return fail('BUSY');
      let dir = '';
      if (typeof r.modelDir === 'string' && r.modelDir.trim()) {
        const raw = r.modelDir.trim();
        // a folder on this computer only (no network share, no URL, no device path) and no relative path
        try { dir = assertLocalMediaPath(raw); } catch (err) { return fail('BAD_DIR', 'not a local folder'); }
        if (!path.isAbsolute(raw)) return fail('BAD_DIR', 'not an absolute path');
      }
      patch.modelDir = dir;
      newRoot = dir || defaultRoot;
    }
    if (newRoot !== null || (patch.backend !== undefined && patch.backend !== ctx.getSettings().llm.backend)) await server.stop();
    if (patch.backend !== undefined && patch.backend !== ctx.getSettings().llm.backend) server.forgetFallback();
    if (newRoot !== null) store.setRoot(newRoot);
    ctx.updateSettings({ llm: patch });
    return { ok: true, status: status() };
  });

  ctx.handle('llm:pick-dir', async () => ({ ok: true, path: (await ctx.pickDirectory()) || '' }));

  return {
    status,
    // the model must be installed; true when the assistant can use it right now
    ready: () => store.status(model.id).state === 'ready',
    isInstalled: () => { const s = store.status(model.id).state; return s === 'ready' || s === 'unverified'; },
    model,
    // Runs fn(endpoint) while the server runs (started if needed) and is not stopped for being idle.
    async use(fn, opts) {
      await ensureServer(opts && opts.signal);
      return server.use(fn, opts);
    },
    // starts the model in the background (the assistant pane was opened)
    warm() { ensureServer().catch(() => {}); },
    serverInfo: () => server.info(),
    stopServer: () => server.stop(),
    abortAll() { store.cancel(); },
  };
}

module.exports = { registerLlmIpc, errInfo };
