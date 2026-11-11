(function () {
  'use strict';
  window.VE = window.VE || {};
  const { $, $$, el, clamp, fmtNum, stripExt } = VE.util;
  const M = VE.model;
  const st = VE.state;
  const S = st.S;
  const api = window.api;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ====================================================================== UI helpers */

  function toast(message, kind, ms) {
    const root = $('#toasts');
    const node = el('div', { class: 'toast ' + (kind || ''), role: 'status' }, [message]);
    root.appendChild(node);
    while (root.children.length > 4) root.firstChild.remove();
    setTimeout(() => node.remove(), ms || (kind === 'error' ? 6500 : 3200));
  }

  function setStatus(text) {
    $('#status-text').textContent = text || t('status.ready');
  }

  function updateTimecodes() {
    $('#tc-cur').textContent = M.formatTime(S.playhead);
    $('#tc-total').textContent = M.formatTime(st.layout().total);
  }

  function updateInfo() {
    const lay = st.layout();
    const node = $('#status-info');
    if (!lay.items.length) { node.textContent = ''; return; }
    const first = st.firstMedia();
    const c = M.canvasSize(S.exportSettings, first);
    const fps = M.exportFps(S.exportSettings, first);
    node.textContent = [t('info.clips', { n: lay.items.length }), M.formatTime(lay.total), c.width + '×' + c.height, fmtNum(fps.value, 2) + ' fps'].join('  ·  ');
  }

  function projectName() {
    return S.projectPath ? stripExt(S.projectPath.split(/[\\/]/).pop()) : t('proj.untitled');
  }

  function updateTitle() {
    const name = projectName() + (S.dirty ? ' •' : '');
    $('#project-name').textContent = name;
    document.title = name + ' — ' + t('app.title');
  }

  function updateEnabled() {
    const has = S.segments.length > 0;
    const idx = S.selectedId ? S.segments.findIndex((s) => s.id === S.selectedId) : -1;
    const sel = idx >= 0;
    ['btn-start', 'btn-step-back', 'btn-play', 'btn-step-fwd', 'btn-end', 'btn-split', 'btn-export'].forEach((id) => { $('#' + id).disabled = !has; });
    ['btn-delete', 'btn-duplicate', 'btn-trim-start', 'btn-trim-end'].forEach((id) => { $('#' + id).disabled = !sel; });
    $('#btn-move-left').disabled = !(sel && idx > 0);
    $('#btn-move-right').disabled = !(sel && idx < S.segments.length - 1);
    $('#btn-undo').disabled = !st.canUndo();
    $('#btn-redo').disabled = !st.canRedo();
  }

  function updateThemeButton(theme) {
    const btn = $('#btn-theme');
    VE.icons.set(btn.querySelector('[data-icon]'), theme === 'dark' ? 'sun' : 'moon');
    const label = t(theme === 'dark' ? 'tb.themeToLight' : 'tb.themeToDark');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeButton(theme);
    api.setTheme(theme);
    if (persist) api.setSettings({ theme });
    VE.timeline.themeChanged();
  }

  function updateLangButtons(lang) {
    $$('#lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  }

  function applyLanguage(lang, persist) {
    VE.i18n.setLanguage(lang);
    updateLangButtons(lang);
    updateThemeButton(currentTheme());
    updateTitle();
    updateInfo();
    setStatus('');
    if (persist) api.setSettings({ language: lang });
  }

  /* ====================================================================== editing actions */

  // Commits a new segment list. opts.anchorId keeps the playhead on the same source frame of that clip (speed/trim edits).
  function commitSegments(segs, opts) {
    const o = Object.assign({}, opts);
    if (o.anchorId) {
      const loc = M.locate(st.layout(), S.playhead);
      if (loc && loc.item.seg.id === o.anchorId) {
        const it = M.layout(segs).items.find((i) => i.seg.id === o.anchorId);
        if (it) o.playhead = it.start + clamp((loc.srcTime - it.seg.in) / it.seg.speed, 0, it.dur);
      }
    }
    st.commit(segs, o);
  }

  const sameSeg = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

  function updateSegment(id, patch, opts) {
    const seg = st.getSeg(id);
    if (!seg) return;
    const next = M.sanitizeSegment(Object.assign({}, seg, patch), st.mediaOf(seg));
    if (sameSeg(seg, next)) return;
    commitSegments(S.segments.map((s) => (s.id === id ? next : s)), Object.assign({ anchorId: id }, opts));
  }

  function moveSegment(id, newIndex) {
    const idx = S.segments.findIndex((s) => s.id === id);
    if (idx < 0 || newIndex === idx) return;
    const arr = S.segments.slice();
    const moved = arr.splice(idx, 1)[0];
    arr.splice(clamp(newIndex, 0, arr.length), 0, moved);
    commitSegments(arr, { selectedId: id });
  }

  function trimSegment(id, nin, nout) {
    updateSegment(id, { in: nin, out: nout }, {});
  }

  function stepFrames(n) {
    VE.player.pause();
    const fps = M.exportFps(S.exportSettings, st.firstMedia()).value;
    st.setPlayhead(S.playhead + n / fps, 'user');
  }

  function jumpCut(dir) {
    VE.player.pause();
    const lay = st.layout();
    const points = [0].concat(lay.items.map((i) => i.end));
    const eps = 0.005;
    let target = dir > 0 ? lay.total : 0;
    if (dir > 0) { const p = points.find((x) => x > S.playhead + eps); if (p !== undefined) target = p; }
    else { const p = points.slice().reverse().find((x) => x < S.playhead - eps); if (p !== undefined) target = p; }
    st.setPlayhead(target, 'user');
  }

  function splitAtPlayhead() {
    const loc = M.locate(st.layout(), S.playhead);
    if (!loc) { toast(t('toast.splitNone'), 'warning'); return; }
    const seg = loc.item.seg;
    const media = st.mediaOf(seg);
    const minD = Math.max(M.LIMITS.minSourceDur, 0.5 / ((media && media.fps) || 30));
    const mid = seg.in + (seg.out - seg.in) * loc.frac;
    if (mid - seg.in < minD || seg.out - mid < minD) { toast(t('toast.splitNone'), 'warning'); return; }
    const parts = M.splitSegment(seg, loc.frac);
    const arr = S.segments.slice();
    arr.splice(loc.index, 1, parts[0], parts[1]);
    commitSegments(arr, { selectedId: parts[1].id });
  }

  function deleteSelected() {
    const seg = st.selectedSeg();
    if (!seg) { toast(t('toast.selectFirst'), 'warning'); return; }
    const idx = S.segments.findIndex((s) => s.id === seg.id);
    const it = st.layout().items[idx];
    const arr = S.segments.filter((s) => s.id !== seg.id);
    const next = arr[Math.min(idx, arr.length - 1)] || null;
    let ph = S.playhead;
    if (ph > it.start) ph = Math.max(it.start, ph - it.dur);
    commitSegments(arr, { selectedId: next ? next.id : null, playhead: ph });
  }

  function duplicateSelected() {
    const seg = st.selectedSeg();
    if (!seg) { toast(t('toast.selectFirst'), 'warning'); return; }
    const idx = S.segments.findIndex((s) => s.id === seg.id);
    const copy = Object.assign({}, seg, { id: M.uid('seg') });
    const arr = S.segments.slice();
    arr.splice(idx + 1, 0, copy);
    commitSegments(arr, { selectedId: copy.id });
  }

  function moveSelected(dir) {
    const seg = st.selectedSeg();
    if (!seg) return;
    const idx = S.segments.findIndex((s) => s.id === seg.id);
    const to = idx + dir;
    if (to < 0 || to >= S.segments.length) return;
    moveSegment(seg.id, to);
  }

  function trimToPlayhead(side) {
    const loc = M.locate(st.layout(), S.playhead);
    const sel = st.selectedSeg();
    if (!loc || (sel && loc.item.seg.id !== sel.id)) { toast(t('toast.trimNone'), 'warning'); return; }
    const seg = loc.item.seg;
    const media = st.mediaOf(seg);
    const minD = Math.max(M.LIMITS.minSourceDur, 0.5 / ((media && media.fps) || 30));
    const src = loc.srcTime;
    if (src - seg.in < minD || seg.out - src < minD) { toast(t('toast.trimNone'), 'warning'); return; }
    const patch = side === 'start' ? { in: src } : { out: src };
    const next = M.sanitizeSegment(Object.assign({}, seg, patch), media);
    const arr = S.segments.map((s) => (s.id === seg.id ? next : s));
    const it = M.layout(arr).items[loc.index];
    commitSegments(arr, { selectedId: seg.id, playhead: side === 'start' ? it.start : it.start + it.dur });
  }

  /* ====================================================================== media import */

  function registerMedia(m) {
    const existing = S.media.get(m.id);
    if (existing) return existing;
    const rec = Object.assign({}, m, {
      thumbsReady: new Set(m.thumbsReady || []),
      waveform: m.waveform ? new Uint8Array(m.waveform) : null,
      proxyProgress: 0,
    });
    S.media.set(rec.id, rec);
    return rec;
  }

  function importErrorText(r) {
    const key = 'err.import.' + (r.error || 'generic');
    const s = t(key);
    return s === key ? t('err.import.generic') : s;
  }

  async function reportImportFailures(failed) {
    const lines = failed.map((r) => (r.path ? r.path.split(/[\\/]/).pop() : '?') + ' — ' + importErrorText(r));
    if (failed.length === 1) { toast(lines[0], 'error'); return; }
    await api.messageBox({ type: 'warning', title: t('app.title'), message: t('dlg.reportTitle'), detail: lines.join('\n') });
  }

  function addResults(results) {
    const added = [];
    const failed = [];
    (results || []).forEach((r) => { if (r && r.ok) added.push(registerMedia(r.media)); else if (r) failed.push(r); });
    if (added.length) {
      const fresh = added.map((m) => M.createSegment(m));
      commitSegments(S.segments.concat(fresh), { selectedId: fresh[fresh.length - 1].id });
      toast(t('toast.added', { n: added.length }), 'success');
      if (added.some((m) => m.hdr)) toast(t('toast.hdr'), 'warning', 5200);
    }
    if (failed.length) reportImportFailures(failed);
  }

  async function addVideosDialog() {
    setStatus(t('status.importing'));
    try {
      const res = await api.pickMedia();
      if (!res.canceled) addResults(res.results);
    } catch (e) {
      toast(String((e && e.message) || e), 'error');
    } finally {
      setStatus('');
    }
  }

  async function importAndAdd(paths) {
    if (!paths.length) return;
    setStatus(t('status.importing'));
    try {
      addResults(await api.importPaths(paths));
    } catch (e) {
      toast(String((e && e.message) || e), 'error');
    } finally {
      setStatus('');
    }
  }

  async function openPaths(paths) {
    const list = (paths || []).filter(Boolean);
    const projects = list.filter((p) => /\.vedproj$/i.test(p));
    const videos = list.filter((p) => !/\.vedproj$/i.test(p));
    if (projects.length) await openProject(projects[0]);
    if (videos.length) await importAndAdd(videos);
  }

  /* ====================================================================== projects */

  async function confirmDiscard() {
    if (!S.dirty || !S.segments.length) return true;
    const choice = await api.messageBox({
      type: 'question', title: t('dlg.unsavedTitle'), message: t('dlg.unsavedMsg'),
      buttons: [t('dlg.save'), t('dlg.dontSave'), t('dlg.cancel')], defaultId: 0, cancelId: 2,
    });
    if (choice === 2) return false;
    if (choice === 0) return saveProject(false);
    return true;
  }

  async function saveProject(saveAs) {
    const mediaIds = Array.from(new Set(S.segments.map((s) => s.mediaId)));
    let res;
    try {
      res = await api.projectSave({ path: S.projectPath, saveAs: !!saveAs, defaultName: projectName(), mediaIds, settings: Object.assign({}, S.exportSettings), segments: S.segments });
    } catch (e) {
      toast(t('proj.saveError'), 'error');
      return false;
    }
    if (res.canceled) return false;
    if (res.error) { toast(t('proj.saveError'), 'error'); return false; }
    st.markClean(res.path);
    toast(t('toast.saved'), 'success', 1800);
    return true;
  }

  function sanitizeExport(obj) {
    const o = obj || {};
    const pick = (v, allowed, def) => (allowed.includes(String(v)) ? String(v) : def);
    return {
      resolution: pick(o.resolution, ['original', '1080', '720', '480'], 'original'),
      aspect: pick(o.aspect, ['auto', '16:9', '9:16', '1:1', '4:3'], 'auto'),
      fps: pick(o.fps, ['auto', '24', '25', '30', '50', '60'], 'auto'),
      quality: pick(o.quality, ['high', 'medium', 'low'], 'high'),
    };
  }

  async function openProject(pathArg) {
    if (!(await confirmDiscard())) return;
    let res;
    try {
      res = await api.projectOpen(typeof pathArg === 'string' ? pathArg : '');
    } catch (e) {
      toast(t('proj.invalid'), 'error');
      return;
    }
    if (res.canceled) return;
    if (res.error) { await api.messageBox({ type: 'error', title: t('app.title'), message: t('proj.invalid') }); return; }
    VE.player.pause();
    st.reset();
    VE.timeline.resetView();
    const seen = new Set();
    const segs = [];
    (res.segments || []).forEach((raw) => {
      const entry = raw && res.media[raw.mediaId];
      if (!entry) return;
      const media = registerMedia(entry);
      const base = M.createSegment(media);
      const merged = Object.assign(base, raw, { mediaId: media.id });
      if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) merged.id = M.uid('seg');
      seen.add(merged.id);
      segs.push(M.sanitizeSegment(merged, media));
    });
    S.exportSettings = Object.assign({}, S.exportSettings, sanitizeExport(res.settings));
    VE.exportUI.reset();
    st.load(segs, res.path);
    VE.player.relayout();
    if (res.missing && res.missing.length) {
      await api.messageBox({ type: 'warning', title: t('app.title'), message: t('proj.missing'), detail: res.missing.map((m) => m.path).join('\n') });
    }
    if (res.blocked && res.blocked.length) {
      await api.messageBox({ type: 'warning', title: t('app.title'), message: t('proj.blocked'), detail: res.blocked.map((m) => m.path).join('\n') });
    }
  }

  async function newProject() {
    if (!(await confirmDiscard())) return;
    VE.player.pause();
    await api.resetMedia();
    st.reset();
    VE.timeline.resetView();
    VE.exportUI.reset();
    VE.timeline.fit();
  }

  /* ====================================================================== about */

  async function showAbout() {
    let info = {};
    try { info = await api.info(); } catch (e) { /* show what we have */ }
    const row = (label, value) => [el('span', { text: label }), el('b', { text: value || '—' })];
    const grid = el('div', { class: 'about-grid' }, [
      ...row(t('about.version'), info.version),
      ...row(t('about.engine'), info.electron ? 'Electron ' + info.electron + ' · Chromium ' + info.chrome : ''),
      ...row(t('about.ffmpeg'), info.ffmpeg ? 'FFmpeg ' + info.ffmpeg : ''),
    ]);
    const note = el('div', { class: 'about-note' });
    note.innerHTML = t('about.offline');
    const ok = el('button', { class: 'btn primary', type: 'button', text: t('about.ok'), 'data-autofocus': true });
    ok.addEventListener('click', () => VE.modal.close());
    VE.modal.open({ title: t('about.title'), body: el('div', { style: { display: 'contents' } }, [grid, note, el('div', { class: 'hint', text: t('about.license') })]), footer: [ok] });
  }

  /* ====================================================================== keyboard */

  function onKeyDown(e) {
    // The dialog's own Escape handler has already used the key (preventDefault): it must not also clear the selection.
    if (VE.modal.isOpen() || e.defaultPrevented) return;
    const target = e.target;
    const tag = target && target.tagName;
    const type = target && target.type;
    const isRange = tag === 'INPUT' && type === 'range';
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'button'].includes(type));
    if (typing) return;
    const key = e.key;
    const k = key.length === 1 ? key.toLowerCase() : key;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl) {
      switch (k) {
        case 'z': if (e.shiftKey) redo(); else undo(); break;
        case 'y': redo(); break;
        case 'o': if (e.shiftKey) openProject(); else addVideosDialog(); break;
        case 's': saveProject(e.shiftKey); break;
        case 'n': newProject(); break;
        case 'e': VE.exportUI.open(); break;
        case 'k': VE.ai.toggle(); break;
        case 'd': duplicateSelected(); break;
        case 'ArrowLeft': jumpCut(-1); break;
        case 'ArrowRight': jumpCut(1); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if (e.altKey) {
      if (key === 'ArrowLeft') moveSelected(-1);
      else if (key === 'ArrowRight') moveSelected(1);
      else return;
      e.preventDefault();
      return;
    }
    // Keyboard-operated sliders keep their own arrow-key behaviour.
    if (isRange && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;

    const fps = M.exportFps(S.exportSettings, st.firstMedia()).value;
    switch (k) {
      case ' ': if (!e.repeat) VE.player.toggle(); break;
      case 'Home': VE.player.pause(); st.setPlayhead(0, 'user'); break;
      case 'End': VE.player.pause(); st.setPlayhead(st.layout().total, 'user'); break;
      case 'ArrowLeft': stepFrames(e.shiftKey ? -Math.round(fps) : -1); break;
      case 'ArrowRight': stepFrames(e.shiftKey ? Math.round(fps) : 1); break;
      case 'Delete': case 'Backspace': if (!e.repeat) deleteSelected(); break;
      case 's': if (!e.repeat) splitAtPlayhead(); break;
      case 'q': if (!e.repeat) trimToPlayhead('start'); break;
      case 'w': if (!e.repeat) trimToPlayhead('end'); break;
      case 'f': VE.timeline.fit(); break;
      case '+': case '=': VE.timeline.zoomBy(1.4); break;
      case '-': VE.timeline.zoomBy(1 / 1.4); break;
      case 'Escape': st.select(null); break;
      default: return;
    }
    e.preventDefault();
  }

  function undo() { if (st.undo()) clampPlayhead(); }
  function redo() { if (st.redo()) clampPlayhead(); }
  function clampPlayhead() { if (S.playhead > st.layout().total) st.setPlayhead(st.layout().total, 'user'); }

  /* ====================================================================== drag & drop */

  function bindDragDrop() {
    const overlay = $('#drop-overlay');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      overlay.classList.add('show');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.classList.remove('show');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      if (!hasFiles(e)) return;
      const paths = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean);
      openPaths(paths);
    });
  }

  /* ====================================================================== window lifecycle */

  let closing = false;
  async function onCloseRequested() {
    api.closeAck();
    if (closing) return;
    closing = true;
    try {
      if (VE.ai.isRunning()) VE.ai.cancel();
      if (VE.exportUI.isRunning()) {
        const choice = await api.messageBox({ type: 'warning', title: t('dlg.exportBusyTitle'), message: t('dlg.exportBusyMsg'), buttons: [t('dlg.quit'), t('dlg.stay')], defaultId: 1, cancelId: 1 });
        if (choice !== 0) return;
        VE.exportUI.cancel();
        await sleep(400);
      }
      if (!(await confirmDiscard())) return;
      await api.closeConfirmed();
    } finally {
      closing = false;
    }
  }

  /* ====================================================================== wiring */

  function bindUi() {
    const on = (id, fn) => $('#' + id).addEventListener('click', fn);
    on('btn-new', newProject);
    on('btn-add', addVideosDialog);
    on('btn-add-empty', addVideosDialog);
    on('btn-open', () => openProject());
    on('btn-save', () => saveProject(false));
    on('btn-undo', undo);
    on('btn-redo', redo);
    on('btn-theme', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true));
    on('btn-about', showAbout);
    on('btn-export', () => VE.exportUI.open());

    on('btn-start', () => { VE.player.pause(); st.setPlayhead(0, 'user'); });
    on('btn-end', () => { VE.player.pause(); st.setPlayhead(st.layout().total, 'user'); });
    on('btn-step-back', () => stepFrames(-1));
    on('btn-step-fwd', () => stepFrames(1));

    on('btn-split', splitAtPlayhead);
    on('btn-delete', deleteSelected);
    on('btn-duplicate', duplicateSelected);
    on('btn-trim-start', () => trimToPlayhead('start'));
    on('btn-trim-end', () => trimToPlayhead('end'));
    on('btn-move-left', () => moveSelected(-1));
    on('btn-move-right', () => moveSelected(1));

    $$('#lang-switch button').forEach((b) => b.addEventListener('click', () => applyLanguage(b.dataset.lang, true)));

    // Buttons clicked with the mouse must not keep focus (otherwise Space would re-trigger them).
    document.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('button') : null;
      if (b && e.detail > 0 && !VE.modal.isOpen()) b.blur();
    });
    window.addEventListener('keydown', onKeyDown);
    // No browser context menu anywhere except in text fields (cut/copy/paste, e.g. to paste an API key): the main process shows it there.
    window.addEventListener('contextmenu', (e) => {
      const t0 = e.target;
      if (t0 && t0.closest && t0.closest('input[type="text"], input[type="password"], textarea')) return;
      e.preventDefault();
    });
    window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason));
    bindDragDrop();
  }

  function bindEvents() {
    st.bus.on('segments', () => {
      updateTimecodes();
      updateInfo();
      updateEnabled();
      VE.player.sync();
    });
    st.bus.on('selection', updateEnabled);
    st.bus.on('history', updateEnabled);
    st.bus.on('project', updateTitle);
    st.bus.on('playhead', updateTimecodes);

    api.on('media:thumb', (ev) => {
      const m = S.media.get(ev.id);
      if (!m) return;
      m.thumbsReady.add(ev.index);
      VE.timeline.thumbReady();
      VE.inspector.thumbReady(ev.id);
    });
    api.on('media:waveform', (ev) => {
      const m = S.media.get(ev.id);
      if (!m) return;
      m.waveform = new Uint8Array(ev.peaks);
      VE.timeline.waveformReady();
    });
    api.on('media:proxy', (ev) => VE.player.onProxyEvent(ev));
    api.on('app:open-files', (files) => openPaths(files));
    api.on('app:close-requested', onCloseRequested);
  }

  function init() {
    const settings = api.settings;
    S.exportSettings = Object.assign({}, S.exportSettings, sanitizeExport(settings.export));
    VE.icons.apply();
    VE.i18n.setLanguage(settings.language);
    VE.player.init(settings);
    VE.timeline.init();
    VE.inspector.init();
    VE.exportUI.init();
    VE.ai.init();
    bindUi();
    bindEvents();
    document.querySelectorAll('input[type="range"]').forEach((i) => {
      VE.util.fillRange(i);
      i.addEventListener('input', () => VE.util.fillRange(i));
    });
    updateLangButtons(settings.language);
    updateThemeButton(currentTheme());
    api.setTheme(currentTheme());
    updateTimecodes();
    updateInfo();
    updateEnabled();
    updateTitle();
    setStatus('');
    VE.player.sync();
    api.ready().then((files) => { if (files && files.length) openPaths(files); });
  }

  // The assistant's result replaces the timeline in ONE undo step; selection survives if its clip still exists.
  function applyAiSegments(segs) {
    const keep = S.selectedId && segs.some((s) => s.id === S.selectedId) ? S.selectedId : null;
    commitSegments(segs, { selectedId: keep });
  }

  function applyExportSettings(obj) {
    S.exportSettings = Object.assign({}, S.exportSettings, sanitizeExport(obj));
    api.setSettings({ export: Object.assign({}, S.exportSettings) });
    VE.player.relayout();
    updateInfo();
  }

  VE.actions = {
    toast, status: setStatus,
    seek: (time) => st.setPlayhead(time, 'user'),
    select: (id) => st.select(id),
    updateSegment, moveSegment, trimSegment,
    undo, redo, applyAi: applyAiSegments, applyExportSettings,
  };

  init();
})();
