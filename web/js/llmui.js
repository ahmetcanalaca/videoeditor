(function () {
  'use strict';
  // The built-in model in the WEB edition: it does not run in the page. The "Local AI" helper (web/local-ai/) downloads the model once, checks it, and
  // serves it on this computer (127.0.0.1) - the same model and the same llama.cpp as the desktop app. This panel of the AI settings dialog guides through
  // getting it running and pairing the page with it. (The desktop version of this file manages the download itself, see src/renderer/js/llmui.js.)
  window.VE = window.VE || {};
  const { el, fmtNum } = VE.util;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const api = window.api;

  const state = { progress: null, loading: false, loadError: null };
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* a broken listener must not stop the others */ } });
  const gb = (n) => (n >= 1073741824 ? fmtNum(n / 1073741824, 1) + ' GB' : (n >= 1048576 ? fmtNum(n / 1048576, 0) + ' MB' : fmtNum(n / 1024, 0) + ' KB'));
  const icon = (name) => { const n = el('span', { class: 'ai-ico' }); VE.icons.set(n, name); return n; };

  function init() { /* nothing is downloaded or started by the page: there are no progress events */ }

  // What is going on right now with the model, as one line (null when nothing): the banner of the assistant pane shows it
  function busyLine() { return null; }

  // Information about the helper download (written by scripts/build.js): { version, zip: { name, bytes, sha256 }, script: { name, sha256 } }
  let infoPromise = null;
  function helperInfo() {
    if (!infoPromise) {
      infoPromise = fetch(new URL('local-ai/info.json', document.baseURI).href, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    return infoPromise;
  }

  // opts: { getBuiltin() -> status.builtin, refresh() -> Promise, ensureProvider() -> Promise, say(kind, text), errorText(error) }
  function panel(opts) {
    const title = el('div', { class: 'llm-title' });
    const stateLine = el('div', { class: 'llm-state', 'data-llm': 'state' });
    const mk = (role, cls, iconName, key) => {
      const b = el('button', { class: 'btn ' + cls, type: 'button', 'data-llm': role }, [icon(iconName), el('span', { class: 'lbl' })]);
      b.setLabel = (text) => { b.querySelector('.lbl').textContent = text; };
      b.setLabel(t(key));
      return b;
    };
    const download = el('a', { class: 'btn primary', 'data-llm': 'download', href: new URL('local-ai/VideoEditor-LocalAI.zip', document.baseURI).href, download: 'VideoEditor-LocalAI.zip' }, [icon('download'), el('span', { class: 'lbl', text: t('web.llm.download') })]);
    const test = mk('test', 'outline', 'checkCircle', 'web.llm.test');
    const forget = mk('forget', 'outline danger-text', 'trash', 'web.llm.forget');
    const actions = el('div', { class: 'llm-actions' }, [download, test, forget]);
    const steps = el('ol', { class: 'llm-steps' }, [1, 2, 3].map((n) => el('li', { 'data-llm': 'step' + n })));
    const hash = el('div', { class: 'hint llm-hash', 'data-llm': 'hash', hidden: true });
    const port = el('input', { type: 'number', min: '1024', max: '65535', step: '1', 'data-llm': 'port', placeholder: '8473' });
    const key = el('input', { type: 'password', spellcheck: 'false', autocomplete: 'off', 'data-llm': 'key', placeholder: t('web.llm.keyPlaceholder') });
    const connect = el('button', { class: 'btn outline', type: 'button', 'data-llm': 'connect', text: t('web.llm.connect') });
    const manual = el('details', { class: 'llm-manual' }, [
      el('summary', { text: t('web.llm.manual') }),
      el('div', { class: 'form-grid' }, [el('label', { text: t('web.llm.port') }), port, el('label', { text: t('web.llm.key') }), el('div', { class: 'path-row' }, [key, connect])]),
    ]);
    const facts = el('div', { class: 'hint' });
    const notice = el('div', { class: 'about-note', text: t('web.llm.notice') });
    const node = el('div', { class: 'llm-panel', 'data-llm': 'panel' }, [title, stateLine, actions, steps, hash, manual, facts, notice]);
    let busyAction = false;

    function render() {
      const b = opts.getBuiltin();
      if (!b) return;
      const m = b.model;
      title.textContent = m.name + ' · ' + m.license + ' · ' + gb(m.total);
      let kind = 'warn';
      let text = t('web.llm.state.none');
      let shown = b.paired ? b.connection : 'none';
      if (b.paired) {
        if (b.connection === 'ready') { kind = 'ok'; text = t('web.llm.state.ready', { port: b.port, model: b.served || m.name }); } else if (b.connection === 'unreachable') {
          kind = 'err';
          // the browser's own "local network access" refusal is told apart from "the helper is not running"
          if (b.lna === 'denied') { text = t('web.llm.state.blocked'); shown = 'blocked'; } else text = t('web.llm.state.unreachable', { port: b.port });
        } else if (b.connection === 'unauthorized') { kind = 'err'; text = t('web.llm.state.unauthorized'); } else { kind = 'warn'; text = t('web.llm.state.paired', { port: b.port }); }
      }
      stateLine.className = 'llm-state ' + kind;
      stateLine.dataset.state = shown;
      stateLine.textContent = text;
      steps.children[0].textContent = t('web.llm.step1', { size: gb(m.total) });
      steps.children[1].textContent = t('web.llm.step2');
      steps.children[2].textContent = t('web.llm.step3');
      test.hidden = !b.paired;
      forget.hidden = !b.paired;
      test.disabled = forget.disabled = connect.disabled = busyAction;
      if (document.activeElement !== port) port.value = b.paired ? String(b.port) : (port.value || '');
      port.placeholder = String(b.defaultPort || 8473);
      facts.textContent = t('web.llm.facts', { gb: m.needsRamGb });
    }

    helperInfo().then((info) => {
      if (!info || !info.zip) return;
      hash.hidden = false;
      hash.textContent = t('web.llm.hash', { name: info.zip.name, size: gb(info.zip.bytes), sha: info.zip.sha256 });
      // links to the readable source of the helper and to the explanation of how to check where the download was built (https only; new tab)
      const link = (href, key, label) => {
        if (typeof href !== 'string' || !/^https:\/\/[a-z0-9.-]+\//i.test(href)) return;
        hash.appendChild(document.createTextNode(' · '));
        hash.appendChild(el('a', { href, target: '_blank', rel: 'noopener noreferrer', 'data-llm': key, text: t(label) }));
      };
      link(info.source, 'source', 'web.llm.source');
      link(info.verify, 'verify', 'web.llm.verify');
    });

    async function act(fn) {
      if (busyAction) return;
      busyAction = true;
      render();
      try { await fn(); } finally { busyAction = false; await opts.refresh(); render(); }
    }

    async function runTest() {
      await opts.ensureProvider();
      opts.say('busy', t('web.llm.testing'));
      const res = await api.ai.test();
      if (res.ok) opts.say('ok', t('web.llm.testOk', { model: (res.models && res.models[0]) || '' }));
      else opts.say('err', opts.errorText(res.error) + (res.error && res.error.detail ? ' (' + res.error.detail + ')' : ''));
    }

    test.addEventListener('click', () => act(runTest));
    forget.addEventListener('click', () => act(async () => {
      const res = await api.llm.forget();
      if (res.ok) opts.say('ok', t('web.llm.forgotten')); else opts.say('err', opts.errorText(res.error));
    }));
    connect.addEventListener('click', () => act(async () => {
      const res = await api.llm.pair({ port: Number(port.value) || 0, key: key.value });
      key.value = '';
      if (!res.ok) { opts.say('err', opts.errorText(res.error)); return; }
      await runTest();
    }));
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect.click(); } });

    const listener = () => render();
    listeners.add(listener);
    render();
    return { node, update: render, destroy() { listeners.delete(listener); } };
  }

  VE.llmUI = { init, panel, busyLine, state, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
})();
