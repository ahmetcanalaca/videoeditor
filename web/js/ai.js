(function () {
  'use strict';
  window.VE = window.VE || {};
  const { $, el, fmtNum } = VE.util;
  const M = VE.model;
  const st = VE.state;
  const S = st.S;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const api = window.api;

  const PROVIDERS = ['builtin', 'openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local'];
  const PROV_KEYS = { builtin: 'aiset.prov.builtin', openai: 'aiset.prov.openai', azure: 'aiset.prov.azure', foundry: 'aiset.prov.foundry', anthropic: 'aiset.prov.anthropic', gemini: 'aiset.prov.gemini', local: 'aiset.prov.local' };
  const HINT_KEYS = { builtin: 'aiset.hint.builtin', openai: 'aiset.hint.openai', azure: 'aiset.hint.azure', foundry: 'aiset.hint.foundry', anthropic: 'aiset.hint.anthropic', gemini: 'aiset.hint.gemini', local: 'aiset.hint.local' };
  const AUTH_KEYS = { key: 'aiset.auth.key', entra: 'aiset.auth.entra' };
  const URL_HINT = {
    builtin: '', openai: 'https://api.openai.com/v1', azure: 'https://RESOURCE.openai.azure.com', foundry: 'https://RESOURCE.services.ai.azure.com/api/projects/PROJECT',
    anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com', local: 'http://127.0.0.1:11434/v1',
  };
  const MODEL_HINT = { builtin: '', openai: 'gpt-4o-mini', azure: 'my-deployment', foundry: 'my-deployment', anthropic: 'claude-sonnet-4-5', gemini: 'gemini-2.5-flash', local: 'qwen2.5:3b' };
  // problems the user can fix in the settings dialog (the error card then offers a shortcut)
  const FIXABLE = ['AUTH', 'FORBIDDEN', 'NO_KEY', 'NOT_CONFIGURED', 'KEY_MISMATCH', 'NOT_FOUND', 'NO_TOOLS', 'URL', 'URL_EMPTY', 'URL_INVALID', 'URL_SCHEME', 'URL_CREDENTIALS', 'URL_NOT_LOCAL',
    'NOT_INSTALLED', 'MODEL_NOT_READY', 'HASH_MISMATCH', 'LLM_START_FAILED', 'LLM_START_TIMEOUT', 'RUNTIME_MISSING', 'WRITE_FAILED', 'ENTRA_NOT_CONFIRMED', 'ENDPOINT_NOT_CONFIRMED',
    'CU_NO_ENDPOINT', 'CU_ORIGIN_MISMATCH', 'CU_NOT_CONFIRMED', 'CU_URL_INVALID', 'CU_URL_SCHEME', 'CU_URL_CREDENTIALS', 'CU_ANALYZER_INVALID', 'CU_NO_ANALYZER', 'CU_NO_DEFAULTS', 'CU_LOCATION'];
  const EXAMPLES = ['ai.ex1', 'ai.ex2', 'ai.ex3', 'ai.ex4', 'ai.ex5'];
  // what the assistant can do with the video's CONTENT (only with the built-in model)
  const VISION_EXAMPLES = ['ai.exv1', 'ai.exv2', 'ai.exv3'];
  // ... and with an analysis by Azure Content Understanding (what is shown AND said)
  const CU_EXAMPLES = ['ai.exc1', 'ai.exc2', 'ai.exc3'];
  const CU_LOCATIONS = ['geography', 'dataZone', 'global'];
  // what is still missing for the video analysis (status.cu.needs) and the names of the processing locations; the keys are built here, not inside t()
  const cuNeedsText = (needs) => { const key = 'ai.cuNeeds.' + needs; return t(key); };
  const cuLocationText = (loc) => { const key = 'aiset.cu.loc.' + loc; return t(key); };
  const MAX_MESSAGES = 80;
  const MAX_HISTORY = 24;

  // The API key never reaches this file: the main process holds it and only reports a masked hint in `status`.
  const state = { status: null, open: false, running: false, runId: 0, messages: [], history: [], live: null, committed: null, warmTried: false };
  const r = {};

  const ready = () => !!(state.status && state.status.ready);
  const hasClips = () => S.segments.length > 0;
  // Segments are immutable: the same objects mean the same timeline, even if undo/redo handed out a new array.
  const sameList = (a, b) => !!a && !!b && (a === b || (a.length === b.length && a.every((s, i) => s === b[i])));
  const icon = (name) => { const n = el('span', { class: 'ai-ico' }); VE.icons.set(n, name); return n; };

  /* ---------- formatting of the actions the assistant performed ---------- */

  function fmtT(sec) {
    const cs = Math.round(Math.max(0, sec) * 100);
    const frac = cs % 100;
    return M.formatTime(Math.floor(cs / 100), false) + (frac ? (VE.i18n.getLanguage() === 'en' ? '.' : ',') + String(frac).padStart(2, '0') : '');
  }
  const fmtRange = (a, b) => fmtT(a) + '–' + fmtT(b);

  function fmtAction(a) {
    const range = () => fmtRange(a.start, a.end);
    switch (a.op) {
      case 'split': return t('ai.act.split', { times: (a.times || []).map(fmtT).join(', ') });
      case 'remove': return t('ai.act.remove', { range: range(), secs: fmtNum(a.seconds, 1) });
      case 'keep': return t('ai.act.keep', { range: range() });
      case 'speed': return t('ai.act.speed', { speed: fmtNum(a.speed, 2), range: range() });
      case 'zoom': return a.from === 1 && a.to === 1 ? t('ai.act.zoomNone', { range: range() }) : t('ai.act.zoom', { from: fmtNum(a.from, 2), to: fmtNum(a.to, 2), range: range() }) + (a.eased ? ' · ' + t('ai.act.eased') : '');
      case 'volume': {
        const bits = [];
        if (a.volume_percent !== undefined && a.volume_percent !== null) bits.push(t('ai.act.volumePct', { p: a.volume_percent }));
        if (a.mute !== undefined && a.mute !== null) bits.push(t(a.mute ? 'ai.act.mute' : 'ai.act.unmute'));
        return t('ai.act.volume', { what: bits.join(', '), range: range() });
      }
      case 'fade': {
        const bits = [];
        if (a.fade_in !== undefined && a.fade_in !== null) bits.push(t('ai.act.fadeIn', { s: fmtNum(a.fade_in, 1) }));
        if (a.fade_out !== undefined && a.fade_out !== null) bits.push(t('ai.act.fadeOut', { s: fmtNum(a.fade_out, 1) }));
        return t('ai.act.fade', { what: bits.join(', '), range: range() });
      }
      case 'reorder': return t('ai.act.reorder', { order: (a.order || []).join(', ') });
      case 'reset': return t('ai.act.reset', { range: range() });
      case 'export_settings': return t('ai.act.export', { what: Object.keys(a).filter((k) => k !== 'op').map((k) => k + ' ' + a[k]).join(', ') });
      case 'open_export': return t('ai.act.openExport');
      default: return String(a.op || '');
    }
  }

  // The same code can mean different things for a local server or an Entra ID sign-in: pick the most specific text that exists.
  function errorText(error) {
    const code = (error && error.code) || 'INTERNAL';
    const s = state.status;
    const tries = [];
    if (s && s.provider === 'local') tries.push('ai.err.' + code + '_LOCAL');
    if (s && s.provider === 'builtin') tries.push('ai.err.' + code + '_BUILTIN');
    if (s && s.auth === 'entra') tries.push('ai.err.' + code + '_ENTRA');
    tries.push('ai.err.' + code);
    for (const key of tries) {
      const text = t(key);
      if (text !== key) return text;
    }
    return t('ai.err.INTERNAL');
  }

  // errors the settings dialog can fix; for a model on this computer (the Local AI helper or another server) an unreachable server is one of them (not started, wrong port)
  function isFixable(code) {
    const s = state.status;
    return FIXABLE.includes(code) || ((code === 'NETWORK' || code === 'TIMEOUT') && !!s && (s.provider === 'local' || s.provider === 'builtin'));
  }

  /* ---------- rendering ---------- */

  function actionList(actions, withIcon) {
    if (!actions || !actions.length) return null;
    return el('ul', { class: 'ai-actions' }, actions.map((a) => el('li', {}, [withIcon === false ? null : icon('checkCircle'), el('span', { text: fmtAction(a) })])));
  }

  function introNode() {
    const sees = !!(state.status && state.status.vision);
    const cu = state.status && state.status.cu ? state.status.cu : null;
    const reads = !!(cu && cu.ready);
    const chip = (key) => {
      const b = el('button', { class: 'ai-chip', type: 'button', text: t(key) });
      b.addEventListener('click', () => { if (r.input.disabled) return; r.input.value = t(key); autosize(); updateControls(); r.input.focus(); });
      return b;
    };
    const chips = EXAMPLES.map(chip);
    const nodes = [el('div', { class: 'ai-intro-title', text: t('ai.intro') }), el('div', { class: 'ai-chips' }, chips)];
    if (sees) {
      nodes.push(el('div', { class: 'ai-intro-title', text: t('ai.introVision') }), el('div', { class: 'ai-chips', 'data-ai': 'vision-examples' }, VISION_EXAMPLES.map(chip)));
    } else if (reads) {
      nodes.push(el('div', { class: 'ai-intro-title', text: t('ai.introCu') }), el('div', { class: 'ai-chips', 'data-ai': 'cu-examples' }, CU_EXAMPLES.map(chip)));
    }
    nodes.push(el('div', { class: 'ai-intro-note', text: t(sees ? 'ai.vision' : (reads ? 'ai.cuNote' : 'ai.noVision')) }));
    // switched on but something is missing: say what, with a way to fix it
    if (cu && cu.enabled && !cu.ready && !sees) {
      const fix = el('button', { class: 'btn outline small', type: 'button', text: t('ai.setup.fix') });
      fix.addEventListener('click', openSettings);
      nodes.push(el('div', { class: 'ai-intro-note warn', 'data-ai': 'cu-notready' }, [el('span', { text: cuNeedsText(cu.needs) + ' ' }), fix]));
    }
    if (!hasClips()) nodes.push(el('div', { class: 'ai-intro-note warn', text: t('ai.emptyHint') }));
    return el('div', { class: 'ai-intro' }, nodes);
  }

  // "dog (left)" - what find_in_video looked for
  const POS_KEYS = { left: 'ai.pos.left', right: 'ai.pos.right', top: 'ai.pos.top', bottom: 'ai.pos.bottom', center: 'ai.pos.center' };
  function searchWhat(o) {
    return String(o.object || o.label || '') + (POS_KEYS[o.position] ? ' (' + t(POS_KEYS[o.position]) + ')' : '');
  }

  // what find_in_video found: one line per thing, with the time ranges
  function foundList(found) {
    if (!found || !found.length) return null;
    return el('ul', { class: 'ai-actions ai-found-list' }, found.map((f) => {
      const text = f.intervals && f.intervals.length
        ? t('ai.foundLine', { what: f.label, n: f.intervals.length, ranges: f.intervals.slice(0, 6).map((iv) => fmtRange(Math.round(iv.start), Math.round(iv.end))).join(', ') + (f.intervals.length > 6 ? ' …' : '') })
        : t('ai.foundNone', { what: f.label });
      const kids = [el('span', { text })];
      if (f.frames) kids.push(el('span', { class: 'ai-found-meta', text: ' · ' + t('ai.foundMeta', { frames: f.frames, step: fmtNum(f.step, 1), secs: fmtNum(f.seconds, 0) }) }));
      return el('li', { 'data-ai': 'found' }, [icon(f.intervals && f.intervals.length ? 'zoom' : 'alert'), el('span', {}, kids)]);
    }));
  }

  // The analysis of the video by Azure Content Understanding: one block per analysis, a closed list of its scenes (a click moves the playhead there).
  function analysisList(list) {
    if (!list || !list.length) return null;
    return el('div', { class: 'ai-analyses' }, list.map((a) => {
      const head = t('ai.cu.line', { n: a.count, src: t(a.uploaded ? 'ai.cu.srcUploaded' : 'ai.cu.srcCache', { n: a.uploaded }) });
      const rows = (a.scenes || []).map((s) => {
        const b = el('button', { class: 'ai-scene', type: 'button', title: t('ai.cu.seek') }, [el('b', { text: fmtRange(Math.round(s.start), Math.round(s.end)) }), el('span', { text: ' ' + s.text })]);
        b.addEventListener('click', () => VE.actions.seek(s.start));
        return b;
      });
      const more = a.count > rows.length ? el('div', { class: 'ai-scene-more', text: t('ai.cu.more', { n: a.count - rows.length }) }) : null;
      return el('details', { class: 'ai-analysis', 'data-ai': 'analysis' }, [el('summary', {}, [icon('film'), el('span', { text: head })]), el('div', { class: 'ai-scenes' }, rows.concat(more ? [more] : []))]);
    }));
  }

  function messageNode(m) {
    if (m.type === 'user') return el('div', { class: 'ai-msg user', text: m.text });
    if (m.type === 'info') return el('div', { class: 'ai-msg info', text: m.text });
    if (m.type === 'error') {
      const kids = [icon('xCircle'), el('div', { class: 'ai-err-body' }, [el('b', { text: m.text })])];
      const body = kids[1];
      if (m.detail) body.append(el('div', { class: 'ai-err-detail', text: t('ai.err.detail') + ': ' + m.detail }));
      if (m.fix) {
        const fix = el('button', { class: 'btn outline small', type: 'button', text: t('ai.setup.fix') });
        fix.addEventListener('click', openSettings);
        body.append(fix);
      }
      return el('div', { class: 'ai-msg err' }, kids);
    }
    const kids = [el('div', { class: 'ai-text', text: m.text })];
    const looked = foundList(m.found);
    if (looked) kids.push(looked);
    const read = analysisList(m.analyses);
    if (read) kids.push(read);
    const list = actionList(m.actions);
    if (list) kids.push(list);
    if (m.meta) kids.push(el('div', { class: 'ai-meta', text: t('ai.meta', { n: m.meta.n, tokens: m.meta.tokens }) }));
    return el('div', { class: 'ai-msg ai' }, kids);
  }

  // progress of the video analysis (Azure Content Understanding): which part, what is happening
  function analysisLabel(a) {
    const n = a.parts || 1;
    const i = a.index || 1;
    if (a.phase === 'plan') return t('ai.cu.plan', { parts: a.parts, cached: a.cached });
    if (a.phase === 'prepare') return t('ai.cu.prepare', { i, n, pct: Math.round((a.fraction || 0) * 100) });
    if (a.phase === 'upload') return t('ai.cu.upload', { i, n, mb: fmtNum(a.megabytes || 0, 1) });
    if (a.phase === 'wait') return t('ai.cu.wait', { i, n, s: Math.round((a.elapsedMs || 0) / 1000) });
    return t('ai.cu.start');
  }

  function liveNode() {
    const live = state.live;
    const s = live.search;
    let label = t('ai.working');
    let ratio = null;
    if (VE.llmUI.state.loading) label = t('ai.loadingModel');
    else if (live.analysis) {
      label = analysisLabel(live.analysis);
      if (live.analysis.phase === 'prepare') ratio = live.analysis.fraction || 0;
    } else if (s) {
      const what = searchWhat(s);
      label = t(s.phase === 'refine' ? 'ai.searchRefine' : (s.phase === 'ground' ? 'ai.searchGround' : 'ai.searching'), { what, done: s.done || 0, total: s.total || 0 });
      if (s.total > 0) ratio = Math.min(1, (s.done || 0) / s.total);
    }
    const head = el('div', { class: 'ai-working', 'data-ai': 'working' }, [el('span', { class: 'ai-dots' }, [el('span'), el('span'), el('span')]), el('span', { text: label })]);
    const kids = [head];
    if (ratio !== null) {
      const bar = el('div', { class: 'ai-progress', 'data-ai': 'search-bar' }, [el('i')]);
      bar.firstChild.style.width = Math.round(ratio * 100) + '%';
      kids.push(bar);
    }
    const looked = foundList(live.found);
    if (looked) kids.push(looked);
    const read = analysisList(live.analyses);
    if (read) kids.push(read);
    const list = actionList(live.actions);
    if (list) kids.push(list);
    return el('div', { class: 'ai-msg ai live' }, kids);
  }

  function renderLog() {
    const nodes = [];
    if (!state.messages.length && !state.live && ready()) nodes.push(introNode());
    state.messages.forEach((m) => nodes.push(messageNode(m)));
    if (state.live) nodes.push(liveNode());
    r.log.replaceChildren(...nodes);
    r.log.scrollTop = r.log.scrollHeight;
  }

  function bannerInfo() {
    const s = state.status;
    const needs = s ? s.needs : 'key';
    if (!needs) return null;
    if (needs === 'url') return { title: t('ai.setup.urlTitle'), text: t('ai.setup.url'), button: t('ai.setup.fix') };
    if (needs === 'mismatch') return { title: t('ai.setup.mismatchTitle'), text: t('ai.setup.mismatch'), button: t('ai.setup.fix') };
    if (needs === 'model') return { title: t('ai.setup.modelTitle'), text: t('ai.setup.model'), button: t('ai.setup.fix') };
    if (needs === 'install') {
      const busy = VE.llmUI.busyLine();
      if (busy) return { title: t('ai.setup.installingTitle'), text: busy, button: t('ai.setup.fix'), icon: 'download' };
      return { title: t('ai.setup.installTitle'), text: t('ai.setup.install'), button: t('ai.setup.installBtn'), icon: 'download' };
    }
    return { title: t('ai.setup.title'), text: t('ai.setup.text'), button: t('ai.setup.button') };
  }

  function autosize() {
    r.input.style.height = 'auto';
    r.input.style.height = Math.min(r.input.scrollHeight, 110) + 'px';
  }

  function updateControls() {
    const on = ready();
    const canType = on && hasClips() && !state.running;
    r.input.disabled = !canType;
    r.input.placeholder = !on ? t(!state.status || state.status.needs === 'key' ? 'ai.placeholderOff' : 'ai.placeholderSetup') : (!hasClips() ? t('ai.placeholderEmpty') : t('ai.placeholder'));
    const sendBtn = r.send;
    sendBtn.classList.toggle('stop', state.running);
    VE.icons.set(sendBtn, state.running ? 'stop' : 'send');
    const label = t(state.running ? 'ai.stop' : 'ai.send');
    sendBtn.title = label;
    sendBtn.setAttribute('aria-label', label);
    sendBtn.disabled = state.running ? false : !(canType && r.input.value.trim());
    const showUndo = !!state.committed && sameList(S.segments, state.committed) && st.canUndo() && !state.running;
    r.undoRow.hidden = !showUndo;
  }

  function renderState() {
    const on = ready();
    r.state.textContent = state.running ? t('ai.state.busy') : t(on ? 'ai.state.ready' : 'ai.state.off');
    r.state.className = 'ai-state' + (state.running ? ' busy' : (on ? ' ready' : ''));
    r.btn.dataset.state = on ? 'ready' : 'off';
    r.btn.classList.toggle('off', !on);
    // "stop the model": only for the built-in model, and only while it is loaded or loading (it is not needed while a request is using it)
    const srv = state.status && state.status.provider === 'builtin' && state.status.builtin ? state.status.builtin.server : null;
    const loaded = !!srv && (srv.phase === 'ready' || srv.phase === 'starting');
    r.stopModel.hidden = !loaded;
    r.stopModel.disabled = state.running || (!!srv && srv.busy > 0);
    const banner = bannerInfo();
    r.banner.hidden = !banner;
    if (banner) {
      r.bannerTitle.textContent = banner.title;
      r.bannerText.textContent = banner.text;
      r.bannerLabel.textContent = banner.button;
      VE.icons.set(r.bannerIcon, banner.icon || 'key');
      VE.icons.set(r.bannerBtnIcon, banner.icon || 'key');
    }
  }

  function renderAll() {
    renderState();
    renderLog();
    updateControls();
  }

  /* ---------- pane ---------- */

  async function refresh() {
    try { state.status = await api.ai.status(); } catch (e) { state.status = null; }
    renderAll();
    maybeWarm();
  }

  // The built-in model is started in the background as soon as the pane is open and the model is installed (once per such period,
  // so that a model that cannot start is not retried in a loop).
  function maybeWarm() {
    const s = state.status;
    const can = state.open && !!s && s.provider === 'builtin' && s.ready;
    if (!can) { if (!state.open || !s || !s.ready) state.warmTried = false; return; }
    if (state.warmTried) return;
    state.warmTried = true;
    api.ai.warm();
  }

  // "Stop model" (header button): unloads the built-in model and frees its memory. The next command starts it again by itself, so the pane must
  // not start it again right away (maybeWarm) - it stays stopped until the pane is closed and opened again or a command needs it.
  async function stopModel() {
    r.stopModel.disabled = true;
    state.warmTried = true;
    let res = null;
    try { res = await api.llm.stop(); } catch (e) { res = null; }
    if (res && res.ok) VE.actions.toast(t('llm.stopped'), 'success', 2600);
    else VE.actions.toast(errorText(res && res.error ? res.error : { code: 'INTERNAL' }), 'warning');
    await refresh();
  }

  function open() {
    if (state.open) { r.input.focus(); return; }
    state.open = true;
    r.pane.hidden = false;
    r.inspector.inert = true;
    r.btn.setAttribute('aria-pressed', 'true');
    refresh().then(() => {
      if (!r.input.disabled) r.input.focus(); else if (!r.banner.hidden) r.bannerBtn.focus();
    });
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.warmTried = false;
    r.pane.hidden = true;
    r.inspector.inert = false;
    r.btn.setAttribute('aria-pressed', 'false');
  }

  function toggle() { if (state.open) close(); else open(); }

  /* ---------- running a request ---------- */

  function pushMessage(m) {
    state.messages.push(m);
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }

  function takeSnapshot() {
    return { segments: S.segments.map((s) => Object.assign({}, s)), exportSettings: Object.assign({}, S.exportSettings), playhead: S.playhead, selectedId: S.selectedId };
  }

  async function send(text) {
    const prompt = String(text == null ? r.input.value : text).trim();
    if (state.running || !prompt || !ready() || !hasClips()) return;
    open();
    pushMessage({ type: 'user', text: prompt });
    r.input.value = '';
    autosize();
    state.running = true;
    state.live = { actions: [], search: null, found: [], analysis: null, analyses: [] };
    const runId = ++state.runId;
    const base = S.segments;
    renderAll();
    const off = api.on('ai:step', (ev) => {
      if (!ev || ev.runId !== runId || !state.live) return;
      if (ev.kind === 'action') state.live.actions.push(ev.action);
      else if (ev.kind === 'reset') state.live.actions = [];
      else if (ev.kind === 'search') state.live.search = ev.phase === 'done' ? null : { object: ev.object, position: ev.position, phase: ev.phase, done: ev.done, total: ev.total };
      else if (ev.kind === 'found') state.live.found.push({ id: ev.id, label: ev.label, intervals: ev.intervals, frames: ev.frames, step: ev.step, seconds: ev.seconds });
      else if (ev.kind === 'analysis') {
        // Azure Content Understanding: progress (plan / prepare / upload / wait), then the scenes that were read
        if (ev.phase === 'done') { state.live.analysis = null; state.live.analyses.push({ count: ev.count, uploaded: ev.uploaded, range: ev.range, scenes: ev.scenes || [] }); } else if (ev.phase === 'failed') state.live.analysis = null;
        else state.live.analysis = Object.assign({}, state.live.analysis || {}, { phase: ev.phase, index: ev.index, parts: ev.parts, cached: ev.cached, fraction: ev.fraction, megabytes: ev.megabytes, elapsedMs: ev.elapsedMs });
      }
      renderLog();
    });
    // the model loading (llm:progress) and the search progress change the live card too
    const offLoad = VE.llmUI.onChange(() => { if (state.live) renderLog(); });
    let res;
    try {
      res = await api.ai.run({ runId, prompt, history: state.history.slice(), snapshot: takeSnapshot() });
    } catch (e) {
      res = { ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } };
    }
    off();
    offLoad();
    const analyses = state.live ? state.live.analyses : [];
    state.running = false;
    state.live = null;
    handleResult(res, prompt, base, analyses);
    renderAll();
    if (state.open && !r.input.disabled) r.input.focus();
  }

  function handleResult(res, prompt, base, analyses) {
    if (!res || !res.ok) {
      const error = (res && res.error) || { code: 'INTERNAL' };
      if (error.code === 'ABORTED') pushMessage({ type: 'info', text: t('ai.cancelled') });
      else pushMessage({ type: 'error', code: error.code, text: errorText(error), detail: error.detail || '', fix: isFixable(error.code) });
      return;
    }
    const stale = !sameList(S.segments, base);
    if (res.changed && stale) {
      pushMessage({ type: 'ai', text: res.message || '', actions: [], found: res.found || [], analyses, meta: null });
      pushMessage({ type: 'info', text: t('ai.stale') });
      return;
    }
    if (res.changed) {
      VE.actions.applyAi(res.segments);
      state.committed = S.segments;
    }
    if (res.exportChanged) VE.actions.applyExportSettings(res.exportSettings);
    const did = res.changed || res.exportChanged || (res.uiActions && res.uiActions.length);
    const text = res.message || t(did ? 'ai.applied' : 'ai.nothing');
    const tokens = res.usage ? (res.usage.input || 0) + (res.usage.output || 0) : 0;
    pushMessage({ type: 'ai', text, actions: res.actions || [], found: res.found || [], analyses, meta: tokens ? { n: res.iterations || 1, tokens } : null });
    state.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    if (res.uiActions && res.uiActions.includes('open_export')) setTimeout(() => VE.exportUI.open(), 0);
  }

  function cancel() {
    if (!state.running) return;
    api.ai.cancel(state.runId);
  }

  /* ---------- settings dialog ---------- */

  function openSettings() {
    api.ai.status().then((status) => { state.status = status; }, () => { state.status = null; }).then(() => {
      renderState();
      buildSettings(state.status || { provider: 'builtin', baseUrl: '', apiVersion: '', model: '', shareNames: true, hasKey: false, masked: '', encryptionAvailable: true, builtin: null });
    });
  }

  function buildSettings(status) {
    const row = (label, control) => [el('label', { text: label }), control];
    const provider = el('select', {}, PROVIDERS.map((p) => el('option', { value: p, text: t(PROV_KEYS[p]) })));
    provider.value = PROVIDERS.includes(status.provider) ? status.provider : 'builtin';
    const providerHint = el('div', { class: 'hint' });
    const url = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
    url.value = status.baseUrl || '';
    const find = el('button', { class: 'btn outline', type: 'button', text: t('aiset.discover') });
    const found = el('div', { class: 'ai-found', hidden: true });
    const version = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: '2024-10-21' });
    version.value = status.apiVersion || '';
    const models = el('datalist', { id: 'ai-models' });
    const model = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', list: 'ai-models' });
    model.value = status.model || '';
    const auth = el('select', {}, ['key', 'entra'].map((a) => el('option', { value: a, text: t(AUTH_KEYS[a]) })));
    auth.value = status.auth === 'entra' ? 'entra' : 'key';
    const authHint = el('div', { class: 'hint' });
    const key = el('input', { type: 'password', spellcheck: 'false', autocomplete: 'off', 'data-autofocus': true });
    const show = el('button', { class: 'btn icon', type: 'button' });
    VE.icons.set(show, 'eye');
    show.title = t('aiset.show');
    show.addEventListener('click', () => {
      const hidden = key.type === 'password';
      key.type = hidden ? 'text' : 'password';
      VE.icons.set(show, hidden ? 'eyeOff' : 'eye');
      show.title = t(hidden ? 'aiset.hide' : 'aiset.show');
    });
    const share = el('input', { type: 'checkbox' });
    share.checked = status.shareNames !== false;
    const result = el('div', { class: 'ai-result', hidden: true });
    const urlRow = row(t('aiset.endpoint'), el('div', { class: 'path-row' }, [url, find]));
    const verRow = row(t('aiset.apiVersion'), version);
    const modelLabel = el('label');
    const authRow = row(t('aiset.auth'), auth);
    const keyLabel = el('label');
    const keyRow = [keyLabel, el('div', { class: 'path-row' }, [key, show])];
    const keyHint = el('div', { class: 'hint' });
    const canEntra = () => provider.value === 'azure' || provider.value === 'foundry';
    const entra = () => canEntra() && auth.value === 'entra';
    const builtin = () => provider.value === 'builtin';

    // web edition: "entra" is an access token that is pasted like a key (there is no Azure CLI in a browser), so the key row stays
    const syncAuth = () => {
      const noKey = builtin();
      keyRow.forEach((n) => { n.hidden = noKey; });
      keyHint.hidden = noKey || !keyHint.textContent;
      keyLabel.textContent = t(entra() ? 'aiset.token' : (provider.value === 'local' ? 'aiset.keyOptional' : 'aiset.key'));
      authHint.hidden = !entra();
      authHint.textContent = entra() ? t('aiset.entraHint') : '';
      authHint.classList.remove('warn');
    };
    const syncProvider = () => {
      const p = provider.value;
      url.placeholder = URL_HINT[p];
      model.placeholder = MODEL_HINT[p];
      modelLabel.textContent = t(p === 'azure' || p === 'foundry' ? 'aiset.modelAzure' : 'aiset.model');
      providerHint.textContent = t(HINT_KEYS[p]);
      // the built-in model has no address, model name or key: it brings its own panel instead
      urlRow.forEach((n) => { n.hidden = builtin(); });
      modelLabel.hidden = model.hidden = builtin();
      verRow.forEach((n) => { n.hidden = p !== 'azure'; });
      authRow.forEach((n) => { n.hidden = !canEntra(); });
      find.hidden = p !== 'local';
      found.hidden = found.hidden || p !== 'local';
      builtinWrap.hidden = !builtin();
      // the panel sits right below the provider row, and only exists in the dialog while "built-in" is chosen
      if (builtin()) { if (!builtinWrap.isConnected) grid.after(builtinWrap); } else builtinWrap.remove();
      shareRow.hidden = builtin();
      note.innerHTML = t(builtin() ? 'llm.privacy' : 'aiset.privacy');
      if (!canEntra()) auth.value = 'key';
      syncAuth();
      syncCu(state.status || status);
    };
    const syncKey = (st2) => {
      key.placeholder = st2.hasKey ? '' : t(entra() ? 'aiset.tokenPlaceholder' : 'aiset.keyPlaceholder');
      keyHint.textContent = st2.hasKey ? t('aiset.keySaved', { mask: st2.masked }) : '';
      keyHint.hidden = builtin() || !st2.hasKey;
      if (clear) clear.hidden = builtin() || !st2.hasKey;
    };
    const say = (kind, text) => { result.hidden = !text; result.className = 'ai-result ' + kind; result.textContent = text || ''; };

    // the built-in model: install / progress / folder / graphics chip (see llmui.js)
    const refreshStatus = () => refresh();
    const builtinPanel = VE.llmUI.panel({
      getBuiltin: () => (state.status && state.status.builtin) || status.builtin,
      refresh: refreshStatus,
      ensureProvider: async () => {
        if (state.status && state.status.provider === 'builtin') return;
        const saved = await api.ai.save({ provider: 'builtin', shareNames: true });
        if (saved.ok) state.status = saved.status;
      },
      say,
      errorText,
    });
    const builtinWrap = el('div', { class: 'llm-wrap' }, [builtinPanel.node]);

    const grid = el('div', { class: 'form-grid' }, [
      ...row(t('aiset.provider'), provider),
      ...urlRow, ...verRow,
      modelLabel, model,
      ...authRow,
      ...keyRow,
    ]);
    const shareRow = el('label', { class: 'check' }, [share, el('span', { text: t('aiset.shareNames') })]);
    const note = el('div', { class: 'about-note' });
    note.innerHTML = t('aiset.privacy');
    const warn = el('div', { class: 'hint warn', text: t('aiset.keyWarn'), hidden: status.encryptionAvailable !== false });

    // ---- video analysis with Azure Content Understanding (Foundry provider only; off until switched on, every upload is confirmed in a native dialog)
    const cuSt = status.cu || {};
    const cuOn = el('input', { type: 'checkbox', 'data-ai': 'cu-enable' });
    cuOn.checked = !!cuSt.enabled;
    const cuEndpoint = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://RESOURCE.services.ai.azure.com', 'data-ai': 'cu-endpoint' });
    cuEndpoint.value = cuSt.endpoint || '';
    const cuAnalyzer = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'prebuilt-videoSearch', 'data-ai': 'cu-analyzer' });
    cuAnalyzer.value = cuSt.analyzer || 'prebuilt-videoSearch';
    const cuLocation = el('select', { 'data-ai': 'cu-location' }, CU_LOCATIONS.map((l) => el('option', { value: l, text: cuLocationText(l) })));
    cuLocation.value = CU_LOCATIONS.includes(cuSt.location) ? cuSt.location : 'geography';
    const cuDerived = el('div', { class: 'hint' });
    const cuCache = el('div', { class: 'hint' });
    const cuTest = el('button', { class: 'btn outline', type: 'button', text: t('aiset.cu.test'), 'data-ai': 'cu-test' });
    const cuClear = el('button', { class: 'btn outline danger-text', type: 'button', text: t('aiset.cu.clear'), 'data-ai': 'cu-clear' });
    const cuNote = el('div', { class: 'about-note' });
    cuNote.innerHTML = t('aiset.cu.privacy');
    const cuGrid = el('div', { class: 'cu-grid' }, [...row(t('aiset.cu.endpoint'), cuEndpoint), ...row(t('aiset.cu.analyzer'), cuAnalyzer), ...row(t('aiset.cu.location'), cuLocation)]);
    const cuDetails = el('div', { class: 'cu-details' }, [cuGrid, cuDerived, cuNote, el('div', { class: 'path-row' }, [cuTest, cuClear]), cuCache]);
    const cuWrap = el('div', { class: 'cu-wrap', 'data-ai': 'cu-section' }, [el('div', { class: 'ai-intro-title', text: t('aiset.cu.title') }), el('label', { class: 'check' }, [cuOn, el('span', { text: t('aiset.cu.enable') })]), cuDetails]);
    // display only (the main process derives the real address): what the Content Understanding address would be for the Foundry address typed above
    const deriveCuAddress = (typed) => {
      let u;
      try { u = new URL(String(typed || '').trim()); } catch (e) { return ''; }
      const host = u.hostname.toLowerCase();
      if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) return u.origin;
      if (u.protocol !== 'https:') return '';
      if (/\.(?:services\.ai|cognitiveservices)\.azure\.com$/.test(host)) return u.origin;
      const m = /^([a-z0-9-]+)\.openai\.azure\.com$/.exec(host);
      return m ? 'https://' + m[1] + '.services.ai.azure.com' : '';
    };
    const syncCu = (st2) => {
      const s2 = (st2 && st2.cu) || cuSt;
      cuWrap.hidden = provider.value !== 'foundry';
      cuDetails.hidden = !cuOn.checked;
      // while the video analysis is on, the note about what is sent says so
      if (!builtin()) note.innerHTML = t(provider.value === 'foundry' && cuOn.checked ? 'aiset.privacyCu' : 'aiset.privacy');
      const derived = deriveCuAddress(url.value) || (url.value.trim() ? '' : (s2.effectiveEndpoint || ''));
      cuDerived.textContent = cuEndpoint.value.trim() ? '' : t(derived ? 'aiset.cu.derived' : 'aiset.cu.derivedNone', { addr: derived });
      cuDerived.hidden = !cuDerived.textContent;
      const c = s2.cache || { files: 0, bytes: 0 };
      cuCache.textContent = t('aiset.cu.cache', { files: c.files, size: VE.util.formatBytes(c.bytes) });
      cuClear.disabled = !c.files;
    };
    cuOn.addEventListener('change', () => syncCu(state.status || status));
    cuEndpoint.addEventListener('input', () => syncCu(state.status || status));
    url.addEventListener('input', () => syncCu(state.status || status));
    cuTest.addEventListener('click', async () => {
      cuTest.disabled = true;
      say('busy', t('aiset.cu.testing'));
      let res;
      try { res = await api.ai.cuTest(); } catch (e) { res = { ok: false, error: { code: 'INTERNAL' } }; }
      cuTest.disabled = false;
      if (!res.ok) { say('err', errorText(res.error) + (res.error && res.error.detail ? ' (' + res.error.detail + ')' : '')); return; }
      if (!res.defaultsSet) { say('err', t('aiset.cu.noDefaults')); return; }
      say('ok', t('aiset.cu.testOk', { models: Object.keys(res.defaults).join(', ') }));
    });
    cuClear.addEventListener('click', async () => {
      const res = await api.ai.cuClearCache();
      if (res && res.status) { state.status = res.status; syncCu(res.status); }
      say('ok', t('aiset.cu.cleared', { n: res ? res.removed : 0 }));
    });

    const closeBtn = el('button', { class: 'btn outline', type: 'button', text: t('aiset.close') });
    closeBtn.addEventListener('click', () => VE.modal.close());
    const saveBtn = el('button', { class: 'btn primary', type: 'button', text: t('aiset.save') });
    const clear = el('button', { class: 'btn outline danger-text', type: 'button', text: t('aiset.clear') });
    syncProvider();
    syncKey(status);
    provider.addEventListener('change', () => { syncProvider(); syncKey(state.status || status); });
    auth.addEventListener('change', () => { syncAuth(); syncKey(state.status || status); });

    clear.addEventListener('click', async () => {
      const res = await api.ai.clearKey();
      if (res.status) { state.status = res.status; syncKey(res.status); renderAll(); }
      key.value = '';
      if (!res.ok) { say('err', errorText(res.error)); return; }
      say('ok', t('aiset.cleared'));
    });

    // "Find local servers": the main process asks a few loopback ports; a click on a result fills in the address and the model list.
    function pick(server) {
      url.value = server.url;
      models.replaceChildren(...server.models.map((m) => el('option', { value: m })));
      if (!server.models.includes(model.value)) model.value = server.models[0] || '';
    }
    find.addEventListener('click', async () => {
      find.disabled = true;
      say('busy', t('aiset.discovering'));
      let res;
      try { res = await api.ai.discover(); } catch (e) { res = { ok: false, error: { code: 'INTERNAL' } }; }
      find.disabled = false;
      found.replaceChildren();
      if (!res.ok) { found.hidden = true; say('err', errorText(res.error)); return; }
      if (!res.servers.length) { found.hidden = true; say('err', t('aiset.noneFound')); return; }
      say('ok', t('aiset.found', { n: res.servers.length }));
      res.servers.forEach((s) => {
        const b = el('button', { class: 'btn outline small', type: 'button', text: s.name + ' · ' + s.url.replace(/^http:\/\//, '') + ' · ' + t('aiset.nModels', { n: s.models.length }) });
        b.addEventListener('click', () => pick(s));
        found.append(b);
      });
      found.hidden = false;
      if (res.servers.length === 1) pick(res.servers[0]);
    });

    async function saveAndTest() {
      saveBtn.disabled = true; clear.disabled = true;
      say('busy', t('aiset.testing'));
      if (builtin()) {
        // nothing to type: save the choice, then start the model once to prove that it works on this computer
        const savedB = await api.ai.save({ provider: 'builtin', shareNames: true });
        saveBtn.disabled = false; clear.disabled = false;
        if (!savedB.ok) { say('err', errorText(savedB.error)); return; }
        state.status = savedB.status;
        renderAll();
        builtinPanel.update();
        if (savedB.status.needs === 'install') { say('ok', t('llm.saveNeedsInstall')); return; }
        say('busy', t('llm.starting'));
        saveBtn.disabled = true; clear.disabled = true;
        const started = await api.ai.test();
        saveBtn.disabled = false; clear.disabled = false;
        await refreshStatus();
        builtinPanel.update();
        if (!started.ok) { say('err', errorText(started.error) + (started.error && started.error.detail ? ' (' + started.error.detail + ')' : '')); return; }
        say('ok', t('llm.testOk', { backend: t(started.backend === 'vk' ? 'llm.backend.vkShort' : 'llm.backend.cpuShort') }));
        return;
      }
      const cuReq = provider.value === 'foundry' ? { enabled: cuOn.checked, endpoint: cuEndpoint.value, analyzer: cuAnalyzer.value, location: cuLocation.value } : undefined;
      const saved = await api.ai.save({ provider: provider.value, baseUrl: url.value, model: model.value, apiVersion: version.value, shareNames: share.checked, auth: auth.value, apiKey: key.value, cu: cuReq });
      // a rejected save keeps what was typed so it can be corrected; the secret leaves the DOM as soon as the main process has it
      if (!saved.ok) { say('err', errorText(saved.error)); saveBtn.disabled = false; clear.disabled = false; return; }
      key.value = '';
      state.status = saved.status;
      // the main process cleans the address up (portal "Target URI", project endpoint, ...): show what was really saved
      url.value = saved.status.baseUrl || '';
      model.value = saved.status.model || '';
      version.value = saved.status.apiVersion || '';
      if (saved.status.cu && saved.status.cu.available) {
        cuOn.checked = !!saved.status.cu.enabled;
        cuEndpoint.value = saved.status.cu.endpoint || '';
        cuAnalyzer.value = saved.status.cu.analyzer;
        cuLocation.value = saved.status.cu.location;
      }
      syncKey(saved.status);
      syncCu(saved.status);
      renderAll();
      // what to add to the result line about the video analysis: ready, or what is still missing
      const cuTail = () => {
        const c = saved.status.cu;
        if (!c || !c.available || !c.enabled) return '';
        return ' ' + (c.ready ? t('aiset.cu.ready') : cuNeedsText(c.needs));
      };
      if (saved.keyCleared) { say('err', t('aiset.keyCleared')); saveBtn.disabled = false; clear.disabled = false; return; }
      if (saved.status.needs === 'key') { say('ok', t('aiset.needKey')); saveBtn.disabled = false; clear.disabled = false; return; }
      const test = await api.ai.test();
      saveBtn.disabled = false; clear.disabled = false;
      if (!test.ok) {
        say('err', errorText(test.error) + (test.error && test.error.detail ? ' (' + test.error.detail + ')' : ''));
        return;
      }
      models.replaceChildren(...(test.models || []).map((m) => el('option', { value: m })));
      if (test.modelOk) say('ok', t('aiset.okModel') + cuTail());
      else if ((test.models || []).length) say('ok', t('aiset.okModels', { n: test.models.length }) + cuTail());
      else say('ok', t('aiset.okNoModel') + cuTail());
    }
    saveBtn.addEventListener('click', saveAndTest);
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAndTest(); } });

    const body = el('div', { style: { display: 'contents' } }, [providerHint, grid, found, models, keyHint, authHint, shareRow, warn, cuWrap, note, result]);
    syncProvider(); // again, now that the dialog has a place to put the built-in model's panel
    VE.modal.open({ title: t('aiset.title'), body, footer: [clear, el('span', { class: 'spacer' }), closeBtn, saveBtn], onClose: () => builtinPanel.destroy() });
  }

  /* ---------- wiring ---------- */

  function init() {
    ['ai-pane', 'ai-log', 'ai-input', 'ai-send', 'ai-undo-row', 'ai-undo', 'ai-state', 'ai-settings', 'ai-stop-model', 'ai-close', 'ai-banner', 'ai-banner-icon', 'ai-banner-title', 'ai-banner-text', 'ai-banner-btn', 'ai-banner-btn-icon', 'ai-banner-btn-label', 'btn-ai', 'inspector'].forEach((id) => {
      r[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
    });
    r.pane = r.aiPane; r.log = r.aiLog; r.input = r.aiInput; r.send = r.aiSend; r.undoRow = r.aiUndoRow; r.state = r.aiState;
    r.banner = r.aiBanner; r.bannerIcon = r.aiBannerIcon; r.bannerTitle = r.aiBannerTitle; r.bannerText = r.aiBannerText; r.bannerBtn = r.aiBannerBtn; r.bannerBtnIcon = r.aiBannerBtnIcon; r.bannerLabel = r.aiBannerBtnLabel;
    r.btn = r.btnAi;
    r.stopModel = r.aiStopModel;
    VE.llmUI.init();
    // download / verification progress and the model starting up are shown in the banner and in the live card
    VE.llmUI.onChange(() => { if (state.open) { renderState(); updateControls(); } });

    r.btn.addEventListener('click', toggle);
    r.aiClose.addEventListener('click', () => { close(); r.btn.focus(); });
    r.aiSettings.addEventListener('click', openSettings);
    r.aiStopModel.addEventListener('click', stopModel);
    r.bannerBtn.addEventListener('click', openSettings);
    r.send.addEventListener('click', () => { if (state.running) cancel(); else send(); });
    r.aiUndo.addEventListener('click', () => VE.actions.undo());
    r.input.addEventListener('input', () => { autosize(); updateControls(); });
    r.input.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } else if (e.key === 'Escape') { e.preventDefault(); close(); r.btn.focus(); } else if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); close(); r.btn.focus(); } else if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y') && !r.input.value) {
        // an empty box has no text to undo: Ctrl+Z / Ctrl+Y act on the timeline (e.g. to undo what the assistant just did)
        e.preventDefault();
        if (k === 'y' || e.shiftKey) VE.actions.redo(); else VE.actions.undo();
      }
    });
    st.bus.on('segments', () => { updateControls(); if (!state.messages.length && !state.live) renderLog(); });
    st.bus.on('history', updateControls);
    VE.i18n.onChange(renderAll);
    renderAll();
    refresh();
  }

  VE.ai = {
    init, open, close, toggle, send, cancel, refresh, openSettings,
    isOpen: () => state.open,
    isRunning: () => state.running,
    debug: () => ({ open: state.open, running: state.running, ready: ready(), status: state.status, messages: state.messages.map((m) => Object.assign({}, m)), history: state.history.slice() }),
  };
})();
