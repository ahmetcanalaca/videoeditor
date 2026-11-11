'use strict';
// Vendors the few third-party browser libraries the site needs, EXACTLY pinned, so that the published site loads nothing from a CDN and has no
// npm dependency tree: every file is copied out of the npm tarball, the tarball is checked against the registry's integrity value, and the
// SHA-256 of each vendored file is written to vendor/vendor-lock.json (checked again by `verify`, which CI runs on every deploy).
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
        const from = path.join(tmp, 'package', f.from);
        if (!fs.existsSync(from)) throw new Error(spec + ': missing ' + f.from);
        const to = path.join(VENDOR, f.to);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        keep.add(f.to);
        entry.files.push({ path: f.to, sha256: sha256(fs.readFileSync(to)), bytes: fs.statSync(to).size });
      }
      lock.packages.push(entry);
      console.log('  ok: ' + entry.files.map((x) => x.path + ' (' + Math.round(x.bytes / 1024) + ' KB)').join(', '));
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
  for (const pkg of lock.packages) {
    for (const f of pkg.files) {
      expected.add(f.path);
      const p = path.join(VENDOR, f.path);
      if (!fs.existsSync(p)) { problems.push('missing: ' + f.path); continue; }
      const h = sha256(fs.readFileSync(p));
      if (h !== f.sha256) problems.push('changed: ' + f.path + ' (' + h + ' != ' + f.sha256 + ')');
    }
  }
  for (const f of walk(VENDOR, VENDOR)) if (!expected.has(f)) problems.push('not in the lock file: ' + f);
  if (problems.length) {
    console.error('vendor verification FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('vendor OK: ' + lock.packages.map((p) => p.name + '@' + p.version).join(', '));
}

const cmd = process.argv[2];
if (cmd === 'add') add();
else if (cmd === 'verify') verify();
else { console.error('usage: node scripts/vendor.js add|verify'); process.exit(2); }
