(function () {
  'use strict';
  window.VE = window.VE || {};
  const { $, el, debounce, formatBytes, formatDuration, fmtNum, stripExt } = VE.util;
  const M = VE.model;
  const st = VE.state;
  const S = st.S;
  const t = (key, vars) => VE.i18n.t(key, vars);

  /* ---------- generic modal ---------- */

  const modal = (function () {
    let current = null;

    function build(opts) {
      const closeBtn = el('button', { class: 'btn icon', type: 'button' });
      VE.icons.set(closeBtn, 'close');
      closeBtn.title = t('ex.close');
      closeBtn.setAttribute('aria-label', t('ex.close'));
      closeBtn.addEventListener('click', () => close());
      const head = el('div', { class: 'modal-head' }, [el('h2', { text: opts.title || '' }), opts.dismissible === false ? null : closeBtn]);
      const body = el('div', { class: 'modal-body' }, [opts.body]);
      const foot = el('div', { class: 'modal-foot' }, opts.footer || []);
      return { head, body, foot };
    }

    function open(opts) {
      close();
      const parts = build(opts);
      const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [parts.head, parts.body, parts.foot]);
      const scrim = el('div', { class: 'scrim' }, [box]);
      scrim.addEventListener('mousedown', (e) => { if (e.target === scrim && current && current.opts.dismissible !== false) close(); });
      $('#modal-root').appendChild(scrim);
      current = { scrim, box, opts, prevFocus: document.activeElement };
      VE.icons.apply(scrim);
      focusFirst();
      return current;
    }

    // Swaps the content of the open modal (used for the export phases).
    function update(opts) {
      if (!current) return;
      const parts = build(opts);
      current.box.replaceChildren(parts.head, parts.body, parts.foot);
      current.opts = Object.assign({}, current.opts, { dismissible: true }, opts);
      VE.icons.apply(current.box);
      focusFirst();
    }

    function focusFirst() {
      if (!current) return;
      const target = current.box.querySelector('[data-autofocus]') || current.box.querySelector('.modal-foot .btn.primary') || current.box.querySelector('.modal-foot .btn');
      if (target) target.focus();
    }

    function close() {
      if (!current) return;
      const c = current;
      current = null;
      c.scrim.remove();
      if (c.prevFocus && c.prevFocus.focus) { try { c.prevFocus.focus(); } catch (e) { /* ignore */ } }
      if (c.opts.onClose) c.opts.onClose();
    }

    window.addEventListener('keydown', (e) => {
      if (!current) return;
      if (e.key === 'Escape' && current.opts.dismissible !== false) { e.preventDefault(); close(); }
    });

    return { open, update, close, isOpen: () => !!current };
  })();

  /* ---------- export dialog ---------- */

  let phase = 'idle'; // idle | form | running | done
  let jobId = null;
  let outPath = '';
  let cancelRequested = false;
  let progressRefs = null;

  const persist = debounce(() => { window.api.setSettings({ export: Object.assign({}, S.exportSettings) }); }, 400);

  function field(label, control) { return [el('label', { text: label }), control]; }

  function makeSelect(key, options) {
    const sel = el('select');
    options.forEach(([value, label]) => sel.appendChild(el('option', { value, text: label })));
    sel.value = String(S.exportSettings[key]);
    sel.addEventListener('change', () => {
      S.exportSettings[key] = sel.value;
      persist();
      VE.player.relayout();
      if (current.updateSummary) current.updateSummary();
    });
    return sel;
  }

  const current = {};

  function defaultFileName() {
    const m = st.firstMedia();
    const base = m ? stripExt(m.name) : 'video';
    return base + t('ex.suffix') + '.mp4';
  }

  function showForm() {
    phase = 'form';
    jobId = null;
    cancelRequested = false;
    const pathInput = el('input', { type: 'text', readonly: true, placeholder: t('ex.notChosen'), value: outPath });
    const browse = el('button', { class: 'btn outline', type: 'button', text: t('ex.browse'), 'data-autofocus': true });
    browse.addEventListener('click', async () => {
      const p = await window.api.pickExportPath(outPath ? outPath.split(/[\\/]/).pop() : defaultFileName());
      if (p) { outPath = p; pathInput.value = p; pathInput.title = p; }
    });

    const aspectLabel = { auto: t('ex.auto'), '16:9': '16:9', '9:16': '9:16 (' + t('ex.portrait') + ')', '1:1': '1:1 (' + t('ex.square') + ')', '4:3': '4:3' };
    const selRes = makeSelect('resolution', [['original', t('ex.original')], ['1080', '1080p'], ['720', '720p'], ['480', '480p']]);
    const selAspect = makeSelect('aspect', ['auto', '16:9', '9:16', '1:1', '4:3'].map((v) => [v, aspectLabel[v]]));
    const selFps = makeSelect('fps', [['auto', t('ex.auto')], ['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']]);
    const selQuality = makeSelect('quality', [['high', t('ex.qHigh')], ['medium', t('ex.qMedium')], ['low', t('ex.qLow')]]);

    const summary = el('div', { class: 'summary' });
    current.updateSummary = () => {
      const first = st.firstMedia();
      const c = M.canvasSize(S.exportSettings, first);
      const fps = M.exportFps(S.exportSettings, first);
      const item = (label, value) => el('span', {}, [label + ': ', el('b', { text: value })]);
      summary.replaceChildren(
        item(t('ex.summaryLen'), M.formatTime(st.layout().total)),
        item(t('ex.summarySize'), c.width + '×' + c.height),
        item(t('ex.summaryFps'), fmtNum(fps.value, 2)),
        item(t('ex.summaryClips'), String(S.segments.length)),
      );
    };
    current.updateSummary();

    const grid = el('div', { class: 'form-grid' }, [
      ...field(t('ex.output'), el('div', { class: 'path-row' }, [pathInput, browse])),
      ...field(t('ex.resolution'), selRes),
      ...field(t('ex.aspect'), selAspect),
      ...field(t('ex.fps'), selFps),
      ...field(t('ex.quality'), selQuality),
    ]);

    const cancelBtn = el('button', { class: 'btn outline', type: 'button', text: t('ex.cancel') });
    cancelBtn.addEventListener('click', () => modal.close());
    const startBtn = el('button', { class: 'btn primary', type: 'button' }, [el('span', { 'data-icon': 'export' }), el('span', { text: t('ex.start') })]);
    startBtn.addEventListener('click', start);

    const opts = { title: t('ex.title'), body: el('div', { style: { display: 'contents' } }, [grid, summary]), footer: [cancelBtn, startBtn], onClose: () => { phase = phase === 'form' ? 'idle' : phase; } };
    if (modal.isOpen()) modal.update(opts); else modal.open(opts);
  }

  function showProgress() {
    const bar = el('div');
    const pct = el('b', { text: '0%' });
    const stats = el('span', { text: t('ex.rendering') });
    const body = el('div', { style: { display: 'contents' } }, [
      el('div', { text: t('ex.rendering') }),
      el('div', { class: 'progress' }, [bar]),
      el('div', { class: 'progress-meta' }, [pct, stats]),
    ]);
    const cancelBtn = el('button', { class: 'btn outline', type: 'button', text: t('ex.cancel'), 'data-autofocus': true });
    cancelBtn.addEventListener('click', cancel);
    progressRefs = { bar, pct, stats, cancelBtn };
    modal.update({ title: t('ex.title'), body, footer: [cancelBtn], dismissible: false });
  }

  function onProgress(p) {
    if (phase !== 'running' || !progressRefs) return;
    if (jobId && p.jobId !== jobId) return;
    const f = Math.max(0, Math.min(1, p.fraction || 0));
    progressRefs.bar.style.width = (f * 100).toFixed(1) + '%';
    progressRefs.pct.textContent = Math.floor(f * 100) + '%';
    const parts = [t('ex.elapsed', { t: formatDuration(p.elapsed || 0) })];
    if (p.eta !== null && p.eta !== undefined && f > 0.02) parts.push(t('ex.remaining', { t: formatDuration(p.eta) }));
    if (p.speed > 0) parts.push(t('ex.speed', { s: fmtNum(p.speed, 1) }));
    progressRefs.stats.textContent = parts.join('  ·  ');
  }

  function errorText(err) {
    const code = err && err.code;
    const key = 'exerr.' + (code === 'FFMPEG_FAILED' ? (err.kind || 'UNKNOWN') : code);
    const s = t(key);
    return s === key ? t('exerr.UNKNOWN') : s;
  }

  function resultCard(kind, icon, title, lines, details) {
    const iconEl = el('span');
    VE.icons.set(iconEl, icon);
    const msg = el('div', { class: 'msg' }, [el('b', { text: title }), ...lines]);
    if (details) {
      msg.appendChild(el('details', { class: 'err-details' }, [el('summary', { text: t('ex.details') }), el('pre', { text: details })]));
    }
    return el('div', { class: 'result ' + kind }, [iconEl, msg]);
  }

  function showResult(msg) {
    phase = 'done';
    progressRefs = null;
    const closeBtn = el('button', { class: 'btn outline', type: 'button', text: t('ex.close') });
    closeBtn.addEventListener('click', () => modal.close());
    const footer = [];
    let card;
    if (msg.ok) {
      const r = msg.result || {};
      card = resultCard('ok', 'checkCircle', t('ex.done'), [
        el('div', { class: 'path', text: r.outPath || outPath }),
        el('div', { class: 'path', text: t('ex.doneSize', { size: formatBytes(r.size || 0) }) }),
      ]);
      const reveal = el('button', { class: 'btn outline', type: 'button' }, [el('span', { 'data-icon': 'folder' }), el('span', { text: t('ex.show') })]);
      reveal.addEventListener('click', () => window.api.reveal());
      const play = el('button', { class: 'btn primary', type: 'button', 'data-autofocus': true }, [el('span', { 'data-icon': 'playCircle' }), el('span', { text: t('ex.play') })]);
      play.addEventListener('click', () => window.api.openOutput());
      footer.push(reveal, play, closeBtn);
    } else if (msg.error && msg.error.code === 'CANCELLED') {
      card = resultCard('', 'alert', t('ex.cancelled'), []);
      footer.push(closeBtn);
    } else {
      const err = msg.error || {};
      card = resultCard('err', 'xCircle', t('ex.failed'), [el('div', { text: errorText(err) })], err.details || err.message || '');
      closeBtn.classList.add('primary');
      closeBtn.classList.remove('outline');
      footer.push(closeBtn);
    }
    modal.update({ title: t('ex.title'), body: card, footer });
  }

  async function start() {
    if (!outPath) { VE.actions.toast(t('ex.chooseFile'), 'warning'); return; }
    phase = 'running';
    cancelRequested = false;
    jobId = null;
    showProgress();
    let res;
    try {
      res = await window.api.exportStart({ segments: S.segments, settings: Object.assign({}, S.exportSettings), outPath });
    } catch (e) {
      showResult({ ok: false, error: { code: 'UNKNOWN', message: String((e && e.message) || e) } });
      return;
    }
    if (phase !== 'running') return; // finished (or failed) before the reply arrived
    if (!res || !res.ok) {
      showResult({ ok: false, error: (res && res.error) || { code: 'UNKNOWN' } });
      return;
    }
    jobId = res.jobId;
    if (cancelRequested) window.api.exportCancel(jobId);
  }

  function cancel() {
    if (phase !== 'running') return;
    cancelRequested = true;
    if (progressRefs) {
      progressRefs.cancelBtn.disabled = true;
      progressRefs.cancelBtn.textContent = t('ex.cancelling');
      progressRefs.stats.textContent = t('ex.cancelling');
    }
    if (jobId) window.api.exportCancel(jobId);
  }

  function onDone(msg) {
    if (phase !== 'running') return;
    if (jobId && msg.jobId !== jobId) return;
    showResult(msg);
  }

  function open() {
    if (phase === 'running') return;
    if (!S.segments.length) { VE.actions.toast(t('toast.noClips'), 'warning'); return; }
    showForm();
  }

  function init() {
    window.api.on('export:progress', onProgress);
    window.api.on('export:done', onDone);
  }

  VE.modal = modal;
  VE.exportUI = {
    init, open, cancel,
    isRunning: () => phase === 'running',
    reset: () => { outPath = ''; },
  };
})();
