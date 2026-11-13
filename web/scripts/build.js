#!/usr/bin/env node
'use strict';
// Builds the publishable site (default: web/_site): only what the browser needs, a precache list with the hash of every file, the version of the
// service worker, and the files GitHub Pages wants (.nojekyll, 404.html). The source tree stays the single source of truth - nothing is minified,
// bundled or transformed, so what is published is what is in the repository.
//   node scripts/build.js [--out <dir>]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The files that are not precached but fetched on demand (and checked against the manifest, see sw.js): the libraries of the in-browser assistant.
const LAZY_RE = /^vendor\/(transformers|onnxruntime-web)\//;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// What is published (relative to the web/ folder).
const INCLUDE = [
  { from: 'index.html', to: 'index.html' },
  { from: 'manifest.webmanifest', to: 'manifest.webmanifest' },
  { dir: 'css' },
  { dir: 'js' },
  { dir: 'assets' },
  { dir: 'vendor', skip: ['vendor-manifest.json'] },
  { from: '../LICENSE', to: 'LICENSE', optional: true },
  { from: 'THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt', optional: true },
];

// opts: { root (the web/ folder), out, quiet? } -> { out, files, build, version, bytes }
function build(opts) {
  const ROOT = path.resolve(opts.root);
  const OUT = path.resolve(opts.out);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // 1. the vendored libraries must be exactly the pinned ones
  const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'vendor.js'), 'verify'], { encoding: 'utf8' });
  if (!opts.quiet) process.stdout.write(v.stdout || '');
  if (v.status !== 0) throw new Error('vendor verification failed:\n' + (v.stderr || v.stdout || ''));

  // 1b. the web edition's copies of the desktop code are current (checkable where the desktop sources sit next to the web folder, i.e. in the repository)
  if (fs.existsSync(path.join(ROOT, '..', 'src', 'main', 'ai', 'agent.js'))) {
    const s = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-desktop.js'), '--check'], { encoding: 'utf8' });
    if (!opts.quiet) process.stdout.write(s.stdout || '');
    if (s.status !== 0) throw new Error('desktop sync check failed:\n' + (s.stderr || s.stdout || ''));
  }

  // 2. copy
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const copied = [];
  for (const item of INCLUDE) {
    if (item.dir) {
      const base = path.join(ROOT, item.dir);
      if (!fs.existsSync(base)) continue;
      for (const f of walk(base)) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/');
        if ((item.skip || []).includes(path.basename(f))) continue;
        const to = path.join(OUT, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(f, to);
        copied.push(rel);
      }
    } else {
      const from = path.join(ROOT, item.from);
      if (!fs.existsSync(from)) { if (item.optional) continue; throw new Error('missing ' + item.from); }
      fs.copyFileSync(from, path.join(OUT, item.to));
      copied.push(item.to);
    }
  }

  // 3. the precache list: every file of the application, except the libraries of the in-browser assistant (a few MB of code and a 26 MB WebAssembly file that only that
  //    feature needs): those are listed apart ("lazy"), fetched by the service worker when a page asks for them, and checked against the same manifest
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  if (!swSrc.includes("'__BUILD_ID__'")) throw new Error('sw.js has no __BUILD_ID__ placeholder');
  if (!swSrc.includes("'__MANIFEST_SHA256__'")) throw new Error('sw.js has no __MANIFEST_SHA256__ placeholder');
  // the worker answers every address of its scope that is not written the plain way with a 404 (NOT_PLAIN in sw.js), and it sees an address as the browser writes it: a file whose name
  // needs escaping (a space, a non-ASCII letter, a # or ?) arrives as %-escapes. A published file that would be refused for either reason could not be reached.
  const plainRule = /const NOT_PLAIN = \/(.+)\/;/.exec(swSrc);
  if (!plainRule) throw new Error('sw.js has no NOT_PLAIN rule');
  const notPlain = new RegExp(plainRule[1]);
  const refused = copied.filter((url) => { const seen = new URL(url, 'https://h/s/').pathname.slice('/s/'.length); return seen !== url || notPlain.test(seen); });
  if (refused.length) throw new Error('these published names would be refused by the service worker (they need escaping in an address, or look like a spelling it refuses, see NOT_PLAIN in sw.js): ' + refused.join(', '));
  const entries = copied.slice().sort().map((url) => ({ url, sha256: sha256(fs.readFileSync(path.join(OUT, url))), bytes: fs.statSync(path.join(OUT, url)).size }));
  const files = entries.filter((e) => !LAZY_RE.test(e.url)).map((e) => ({ url: e.url, sha256: e.sha256 }));
  const lazy = entries.filter((e) => LAZY_RE.test(e.url));
  // the worker itself counts too: a changed worker is a new build (a new cache)
  const all = copied.map((url) => url + ':' + sha256(fs.readFileSync(path.join(OUT, url)))).concat(['sw.js:' + sha256(Buffer.from(swSrc))]).sort();
  const buildId = sha256(Buffer.from(all.join('\n'))).slice(0, 16);
  const manifestText = JSON.stringify({ version: pkg.version, build: buildId, files, lazy }, null, 1) + '\n';
  fs.writeFileSync(path.join(OUT, 'precache-manifest.json'), manifestText);

  // 4. the worker carries the build id (a new build = a new cache = the update flow of the editor) and the hash of the manifest: the anchor of its integrity
  //    checks (a page of another site on the same origin can write into Cache Storage, but it cannot change an installed worker script)
  fs.writeFileSync(path.join(OUT, 'sw.js'), swSrc.replace("'__BUILD_ID__'", JSON.stringify(buildId)).replace("'__MANIFEST_SHA256__'", JSON.stringify(sha256(Buffer.from(manifestText)))));

  // 5. GitHub Pages: no Jekyll processing, a friendly 404, a robots file
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(path.join(OUT, '404.html'), [
    '<!doctype html>',
    '<html lang="tr"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>404</title></head>',
    '<body><h1>404</h1><p>Sayfa bulunamadı. · Page not found.</p><p><a href="./">Video Editör</a></p></body></html>',
    '',
  ].join('\n'));

  // 6. the browser extension for Foundry Local (extension/): the zip that the settings dialog offers, under a fixed name, with its SHA-256 next to it. It is only
  //    downloaded, never used by the page itself, so it is not part of the precache.
  const packExtension = require('./pack-extension');
  const zip = packExtension.buildZip({ root: ROOT, zip: path.join(OUT, 'extension', packExtension.ZIP_NAME) });
  const extension = { version: zip.version, sha256: zip.sha256, bytes: zip.bytes, files: zip.files.length };

  const bytes = copied.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
  return { out: OUT, files: copied.length, precached: files.length, lazy: lazy.length, build: buildId, version: pkg.version, bytes, extension };
}

module.exports = { build, LAZY_RE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : '';
  const root = path.resolve(__dirname, '..');
  const r = build({ root, out: outArg || path.join(root, '_site') });
  console.log('built ' + path.relative(process.cwd(), r.out) + ': ' + r.files + ' files (' + r.precached + ' precached, ' + r.lazy + ' on demand), ' + (r.bytes / 1048576).toFixed(1) + ' MB, build ' + r.build + ', version ' + r.version);
  console.log('extension zip: version ' + r.extension.version + ', ' + r.extension.files + ' files, ' + r.extension.bytes + ' bytes, sha256 ' + r.extension.sha256);
}
