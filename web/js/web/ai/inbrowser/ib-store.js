// Storage of the model files of the in-browser assistant: downloading them from Hugging Face into the browser's storage (Cache Storage) and reading them back. The
// catalogue (ib-models.js) is the only authority: every byte that goes in is checked against the SHA-256 of its 16 MiB block, and every byte that comes out is checked
// again (a page of another repository of the same account shares this origin and can write into the storage; it cannot change the catalogue, which is part of the
// files the service worker verifies). No DOM, no worker globals: the cache, `fetch` and the hash function are passed in, so the Node tests run all of it.
import { IbError, HEADER_BYTES, HEADER_SHA, blockHashes, fileUrl, allowedUrl, blockVerifier, totalBytes } from './ib-core.js';

const MAX_RETRIES = 8;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 20000, 20000, 20000];
const PROGRESS_EVERY_MS = 200;
// A connection that gives nothing for this long while a file is coming is taken as broken (the rest is asked for with Range). The first answer may take much longer: a
// company proxy may check a big file completely before it passes the first byte on.
const STALL_MS = 60 * 1000;
const FIRST_ANSWER_MS = 5 * 60 * 1000;

const defaultDigest = (u8) => globalThis.crypto.subtle.digest('SHA-256', u8);
const abortError = () => new IbError('ABORTED', 'Cancelled');
// cancelling a stream that already failed rejects: nobody is waiting for that answer
const quiet = (p) => { try { Promise.resolve(p).catch(() => {}); } catch (e) { /* nothing to wait for */ } };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// what went wrong while storing a file -> an IbError the page can explain
export function explain(e) {
  if (e instanceof IbError) return e;
  const name = e && e.name;
  if (name === 'AbortError') return abortError();
  if (name === 'QuotaExceededError') return new IbError('IB_NO_SPACE', 'The browser has no room for the model', String(e.message || '').slice(0, 200));
  return new IbError('IB_DOWNLOAD_FAILED', 'The download failed', String((e && e.message) || e).slice(0, 200));
}

/* ------------------------------------------------------------------ what is stored */

export async function hasFile(cache, url, file) {
  let res;
  try { res = await cache.match(url); } catch (e) { return false; }
  return !!res && res.headers.get(HEADER_BYTES) === String(file.bytes) && res.headers.get(HEADER_SHA) === file.sha256;
}

// o: { host } -> [{ key, bytes, bytesInstalled, files, filesInstalled, installed }]. Only looks at what is stored (the sizes and hashes written with each file); the bytes are
// verified when they are read (readVerified).
export async function status(cache, models, o) {
  const out = [];
  for (const m of models) {
    let have = 0;
    let count = 0;
    for (const f of m.files) {
      if (await hasFile(cache, fileUrl(o.host, m, f), f)) { have += f.bytes; count++; }
    }
    out.push({ key: m.key, bytes: totalBytes(m), bytesInstalled: have, files: m.files.length, filesInstalled: count, installed: count === m.files.length });
  }
  return out;
}

export async function remove(cache, model, o) {
  let n = 0;
  for (const f of model.files) { if (await cache.delete(fileUrl(o.host, model, f))) n++; }
  return n;
}

// deletes what the catalogue does not list (files of an older revision of a model, leftovers); -> number of entries removed
export async function prune(cache, models, o) {
  const keep = new Set();
  for (const m of models) for (const f of m.files) keep.add(fileUrl(o.host, m, f));
  let n = 0;
  for (const req of await cache.keys()) if (!keep.has(req.url) && (await cache.delete(req))) n++;
  return n;
}

// A stored file as a Response whose body is checked block by block while it is read. A block that does not match fails the stream (and `onCorrupt(error, url)` is told: the
// library that reads the stream may wrap the error). undefined when the file is not (completely) stored.
export async function readVerified(cache, url, file, o) {
  let res;
  try { res = await cache.match(url); } catch (e) { return undefined; }
  if (!res || !res.body) return undefined;
  if (res.headers.get(HEADER_BYTES) !== String(file.bytes) || res.headers.get(HEADER_SHA) !== file.sha256) return undefined;
  const reader = res.body.pipeThrough(blockVerifier({ blockSize: o.chunk, hashes: blockHashes(file), size: file.bytes, digest: o.digest || defaultDigest })).getReader();
  const tapped = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (e) {
        if (o.onCorrupt) o.onCorrupt(e, url);
        throw e;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(tapped, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.bytes) } });
}

/* ------------------------------------------------------------------ downloading */

// The bytes of one file as one stream, however many connections it takes: when the connection breaks, the next request asks for the rest (Range) and the stream goes on
// where it stopped. Fatal: an answer that is not the file (HTTP 4xx), another host after the redirects, a size that is not the catalogue's.
//   o: { url, size, fetch, signal, onBytes(total so far), sleep?, stallMs?, firstAnswerMs? }
export function resumableBody(o) {
  const wait = o.sleep || sleep;
  let offset = 0;
  let skip = 0;
  let reader = null;
  let retries = 0;
  let sinceFailure = 0;
  let ctl = null; // the connection's own controller: the caller's signal ends it, and so does a stall
  let unlink = null;
  const fatal = (message, detail) => new IbError('IB_DOWNLOAD_FAILED', message, detail);

  // `promise` has to settle within `ms`, else the connection is ended and the attempt counts as a broken connection (the error carries `retry`, see the catch below)
  const stall = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error('The connection stalled');
      e.retry = true;
      try { ctl.abort(); } catch (x) { /* ended already */ }
      reject(e);
    }, ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  const release = () => {
    if (unlink) { unlink(); unlink = null; }
    ctl = null;
  };

  async function open() {
    release();
    ctl = new AbortController();
    if (o.signal) {
      const relay = () => { try { ctl.abort(); } catch (x) { /* ended already */ } };
      o.signal.addEventListener('abort', relay, { once: true });
      unlink = () => o.signal.removeEventListener('abort', relay);
    }
    const headers = offset > 0 ? { range: 'bytes=' + offset + '-' } : {};
    const res = await stall(o.fetch(o.url, { headers, signal: ctl.signal, redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }), o.firstAnswerMs || FIRST_ANSWER_MS);
    if (!allowedUrl(res.url || o.url)) throw fatal('The file came from an address that is not Hugging Face', String(res.url).slice(0, 120));
    if (res.status === 408 || res.status === 429 || res.status >= 500) { const e = new Error('HTTP ' + res.status); e.retry = true; throw e; }
    if (res.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
      if (!m || Number(m[1]) !== offset || Number(m[3]) !== o.size) throw fatal('The server answered with another part of the file than asked for');
      skip = 0;
    } else if (res.status === 200) {
      const len = res.headers.get('content-length');
      if (len !== null && Number(len) !== o.size) throw fatal('The file has another size than the catalogue says', len + ' instead of ' + o.size);
      skip = offset; // the server ignored the range: read the beginning again and drop it
    } else {
      throw fatal('Hugging Face answered with HTTP ' + res.status, String(res.status));
    }
    if (!res.body) throw fatal('The answer has no body');
    reader = res.body.getReader();
  }

  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (o.signal && o.signal.aborted) throw abortError();
        try {
          if (!reader) await open();
          const { done, value } = await stall(reader.read(), o.stallMs || STALL_MS);
          if (done) {
            reader = null;
            release();
            if (offset !== o.size) { const e = new Error('The connection closed before the end of the file'); e.retry = true; throw e; }
            controller.close();
            return;
          }
          let chunk = value;
          if (skip > 0) {
            const drop = Math.min(skip, chunk.length);
            skip -= drop;
            chunk = chunk.subarray(drop);
            if (!chunk.length) continue;
          }
          offset += chunk.length;
          sinceFailure += chunk.length;
          if (offset > o.size) throw fatal('More bytes than the catalogue says');
          if (o.onBytes) o.onBytes(offset);
          controller.enqueue(chunk);
          return;
        } catch (e) {
          if (reader) { quiet(reader.cancel()); reader = null; }
          release();
          if (o.signal && o.signal.aborted) throw abortError();
          if (e instanceof IbError) throw e; // fatal
          // a refused or broken connection (TypeError from fetch, a stream that failed, a 5xx, a stall): try again from where it stopped
          if (sinceFailure >= 1048576) retries = 0;
          sinceFailure = 0;
          if (++retries > MAX_RETRIES) throw fatal('The connection to Hugging Face keeps failing', String((e && e.message) || e).slice(0, 160));
          await wait(BACKOFF_MS[Math.min(retries - 1, BACKOFF_MS.length - 1)], o.signal);
        }
      }
    },
    cancel() {
      if (reader) { quiet(reader.cancel()); reader = null; }
      release();
    },
  });
}

// One file into the storage, checked on the way in. Nothing is stored unless every block matched (an error in the stream makes put() fail and leave nothing).
//   o: { cache, host, model, file, fetch, signal, onBytes, chunk, digest?, sleep?, stallMs?, firstAnswerMs? }
export async function downloadFile(o) {
  const url = fileUrl(o.host, o.model, o.file);
  const body = resumableBody({ url, size: o.file.bytes, fetch: o.fetch, signal: o.signal, onBytes: o.onBytes, sleep: o.sleep, stallMs: o.stallMs, firstAnswerMs: o.firstAnswerMs });
  const verified = body.pipeThrough(blockVerifier({ blockSize: o.chunk, hashes: blockHashes(o.file), size: o.file.bytes, digest: o.digest || defaultDigest }));
  const res = new Response(verified, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(o.file.bytes), [HEADER_BYTES]: String(o.file.bytes), [HEADER_SHA]: o.file.sha256 } });
  try {
    await o.cache.put(url, res);
  } catch (e) {
    try { await o.cache.delete(url); } catch (x) { /* nothing was stored */ }
    throw explain(e);
  }
}

// All files of a model that are not stored yet, the small ones first. Resolves when the model is complete.
//   o: { cache, host, chunk, model, fetch, signal, onProgress({ loaded, total, file, index, count }), estimate?() -> { usage, quota }, digest?, sleep?, stallMs?, firstAnswerMs? }
export async function install(o) {
  const todo = [];
  let have = 0;
  for (const f of o.model.files) {
    if (await hasFile(o.cache, fileUrl(o.host, o.model, f), f)) have += f.bytes; else todo.push(f);
  }
  const total = totalBytes(o.model);
  let last = 0;
  const report = (p, force) => {
    const now = Date.now();
    if (!o.onProgress || (!force && now - last < PROGRESS_EVERY_MS)) return;
    last = now;
    o.onProgress(p);
  };
  if (!todo.length) { report({ loaded: total, total, file: '', index: 0, count: 0 }, true); return { downloaded: 0, total }; }
  todo.sort((a, b) => a.bytes - b.bytes || (a.path < b.path ? -1 : 1));
  const need = todo.reduce((s, f) => s + f.bytes, 0);
  if (o.estimate) {
    let est = null;
    try { est = await o.estimate(); } catch (e) { est = null; }
    if (est && est.quota > 0 && est.quota - (est.usage || 0) < need * 1.05) throw new IbError('IB_NO_SPACE', 'The browser has no room for the model', JSON.stringify({ free: Math.max(0, est.quota - (est.usage || 0)), need }));
  }
  let done = have;
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    if (o.signal && o.signal.aborted) throw abortError();
    await downloadFile({ cache: o.cache, host: o.host, model: o.model, file: f, fetch: o.fetch, signal: o.signal, chunk: o.chunk, digest: o.digest, sleep: o.sleep, stallMs: o.stallMs, firstAnswerMs: o.firstAnswerMs, onBytes: (n) => report({ loaded: done + n, total, file: f.path, index: i + 1, count: todo.length }) });
    done += f.bytes;
    report({ loaded: done, total, file: f.path, index: i + 1, count: todo.length }, i === todo.length - 1);
  }
  return { downloaded: need, total };
}
