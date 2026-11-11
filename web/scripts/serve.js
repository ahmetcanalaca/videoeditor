#!/usr/bin/env node
'use strict';
// Tiny static file server for developing / testing the web edition on this machine (GitHub Pages serves the same files in production).
//   node scripts/serve.js [--port 8080] [--base /video-editor/] [--headers coi]
// --base       serve under a sub-path, like a GitHub "project site" (https://user.github.io/<repo>/), to catch absolute URLs
// --headers    coi: add Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy (credentialless) to try cross-origin isolation
const http = require('http');
const fs = require('fs');
const path = require('path');

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
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
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
      resolve({ server, port: server.address().port, base, close: () => new Promise((r) => server.close(() => r())) });
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
