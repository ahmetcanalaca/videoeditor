// Video analysis with Azure Content Understanding in the web edition: what the desktop app does in src/main/ai/cu-service.js + cu-proxy.js, with the browser's
// own parts. The service logic (which parts of which file are needed, the cache keys, the upload, the polling, mapping the scenes onto the timeline, the
// compact answer for the model) is the desktop code, bundled unchanged; the pieces below replace what needs files and ffmpeg there:
//   - the reduced copy of the video  (<= 480 px on the short side, low bitrate) is made with the web export engine, in memory;
//   - the analysis cache             is kept in this browser (IndexedDB) instead of a folder;
//   - the fingerprint of a video     is read from the user's File.
// Nothing is uploaded before the user confirmed it (confirmUpload), and only to an address the user allowed.

const DB_NAME = 've-cu-cache';
const STORE = 'analysis';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 100 * 1024 * 1024;
const CACHE_MAX_FILE = 6 * 1024 * 1024;
const MAX_PROXY_BYTES = 150 * 1024 * 1024; // the service accepts 200 MB with analyzeBinary

const codeError = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

/* ------------------------------------------------------------------ the analysis cache (IndexedDB behind a synchronous Map) */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

const validScene = (s) => s && typeof s === 'object' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && Array.isArray(s.speech);

// The desktop code asks the cache synchronously (get / set): everything is loaded into memory before a request starts and written back in the background.
export class WebAnalysisCache {
  constructor() { this.map = new Map(); this.loaded = false; this.db = null; }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.db = await openDb();
      const store = this.db.transaction(STORE, 'readonly').objectStore(STORE);
      const keys = await wrap(store.getAllKeys());
      const values = await wrap(store.getAll());
      const now = Date.now();
      keys.forEach((k, i) => {
        const rec = values[i];
        if (rec && rec.v === 1 && now - Date.parse(rec.createdAt) <= CACHE_TTL_MS) this.map.set(String(k), rec);
        else this._drop(String(k));
      });
    } catch (e) { /* no storage: the analysis still works, it is just not remembered */ }
  }

  _drop(key) { if (this.db) { try { this.db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); } catch (e) { /* ignore */ } } }

  get(key) {
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const rec = this.map.get(key);
    if (!rec || !Array.isArray(rec.scenes) || !rec.scenes.every(validScene) || !Array.isArray(rec.shots)) return null;
    return rec;
  }

  set(key, record) {
    if (!/^[0-9a-f]{64}$/.test(key)) return false;
    const rec = Object.assign({ v: 1, createdAt: new Date().toISOString() }, record);
    const size = JSON.stringify(rec).length;
    if (size > CACHE_MAX_FILE) return false;
    this.map.set(key, rec);
    if (this.db) { try { this.db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec, key); } catch (e) { /* kept in memory only */ } }
    this._prune();
    return true;
  }

  info() {
    let bytes = 0;
    this.map.forEach((rec) => { bytes += JSON.stringify(rec).length; });
    return { files: this.map.size, bytes };
  }

  // the oldest entries go first until the cache is small enough
  _prune() {
    const sizes = [];
    this.map.forEach((rec, key) => sizes.push({ key, at: Date.parse(rec.createdAt) || 0, size: JSON.stringify(rec).length }));
    sizes.sort((a, b) => a.at - b.at);
    let total = sizes.reduce((s, x) => s + x.size, 0);
    for (const x of sizes) {
      if (total <= CACHE_MAX_BYTES) break;
      this.map.delete(x.key);
      this._drop(x.key);
      total -= x.size;
    }
  }

  async clear() {
    const n = this.map.size;
    this.map.clear();
    try {
      const db = this.db || await openDb();
      await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
    } catch (e) { /* nothing stored */ }
    return n;
  }
}

export async function clearCache() {
  const c = new WebAnalysisCache();
  await c.load();
  const n = await c.clear();
  return n;
}

export async function cacheInfo() {
  const c = new WebAnalysisCache();
  await c.load();
  return c.info();
}

/* ------------------------------------------------------------------ pieces the desktop service gets injected */

// Identifies the CONTENT of a file without reading all of it: size + three samples of 256 KB (start, middle, end). A renamed or moved copy hits the cache.
async function fingerprintFile(file) {
  const N = 256 * 1024;
  const size = file.size;
  const parts = [new TextEncoder().encode(String(size))];
  const take = async (pos) => {
    const len = Math.max(0, Math.min(N, size - pos));
    if (len) parts.push(new Uint8Array(await file.slice(pos, pos + len).arrayBuffer()));
  };
  await take(0);
  if (size > 3 * N) await take(Math.floor(size / 2) - N / 2);
  if (size > N) await take(size - Math.min(N, size - N));
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  parts.forEach((p) => { all.set(p, o); o += p.length; });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The reduced copy: the part [start, start + duration] of the video, short side 480 px at most (the service looks at about one picture per second, scaled to
// 512 x 512), low bitrate (about 0.04 MB per second: the 'proxy' quality of the export engine), no metadata. Made in memory by the export engine of the editor.
function makeProxyFactory(core, getMedia) {
  const made = new Map();
  async function makeProxy(o) {
    if (o.signal && o.signal.aborted) throw codeError('ABORTED', 'Cancelled');
    const m = getMedia(o.file);
    if (!m) throw codeError('PROXY_FAILED', 'The video is no longer open');
    const eng = await import('../engine/export.js');
    const id = String(o.file);
    const media = { [id]: Object.assign({}, m.info, { id }) };
    const seg = core.model.createSegment(media[id], { id: 'cu-proxy', in: o.start, out: Math.min(m.info.duration, o.start + Math.max(0.5, o.duration)) });
    let job;
    try {
      job = eng.runExport({
        segments: [seg], media, files: { [id]: m.file }, settings: { resolution: '480', aspect: 'auto', fps: '24', quality: 'proxy' }, outName: 'analysis-copy.mp4',
        onProgress: (p) => { if (o.onProgress) o.onProgress(Math.max(0, Math.min(1, p.fraction || 0))); },
      });
    } catch (e) {
      throw codeError('PROXY_FAILED', 'The video could not be prepared for analysis', { detail: String((e && e.message) || e).slice(0, 300) });
    }
    const onAbort = () => job.cancel();
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await job.promise;
    } catch (e) {
      if (e && e.code === 'CANCELLED') throw codeError('ABORTED', 'Cancelled');
      throw codeError('PROXY_FAILED', 'The video could not be prepared for analysis', { detail: String((e && (e.code || e.message)) || e).slice(0, 300) });
    } finally {
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
    }
    if (!res.blob || res.size < 1000) throw codeError('PROXY_FAILED', 'The video could not be prepared for analysis');
    if (res.size >= MAX_PROXY_BYTES) throw codeError('PROXY_TOO_LARGE', 'The reduced copy is larger than the service accepts');
    made.set(o.out, new Uint8Array(await res.blob.arrayBuffer()));
    return { file: o.out, bytes: res.size };
  }
  // read once: the copy is not kept after the upload
  function readFile(name) {
    const bytes = made.get(name);
    made.delete(name);
    if (!bytes) throw codeError('PROXY_FAILED', 'The reduced copy is gone');
    return Promise.resolve(bytes);
  }
  return { makeProxy, readFile };
}

// The credential of the analysis: the API key (header Ocp-Apim-Subscription-Key) or the pasted Microsoft Entra access token (Authorization: Bearer).
// A key is handed out for the address it was entered for only; a token only to an address the user confirmed (checked when the setting was saved).
function cuClient(core, st, vault, net, signal) {
  const auth = async () => {
    const v = vault();
    const key = st.credential === 'entra' ? v.key : (v.origin === st.cu.effectiveEndpoint ? v.key : '');
    if (!key) throw new core.providers.AiError('AUTH', 'No API key');
    return st.credential === 'entra' ? { name: 'Authorization', value: 'Bearer ' + key } : { name: 'Ocp-Apim-Subscription-Key', value: key };
  };
  return core.cu.createCuClient({ endpoint: st.cu.effectiveEndpoint, fetch: (u, i) => net.fetch(u, Object.assign({}, i, { signal: (i && i.signal) || signal })), auth, analyzerId: st.cu.analyzer, processingLocation: st.cu.location });
}

/* ------------------------------------------------------------------ public */

// o: { core, status, session, runSignal, runId, hooks: { pause, resume }, getMedia(id) -> { info, file }, vault() -> { key, origin }, net, emit(step), confirmUpload(plan),
//      timeoutMs, onCache(info) }
export function createAnalysis(o) {
  const controller = new AbortController();
  const abortWithRun = () => controller.abort();
  if (o.runSignal.aborted) abortWithRun(); else o.runSignal.addEventListener('abort', abortWithRun, { once: true });
  const cache = new WebAnalysisCache();
  const proxy = makeProxyFactory(o.core, o.getMedia);
  const svc = o.core.cuService.createVideoAnalysis({
    client: () => cuClient(o.core, o.status, o.vault, o.net, controller.signal),
    cache,
    pieces: o.session.originalMap(),
    total: o.session.baseTotal,
    // the "path" of a media is its id here: the helpers below look the file up by it
    getMedia: (id) => { const m = o.getMedia(id); return m ? Object.assign({}, m.info, { path: id }) : null; },
    fingerprint: async (id) => { const m = o.getMedia(id); if (!m) throw codeError('PROXY_FAILED', 'media is gone'); return fingerprintFile(m.file); },
    makeProxy: proxy.makeProxy,
    readFile: proxy.readFile,
    ffmpegPath: 'browser',
    procs: null,
    tmpDir: '/tmp',
    confirmUpload: o.confirmUpload,
    onProgress: (p) => o.emit({ kind: 'analysis', phase: p.phase, index: p.index, parts: p.parts, cached: p.cached, fraction: p.fraction, megabytes: p.megabytes, elapsedMs: p.elapsedMs }),
    signal: controller.signal,
    log: () => {},
  });
  return {
    async analyze(args) {
      o.hooks.pause();
      const timer = setTimeout(abortWithRun, o.timeoutMs);
      try {
        await cache.load();
        return await svc.analyze(args);
      } finally {
        clearTimeout(timer);
        o.hooks.resume();
        if (o.onCache) o.onCache(cache.info());
      }
    },
  };
}

// "Test the connection": the model deployments Content Understanding uses and the analyzer. Nothing is uploaded.
export async function test(o) {
  return cuClient(o.core, o.status, o.vault, o.net, o.signal).testConnection(o.signal);
}
