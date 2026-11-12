(function () {
  'use strict';
  // Foundry Local in the user interface: the panel of the AI settings dialog (is it installed, is it running, which model, download, the official places to get it).
  // The main process does all the work (src/main/foundry/); this file only shows its state.
  window.VE = window.VE || {};
  const { el, fmtNum } = VE.util;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const api = window.api;

  const state = { job: '', id: '', percent: 0 };
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* a broken listener must not stop the others */ } });
  const icon = (name) => { const n = el('span', { class: 'ai-ico' }); VE.icons.set(n, name); return n; };
  const size = (mb) => (mb >= 1024 ? fmtNum(mb / 1024, 1) + ' GB' : fmtNum(mb, 0) + ' MB');

  // 'fl:progress' events of the main process: which job is running and, for a download, how far it is
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.phase === 'start') { state.job = String(ev.job || ''); state.id = String(ev.id || ''); state.percent = 0; }
    else if (ev.phase === 'progress') { state.percent = Math.max(0, Math.min(100, Number(ev.percent) || 0)); }
    else if (ev.phase === 'end') { state.job = ''; state.id = ''; state.percent = 0; }
    notify();
  }

  function init() {
    api.on('fl:progress', onEvent);
  }

  // The panel shown in the settings dialog when "Foundry Local" is chosen.
  // opts: { getSavedModel() -> id, say(kind, text), errorText(error) }
  function panel(opts) {
    let status = null;
    let models = [];
    let listError = '';
    let loading = true;
    let selected = '';
    let busy = false;
    // The list starts from what is on this computer (`foundry cache list`, no network). The catalogue of everything that could be downloaded is asked for only
    // when the person presses "Show all models": Foundry Local then talks to Microsoft (and may fetch hardware components on its first run).
    let catalog = false;

    const mk = (role, cls, iconName) => {
      const b = el('button', { class: 'btn ' + cls, type: 'button', 'data-fl': role }, [icon(iconName), el('span', { class: 'lbl' })]);
      b.setLabel = (text) => { b.querySelector('.lbl').textContent = text; };
      return b;
    };
    const title = el('div', { class: 'llm-title', text: t('fl.title') });
    const intro = el('div', { class: 'hint', text: t('fl.intro') });
    const stateLine = el('div', { class: 'llm-state', 'data-fl': 'state' });

    // not installed: where to get it (official addresses only; main opens exactly these three)
    const cmd = el('input', { type: 'text', readonly: true, spellcheck: 'false', 'data-fl': 'command' });
    const getBtn = mk('get', 'primary', 'download');
    const docsBtn = mk('docs', 'outline', 'info');
    const installBox = el('div', { class: 'llm-wrap', 'data-fl': 'install' }, [
      el('div', { class: 'hint', text: t('fl.installHint') }),
      el('div', { class: 'form-grid' }, [el('label', { text: t('fl.command') }), cmd]),
      el('div', { class: 'llm-actions' }, [getBtn, docsBtn]),
    ]);

    // installed: the model
    const select = el('select', { 'data-fl': 'model' });
    const modelInfo = el('div', { class: 'hint', 'data-fl': 'info' });
    const modelWarn = el('div', { class: 'hint warn', 'data-fl': 'warn' });
    const bar = el('div', { class: 'llm-bar', hidden: true }, [el('i')]);
    const downloadBtn = mk('download', 'primary', 'download');
    const cancelBtn = mk('cancel', 'outline', 'close');
    const startBtn = mk('start', 'outline', 'power');
    const refreshBtn = mk('refresh', 'outline', 'reset');
    const catalogBtn = mk('catalog', 'outline', 'zoom');
    const catalogHint = el('div', { class: 'hint', 'data-fl': 'catalog-hint', text: t('fl.catalogHint') });
    const modelBox = el('div', { class: 'llm-wrap', 'data-fl': 'models' }, [
      el('div', { class: 'form-grid' }, [el('label', { text: t('fl.model') }), select]),
      modelInfo, modelWarn, bar,
      el('div', { class: 'llm-actions' }, [downloadBtn, cancelBtn, startBtn, refreshBtn, catalogBtn]),
      catalogHint,
    ]);
    const notice = el('div', { class: 'about-note', 'data-fl': 'notice' });
    notice.innerHTML = t('fl.notice');
    const node = el('div', { class: 'llm-panel', 'data-fl': 'panel' }, [title, intro, stateLine, installBox, modelBox, notice]);

    cmd.value = 'winget install Microsoft.FoundryLocal';
    getBtn.setLabel(t('fl.btn.get'));
    docsBtn.setLabel(t('fl.btn.docs'));
    cancelBtn.setLabel(t('fl.btn.cancel'));
    startBtn.setLabel(t('fl.btn.start'));
    refreshBtn.setLabel(t('fl.btn.refresh'));
    catalogBtn.setLabel(t('fl.btn.catalog'));

    const current = () => models.find((m) => m.id === selected) || null;

    function optionText(m) {
      return (m.recommended ? '★ ' : '') + (m.alias || m.id) + ' · ' + (m.device || '?') + (m.sizeMb ? ' · ' + size(m.sizeMb) : '') + (m.vision ? ' · ' + t('fl.vision') : '');
    }

    function fillSelect() {
      const downloaded = models.filter((m) => m.cached);
      const other = models.filter((m) => !m.cached);
      const group = (label, list) => (list.length ? el('optgroup', { label }, list.map((m) => el('option', { value: m.id, text: optionText(m) }))) : null);
      select.replaceChildren(...[group(t('fl.group.have'), downloaded), group(t('fl.group.catalog'), other)].filter(Boolean));
      if (selected && models.some((m) => m.id === selected)) select.value = selected;
    }

    // the saved model, else the best one that is already on this computer, else the recommended one (a choice the person made in this dialog stays)
    function pickInitial() {
      if (selected && models.some((m) => m.id === selected)) return;
      const saved = opts.getSavedModel();
      const first = (list) => (list.length ? list[0].id : '');
      selected = (models.some((m) => m.id === saved) ? saved : '')
        || first(models.filter((m) => m.cached && m.recommended)) || first(models.filter((m) => m.cached)) || first(models.filter((m) => m.recommended)) || first(models);
    }

    function render() {
      const running = state.job;
      const installed = !!(status && status.installed);
      let kind = 'warn';
      let text = '';
      if (loading && !status) { kind = 'busy'; text = t('fl.state.checking'); }
      else if (!installed) { kind = 'warn'; text = t('fl.state.missing'); }
      else if (status.running) { kind = 'ok'; text = t('fl.state.running', { addr: String(status.url || '').replace(/^http:\/\//, ''), version: status.version || '?' }); }
      else { kind = 'warn'; text = t('fl.state.stopped'); }
      if (running === 'download') { kind = 'busy'; text = t('fl.state.downloading', { id: state.id, pct: state.percent }); }
      else if (running === 'load') { kind = 'busy'; text = t('fl.state.loading'); }
      else if (running === 'start') { kind = 'busy'; text = t('fl.state.starting'); }
      else if (loading && installed) { kind = 'busy'; text = t('fl.state.listing'); }
      stateLine.className = 'llm-state ' + kind;
      stateLine.dataset.state = running || (loading ? 'checking' : (!installed ? 'missing' : (status.running ? 'running' : 'stopped')));
      stateLine.textContent = text;

      installBox.hidden = loading && !status ? true : installed;
      modelBox.hidden = !installed;
      bar.hidden = running !== 'download';
      if (running === 'download') bar.firstChild.style.width = state.percent + '%';

      const m = current();
      if (installed) fillSelect();
      select.disabled = !!running || busy || loading || !models.length;
      modelInfo.textContent = '';
      modelWarn.textContent = '';
      if (listError) modelWarn.textContent = opts.errorText({ code: listError });
      else if (m) {
        modelInfo.textContent = t(m.vision ? 'fl.info.vision' : 'fl.info.text', { device: m.device || '?', size: m.sizeMb ? size(m.sizeMb) : '?' }) + (m.cached ? ' · ' + t('fl.info.cached') : '');
        const warnings = [];
        if (!m.vision) warnings.push(t('fl.warn.noVision'));
        if (!m.cached) warnings.push(t('fl.warn.notCached', { size: m.sizeMb ? size(m.sizeMb) : '?' }));
        if (m.fits === false && status && !m.loaded) warnings.push(t('fl.warn.memory', { free: size(status.freeMemMb || 0) }));
        modelWarn.textContent = warnings.join(' ');
      } else if (!loading && installed) modelInfo.textContent = t(catalog ? 'fl.noModels' : 'fl.noCached');
      modelWarn.hidden = !modelWarn.textContent;
      modelInfo.hidden = !modelInfo.textContent;

      downloadBtn.hidden = !m || m.cached || !!running;
      downloadBtn.setLabel(t('fl.btn.download', { size: m && m.sizeMb ? size(m.sizeMb) : '' }));
      cancelBtn.hidden = running !== 'download';
      startBtn.hidden = !installed || !!(status && status.running) || !!running;
      refreshBtn.hidden = !installed;
      catalogBtn.hidden = !installed || catalog || !!running;
      catalogHint.hidden = catalogBtn.hidden;
      downloadBtn.disabled = startBtn.disabled = refreshBtn.disabled = catalogBtn.disabled = busy || loading;
    }

    async function load() {
      loading = true;
      listError = '';
      render();
      let s = null;
      try { s = await api.fl.status(); } catch (e) { s = null; }
      status = s && s.ok ? s.status : { installed: false, cliFound: false, running: false, url: '', version: '', freeMemMb: 0 };
      // the list that is shown stays until the new one has arrived (no flicker after a download or a test)
      let next = [];
      if (status.installed) {
        let r = null;
        try { r = await api.fl.models({ catalog }); } catch (e) { r = null; }
        if (r && r.ok) {
          // chat models only (Foundry Local also lists speech and embedding models)
          next = r.models.filter((m) => m.kind !== 'other');
          if (r.status) status = r.status;
        } else listError = (r && r.error && r.error.code) || 'FL_CLI_FAILED';
      }
      models = next;
      loading = false;
      pickInitial();
      render();
    }

    async function act(fn) {
      if (busy) return;
      busy = true;
      render();
      try { await fn(); } finally { busy = false; await load(); }
    }

    getBtn.addEventListener('click', () => { api.fl.openLink({ key: 'install' }); });
    docsBtn.addEventListener('click', () => { api.fl.openLink({ key: 'docs' }); });
    select.addEventListener('change', () => { selected = select.value; render(); });
    refreshBtn.addEventListener('click', () => act(async () => {}));
    catalogBtn.addEventListener('click', () => act(async () => { catalog = true; }));
    cancelBtn.addEventListener('click', () => { api.fl.cancel(); });
    startBtn.addEventListener('click', () => act(async () => {
      opts.say('busy', t('fl.state.starting'));
      const res = await api.fl.start();
      if (res.ok) opts.say('ok', t('fl.started')); else opts.say('err', opts.errorText(res.error) + (res.error && res.error.detail ? ' (' + res.error.detail + ')' : ''));
    }));
    downloadBtn.addEventListener('click', () => act(async () => {
      const m = current();
      if (!m) return;
      opts.say('busy', t('fl.downloading', { id: m.alias || m.id }));
      const res = await api.fl.download({ id: m.id });
      if (res.ok) opts.say('ok', t('fl.downloaded'));
      else if (res.error && res.error.code === 'FL_ABORTED') opts.say('', t('fl.cancelled'));
      else opts.say('err', opts.errorText(res.error) + (res.error && res.error.detail ? ' (' + res.error.detail + ')' : ''));
    }));

    const listener = () => render();
    listeners.add(listener);
    load();
    return {
      node,
      update: load,
      render,
      getModel: () => selected,
      isCached: () => { const m = current(); return !!m && m.cached; },
      destroy() { listeners.delete(listener); },
    };
  }

  VE.flUI = { init, panel, state, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
})();
