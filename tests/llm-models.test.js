'use strict';
// Tests of src/main/llm/models.js against a local HTTP server that behaves like a model host (and misbehaves on demand):
// resumable downloads, SHA-256 verification, dropped connections, servers that ignore Range, corrupted files, cancel, stalls, pre-seeded files.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createModelStore, LlmError, sha256File } = require('../src/main/llm/models');
const catalogLib = require('../src/main/llm/catalog');

let failures = 0;
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)${detail ? '  ' + detail : ''}`);
  } catch (e) {
    failures++;
    results.push(false);
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms)\n      ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || 'values differ') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };
const truthy = (c, m) => { if (!c) throw new Error(m || 'not true'); };
async function rejectsWith(promise, code) {
  try { await promise; } catch (e) { eq(e && e.code, code, 'error code (' + (e && e.message) + ')'); return e; }
  throw new Error('expected a rejection with ' + code);
}

// deterministic "model files"
const makeBytes = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const A = makeBytes(3 * 1024 * 1024 + 123, 1);
const B = makeBytes(1024 * 1024 + 7, 2);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function startServer() {
  const state = { mode: 'normal', requests: [], dropAfter: 0, dropped: 0, stallAfter: 0 };
  const files = { '/a.bin': A, '/b.bin': B };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    state.requests.push({ url, range: range ? Number(range[1]) : null, raw: req.headers.range });
    // like the real host (Hugging Face / its CDN): a Range header that is not "bytes=<digits>-" is a 400, not "ignored"
    if (req.headers.range !== undefined && !/^bytes=\d+-\d*$/.test(req.headers.range)) { res.writeHead(400); res.end(); return; }
    if (url === '/redirect/a.bin') { res.writeHead(302, { location: '/a.bin' }); res.end(); return; }
    if (url === '/gone.bin') { res.writeHead(404); res.end(); return; }
    if (url === '/denied.bin') { res.writeHead(403); res.end(); return; }
    if (url === '/bad.bin') { res.writeHead(400); res.end(); return; }
    let body = files[url];
    if (!body) { res.writeHead(404); res.end(); return; }
    if (state.mode === 'corrupt') { body = Buffer.from(body); body[body.length >> 1] ^= 0xff; }
    let start = 0;
    let status = 200;
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
    if (range && state.mode !== 'ignoreRange') {
      start = Number(range[1]);
      if (start >= body.length) { res.writeHead(416, { 'content-range': 'bytes */' + body.length }); res.end(); return; }
      status = 206;
      headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    const slice = body.subarray(start);
    headers['content-length'] = state.mode === 'lie' ? String(slice.length + 5) : String(slice.length);
    res.writeHead(status, headers);
    const chunk = 256 * 1024;
    let off = 0;
    const pump = () => {
      if (res.destroyed) return;
      if (state.dropAfter && state.dropped === 0 && off >= state.dropAfter) { state.dropped++; res.destroy(); return; }
      if (state.stallAfter && off >= state.stallAfter) return; // go silent: neither data nor close
      if (off >= slice.length) { res.end(); return; }
      res.write(slice.subarray(off, off + chunk));
      off += chunk;
      setTimeout(pump, state.mode === 'slow' ? 40 : 0);
    };
    pump();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, base: 'http://127.0.0.1:' + server.address().port })));
}

function makeCatalog(base, over) {
  return [{
    id: 'test-model', name: 'Test model', family: 'test', boxFormat: 'k1000', vision: true, license: 'x', needsRamGb: 1,
    files: [
      { role: 'model', name: 'model.gguf', aliases: [], url: base + (over && over.aUrl ? over.aUrl : '/a.bin'), size: A.length, sha256: sha(A) },
      { role: 'mmproj', name: 'model-mmproj.gguf', aliases: ['mmproj.gguf'], url: base + '/b.bin', size: B.length, sha256: sha(B) },
    ],
  }];
}

function makeStore(dir, catalog, extra) {
  return createModelStore(Object.assign({ root: path.join(dir, 'models'), catalog, stateFile: path.join(dir, 'verified.json'), fetch: (u, i) => fetch(u, i) }, extra));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-llm-models-'));
  const srv = await startServer();
  const fresh = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
  const reset = () => { srv.state.mode = 'normal'; srv.state.requests.length = 0; srv.state.dropAfter = 0; srv.state.dropped = 0; srv.state.stallAfter = 0; };
  const tdir = (id) => (store) => path.join(store.getRoot(), id);

  await test('L01 download: missing -> ready, files genuine, no .part left, progress monotonic and complete', async () => {
    reset();
    const dir = fresh('l01');
    const store = makeStore(dir, makeCatalog(srv.base));
    eq(store.status('test-model').state, 'missing');
    const prog = [];
    const st = await store.download('test-model', { onProgress: (p) => prog.push(p) });
    eq(st.state, 'ready');
    const d = tdir('test-model')(store);
    truthy(fs.readFileSync(path.join(d, 'model.gguf')).equals(A) && fs.readFileSync(path.join(d, 'model-mmproj.gguf')).equals(B), 'file content differs');
    truthy(!fs.readdirSync(d).some((n) => n.endsWith('.part')), '.part left behind');
    for (let i = 1; i < prog.length; i++) truthy(prog[i].done >= prog[i - 1].done, 'progress went backwards');
    const last = prog[prog.length - 1];
    eq(last.done, A.length + B.length, 'final progress');
    const paths = store.paths('test-model');
    eq(paths.model, path.join(d, 'model.gguf'));
    // a fresh download asks for the whole file: NO Range header at all (a "bytes=-1-" is answered with HTTP 400 by the real host)
    for (const u of ['/a.bin', '/b.bin']) {
      const first = srv.state.requests.find((r) => r.url === u);
      truthy(first && first.raw === undefined, u + ' fresh download sent a Range header: ' + JSON.stringify(first));
    }
    return `${prog.length} progress events`;
  });

  await test('L02 a dropped connection resumes with a Range request instead of starting over', async () => {
    reset();
    srv.state.dropAfter = 1024 * 1024;
    const store = makeStore(fresh('l02'), makeCatalog(srv.base));
    const st = await store.download('test-model', { retryDelayMs: 10 });
    eq(st.state, 'ready');
    const aReqs = srv.state.requests.filter((r) => r.url === '/a.bin');
    truthy(aReqs.length >= 2, 'no second request');
    truthy(aReqs[1].range && aReqs[1].range > 0 && aReqs[1].range < A.length, 'second request did not resume: ' + JSON.stringify(aReqs));
    return 'resumed at byte ' + aReqs[1].range;
  });

  await test('L03 a server that ignores Range (always 200) still ends with a correct file', async () => {
    reset();
    const dir = fresh('l03');
    const store = makeStore(dir, makeCatalog(srv.base));
    // a half-finished download from an earlier run
    const d = tdir('test-model')(store);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'model.gguf.part'), A.subarray(0, 500000));
    srv.state.mode = 'ignoreRange';
    const st = await store.download('test-model', { retryDelayMs: 10 });
    eq(st.state, 'ready');
    truthy(fs.readFileSync(path.join(d, 'model.gguf')).equals(A), 'content differs');
  });

  await test('L04 a corrupted download is refused (HASH_MISMATCH), the partial file is deleted and no final file appears', async () => {
    reset();
    srv.state.mode = 'corrupt';
    const store = makeStore(fresh('l04'), makeCatalog(srv.base));
    const e = await rejectsWith(store.download('test-model'), 'HASH_MISMATCH');
    eq(e.file, 'model.gguf');
    const d = tdir('test-model')(store);
    truthy(!fs.existsSync(path.join(d, 'model.gguf')) && !fs.existsSync(path.join(d, 'model.gguf.part')), 'bad file kept');
    eq(store.status('test-model').state, 'missing');
  });

  await test('L05 cancel keeps the partial file; the next download resumes and completes', async () => {
    reset();
    srv.state.mode = 'slow';
    const store = makeStore(fresh('l05'), makeCatalog(srv.base));
    let cancelled = false;
    const p = store.download('test-model', { onProgress: (pr) => { if (!cancelled && pr.done > 400000) { cancelled = true; store.cancel(); } } });
    await rejectsWith(p, 'ABORTED');
    const d = tdir('test-model')(store);
    const partSize = fs.statSync(path.join(d, 'model.gguf.part')).size;
    truthy(partSize > 0 && partSize < A.length, 'partial file missing: ' + partSize);
    eq(store.status('test-model').state, 'partial');
    srv.state.mode = 'normal';
    srv.state.requests.length = 0;
    const st = await store.download('test-model');
    eq(st.state, 'ready');
    truthy(srv.state.requests.find((r) => r.url === '/a.bin').range > 0, 'did not resume');
    return `cancelled at ${partSize} bytes`;
  });

  await test('L06 a new store (app restart) trusts the verified cache; a file changed behind its back is caught', async () => {
    reset();
    const dir = fresh('l06');
    const cat = makeCatalog(srv.base);
    await makeStore(dir, cat).download('test-model');
    const again = makeStore(dir, cat);
    eq(again.status('test-model').state, 'ready', 'after restart');
    // same size, different bytes (and a new modification time)
    const d = tdir('test-model')(again);
    const corrupted = Buffer.from(B); corrupted[100] ^= 1;
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(d, 'model-mmproj.gguf'), corrupted);
    eq(makeStore(dir, cat).status('test-model').state, 'unverified', 'after the change');
    const s2 = makeStore(dir, cat);
    const e = await rejectsWith(s2.verify('test-model'), 'HASH_MISMATCH');
    eq(e.file, 'model-mmproj.gguf');
    eq(s2.status('test-model').state, 'bad');
    truthy(() => s2.paths('test-model'), '');
    let threw = false; try { s2.paths('test-model'); } catch (x) { threw = x.code === 'MODEL_NOT_READY'; }
    truthy(threw, 'paths() handed out a bad file');
  });

  await test('L07 files placed by an administrator (also under the repository name) are verified, then used', async () => {
    reset();
    const dir = fresh('l07');
    const store = makeStore(dir, makeCatalog(srv.base));
    const d = tdir('test-model')(store);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'model.gguf'), A);
    fs.writeFileSync(path.join(d, 'mmproj.gguf'), B); // alias name
    eq(store.status('test-model').state, 'unverified');
    const prog = [];
    const st = await store.verify('test-model', { onProgress: (p) => prog.push(p) });
    eq(st.state, 'ready');
    eq(store.paths('test-model').mmproj, path.join(d, 'mmproj.gguf'));
    eq(srv.state.requests.length, 0, 'verification must not touch the network');
    truthy(prog.length > 0 && prog[prog.length - 1].done === A.length + B.length, 'verify progress incomplete');
  });

  await test('L08 a file of the wrong size is reported bad and replaced by the next download', async () => {
    reset();
    const store = makeStore(fresh('l08'), makeCatalog(srv.base));
    const d = tdir('test-model')(store);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'model.gguf'), Buffer.from('truncated'));
    eq(store.status('test-model').state, 'bad');
    const st = await store.download('test-model');
    eq(st.state, 'ready');
    truthy(fs.readFileSync(path.join(d, 'model.gguf')).equals(A));
  });

  await test('L09 HTTP 404 and 403 give distinct, non-retried errors', async () => {
    reset();
    const s1 = makeStore(fresh('l09a'), makeCatalog(srv.base, { aUrl: '/gone.bin' }));
    const e1 = await rejectsWith(s1.download('test-model'), 'DOWNLOAD_NOT_FOUND');
    eq(e1.detail, 'HTTP 404', 'the HTTP status must reach the user');
    eq(srv.state.requests.filter((r) => r.url === '/gone.bin').length, 1, 'a 404 must not be retried');
    const s2 = makeStore(fresh('l09b'), makeCatalog(srv.base, { aUrl: '/denied.bin' }));
    const e2 = await rejectsWith(s2.download('test-model'), 'DOWNLOAD_DENIED');
    eq(e2.detail, 'HTTP 403', 'the HTTP status must reach the user');
  });

  await test('L09b any other HTTP answer (400, 407 ...) is HTTP_ERROR with its status, not "unreachable", and is not retried', async () => {
    reset();
    const s = makeStore(fresh('l09c'), makeCatalog(srv.base, { aUrl: '/bad.bin' }));
    const e = await rejectsWith(s.download('test-model'), 'HTTP_ERROR');
    eq(e.detail, 'HTTP 400');
    eq(srv.state.requests.filter((r) => r.url === '/bad.bin').length, 1, 'a 400 must not be retried');
  });

  await test('L10 a server that announces another size than the catalog is refused before anything is written', async () => {
    reset();
    srv.state.mode = 'lie';
    const store = makeStore(fresh('l10'), makeCatalog(srv.base));
    await rejectsWith(store.download('test-model'), 'SIZE_MISMATCH');
    const d = tdir('test-model')(store);
    truthy(!fs.existsSync(path.join(d, 'model.gguf.part')), 'a partial file was written');
  });

  await test('L11 not enough disk space is reported up front (DISK_FULL) with the numbers', async () => {
    reset();
    const store = makeStore(fresh('l11'), makeCatalog(srv.base), { freeSpace: () => 1024 });
    const e = await rejectsWith(store.download('test-model'), 'DISK_FULL');
    truthy(e.needed === A.length + B.length && e.free === 1024, 'numbers: ' + e.needed + ' / ' + e.free);
    eq(srv.state.requests.length, 0, 'no request may be made');
  });

  await test('L12 only one model operation at a time (BUSY)', async () => {
    reset();
    srv.state.mode = 'slow';
    const store = makeStore(fresh('l12'), makeCatalog(srv.base));
    const p = store.download('test-model');
    await rejectsWith(store.download('test-model'), 'BUSY');
    await rejectsWith(store.verify('test-model'), 'BUSY');
    eq(store.busy(), 'download');
    srv.state.mode = 'normal';
    store.cancel();
    await rejectsWith(p, 'ABORTED');
    eq(store.busy(), null);
  });

  await test('L13 remove() deletes the files, partial files and the verified-cache entries', async () => {
    reset();
    const dir = fresh('l13');
    const store = makeStore(dir, makeCatalog(srv.base));
    await store.download('test-model');
    const st = store.remove('test-model');
    eq(st.state, 'missing');
    truthy(!fs.existsSync(tdir('test-model')(store)), 'folder still there');
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'verified.json'), 'utf8'));
    eq(Object.keys(cache).length, 0, 'cache entries left');
  });

  await test('L14 redirects are followed (the model host forwards to its content delivery network)', async () => {
    reset();
    const store = makeStore(fresh('l14'), makeCatalog(srv.base, { aUrl: '/redirect/a.bin' }));
    const st = await store.download('test-model');
    eq(st.state, 'ready');
  });

  await test('L15 a connection that goes silent is detected (stall) and the download resumes', async () => {
    reset();
    srv.state.stallAfter = 700000;
    const store = makeStore(fresh('l15'), makeCatalog(srv.base), { stallMs: 400 });
    setTimeout(() => { srv.state.stallAfter = 0; }, 150); // the second connection is healthy
    const st = await store.download('test-model', { retryDelayMs: 10 });
    eq(st.state, 'ready');
  });

  await test('L16 the download host allow-list: model repository and its CDN only, https only', async () => {
    const ok = (u, x) => catalogLib.isAllowedDownloadUrl(u, x);
    truthy(ok('https://huggingface.co/a/b/resolve/x/f.gguf') && ok('https://cdn-lfs.hf.co/x') && ok('https://cas-bridge.xethub.hf.co/x') && ok('https://cdn-lfs.huggingface.co/x'), 'allowed hosts refused');
    truthy(!ok('https://evilhuggingface.co/x') && !ok('https://huggingface.co.evil.example/x') && !ok('http://huggingface.co/x') && !ok('https://user:pw@huggingface.co/x') && !ok('file:///C:/x') && !ok('https://example.com/x'), 'a bad host was allowed');
    truthy(!ok('http://127.0.0.1:9/x') && ok('http://127.0.0.1:9/x', ['127.0.0.1']), 'loopback rules');
    // the shipped catalog is complete and consistent
    for (const m of catalogLib.CATALOG) for (const f of m.files) truthy(f.size > 0 && /^[0-9a-f]{64}$/.test(f.sha256) && ok(f.url) && /\/resolve\/[0-9a-f]{40}\//.test(f.url), 'catalog entry ' + f.name);
  });

  await test('L17 sha256File matches crypto and reports its progress', async () => {
    const f = path.join(tmp, 'sha.bin');
    fs.writeFileSync(f, A);
    let n = 0;
    eq(await sha256File(f, null, (c) => { n += c; }), sha(A));
    eq(n, A.length);
  });

  await test('L18 a folder that cannot be written to is reported as WRITE_FAILED, a full disk as DISK_FULL (neither is a network problem)', async () => {
    reset();
    const dir = fresh('l18');
    const store = makeStore(dir, makeCatalog(srv.base));
    // a DIRECTORY sits where the partial file has to be created: opening it for writing fails
    fs.mkdirSync(path.join(store.getRoot(), 'test-model', 'model.gguf.part'), { recursive: true });
    const e = await rejectsWith(store.download('test-model', { retryDelayMs: 10 }), 'WRITE_FAILED');
    truthy(e.detail, 'the reason is passed on');
    eq(srv.state.requests.filter((r) => r.url === '/a.bin').length, 1, 'a write problem is not retried like a network problem');
    // the model folder itself cannot be created (a FILE blocks the way)
    const blocked = path.join(fresh('l18b'), 'models');
    fs.writeFileSync(blocked, 'x');
    await rejectsWith(makeStore(path.dirname(blocked), makeCatalog(srv.base)).download('test-model'), 'WRITE_FAILED');
    // ENOSPC from the file system
    const realOpen = fs.promises.open;
    fs.promises.open = async () => { const err = new Error('no space'); err.code = 'ENOSPC'; throw err; };
    try {
      await rejectsWith(makeStore(fresh('l18c'), makeCatalog(srv.base)).download('test-model', { retryDelayMs: 10 }), 'DISK_FULL');
    } finally {
      fs.promises.open = realOpen;
    }
  });

  await test('L19 invalidate(): a file swapped for another of the same size with the old modification time passes the cache, but not a fresh hash', async () => {
    reset();
    const dir = fresh('l19');
    const store = makeStore(dir, makeCatalog(srv.base));
    await store.download('test-model');
    const d = tdir('test-model')(store);
    const target = path.join(d, 'model.gguf');
    const old = fs.statSync(target);
    // somebody with write access to the folder swaps the file (same size) and puts the old modification time back
    const evil = Buffer.from(A); evil[100] ^= 0xff;
    fs.writeFileSync(target, evil);
    fs.utimesSync(target, old.atime, old.mtime);
    eq(store.status('test-model').state, 'ready', 'the cache is (size, mtime) based, this is the known weakness');
    store.invalidate('test-model');
    eq(store.status('test-model').state, 'unverified', 'invalidate() must make the files unverified');
    const e = await rejectsWith(store.verify('test-model'), 'HASH_MISMATCH');
    eq(e.file, 'model.gguf');
    eq(store.status('test-model').state, 'bad');
  });

  srv.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${results.length} FAILED` : `\nall ${results.length} model-store checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('crashed', e); process.exit(2); });
