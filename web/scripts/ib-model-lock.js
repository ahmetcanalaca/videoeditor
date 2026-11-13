#!/usr/bin/env node
'use strict';
// Writes js/web/ai/inbrowser/ib-models.js: the catalogue of the models the in-browser assistant can download, with everything the page needs to refuse a wrong
// byte - the exact revision (a commit, never a branch) and, for every file, its size, its SHA-256 and the SHA-256 of every 16 MiB block of it.
//
// Nothing here is trusted blindly: the list of files comes from the Hugging Face API for that commit, every file is downloaded, its size is compared with the API's, its
// SHA-256 with the one Hugging Face publishes for it (LFS files) or its git blob id (small files), and only then are the hashes written. The page checks every byte it
// downloads, and every byte it reads back from the browser's storage, against this file (see js/web/ai/inbrowser/ib-core.js).
//
//   node scripts/ib-model-lock.js [--cache <dir>] [--only <key>]      (needs the network; ~4.4 GB for the two models, kept in the cache dir so that a second run is fast)
//   node scripts/ib-model-lock.js --check                              no network: the generated file is well-formed and consistent
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const OUT = path.join(__dirname, '..', 'js', 'web', 'ai', 'inbrowser', 'ib-models.js');
const CHUNK = 16 * 1024 * 1024;
const DTYPE = 'q4f16';
const HOST = 'https://huggingface.co';

// What the assistant can run. The revisions are commits of the repositories (not branches): a model that is changed later on Hugging Face is not picked up by accident.
// (A 0.8B model was measured too and left out: on the real graphics card it answered questions but did not manage a single editing command.)
const MODELS = [
  { key: 'qwen3.5-2b', name: 'Qwen3.5 2B', tier: 'balanced', repo: 'onnx-community/Qwen3.5-2B-ONNX-OPT', revision: 'ed446636739bf426e73c5a00714fd8e010d36c21' },
  { key: 'qwen3.5-4b', name: 'Qwen3.5 4B', tier: 'best', repo: 'webgpu/Qwen3.5-4B-ONNX', revision: 'da5d5398623d1e28e2a51c4cc81ab8dff6c34096' },
];
const TOP_FILES = ['chat_template.jinja', 'config.json', 'generation_config.json', 'preprocessor_config.json', 'processor_config.json', 'tokenizer_config.json', 'tokenizer.json'];
const ONNX_RE = new RegExp('^onnx/(decoder_model_merged|embed_tokens|vision_encoder)_' + DTYPE + '\\.onnx(_data(_\\d+)?)?$');

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitBlobId = (buf) => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

async function getJson(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === 3) throw new Error(url + ': ' + e.message);
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  return null;
}

// -> { size, sha256, chunks: [sha256 of each 16 MiB block] } of a file on disk
async function hashFile(file) {
  const whole = crypto.createHash('sha256');
  const chunks = [];
  let cur = crypto.createHash('sha256');
  let left = CHUNK;
  let size = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  for await (const buf of stream) {
    whole.update(buf);
    size += buf.length;
    let off = 0;
    while (off < buf.length) {
      const n = Math.min(left, buf.length - off);
      cur.update(buf.subarray(off, off + n));
      off += n;
      left -= n;
      if (left === 0) { chunks.push(cur.digest('hex')); cur = crypto.createHash('sha256'); left = CHUNK; }
    }
  }
  if (left !== CHUNK) chunks.push(cur.digest('hex'));
  return { size, sha256: whole.digest('hex'), chunks };
}

// curl is much faster than Node's fetch on some networks (measured: 21 MB/s against 2 MB/s on the same connection), so it is used when it is there
const { spawnSync } = require('child_process');
const HAS_CURL = (() => { try { return spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; } })();

async function download(url, to, expected) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const tmp = to + '.part';
    try {
      if (HAS_CURL) {
        const r = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', tmp, url], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
        if (r.status !== 0) throw new Error('curl: ' + String(r.stderr || r.status).trim().slice(0, 200));
        if (fs.statSync(tmp).size !== expected) throw new Error('size ' + fs.statSync(tmp).size + ' != ' + expected);
        fs.renameSync(tmp, to);
        return;
      }
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const out = fs.createWriteStream(tmp);
      let got = 0;
      let lastLog = Date.now();
      for await (const buf of r.body) {
        if (!out.write(buf)) await new Promise((res) => out.once('drain', res));
        got += buf.length;
        if (Date.now() - lastLog > 15000) { lastLog = Date.now(); process.stdout.write('    ' + mb(got) + ' / ' + mb(expected) + '\n'); }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (got !== expected) throw new Error('size ' + got + ' != ' + expected);
      fs.renameSync(tmp, to);
      return;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (x) { /* nothing to remove */ }
      if (attempt === 4) throw new Error(url + ': ' + e.message);
      console.log('    retry ' + attempt + ': ' + e.message);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

async function lockModel(m, cacheDir) {
  console.log('== ' + m.key + '  ' + m.repo + '@' + m.revision.slice(0, 8));
  const info = await getJson(HOST + '/api/models/' + m.repo + '/revision/' + m.revision + '?blobs=true');
  if (!info || info.sha !== m.revision) throw new Error(m.repo + ': the API did not answer for commit ' + m.revision);
  const siblings = new Map((info.siblings || []).map((s) => [s.rfilename, s]));
  const wanted = TOP_FILES.slice();
  for (const name of siblings.keys()) if (ONNX_RE.test(name)) wanted.push(name);
  wanted.sort();
  const need = wanted.filter((n) => !siblings.has(n));
  if (need.length) throw new Error(m.repo + ': files missing in the repository: ' + need.join(', '));
  // the three model parts have to be there (a decoder, the embeddings, the vision encoder), each with its weights
  for (const part of ['decoder_model_merged', 'embed_tokens', 'vision_encoder']) {
    if (!wanted.includes('onnx/' + part + '_' + DTYPE + '.onnx') || !wanted.includes('onnx/' + part + '_' + DTYPE + '.onnx_data')) throw new Error(m.repo + ': incomplete model part ' + part);
  }
  const files = [];
  for (const name of wanted) {
    const s = siblings.get(name);
    const local = path.join(cacheDir, m.repo.replace('/', '__'), m.revision, name);
    if (!fs.existsSync(local) || fs.statSync(local).size !== s.size) {
      console.log('  download ' + name + ' (' + mb(s.size) + ')');
      await download(HOST + '/' + m.repo + '/resolve/' + m.revision + '/' + name, local, s.size);
    }
    const h = await hashFile(local);
    if (h.size !== s.size) throw new Error(name + ': size ' + h.size + ' != ' + s.size);
    if (s.lfs) {
      if (h.sha256 !== s.lfs.sha256) throw new Error(name + ': SHA-256 ' + h.sha256 + ' is not the one Hugging Face publishes (' + s.lfs.sha256 + ')');
    } else if (s.blobId) {
      if (gitBlobId(fs.readFileSync(local)) !== s.blobId) throw new Error(name + ': git blob id does not match');
    } else {
      throw new Error(name + ': Hugging Face publishes no hash for it');
    }
    files.push({ path: name, bytes: h.size, sha256: h.sha256, chunks: h.chunks.length > 1 ? h.chunks : undefined });
    console.log('  ok ' + name.padEnd(52) + String(h.size).padStart(12) + '  ' + h.sha256.slice(0, 12));
  }
  return Object.assign({}, m, { dtype: DTYPE, vision: true, license: 'Apache-2.0', files });
}

function render(models) {
  const lines = [];
  lines.push('// GENERATED by scripts/ib-model-lock.js - do not edit by hand (npm run ib:lock, needs the network).');
  lines.push('// The models the in-browser assistant can download from Hugging Face: a commit of a repository (never a branch) and, for every file, its size, its SHA-256 and the');
  lines.push('// SHA-256 of every 16 MiB block of it. A file shorter than one block has no "chunks" list: its SHA-256 is the one of its only block. Everything the page downloads');
  lines.push('// or reads back from the browser\'s storage is checked against this list before it is used (ib-core.js).');
  lines.push('export const HOST = ' + JSON.stringify(HOST) + ';');
  lines.push('export const CHUNK = ' + CHUNK + ';');
  lines.push('export const DTYPE = ' + JSON.stringify(DTYPE) + ';');
  lines.push('export const MODELS = ' + JSON.stringify(models, null, 1) + ';');
  lines.push('');
  // the files of this repository have CRLF line ends
  return lines.join('\n').replace(/\r?\n/g, '\r\n');
}

// the generated module is plain data (one JSON value per line of "export const NAME = value;"): read as such, nothing in it is ever run. A "__proto__" key is refused: JSON reads it as
// an ordinary property, but a browser that runs the same text as a module takes it for the prototype of the object - what the check saw would not be what the page gets.
function loadCatalog(text) {
  const out = {};
  const noProto = (k, v) => { if (k === '__proto__') throw new Error('ib-models.js: a "__proto__" key'); return v; };
  for (const part of text.replace(/\r/g, '').split(/^export const /m).slice(1)) {
    const m = /^(\w+) = ([\s\S]*);\s*$/.exec(part);
    if (!m) throw new Error('ib-models.js: a line that is not "export const NAME = value;"');
    out[m[1]] = JSON.parse(m[2], noProto);
  }
  return out;
}

function check() {
  const text = fs.readFileSync(OUT, 'utf8');
  const mod = loadCatalog(text);
  const problems = [];
  if (!Array.isArray(mod.MODELS)) { console.error('ib-models.js is not consistent:\n  there is no MODELS list'); process.exit(1); }
  // The file is the root of trust of every pin, and every browser runs it as a module: it has to be exactly what render() writes for the catalogue it holds (line ends aside).
  // Code in front of the first "export const", a further statement or a comment that was edited by hand is a difference, however the data itself looks.
  const lf = (s) => s.replace(/\r\n/g, '\n');
  if (lf(text) !== lf(render(mod.MODELS))) problems.push('the file is not exactly what this script writes for the catalogue it holds (something was added, removed or edited by hand)');
  if (mod.CHUNK !== CHUNK || mod.HOST !== HOST) problems.push('constants');
  for (const m of MODELS) {
    const g = mod.MODELS.find((x) => x.key === m.key);
    if (!g || g.repo !== m.repo || g.revision !== m.revision) { problems.push(m.key + ': not the pinned repository/commit'); continue; }
    for (const f of g.files) {
      if (!/^[0-9a-f]{64}$/.test(f.sha256) || !(f.bytes > 0)) problems.push(m.key + '/' + f.path + ': bad entry');
      const blocks = Math.ceil(f.bytes / CHUNK);
      if (blocks > 1 && (!Array.isArray(f.chunks) || f.chunks.length !== blocks || !f.chunks.every((c) => /^[0-9a-f]{64}$/.test(c)))) problems.push(m.key + '/' + f.path + ': block list');
      if (blocks <= 1 && f.chunks) problems.push(m.key + '/' + f.path + ': a single block has no list');
    }
  }
  if (problems.length) { console.error('ib-models.js is not consistent:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('ib-models.js OK: ' + mod.MODELS.map((m) => m.key + ' (' + mb(m.files.reduce((s, f) => s + f.bytes, 0)) + ')').join(', '));
}

(async () => {
  if (process.argv.includes('--check')) { check(); return; }
  const cacheDir = arg('--cache') || path.join(os.tmpdir(), 've-ib-lock-cache');
  const only = arg('--only');
  const locked = [];
  for (const m of MODELS) {
    if (only && m.key !== only) {
      // keep the entry of a model that is not locked this time
      const old = fs.existsSync(OUT) ? loadCatalog(fs.readFileSync(OUT, 'utf8')).MODELS.find((x) => x.key === m.key) : null;
      if (old) locked.push(old);
      continue;
    }
    locked.push(await lockModel(m, cacheDir));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(locked));
  console.log('wrote ' + path.relative(process.cwd(), OUT));
  check();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
