'use strict';
// Builds the portable Windows application (no installer, no administrator rights needed):
//   dist/VideoEditor-win32-x64/VideoEditor.exe
//   dist/VideoEditor-<version>-win-x64.zip
// FFmpeg/ffprobe are copied to resources/bin and llama-server (built-in local model) to resources/llama (outside app.asar, because they have to be
// executed). They come from the pinned, SHA-256-verified packages in vendor/ffmpeg (npm run ffmpeg:fetch) and vendor/llama (npm run llama:fetch).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// VE_DIST_DIR: build somewhere else (a staging folder, outside the project) so that an application that is still running from dist/ is never touched
const DIST = process.env.VE_DIST_DIR ? path.resolve(process.env.VE_DIST_DIR) : path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const pkg = require(path.join(ROOT, 'package.json'));
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const KEEP_LOCALES = new Set(['en-US.pak', 'tr.pak']);

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Antivirus scanners briefly lock freshly extracted files, which makes the packager's final directory rename fail with
// EPERM/EBUSY. The finished build is still in the temp folder then: move it into place with retries (copy as a last resort).
async function moveWithRetry(src, dest) {
  for (let i = 1; i <= 30; i++) {
    try {
      rm(dest);
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (i === 1) console.log('The final folder move is blocked (antivirus scan?) - retrying ...');
      await sleep(2000);
    }
  }
  console.log('Renaming kept failing - copying instead ...');
  rm(dest);
  fs.cpSync(src, dest, { recursive: true });
  rm(src);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function stageBinaries() {
  // ffmpeg and ffprobe come from ONE pinned package (vendor/ffmpeg, see scripts/fetch-ffmpeg.js); the build stops if anything differs from the pin.
  const fetcher = require('./fetch-ffmpeg');
  const pin = fetcher.loadPin();
  const problems = fetcher.verifyInstalled(pin);
  if (problems.length) throw new Error('vendor/ffmpeg does not match vendor/ffmpeg/ffmpeg-pin.json (run: npm run ffmpeg:fetch): ' + problems.join('; '));
  const out = path.join(BUILD, 'bin');
  rm(BUILD);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(fetcher.BIN, 'ffmpeg.exe'), path.join(out, 'ffmpeg.exe'));
  fs.copyFileSync(path.join(fetcher.BIN, 'ffprobe.exe'), path.join(out, 'ffprobe.exe'));
  // licence texts that must travel with the binaries
  fs.copyFileSync(path.join(fetcher.DIR, 'LICENSE'), path.join(out, 'FFMPEG-LICENSE.txt'));
  fs.copyFileSync(path.join(fetcher.DIR, 'README.txt'), path.join(out, 'FFMPEG-BUILD-INFO.txt'));
  fs.writeFileSync(path.join(out, 'OKU-BENI.txt'), [
    'Bu klasor, Video Editor uygulamasinin kullandigi FFmpeg ve ffprobe programlarini icerir.',
    'FFmpeg ' + pin.version + ' (https://ffmpeg.org) GPL v3 lisansli bir derlemedir (www.gyan.dev "essentials" build); ffmpeg.exe ve ffprobe.exe ayni pakettendir.',
    'Lisans metni: FFMPEG-LICENSE.txt   Derleme bilgisi ve kaynak kodu baglantilari: FFMPEG-BUILD-INFO.txt',
    'Paketin SHA-256 degeri (gyan.dev ve GitHub ile ayni): ' + pin.zipSha256,
    '',
    'This folder contains the FFmpeg and ffprobe programs used by Video Editor.',
    'FFmpeg ' + pin.version + ' is a GPL v3 build (www.gyan.dev "essentials"); ffmpeg.exe and ffprobe.exe come from the same package. See FFMPEG-LICENSE.txt and FFMPEG-BUILD-INFO.txt (build info and source links).',
    'SHA-256 of the package (identical at gyan.dev and GitHub): ' + pin.zipSha256,
    '',
  ].join('\r\n'), 'utf8');
  return out;
}

function trimLocales(appDir) {
  const dir = path.join(appDir, 'locales');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (!KEEP_LOCALES.has(f)) rm(path.join(dir, f));
}

// The runtime of the built-in local model: llama-server of llama.cpp (MIT), a CPU build (always works) and a Vulkan build (graphics chip),
// from the pinned, SHA-256-verified package in vendor/llama (npm run llama:fetch). The model itself is NOT part of the application: the user
// downloads it on request (see src/main/llm/).
function stageLlama() {
  const fetcher = require('./fetch-llama');
  const pin = fetcher.loadPin();
  const problems = fetcher.verifyInstalled(pin);
  if (problems.length) throw new Error('vendor/llama does not match vendor/llama/llama-pin.json (run: npm run llama:fetch): ' + problems.join('; '));
  const out = path.join(BUILD, 'llama');
  fs.mkdirSync(out, { recursive: true });
  for (const b of fetcher.BACKENDS) fs.cpSync(path.join(fetcher.DIR, b), path.join(out, b), { recursive: true });
  fs.copyFileSync(path.join(fetcher.DIR, 'LICENSE'), path.join(out, 'LLAMA-CPP-LICENSE.txt'));
  fs.writeFileSync(path.join(out, 'OKU-BENI.txt'), [
    'Bu klasor, Video Editor uygulamasinin yerlesik yerel yapay zeka modelini calistiran llama-server programini icerir (llama.cpp ' + pin.tag + ', MIT lisansi; metin: LLAMA-CPP-LICENSE.txt).',
    'cpu : her bilgisayarda calisan surum.   vk : ekran kartini (Vulkan) kullanan surum; calismazsa uygulama otomatik olarak cpu surumune gecer.',
    'Model dosyalari uygulamayla GELMEZ: kullanici "Indir ve kur" dugmesine bastiginda yalnizca huggingface.co adresinden indirilir ve SHA-256 degerleriyle dogrulanir (Qwen3.5-4B, Apache-2.0).',
    'llama-server yalnizca 127.0.0.1 uzerinde, her acilista degisen rastgele bir anahtarla dinler; uygulama kapaninca durdurulur.',
    '',
    'This folder contains llama-server (llama.cpp ' + pin.tag + ', MIT licence; text in LLAMA-CPP-LICENSE.txt), which runs the built-in local AI model of Video Editor.',
    'cpu: the build that runs everywhere.   vk: the build that uses the graphics chip (Vulkan); if it cannot start, the app falls back to the cpu build automatically.',
    'The model files are NOT part of the application: they are downloaded only from huggingface.co when the user presses "Download and install" and are verified against pinned SHA-256 values (Qwen3.5-4B, Apache-2.0).',
    'llama-server only listens on 127.0.0.1 with a random key that changes at every start, and it is stopped when the app quits.',
    '',
  ].join('\r\n'), 'utf8');
  return out;
}

// Whatever ends up in the application folder is checked against the pin once more (file by file, nothing missing, nothing extra).
function verifyPackagedLlama(appDir) {
  const fetcher = require('./fetch-llama');
  const pin = fetcher.loadPin();
  const problems = [];
  for (const b of fetcher.BACKENDS) {
    const dir = path.join(appDir, 'resources', 'llama', b);
    const want = pin.files[b];
    for (const name of Object.keys(want)) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) { problems.push(b + '/' + name + ' is missing'); continue; }
      if (fetcher.sha256File(p) !== want[name]) problems.push(b + '/' + name + ' differs from the pin');
    }
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) if (!(name in want)) problems.push(b + '/' + name + ' is not in the pin');
  }
  return problems;
}

// Electron "fuses" are switches inside VideoEditor.exe itself. They take away ways to turn the program into a general-purpose Node.js
// interpreter or to replace its code, which is what a local attacker (or malware running as the same user) would try first.
async function hardenExecutable(exe) {
  const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options: F, FuseState } = await import('@electron/fuses');
  const wanted = {
    [F.RunAsNode]: false, // ELECTRON_RUN_AS_NODE=1 would make VideoEditor.exe a plain Node.js interpreter
    [F.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS can no longer inject code
    [F.EnableNodeCliInspectArguments]: false, // --inspect and friends are ignored
    [F.EnableEmbeddedAsarIntegrityValidation]: true, // app.asar is checked against the hash embedded in the exe
    [F.OnlyLoadAppFromAsar]: true, // an unpacked "app" folder cannot replace app.asar
    [F.EnableCookieEncryption]: true,
  };
  await flipFuses(exe, Object.assign({ version: FuseVersion.V1 }, wanted));
  const wire = await getCurrentFuseWire(exe);
  const problems = [];
  for (const [key, on] of Object.entries(wanted)) {
    const state = wire[key];
    if (state !== (on ? FuseState.ENABLE : FuseState.DISABLE)) problems.push(F[key] + ' is not ' + (on ? 'enabled' : 'disabled'));
  }
  if (problems.length) throw new Error('Electron fuses were not applied: ' + problems.join('; '));
  return Object.entries(wanted).map(([key, on]) => F[key] + '=' + (on ? 'on' : 'off')).join(', ');
}

function writeExtras(appDir) {
  fs.writeFileSync(path.join(appDir, 'Masaustu-Kisayolu-Olustur.cmd'), [
    '@echo off',
    'rem Creates a Desktop shortcut for the current user (no administrator rights needed).',
    'rem The folder reaches PowerShell through an environment variable: a folder name with an apostrophe or other special characters cannot break the command.',
    'set "VE_DIR=%~dp0"',
    'powershell -NoProfile -Command "$d=$env:VE_DIR; $s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath(\'Desktop\')+\'\\Video Editor.lnk\'); $s.TargetPath=$d+\'VideoEditor.exe\'; $s.WorkingDirectory=$d; $s.IconLocation=$d+\'VideoEditor.exe,0\'; $s.Save()"',
    'if errorlevel 1 (echo Kisayol olusturulamadi / Could not create the shortcut) else (echo Masaustu kisayolu olusturuldu / Desktop shortcut created)',
    'pause',
    '',
  ].join('\r\n'), 'utf8');
  const readme = path.join(ROOT, 'README.md');
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(appDir, 'README.md'));
  // The user guide (TR + EN) travels next to the exe, together with the screenshots it links to.
  const guide = path.join(ROOT, 'KULLANIM-KILAVUZU-USER-GUIDE.md');
  if (fs.existsSync(guide)) {
    fs.copyFileSync(guide, path.join(appDir, path.basename(guide)));
    const shots = path.join(ROOT, 'docs', 'screenshots');
    if (fs.existsSync(shots)) fs.cpSync(shots, path.join(appDir, 'docs', 'screenshots'), { recursive: true });
    // further documents the guide links to (e.g. the object-understanding feasibility study)
    const docsDir = path.join(ROOT, 'docs');
    if (fs.existsSync(docsDir)) {
      for (const f of fs.readdirSync(docsDir)) {
        if (!/\.md$/i.test(f)) continue;
        fs.mkdirSync(path.join(appDir, 'docs'), { recursive: true });
        fs.copyFileSync(path.join(docsDir, f), path.join(appDir, 'docs', f));
      }
    }
  }
}

function zip(appDir) {
  const zipPath = path.join(DIST, `VideoEditor-${pkg.version}-win-x64.zip`);
  rm(zipPath);
  const parent = path.dirname(appDir);
  const name = path.basename(appDir);
  let r = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', parent, name], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(zipPath)) {
    r = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${appDir}' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
  }
  return fs.existsSync(zipPath) ? zipPath : null;
}

async function main() {
  const t0 = Date.now();
  if (!fs.existsSync(path.join(ROOT, 'assets', 'icon.ico'))) require('./make-icons');
  const binDir = stageBinaries();
  const llamaDir = stageLlama();
  console.log('Packaging Electron ' + electronVersion + ' ...');
  const { packager } = await import('@electron/packager');
  const options = {
    dir: ROOT,
    out: DIST,
    name: 'VideoEditor',
    executableName: 'VideoEditor',
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    appVersion: pkg.version,
    appCopyright: 'Video Editor',
    overwrite: true,
    asar: true,
    prune: false,
    junk: true,
    quiet: true,
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    extraResource: [binDir, llamaDir],
    ignore: [/^\/node_modules($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/assets($|\/)/, /^\/docs($|\/)/, /^\/installer($|\/)/, /^\/vendor($|\/)/, /^\/web($|\/)/, /^\/dist($|\/)/, /^\/build($|\/)/, /^\/\.gitignore$/, /^\/package-lock\.json$/, /^\/README\.md$/, /^\/KULLANIM-KILAVUZU-USER-GUIDE\.md$/],
    win32metadata: {
      CompanyName: 'Video Editor',
      FileDescription: 'Video Editör',
      ProductName: 'Video Editör',
      InternalName: 'VideoEditor',
      OriginalFilename: 'VideoEditor.exe',
    },
  };
  let outDirs;
  try {
    outDirs = await packager(options);
  } catch (e) {
    if (e && e.code === 'EPERM' && e.syscall === 'rename' && e.path && e.dest && fs.existsSync(e.path)) {
      await moveWithRetry(e.path, e.dest);
      outDirs = [e.dest];
    } else {
      throw e;
    }
  }
  const appDir = outDirs[0];
  trimLocales(appDir);
  writeExtras(appDir);
  rm(BUILD);
  const exe = path.join(appDir, 'VideoEditor.exe');
  if (!fs.existsSync(exe)) throw new Error('VideoEditor.exe was not produced');
  console.log('Fuses      : ' + await hardenExecutable(exe));
  if (!fs.existsSync(path.join(appDir, 'resources', 'bin', 'ffmpeg.exe'))) throw new Error('ffmpeg.exe missing from resources/bin');
  const llamaProblems = verifyPackagedLlama(appDir);
  if (llamaProblems.length) throw new Error('resources/llama does not match the pin: ' + llamaProblems.join('; '));
  // release gate: the package must be made of the code that is in the working tree right now
  const stale = require('./verify-package').verify(appDir);
  if (stale.length) throw new Error('the package is not current: ' + stale.slice(0, 5).join('; '));
  console.log('App folder : ' + appDir + '  (' + mb(dirSize(appDir)) + ')');
  console.log('Executable : ' + exe);
  const z = zip(appDir);
  if (z) console.log('Zip        : ' + z + '  (' + mb(fs.statSync(z).size) + ')');
  console.log('Done in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
}

main().catch((e) => { console.error('PACKAGING FAILED:', e); process.exit(1); });
