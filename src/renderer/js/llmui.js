(function () {
  'use strict';
  // The built-in local model in the user interface: the panel of the AI settings dialog (install, progress, folder, graphics chip / CPU, remove)
  // and the texts of the banner. The main process does all the work (see src/main/llm/ipc.js); this file only shows its state.
  window.VE = window.VE || {};
  const { el, fmtNum } = VE.util;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const api = window.api;

  const state = { progress: null, loading: false, loadError: null };
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* a broken listener must not stop the others */ } });

  const pct = (done, total) => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) + '%' : '0%');
  const gb = (n) => (n >= 1073741824 ? fmtNum(n / 1073741824, 1) + ' GB' : fmtNum(n / 1048576, 0) + ' MB');
  const rate = (n) => (n > 0 ? gb(n) + '/' + t('llm.sec') : '');
  const icon = (name) => { const n = el('span', { class: 'ai-ico' }); VE.icons.set(n, name); return n; };

  // events of the main process: download / verification progress, model start-up
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.phase === 'download' || ev.phase === 'verify') state.progress = ev;
    else if (ev.phase === 'done' || ev.phase === 'error') state.progress = null;
    else if (ev.phase === 'loading') { state.loading = true; state.loadError = null; }
    else if (ev.phase === 'loaded') state.loading = false;
    else if (ev.phase === 'stopped') state.loading = false; // stopped by the user, by the idle time-out or by a crash
    else if (ev.phase === 'load-error') { state.loading = false; state.loadError = ev.error || null; }
    notify();
    if (ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'loaded' || ev.phase === 'load-error' || ev.phase === 'stopped') {
      if (VE.ai && VE.ai.refresh) VE.ai.refresh();
    }
  }

  function init() {
    api.on('llm:progress', onEvent);
  }

  // What is going on right now with the model, as one line (null when nothing). Used by the banner of the assistant pane.
  function busyLine() {
    const p = state.progress;
    if (p && p.phase === 'download') return t('llm.state.download', { pct: pct(p.done, p.total), done: gb(p.done), total: gb(p.total), speed: rate(p.bytesPerSec) }).replace(/ · $/, '');
    if (p && p.phase === 'verify') return t('llm.state.verify', { pct: pct(p.done, p.total) });
    if (state.loading) return t('llm.state.loading');
    return null;
  }

  // The panel shown in the settings dialog when "built-in model" is chosen.
  // opts: { getBuiltin() -> llm status, refresh() -> Promise, ensureProvider() -> Promise, say(kind, text), errorText(error) }
  function panel(opts) {
    const title = el('div', { class: 'llm-title' });
    const stateLine = el('div', { class: 'llm-state', 'data-llm': 'state' });
    const bar = el('div', { class: 'llm-bar', hidden: true }, [el('i')]);
    const mk = (role, cls, iconName, key) => {
      const b = el('button', { class: 'btn ' + cls, type: 'button', 'data-llm': role }, [icon(iconName), el('span', { class: 'lbl' })]);
      b.setLabel = (text) => { b.querySelector('.lbl').textContent = text; };
      b.setLabel(t(key));
      return b;
    };
    const install = mk('install', 'primary', 'download', 'llm.btn.install');
    const verify = mk('verify', 'outline', 'checkCircle', 'llm.btn.verify');
    const cancel = mk('cancel', 'outline', 'close', 'llm.btn.cancel');
    const remove = mk('remove', 'outline danger-text', 'trash', 'llm.btn.remove');
    const stopBtn = mk('stop', 'outline', 'power', 'llm.btn.stop');
    const actions = el('div', { class: 'llm-actions' }, [install, verify, cancel, stopBtn, remove]);

    const dir = el('input', { type: 'text', readonly: true, spellcheck: 'false', 'data-llm': 'dir' });
    const pick = el('button', { class: 'btn outline', type: 'button', 'data-llm': 'pick', text: t('llm.btn.pick') });
    const reset = el('button', { class: 'btn outline', type: 'button', 'data-llm': 'default', text: t('llm.btn.default') });
    const BACKEND_KEYS = { auto: 'llm.backend.auto', vk: 'llm.backend.vk', cpu: 'llm.backend.cpu' };
    const backend = el('select', { 'data-llm': 'backend' }, ['auto', 'vk', 'cpu'].map((b) => el('option', { value: b, text: t(BACKEND_KEYS[b]) })));
    const idle = el('input', { type: 'number', min: '0', max: '240', step: '1', 'data-llm': 'idle' });
    const grid = el('div', { class: 'form-grid' }, [
      el('label', { text: t('llm.dir') }), el('div', { class: 'path-row' }, [dir, pick, reset]),
      el('label', { text: t('llm.backend') }), backend,
      el('label', { text: t('llm.idle') }), el('div', { class: 'path-row' }, [idle, el('span', { class: 'hint', text: t('llm.idleHint') })]),
    ]);
    const facts = el('div', { class: 'hint' });
    const runLine = el('div', { class: 'hint', 'data-llm': 'run' });
    const notice = el('div', { class: 'about-note', text: t('llm.notice') });
    const node = el('div', { class: 'llm-panel', 'data-llm': 'panel' }, [title, stateLine, bar, actions, grid, runLine, facts, notice]);
    let busyAction = false;

    function render() {
      const b = opts.getBuiltin();
      if (!b) return;
      const m = b.model;
      const p = state.progress;
      const running = p && (p.phase === 'download' || p.phase === 'verify') ? p.phase : (m.busy || null);
      title.textContent = m.name + ' · ' + m.license + ' · ' + gb(m.total);
      let kind = 'warn';
      let text = '';
      let ratio = null;
      if (running === 'download') {
        const q = p && p.phase === 'download' ? p : (m.progress || { done: 0, total: m.total, bytesPerSec: 0 });
        kind = 'busy';
        text = t('llm.state.download', { pct: pct(q.done, q.total), done: gb(q.done), total: gb(q.total), speed: rate(q.bytesPerSec) }).replace(/ · $/, '');
        ratio = q.total > 0 ? q.done / q.total : 0;
      } else if (running === 'verify') {
        const q = p && p.phase === 'verify' ? p : (m.progress || { done: 0, total: m.total });
        kind = 'busy';
        text = t('llm.state.verify', { pct: pct(q.done, q.total) });
        ratio = q.total > 0 ? q.done / q.total : 0;
      } else if (state.loading) {
        kind = 'busy';
        text = t('llm.state.loading');
      } else if (m.state === 'ready') { kind = 'ok'; text = t('llm.state.ready'); }
      else if (m.state === 'unverified') { kind = 'warn'; text = t('llm.state.unverified'); }
      else if (m.state === 'partial') { kind = 'warn'; text = t('llm.state.partial', { pct: pct(m.have, m.total) }); }
      else if (m.state === 'bad') { kind = 'err'; text = t('llm.state.bad'); }
      else { kind = 'warn'; text = t('llm.state.missing'); }
      stateLine.className = 'llm-state ' + kind;
      stateLine.dataset.state = running || (state.loading ? 'loading' : m.state);
      stateLine.textContent = text;
      bar.hidden = ratio === null;
      if (ratio !== null) bar.firstChild.style.width = Math.round(ratio * 100) + '%';

      const needsDownload = m.state === 'missing' || m.state === 'partial' || m.state === 'bad';
      install.hidden = !needsDownload || !!running;
      install.setLabel(m.state === 'partial' ? t('llm.btn.resume') : (m.state === 'bad' ? t('llm.btn.reinstall', { size: gb(m.total) }) : t('llm.btn.install', { size: gb(m.total) })));
      verify.hidden = m.state !== 'unverified' || !!running;
      cancel.hidden = !running;
      remove.hidden = m.state === 'missing' || !!running;
      install.disabled = verify.disabled = remove.disabled = busyAction;

      dir.value = b.dir;
      dir.title = b.dir;
      reset.hidden = !b.customDir;
      pick.disabled = reset.disabled = !!running || busyAction;
      backend.value = b.backend;
      backend.options[1].disabled = !b.runtime.vk;
      backend.options[2].disabled = !b.runtime.cpu;
      if (document.activeElement !== idle) idle.value = String(b.idleMinutes);

      const srv = b.server;
      stopBtn.hidden = !(srv.phase === 'ready' || srv.phase === 'starting') || !!running;
      stopBtn.disabled = busyAction || srv.busy > 0;
      const gpu = srv.detectedGpu && srv.detectedGpu.length ? ' · ' + srv.detectedGpu[0] : '';
      runLine.hidden = srv.phase !== 'ready';
      runLine.textContent = srv.phase === 'ready' ? t('llm.running', { backend: t(srv.backend === 'vk' ? 'llm.backend.vkShort' : 'llm.backend.cpuShort') + gpu }) + (srv.fallbackFrom ? ' · ' + t('llm.fellBack') : '') : '';
      facts.textContent = t('llm.facts', { gb: m.needsRamGb, have: b.ramGb, license: m.license });
    }

    async function act(fn) {
      if (busyAction) return;
      busyAction = true;
      render();
      try { await fn(); } finally { busyAction = false; await opts.refresh(); render(); }
    }

    install.addEventListener('click', () => act(async () => {
      await opts.ensureProvider(); // choosing "download" also chooses this provider
      opts.say('busy', t('llm.installing'));
      const res = await api.llm.install();
      if (res.ok) opts.say('ok', t('llm.installed'));
      else if (res.error && res.error.code === 'ABORTED') opts.say('', t('llm.cancelled'));
      else opts.say('err', opts.errorText(res.error) + (res.error && res.error.detail ? ' (' + res.error.detail + ')' : ''));
    }));
    verify.addEventListener('click', () => act(async () => {
      await opts.ensureProvider();
      opts.say('busy', t('llm.verifying'));
      const res = await api.llm.install(); // the same call: nothing is downloaded for files that are already there, they are only checked
      if (res.ok) opts.say('ok', t('llm.installed'));
      else opts.say('err', opts.errorText(res.error) + (res.error && res.error.detail ? ' (' + res.error.detail + ')' : ''));
    }));
    cancel.addEventListener('click', () => { api.llm.cancel(); });
    stopBtn.addEventListener('click', () => act(async () => {
      const res = await api.llm.stop();
      if (res.ok) opts.say('ok', t('llm.stopped')); else opts.say('err', opts.errorText(res.error));
    }));
    remove.addEventListener('click', async () => {
      const choice = await api.messageBox({ type: 'question', title: t('app.title'), message: t('llm.removeAsk'), detail: t('llm.removeDetail'), buttons: [t('llm.btn.remove'), t('aiset.close')], defaultId: 1, cancelId: 1 });
      if (choice !== 0) return;
      act(async () => {
        const res = await api.llm.remove();
        if (res.ok) opts.say('ok', t('llm.removed')); else opts.say('err', opts.errorText(res.error));
      });
    });
    pick.addEventListener('click', () => act(async () => {
      const chosen = await api.llm.pickDir();
      if (!chosen || !chosen.path) return;
      const res = await api.llm.set({ modelDir: chosen.path });
      if (!res.ok) opts.say('err', opts.errorText(res.error)); else opts.say('ok', t('llm.dirSet'));
    }));
    reset.addEventListener('click', () => act(async () => {
      const res = await api.llm.set({ modelDir: '' });
      if (!res.ok) opts.say('err', opts.errorText(res.error));
    }));
    backend.addEventListener('change', () => act(async () => {
      const res = await api.llm.set({ backend: backend.value });
      if (!res.ok) opts.say('err', opts.errorText(res.error)); else opts.say('ok', t('llm.backendSet'));
    }));
    idle.addEventListener('change', () => act(async () => {
      const res = await api.llm.set({ idleMinutes: Number(idle.value) });
      if (!res.ok) opts.say('err', opts.errorText(res.error));
    }));

    const listener = () => render();
    listeners.add(listener);
    render();
    return { node, update: render, destroy() { listeners.delete(listener); } };
  }

  VE.llmUI = { init, panel, busyLine, state, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
})();
