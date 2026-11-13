(function () {
  'use strict';
  // The setup panel of the in-browser assistant in the settings dialog of the web edition: three steps that turn green by themselves - can this computer run it, which
  // model, and "download and use". It only shows what api.ib (js/web/ai/ai-api.js) reports and asks it to act; the workers are never reached from here directly.
  window.VE = window.VE || {};
  const { el } = VE.util;
  const t = (key, vars) => VE.i18n.t(key, vars);
  const api = window.api;

  const POLL_MS = 4000;
  const fmt = (n) => VE.util.formatBytes(n);
  const icon = (name) => { const n = el('span', { class: 'ai-ico' }); VE.icons.set(n, name); return n; };

  // opts: { getStatus() -> assistant status, say(kind, text), errorText(error) -> text, onUsed(status) }
  function panel(opts) {
    const st = { s: null, key: '', busy: '', progress: null, speed: null, win: null, touched: false, timer: 0 };

    const step = (n, key) => {
      const status = el('span', { class: 'st' });
      const body = el('div', { class: 'flw-body' });
      const node = el('div', { class: 'flw-step', 'data-ib-step': key, 'data-state': 'off' }, [
        el('span', { class: 'flw-num', text: String(n) }),
        el('div', { class: 'flw-head' }, [el('span', { class: 'ti', text: t('ibw.step.' + key) }), status]),
        body,
      ]);
      return { node, status, body, set(state, text) { node.dataset.state = state; status.textContent = text || ''; } };
    };
    const btn = (role, cls, iconName, label) => {
      const b = el('button', { class: 'btn ' + cls, type: 'button', 'data-ib': role }, [iconName ? icon(iconName) : null, el('span', { class: 'lbl', text: label })]);
      b.setLabel = (text) => { b.querySelector('.lbl').textContent = text; };
      return b;
    };

    /* ---- 1: this computer */
    const s1 = step(1, 'gpu');
    const gpuNote = el('div', { class: 'hint', 'data-ib': 'gpu-note' });
    s1.body.append(gpuNote);

    /* ---- 2: the model */
    const s2 = step(2, 'model');
    const list = el('div', { class: 'ibw-models', 'data-ib': 'models', role: 'radiogroup' });
    s2.body.append(list);

    /* ---- 3: use */
    const s3 = step(3, 'use');
    const use = btn('use', 'primary', 'download', t('ibw.use'));
    const cancel = btn('cancel', 'outline', '', t('ibw.cancel'));
    const remove = btn('remove', 'outline danger-text', '', t('ibw.remove'));
    const unload = btn('unload', 'outline', '', t('ibw.unload'));
    const bar = el('div', { class: 'llm-bar', 'data-ib': 'bar', hidden: true }, [el('i')]);
    const progress = el('div', { class: 'hint', 'data-ib': 'progress' });
    const storage = el('div', { class: 'hint', 'data-ib': 'storage' });
    s3.body.append(el('div', { class: 'llm-actions' }, [use, cancel, remove, unload]), bar, progress);

    const notice = el('div', { class: 'about-note', 'data-ib': 'notice' });
    notice.innerHTML = t('ibw.notice');
    const node = el('div', { class: 'llm-panel flw-panel ibw-panel', 'data-ib': 'panel' }, [
      el('div', { class: 'llm-title', text: t('ibw.title') }),
      el('div', { class: 'hint', text: t('ibw.intro') }),
      el('div', { class: 'flw-steps' }, [s1.node, s2.node, s3.node]),
      storage,
      notice,
    ]);

    const modelOf = (key) => (st.s && st.s.catalog ? st.s.catalog.find((m) => m.key === key) : null);
    const storedOf = (key) => (st.s && st.s.models ? st.s.models.find((m) => m.key === key) : null);

    function stateText(m) {
      const s = storedOf(m.key);
      const cur = opts.getStatus ? opts.getStatus() : null;
      if (cur && cur.provider === 'inbrowser' && cur.model === m.key && s && s.installed) return t('ibw.state.current');
      if (st.s && st.s.loaded === m.key) return t('ibw.state.loaded');
      if (s && s.installed) return t('ibw.state.installed');
      if (s && s.bytesInstalled > 0) return t('ibw.state.partial', { size: fmt(s.bytesInstalled) });
      return t('ibw.state.none');
    }

    function renderList() {
      const cat = st.s && st.s.catalog ? st.s.catalog : [];
      const sig = cat.map((m) => m.key).join(',') + '|' + st.key + '|' + (st.busy ? 1 : 0);
      if (list.dataset.sig !== sig) {
        list.dataset.sig = sig;
        list.replaceChildren(...cat.map((m) => {
          const input = el('input', { type: 'radio', name: 'ibw-model', value: m.key, 'data-ib-model': m.key });
          input.checked = m.key === st.key;
          input.disabled = !!st.busy;
          input.addEventListener('change', () => { st.key = m.key; st.touched = true; render(); });
          const rec = st.s && st.s.recommended === m.key ? el('span', { class: 'ibw-rec', text: t('ibw.recommended') }) : null;
          return el('label', { class: 'ibw-model', 'data-ib-tier': m.tier }, [
            input,
            el('span', { class: 'ibw-main' }, [
              el('span', { class: 'ibw-name' }, [el('b', { text: t('ibw.tier.' + m.tier) }), el('span', { text: ' · ' + m.name + ' · ' + fmt(m.bytes) + ' ' }), rec]),
              el('span', { class: 'hint', text: t('ibw.tierHint.' + m.tier) }),
              el('span', { class: 'ibw-state', 'data-ib-state': m.key }),
            ]),
          ]);
        }));
      }
      cat.forEach((m) => { const n = list.querySelector('[data-ib-state="' + m.key + '"]'); if (n) n.textContent = stateText(m); });
    }

    function progressText() {
      const p = st.progress;
      if (!p) return '';
      if (p.phase === 'download') {
        const pct = p.total ? Math.floor((p.loaded / p.total) * 100) : 0;
        return t('ibw.p.download', { loaded: fmt(p.loaded), total: fmt(p.total), pct, i: p.index || 1, n: p.count || 1 }) + (st.speed ? t('ibw.p.speed', { speed: fmt(st.speed) }) : '');
      }
      if (p.phase === 'read') return t('ibw.p.read', { pct: p.total ? Math.floor((p.loaded / p.total) * 100) : 0 });
      if (p.phase === 'init') return t('ibw.p.init');
      if (p.phase === 'warm') return t('ibw.p.warm');
      if (p.phase === 'test') return t('ibw.p.test');
      return '';
    }

    function render() {
      const s = st.s;
      const sup = s && s.support;
      const busy = !!st.busy;
      if (!s) s1.set('busy', t('ibw.checking'));
      else if (sup && sup.ok) {
        s1.set('ok', sup.gpu && sup.gpu.description ? t('ibw.gpu.ok', { gpu: sup.gpu.description }) : t('ibw.gpu.okPlain'));
      } else s1.set('warn', t('ibw.gpu.fail'));
      gpuNote.textContent = !s ? '' : (sup && sup.ok ? (sup.memoryGB > 0 && sup.memoryGB < 8 ? t('ibw.gpu.memory', { gb: sup.memoryGB }) : '') : t('ibw.gpu.' + ((sup && sup.code) || 'IB_NO_WEBGPU')));
      gpuNote.hidden = !gpuNote.textContent;
      const ok = !!(sup && sup.ok);
      if (ok && !st.key && s && s.catalog) st.key = s.current || s.recommended || (s.catalog[0] && s.catalog[0].key) || '';

      if (!ok) s2.set('off', ''); else s2.set(st.key ? 'ok' : 'todo', st.key && modelOf(st.key) ? modelOf(st.key).name : '');
      s2.body.hidden = !ok;
      renderList();

      const cur = st.key ? storedOf(st.key) : null;
      const installed = !!(cur && cur.installed);
      if (!ok || !st.key) s3.set('off', ''); else if (busy) s3.set('busy', progressText()); else s3.set(installed ? 'ok' : 'todo', installed ? stateText(modelOf(st.key)) : '');
      s3.body.hidden = !ok || !st.key;
      use.setLabel(t(installed ? 'ibw.useInstalled' : 'ibw.use'));
      use.disabled = busy || !ok || !st.key;
      cancel.hidden = !busy;
      remove.hidden = busy || !(cur && cur.bytesInstalled > 0);
      unload.hidden = busy || !(s && s.loaded);
      const p = st.progress;
      bar.hidden = !busy || !p || !(p.total > 0);
      if (!bar.hidden) bar.firstChild.style.width = Math.min(100, Math.round((p.loaded / p.total) * 100)) + '%';
      progress.textContent = busy ? progressText() : '';
      progress.hidden = !busy;
      const q = s && s.storage;
      storage.textContent = q && q.quota ? t('ibw.storage', { used: fmt(q.usage), quota: fmt(q.quota), persist: q.persisted ? t('ibw.storage.persist') : '' }) : '';
      storage.hidden = !storage.textContent;
    }

    async function refresh() {
      let s = null;
      try { s = await api.ib.state(); } catch (e) { s = null; }
      if (!s || !s.ok) return;
      st.s = s;
      render();
    }

    // the speed of the download over the last three to six seconds (two samples are kept)
    function track(p) {
      if (p.phase !== 'download') { st.speed = null; st.win = null; return; }
      const now = Date.now();
      if (!st.win) st.win = { t: now, loaded: p.loaded, prev: null };
      else if (now - st.win.t >= 3000) st.win = { t: now, loaded: p.loaded, prev: st.win };
      const base = st.win.prev || st.win;
      const dt = (now - base.t) / 1000;
      if (dt > 0.5) st.speed = Math.max(0, (p.loaded - base.loaded) / dt);
    }

    async function useModel() {
      if (st.busy || !st.key) { if (!st.key) opts.say('err', t('ibw.pickFirst')); return; }
      st.busy = 'use';
      st.progress = null;
      st.speed = null;
      st.win = null;
      opts.say('busy', t('ibw.p.test'));
      render();
      let r;
      try {
        r = await api.ib.use({ model: st.key, onProgress: (p) => { track(p); st.progress = p; render(); } });
      } catch (e) {
        r = { ok: false, error: { code: 'INTERNAL' } };
      }
      st.busy = '';
      st.progress = null;
      if (r && r.ok) {
        if (opts.onUsed) opts.onUsed(r.status);
        opts.say('ok', r.reply ? t('ibw.ready', { reply: r.reply }) : t('ibw.readyPlain'));
      } else if (r && r.cancelled) {
        opts.say('', t('ibw.cancelled'));
      } else {
        opts.say('err', opts.errorText(r && r.error) + (r && r.error && r.error.detail ? ' (' + r.error.detail + ')' : ''));
      }
      await refresh();
    }

    use.addEventListener('click', useModel);
    cancel.addEventListener('click', () => { api.ai.cancel(); });
    remove.addEventListener('click', async () => {
      if (st.busy || !st.key) return;
      st.busy = 'remove';
      render();
      let r;
      try { r = await api.ib.remove({ model: st.key }); } catch (e) { r = { ok: false, error: { code: 'INTERNAL' } }; }
      st.busy = '';
      if (r && r.ok) { if (opts.onUsed && r.status) opts.onUsed(r.status); opts.say('ok', t('ibw.removed')); } else if (r && r.cancelled) opts.say('', '');
      else opts.say('err', opts.errorText(r && r.error));
      await refresh();
    });
    unload.addEventListener('click', async () => {
      await api.ib.unload();
      opts.say('ok', t('ibw.unloaded'));
      await refresh();
    });

    render();
    refresh();
    st.timer = setInterval(() => {
      if (!node.isConnected) { clearInterval(st.timer); return; }
      if (!st.busy) refresh();
    }, POLL_MS);
    return {
      node,
      update: refresh,
      render,
      getModel: () => st.key,
      // the dialog's "Save and test" button: the same as "Download and use"
      apply: useModel,
      destroy() { clearInterval(st.timer); },
    };
  }

  window.VE.web = window.VE.web || {};
  window.VE.web.ibPanel = { panel };
})();
