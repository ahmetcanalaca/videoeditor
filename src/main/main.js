'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session, Menu, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { fileURLToPath } = require('url');

const { SettingsStore } = require('./settings');
const { resolveBinaries } = require('./ffmpeg-paths');
const { probe, versionOf, execFileP } = require('./probe');
const mediaTools = require('./media-tools');
const exporter = require('./exporter');
const procs = require('./procs');
const { assertLocalMediaPath } = require('./media-guard');
const { createApprovals, samePath } = require('./approvals');
const { registerAiIpc } = require('./ai/ipc');
const { registerLlmIpc } = require('./llm/ipc');
const { resolveRuntime, EXE: LLAMA_EXE } = require('./llm/runtime');

app.setName('VideoEditor');
app.setAppUserModelId('com.videoeditor.app');

// Programs this app starts by a bare name (tasklist ...) must never be looked up in the current folder: a project file in a folder that also holds
// a planted tasklist.exe would otherwise run it (Windows consults the working directory before PATH unless told not to).
process.env.NoDefaultCurrentDirectoryInExePath = '1';

// Command-line switches that open the app to debugging, switch its protections off, redirect its traffic or load foreign code are refused (the
// automated tests set VE_TEST_MODE=1 and need the remote debugging port). A shortcut or file association that someone changed to add such a switch
// must not be able to turn the app into an open door. Chromium accepts "--name", "-name" and "/name" alike, so all three spellings are checked.
// Harmless switches such as --disable-gpu (see the troubleshooting section) still work.
const UNSAFE_SWITCHES = new Set([
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid', 'debug-port',
  'no-sandbox', 'disable-gpu-sandbox', 'no-zygote', 'single-process', 'in-process-gpu',
  'disable-web-security', 'disable-site-isolation-trials', 'allow-file-access-from-files', 'allow-running-insecure-content',
  'allow-insecure-localhost', 'unsafely-treat-insecure-origin-as-secure', 'ignore-certificate-errors', 'ignore-certificate-errors-spki-list',
  'js-flags', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher', 'browser-subprocess-path', 'load-extension', 'disable-extensions-except',
  'proxy-server', 'proxy-pac-url', 'proxy-bypass-list', 'host-rules', 'host-resolver-rules',
]);
// Only what was TYPED on the command line counts (process.argv), never what Electron itself adds to Chromium's command line at start-up (the
// GrantFileProtocolExtraPrivileges fuse, for example, adds --allow-file-access-from-files: asking Chromium would refuse the app's own start).
// The name is compared case-insensitively, like Chromium does on Windows.
function unsafeSwitchIn(argv) {
  for (const a of argv.slice(1)) {
    const m = /^(?:--|-|\/)([A-Za-z0-9][A-Za-z0-9-]*)(?:=|$)/.exec(String(a));
    if (m && UNSAFE_SWITCHES.has(m[1].toLowerCase())) return m[1].toLowerCase();
  }
  return '';
}
if (process.env.VE_TEST_MODE !== '1') {
  const bad = unsafeSwitchIn(process.argv);
  if (bad) {
    process.stderr.write('Video Editor: the command-line switch --' + bad + ' is not allowed.\n');
    app.exit(2);
  }
}

// No background networking, no component updates, no crash/usage reporting. The only network traffic the app can ever
// produce is (1) the optional AI assistant talking to the endpoint the user configured (see ai/net.js), (2) the one-time download of the
// built-in model, started by a click and limited to the model repository (see llm/ipc.js) and (3) the loopback connection to the private
// llama-server of the built-in model. The default session below stays completely offline.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
// CalculateNativeWinOcclusion: a covered window must keep playing its preview (no "hidden page" throttling).
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('no-pings');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vemedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const THEME_CHROME = {
  dark: { bg: '#0d0f13', bar: '#12151b', symbol: '#e8ebf2' },
  light: { bg: '#eceef3', bar: '#f7f8fb', symbol: '#1d2330' },
};
const TITLEBAR_HEIGHT = 40;

const STR = {
  tr: {
    openVideos: 'Video ekle', videoFiles: 'Video dosyaları', allFiles: 'Tüm dosyalar',
    exportTitle: 'Dışa aktar', mp4: 'MP4 video',
    saveProject: 'Projeyi kaydet', openProject: 'Projeyi aç', projectFiles: 'Video Editör projesi',
    cut: 'Kes', copy: 'Kopyala', paste: 'Yapıştır', selectAll: 'Tümünü seç',
    chooseModelDir: 'Model klasörünü seç',
    entraTitle: 'Microsoft Entra ID oturumu',
    entraMessage: 'Azure CLI oturumunuzdan alınan geçici erişim belirteci şu adrese gönderilecek:',
    entraDetail: 'Bu belirteç, adı geçen adreste sizin adınıza işlem yapılmasını sağlar. Adres size ya da kuruluşunuza ait bir Azure OpenAI / Foundry kaynağı değilse İptal’i seçin.',
    entraAllow: 'Bu adrese izin ver', entraCancel: 'İptal',
    endpointTitle: 'Yapay zeka hizmeti adresi',
    endpointMessage: 'Yapay zeka asistanına yazdıklarınız, zaman çizelgenizin özeti ve API anahtarınız şu adrese gönderilecek:',
    endpointDetail: 'Adres, kullandığınız sağlayıcının ya da kuruluşunuzun kendi adresi değilse İptal’i seçin.',
    cuEndpointTitle: 'Video analizi adresi',
    cuEndpointMessage: 'Video analizi için videolarınızın küçültülmüş kopyaları (en fazla 480p, tek kanallı ses) şu Azure Content Understanding adresine yüklenebilecek:',
    cuEndpointDetail: 'Her yükleme ayrıca sizin onayınızla yapılır. Adres size ya da kuruluşunuza ait bir Foundry kaynağı değilse İptal’i seçin.',
    cuUploadTitle: 'Videoyu analiz için yükle',
    cuUploadMessage: 'Şu videoların küçültülmüş kopyası (en fazla 480p, tek kanallı ses; yaklaşık {mb} MB) yüklenip Azure Content Understanding ile analiz edilecek:',
    cuUploadDetail: 'Kopya yalnızca bu analiz için gönderilir ve Azure aboneliğinizde ücretlendirilir (1 saatlik video için birkaç dolar; kullandığınız modele göre değişir). Sonuç (sahne açıklamaları ve konuşma metni) bu bilgisayarda saklanır ve komutu uygulayabilmesi için sohbet modelinize metin olarak da gönderilir; aynı video için yeniden yüklenmez; hizmetteki kopyanın silinmesi hemen istenir. Verinin işlenebileceği yer: {loc}.',
    cuUploadAllow: 'Yükle ve analiz et', cuUploadCancel: 'İptal',
    locateTitle: 'Resimler modele gönderilsin mi?',
    locateMessage: 'Nesnenin yerini bulmak için videonuzdan en fazla {n} küçük resim (toplam en fazla {mb} MB) sohbet için seçtiğiniz modele gönderilecek:',
    locateDetail: 'Aranan: {object}\nModel: {model}\nBakılacak bölümler: {ranges} aralık, toplam {seconds} sn\n\nResimler en fazla {side} piksele küçültülür ve yalnızca bu konumu bulmak için gönderilir; bu uygulama onları saklamaz (modelin hizmetinde o hizmetin kendi veri politikası geçerlidir). İzin vermezseniz yakınlaştırma görüntünün ortasına yapılır. Bu soru her seferinde yeniden sorulur.',
    locateAllow: 'Resimleri gönder', locateCancel: 'Vazgeç',
    cuLoc: { geography: 'kaynağınızla aynı coğrafya', dataZone: 'kaynağınızla aynı veri bölgesi', global: 'dünya genelinde herhangi bir Azure veri merkezi' },
  },
  en: {
    openVideos: 'Add videos', videoFiles: 'Video files', allFiles: 'All files',
    exportTitle: 'Export', mp4: 'MP4 video',
    saveProject: 'Save project', openProject: 'Open project', projectFiles: 'Video Editor project',
    cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all',
    chooseModelDir: 'Choose the model folder',
    entraTitle: 'Microsoft Entra ID sign-in',
    entraMessage: 'A short-lived access token from your Azure CLI sign-in will be sent to this address:',
    entraDetail: 'The token lets this address act on your behalf. If it is not an Azure OpenAI / Foundry resource of yours or your organisation, choose Cancel.',
    entraAllow: 'Allow this address', entraCancel: 'Cancel',
    endpointTitle: 'AI service address',
    endpointMessage: 'What you type in the AI assistant, a summary of your timeline and your API key will be sent to this address:',
    endpointDetail: 'If it is not the address of the provider you use or of your organisation, choose Cancel.',
    cuEndpointTitle: 'Video analysis address',
    cuEndpointMessage: 'For the video analysis, reduced copies of your videos (at most 480p, mono audio) may be uploaded to this Azure Content Understanding address:',
    cuEndpointDetail: 'Every upload is confirmed by you separately. If this is not a Foundry resource of yours or your organisation, choose Cancel.',
    cuUploadTitle: 'Upload video for analysis',
    cuUploadMessage: 'A reduced copy of these videos (at most 480p, mono audio; about {mb} MB) will be uploaded and analysed with Azure Content Understanding:',
    cuUploadDetail: 'The copy is sent for this analysis only and is billed to your Azure subscription (a few dollars per hour of video; it depends on the model you use). The result (scene descriptions and speech text) is kept on this computer and is also sent as text to your chat model so that it can carry out the command; the same video is not uploaded again; the service is asked to delete its copy right away. Where the data may be processed: {loc}.',
    cuUploadAllow: 'Upload and analyse', cuUploadCancel: 'Cancel',
    locateTitle: 'Send pictures to the model?',
    locateMessage: 'To find where the object is, up to {n} small pictures (at most {mb} MB in total) from your video will be sent to the model you chose for the chat:',
    locateDetail: 'Looking for: {object}\nModel: {model}\nParts to look at: {ranges} range(s), {seconds} s in total\n\nThe pictures are reduced to at most {side} pixels and sent only to find this position; this app does not keep them (the data policy of the model service applies there). If you decline, the zoom aims at the center of the picture. You are asked every time.',
    locateAllow: 'Send the pictures', locateCancel: 'Cancel',
    cuLoc: { geography: 'the same geography as your resource', dataZone: 'the same data zone as your resource', global: 'any Azure data centre worldwide' },
  },
};

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'vob', 'mxf'];

let mainWindow = null;
let settings = null;
let bins = { ffmpeg: null, ffprobe: null };
let cacheDir = '';
let forceClose = false;
let closeAcked = false;
let closeTimer = null;
let pendingOpenFiles = [];
let rendererReady = false;
let lastExportPath = '';
let aiIpc = null;
let llmIpc = null;

// ---- what the USER chose, as opposed to what a script in the page asks for ----
// The page is the least trusted part of the app: whatever it passes to main as a path is only honoured when it is one of these.
//   currentProject  the project file that was opened or saved here (a silent "Save" may only write there)
//   exportTarget    the file the user picked in the export dialog (the only place an export may be written)
//   approvals       paths from the command line / "open with" and files the user really dropped on the window (isTrusted drop in the preload):
//                   these may be network (UNC) paths; any other path coming from the page may not (see approvals.js)
let currentProject = '';
let exportTarget = '';
const approvals = createApprovals();
const approvePaths = (list) => approvals.approve(list);
const isApproved = (p) => approvals.has(p);
// Settings the page may change itself (everything else - AI endpoint, model folder, last folders, window - is set by main or through its own checked calls).
const PAGE_SETTINGS = ['theme', 'language', 'export', 'previewVolume', 'previewMuted'];
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const MAX_EXPORT_JOBS = 2;
// The export options stored in / read from a project file: only the four known options, as short strings (the page validates the values again).
function pageExportSettings(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of ['resolution', 'aspect', 'fps', 'quality']) if (typeof o[k] === 'string' || typeof o[k] === 'number') out[k] = String(o[k]).slice(0, 12);
  return out;
}

const registry = new Map(); // id -> entry
const byKey = new Map(); // path|size|mtime -> entry
const exportJobs = new Map();
let idCounter = 0;

/* ---------------------------------------------------------------- helpers */

function lang() {
  return settings && settings.get().language === 'en' ? 'en' : 'tr';
}

function str(key) {
  return STR[lang()][key];
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function trusted(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  // only the top-level page of the app itself, never a sub-frame or any other document
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame && isAppPage(frame.url);
}

const APP_PAGE = path.resolve(__dirname, '..', 'renderer', 'index.html').toLowerCase();
function isAppPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.resolve(fileURLToPath(u)).toLowerCase() === APP_PAGE;
  } catch (e) {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted sender');
    return fn(event, ...args);
  });
}

function cliFiles(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const files = args.filter((a) => a && !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isFile());
  approvePaths(files); // what the user opened with the app (command line, "open with", file association) may be on a network share
  return files;
}

function newId() {
  idCounter += 1;
  return 'm' + idCounter + 'x' + Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------- task queue (heavy background ffmpeg jobs) */

const queue = [];
let running = 0;
const MAX_TASKS = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

function enqueue(priority, fn) {
  queue.push({ priority, fn });
  queue.sort((a, b) => a.priority - b.priority);
  pump();
}

function pump() {
  while (running < MAX_TASKS && queue.length) {
    const task = queue.shift();
    running += 1;
    Promise.resolve().then(task.fn).catch(() => {}).finally(() => {
      running -= 1;
      pump();
    });
  }
}

/* ---------------------------------------------------------------- media registry */

function publicMedia(entry) {
  return Object.assign({}, entry.info, {
    id: entry.id,
    thumbCount: entry.thumbCount,
    thumbsReady: Array.from(entry.thumbsReady),
    waveform: entry.waveform,
    proxyState: entry.proxyState,
  });
}

function previewFileOf(entry) {
  return entry.proxyState === 'ready' && entry.proxyPath ? entry.proxyPath : entry.info.path;
}

function startProxy(entry) {
  if (entry.proxyState === 'building' || entry.proxyState === 'ready') return;
  entry.proxyState = 'building';
  send('media:proxy', { id: entry.id, state: 'building', progress: 0 });
  enqueue(0, async () => {
    if (entry.token.cancelled) return;
    const outFile = path.join(cacheDir, 'proxy', entry.id + '.mp4');
    try {
      const job = mediaTools.createProxy({
        ffmpegPath: bins.ffmpeg, file: entry.info.path, outFile, duration: entry.info.duration, hasAudio: entry.info.hasAudio, token: entry.token,
        onProgress: (p) => send('media:proxy', { id: entry.id, state: 'building', progress: p }),
      });
      await job.promise;
      entry.proxyPath = outFile;
      entry.proxyState = 'ready';
      send('media:proxy', { id: entry.id, state: 'ready', progress: 1 });
    } catch (e) {
      entry.proxyState = 'error';
      send('media:proxy', { id: entry.id, state: 'error', progress: 0, message: String(e && e.message || e).slice(0, 300) });
    }
  });
}

function startBackground(entry) {
  if (entry.info.needsProxy) startProxy(entry);
  enqueue(1, async () => {
    if (entry.token.cancelled) return;
    await mediaTools.generateThumbs({
      ffmpegPath: bins.ffmpeg, file: entry.info.path, duration: entry.info.duration, count: entry.thumbCount,
      outDir: entry.thumbDir, token: entry.token,
      onThumb: (index) => { entry.thumbsReady.add(index); send('media:thumb', { id: entry.id, index }); },
    });
  });
  if (entry.info.hasAudio) {
    enqueue(2, async () => {
      if (entry.token.cancelled) return;
      const peaks = await mediaTools.extractWaveform({ ffmpegPath: bins.ffmpeg, file: entry.info.path, token: entry.token });
      if (peaks && !entry.token.cancelled) {
        entry.waveform = peaks;
        send('media:waveform', { id: entry.id, peaks });
      }
    });
  }
}

// opts.fromProject: the path comes from a .vedproj file, not from the user's own pick: network (UNC) paths are not opened then (see media-guard.js).
// opts.userChosen: the path comes from a native dialog of this process. Otherwise (a path sent by the page) a network path is accepted only if
// the user really handed it to the app (command line, real drop; see approvePaths).
async function importOne(filePath, opts) {
  const o = opts || {};
  let abs;
  try {
    const allowNetwork = !o.fromProject && (!!o.userChosen || isApproved(filePath));
    abs = assertLocalMediaPath(String(filePath), { allowNetwork });
  } catch (e) {
    return { ok: false, path: String(filePath).slice(0, 260), error: 'REMOTE_PATH' };
  }
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch (e) {
    return { ok: false, path: abs, error: 'ENOENT' };
  }
  const key = [abs, stat.size, Math.round(stat.mtimeMs)].join('|');
  let entry = byKey.get(key);
  if (!entry) {
    let info;
    try {
      info = await probe(bins, abs);
    } catch (e) {
      return { ok: false, path: abs, error: e.code || 'PROBE_FAILED', message: String(e.message || '').slice(0, 400) };
    }
    const id = newId();
    entry = {
      id,
      info,
      key,
      token: { cancelled: false },
      thumbCount: mediaTools.thumbCountFor(info.duration),
      thumbDir: path.join(cacheDir, 'thumbs', id),
      thumbsReady: new Set(),
      waveform: null,
      proxyState: 'none',
      proxyPath: '',
    };
    registry.set(id, entry);
    byKey.set(key, entry);
    startBackground(entry);
  }
  return { ok: true, media: publicMedia(entry) };
}

async function importMany(paths, opts) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).slice(0, 200);
  const results = [];
  for (const p of list) results.push(await importOne(p, opts));
  return freshen(results);
}

// Thumbnails/waveforms of earlier files may have progressed while later files were still being probed:
// re-snapshot every entry at reply time so the renderer never misses an update that was sent before it knew the media.
function freshen(results) {
  return results.map((r) => {
    if (!r.ok) return r;
    const entry = registry.get(r.media.id);
    return entry ? { ok: true, media: publicMedia(entry) } : r;
  });
}

function resetMedia() {
  for (const entry of registry.values()) entry.token.cancelled = true;
  registry.clear();
  byKey.clear();
}

/* ---------------------------------------------------------------- vemedia:// protocol (range-capable file server for <video> and thumbnails) */

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.jpg': 'image/jpeg',
};

async function serveFile(request, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
  const size = stat.size;
  const headers = {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      }
      if (!(start <= end) || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers['Content-Length'] = String(end - start + 1);
  if (size === 0) return new Response(null, { status: 200, headers });
  const stream = fs.createReadStream(filePath, { start, end });
  return new Response(Readable.toWeb(stream), { status, headers });
}

function registerMediaProtocol() {
  protocol.handle('vemedia', async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.hostname === 'media') {
        const entry = registry.get(parts[0]);
        if (!entry) return new Response('Not found', { status: 404 });
        return await serveFile(request, previewFileOf(entry));
      }
      if (url.hostname === 'thumb') {
        const entry = registry.get(parts[0]);
        const idx = Number.parseInt(parts[1], 10);
        if (!entry || !Number.isInteger(idx) || idx < 0 || idx >= entry.thumbCount) return new Response('Not found', { status: 404 });
        return await serveFile(request, path.join(entry.thumbDir, idx + '.jpg'));
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response('Error', { status: 500 });
    }
  });
}

/* ---------------------------------------------------------------- window */

function applyChrome(theme) {
  const c = THEME_CHROME[theme] || THEME_CHROME.dark;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(c.bg);
  try { mainWindow.setTitleBarOverlay({ color: c.bar, symbolColor: c.symbol, height: TITLEBAR_HEIGHT }); } catch (e) { /* not supported on this platform */ }
}

function createWindow() {
  const s = settings.get();
  const chrome = THEME_CHROME[s.theme] || THEME_CHROME.dark;
  // Never open larger than the usable screen area (small work laptops).
  const work = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(s.window.width, work.width),
    height: Math.min(s.window.height, work.height),
    minWidth: Math.min(980, work.width),
    minHeight: Math.min(640, work.height),
    show: false,
    backgroundColor: chrome.bg,
    title: 'Video Editör',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.bar, symbolColor: chrome.symbol, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: !app.isPackaged || (process.argv.includes('--devtools') && process.env.VE_TEST_MODE === '1'),
    },
  });
  if (s.window.maximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (forceClose) return;
    // Renderer not loaded yet or crashed: nothing to ask, just close.
    if (!rendererReady) { forceClose = true; return; }
    e.preventDefault();
    closeAcked = false;
    send('app:close-requested', {});
    // Only a renderer that does not even acknowledge the request (hung) is overridden; a user deciding in a dialog is not.
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!closeAcked && mainWindow && !mainWindow.isDestroyed()) { forceClose = true; mainWindow.close(); }
    }, 2500);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', () => { rendererReady = false; });
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });
  // The renderer suppresses the context menu everywhere except in text fields, where cut/copy/paste is needed (pasting an API key).
  mainWindow.webContents.on('context-menu', (e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const items = params.isEditable
      ? [{ role: 'cut', label: str('cut') }, { role: 'copy', label: str('copy') }, { role: 'paste', label: str('paste') }, { type: 'separator' }, { role: 'selectAll', label: str('selectAll') }]
      : [{ role: 'copy', label: str('copy') }];
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const b = mainWindow.getNormalBounds();
  settings.update({ window: { width: b.width, height: b.height, maximized } });
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.on('settings:get-sync', (event) => {
    event.returnValue = trusted(event) ? settings.get() : null;
  });

  // Only these few settings can be changed by the page itself: the AI endpoint (which decides where credentials go), the model folder, the
  // last-used folders and the window state are written by main or through their own checked calls (ai:save, llm:set, dialogs).
  handle('settings:set', (e, patch) => {
    const clean = {};
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) for (const k of PAGE_SETTINGS) if (Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
    return settings.update(clean);
  });

  // Files the user really dropped on the window: the preload reports them from a trusted (isTrusted) drop event, never the page script.
  ipcMain.on('media:dropped', (event, list) => {
    if (trusted(event)) approvePaths(list);
  });

  handle('app:ready', () => {
    rendererReady = true;
    const files = pendingOpenFiles;
    pendingOpenFiles = [];
    return files;
  });

  handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    ffmpeg: bins.ffmpeg ? await versionOf(bins.ffmpeg) : '',
    ffprobe: bins.ffprobe ? await versionOf(bins.ffprobe) : '',
    packaged: app.isPackaged,
    approvals: process.env.VE_TEST_MODE === '1' ? approvals.size() : undefined, // test hook: how many paths the user handed over (see approvals.js)
  }));

  handle('media:pick', async () => {
    const s = settings.get();
    // Automated UI tests (VE_TEST_MODE=1 only) cannot drive native dialogs.
    if (process.env.VE_TEST_MODE === '1' && process.env.VE_TEST_OPEN_PATHS) {
      const paths = process.env.VE_TEST_OPEN_PATHS.split('|').filter(Boolean);
      return { canceled: false, results: await importMany(paths, { userChosen: true }) };
    }
    const res = await dialog.showOpenDialog(mainWindow, {
      title: str('openVideos'),
      defaultPath: s.lastDirs.open || app.getPath('videos'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: str('videoFiles'), extensions: VIDEO_EXT }, { name: str('allFiles'), extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, results: [] };
    settings.update({ lastDirs: { open: path.dirname(res.filePaths[0]) } });
    return { canceled: false, results: await importMany(res.filePaths, { userChosen: true }) };
  });

  handle('media:import', (e, paths) => importMany(paths)); // paths sent by the page: network paths only if the user handed them to the app (approvePaths)
  handle('media:request-proxy', (e, id) => {
    const entry = registry.get(String(id));
    if (entry) {
      if (entry.proxyState === 'error') entry.proxyState = 'none';
      startProxy(entry);
    }
    return !!entry;
  });
  handle('media:reset', () => { resetMedia(); currentProject = ''; return true; });

  handle('export:pick-path', async (e, defaultName) => {
    const s = settings.get();
    if (process.env.VE_TEST_MODE === '1' && process.env.VE_TEST_EXPORT_PATH) { exportTarget = process.env.VE_TEST_EXPORT_PATH; return exportTarget; }
    const dir = s.lastDirs.export || app.getPath('videos');
    const safe = String(defaultName || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: str('exportTitle'),
      defaultPath: path.join(dir, safe),
      filters: [{ name: str('mp4'), extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return null;
    let p = res.filePath;
    if (!/\.mp4$/i.test(p)) p += '.mp4';
    settings.update({ lastDirs: { export: path.dirname(p) } });
    exportTarget = p;
    return p;
  });

  handle('export:start', async (e, req) => {
    if (!req || !Array.isArray(req.segments) || !req.segments.length || req.segments.length > 2000) return { ok: false, error: { code: 'EMPTY', message: 'Nothing to export' } };
    const requested = typeof req.outPath === 'string' ? path.resolve(req.outPath) : '';
    if (!requested || !path.isAbsolute(requested) || !/\.mp4$/i.test(requested)) return { ok: false, error: { code: 'OUT_DIR', message: 'Invalid output path' } };
    // the output goes only where the user picked it in the export dialog (a script in the page cannot name a network share or another file) ...
    if (!samePath(requested, exportTarget)) return { ok: false, error: { code: 'OUT_DIR', message: 'The output file was not chosen in the export dialog' } };
    // ... and it is written to exactly that path, not to the page's spelling of it (upper/lower case rules differ between JavaScript and NTFS)
    const outPath = path.resolve(exportTarget);
    if (exportJobs.size >= MAX_EXPORT_JOBS) return { ok: false, error: { code: 'BUSY', message: 'Too many exports at the same time' } };
    if (!bins.ffmpeg) return { ok: false, error: { code: 'SPAWN_FAILED', message: 'ffmpeg not found' } };
    const mediaMap = {};
    for (const seg of req.segments) {
      const entry = registry.get(String(seg && seg.mediaId));
      if (!entry) return { ok: false, error: { code: 'MEDIA_MISSING', message: 'Unknown media' } };
      mediaMap[entry.id] = Object.assign({}, entry.info, { id: entry.id });
    }
    const jobId = 'job' + Date.now().toString(36);
    let job;
    try {
      job = exporter.runExport({
        ffmpegPath: bins.ffmpeg, segments: req.segments, media: mediaMap, settings: req.settings || {}, outPath, tempRoot: cacheDir,
        onProgress: (p) => send('export:progress', Object.assign({ jobId }, p)),
      });
    } catch (err) {
      return { ok: false, error: { code: err.code || 'UNKNOWN', message: err.message } };
    }
    exportJobs.set(jobId, job);
    job.promise.then((res) => {
      lastExportPath = outPath;
      send('export:done', { jobId, ok: true, result: res });
    }).catch((err) => {
      send('export:done', { jobId, ok: false, error: { code: err.code || 'UNKNOWN', kind: err.kind || '', message: String(err.message || '').slice(0, 500), details: String(err.details || '').slice(-1500) } });
    }).finally(() => exportJobs.delete(jobId));
    return { ok: true, jobId, totalDuration: job.plan.totalDuration, width: job.plan.canvas.width, height: job.plan.canvas.height, fps: job.plan.fps.value };
  });

  handle('export:cancel', (e, jobId) => {
    const job = exportJobs.get(String(jobId));
    if (job) job.cancel();
    return !!job;
  });

  handle('shell:reveal', () => {
    if (lastExportPath && fs.existsSync(lastExportPath)) { shell.showItemInFolder(lastExportPath); return true; }
    return false;
  });
  handle('shell:open-output', async () => {
    if (lastExportPath && fs.existsSync(lastExportPath)) { await shell.openPath(lastExportPath); return true; }
    return false;
  });

  handle('project:save', async (e, request) => {
    const req = request && typeof request === 'object' ? request : {};
    const s = settings.get();
    // The page never decides where a project is written: a silent save goes to the project file main already knows (opened or saved here),
    // anything else through the save dialog. (Otherwise a script in the page could write any file, e.g. a .cmd into the Startup folder.)
    let target = currentProject && samePath(req.path, currentProject) ? currentProject : '';
    if (!target && process.env.VE_TEST_MODE === '1' && process.env.VE_TEST_PROJECT_PATH) target = process.env.VE_TEST_PROJECT_PATH;
    if (!target || req.saveAs) {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: str('saveProject'),
        defaultPath: target || path.join(s.lastDirs.project || app.getPath('documents'), String(req.defaultName || 'proje').replace(/[\\/:*?"<>|]/g, '_') + '.vedproj'),
        filters: [{ name: str('projectFiles'), extensions: ['vedproj'] }],
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      target = /\.vedproj$/i.test(res.filePath) ? res.filePath : res.filePath + '.vedproj';
    }
    if (!/\.vedproj$/i.test(target)) return { canceled: false, error: 'WRITE_FAILED' };
    const media = [];
    for (const id of (Array.isArray(req.mediaIds) ? req.mediaIds : []).slice(0, 500)) {
      const entry = registry.get(String(id));
      if (entry) media.push({ id: entry.id, path: entry.info.path, name: entry.info.name });
    }
    const doc = {
      app: 'VideoEditor', version: 1, savedAt: new Date().toISOString(),
      settings: pageExportSettings(req.settings), media, segments: Array.isArray(req.segments) ? req.segments.slice(0, 5000) : [],
    };
    // written next to the target and moved into place: a failed or interrupted write never leaves a half-written project
    const tmp = target + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
      return { canceled: false, error: err.code || 'WRITE_FAILED' };
    }
    currentProject = target;
    settings.update({ lastDirs: { project: path.dirname(target) } });
    return { canceled: false, path: target };
  });

  handle('project:open', async (e, requestedPath) => {
    let target = typeof requestedPath === 'string' ? requestedPath : '';
    if (target) {
      // A path sent by the page is opened only when the user handed that very file to the app (command line, "open with", a real drop in the window).
      // Otherwise a script could make any file that merely looks like a project the one that a silent "Save" overwrites. A network path is possible
      // only this way as well; never a URL or a device path.
      if (!isApproved(target)) return { canceled: false, error: 'INVALID_PROJECT' };
      try { assertLocalMediaPath(target, { allowNetwork: true }); } catch (err) { return { canceled: false, error: 'INVALID_PROJECT' }; }
    } else {
      const s = settings.get();
      const res = await dialog.showOpenDialog(mainWindow, {
        title: str('openProject'),
        defaultPath: s.lastDirs.project || app.getPath('documents'),
        properties: ['openFile'],
        filters: [{ name: str('projectFiles'), extensions: ['vedproj'] }],
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true };
      target = res.filePaths[0];
    }
    let doc;
    try {
      if (fs.statSync(target).size > MAX_PROJECT_BYTES) return { canceled: false, error: 'INVALID_PROJECT' };
      doc = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      return { canceled: false, error: 'INVALID_PROJECT' };
    }
    if (!doc || doc.app !== 'VideoEditor' || !Array.isArray(doc.segments) || !Array.isArray(doc.media)) return { canceled: false, error: 'INVALID_PROJECT' };
    currentProject = /\.vedproj$/i.test(target) ? path.resolve(target) : '';
    settings.update({ lastDirs: { project: path.dirname(target) } });
    resetMedia();
    const mediaMap = {};
    const missing = [];
    const blocked = [];
    for (const m of doc.media.slice(0, 500)) {
      if (!m || typeof m.id !== 'string' || typeof m.path !== 'string') continue;
      const r = await importOne(m.path, { fromProject: true });
      if (r.ok) mediaMap[m.id] = r.media;
      else if (r.error === 'REMOTE_PATH') blocked.push({ id: m.id, path: m.path.slice(0, 300), name: String(m.name || '').slice(0, 200) });
      else missing.push({ id: m.id, path: m.path, name: m.name || path.basename(m.path) });
    }
    for (const oldId of Object.keys(mediaMap)) {
      const entry = registry.get(mediaMap[oldId].id);
      if (entry) mediaMap[oldId] = publicMedia(entry);
    }
    return { canceled: false, path: target, settings: pageExportSettings(doc.settings), segments: doc.segments.slice(0, 5000), media: mediaMap, missing, blocked };
  });

  handle('dialog:message', async (e, opts) => {
    const o = opts || {};
    // Automated UI tests (VE_TEST_MODE=1): record the dialog and answer from a file instead of showing a native box.
    if (process.env.VE_TEST_MODE === '1' && process.env.VE_TEST_MSGBOX_LOG) {
      try { fs.appendFileSync(process.env.VE_TEST_MSGBOX_LOG, JSON.stringify({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons }) + '\n'); } catch (err) { /* ignore */ }
      let choice = Number.isInteger(o.defaultId) ? o.defaultId : 0;
      try { choice = Number(fs.readFileSync(process.env.VE_TEST_MSGBOX_LOG + '.choice', 'utf8').trim()); } catch (err) { /* default */ }
      return choice;
    }
    const res = await dialog.showMessageBox(mainWindow, {
      type: ['info', 'warning', 'error', 'question'].includes(o.type) ? o.type : 'info',
      title: String(o.title || 'Video Editör').slice(0, 100),
      message: String(o.message || '').slice(0, 1000),
      detail: o.detail ? String(o.detail).slice(0, 2000) : undefined,
      buttons: Array.isArray(o.buttons) && o.buttons.length ? o.buttons.slice(0, 4).map((b) => String(b).slice(0, 40)) : ['OK'],
      defaultId: Number.isInteger(o.defaultId) ? o.defaultId : 0,
      cancelId: Number.isInteger(o.cancelId) ? o.cancelId : 0,
      noLink: true,
    });
    return res.response;
  });

  handle('window:set-theme', (e, theme) => { applyChrome(theme === 'light' ? 'light' : 'dark'); return true; });

  handle('app:close-ack', () => {
    closeAcked = true;
    clearTimeout(closeTimer);
    return true;
  });

  handle('app:close-confirmed', () => {
    forceClose = true;
    saveWindowState();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return true;
  });

  // Built-in local model (llm/): download on request, private llama-server. Automated UI tests (VE_TEST_MODE=1) can swap the model repository
  // for a local test server and the llama-server process for an in-process stand-in, so that no 3 GB model is needed.
  function llmTestHooks() {
    if (process.env.VE_TEST_MODE !== '1') return undefined;
    const t = {};
    if (process.env.VE_TEST_LLM_CATALOG) { t.catalog = JSON.parse(fs.readFileSync(process.env.VE_TEST_LLM_CATALOG, 'utf8')); t.extraHosts = ['127.0.0.1']; }
    if (process.env.VE_TEST_LLM_BACKEND) t.inProcess = require(process.env.VE_TEST_LLM_BACKEND);
    if (process.env.VE_TEST_LLM_STALL_MS) t.stallMs = Number(process.env.VE_TEST_LLM_STALL_MS);
    return t;
  }
  async function pickModelDir() {
    if (process.env.VE_TEST_MODE === '1' && process.env.VE_TEST_LLM_PICK_DIR) return process.env.VE_TEST_LLM_PICK_DIR;
    const res = await dialog.showOpenDialog(mainWindow, { title: str('chooseModelDir'), properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get().llm.modelDir || undefined });
    return res.canceled || !res.filePaths.length ? '' : res.filePaths[0];
  }
  llmIpc = registerLlmIpc({
    handle,
    getSettings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
    send,
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    appRoot: path.join(__dirname, '..', '..'),
    procs,
    session,
    pickDirectory: pickModelDir,
    log: (m) => { if (process.env.VE_LLM_LOG) console.log('[llm] ' + m); },
    test: llmTestHooks(),
  });

  // May the assistant's requests go to this address? kind 'key': the prompts and the API key (an address that is not the provider's own);
  // kind 'entra': the token of the user's Azure CLI sign-in; kind 'cu': reduced copies of the user's videos (video analysis). Only this native
  // dialog (never the page) can say yes.
  async function confirmEndpoint(origin, kind) {
    const entra = kind === 'entra';
    const cu = kind === 'cu';
    const title = str(entra ? 'entraTitle' : (cu ? 'cuEndpointTitle' : 'endpointTitle'));
    if (process.env.VE_TEST_MODE === '1') {
      if (process.env.VE_TEST_MSGBOX_LOG) {
        try { fs.appendFileSync(process.env.VE_TEST_MSGBOX_LOG, JSON.stringify({ title, message: origin, buttons: [str('entraAllow'), str('entraCancel')] }) + '\n'); } catch (err) { /* ignore */ }
      }
      return process.env.VE_TEST_ENDPOINT_CONFIRM !== 'deny';
    }
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title, message: str(entra ? 'entraMessage' : (cu ? 'cuEndpointMessage' : 'endpointMessage')) + '\n\n' + origin, detail: str(entra ? 'entraDetail' : (cu ? 'cuEndpointDetail' : 'endpointDetail')),
      buttons: [str('entraAllow'), str('entraCancel')], defaultId: 1, cancelId: 1, noLink: true,
    });
    return res.response === 0;
  }

  // Before every upload for the video analysis: which videos, how much, where to. The page cannot answer this dialog, and nothing is sent without it.
  // plan: { origin, files: [{ name, seconds }], seconds, parts, megabytes, location }
  async function confirmUpload(plan) {
    const fmt = (s) => { const t = Math.round(s); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0'); };
    const shown = plan.files.slice(0, 8).map((f) => '• ' + String(f.name).slice(0, 80) + ' (' + fmt(f.seconds) + ')');
    if (plan.files.length > 8) shown.push('… +' + (plan.files.length - 8));
    const loc = (STR[lang()].cuLoc || {})[plan.location] || String(plan.location || '');
    const message = str('cuUploadMessage').replace('{mb}', String(plan.megabytes)) + '\n\n' + shown.join('\n') + '\n\n' + plan.origin;
    const detail = str('cuUploadDetail').replace('{loc}', loc);
    if (process.env.VE_TEST_MODE === '1') {
      if (process.env.VE_TEST_MSGBOX_LOG) {
        try { fs.appendFileSync(process.env.VE_TEST_MSGBOX_LOG, JSON.stringify({ title: str('cuUploadTitle'), message, detail, buttons: [str('cuUploadAllow'), str('cuUploadCancel')] }) + '\n'); } catch (err) { /* ignore */ }
      }
      return process.env.VE_TEST_UPLOAD_CONFIRM !== 'deny';
    }
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: str('cuUploadTitle'), message, detail, buttons: [str('cuUploadAllow'), str('cuUploadCancel')], defaultId: 1, cancelId: 1, noLink: true,
    });
    return res.response === 0;
  }

  // Before every use of locate_in_video: a few small pictures of the video go to the chat model the user chose. The page cannot answer this dialog, and nothing is cut
  // out of the video or sent without it. plan: { object, ranges, seconds, pictures, megabytes, origin, model, side }
  async function confirmFrames(plan) {
    const fill = (s) => s.replace('{n}', () => String(plan.pictures)).replace('{mb}', () => String(plan.megabytes)).replace('{object}', () => String(plan.object)).replace('{model}', () => String(plan.model))
      .replace('{ranges}', () => String(plan.ranges)).replace('{seconds}', () => String(plan.seconds)).replace('{side}', () => String(plan.side));
    const message = fill(str('locateMessage')) + '\n\n' + plan.origin;
    const detail = fill(str('locateDetail'));
    const buttons = [str('locateAllow'), str('locateCancel')];
    if (process.env.VE_TEST_MODE === '1') {
      // automated tests: the dialog is recorded and answered from a file next to the log ("deny" or "allow", allow by default)
      if (process.env.VE_TEST_MSGBOX_LOG) {
        try { fs.appendFileSync(process.env.VE_TEST_MSGBOX_LOG, JSON.stringify({ title: str('locateTitle'), message, detail, buttons }) + '\n'); } catch (err) { /* ignore */ }
      }
      let answer = process.env.VE_TEST_FRAMES_CONFIRM || 'allow';
      if (process.env.VE_TEST_MSGBOX_LOG) { try { answer = fs.readFileSync(process.env.VE_TEST_MSGBOX_LOG + '.frames', 'utf8').trim() || answer; } catch (err) { /* default */ } }
      return answer !== 'deny';
    }
    const res = await dialog.showMessageBox(mainWindow, { type: 'warning', title: str('locateTitle'), message, detail, buttons, defaultId: 1, cancelId: 1, noLink: true });
    return res.response === 0;
  }

  aiIpc = registerAiIpc({
    handle,
    getSettings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
    getMedia: (id) => { const entry = registry.get(String(id)); return entry ? entry.info : null; },
    send,
    getLang: lang,
    userDataPath: app.getPath('userData'),
    get tempDir() { return cacheDir; },
    safeStorage,
    session,
    llm: llmIpc,
    getBins: () => bins,
    procs,
    confirmEndpoint,
    confirmUpload,
    confirmFrames,
    log: (m) => { if (process.env.VE_LLM_LOG) console.log('[ai] ' + m); },
  });
}

/* ---------------------------------------------------------------- startup / hardening */

async function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // The app never talks to the network. Anything that is not a local resource is cancelled.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (details, cb) => cb({ cancel: true }));
  // WebRTC (STUN / TURN, also over TCP) is not a request: webRequest cannot cancel it and the Content-Security-Policy does not name it, so a script in
  // the page could still send data to a server of its own (found by tests/ui-net-hostile.js). The window has no use for any network: its session
  // gets a proxy that does not exist (loopback included), and without UDP (see the policy in web-contents-created) nothing can leave. The assistant
  // and the model download use their own sessions (partitions), which are not affected.
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' });
}

function setupCache() {
  const root = path.join(app.getPath('temp'), 'VideoEditor-cache');
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  cacheDir = path.join(root, 's' + process.pid + '_' + Date.now().toString(36));
  fs.mkdirSync(cacheDir, { recursive: true });
}

async function runSelfTest(outFile) {
  const result = { ok: false, packaged: app.isPackaged, resourcesPath: process.resourcesPath, ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe };
  try {
    result.ffmpegVersion = bins.ffmpeg ? await versionOf(bins.ffmpeg) : '';
    result.ffprobeVersion = bins.ffprobe ? await versionOf(bins.ffprobe) : '';
    if (bins.ffmpeg) {
      const { stdout } = await execFileP(bins.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 20000 });
      result.libx264 = /libx264/.test(stdout);
      result.aac = /\baac\b/.test(stdout);
      const filters = await execFileP(bins.ffmpeg, ['-hide_banner', '-filters'], { timeout: 20000 });
      result.perspective = /\bperspective\b/.test(filters.stdout);
    }
    // the runtime of the built-in local model: both builds have to be there and start (the model itself is downloaded later by the user)
    const rt = resolveRuntime({ resourcesPath: process.resourcesPath, appRoot: path.join(__dirname, '..', '..') });
    result.llama = {};
    for (const kind of ['cpu', 'vk']) {
      if (!rt[kind]) { result.llama[kind] = null; continue; }
      try {
        const out = await execFileP(path.join(rt[kind], LLAMA_EXE), ['--version'], { timeout: 30000, cwd: rt[kind] });
        const m = /build\s+(\d+)/i.exec(String(out.stdout) + '\n' + String(out.stderr));
        result.llama[kind] = m ? m[1] : 'unknown';
      } catch (e) {
        const m = /build\s+(\d+)/i.exec(String(e && e.stderr) + '\n' + String(e && e.stdout));
        result.llama[kind] = m ? m[1] : 'error';
      }
    }
    result.ok = !!(result.ffmpegVersion && result.ffprobeVersion && result.libx264 && result.aac && result.perspective && /^\d+$/.test(String(result.llama.cpu)) && /^\d+$/.test(String(result.llama.vk)));
  } catch (e) {
    result.error = String(e && e.message || e);
  }
  try { fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  app.exit(result.ok ? 0 : 1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const files = cliFiles(argv);
      if (files.length) send('app:open-files', files);
    }
  });

  app.on('web-contents-created', (e, contents) => {
    contents.on('will-navigate', (ev) => ev.preventDefault());
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); // no UDP for WebRTC (see hardenSession)
  });

  app.whenReady().then(async () => {
    const selfTestArg = process.argv.find((a) => a.startsWith('--selftest-out='));
    bins = resolveBinaries();
    if (selfTestArg) {
      // the diagnostic writes one small .json report, and only to a local absolute path
      const outFile = selfTestArg.slice('--selftest-out='.length);
      let okTarget = false;
      try { okTarget = path.isAbsolute(outFile) && /\.json$/i.test(outFile) && assertLocalMediaPath(outFile) !== ''; } catch (e) { okTarget = false; }
      if (!okTarget) { process.stderr.write('Video Editor: --selftest-out needs an absolute local .json path.\n'); app.exit(2); return; }
      await runSelfTest(outFile);
      return;
    }

    Menu.setApplicationMenu(null);
    settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
    setupCache();
    await hardenSession();
    registerMediaProtocol();
    registerIpc();
    pendingOpenFiles = cliFiles(process.argv);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (aiIpc) aiIpc.abortAll();
    if (llmIpc) { llmIpc.abortAll(); llmIpc.stopServer().catch(() => {}); }
    resetMedia();
    for (const job of exportJobs.values()) job.cancel();
    procs.killAll();
    if (settings) settings.flush();
    try { if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });
}
