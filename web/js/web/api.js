(function () {
  'use strict';
  // window.api of the WEB edition. The renderer (UI, timeline, player, inspector) is the desktop app's; this file is the other side of its
  // `window.api` calls, implemented with browser APIs instead of the Electron main process:
  //   files        File System Access API (open / save pickers) with a file-input fallback; a dropped file gets a token that stands for its "path"
  //   media        probing, thumbnails and waveform with Mediabunny (js/web/engine/media.js); previews are object URLs of the user's files
  //   export       WebCodecs + Mediabunny (js/web/engine/export.js), written straight into the file the user picked
  //   projects     a .vedproj file holds names and sizes (browsers do not give out paths); opening one asks for the videos again
  // Nothing in here sends anything to a server.
  var VEW = window.VE.web;
  var LS_KEY = 've.web.settings.v1';
  var VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.3gp', '.ogv', '.vob', '.mxf'];
  var MAX_PROJECT_BYTES = 50 * 1024 * 1024;

  /* ---------------------------------------------------------------- settings */

  function pick(v, allowed, def) { return allowed.indexOf(String(v)) >= 0 ? String(v) : def; }
  function sanitizeSettings(raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    var e = o.export && typeof o.export === 'object' ? o.export : {};
    var vol = Number(o.previewVolume);
    return {
      theme: o.theme === 'light' ? 'light' : 'dark',
      language: o.language === 'en' ? 'en' : 'tr', // Turkish unless the user chose English
      export: {
        resolution: pick(e.resolution, ['original', '1080', '720', '480'], 'original'),
        aspect: pick(e.aspect, ['auto', '16:9', '9:16', '1:1', '4:3'], 'auto'),
        fps: pick(e.fps, ['auto', '24', '25', '30', '50', '60'], 'auto'),
        quality: pick(e.quality, ['high', 'medium', 'low'], 'high'),
      },
      previewVolume: isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1,
      previewMuted: !!o.previewMuted,
    };
  }
  var settings;
  try { settings = sanitizeSettings(JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { settings = sanitizeSettings({}); }
  function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked: the settings are per session then */ } }
  function setSettings(patch) {
    var p = patch && typeof patch === 'object' ? patch : {};
    var next = Object.assign({}, settings);
    ['theme', 'language', 'export', 'previewVolume', 'previewMuted'].forEach(function (k) { if (Object.prototype.hasOwnProperty.call(p, k)) next[k] = p[k]; });
    settings = sanitizeSettings(next);
    saveSettings();
    return Promise.resolve(settings);
  }

  /* ---------------------------------------------------------------- events */

  var listeners = new Map();
  function on(channel, cb) {
    if (typeof cb !== 'function') return function () {};
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(cb);
    return function () { var l = listeners.get(channel) || []; var i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); };
  }
  function emit(channel, payload) {
    (listeners.get(channel) || []).slice().forEach(function (fn) { try { fn(payload); } catch (e) { console.error('[api:' + channel + ']', e); } });
  }

  /* ---------------------------------------------------------------- message box */

  var dialogLog = [];
  function messageBox(opts) {
    var o = opts || {};
    var labels = Array.isArray(o.buttons) && o.buttons.length ? o.buttons.map(String) : ['OK'];
    var def = Number.isInteger(o.defaultId) ? o.defaultId : 0;
    var cancel = Number.isInteger(o.cancelId) ? o.cancelId : (labels.length > 1 ? labels.length - 1 : 0);
    if (VEW.test) {
      // automated tests: record the dialog and answer from a list (nothing is shown)
      dialogLog.push({ type: o.type || '', title: String(o.title || ''), message: String(o.message || ''), detail: String(o.detail || ''), buttons: labels });
      window.__veDialogs = dialogLog;
      if (Array.isArray(window.__veAnswers)) return Promise.resolve(window.__veAnswers.length ? window.__veAnswers.shift() : cancel);
    }
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.className = 've-msgbox';
      var body = document.createElement('div');
      body.className = 'mb-body';
      [['mb-title', o.title], ['mb-msg', o.message], ['mb-detail', o.detail]].forEach(function (p) {
        if (!p[1]) return;
        var d = document.createElement('div');
        d.className = p[0];
        d.textContent = String(p[1]); // text only: file names and error texts are never markup
        body.appendChild(d);
      });
      var foot = document.createElement('div');
      foot.className = 'mb-foot';
      var done = false;
      function finish(i) { if (done) return; done = true; try { dlg.close(); } catch (e) { /* already closed */ } dlg.remove(); resolve(i); }
      labels.forEach(function (label, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (i === def ? ' primary' : ' outline');
        b.textContent = label;
        b.addEventListener('click', function () { finish(i); });
        foot.appendChild(b);
      });
      dlg.appendChild(body);
      dlg.appendChild(foot);
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(cancel); });
      document.body.appendChild(dlg);
      dlg.showModal();
      if (foot.children[def]) foot.children[def].focus();
    });
  }

  /* ---------------------------------------------------------------- files */

  // A page cannot learn the path of a file. A File that was picked or dropped gets a token that looks like a path (so that the renderer, which
  // only passes such strings around, needs no change): ve-file://f1/holiday.mp4 - the name at the end is what error messages show.
  var fileTokens = new Map();
  var tokenOf = new WeakMap();
  var tokenSeq = 0;
  function tokenFor(file, handle) {
    var tok = tokenOf.get(file);
    if (tok && fileTokens.has(tok)) {
      if (handle && !fileTokens.get(tok).handle) fileTokens.get(tok).handle = handle;
      return tok;
    }
    tok = 've-file://f' + (++tokenSeq) + '/' + file.name;
    fileTokens.set(tok, { file: file, handle: handle || null });
    tokenOf.set(file, tok);
    return tok;
  }
  function pathForFile(file) { return file && typeof file.name === 'string' ? tokenFor(file, null) : ''; }

  function pickViaInput(accept, multiple) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!multiple;
      input.accept = accept;
      input.addEventListener('change', function () { resolve(Array.from(input.files || [])); });
      input.addEventListener('cancel', function () { resolve([]); });
      input.click();
    });
  }
  function isAbort(e) { return !!e && (e.name === 'AbortError' || e.code === 20); }

  // -> [{ file, handle }] ([] when the user cancelled)
  async function pickFiles(kind, multiple) {
    if (VEW.test && window.__veTest && Array.isArray(window.__veTest[kind])) return window.__veTest[kind].map(function (f) { return { file: f, handle: null }; });
    var accept = kind === 'project' ? { 'application/json': ['.vedproj'] } : { 'video/*': VIDEO_EXTS };
    if (VEW.caps.fileSystemAccess) {
      try {
        var handles = await window.showOpenFilePicker({ multiple: !!multiple, id: kind === 'project' ? 've-project' : 've-media', types: [{ description: kind === 'project' ? 'Video Editor project' : 'Video', accept: accept }] });
        return await Promise.all(handles.map(async function (h) { return { file: await h.getFile(), handle: h }; }));
      } catch (e) {
        if (isAbort(e)) return [];
        throw e;
      }
    }
    var list = await pickViaInput(kind === 'project' ? '.vedproj,application/json' : 'video/*,' + VIDEO_EXTS.join(','), multiple);
    return list.map(function (f) { return { file: f, handle: null }; });
  }

  /* ---------------------------------------------------------------- media registry */

  var mediaEngineP = null;
  function mediaEngine() { return mediaEngineP || (mediaEngineP = import('./engine/media.js')); }
  var exportEngineP = null;
  function exportEngine() { return exportEngineP || (exportEngineP = import('./engine/export.js')); }

  var registry = new Map(); // id -> entry
  var byKey = new Map(); // name|size|mtime -> entry
  var idCounter = 0;
  function newId() { idCounter += 1; return 'm' + idCounter + 'x' + Math.random().toString(36).slice(2, 8); }

  function publicMedia(entry) {
    return Object.assign({}, entry.info, {
      id: entry.id,
      thumbCount: entry.thumbCount,
      thumbsReady: Array.from(entry.thumbsReady),
      waveform: entry.waveform,
      proxyState: entry.proxyState,
    });
  }

  VEW.mediaUrl = function (id) { var e = registry.get(id); return e ? e.objectUrl : ''; };
  VEW.thumbUrl = function (id, index) { var e = registry.get(id); return (e && e.thumbUrls.get(index)) || ''; };

  // background work (thumbnails, waveform) runs two at a time
  var queue = [];
  var running = 0;
  function enqueue(fn) { queue.push(fn); pump(); }
  function pump() {
    while (running < 2 && queue.length) {
      var fn = queue.shift();
      running += 1;
      fn().catch(function (e) { console.warn('[media]', e); }).then(function () { running -= 1; pump(); });
    }
  }

  function startBackground(entry) {
    enqueue(async function () {
      if (entry.token.cancelled) return;
      var eng = await mediaEngine();
      await eng.generateThumbs({
        file: entry.file, duration: entry.info.duration, count: entry.thumbCount, token: entry.token,
        onThumb: function (index, blob) {
          if (entry.token.cancelled) return;
          entry.thumbUrls.set(index, URL.createObjectURL(blob));
          entry.thumbsReady.add(index);
          emit('media:thumb', { id: entry.id, index: index });
        },
      });
    });
    if (entry.info.hasAudio) {
      enqueue(async function () {
        if (entry.token.cancelled) return;
        var eng = await mediaEngine();
        var peaks = await eng.extractWaveform({ file: entry.file, duration: entry.info.duration, token: entry.token });
        if (peaks && !entry.token.cancelled) {
          entry.waveform = peaks;
          emit('media:waveform', { id: entry.id, peaks: peaks });
        }
      });
    }
  }

  function dropEntry(entry) {
    entry.token.cancelled = true;
    registry.delete(entry.id);
    byKey.delete(entry.key);
    try { URL.revokeObjectURL(entry.objectUrl); } catch (e) { /* ignore */ }
    entry.thumbUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    entry.thumbUrls.clear();
  }
  function resetMedia() { Array.from(registry.values()).forEach(dropEntry); }

  async function importOne(token) {
    var rec = typeof token === 'string' ? fileTokens.get(token) : null;
    if (!rec) return { ok: false, path: String(token || '').slice(0, 260), error: 'ENOENT' };
    var file = rec.file;
    var key = [file.name, file.size, file.lastModified].join('|');
    var entry = byKey.get(key);
    if (!entry) {
      var info;
      try {
        var eng = await mediaEngine();
        info = await eng.probeFile(file);
      } catch (e) {
        return { ok: false, path: file.name, error: (e && e.code) || 'PROBE_FAILED', message: String((e && e.message) || '').slice(0, 300) };
      }
      var id = newId();
      entry = {
        id: id, file: file, handle: rec.handle, key: key, token: { cancelled: false },
        info: Object.assign({ path: file.name, name: file.name, size: file.size }, info),
        thumbCount: (await mediaEngine()).thumbCountFor(info.duration),
        thumbUrls: new Map(), thumbsReady: new Set(), waveform: null, proxyState: 'none',
        objectUrl: URL.createObjectURL(file),
      };
      registry.set(id, entry);
      byKey.set(key, entry);
      startBackground(entry);
    }
    return { ok: true, media: publicMedia(entry) };
  }

  // Thumbnails/waveforms of earlier files may have progressed while later files were still being probed:
  // re-snapshot every entry at reply time so the renderer never misses an update that was sent before it knew the media.
  async function importMany(tokens) {
    var list = (Array.isArray(tokens) ? tokens : []).filter(function (p) { return typeof p === 'string' && p; }).slice(0, 200);
    var results = [];
    for (var i = 0; i < list.length; i++) results.push(await importOne(list[i]));
    return results.map(function (r) {
      if (!r.ok) return r;
      var entry = registry.get(r.media.id);
      return entry ? { ok: true, media: publicMedia(entry) } : r;
    });
  }

  async function pickMedia() {
    var picked = await pickFiles('media', true);
    if (!picked.length) return { canceled: true, results: [] };
    return { canceled: false, results: await importMany(picked.map(function (p) { return tokenFor(p.file, p.handle); })) };
  }

  /* ---------------------------------------------------------------- export */

  var exportTarget = null; // { display, handle? } chosen in the export dialog
  var exportJobs = new Map();
  var lastOutput = null; // { handle?, blob?, name }

  function safeFileName(name, fallback) {
    var n = String(name || fallback).replace(/[\\/:*?"<>|]/g, '_').trim();
    return n || fallback;
  }

  async function pickExportPath(defaultName) {
    var name = safeFileName(defaultName, 'video.mp4');
    if (!/\.mp4$/i.test(name)) name += '.mp4';
    if (VEW.test && window.__veTest && window.__veTest.exportToMemory) { exportTarget = { display: name, handle: null }; return name; }
    if (VEW.caps.fileSystemAccess) {
      try {
        var handle = await window.showSaveFilePicker({ suggestedName: name, id: 've-export', types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
        exportTarget = { display: handle.name, handle: handle };
        return handle.name;
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    }
    exportTarget = { display: name, handle: null }; // no file picker in this browser: the result is offered as a download
    return name;
  }

  async function exportStart(req) {
    var r = req && typeof req === 'object' ? req : {};
    if (!Array.isArray(r.segments) || !r.segments.length || r.segments.length > 2000) return { ok: false, error: { code: 'EMPTY', message: 'Nothing to export' } };
    if (!exportTarget || r.outPath !== exportTarget.display) return { ok: false, error: { code: 'OUT_DIR', message: 'The output file was not chosen in the export dialog' } };
    if (exportJobs.size >= 1) return { ok: false, error: { code: 'BUSY', message: 'An export is already running' } };
    var mediaMap = {};
    var files = {};
    for (var i = 0; i < r.segments.length; i++) {
      var entry = registry.get(String(r.segments[i] && r.segments[i].mediaId));
      if (!entry) return { ok: false, error: { code: 'MEDIA_MISSING', message: 'Unknown media' } };
      mediaMap[entry.id] = Object.assign({}, entry.info, { id: entry.id });
      files[entry.id] = entry.file;
    }
    var target = exportTarget;
    var jobId = 'job' + Date.now().toString(36);
    var job;
    try {
      var eng = await exportEngine();
      job = eng.runExport({
        segments: r.segments, media: mediaMap, files: files, settings: r.settings || {}, outName: target.display, handle: target.handle,
        onProgress: function (p) { emit('export:progress', Object.assign({ jobId: jobId }, p)); },
      });
    } catch (err) {
      return { ok: false, error: { code: (err && err.code) || 'UNKNOWN', message: err && err.message } };
    }
    exportJobs.set(jobId, job);
    job.promise.then(function (res) {
      lastOutput = { handle: target.handle, blob: res.blob || null, name: target.display };
      if (VEW.test) window.__veLastExport = { blob: res.blob || null, name: target.display, size: res.size };
      emit('export:done', { jobId: jobId, ok: true, result: { outPath: target.display, size: res.size, duration: job.plan.totalDuration } });
    }).catch(function (err) {
      emit('export:done', { jobId: jobId, ok: false, error: { code: (err && err.code) || 'UNKNOWN', kind: (err && err.kind) || '', message: String((err && err.message) || '').slice(0, 500), details: String((err && err.details) || '').slice(-1500) } });
    }).then(function () { exportJobs.delete(jobId); });
    return { ok: true, jobId: jobId, totalDuration: job.plan.totalDuration, width: job.plan.canvas.width, height: job.plan.canvas.height, fps: job.plan.fps.value };
  }

  function exportCancel(jobId) {
    var job = exportJobs.get(String(jobId));
    if (job) job.cancel();
    return Promise.resolve(!!job);
  }

  // "Play": the finished file in a new tab (it is a file on the user's disk; the browser plays it from there) or, without a file picker, a download.
  async function openOutput() {
    if (!lastOutput) return false;
    try {
      var blob = lastOutput.blob;
      if (!blob && lastOutput.handle) blob = await lastOutput.handle.getFile();
      if (!blob) return false;
      var url = URL.createObjectURL(blob);
      if (lastOutput.handle) { window.open(url, '_blank', 'noopener'); } else {
        var a = document.createElement('a');
        a.href = url;
        a.download = lastOutput.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
      return true;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- projects */

  var currentProject = null; // { name, handle } of the project file saved / opened in this session

  function pageExportSettings(raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    ['resolution', 'aspect', 'fps', 'quality'].forEach(function (k) { if (typeof o[k] === 'string' || typeof o[k] === 'number') out[k] = String(o[k]).slice(0, 12); });
    return out;
  }

  async function projectSave(request) {
    var req = request && typeof request === 'object' ? request : {};
    var media = [];
    (Array.isArray(req.mediaIds) ? req.mediaIds : []).slice(0, 500).forEach(function (id) {
      var e = registry.get(String(id));
      if (e) media.push({ id: e.id, name: e.info.name, size: e.file.size, lastModified: e.file.lastModified, duration: e.info.duration });
    });
    var doc = { app: 'VideoEditor', version: 1, edition: 'web', savedAt: new Date().toISOString(), settings: pageExportSettings(req.settings), media: media, segments: Array.isArray(req.segments) ? req.segments.slice(0, 5000) : [] };
    var json = JSON.stringify(doc, null, 2);
    var handle = !req.saveAs && currentProject && currentProject.handle && req.path === currentProject.name ? currentProject.handle : null;
    var name = currentProject && !req.saveAs && req.path === currentProject.name ? currentProject.name : '';
    if (!handle) {
      var suggested = safeFileName(req.defaultName, 'project') + '.vedproj';
      if (VEW.caps.fileSystemAccess && !(VEW.test && window.__veTest && window.__veTest.projectToMemory)) {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: suggested, id: 've-project', types: [{ description: 'Video Editor project', accept: { 'application/json': ['.vedproj'] } }] });
        } catch (e) {
          if (isAbort(e)) return { canceled: true };
          return { canceled: false, error: 'WRITE_FAILED' };
        }
      } else {
        // no file picker: the project is downloaded (or kept for the tests)
        var blob = new Blob([json], { type: 'application/json' });
        if (VEW.test) window.__veLastProject = { text: json, name: suggested };
        else {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = suggested;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        }
        currentProject = { name: suggested, handle: null };
        return { canceled: false, path: suggested };
      }
      name = handle.name;
    }
    try {
      var w = await handle.createWritable();
      await w.write(json);
      await w.close();
    } catch (e) {
      return { canceled: false, error: (e && e.name) || 'WRITE_FAILED' };
    }
    currentProject = { name: name || handle.name, handle: handle };
    return { canceled: false, path: currentProject.name };
  }

  async function projectOpen(pathArg) {
    var file = null;
    var handle = null;
    if (typeof pathArg === 'string' && pathArg) {
      var rec = fileTokens.get(pathArg);
      if (!rec) return { canceled: false, error: 'INVALID_PROJECT' };
      file = rec.file; handle = rec.handle;
    } else {
      var picked = await pickFiles('project', false);
      if (!picked.length) return { canceled: true };
      file = picked[0].file; handle = picked[0].handle;
    }
    var doc;
    try {
      if (file.size > MAX_PROJECT_BYTES) return { canceled: false, error: 'INVALID_PROJECT' };
      doc = JSON.parse(await file.text());
    } catch (e) { return { canceled: false, error: 'INVALID_PROJECT' }; }
    if (!doc || doc.app !== 'VideoEditor' || !Array.isArray(doc.segments) || !Array.isArray(doc.media)) return { canceled: false, error: 'INVALID_PROJECT' };
    currentProject = { name: file.name, handle: handle };

    // A project file names its videos but cannot say where they are: the ones that are open in this session are reused, the user picks the others.
    var wanted = doc.media.slice(0, 500).filter(function (m) { return m && typeof m.id === 'string' && typeof m.name === 'string'; });
    var mediaMap = {};
    var matches = function (e, m) { return e.info.name === m.name && (!(m.size > 0) || e.file.size === m.size); };
    var unresolved = [];
    wanted.forEach(function (m) {
      var found = null;
      registry.forEach(function (e) { if (!found && matches(e, m)) found = e; });
      if (found) mediaMap[m.id] = publicMedia(found); else unresolved.push(m);
    });
    if (unresolved.length) {
      var t = (window.VE.i18n && window.VE.i18n.t) || function (k) { return k; };
      var choice = await messageBox({
        type: 'question', title: t('app.title'), message: t('proj.relinkMsg', { n: unresolved.length }),
        detail: unresolved.map(function (m) { return m.name; }).join('\n'), buttons: [t('proj.relinkPick'), t('proj.relinkSkip')], defaultId: 0, cancelId: 1,
      });
      if (choice === 0) {
        var picks = await pickFiles('media', true);
        var tokens = [];
        var wantedFor = [];
        picks.forEach(function (p) {
          var m = unresolved.find(function (u) { return u.name === p.file.name && (!(u.size > 0) || u.size === p.file.size) && wantedFor.indexOf(u) < 0; });
          if (m) { wantedFor.push(m); tokens.push(tokenFor(p.file, p.handle)); }
        });
        var results = await importMany(tokens);
        results.forEach(function (r, i) { if (r.ok) mediaMap[wantedFor[i].id] = r.media; });
      }
    }
    var missing = wanted.filter(function (m) { return !mediaMap[m.id]; }).map(function (m) { return { id: m.id, path: m.name, name: m.name }; });
    // what is no longer part of the project is released
    var keep = new Set(Object.keys(mediaMap).map(function (k) { return mediaMap[k].id; }));
    Array.from(registry.values()).forEach(function (e) { if (!keep.has(e.id)) dropEntry(e); });
    return { canceled: false, path: file.name, settings: pageExportSettings(doc.settings), segments: doc.segments.slice(0, 5000), media: mediaMap, missing: missing, blocked: [] };
  }

  /* ---------------------------------------------------------------- misc */

  function browserName() {
    var ua = navigator.userAgent;
    var m = /Edg\/([\d.]+)/.exec(ua) || /OPR\/([\d.]+)/.exec(ua) || /Chrome\/([\d.]+)/.exec(ua) || /Firefox\/([\d.]+)/.exec(ua) || /Version\/([\d.]+).*Safari/.exec(ua);
    var name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return name + (m ? ' ' + m[1].split('.')[0] : '');
  }

  // The assistant arrives in a later step of the web edition; until then these answer "not available" and the UI keeps the AI button hidden.
  function notAvailable() { return Promise.resolve({ ok: false, error: { code: 'NOT_AVAILABLE', message: 'The assistant is not available in this build.' } }); }

  window.addEventListener('beforeunload', function (e) {
    var S = window.VE && window.VE.state && window.VE.state.S;
    if (S && S.dirty && S.segments.length) { e.preventDefault(); e.returnValue = ''; }
  });

  window.api = {
    settings: settings,
    on: on,
    setSettings: setSettings,
    setTheme: function (theme) {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'light' ? '#f7f8fb' : '#12151b');
      return Promise.resolve(true);
    },
    ready: function () { return Promise.resolve([]); },
    info: function () {
      return Promise.resolve({ version: VEW.version, electron: '', chrome: '', browser: browserName(), node: '', ffmpeg: '', ffprobe: '', engine: 'WebCodecs · Mediabunny ' + VEW.mediabunnyVersion, packaged: true, edition: 'web' });
    },
    pathForFile: pathForFile,
    pickMedia: pickMedia,
    importPaths: importMany,
    requestProxy: function () { return Promise.resolve(false); },
    resetMedia: function () { resetMedia(); currentProject = null; return Promise.resolve(true); },
    pickExportPath: pickExportPath,
    exportStart: exportStart,
    exportCancel: exportCancel,
    reveal: function () { return Promise.resolve(false); },
    openOutput: openOutput,
    projectSave: projectSave,
    projectOpen: projectOpen,
    messageBox: messageBox,
    closeAck: function () { return Promise.resolve(true); },
    closeConfirmed: function () { return Promise.resolve(true); },
    ai: {
      status: function () { return Promise.resolve({ provider: 'builtin', credential: 'none', needs: 'install', ready: false, hasKey: false, vision: false, builtin: null }); },
      save: notAvailable, clearKey: notAvailable, test: notAvailable, run: notAvailable, discover: notAvailable,
      cancel: function () { return Promise.resolve(true); },
      warm: function () { return Promise.resolve({ ok: true, started: false }); },
    },
    llm: {
      status: notAvailable, install: notAvailable, remove: notAvailable, set: notAvailable,
      cancel: function () { return Promise.resolve(true); },
      stop: function () { return Promise.resolve({ ok: true }); },
      pickDir: function () { return Promise.resolve({ canceled: true }); },
    },
  };

  // browsers without WebCodecs cannot decode or encode: say so instead of failing at the first import
  document.addEventListener('DOMContentLoaded', function () {
    if (VEW.caps.webCodecs && VEW.caps.secureContext) return;
    var box = document.createElement('div');
    box.id = 'web-unsupported';
    var inner = document.createElement('div');
    inner.className = 'box';
    var title = document.createElement('b');
    title.textContent = 'Bu tarayıcı desteklenmiyor · This browser is not supported';
    var text = document.createElement('div');
    text.textContent = 'Video Editör, WebCodecs gerektirir: güncel Chrome veya Edge kullanın (adres https:// ile açılmalıdır). · The editor needs WebCodecs: please use a current Chrome or Edge (the page must be opened over https://).';
    inner.appendChild(title);
    inner.appendChild(text);
    box.appendChild(inner);
    document.body.appendChild(box);
  });
})();
