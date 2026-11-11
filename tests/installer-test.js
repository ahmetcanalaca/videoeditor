'use strict';
// Tests of the per-user installer (installer/VideoEditor.nsi) in SILENT mode, where nothing is shown and everything can be checked:
//   node tests/installer-test.js                    the release installer dist\VideoEditor-<version>-Setup-x64.exe
//   node tests/installer-test.js --setup=<exe>      another build. The FAST test build (build\VideoEditor-fast-Setup-x64.exe, made by
//                                                   "node scripts/make-installer.js --fast") is compiled with a sandbox data folder
//                                                   (build\test-appdata), so it also runs the "delete my data" checks without touching the real
//                                                   %APPDATA%\VideoEditor of whoever runs the test.
// Everything lands in a temp folder with spaces and Turkish letters. The Start menu / Desktop shortcuts and the HKCU keys the installer writes are
// removed again by the uninstaller, and that is checked. A real installation of the app in another folder makes the test refuse to run.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, sleep } = require('./ui-lib');
const { step, assert, summary, ud } = require('./ui-helpers');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const DIST = process.env.VE_DIST_DIR ? path.resolve(process.env.VE_DIST_DIR) : path.join(ROOT, 'dist'); // a staging folder (see scripts/package.js)
const SETUP_SRC = path.resolve(arg('setup', path.join(DIST, `VideoEditor-${pkg.version}-Setup-x64.exe`)));
const FAST = /fast/i.test(path.basename(SETUP_SRC));
const APP_DIR = path.join(DIST, 'VideoEditor-win32-x64');
const BASE = path.join(os.tmpdir(), 've-installer-test');
const WORK = path.join(BASE, 'work'); // no spaces: the installer is started from here
const INST = path.join(BASE, 'Kurulum Çalışması ğüşiöç', 'Video Editor');
const SETUP = path.join(WORK, 'setup.exe');
const SANDBOX_DATA = path.join(ROOT, 'build', 'test-appdata');
const UNINST_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VideoEditor';
const APP_KEY = 'HKCU\\Software\\VideoEditor';

// PowerShell, with the answer passed back as base64 of UTF-8 (console output would mangle Turkish letters)
function ps(expr) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$(${expr})))`], { encoding: 'utf8' });
  return Buffer.from(String(r.stdout).trim(), 'base64').toString('utf8').trim();
}
// the real folders (the Desktop of a managed PC is often redirected to OneDrive)
const START_MENU = path.join(ps("[Environment]::GetFolderPath('Programs')"), 'Video Editör.lnk');
const DESKTOP = path.join(ps("[Environment]::GetFolderPath('Desktop')"), 'Video Editör.lnk');

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// cmd.exe starts the program with a correctly quoted program path while "/D=<folder>" stays the unquoted last argument (an NSIS rule)
function cmd(line, timeout) {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], { windowsVerbatimArguments: true, encoding: 'utf8', timeout: timeout || 900000 });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
const install = (extra) => cmd('"' + SETUP + '" /S ' + (extra ? extra + ' ' : '') + '/D=' + INST);
// a registry value ('(Default)' for the default one) or, without a name, 'exists' / null for the key
function reg(key, name) {
  const k = 'Registry::' + key.replace(/'/g, "''");
  if (!name) return ps(`Test-Path -LiteralPath '${k}'`) === 'True' ? 'exists' : null;
  const prop = name === '(Default)' ? '(default)' : name;
  const v = ps(`$p = Get-ItemProperty -LiteralPath '${k}' -ErrorAction SilentlyContinue; if ($p -and $p.PSObject.Properties['${prop}']) { $p.'${prop}' }`);
  return v === '' ? null : v;
}
function lnkTarget(lnk) {
  if (!fs.existsSync(lnk)) return null;
  // Shell.Application reads the link as Unicode (WScript.Shell's TargetPath turns ş, ğ, ı into s, g, i)
  const q = (s) => s.replace(/'/g, "''");
  return ps(`(New-Object -ComObject Shell.Application).Namespace('${q(path.dirname(lnk))}').ParseName('${q(path.basename(lnk))}').GetLink.Path`);
}
async function waitGone(p, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!fs.existsSync(p)) return true; await sleep(500); }
  return !fs.existsSync(p);
}
// the uninstaller exactly as Windows runs it ("Installed apps" -> Uninstall): it copies itself to %TEMP% and returns at once
async function uninstall(extra) {
  const q = reg(UNINST_KEY, 'QuietUninstallString');
  assert(q && /uninstall\.exe"? \/S/i.test(q), 'QuietUninstallString: ' + q);
  const r = cmd(q + (extra ? ' ' + extra : ''), 120000);
  assert(r.code === 0, 'uninstaller exit code ' + r.code);
  assert(await waitGone(path.join(INST, 'VideoEditor.exe'), 120000), 'the program files are still there');
  for (let i = 0; i < 60 && reg(UNINST_KEY); i++) await sleep(500);
}

(async () => {
  if (process.platform !== 'win32') { console.error('Windows only'); process.exit(2); }
  if (!fs.existsSync(SETUP_SRC)) { console.error('installer not found: ' + SETUP_SRC + '\n(build it: npm run package && npm run installer, or node scripts/make-installer.js --fast)'); process.exit(2); }
  if (!fs.existsSync(path.join(APP_DIR, 'VideoEditor.exe'))) { console.error('dist\\VideoEditor-win32-x64 is missing: npm run package'); process.exit(2); }
  rm(BASE);
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(SETUP_SRC, SETUP);
  console.log('Testing ' + SETUP_SRC + (FAST ? '  (fast test build: data folder sandbox ' + SANDBOX_DATA + ')' : ''));

  try {
    await step('I01 no other installation of the app is registered (the test never touches a real one)', async () => {
      const loc = reg(UNINST_KEY, 'InstallLocation');
      assert(!loc || path.resolve(loc).toLowerCase().startsWith(BASE.toLowerCase()), 'a real installation exists at ' + loc + ' - uninstall it first');
      assert(!fs.existsSync(START_MENU) || loc, 'a Start menu shortcut exists without a registration: ' + START_MENU);
    });

    await step('I02 the installer asks for NO administrator rights (asInvoker) and has the version information', async () => {
      const buf = fs.readFileSync(SETUP_SRC);
      assert(buf.includes(Buffer.from('asInvoker')), 'no asInvoker in the manifest');
      assert(!buf.includes(Buffer.from('requireAdministrator')), 'it asks for administrator rights');
      assert(buf.includes(Buffer.from(pkg.version, 'utf16le')), 'version ' + pkg.version + ' not found in the version resource');
    });

    await step('I03 silent install into a folder with spaces and Turkish letters (/S /LANG=tr /D=...)', async () => {
      const t0 = Date.now();
      const r = install('/LANG=tr');
      assert(r.code === 0, 'exit code ' + r.code + ' ' + r.out);
      console.log('      installed in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
      assert(fs.existsSync(path.join(INST, 'VideoEditor.exe')), 'no exe in ' + INST);
    });

    await step('I04 every file of the packaged app is installed, byte for byte; the uninstaller is there; the portable-only helper is not', async () => {
      const rel = [];
      (function collect(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) collect(p); else rel.push(path.relative(APP_DIR, p)); } })(APP_DIR);
      const want = rel.filter((f) => f !== 'Masaustu-Kisayolu-Olustur.cmd');
      let bad = 0;
      for (const f of want) {
        const p = path.join(INST, f);
        if (!fs.existsSync(p) || fs.statSync(p).size !== fs.statSync(path.join(APP_DIR, f)).size) bad++;
      }
      assert(bad === 0, bad + ' files are missing or have another size');
      for (const f of ['VideoEditor.exe', 'resources\\app.asar', 'resources\\bin\\ffmpeg.exe', 'resources\\bin\\ffprobe.exe', 'resources\\llama\\cpu\\llama-server.exe', 'resources\\llama\\vk\\ggml-vulkan.dll']) {
        assert(sha256(path.join(INST, f)) === sha256(path.join(APP_DIR, f)), f + ' differs from the package');
      }
      assert(fs.existsSync(path.join(INST, 'uninstall.exe')), 'no uninstall.exe');
      assert(!fs.existsSync(path.join(INST, 'Masaustu-Kisayolu-Olustur.cmd')), 'the portable-only helper was installed');
      return want.length + ' files';
    });

    await step('I05 Start menu shortcut points to the installed exe; no Desktop shortcut unless asked for', async () => {
      assert(lnkTarget(START_MENU).toLowerCase() === path.join(INST, 'VideoEditor.exe').toLowerCase(), 'start menu target: ' + lnkTarget(START_MENU));
      assert(!fs.existsSync(DESKTOP), 'a desktop shortcut was created without asking');
    });

    await step('I06 registry (current user only): "Installed apps" entry, .vedproj association, remembered language', async () => {
      assert(reg(UNINST_KEY, 'DisplayName') === 'Video Editör', String(reg(UNINST_KEY, 'DisplayName')));
      assert(reg(UNINST_KEY, 'DisplayVersion') === pkg.version, String(reg(UNINST_KEY, 'DisplayVersion')));
      assert(path.resolve(reg(UNINST_KEY, 'InstallLocation')).toLowerCase() === INST.toLowerCase(), String(reg(UNINST_KEY, 'InstallLocation')));
      assert(/^"[^"]+uninstall\.exe"$/i.test(reg(UNINST_KEY, 'UninstallString')), String(reg(UNINST_KEY, 'UninstallString')));
      assert(/^"[^"]+uninstall\.exe" \/S$/i.test(reg(UNINST_KEY, 'QuietUninstallString')), String(reg(UNINST_KEY, 'QuietUninstallString')));
      assert(Number(reg(UNINST_KEY, 'EstimatedSize')) > 300000, 'EstimatedSize ' + reg(UNINST_KEY, 'EstimatedSize'));
      assert(reg(UNINST_KEY, 'NoModify') === '1', 'NoModify: ' + reg(UNINST_KEY, 'NoModify'));
      assert(reg('HKCU\\Software\\Classes\\.vedproj', '(Default)') === 'VideoEditor.Project', 'association: ' + reg('HKCU\\Software\\Classes\\.vedproj', '(Default)'));
      const open = reg('HKCU\\Software\\Classes\\VideoEditor.Project\\shell\\open\\command', '(Default)');
      assert(open && open.toLowerCase().includes(path.join(INST, 'VideoEditor.exe').toLowerCase()) && /"%1"$/.test(open), 'open command: ' + open);
      assert(parseInt(reg(APP_KEY, 'InstallerLanguage'), 10) === 1055, 'language ' + reg(APP_KEY, 'InstallerLanguage'));
      assert(!reg('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VideoEditor'), 'something was written to HKLM');
    });

    await step('I07 the installed program (in its Turkish-lettered folder) runs its self-test: FFmpeg, libx264, perspective, both llama builds', async () => {
      const out = path.join(WORK, 'selftest.json');
      // an own profile folder: another copy of the app that may be running on this PC (single-instance lock on the default profile) must not matter
      const r = cmd('"' + path.join(INST, 'VideoEditor.exe') + '" --selftest-out=' + out + ' --user-data-dir=' + path.join(WORK, 'selftest-profile'), 120000);
      assert(r.code === 0 && fs.existsSync(out), 'exit ' + r.code + ' ' + r.out);
      const j = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert(j.ok && j.packaged && j.libx264 && j.aac && j.perspective && j.llama && j.llama.cpu && j.llama.vk, JSON.stringify(j));
      assert(j.ffmpeg.toLowerCase().startsWith(INST.toLowerCase()), 'ffmpeg is not the installed one: ' + j.ffmpeg);
    });

    await step('I08 the installed exe keeps its hardening (Electron fuses)', async () => {
      const { getCurrentFuseWire, FuseV1Options: F, FuseState } = await import('@electron/fuses');
      const wire = await getCurrentFuseWire(path.join(INST, 'VideoEditor.exe'));
      assert(wire[F.RunAsNode] === FuseState.DISABLE && wire[F.EnableNodeOptionsEnvironmentVariable] === FuseState.DISABLE && wire[F.EnableNodeCliInspectArguments] === FuseState.DISABLE, 'node fuses');
      assert(wire[F.EnableEmbeddedAsarIntegrityValidation] === FuseState.ENABLE && wire[F.OnlyLoadAppFromAsar] === FuseState.ENABLE, 'asar fuses');
    });

    await step('I09 a running copy blocks the installer (exit code 5, nothing changed); after closing the app the same command works', async () => {
      const app = await launch({ exe: path.join(INST, 'VideoEditor.exe'), userData: ud('installer-running'), port: 9449 });
      try {
        const before = sha256(path.join(INST, 'resources', 'app.asar'));
        const r = install('/LANG=tr');
        assert(r.code === 5, 'expected exit code 5 while the app runs, got ' + r.code);
        assert(sha256(path.join(INST, 'resources', 'app.asar')) === before, 'files changed although the install was refused');
        assert(fs.existsSync(path.join(INST, 'uninstall.exe')), 'the uninstaller disappeared');
      } finally {
        await app.close();
      }
      for (let i = 0; i < 40; i++) { try { const fd = fs.openSync(path.join(INST, 'VideoEditor.exe'), 'r+'); fs.closeSync(fd); break; } catch (e) { await sleep(500); } }
      const r2 = install('/LANG=tr');
      assert(r2.code === 0, 'install after closing: exit ' + r2.code + ' ' + r2.out);
    });

    await step('I10 upgrade over the same folder with /DESKTOP /NOASSOC /LANG=en: desktop shortcut yes, association no, English remembered, files of others stay', async () => {
      fs.writeFileSync(path.join(INST, 'keep.txt'), 'not mine');
      const r = install('/DESKTOP /NOASSOC /LANG=en');
      assert(r.code === 0, 'exit ' + r.code + ' ' + r.out);
      assert(fs.existsSync(path.join(INST, 'VideoEditor.exe')) && fs.existsSync(path.join(INST, 'uninstall.exe')), 'program files missing');
      assert(lnkTarget(DESKTOP).toLowerCase() === path.join(INST, 'VideoEditor.exe').toLowerCase(), 'desktop shortcut: ' + lnkTarget(DESKTOP));
      assert(!reg('HKCU\\Software\\Classes\\.vedproj', '(Default)'), '/NOASSOC was ignored');
      assert(parseInt(reg(APP_KEY, 'InstallerLanguage'), 10) === 1033, 'language ' + reg(APP_KEY, 'InstallerLanguage'));
      assert(fs.readFileSync(path.join(INST, 'keep.txt'), 'utf8') === 'not mine', 'a foreign file was touched');
      assert(sha256(path.join(INST, 'VideoEditor.exe')) === sha256(path.join(APP_DIR, 'VideoEditor.exe')), 'exe differs after the upgrade');
    });

    await step('I11 uninstall as Windows runs it: only the installed files go (a foreign file and its folder stay); shortcuts and every registry key are gone', async () => {
      await uninstall();
      assert(!fs.existsSync(path.join(INST, 'VideoEditor.exe')) && !fs.existsSync(path.join(INST, 'resources')) && !fs.existsSync(path.join(INST, 'locales')), 'program files left');
      assert(!fs.existsSync(path.join(INST, 'uninstall.exe')), 'uninstall.exe left');
      assert(fs.existsSync(path.join(INST, 'keep.txt')), 'the foreign file was deleted: the uninstaller must never delete what it did not install');
      assert(!fs.existsSync(START_MENU) && !fs.existsSync(DESKTOP), 'shortcuts left');
      assert(!reg(UNINST_KEY) && !reg(APP_KEY) && !reg('HKCU\\Software\\Classes\\.vedproj') && !reg('HKCU\\Software\\Classes\\VideoEditor.Project'), 'registry keys left');
    });

    if (FAST) {
      await step('I12 "delete my data": a silent uninstall keeps the data folder, /PURGE removes it (sandbox folder of the test build)', async () => {
        rm(SANDBOX_DATA);
        fs.mkdirSync(path.join(SANDBOX_DATA, 'models'), { recursive: true });
        fs.writeFileSync(path.join(SANDBOX_DATA, 'settings.json'), '{"language":"en"}');
        fs.writeFileSync(path.join(SANDBOX_DATA, 'models', 'x.gguf'), 'x');
        let r = install('/LANG=tr');
        assert(r.code === 0, 'install ' + r.code);
        await uninstall();
        assert(fs.existsSync(path.join(SANDBOX_DATA, 'settings.json')), 'a silent uninstall deleted the data');
        r = install('/LANG=tr');
        assert(r.code === 0, 'install ' + r.code);
        assert(fs.existsSync(path.join(SANDBOX_DATA, 'settings.json')), 'the install touched the data');
        await uninstall('/PURGE');
        assert(!fs.existsSync(SANDBOX_DATA), 'the data folder is still there after /PURGE');
      });

      await step('I12b /PURGE never follows a junction: what a link inside the data folder points to survives, the link itself is removed', async () => {
        const victim = path.join(BASE, 'victim-folder');
        fs.mkdirSync(path.join(victim, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(victim, 'important.txt'), 'keep me');
        fs.writeFileSync(path.join(victim, 'sub', 'deep.txt'), 'keep me too');
        rm(SANDBOX_DATA);
        fs.mkdirSync(path.join(SANDBOX_DATA, 'models', 'qwen3.5-4b'), { recursive: true });
        fs.writeFileSync(path.join(SANDBOX_DATA, 'settings.json'), '{}');
        fs.writeFileSync(path.join(SANDBOX_DATA, 'models', 'qwen3.5-4b', 'readonly.gguf'), 'x');
        fs.chmodSync(path.join(SANDBOX_DATA, 'models', 'qwen3.5-4b', 'readonly.gguf'), 0o444); // a read-only file is removed too
        fs.symlinkSync(victim, path.join(SANDBOX_DATA, 'models', 'linked'), 'junction');
        fs.symlinkSync(victim, path.join(SANDBOX_DATA, 'models', 'qwen3.5-4b', 'again'), 'junction');
        const r = install('/LANG=tr');
        assert(r.code === 0, 'install ' + r.code);
        await uninstall('/PURGE');
        assert(!fs.existsSync(SANDBOX_DATA), 'the data folder (and the links in it) must be gone');
        assert(fs.existsSync(path.join(victim, 'important.txt')) && fs.readFileSync(path.join(victim, 'important.txt'), 'utf8') === 'keep me', 'the purge followed a junction and deleted what it points to');
        assert(fs.existsSync(path.join(victim, 'sub', 'deep.txt')), 'the purge followed a junction into a sub folder');
        rm(victim);
      });
    } else {
      console.log('SKIP  I12 "delete my data" (only with the fast test build, which has a sandbox data folder)');
    }
  } finally {
    // whatever happened: leave no registration or shortcut behind
    try { if (reg(UNINST_KEY)) { const q = reg(UNINST_KEY, 'QuietUninstallString'); if (q) cmd(q, 120000); } } catch (e) { /* ignore */ }
    for (let i = 0; i < 20 && reg(UNINST_KEY); i++) await sleep(500);
    for (const k of [UNINST_KEY, APP_KEY, 'HKCU\\Software\\Classes\\VideoEditor.Project']) if (reg(k)) spawnSync('reg.exe', ['delete', k, '/f']);
    if (reg('HKCU\\Software\\Classes\\.vedproj', '(Default)') === 'VideoEditor.Project') spawnSync('reg.exe', ['delete', 'HKCU\\Software\\Classes\\.vedproj', '/f']);
    for (const l of [START_MENU, DESKTOP]) rm(l);
    rm(BASE);
    if (FAST) rm(SANDBOX_DATA);
  }
  const failed = summary('installer');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('installer test crashed:', e); process.exit(2); });
