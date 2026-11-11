'use strict';
// Fetches the pinned FFmpeg + ffprobe into vendor/ffmpeg. Both programs come from the SAME package, so they always have the same version
// (before 2.0.1 ffprobe came from a separate 2018 package, ffprobe 4.0.2, and ffmpeg.exe was downloaded at install time without any check).
//
//   node scripts/fetch-ffmpeg.js                  download (if needed), verify, extract
//   node scripts/fetch-ffmpeg.js --zip=<file>     use a local copy of the pinned zip (offline machines, or a copy IT approved)
//   node scripts/fetch-ffmpeg.js --force          re-extract even if vendor/ffmpeg already verifies
//   node scripts/fetch-ffmpeg.js --update-pin     maintainers only, AFTER changing version / url / zipSha256 / zipRoot in the pin by hand:
//                                                 records the SHA-256 of the extracted files
//
// Trust model: nothing is used unless its SHA-256 equals the value pinned in vendor/ffmpeg/ffmpeg-pin.json.
//   zipSha256 - published independently by gyan.dev (see zipSha256Sources in the pin) and equal to the digest of the GitHub release asset
//   files     - SHA-256 of the extracted programs; scripts/package.js checks them again right before they are packed into the app
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'vendor', 'ffmpeg');
const BIN = path.join(DIR, 'bin');
const PIN_FILE = path.join(DIR, 'ffmpeg-pin.json');
// archive member (below zipRoot) -> file in vendor/ffmpeg
const MEMBERS = { 'bin/ffmpeg.exe': 'bin/ffmpeg.exe', 'bin/ffprobe.exe': 'bin/ffprobe.exe', 'LICENSE': 'LICENSE', 'README.txt': 'README.txt' };

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

function loadPin() {
  return JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
}

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

// Returns a list of problems (empty = vendor/ffmpeg matches the pin exactly).
function verifyInstalled(pin) {
  const problems = [];
  const names = Object.keys(MEMBERS);
  if (!pin.files || !names.every((n) => pin.files[MEMBERS[n]])) return ['the pin has no file hashes yet (run: node scripts/fetch-ffmpeg.js --update-pin)'];
  for (const n of names) {
    const rel = MEMBERS[n];
    const p = path.join(DIR, rel);
    if (!fs.existsSync(p)) { problems.push('missing: ' + rel); continue; }
    const actual = sha256File(p);
    if (actual !== pin.files[rel]) problems.push('SHA-256 mismatch: ' + rel + ' (' + actual + ')');
  }
  return problems;
}

function download(url, dest) {
  console.log('Downloading ' + url);
  // curl.exe ships with Windows 10/11 and uses the Windows certificate store (works behind TLS-inspecting corporate proxies)
  const r = spawnSync('curl.exe', ['-L', '--fail', '--silent', '--show-error', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('download failed (curl exit ' + r.status + '). Download the file manually and pass --zip=<file>.');
}

function extract(zip, pin, outDir) {
  const wanted = Object.keys(MEMBERS).map((n) => pin.zipRoot + '/' + n);
  const r = spawnSync('tar', ['-xf', zip, '-C', outDir, '--strip-components=1', ...wanted], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not extract the archive: ' + String(r.stderr || r.error || '').slice(0, 400));
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
  const force = args.includes('--force');
  const updatePin = args.includes('--update-pin');
  const pin = loadPin();

  if (!force && !updatePin) {
    const problems = verifyInstalled(pin);
    if (!problems.length) {
      console.log('FFmpeg ' + pin.version + ' is already in vendor/ffmpeg and matches the pin.');
      return;
    }
    if (fs.existsSync(path.join(BIN, 'ffmpeg.exe'))) console.log('vendor/ffmpeg does not match the pin: ' + problems.join('; '));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-ffmpeg-'));
  try {
    let zip = opt('zip');
    if (zip) zip = path.resolve(zip);
    else { zip = path.join(tmp, 'ffmpeg.zip'); download(pin.url, zip); }
    const zipHash = sha256File(zip);
    if (zipHash !== pin.zipSha256) throw new Error('the archive does not match the pinned SHA-256 (' + zipHash + ' instead of ' + pin.zipSha256 + '). Not using it.');
    console.log('Archive OK (' + mb(fs.statSync(zip).size) + ', SHA-256 matches the pin).');

    const stage = path.join(tmp, 'x');
    fs.mkdirSync(stage, { recursive: true });
    extract(zip, pin, stage);
    const hashes = {};
    for (const rel of Object.values(MEMBERS)) {
      const p = path.join(stage, rel);
      if (!fs.existsSync(p)) throw new Error('the archive has no ' + rel);
      hashes[rel] = sha256File(p);
    }
    if (updatePin) {
      pin.files = hashes;
      fs.writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2) + '\n', 'utf8');
      console.log('Pin updated with the hashes of the extracted files.');
    } else {
      const bad = Object.keys(hashes).filter((rel) => !pin.files || hashes[rel] !== pin.files[rel]);
      if (bad.length) throw new Error('extracted files do not match the pin: ' + bad.join(', '));
    }

    rm(BIN);
    fs.mkdirSync(BIN, { recursive: true });
    for (const rel of Object.values(MEMBERS)) fs.copyFileSync(path.join(stage, rel), path.join(DIR, rel));
    const problems = verifyInstalled(loadPin());
    if (problems.length) throw new Error('verification after copying failed: ' + problems.join('; '));
    const v = spawnSync(path.join(BIN, 'ffprobe.exe'), ['-hide_banner', '-version'], { encoding: 'utf8' });
    console.log('Installed to vendor/ffmpeg: ' + String(v.stdout || '').split('\n')[0].trim());
  } finally {
    rm(tmp);
  }
}

module.exports = { loadPin, verifyInstalled, sha256File, DIR, BIN, PIN_FILE };

if (require.main === module) {
  try { main(); } catch (e) { console.error('FETCH FAILED: ' + e.message); process.exit(1); }
}
