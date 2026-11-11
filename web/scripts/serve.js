#!/usr/bin/env node
'use strict';
// Tiny static file server for developing / testing the web edition on this machine (GitHub Pages serves the same files in production).
//   node scripts/serve.js [--port 8080] [--base /video-editor/] [--headers coi]
// --base       serve under a sub-path, like a GitHub "project site" (https://user.github.io/<repo>/), to catch absolute URLs
// --headers    coi: add Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy (credentialless) to try cross-origin isolation
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pack } = require('./local-ai-pack');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
};

function start(opts) {
  const root = path.resolve(opts.root);
  let base = opts.base || '/';
  if (!base.startsWith('/')) base = '/' + base;
  if (!base.endsWith('/')) base += '/';
  const extra = {};
  if (opts.headers === 'coi') {
    extra['Cross-Origin-Opener-Policy'] = 'same-origin';
    extra['Cross-Origin-Embedder-Policy'] = 'credentialless';
  }
  // extra folders served under absolute prefixes (tests: { '/__fixtures__/': dir })
  const mounts = Object.keys(opts.mounts || {}).map((prefix) => ({ prefix, dir: path.resolve(opts.mounts[prefix]) }));
  // from the source tree, the download of the Local AI helper (zip + info.json) is packed on the fly, as scripts/build.js does for the published site
  let packDir = '';
  if (opts.localAi !== false && fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'local-ai', 'pins.json'))) {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 've-web-localai-'));
    pack({ root, out: packDir });
    mounts.push({ prefix: base + 'local-ai/', dir: path.join(packDir, 'local-ai') });
  }
  // tests only: POST /__upload__/<name> stores the body in opts.uploads (the page hands exported files to the test this way)
  const uploads = opts.uploads ? path.resolve(opts.uploads) : '';
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
    if (uploads && req.method === 'POST' && urlPath.startsWith('/__upload__/')) {
      const name = path.basename(urlPath.slice('/__upload__/'.length));
      if (!name) { res.writeHead(400); res.end('bad name'); return; }
      fs.mkdirSync(uploads, { recursive: true });
      const target = path.join(uploads, name);
      const out = fs.createWriteStream(target);
      req.pipe(out);
      out.on('finish', () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(target); });
      out.on('error', () => { res.writeHead(500); res.end('write failed'); });
      return;
    }
    let dir = root;
    let rel;
    const mount = mounts.find((m) => urlPath.startsWith(m.prefix));
    if (mount) {
      dir = mount.dir;
      rel = urlPath.slice(mount.prefix.length);
    } else {
      if (urlPath === base.slice(0, -1)) { res.writeHead(301, { Location: base }); res.end(); return; }
      if (!urlPath.startsWith(base)) { res.writeHead(404); res.end('not found'); return; }
      rel = urlPath.slice(base.length);
      if (!rel || rel.endsWith('/')) rel += 'index.html';
    }
    const file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      const headers = Object.assign({ 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' }, extra);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        base,
        close: () => new Promise((r) => server.close(() => { if (packDir) fs.rmSync(packDir, { recursive: true, force: true }); r(); })),
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  start({ root: path.join(__dirname, '..'), port: Number(get('port', 8080)), base: get('base', '/'), headers: get('headers', '') }).then((s) => {
    console.log('http://127.0.0.1:' + s.port + s.base);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
