'use strict';
// Fetches the pinned llama.cpp runtime (llama-server) into vendor/llama/{cpu,vk}: the engine of the built-in local model (src/main/llm).
//
//   node scripts/fetch-llama.js                       download (if needed), verify, extract
//   node scripts/fetch-llama.js --cpu-zip=<f> --vk-zip=<f>   use local copies of the pinned zips (offline machines / IT-approved copies)
//   node scripts/fetch-llama.js --force               re-extract even if vendor/llama already verifies
//   node scripts/fetch-llama.js --update-pin          maintainers only, AFTER changing tag / urls / zipSha256 by hand: records the SHA-256 of the
//                                                     extracted files and of the licence text
//
// Trust model (same as scripts/fetch-ffmpeg.js): nothing is used unless its SHA-256 equals the value pinned in vendor/llama/llama-pin.json.
//   zipSha256 - the digest GitHub publishes for the release asset
//   files     - SHA-256 of every extracted file; scripts/package.js checks them again right before they are packed into the app
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'vendor', 'llama');
const PIN_FILE = path.join(DIR, 'llama-pin.json');
const BACKENDS = ['cpu', 'vk'];
// Only what llama-server needs (the release also holds the command-line tools, benchmarks, the RPC server ...: ~25 MB of dead weight)
const KEEP = [
  /^llama-server\.exe$/, /^llama-server-impl\.dll$/, /^llama\.dll$/, /^llama-common\.dll$/, /^mtmd\.dll$/,
  /^ggml\.dll$/, /^ggml-base\.dll$/, /^ggml-vulkan\.dll$/, /^ggml-cpu-[a-z0-9_]+\.dll$/, /^libomp\.dll$/, /^LICENSE-LLVM-OpenMP$/,
];

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const loadPin = () => JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// Returns a list of problems (empty = vendor/llama matches the pin exactly).
function verifyInstalled(pin) {
  const problems = [];
  if (!pin.files || !BACKENDS.every((b) => pin.files[b] && Object.keys(pin.files[b]).length) || !pin.license.sha256) return ['the pin has no file hashes yet (run: node scripts/fetch-llama.js --update-pin)'];
  for (const b of BACKENDS) {
    for (const [name, hash] of Object.entries(pin.files[b])) {
      const p = path.join(DIR, b, name);
      if (!fs.existsSync(p)) { problems.push('missing: ' + b + '/' + name); continue; }
      const actual = sha256File(p);
      if (actual !== hash) problems.push('SHA-256 mismatch: ' + b + '/' + name + ' (' + actual + ')');
    }
    // nothing extra may sit between the verified files (a planted DLL would be loaded by llama-server.exe)
    const dir = path.join(DIR, b);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (!pin.files[b][f]) problems.push('unexpected file: ' + b + '/' + f);
  }
  const lic = path.join(DIR, 'LICENSE');
  if (!fs.existsSync(lic)) problems.push('missing: LICENSE');
  else if (sha256File(lic) !== pin.license.sha256) problems.push('SHA-256 mismatch: LICENSE');
  return problems;
}

function download(url, dest) {
  console.log('Downloading ' + url);
  // curl.exe ships with Windows 10/11 and uses the Windows certificate store (works behind TLS-inspecting corporate proxies)
  const r = spawnSync('curl.exe', ['-L', '--fail', '--silent', '--show-error', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('download failed (curl exit ' + r.status + '). Download the file manually and pass --cpu-zip / --vk-zip.');
}

function listZip(zip) {
  const r = spawnSync('tar', ['-tf', zip], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error('could not read the archive: ' + String(r.stderr || r.error || '').slice(0, 300));
  return r.stdout.split(/\r?\n/).map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);
}

function extract(zip, outDir) {
  const names = listZip(zip).filter((n) => !n.includes('/') && KEEP.some((re) => re.test(n)));
  if (!names.includes('llama-server.exe')) throw new Error('the archive has no llama-server.exe');
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', outDir, ...names], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not extract the archive: ' + String(r.stderr || r.error || '').slice(0, 400));
  return names;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
  const force = args.includes('--force');
  const updatePin = args.includes('--update-pin');
  const pin = loadPin();

  if (!force && !updatePin) {
    const problems = verifyInstalled(pin);
    if (!problems.length) { console.log('llama.cpp ' + pin.tag + ' is already in vendor/llama and matches the pin.'); return; }
    if (fs.existsSync(path.join(DIR, 'cpu', 'llama-server.exe'))) console.log('vendor/llama does not match the pin: ' + problems.join('; '));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-llama-'));
  try {
    const stage = path.join(tmp, 'x');
    const hashes = {};
    for (const b of BACKENDS) {
      let zip = opt(b + '-zip');
      if (zip) zip = path.resolve(zip);
      else { zip = path.join(tmp, b + '.zip'); download(pin.assets[b].url, zip); }
      const zh = sha256File(zip);
      if (zh !== pin.assets[b].zipSha256) throw new Error(b + ': the archive does not match the pinned SHA-256 (' + zh + ' instead of ' + pin.assets[b].zipSha256 + '). Not using it.');
      console.log(b + ': archive OK (' + mb(fs.statSync(zip).size) + ', SHA-256 matches the pin).');
      const names = extract(zip, path.join(stage, b));
      hashes[b] = {};
      for (const n of names.sort()) hashes[b][n] = sha256File(path.join(stage, b, n));
    }
    const licFile = path.join(tmp, 'LICENSE');
    download(pin.license.url, licFile);
    const licHash = sha256File(licFile);
    if (updatePin) {
      pin.files = hashes;
      pin.license.sha256 = licHash;
      fs.writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2) + '\n', 'utf8');
      console.log('Pin updated with the hashes of the extracted files.');
    } else {
      const bad = [];
      for (const b of BACKENDS) for (const n of Object.keys(hashes[b])) if (!pin.files[b] || pin.files[b][n] !== hashes[b][n]) bad.push(b + '/' + n);
      for (const b of BACKENDS) for (const n of Object.keys(pin.files[b] || {})) if (!hashes[b][n]) bad.push(b + '/' + n + ' (missing in the archive)');
      if (licHash !== pin.license.sha256) bad.push('LICENSE');
      if (bad.length) throw new Error('extracted files do not match the pin: ' + bad.join(', '));
    }
    for (const b of BACKENDS) {
      rm(path.join(DIR, b));
      fs.cpSync(path.join(stage, b), path.join(DIR, b), { recursive: true });
    }
    fs.copyFileSync(licFile, path.join(DIR, 'LICENSE'));
    const problems = verifyInstalled(loadPin());
    if (problems.length) throw new Error('verification after copying failed: ' + problems.join('; '));
    const size = (b) => fs.readdirSync(path.join(DIR, b)).reduce((s, f) => s + fs.statSync(path.join(DIR, b, f)).size, 0);
    console.log('Installed to vendor/llama: ' + pin.tag + ' (cpu ' + mb(size('cpu')) + ', vk ' + mb(size('vk')) + ').');
  } finally {
    rm(tmp);
  }
}

module.exports = { loadPin, verifyInstalled, sha256File, DIR, PIN_FILE, BACKENDS };

if (require.main === module) {
  try { main(); } catch (e) { console.error('FETCH FAILED: ' + e.message); process.exit(1); }
}
