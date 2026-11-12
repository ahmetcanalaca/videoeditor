#!/usr/bin/env node
'use strict';
// Packs the browser extension of the web edition (web/extension/): the files the browser needs (nothing else), a manifest variant for the tests, and a
// reproducible zip (sorted entries, fixed time stamps: the same sources always give the same bytes, so the published hash can be checked).
//   node scripts/pack-extension.js [--out <dir>] [--zip <file>]      writes the folder and the zip (+ .sha256)
//   require('./pack-extension').buildFolder({ root, out, variant })  variant 'prod' (the manifest as it is) or 'test' (also serves http://127.0.0.1 / localhost pages)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'extension';
// what goes into the package; anything else in the folder (tests, notes) stays out
const FILES = ['manifest.json', 'background.js', 'content.js', 'policy.js', 'popup.html', 'popup.js', 'consent.html', 'consent.js', 'ui.css', 'ui-i18n.js', 'README.md'];
const DIRS = ['icons', '_locales'];
const ZIP_NAME = 'video-editor-foundry-bridge.zip';
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 00:00:00 for every entry
const DOS_TIME = 0;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// -> [{ name, data }] sorted by name
function collect(root) {
  const src = path.join(root, SRC);
  const names = FILES.filter((f) => fs.existsSync(path.join(src, f)));
  for (const d of DIRS) if (fs.existsSync(path.join(src, d))) names.push(...walk(path.join(src, d), src));
  const missing = ['manifest.json', 'background.js', 'content.js', 'policy.js', 'popup.html', 'consent.html'].filter((f) => !names.includes(f));
  if (missing.length) throw new Error('extension files missing: ' + missing.join(', '));
  return names.sort().map((name) => ({ name, data: fs.readFileSync(path.join(src, name)) }));
}

// the manifest of the tests: the same extension, and it also serves the pages of the local test server (the real manifest names the published site only)
function testManifest(text) {
  const m = JSON.parse(text);
  const extra = ['http://127.0.0.1/*', 'http://localhost/*'];
  m.content_scripts = m.content_scripts.map((c) => Object.assign({}, c, { matches: c.matches.concat(extra) }));
  m.host_permissions = Array.from(new Set(m.host_permissions.concat(extra)));
  m.name = m.name + ' (test build)';
  return JSON.stringify(m, null, 2) + '\n';
}

function buildFolder(opts) {
  const root = path.resolve(opts.root || ROOT);
  const out = path.resolve(opts.out);
  const files = collect(root);
  fs.rmSync(out, { recursive: true, force: true });
  for (const f of files) {
    let data = f.data;
    if (f.name === 'manifest.json' && opts.variant === 'test') data = Buffer.from(testManifest(data.toString('utf8')));
    const to = path.join(out, f.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
  }
  return { out, files: files.map((f) => f.name) };
}

/* ---- a reproducible zip ---- */

function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    // Entries are stored, not compressed: the compressed bytes depend on the version of zlib (Node 22 on the CI, another Node on a computer), the stored ones do not -
    // so the zip, and the SHA-256 that is published for it, come out the same everywhere. (The extension is about 60 KB.)
    const raw = f.data;
    const body = raw;
    const crc = zlib.crc32(raw) >>> 0;
    const method = 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 38); // external attributes
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

// -> { zip: path, sha256, bytes, files, version }
function buildZip(opts) {
  const root = path.resolve(opts.root || ROOT);
  const files = collect(root);
  const version = JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString('utf8')).version;
  const buf = zipFiles(files);
  const zip = path.resolve(opts.zip);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.writeFileSync(zip, buf);
  const hash = sha256(buf);
  fs.writeFileSync(zip + '.sha256', hash + '  ' + path.basename(zip) + '\n');
  return { zip, sha256: hash, bytes: buf.length, files: files.map((f) => f.name), version };
}

module.exports = { buildFolder, buildZip, zipFiles, collect, ZIP_NAME, FILES, DIRS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : '');
  const out = arg('--out');
  if (out) { const r = buildFolder({ out }); console.log('folder ' + r.out + ': ' + r.files.length + ' files'); }
  const zip = arg('--zip') || (out ? '' : path.join(ROOT, '_site', 'extension', ZIP_NAME));
  if (zip) { const r = buildZip({ zip }); console.log('zip ' + r.zip + ': ' + r.files.length + ' files, ' + r.bytes + ' bytes, version ' + r.version + ', sha256 ' + r.sha256); }
}
