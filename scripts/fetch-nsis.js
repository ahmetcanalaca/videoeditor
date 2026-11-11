'use strict';
// Fetches the pinned NSIS compiler (makensis) into vendor/nsis: the build-time tool that turns the packaged application into the installer
// (scripts/make-installer.js). NSIS is NOT part of the application and none of its code except the small installer stub ends up in
// the installer.
//
//   node scripts/fetch-nsis.js                 download (if needed), verify, extract
//   node scripts/fetch-nsis.js --zip=<file>    use a local copy of the pinned zip (offline machines / IT-approved copy)
//   node scripts/fetch-nsis.js --force         re-extract even if vendor/nsis already verifies
//   node scripts/fetch-nsis.js --update-pin    maintainers only, AFTER changing version / url / zipSha256 by hand: records the tree hash
//
// Trust model (same as scripts/fetch-ffmpeg.js and fetch-llama.js): nothing is used unless it equals the value pinned in vendor/nsis/nsis-pin.json.
//   zipSha256  - SHA-256 of the release archive (SourceForge publishes size + MD5 in its release feed, the pin also records them)
//   treeSha256 - one hash over every extracted file (path + SHA-256), so a changed, added or missing file (stub, plugin, include) is detected
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'vendor', 'nsis');
const PIN_FILE = path.join(DIR, 'nsis-pin.json');
// What the compiler needs; the documentation, the examples and the NSIS GUI tools are left out.
const KEEP_DIRS = ['Bin', 'Contrib', 'Include', 'Plugins', 'Stubs'];
const KEEP_FILES = ['makensis.exe', 'COPYING', 'nsisconf.nsh'];

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

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// One hash over all files: "<relative path>\t<sha256>\n" lines in byte order of the path.
function treeHash(dir) {
  const files = walk(dir, dir, []).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f + '\t' + sha256File(path.join(dir, f)) + '\n');
  return { hash: h.digest('hex'), count: files.length };
}

const compilerDir = (pin) => path.join(DIR, pin.folder);
const makensisPath = () => path.join(compilerDir(loadPin()), 'makensis.exe');

// Returns a list of problems (empty = vendor/nsis matches the pin exactly).
function verifyInstalled(pin) {
  if (!pin.treeSha256) return ['the pin has no tree hash yet (run: node scripts/fetch-nsis.js --update-pin)'];
  const dir = compilerDir(pin);
  if (!fs.existsSync(path.join(dir, 'makensis.exe'))) return ['missing: ' + path.join('vendor', 'nsis', pin.folder, 'makensis.exe')];
  const actual = treeHash(dir);
  return actual.hash === pin.treeSha256 ? [] : ['the files in vendor/nsis do not match the pin (tree hash ' + actual.hash + ')'];
}

function download(url, dest) {
  console.log('Downloading ' + url);
  // curl.exe ships with Windows 10/11 and uses the Windows certificate store (works behind TLS-inspecting corporate proxies)
  const r = spawnSync('curl.exe', ['-L', '--fail', '--silent', '--show-error', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('download failed (curl exit ' + r.status + '). Download the file manually and pass --zip=<file>.');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
  const force = args.includes('--force');
  const updatePin = args.includes('--update-pin');
  const pin = loadPin();

  if (!force && !updatePin) {
    const problems = verifyInstalled(pin);
    if (!problems.length) { console.log('NSIS ' + pin.version + ' is already in vendor/nsis and matches the pin.'); return; }
    if (fs.existsSync(makensisPath())) console.log('vendor/nsis does not match the pin: ' + problems.join('; '));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-nsis-'));
  try {
    let zip = opt('zip');
    if (zip) zip = path.resolve(zip);
    else { zip = path.join(tmp, 'nsis.zip'); download(pin.asset.url, zip); }
    const size = fs.statSync(zip).size;
    const zh = sha256File(zip);
    if (size !== pin.asset.size) throw new Error('the archive has ' + size + ' bytes instead of the pinned ' + pin.asset.size + '. Not using it.');
    if (zh !== pin.asset.zipSha256) throw new Error('the archive does not match the pinned SHA-256 (' + zh + ' instead of ' + pin.asset.zipSha256 + '). Not using it.');
    console.log('archive OK (' + mb(size) + ', size and SHA-256 match the pin).');

    const stage = path.join(tmp, 'x');
    fs.mkdirSync(stage);
    const r = spawnSync('tar', ['-xf', zip, '-C', stage], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('could not extract the archive: ' + String(r.stderr || r.error || '').slice(0, 400));
    const src = path.join(stage, pin.folder);
    if (!fs.existsSync(path.join(src, 'makensis.exe'))) throw new Error('the archive has no ' + pin.folder + '/makensis.exe');
    const kept = path.join(tmp, 'kept');
    fs.mkdirSync(kept);
    for (const d of KEEP_DIRS) fs.cpSync(path.join(src, d), path.join(kept, d), { recursive: true });
    for (const f of KEEP_FILES) fs.copyFileSync(path.join(src, f), path.join(kept, f));
    const tree = treeHash(kept);

    if (updatePin) {
      pin.treeSha256 = tree.hash;
      fs.writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2) + '\n', 'utf8');
      console.log('Pin updated: tree hash of ' + tree.count + ' files = ' + tree.hash);
    } else if (tree.hash !== pin.treeSha256) {
      throw new Error('the extracted files do not match the pin (tree hash ' + tree.hash + ')');
    }
    rm(compilerDir(pin));
    fs.mkdirSync(DIR, { recursive: true });
    fs.cpSync(kept, compilerDir(pin), { recursive: true });
    const problems = verifyInstalled(loadPin());
    if (problems.length) throw new Error('verification after copying failed: ' + problems.join('; '));
    console.log('Installed to vendor/nsis/' + pin.folder + ' (' + tree.count + ' files).');
  } finally {
    rm(tmp);
  }
}

module.exports = { loadPin, verifyInstalled, sha256File, makensisPath, DIR, PIN_FILE };

if (require.main === module) {
  try { main(); } catch (e) { console.error('FETCH FAILED: ' + e.message); process.exit(1); }
}
