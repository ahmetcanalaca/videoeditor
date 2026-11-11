'use strict';
// Builds the per-user installer (NSIS, no administrator rights) from the packaged application folder:
//
//   npm run package        first: dist/VideoEditor-win32-x64 (hardened exe, FFmpeg, llama-server, docs)
//   npm run installer      then:  dist/VideoEditor-<version>-Setup-x64.exe  +  .sha256
//
// installer/VideoEditor.nsi is the hand-written script; this file generates the two file lists it includes (what to install, and the SAME list
// as Delete commands for the uninstaller - the uninstaller never deletes a folder recursively) and runs the pinned makensis (vendor/nsis).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
// VE_DIST_DIR (see package.js): build from / into a staging folder, so that an application still running from dist/ is never touched
const DIST = process.env.VE_DIST_DIR ? path.resolve(process.env.VE_DIST_DIR) : path.join(ROOT, 'dist');
const APP_DIR = path.join(DIST, 'VideoEditor-win32-x64');
const GEN = path.join(ROOT, 'build', 'installer');
// --fast: a quickly compiled test build (zlib, bigger) in build/; never for distribution. Its "application data folder" is a sandbox folder so that
// the uninstaller tests can exercise the delete-my-data path without touching the real %APPDATA%\VideoEditor of whoever runs them.
const FAST = process.argv.includes('--fast');
const TEST_DATA_DIR = path.join(ROOT, 'build', 'test-appdata');
const OUT_FILE = FAST ? path.join(ROOT, 'build', 'VideoEditor-fast-Setup-x64.exe') : path.join(DIST, `VideoEditor-${pkg.version}-Setup-x64.exe`);
const NSI = path.join(ROOT, 'installer', 'VideoEditor.nsi');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
// belongs to the portable folder only (an installed copy has a Start menu shortcut and an uninstaller)
const EXCLUDE = new Set(['Masaustu-Kisayolu-Olustur.cmd']);
const BOM = '\ufeff';

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const nsisStr = (s) => String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
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

// The installer must carry the hardened exe and the pinned runtimes, exactly as the packaging script produced them.
async function verifyApp() {
  const exe = path.join(APP_DIR, 'VideoEditor.exe');
  if (!fs.existsSync(exe)) throw new Error('dist/VideoEditor-win32-x64/VideoEditor.exe is missing: run "npm run package" first');
  const { getCurrentFuseWire, FuseV1Options: F, FuseState } = await import('@electron/fuses');
  const wire = await getCurrentFuseWire(exe);
  const want = { [F.RunAsNode]: FuseState.DISABLE, [F.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE, [F.EnableNodeCliInspectArguments]: FuseState.DISABLE, [F.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE, [F.OnlyLoadAppFromAsar]: FuseState.ENABLE };
  for (const [k, v] of Object.entries(want)) if (wire[k] !== v) throw new Error('the exe is not hardened (fuse ' + F[k] + '): run "npm run package" again');
  const llama = require('./fetch-llama');
  const pin = llama.loadPin();
  for (const b of llama.BACKENDS) {
    for (const [name, hash] of Object.entries(pin.files[b])) {
      const p = path.join(APP_DIR, 'resources', 'llama', b, name);
      if (!fs.existsSync(p) || llama.sha256File(p) !== hash) throw new Error('resources/llama/' + b + '/' + name + ' is missing or differs from the pin');
    }
  }
  if (!fs.existsSync(path.join(APP_DIR, 'resources', 'bin', 'ffmpeg.exe'))) throw new Error('resources/bin/ffmpeg.exe is missing');
  // release gate: the application folder has to be made of the code that is in the working tree right now (a stale package is never packed)
  const stale = require('./verify-package').verify(APP_DIR);
  if (stale.length) throw new Error('dist/VideoEditor-win32-x64 is not current (' + stale.slice(0, 3).join('; ') + '): run "npm run package" again');
  if (!fs.existsSync(ICON)) throw new Error('assets/icon.ico is missing (npm run icons)');
  if (!fs.existsSync(path.join(ROOT, 'installer', 'welcome.bmp'))) require('./make-installer-art').make();
}

function writeLists(files) {
  fs.rmSync(GEN, { recursive: true, force: true });
  fs.mkdirSync(GEN, { recursive: true });
  const byDir = new Map();
  for (const f of files) {
    const d = path.dirname(f) === '.' ? '' : path.dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const dirs = [...byDir.keys()].sort();
  const inst = ['; generated by scripts/make-installer.js - do not edit', ''];
  for (const d of dirs) {
    inst.push('SetOutPath "$INSTDIR' + (d ? '\\' + nsisStr(d) : '') + '"');
    for (const f of byDir.get(d).sort()) inst.push('File "' + nsisStr(path.join(APP_DIR, f)) + '"');
  }
  const uninst = ['; generated by scripts/make-installer.js - do not edit', ''];
  for (const f of files.slice().sort()) uninst.push('Delete "$INSTDIR\\' + nsisStr(f) + '"');
  // folders: only empty ones are removed (RMDir without /r), deepest first, so a folder the user put other things into stays
  const allDirs = new Set();
  for (const d of dirs) { let cur = d; while (cur) { allDirs.add(cur); cur = path.dirname(cur) === '.' ? '' : path.dirname(cur); } }
  for (const d of [...allDirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || (a < b ? 1 : -1))) uninst.push('RMDir "$INSTDIR\\' + nsisStr(d) + '"');
  fs.writeFileSync(path.join(GEN, 'files-install.nsh'), BOM + inst.join('\r\n') + '\r\n', 'utf8');
  fs.writeFileSync(path.join(GEN, 'files-uninstall.nsh'), BOM + uninst.join('\r\n') + '\r\n', 'utf8');
}

async function main() {
  const t0 = Date.now();
  await verifyApp();
  const nsis = require('./fetch-nsis');
  const problems = nsis.verifyInstalled(nsis.loadPin());
  if (problems.length) throw new Error('vendor/nsis does not match the pin (run: npm run nsis:fetch): ' + problems.join('; '));

  const files = walk(APP_DIR, APP_DIR, []).filter((f) => !EXCLUDE.has(f));
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(APP_DIR, f)).size, 0);
  writeLists(files);
  console.log('Installing ' + files.length + ' files (' + mb(bytes) + ' uncompressed); compressing' + (FAST ? ' (fast test build)' : ' (LZMA, solid) - this takes about ten minutes') + ' ...');

  fs.rmSync(OUT_FILE, { force: true });
  const args = ['/V2', '/DVERSION=' + pkg.version, '/DAPPDIR=' + APP_DIR, '/DOUTFILE=' + OUT_FILE, '/DICON=' + ICON, '/DGEN=' + GEN, '/DART=' + path.join(ROOT, 'installer')].concat(FAST ? ['/DFAST', '/DDATA_DIR=' + TEST_DATA_DIR] : [], [NSI]);
  const r = spawnSync(nsis.makensisPath(), args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0 || !fs.existsSync(OUT_FILE)) throw new Error('makensis failed (exit ' + r.status + ')');

  const hash = sha256File(OUT_FILE);
  if (!FAST) fs.writeFileSync(OUT_FILE + '.sha256', hash + ' *' + path.basename(OUT_FILE) + '\n', 'utf8');
  console.log('Installer : ' + OUT_FILE + '  (' + mb(fs.statSync(OUT_FILE).size) + ')');
  console.log('SHA-256   : ' + hash);
  console.log('Done in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
}

main().catch((e) => { console.error('INSTALLER FAILED:', e.message || e); process.exit(1); });
