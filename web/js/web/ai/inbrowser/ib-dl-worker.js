// The download worker of the in-browser assistant. The service worker gives this script a Content-Security-Policy of its own (sw.js): it may talk to this site, to
// huggingface.co and to *.hf.co and to nobody else, and it runs no code but its own. It fetches the files of a model that the user chose, checks every byte against the
// catalogue (ib-models.js) on the way into the browser's storage, and answers the page's questions about what is stored. It never runs a model (that is the engine worker,
// which cannot reach the network at all).
//
// The page names a model by its key in the catalogue and nothing else: no address, no file name and no hash comes from the page.
import { HOST, CHUNK, MODELS } from './ib-models.js';
import { IbError, CACHE_NAME, findModel } from './ib-core.js';
import * as store from './ib-store.js';

const post = (m) => self.postMessage(m);
const jobs = new Map(); // request id -> AbortController
let installing = '';

function errorInfo(e) {
  const err = e instanceof IbError ? e : store.explain(e);
  return { code: err.code, message: String(err.message).slice(0, 300), detail: String(err.detail || '').slice(0, 300) };
}

async function storage() {
  let est = null;
  try { est = await navigator.storage.estimate(); } catch (e) { est = null; }
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch (e) { persisted = false; }
  return { usage: est ? est.usage || 0 : 0, quota: est ? est.quota || 0 : 0, persisted };
}

self.onmessage = async (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  const id = Number.isSafeInteger(m.id) ? m.id : 0;
  try {
    if (m.t === 'abort') {
      const c = jobs.get(m.target);
      if (c) c.abort();
      return;
    }
    const cache = await caches.open(CACHE_NAME);
    if (m.t === 'hello') {
      post({ t: 'done', id, host: HOST, models: MODELS.map((x) => x.key) });
    } else if (m.t === 'status') {
      post({ t: 'done', id, models: await store.status(cache, MODELS, { host: HOST }), storage: await storage(), installing });
    } else if (m.t === 'install') {
      const model = findModel(MODELS, m.model);
      if (!model) throw new IbError('IB_BAD_MODEL', 'Unknown model');
      if (installing) throw new IbError('IB_BUSY', 'Another model is being downloaded', installing);
      installing = model.key;
      const controller = new AbortController();
      jobs.set(id, controller);
      try {
        // ask the browser to keep the files (best effort: without it the browser may delete them when the disk is full)
        try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* the answer is only a hint */ }
        const r = await store.install({
          cache, host: HOST, chunk: CHUNK, model, signal: controller.signal, fetch: (u, i) => fetch(u, i),
          estimate: () => navigator.storage.estimate(),
          onProgress: (p) => post({ t: 'progress', id, loaded: p.loaded, total: p.total, file: p.file, index: p.index, count: p.count }),
        });
        await store.prune(cache, MODELS, { host: HOST }); // files of an older revision
        post({ t: 'done', id, downloaded: r.downloaded, total: r.total });
      } finally {
        jobs.delete(id);
        installing = '';
      }
    } else if (m.t === 'remove') {
      const model = findModel(MODELS, m.model);
      if (!model) throw new IbError('IB_BAD_MODEL', 'Unknown model');
      if (installing === model.key) throw new IbError('IB_BUSY', 'This model is being downloaded', installing);
      post({ t: 'done', id, removed: await store.remove(cache, model, { host: HOST }) });
    } else {
      throw new IbError('BAD_REQUEST', 'Unknown request');
    }
  } catch (e) {
    post(Object.assign({ t: 'error', id }, errorInfo(e)));
  }
};
