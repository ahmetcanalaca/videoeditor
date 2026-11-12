(function () {
  'use strict';
  // The setup panel of Foundry Local in the settings dialog of the web edition: four steps that turn green by themselves while the person works through them -
  // the browser extension (installed, current), the permission for this site, Foundry Local itself (found), and a model (loaded; does it see pictures?).
  // It only shows what api.fl (js/web/ai/ai-api.js) reports and asks it to act; the extension and Foundry Local are never reached from here directly.
  window.VE = window.VE || {};
  const { el } = VE.util;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const api = window.api;

  const POLL_MS = 3000;
  const ZIP = 'extension/video-editor-foundry-bridge.zip';
  // where the SHA-256 of the zip is also published: the release notes on GitHub, not this site - so a zip that was swapped on the site does not match
  const RELEASE = 'https://github.com/ahmetcanalaca/videoeditor/releases/tag/foundry-bridge-v1.0.0';
  const DEFAULT_MODEL = 'qwen3.5-4b';
  const CMD = { install: 'winget install Microsoft.FoundryLocal', start: 'foundry server start', port: 'foundry config set port 5272', hash: 'Get-FileHash .\\video-editor-foundry-bridge.zip -Algorithm SHA256' };
  const icon = (name) => { const n = el('span', { class: 'ai-ico' }); VE.icons.set(n, name); return n; };

  // opts: { getSavedModel() -> id, say(kind, text), errorText(error) -> text, onUsed(status) }
  function panel(opts) {
    const st = { s: null, busy: '', touched: false, last: null, polling: 0 };

    const btn = (role, cls, iconName, label) => {
      const b = el('button', { class: 'btn ' + cls, type: 'button', 'data-fl': role }, [iconName ? icon(iconName) : null, el('span', { class: 'lbl', text: label })]);
      b.setLabel = (text) => { b.querySelector('.lbl').textContent = text; };
      return b;
    };
    // a command the person types into a command prompt, with a button that copies it
    const command = (text) => {
      const code = el('code', { class: 'flw-code', text });
      const copy = el('button', { class: 'btn outline small', type: 'button', text: t('flw.copy') });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); copy.textContent = t('flw.copied'); } catch (e) { copy.textContent = t('flw.copyFailed'); }
        setTimeout(() => { copy.textContent = t('flw.copy'); }, 1600);
      });
      return el('span', { class: 'flw-cmd' }, [code, copy]);
    };
    const step = (n, key) => {
      const status = el('span', { class: 'st' });
      const body = el('div', { class: 'flw-body' });
      const node = el('div', { class: 'flw-step', 'data-fl-step': key, 'data-state': 'off' }, [
        el('span', { class: 'flw-num', text: String(n) }),
        el('div', { class: 'flw-head' }, [el('span', { class: 'ti', text: t('flw.step.' + key) }), status]),
        body,
      ]);
      return { node, status, body, set(state, text) { node.dataset.state = state; status.textContent = text || ''; } };
    };

    /* ---- 1: the extension */
    const s1 = step(1, 'ext');
    const download = el('a', { class: 'btn primary', href: ZIP, download: '', 'data-fl': 'download' }, [icon('download'), el('span', { class: 'lbl', text: t('flw.ext.download') })]);
    const how = el('details', { class: 'flw-how', 'data-fl': 'how' }, [
      el('summary', { text: t('flw.ext.how') }),
      el('ol', {}, [
        el('li', { text: t('flw.ext.how1') }),
        el('li', {}, [el('span', { text: t('flw.ext.how2') + ' ' }), command('edge://extensions'), el('span', { text: ' · ' }), command('chrome://extensions')]),
        el('li', { text: t('flw.ext.how3') }),
        el('li', { text: t('flw.ext.how4') }),
      ]),
      el('div', { class: 'hint', text: t('flw.ext.policy') }),
    ]);
    s1.body.append(
      el('div', { class: 'llm-actions' }, [download]), how, el('div', { class: 'hint', text: t('flw.ext.safe') }),
      el('div', { class: 'flw-line' }, [el('span', { class: 'hint', text: t('flw.ext.check') + ' ' }), command(CMD.hash), el('a', { class: 'flw-link', href: RELEASE, target: '_blank', rel: 'noopener noreferrer', 'data-fl': 'release', text: t('flw.ext.release') })]),
    );

    /* ---- 2: the permission of this site */
    const s2 = step(2, 'allow');
    const allowBtn = btn('allow', 'primary', 'checkCircle', t('flw.allow.btn'));
    s2.body.append(el('div', { class: 'hint', text: t('flw.allow.text') }), el('div', { class: 'llm-actions' }, [allowBtn]));

    /* ---- 3: Foundry Local */
    const s3 = step(3, 'server');
    const recheck = btn('recheck', 'outline', 'reset', t('flw.server.recheck'));
    const scan = btn('scan', 'outline', 'zoom', t('flw.server.scan'));
    s3.body.append(
      el('div', { class: 'flw-line' }, [el('span', { class: 'hint', text: t('flw.server.install') + ' ' }), command(CMD.install), el('a', { class: 'flw-link', href: 'https://aka.ms/foundry-local-installer', target: '_blank', rel: 'noopener noreferrer', text: t('flw.server.official') })]),
      el('div', { class: 'flw-line' }, [el('span', { class: 'hint', text: t('flw.server.start') + ' ' }), command(CMD.start)]),
      el('div', { class: 'llm-actions' }, [recheck, scan]),
      el('div', { class: 'hint', text: t('flw.server.scanHint') }),
      el('div', { class: 'flw-line' }, [el('span', { class: 'hint', text: t('flw.server.fix') + ' ' }), command(CMD.port)]),
      el('div', { class: 'hint', text: t('flw.server.popup') }),
    );

    /* ---- 4: the model */
    const s4 = step(4, 'model');
    const model = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', list: 'flw-models', placeholder: DEFAULT_MODEL, 'data-fl': 'model' });
    const list = el('datalist', { id: 'flw-models' });
    const use = btn('use', 'primary', 'checkCircle', t('flw.model.use'));
    const loadedLine = el('div', { class: 'hint', 'data-fl': 'loaded' });
    const dlCmdHolder = el('div', { class: 'flw-line', 'data-fl': 'download-cmd', hidden: true });
    const vision = el('div', { class: 'llm-state', 'data-fl': 'vision', hidden: true });
    s4.body.append(
      el('div', { class: 'path-row' }, [model, use]), list, el('div', { class: 'hint', text: t('flw.model.hint') }), loadedLine, dlCmdHolder, vision,
    );

    const notice = el('div', { class: 'about-note', 'data-fl': 'notice' });
    notice.innerHTML = t('flw.notice');
    const node = el('div', { class: 'llm-panel flw-panel', 'data-fl': 'panel' }, [
      el('div', { class: 'llm-title', text: t('flw.title') }),
      el('div', { class: 'hint', text: t('flw.intro') }),
      el('div', { class: 'flw-steps' }, [s1.node, s2.node, s3.node, s4.node]),
      notice,
    ]);

    /* ---- what the steps show */

    function render() {
      const s = st.s;
      const b = s && s.bridge;
      const loading = !s;
      const present = !!(b && b.present);
      const extOk = present && b.compatible;
      const allowOk = extOk && b.approved;
      const found = allowOk && !!s.found;
      const busy = !!st.busy;

      if (loading) s1.set('busy', t('flw.checking'));
      else if (extOk) s1.set('ok', t('flw.ext.ok', { v: b.version }));
      else if (present) s1.set('warn', t('flw.ext.old', { v: b.version || '?', min: s.minVersion }));
      else s1.set('todo', t('flw.ext.missing'));
      s1.body.hidden = loading || extOk;

      if (!extOk) s2.set('off', '');
      else if (st.busy === 'allow') s2.set('busy', t('flw.allow.waiting'));
      else s2.set(allowOk ? 'ok' : 'todo', allowOk ? t('flw.allow.ok') : t('flw.allow.todo'));
      s2.body.hidden = !extOk || allowOk;
      allowBtn.disabled = busy;

      if (!allowOk) s3.set('off', '');
      else if (st.busy === 'scan') s3.set('busy', t('flw.server.scanning'));
      else if (found) s3.set('ok', t('flw.server.ok', { addr: String(s.base).replace(/^http:\/\//, '') }));
      else s3.set('todo', t('flw.server.missing'));
      s3.body.hidden = !allowOk || found;
      recheck.disabled = scan.disabled = busy;
      scan.setLabel(t(st.busy === 'scan' ? 'flw.server.scanning' : 'flw.server.scan'));

      const loaded = found ? s.loaded : [];
      const sv = opts.getStatus ? opts.getStatus() : null;
      const cur = sv && sv.provider === 'foundrylocal' && sv.model ? sv : null;
      if (!found) s4.set('off', '');
      else if (st.busy === 'use') s4.set('busy', t('flw.model.using'));
      else if (st.last && st.last.ok) s4.set('ok', st.last.modelId);
      else if (cur && loaded.includes(cur.model)) s4.set('ok', cur.model); // the model that is set up is loaded: nothing left to do
      else s4.set('todo', loaded.length ? t('flw.model.loadedShort', { n: loaded.length }) : t('flw.model.none'));
      s4.body.hidden = !found;
      use.disabled = busy || !model.value.trim();
      model.disabled = busy;
      loadedLine.textContent = loaded.length ? t('flw.model.loaded', { ids: loaded.join(', ') }) : '';
      loadedLine.hidden = !loaded.length;

      if (found) {
        // the suggestions: the recommended aliases first (an alias lets Foundry Local pick the variant that suits this computer), then every id of its catalogue
        const names = [];
        for (const a of (s.recommended || [])) names.push(a);
        for (const id of (s.ids || [])) names.push(id);
        if (list.dataset.n !== String(names.length)) { list.replaceChildren(...names.map((n) => el('option', { value: n }))); list.dataset.n = String(names.length); }
        if (!st.touched && !model.value) model.value = pickInitial(s);
        use.disabled = busy || !model.value.trim();
      }
      vision.hidden = !cur;
      if (cur) {
        vision.className = 'llm-state ' + (cur.vision ? 'ok' : 'warn');
        vision.textContent = cur.model + ' · ' + t(cur.vision ? 'flw.model.vision' : 'flw.model.noVision');
      }
    }

    function pickInitial(s) {
      const saved = opts.getSavedModel();
      if (saved) return saved;
      if (s.loaded && s.loaded.length) return s.loaded[0];
      return DEFAULT_MODEL;
    }

    async function refresh() {
      let s = null;
      try { s = await api.fl.state(); } catch (e) { s = null; }
      if (!s || !s.ok) return;
      st.s = s;
      render();
    }

    async function act(name, fn) {
      if (st.busy) return;
      st.busy = name;
      render();
      try { await fn(); } finally { st.busy = ''; await refresh(); }
    }

    allowBtn.addEventListener('click', () => act('allow', async () => {
      const r = await api.fl.connect();
      if (r && r.ok) opts.say('ok', t('flw.allow.done'));
      else opts.say(r && r.code === 'DENIED' ? '' : 'err', t(r && r.code === 'DENIED' ? 'flw.allow.denied' : 'flw.allow.failed', { code: (r && r.code) || '?' }));
    }));
    recheck.addEventListener('click', () => act('recheck', async () => { await api.fl.find({}); opts.say('', ''); }));
    scan.addEventListener('click', () => act('scan', async () => {
      opts.say('busy', t('flw.server.scanning'));
      const r = await api.fl.find({ scan: true });
      if (r && r.ok) opts.say('ok', t('flw.server.ok', { addr: String(r.base).replace(/^http:\/\//, '') }));
      else opts.say('err', t(r && r.code === 'BUSY' ? 'flw.server.busy' : 'flw.server.noneFound'));
    }));
    model.addEventListener('input', () => { st.touched = true; use.disabled = !!st.busy || !model.value.trim(); });

    // "Load and use": loads the model (the first time this can take a minute or two), asks it a question, finds out whether it sees pictures, and remembers it
    async function useModel() {
      const name = model.value.trim();
      dlCmdHolder.hidden = true;
      opts.say('busy', t('flw.model.using'));
      st.last = null;
      let r;
      try { r = await api.fl.use({ model: name, shareNames: true }); } catch (e) { r = { ok: false, error: { code: 'INTERNAL' } }; }
      if (r.ok) {
        st.last = r;
        model.value = r.modelId;
        if (opts.onUsed) opts.onUsed(r.status);
        opts.say('ok', t('flw.model.ready', { id: r.modelId }) + ' ' + t(r.visionKnown === false ? 'flw.model.visionUnknown' : (r.vision ? 'flw.model.vision' : 'flw.model.noVision')));
        return;
      }
      const code = r.error && r.error.code;
      opts.say('err', opts.errorText(r.error) + (r.error && r.error.detail && code !== 'FL_NOT_DOWNLOADED' ? ' (' + r.error.detail + ')' : ''));
      if (code === 'FL_NOT_DOWNLOADED') {
        dlCmdHolder.replaceChildren(el('span', { class: 'hint', text: t('flw.model.download') + ' ' }), command('foundry model download ' + (name || DEFAULT_MODEL)));
        dlCmdHolder.hidden = false;
      }
    }
    use.addEventListener('click', () => act('use', useModel));

    render();
    refresh();
    st.polling = setInterval(() => {
      if (!node.isConnected) { clearInterval(st.polling); return; }
      if (!st.busy) refresh();
    }, POLL_MS);
    return {
      node,
      update: refresh,
      render,
      getModel: () => model.value.trim(),
      // the dialog's "Save and test" button: the same as "Load and use"
      apply: () => act('use', useModel),
      destroy() { clearInterval(st.polling); },
    };
  }

  window.VE.web = window.VE.web || {};
  window.VE.web.flPanel = { panel };
})();
