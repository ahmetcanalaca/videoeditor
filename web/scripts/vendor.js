'use strict';
// Vendors the few third-party browser libraries the site needs, EXACTLY pinned, so that the published site loads nothing from a CDN and has no
// npm dependency tree: every file is copied out of the npm tarball, the tarball is checked against the registry's integrity value, and the
// SHA-256 of each vendored file is written to vendor/vendor-lock.json (checked again by `verify`, which CI runs on every deploy).
//
// A file may carry "patches" in the manifest: a declared, deterministic change of the upstream file and nothing else (a text that has to occur exactly "count" times is
// replaced, or a notice is put in front). `add` applies them to the official bytes and writes the SHA-256 of BOTH files into the lock (upstreamSha256 and sha256);
// `verify` undoes the patches on the vendored file and checks that the official file's SHA-256 comes out - offline proof that the file is the official one plus exactly
// these changes, and that the manifest and the lock say the same.
//
//   node scripts/vendor.js add      downloads the packages listed in vendor/vendor-manifest.json and (re)writes vendor/ + vendor-lock.json
//   node scripts/vendor.js verify   no network: every vendored file must match vendor-lock.json, nothing else may be in vendor/
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const MANIFEST = path.join(VENDOR, 'vendor-manifest.json');
const LOCK = path.join(VENDOR, 'vendor-lock.json');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha512b64 = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
const occurrences = (text, part) => (part ? text.split(part).length - 1 : 0);

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', shell: process.platform === 'win32' && /^npm/.test(cmd) }, opts));
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout || '').slice(0, 400));
  return (r.stdout || '').trim();
}

function walk(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// The patches of a file, applied in the order they are listed: { find, with, count, reason } replaces a text that has to occur exactly `count` times (and the new text
// not at all), { prepend, reason } puts a notice in front. The bytes are handled as latin1, so every byte outside the changed text stays exactly as it was.
function applyPatches(buf, patches, name) {
  let text = buf.toString('latin1');
  for (const p of patches) {
    if (typeof p.prepend === 'string') { text = p.prepend + text; continue; }
    if (!p.find || typeof p.with !== 'string' || !(p.count > 0)) throw new Error(name + ': a patch needs "find", "with" and a "count"');
    if (occurrences(text, p.find) !== p.count) throw new Error(name + ': "' + p.find + '" occurs ' + occurrences(text, p.find) + ' times, the patch says ' + p.count);
    if (occurrences(text, p.with) !== 0 || p.with.includes(p.find)) throw new Error(name + ': the new text "' + p.with + '" is already in the file (or contains the old one): the patch could not be undone');
    text = text.split(p.find).join(p.with);
  }
  return Buffer.from(text, 'latin1');
}

// The patches undone in the opposite order: the upstream file, or null when the vendored file is not what the patches make of any file.
function undoPatches(buf, patches) {
  let text = buf.toString('latin1');
  for (const p of patches.slice().reverse()) {
    if (typeof p.prepend === 'string') { if (!text.startsWith(p.prepend)) return null; text = text.slice(p.prepend.length); continue; }
    if (occurrences(text, p.with) !== p.count || occurrences(text, p.find) !== 0) return null;
    text = text.split(p.with).join(p.find);
  }
  return Buffer.from(text, 'latin1');
}

function add() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const lock = { generatedBy: 'scripts/vendor.js', packages: [] };
  const keep = new Set(['vendor-manifest.json', 'vendor-lock.json']);
  for (const pkg of manifest.packages) {
    const spec = pkg.name + '@' + pkg.version;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-vendor-'));
    try {
      console.log('packing ' + spec + ' ...');
      const tgzName = run('npm', ['pack', spec, '--silent'], { cwd: tmp }).split(/\r?\n/).pop().trim();
      const tgz = path.join(tmp, tgzName);
      const buf = fs.readFileSync(tgz);
      const integrity = sha512b64(buf);
      // the registry publishes the tarball's integrity: the downloaded bytes have to match it (the install location could be a mirror)
      const expected = run('npm', ['view', spec, 'dist.integrity']).trim();
      if (expected !== integrity) throw new Error(spec + ': tarball integrity ' + integrity + ' does not match the registry (' + expected + ')');
      run('tar', ['-xf', tgz, '-C', tmp]);
      const entry = { name: pkg.name, version: pkg.version, license: pkg.license, tarballIntegrity: integrity, source: pkg.source || '', files: [] };
      for (const f of pkg.files) {
        const to = path.join(VENDOR, f.to);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (f.url) {
          // a file the npm package does not carry (the licence of ONNX Runtime): taken from the pinned source commit and checked against the SHA-256 written in the manifest
          const dl = path.join(tmp, 'extra-' + path.basename(f.to));
          run('curl', ['-sS', '-L', '--fail', '--max-time', '120', '-o', dl, f.url]);
          const h = sha256(fs.readFileSync(dl));
          if (h !== f.sha256) throw new Error(spec + ': ' + f.url + ' has SHA-256 ' + h + ', the manifest says ' + f.sha256);
          fs.copyFileSync(dl, to);
        } else {
          const from = path.join(tmp, 'package', f.from);
          if (!fs.existsSync(from)) throw new Error(spec + ': missing ' + f.from);
          fs.copyFileSync(from, to);
        }
        const record = { path: f.to, sha256: '', bytes: 0 };
        if (f.patches) {
          const upstream = fs.readFileSync(to);
          fs.writeFileSync(to, applyPatches(upstream, f.patches, spec + ' ' + f.to));
          record.upstreamSha256 = sha256(upstream);
          record.patches = f.patches;
        }
        keep.add(f.to);
        record.sha256 = sha256(fs.readFileSync(to));
        record.bytes = fs.statSync(to).size;
        entry.files.push(record);
      }
      lock.packages.push(entry);
      console.log('  ok: ' + entry.files.map((x) => x.path + ' (' + Math.round(x.bytes / 1024) + ' KB' + (x.patches ? ', patched' : '') + ')').join(', '));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log('wrote ' + path.relative(ROOT, LOCK));
}

function verify() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const problems = [];
  const expected = new Set(['vendor-manifest.json', 'vendor-lock.json']);
  // what the manifest declares for each file has to be what the lock recorded (a patch added to one and not regenerated into the other is caught here)
  const declared = new Map();
  if (fs.existsSync(MANIFEST)) for (const pkg of JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).packages) for (const f of pkg.files) declared.set(f.to, f.patches ? JSON.stringify(f.patches) : '');
  for (const pkg of lock.packages) {
    for (const f of pkg.files) {
      expected.add(f.path);
      const p = path.join(VENDOR, f.path);
      if (!fs.existsSync(p)) { problems.push('missing: ' + f.path); continue; }
      const bytes = fs.readFileSync(p);
      const h = sha256(bytes);
      if (h !== f.sha256) problems.push('changed: ' + f.path + ' (' + h + ' != ' + f.sha256 + ')');
      if (declared.size && (declared.get(f.path) || '') !== (f.patches ? JSON.stringify(f.patches) : '')) problems.push('the patches of ' + f.path + ' in vendor-manifest.json are not the ones in vendor-lock.json (run: node scripts/vendor.js add)');
      if (f.patches) {
        const upstream = undoPatches(bytes, f.patches);
        if (!upstream || sha256(upstream) !== f.upstreamSha256) problems.push('not the official file plus the declared patches: ' + f.path);
      } else if (f.upstreamSha256) {
        problems.push('an official hash without patches: ' + f.path);
      }
    }
  }
  for (const f of walk(VENDOR, VENDOR)) if (!expected.has(f)) problems.push('not in the lock file: ' + f);
  if (problems.length) {
    console.error('vendor verification FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  const patched = lock.packages.reduce((n, pkg) => n + pkg.files.filter((f) => f.patches).length, 0);
  console.log('vendor OK: ' + lock.packages.map((p) => p.name + '@' + p.version).join(', ') + (patched ? ' (' + patched + ' file with a declared patch)' : ''));
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'add') add();
  else if (cmd === 'verify') verify();
  else { console.error('usage: node scripts/vendor.js add|verify'); process.exit(2); }
} else {
  module.exports = { applyPatches, undoPatches };
}
