'use strict';
// Model files of the built-in local assistant: where they live, whether they are complete and genuine, downloading them (resumable,
// SHA-256-checked) and removing them. Pure Node (no Electron APIs): the network function is injected, so tests can run a local server.
//
// Layout:  <root>/<model id>/<file>                 the files, exactly as the catalog names them
//          <root>/<model id>/<file>.part            a download in progress (resumed with a Range request)
//          <stateFile>                              small JSON cache: "this exact file (size + modification time) already passed its SHA-256 check"
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class LlmError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'LlmError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const STALL_MS = 60 * 1000;
const MAX_ATTEMPTS = 4;
const DISK_MARGIN = 256 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (e) { return -1; } };
const rmQuiet = (p) => { try { fs.rmSync(p, { force: true }); } catch (e) { /* ignore */ } };

// SHA-256 of a file, streamed. onBytes(n) after every chunk; an abort stops it with LlmError('ABORTED').
async function sha256File(file, signal, onBytes) {
  const h = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  try {
    for await (const chunk of stream) {
      if (signal && signal.aborted) throw new LlmError('ABORTED', 'Cancelled');
      h.update(chunk);
      if (onBytes) onBytes(chunk.length);
    }
  } finally {
    stream.destroy();
  }
  return h.digest('hex');
}

function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
  return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) } : null;
}

function httpFailure(status) {
  const extra = { status, detail: 'HTTP ' + status }; // the renderer shows "detail" next to the message, so "could not be reached" is never the whole story
  if (status === 401 || status === 403) return new LlmError('DOWNLOAD_DENIED', 'The download server refused access (HTTP ' + status + ')', extra);
  if (status === 404 || status === 410) return new LlmError('DOWNLOAD_NOT_FOUND', 'The file is not on the server any more (HTTP ' + status + ')', extra);
  // a busy or failing server is worth another try; any other answer (400, 405, 407, 451 ...) will not change by itself, and it is NOT "unreachable"
  if (status === 408 || status === 429 || status >= 500) return new LlmError('NETWORK', 'The download server answered HTTP ' + status, extra);
  return new LlmError('HTTP_ERROR', 'The download server answered HTTP ' + status, extra);
}

// opts: { root, catalog, stateFile, fetch(url, init) -> Response, now() }
function createModelStore(opts) {
  const o = opts || {};
  let root = o.root;
  const catalog = o.catalog;
  const stateFile = o.stateFile;
  const state = { job: null, progress: null, bad: new Set(), verified: null };

  const model = (id) => {
    const m = catalog.find((x) => x.id === id);
    if (!m) throw new LlmError('UNKNOWN_MODEL', 'Unknown model ' + id);
    return m;
  };
  const dirOf = (m) => path.join(root, m.id);

  /* ------------------------------------------------ verified cache */

  function readVerified() {
    if (state.verified) return state.verified;
    try { state.verified = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { state.verified = {}; }
    if (!state.verified || typeof state.verified !== 'object') state.verified = {};
    return state.verified;
  }
  function writeVerified() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state.verified || {}), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (e) { /* the cache is a convenience: without it the files are simply hashed again */ }
  }
  function isVerified(p, f) {
    const rec = readVerified()[p];
    if (!rec) return false;
    try {
      const st = fs.statSync(p);
      return rec.sha256 === f.sha256 && rec.size === st.size && rec.mtimeMs === Math.round(st.mtimeMs);
    } catch (e) { return false; }
  }
  function markVerified(p, f) {
    const st = fs.statSync(p);
    readVerified()[p] = { sha256: f.sha256, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    state.bad.delete(p);
    writeVerified();
  }
  function forget(p) {
    delete readVerified()[p];
    writeVerified();
  }

  /* ------------------------------------------------ status */

  // The file as it lies on disk: the catalog name, or one of its aliases (e.g. what the model repository calls it).
  function locate(m, f) {
    const dir = dirOf(m);
    for (const name of [f.name].concat(f.aliases || [])) {
      const p = path.join(dir, name);
      if (exists(p)) return p;
    }
    return path.join(dir, f.name);
  }

  function fileStatus(m, f) {
    const p = locate(m, f);
    const size = sizeOf(p);
    const part = sizeOf(p + '.part');
    let st = 'missing';
    if (size === f.size) st = state.bad.has(p) ? 'bad' : (isVerified(p, f) ? 'ready' : 'unverified');
    else if (size >= 0) st = 'bad';
    else if (part > 0) st = 'partial';
    return { role: f.role, name: f.name, size: f.size, state: st, have: size === f.size ? f.size : Math.max(part, 0), path: p };
  }

  function status(id) {
    const m = model(id);
    const files = m.files.map((f) => fileStatus(m, f));
    const total = m.files.reduce((s, f) => s + f.size, 0);
    const have = files.reduce((s, f) => s + f.have, 0);
    let st;
    if (files.every((f) => f.state === 'ready')) st = 'ready';
    else if (files.some((f) => f.state === 'bad')) st = 'bad';
    else if (files.every((f) => f.state === 'ready' || f.state === 'unverified')) st = 'unverified';
    else if (have > 0) st = 'partial';
    else st = 'missing';
    return {
      id: m.id, name: m.name, state: st, dir: dirOf(m), total, have, files: files.map(({ path: p, ...rest }) => rest),
      busy: state.job ? state.job.kind : null,
      progress: state.job ? state.progress : null,
    };
  }

  // Absolute paths of the files, only if every file is present AND genuine.
  function paths(id) {
    const m = model(id);
    const out = {};
    for (const f of m.files) {
      const fs2 = fileStatus(m, f);
      if (fs2.state !== 'ready') throw new LlmError('MODEL_NOT_READY', 'The model file ' + f.name + ' is ' + fs2.state);
      out[f.role] = fs2.path;
    }
    return out;
  }

  /* ------------------------------------------------ jobs */

  function startJob(kind, fn) {
    if (state.job) return { kind, promise: Promise.reject(new LlmError('BUSY', 'Another model operation is running (' + state.job.kind + ')')) };
    const controller = new AbortController();
    const job = { kind, controller, promise: null };
    state.job = job;
    state.progress = null;
    job.promise = (async () => {
      try { return await fn(controller.signal, job); } finally { state.job = null; state.progress = null; }
    })();
    return job;
  }

  function reporter(job, totalBytes, onProgress) {
    let done = 0;
    let last = 0;
    const t0 = Date.now();
    const emit = (extra, force) => {
      const now = Date.now();
      if (!force && now - last < 200) return;
      last = now;
      const secs = Math.max(0.001, (now - t0) / 1000);
      state.progress = Object.assign({ phase: job.kind, done, total: totalBytes, bytesPerSec: Math.round(done / secs) }, extra);
      if (onProgress) onProgress(state.progress);
    };
    return { add(n, extra) { done += n; emit(extra, false); }, set(n, extra) { done = n; emit(extra, true); }, flush(extra) { emit(extra, true); } };
  }

  /* ------------------------------------------------ verify */

  // Hashes every present file that has not passed the check yet. Resolves with the new status; rejects with HASH_MISMATCH.
  function verify(id, vopts) {
    const m = model(id);
    const job = startJob('verify', async (signal, self) => {
      const todo = m.files.map((f) => ({ f, s: fileStatus(m, f) })).filter((x) => x.s.state === 'unverified' || x.s.state === 'bad');
      const rep = reporter(self, todo.reduce((s, x) => s + x.f.size, 0), vopts && vopts.onProgress);
      let base = 0;
      for (const { f, s } of todo) {
        if (s.state === 'bad' && sizeOf(s.path) !== f.size) throw new LlmError('HASH_MISMATCH', 'The file ' + f.name + ' has the wrong size', { file: f.name });
        const hash = await sha256File(s.path, signal, (n) => rep.add(n, { file: f.name }));
        base += f.size;
        if (hash !== f.sha256) {
          state.bad.add(s.path);
          throw new LlmError('HASH_MISMATCH', 'The file ' + f.name + ' is not the expected one (SHA-256 differs)', { file: f.name });
        }
        markVerified(s.path, f);
        rep.set(base, { file: f.name });
      }
      return status(id);
    });
    return job.promise;
  }

  /* ------------------------------------------------ download */

  async function writeAll(fh, buf) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      off += bytesWritten;
    }
  }

  // A failed write is no network problem: a full disk gets its own message, anything else (read-only or vanished folder, antivirus lock) says so.
  function writeFailure(e) {
    const code = e && e.code;
    if (code === 'ENOSPC' || code === 'EDQUOT') return new LlmError('DISK_FULL', 'The disk is full', { detail: code });
    return new LlmError('WRITE_FAILED', 'The model file could not be written', { detail: String((e && e.code) || (e && e.message) || e).slice(0, 120) });
  }

  // One attempt to bring `part` to f.size. Returns when the file is complete (not yet verified).
  async function fetchInto(f, part, signal, onBytes) {
    const fetchFn = o.fetch;
    let have = Math.max(0, sizeOf(part)); // sizeOf is -1 for a file that does not exist yet: that must never become "Range: bytes=-1-"
    if (have > f.size) { rmQuiet(part); have = 0; }
    if (have === f.size) return;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) throw new LlmError('ABORTED', 'Cancelled'); signal.addEventListener('abort', onAbort, { once: true }); }
    let stalled = false;
    let timer = null;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; controller.abort(); }, o.stallMs || STALL_MS); };
    let fh = null;
    try {
      arm();
      let res;
      try {
        res = await fetchFn(f.url, { headers: have > 0 ? { range: 'bytes=' + have + '-' } : {}, signal: controller.signal });
      } catch (e) {
        if (signal && signal.aborted) throw new LlmError('ABORTED', 'Cancelled');
        throw new LlmError('NETWORK', stalled ? 'The connection stalled' : 'Network error', { detail: String((e && e.message) || e).slice(0, 200) });
      }
      let append = false;
      if (have > 0 && res.status === 206) {
        const cr = parseContentRange(res.headers.get('content-range'));
        if (!cr || cr.start !== have) throw new LlmError('NETWORK', 'The server answered with an unexpected range');
        append = true;
      } else if (res.status === 416) {
        // the partial file does not fit what the server has: start again from nothing
        rmQuiet(part);
        throw new LlmError('NETWORK', 'Resuming was refused; restarting', { restart: true });
      } else if (res.status === 200) {
        have = 0; // no (or ignored) Range: the whole file follows
      } else {
        throw httpFailure(res.status);
      }
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0 && have + len !== f.size) throw new LlmError('SIZE_MISMATCH', 'The server announced ' + (have + len) + ' bytes, the catalog says ' + f.size, { file: f.name });
      if (!res.body || typeof res.body.getReader !== 'function') throw new LlmError('NETWORK', 'The response has no body');
      try {
        fh = await fs.promises.open(part, append ? 'a' : 'w');
      } catch (e) {
        throw writeFailure(e);
      }
      let got = have;
      onBytes(have, true);
      const reader = res.body.getReader();
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal && signal.aborted) throw new LlmError('ABORTED', 'Cancelled');
          throw new LlmError('NETWORK', stalled ? 'The connection stalled' : 'The connection was interrupted', { detail: String((e && e.message) || e).slice(0, 200) });
        }
        if (chunk.done) break;
        arm();
        got += chunk.value.byteLength;
        if (got > f.size) throw new LlmError('SIZE_MISMATCH', 'The server sent more than the expected ' + f.size + ' bytes', { file: f.name });
        try {
          await writeAll(fh, Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength));
        } catch (e) {
          throw writeFailure(e);
        }
        onBytes(chunk.value.byteLength, false);
      }
      if (got !== f.size) throw new LlmError('NETWORK', 'The download ended early (' + got + ' of ' + f.size + ' bytes)', { incomplete: true });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      controller.abort(); // after an error the connection must not stay open until garbage collection (no-op once the body was read completely)
      if (fh) { try { await fh.close(); } catch (e) { /* ignore */ } }
    }
  }

  function freeSpace(dir) {
    try {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) { return Infinity; }
  }

  function download(id, dopts) {
    const m = model(id);
    const onProgress = dopts && dopts.onProgress;
    const job = startJob('download', async (signal, self) => {
      const dir = dirOf(m);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        throw writeFailure(e);
      }
      const need = m.files.reduce((s, f) => {
        const fst = fileStatus(m, f);
        return s + (fst.state === 'ready' || fst.state === 'unverified' ? 0 : f.size - (fst.state === 'partial' ? fst.have : 0));
      }, 0);
      const free = (o.freeSpace || freeSpace)(dir);
      if (need > 0 && free < need + DISK_MARGIN) throw new LlmError('DISK_FULL', 'Not enough free disk space', { needed: need, free });
      const total = m.files.reduce((s, f) => s + f.size, 0);
      const rep = reporter(self, total, onProgress);
      let base = 0;
      for (const f of m.files) {
        const cur = fileStatus(m, f);
        const final = path.join(dir, f.name);
        if (cur.state === 'ready') { base += f.size; rep.set(base, { file: f.name }); continue; }
        if (cur.state === 'bad') { rmQuiet(cur.path); forget(cur.path); state.bad.delete(cur.path); }
        if (cur.state === 'unverified') {
          const hash = await sha256File(cur.path, signal, (n) => rep.add(n, { file: f.name, verifying: true }));
          if (hash === f.sha256) { markVerified(cur.path, f); base += f.size; rep.set(base, { file: f.name }); continue; }
          rmQuiet(cur.path);
        }
        const part = final + '.part';
        let ok = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
          try {
            await fetchInto(f, part, signal, (n, absolute) => { if (absolute) rep.set(base + n, { file: f.name }); else rep.add(n, { file: f.name }); });
            ok = true;
          } catch (e) {
            // a dropped or stalled connection resumes from what is already on disk; everything else is final
            if (!(e instanceof LlmError) || e.code !== 'NETWORK' || attempt === MAX_ATTEMPTS) throw e;
            await sleep(Math.min(8000, (dopts && dopts.retryDelayMs !== undefined ? dopts.retryDelayMs : 500) * Math.pow(2, attempt - 1)));
            if (signal.aborted) throw new LlmError('ABORTED', 'Cancelled');
          }
        }
        // the file is complete: check it BEFORE it gets its real name
        const hash = await sha256File(part, signal, (n) => rep.add(0, { file: f.name, verifying: true, verified: n }));
        if (hash !== f.sha256) {
          rmQuiet(part);
          throw new LlmError('HASH_MISMATCH', 'The downloaded file ' + f.name + ' does not match its SHA-256', { file: f.name });
        }
        rmQuiet(final);
        try {
          await renameWithRetry(part, final);
        } catch (e) {
          throw writeFailure(e);
        }
        markVerified(final, f);
        base += f.size;
        rep.set(base, { file: f.name });
      }
      return status(id);
    });
    return job.promise;
  }

  async function renameWithRetry(from, to) {
    for (let i = 1; i <= 20; i++) {
      try { fs.renameSync(from, to); return; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i === 20) throw e;
        await sleep(500); // antivirus scanners lock a freshly written multi-gigabyte file for a moment
      }
    }
  }

  function cancel() {
    if (state.job) state.job.controller.abort();
    return !!state.job;
  }

  function remove(id) {
    const m = model(id);
    if (state.job) throw new LlmError('BUSY', 'Another model operation is running');
    for (const f of m.files) {
      for (const name of [f.name].concat(f.aliases || [])) {
        const p = path.join(dirOf(m), name);
        forget(p);
        rmQuiet(p);
        rmQuiet(p + '.part');
      }
    }
    try { fs.rmdirSync(dirOf(m)); } catch (e) { /* not empty or gone */ }
    return status(id);
  }

  // Forgets that the files of this model passed the SHA-256 check: the next verify() hashes them again (see doPrepare in ipc.js).
  function invalidate(id) {
    const m = model(id);
    if (state.job) return;
    for (const f of m.files) forget(locate(m, f));
  }

  return {
    status, paths, verify, download, cancel, remove, invalidate,
    setRoot(dir) { root = dir; },
    getRoot: () => root,
    busy: () => (state.job ? state.job.kind : null),
    LlmError,
  };
}

module.exports = { createModelStore, LlmError, sha256File };
