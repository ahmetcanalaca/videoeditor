'use strict';
// Tests of the Local AI helper (web/local-ai/). It is a Windows PowerShell script, so these run the real script with Windows PowerShell 5.1:
//   - static: pinned values in sync with the desktop app, ASCII-only script that parses, messages complete in both languages, the pack (zip) is valid
//   - downloads against a local mock server: resume after a cut connection through a redirect, a second run downloads nothing, a damaged file is replaced,
//     wrong content / wrong size / refused / offline are reported (exit code, nothing half-installed), the desktop app's model is reused and never touched,
//     files of an archive that are not pinned (or that try to leave the folder) are not unpacked, -Remove deletes only what the helper made
//   - REAL: the real llama-server with the real model (when the desktop assets are on this machine): only 127.0.0.1, key required, no key on the
//     command line, vision advertised, a Turkish/Unicode/space path, -Stop, "already running", a killed window (orphan) is taken over
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { checker } = require('./lib/site');
const real = require('./lib/helper-real');
const { pack, zip, FILES } = require('../scripts/local-ai-pack');

const WEB = path.resolve(__dirname, '..');
const REPO = path.resolve(WEB, '..');
const SRC = path.join(WEB, 'local-ai');
const PS = 'powershell.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 've-web-localai-test-'));
const check = checker('local-ai helper');

function ps(args, o) {
  const opts = o || {};
  // like a double-click in Explorer: no module folders handed over by a PowerShell 7 terminal (the launcher clears them too; test 25b)
  const env = Object.assign({}, process.env, { VE_LOCALAI_LANG: 'en', VE_LOCALAI_RETRY_DELAY: '0.05' }, opts.env || {});
  delete env.PSModulePath;
  return new Promise((resolve) => {
    const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SRC, 'local-ai.ps1'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.on('error', () => { /* the script did not read its input */ });
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (e) { /* gone */ } }, opts.timeout || 240000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
    child.stdin.end(opts.input === undefined ? '' : opts.input);
  });
}

function psCommand(cmd) {
  const r = spawnSync(PS, ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

/* ------------------------------------------------------------------ static checks */

function staticChecks() {
  const sync = spawnSync(process.execPath, [path.join(WEB, 'scripts', 'sync-desktop.js'), '--check'], { encoding: 'utf8' });
  check('01 pins.json is generated from the desktop catalog and the llama.cpp pin (nothing to edit by hand, nothing out of date)', sync.status === 0, sync.stdout + sync.stderr);

  const pins = JSON.parse(fs.readFileSync(path.join(SRC, 'pins.json'), 'utf8'));
  const cat = require(path.join(REPO, 'src', 'main', 'llm', 'catalog.js'));
  const m = cat.CATALOG[0];
  check('02 the pinned model files are the desktop app\'s: same size, same SHA-256, https from huggingface.co at a fixed revision', pins.model.files.length === m.files.length
    && pins.model.files.every((f, i) => f.sha256 === m.files[i].sha256 && f.size === m.files[i].size && cat.isAllowedDownloadUrl(f.url) && /\/resolve\/[0-9a-f]{40}\//.test(f.url)), pins.model.files.map((f) => f.url));
  check('03 the pinned engine downloads come from the github.com release of the pinned tag, with a SHA-256 for the zip and for every file', ['cpu', 'vk'].every((k) => pins.llama.assets[k].url.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/' + pins.llama.tag + '/')
    && /^[0-9a-f]{64}$/.test(pins.llama.assets[k].zipSha256) && Object.values(pins.llama.files[k]).every((h) => /^[0-9a-f]{64}$/.test(h)) && 'llama-server.exe' in pins.llama.files[k]));

  const script = fs.readFileSync(path.join(SRC, 'local-ai.ps1'));
  const cmd = fs.readFileSync(path.join(SRC, 'Start-Local-AI.cmd'));
  check('04 the script and the launcher are plain ASCII (Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI)', ![...script].some((b) => b > 127) && ![...cmd].some((b) => b > 127));
  const parse = psCommand("$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + path.join(SRC, 'local-ai.ps1') + "',[ref]$t,[ref]$e); $e.Count; $PSVersionTable.PSVersion.ToString()");
  check('05 the script parses without errors in Windows PowerShell 5.1', /^0\r?\n5\.1/.test(parse.out), parse.out + parse.err);

  const msgs = JSON.parse(fs.readFileSync(path.join(SRC, 'messages.json'), 'utf8'));
  const keys = (o) => Object.keys(o).sort();
  const holes = (o) => Object.values(o).map((v) => (String(v).match(/\{\d+\}/g) || []).sort().join(','));
  const used = Array.from(script.toString().matchAll(/\bT '([A-Za-z0-9.]+)'/g)).map((x) => x[1]);
  check('06 messages.json: English and Turkish have the same keys and the same {n} placeholders; every message the script uses exists', JSON.stringify(keys(msgs.en)) === JSON.stringify(keys(msgs.tr))
    && JSON.stringify(holes(msgs.en)) === JSON.stringify(holes(msgs.tr)) && used.every((k) => k in msgs.en), { missing: used.filter((k) => !(k in msgs.en)) });
  check('07 the Turkish messages really are Turkish (the special letters survived)', /[çğıöşüÇĞİÖŞÜ]/.test(msgs.tr.intro) && /ı|ş|ğ/.test(msgs.tr.ready));

  const out = path.join(tmpRoot, 'pack');
  const a = pack({ root: WEB, out });
  const b = pack({ root: WEB, out: path.join(tmpRoot, 'pack2') });
  check('08 the pack is reproducible: the same sources give the same zip bytes', a.info.zip.sha256 === b.info.zip.sha256 && a.info.zip.bytes === b.info.zip.bytes);
  const zipPath = path.join(a.dir, a.info.zip.name);
  const ex = path.join(tmpRoot, 'unzipped');
  const r = psCommand("Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + ex + "' -Force; (Get-ChildItem -LiteralPath '" + path.join(ex, 'VideoEditor-LocalAI') + "' | ForEach-Object Name) -join ','");
  const names = r.out.split(',').sort();
  check('09 Windows opens the zip: one folder with exactly the helper\'s files, byte for byte what info.json lists', JSON.stringify(names) === JSON.stringify(FILES.slice().sort())
    && a.info.files.every((f) => { const p = path.join(ex, 'VideoEditor-LocalAI', f.name); return fs.existsSync(p) && sha(fs.readFileSync(p)) === f.sha256 && fs.statSync(p).size === f.bytes; })
    && sha(fs.readFileSync(zipPath)) === a.info.zip.sha256, r.out + r.err);
  check('10 the files in the pack have Windows line endings and the readme has a byte-order mark (old Notepad)', ['local-ai.ps1', 'Start-Local-AI.cmd'].every((n) => { const t = fs.readFileSync(path.join(a.dir, n), 'utf8'); return !/[^\r]\n/.test(t) && /\r\n/.test(t); })
    && fs.readFileSync(path.join(a.dir, 'README.txt')).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
}

/* ------------------------------------------------------------------ downloads against a mock server */

function mockServer() {
  const state = { log: [], routes: {} };
  const server = http.createServer((req, res) => {
    const range = req.headers.range || '';
    state.log.push({ url: req.url, range });
    const route = state.routes[req.url.split('?')[0]];
    if (!route) { res.writeHead(404); res.end('no'); return; }
    route(req, res, range);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.base = 'http://127.0.0.1:' + state.port;
      state.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
      resolve(state);
    });
  });
}

// serves `data`; honours Range; `cutAt`: the first request without a range sends that many bytes and drops the connection
function serveBytes(data, o) {
  const opts = o || {};
  let cut = typeof opts.cutAt === 'number';
  return (req, res, range) => {
    const m = /^bytes=(\d+)-/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const body = data.subarray(start);
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length };
    if (m) headers['Content-Range'] = 'bytes ' + start + '-' + (data.length - 1) + '/' + data.length;
    res.writeHead(m ? 206 : 200, headers);
    if (cut && !m) {
      cut = false;
      res.write(body.subarray(0, opts.cutAt));
      setTimeout(() => res.destroy(), 50);
      return;
    }
    res.end(body);
  };
}

async function downloadChecks() {
  const rnd = (n) => crypto.randomBytes(n);
  const MODEL = rnd(3 * 1024 * 1024 + 123);
  const MMPROJ = rnd(1024 * 1024 + 7);
  const common = { 'llama-server.exe': rnd(2048), 'ggml.dll': rnd(4096) };
  const vkFiles = Object.assign({ 'ggml-vulkan.dll': rnd(3000) }, common);
  // archives with extras: a file nobody pinned, a nested one and one that tries to leave the folder
  const extras = [{ name: 'rpc-server.exe', data: rnd(100) }, { name: 'sub/x.dll', data: rnd(100) }, { name: '../evil.dll', data: rnd(100) }];
  const mkZip = (files) => zip(Object.keys(files).map((n) => ({ name: n, data: files[n] })).concat(extras));
  const vkZip = mkZip(vkFiles);
  const cpuZip = mkZip(common);
  const hashes = (files) => Object.fromEntries(Object.keys(files).sort().map((n) => [n, sha(files[n])]));

  const srv = await mockServer();
  const model = (name, aliases, url, data) => ({ role: name.includes('mmproj') ? 'mmproj' : 'model', name, aliases, url, size: data.length, sha256: sha(data) });
  const writePins = (extra) => {
    const pins = Object.assign({
      generated: 'test', site: 'http://127.0.0.1:1/videoeditor/', defaultPort: 8473,
      model: {
        id: 'qwen3.5-4b', name: 'Test model', dir: 'qwen3.5-4b', needsRamGb: 1,
        files: [model('Qwen3.5-4B-Q4_K_M.gguf', [], srv.base + '/model.bin', MODEL), model('Qwen3.5-4B-mmproj-F16.gguf', ['mmproj-F16.gguf'], srv.base + '/mmproj.bin', MMPROJ)],
      },
      llama: {
        tag: 'btest',
        assets: { cpu: { url: srv.base + '/cpu.zip', zipSha256: sha(cpuZip) }, vk: { url: srv.base + '/vk.zip', zipSha256: sha(vkZip) } },
        files: { cpu: hashes(common), vk: hashes(vkFiles) },
      },
    }, extra || {});
    const file = path.join(tmpRoot, 'pins-test.json');
    fs.writeFileSync(file, JSON.stringify(pins));
    return file;
  };
  const pinsFile = writePins();
  const reset = () => {
    srv.routes = {
      '/model.bin': (req, res) => { res.writeHead(302, { Location: '/cdn/model.bin' }); res.end(); },
      '/cdn/model.bin': serveBytes(MODEL, { cutAt: 1200000 }),
      '/mmproj.bin': serveBytes(MMPROJ),
      '/cpu.zip': serveBytes(cpuZip),
      '/vk.zip': serveBytes(vkZip),
    };
    srv.log.length = 0;
  };
  const appdata = path.join(tmpRoot, 'appdata');
  fs.mkdirSync(appdata, { recursive: true });
  const dataA = path.join(tmpRoot, 'data a');
  const run = (dataDir, extra, o) => ps(['-PinsFile', pinsFile, '-DataDir', dataDir, '-NoBrowser', '-PrepareOnly'].concat(extra || []), Object.assign({ env: { APPDATA: appdata } }, o || {}));
  const modelFile = (dir) => path.join(dir, 'models', 'qwen3.5-4b', 'Qwen3.5-4B-Q4_K_M.gguf');
  const mmprojFile = (dir) => path.join(dir, 'models', 'qwen3.5-4b', 'Qwen3.5-4B-mmproj-F16.gguf');

  try {
    reset();
    let r = await run(dataA);
    const ranged = srv.log.filter((e) => e.url === '/cdn/model.bin' && /^bytes=[1-9]\d*-$/.test(e.range));
    check('11 first run: everything is downloaded and checked (exit 0)', r.code === 0 && fs.existsSync(modelFile(dataA)) && sha(fs.readFileSync(modelFile(dataA))) === sha(MODEL) && sha(fs.readFileSync(mmprojFile(dataA))) === sha(MMPROJ), r.out.slice(-1500));
    check('12 a connection cut half way through a redirected download is continued with a Range request, not started again', ranged.length === 1 && /retrying/.test(r.out), { ranged, log: srv.log.slice(0, 8) });
    check('13 no half-downloaded files are left, and only the pinned files of the archives are unpacked (no extras, nothing outside the folder)', (() => {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const all = walk(dataA).map((p) => path.relative(dataA, p).split(path.sep).join('/'));
      const vk = all.filter((p) => p.startsWith('runtime/btest/vk/')).map((p) => path.basename(p)).sort();
      return !all.some((p) => /\.part$|\.new/.test(p)) && JSON.stringify(vk) === JSON.stringify(Object.keys(vkFiles).sort()) && !all.some((p) => /rpc-server|evil\.dll|x\.dll/.test(p)) && !fs.existsSync(path.join(dataA, 'runtime', 'btest', 'evil.dll'));
    })(), r.out.slice(-600));

    const before = srv.log.length;
    const t0 = Date.now();
    r = await run(dataA);
    check('14 second run: nothing is downloaded again and it is quick', r.code === 0 && srv.log.length === before && Date.now() - t0 < 30000, { requests: srv.log.length - before, ms: Date.now() - t0 });

    // a damaged copy (same size) in the helper's own folder is replaced
    const damaged = Buffer.from(MODEL);
    damaged[1000] ^= 0xff;
    fs.writeFileSync(modelFile(dataA), damaged);
    srv.log.length = 0;
    r = await run(dataA);
    check('15 a damaged file of the helper\'s own folder is thrown away and downloaded again', r.code === 0 && sha(fs.readFileSync(modelFile(dataA))) === sha(MODEL) && srv.log.some((e) => e.url === '/model.bin'), r.out.slice(-600));

    // the desktop app's model is used in place and never touched
    const desk = path.join(appdata, 'VideoEditor', 'models', 'qwen3.5-4b');
    fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, 'Qwen3.5-4B-Q4_K_M.gguf'), MODEL);
    fs.writeFileSync(path.join(desk, 'Qwen3.5-4B-mmproj-F16.gguf'), MMPROJ);
    const dataB = path.join(tmpRoot, 'data b');
    reset();
    r = await run(dataB);
    check('16 the model the desktop app already downloaded is used in place after the SHA-256 check: nothing of it is downloaded, nothing is copied', r.code === 0 && !srv.log.some((e) => /model|mmproj/.test(e.url)) && !fs.existsSync(modelFile(dataB)) && /found, checked/.test(r.out), r.out.slice(-600));
    const bad = Buffer.from(MODEL);
    bad[5] ^= 0xff;
    fs.writeFileSync(path.join(desk, 'Qwen3.5-4B-Q4_K_M.gguf'), bad);
    const dataC = path.join(tmpRoot, 'data c');
    reset();
    r = await run(dataC);
    check('17 a damaged copy in the desktop app\'s folder is not used and not deleted: the helper downloads its own', r.code === 0 && sha(fs.readFileSync(path.join(desk, 'Qwen3.5-4B-Q4_K_M.gguf'))) === sha(bad) && sha(fs.readFileSync(modelFile(dataC))) === sha(MODEL), r.out.slice(-400));
    fs.rmSync(path.join(appdata, 'VideoEditor'), { recursive: true, force: true });

    // content that does not match the pin
    const dataD = path.join(tmpRoot, 'data d');
    reset();
    const wrong = Buffer.from(MODEL);
    wrong[100] ^= 0xff;
    srv.routes['/cdn/model.bin'] = serveBytes(wrong);
    r = await run(dataD);
    check('18 wrong content is refused: exit code 3, the SHA-256 is named, nothing half-installed is left', r.code === 3 && /SHA-256/.test(r.out) && !fs.existsSync(modelFile(dataD)) && !fs.existsSync(modelFile(dataD) + '.part'), { code: r.code, out: r.out.slice(-500) });
    const dataE = path.join(tmpRoot, 'data e');
    reset();
    srv.routes['/cdn/model.bin'] = serveBytes(MODEL.subarray(0, MODEL.length - 1000));
    r = await run(dataE);
    check('19 a file of the wrong size is refused before it is kept: exit code 3', r.code === 3 && /unexpected size/.test(r.out) && !fs.existsSync(modelFile(dataE) + '.part'), { code: r.code, out: r.out.slice(-500) });
    const dataF = path.join(tmpRoot, 'data f');
    reset();
    srv.routes['/cdn/model.bin'] = (req, res) => { res.writeHead(403); res.end('blocked by the proxy'); };
    r = await run(dataF);
    // (on a Windows runner os.tmpdir() is an 8.3 short path while PowerShell prints the long one: compare from the folder's own name on)
    check('20 a refused download (a proxy or firewall) gives exit code 2, says so, and tells how to download by hand (address and folder)', r.code === 2 && /refused the download \(403\)/.test(r.out) && r.out.includes(srv.base + '/model.bin') && r.out.includes(path.join(path.basename(dataF), 'models', 'qwen3.5-4b')), { code: r.code, out: r.out.slice(-900) });
    check('21 a refused download is not retried over and over', srv.log.filter((e) => e.url === '/cdn/model.bin').length === 1, srv.log.filter((e) => e.url === '/cdn/model.bin').length);

    // other data in the folder of a -Remove
    const keepFile = path.join(dataA, 'keep.txt');
    fs.writeFileSync(keepFile, 'mine');
    fs.mkdirSync(path.join(dataA, 'keep-dir'));
    fs.writeFileSync(path.join(dataA, 'keep-dir', 'x.txt'), 'mine');
    r = await ps(['-PinsFile', pinsFile, '-DataDir', dataA, '-Remove'], { input: 'no\n', env: { APPDATA: appdata } });
    check('22 -Remove asks first: any other answer than YES deletes nothing', r.code === 0 && fs.existsSync(modelFile(dataA)) && /Nothing was deleted/.test(r.out), r.out.slice(-400));
    r = await ps(['-PinsFile', pinsFile, '-DataDir', dataA, '-Remove'], { input: 'YES\n', env: { APPDATA: appdata } });
    check('23 -Remove deletes what the helper made and nothing else (the folder may be one the user chose)', r.code === 0 && !fs.existsSync(path.join(dataA, 'models')) && !fs.existsSync(path.join(dataA, 'runtime')) && !fs.existsSync(path.join(dataA, 'key.txt')) && fs.readFileSync(keepFile, 'utf8') === 'mine' && fs.existsSync(path.join(dataA, 'keep-dir', 'x.txt')), r.out.slice(-400));
    r = await ps(['-PinsFile', pinsFile, '-DataDir', path.join(tmpRoot, 'nothing here'), '-Stop'], { env: { APPDATA: appdata } });
    check('24 -Stop with nothing running says so and succeeds', r.code === 0 && /not running/.test(r.out), r.out.slice(-300));
    // the launcher: also when a PowerShell 7 terminal hands over its module folders (they would break Windows PowerShell 5.1)
    const noSpace = path.join(tmpRoot, 'nothing here');
    const cmdLine = '"' + path.join(SRC, 'Start-Local-AI.cmd') + '" -DataDir "' + noSpace + '" -Stop';
    const viaCmd = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + cmdLine + '"'], { encoding: 'utf8', windowsVerbatimArguments: true, env: Object.assign({}, process.env, { VE_LOCALAI_LANG: 'en' }) });
    check('24b the launcher Start-Local-AI.cmd runs the script (a path with spaces, a polluted PSModulePath), passes its arguments through, and returns its exit code', viaCmd.status === 0 && /not running/.test(String(viaCmd.stdout)), { status: viaCmd.status, out: String(viaCmd.stdout).slice(-300), err: String(viaCmd.stderr).slice(-300) });

    // a zip the user saved by hand (github.com blocked) is used without any request
    const dataH = path.join(tmpRoot, 'data h');
    reset();
    delete srv.routes['/vk.zip'];
    delete srv.routes['/cpu.zip'];
    fs.mkdirSync(path.join(dataH, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(dataH, 'downloads', 'llama-btest-vk.zip'), vkZip);
    fs.writeFileSync(path.join(dataH, 'downloads', 'llama-btest-cpu.zip'), cpuZip);
    r = await run(dataH);
    check('24c an engine zip saved by hand into the downloads folder is checked and used: nothing is requested, the zips are cleaned up afterwards', r.code === 0 && !srv.log.some((e) => /\.zip$/.test(e.url)) && fs.existsSync(path.join(dataH, 'runtime', 'btest', 'vk', 'llama-server.exe')) && !fs.existsSync(path.join(dataH, 'downloads', 'llama-btest-vk.zip')), r.out.slice(-600));

    // the server is gone
    await srv.close();
    const dataG = path.join(tmpRoot, 'data g');
    r = await run(dataG);
    check('25 offline / blocked host: exit code 2, the host is named, the manual download is explained', r.code === 2 && /could not be reached/.test(r.out) && /download the file/.test(r.out), { code: r.code, out: r.out.slice(-700) });
    return pinsFile;
  } finally {
    try { await srv.close(); } catch (e) { /* closed already */ }
  }
}

/* ------------------------------------------------------------------ the real thing */

const { request, waitHealth } = real;

const listeners = (port) => {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  return String(r.stdout || '').split(/\r?\n/).filter((l) => /LISTENING/.test(l) && new RegExp(':' + port + '\\s').test(l)).map((l) => l.trim().split(/\s+/));
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

async function realChecks() {
  if (!real.available()) { console.log('SKIP real model tests (the desktop app\'s model and engine are not on this machine)'); return; }

  // a folder with spaces and Turkish letters, like the profile folder of a user named "Çağrı"; the model files are hard links (no copy of 3.4 GB)
  const dataDir = real.seed(path.join(tmpRoot, 'Yerel AI çğıöşü İ', 'veri'));
  const PORT = 18473;
  const keyFile = path.join(dataDir, 'key.txt');
  const pidFile = path.join(dataDir, 'llama-server.pid.json');
  const site = 'http://127.0.0.1:1/videoeditor/';
  let current = null;
  const start = (extra) => {
    current = real.start(dataDir, ['-Port', String(PORT), '-Site', site].concat(extra || []));
    current.child.done = current.done;
    return current.child;
  };
  const out = () => (current ? current.output() : '');

  let child = start();
  const up = await waitHealth(PORT, 180000);
  check('26 REAL: the helper starts the real model (Turkish letters and spaces in the folder) and it becomes healthy', up, out().slice(-1500));
  if (!up) { try { child.kill(); } catch (e) { /* gone */ } return; }
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, ''));
  check('27 REAL: the key is 32 characters of base64url, created on this computer; the pid file names the engine inside the helper\'s folder', /^[A-Za-z0-9_-]{32}$/.test(key) && rec.port === PORT && rec.exe.startsWith(path.join(dataDir, 'runtime')) && alive(rec.pid), { key: key.length, rec });
  const ls = listeners(PORT);
  check('28 REAL: the model listens on 127.0.0.1 only (not on the network, not on [::]), owned by the engine process', ls.length === 1 && ls[0][1] === '127.0.0.1:' + PORT && Number(ls[0][ls[0].length - 1]) === rec.pid, ls);
  const noKey = await request(PORT, 'GET', '/v1/models');
  const withKey = await request(PORT, 'GET', '/v1/models', { headers: { Authorization: 'Bearer ' + key } });
  const wrongKey = await request(PORT, 'GET', '/v1/models', { headers: { Authorization: 'Bearer ' + key.split('').reverse().join('') } });
  check('29 REAL: every API request needs the key (none: 401, wrong: 401, right: 200); /health needs none', noKey.status === 401 && wrongKey.status === 401 && withKey.status === 200, [noKey.status, wrongKey.status, withKey.status]);
  const props = await request(PORT, 'GET', '/props', { headers: { Authorization: 'Bearer ' + key } });
  let vision = null;
  try { vision = JSON.parse(props.body).modalities; } catch (e) { /* not json */ }
  check('30 REAL: the engine advertises image input (the picture model is loaded)', !!vision && vision.vision === true, props.body.slice(0, 200));
  const cors = await request(PORT, 'OPTIONS', '/v1/chat/completions', { headers: { Origin: 'https://ahmetcanalaca.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  check('31 REAL: a page on github.io may call it (CORS preflight allowed)', cors.status === 200 || cors.status === 204, [cors.status, cors.headers['access-control-allow-origin']]);
  const cmdLine = psCommand("(Get-CimInstance Win32_Process -Filter 'ProcessId=" + rec.pid + "').CommandLine");
  check('32 REAL: the key is not on the command line of the engine (only in its environment), and it listens on 127.0.0.1', !cmdLine.out.includes(key) && /--host 127\.0\.0\.1/.test(cmdLine.out) && /--no-webui/.test(cmdLine.out), cmdLine.out.slice(0, 400).replace(key, '***'));
  const chat = await request(PORT, 'POST', '/v1/chat/completions', { headers: { Authorization: 'Bearer ' + key }, timeout: 120000, body: { model: 'qwen3.5-4b', max_tokens: 40, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] } });
  let answer = null;
  try { answer = JSON.parse(chat.body).choices[0].message; } catch (e) { /* not json */ }
  check('33 REAL: a chat request is answered, and the model does not "think" first (the template setting reached the engine)', !!answer && /pong/i.test(answer.content || '') && !answer.reasoning_content && !/<think>/.test(answer.content || ''), chat.body.slice(0, 400));

  // a second window while it runs
  const second = await ps(['-DataDir', dataDir, '-Port', String(PORT), '-NoBrowser', '-Site', 'http://127.0.0.1:1/videoeditor/']);
  check('34 REAL: starting the helper again while it runs reuses the running model (no second engine, same port)', second.code === 0 && /already running/.test(second.out) && listeners(PORT).length === 1 && alive(rec.pid), second.out.slice(-300));

  // -Stop ends the first window cleanly
  const stop = await ps(['-DataDir', dataDir, '-Stop']);
  const code = await Promise.race([child.done, sleep(30000).then(() => 'timeout')]);
  await sleep(500);
  check('35 REAL: -Stop makes the window that runs the model end cleanly (exit 0), the engine is gone, the port is free, the pid file and the key file are removed', stop.code === 0 && code === 0 && !alive(rec.pid) && listeners(PORT).length === 0 && !fs.existsSync(pidFile) && !fs.existsSync(keyFile) && /Stopped/.test(out()), { stop: stop.out.slice(-200), code, out: out().slice(-400) });

  // a window that is killed: the engine is left behind; the next start takes it over
  child = start();
  const up2 = await waitHealth(PORT, 180000);
  const rec2 = up2 ? JSON.parse(fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '')) : null;
  const key2 = up2 ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  const oldKey = await request(PORT, 'GET', '/v1/models', { headers: { Authorization: 'Bearer ' + key } });
  child.kill();
  await Promise.race([child.done, sleep(10000)]);
  await sleep(800);
  check('36 REAL: every start makes a NEW key (the key of the earlier run is refused); killing the window leaves the engine running', up2 && /^[A-Za-z0-9_-]{32}$/.test(key2) && key2 !== key && oldKey.status === 401 && alive(rec2.pid), { key2: key2.length, same: key2 === key, old: oldKey.status, rec2 });
  const reuse = await ps(['-DataDir', dataDir, '-Port', String(PORT), '-NoBrowser', '-Site', 'http://127.0.0.1:1/videoeditor/']);
  check('37 REAL: the next start finds that engine and reuses it (with its key, which stays)', reuse.code === 0 && /already running/.test(reuse.out) && (await request(PORT, 'GET', '/health')).status === 200 && fs.readFileSync(keyFile, 'utf8').trim() === key2, reuse.out.slice(-300));
  const t0 = Date.now();
  const kill = await ps(['-DataDir', dataDir, '-Stop']);
  await sleep(500);
  check('38 REAL: -Stop also stops an engine whose window is gone (and removes its key)', kill.code === 0 && rec2 && !alive(rec2.pid) && listeners(PORT).length === 0 && !fs.existsSync(pidFile) && !fs.existsSync(keyFile), { ms: Date.now() - t0, out: kill.out.slice(-200) });

  // the processor build, and a new key again
  child = start(['-Backend', 'cpu']);
  const up3 = await waitHealth(PORT, 180000);
  const key3 = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  const old = await request(PORT, 'GET', '/v1/models', { headers: { Authorization: 'Bearer ' + key2 } });
  const fresh = await request(PORT, 'GET', '/v1/models', { headers: { Authorization: 'Bearer ' + key3 } });
  check('39 REAL: -Backend cpu: the processor build runs, with a new key (the earlier one is refused)', up3 && key3 !== key2 && old.status === 401 && fresh.status === 200 && /runtime[\\/]+[^\\/]+[\\/]+cpu/.test(JSON.parse(fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '')).exe), { out: out().slice(-500) });
  await ps(['-DataDir', dataDir, '-Stop']);
  await Promise.race([child.done, sleep(20000)]);
}

(async () => {
  const only = process.env.VE_ONLY || ''; // static | download | real (default: all)
  try {
    if (!only || only === 'static') staticChecks();
    if (!only || only === 'download') await downloadChecks();
    if (!only || only === 'real') await realChecks();
  } catch (e) {
    check('00 the test ran to the end', false, String(e && e.stack || e));
  } finally {
    check.summary();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* in use: the temp folder cleaner will do */ }
  }
})();
