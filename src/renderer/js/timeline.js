(function () {
  'use strict';
  window.VE = window.VE || {};
  const { $, el, clamp, rafThrottle, stripExt, fmtNum, fillRange } = VE.util;
  const M = VE.model;
  const st = VE.state;
  const S = st.S;
  const t = (key, vars) => VE.i18n.t(key, vars);

  const SEG_H = 72;
  const INNER_H = SEG_H - 2;
  const PAD_RIGHT = 100;
  const GUTTER = 12; // left gutter so that the playhead at t=0 is not clipped by the viewport edge
  const MIN_PPS = 2;
  const MAX_PPS = 480;
  const RULER_H = 26;
  // [major tick seconds, number of minor ticks per major]
  const TICKS = [[0.1, 5], [0.2, 4], [0.5, 5], [1, 5], [2, 4], [5, 5], [10, 5], [15, 3], [30, 6], [60, 6], [120, 4], [300, 5], [600, 5], [1200, 4], [1800, 3], [3600, 6]];

  let scroll = null;
  let content = null;
  let ruler = null;
  let track = null;
  let dropInd = null;
  let emptyMsg = null;
  let playheadEl = null;
  let zoomSlider = null;
  let pps = 60;
  let autoFit = true;
  let gesture = null;
  let colors = {};
  const nodes = new Map();
  const thumbCache = new Map();

  /* ---------- helpers ---------- */

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    colors = { rulerBg: g('--ruler-bg'), text: g('--ruler-text'), tick: g('--ruler-tick'), wave: g('--wave'), band: g('--wave-band') };
  }

  const ppsToSlider = (v) => Math.round((Math.log(v / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
  const sliderToPps = (v) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 1000);
  const fitPps = (total, viewW) => clamp((viewW - GUTTER - 60) / Math.max(total, 0.1), MIN_PPS, MAX_PPS);

  function timeAtClientX(clientX) {
    const r = scroll.getBoundingClientRect();
    return (clientX - r.left + scroll.scrollLeft - GUTTER) / pps;
  }

  function thumbFor(media, idx) {
    const ready = media.thumbsReady;
    let use = -1;
    if (ready.has(idx)) {
      use = idx;
    } else {
      for (let d = 1; d < 12; d++) {
        if (idx - d >= 0 && ready.has(idx - d)) { use = idx - d; break; }
        if (idx + d < media.thumbCount && ready.has(idx + d)) { use = idx + d; break; }
      }
    }
    if (use < 0) return null;
    const key = media.id + ':' + use;
    let img = thumbCache.get(key);
    if (!img) {
      img = new Image();
      img.onload = () => { img.ready = true; scheduleDraw(); };
      img.src = 'vemedia://thumb/' + media.id + '/' + use;
      thumbCache.set(key, img);
      if (thumbCache.size > 800) {
        let n = 0;
        for (const k of thumbCache.keys()) { thumbCache.delete(k); if (++n >= 150) break; }
      }
    }
    return img.ready ? img : null;
  }

  /* ---------- segment nodes ---------- */

  function createNode(seg) {
    const node = el('div', { class: 'seg', dataset: { id: seg.id } });
    const canvas = el('canvas');
    const label = el('div', { class: 'seg-label' });
    const dur = el('div', { class: 'seg-dur' });
    node.append(canvas, label, dur, el('div', { class: 'grip l' }), el('div', { class: 'grip r' }));
    return { node, canvas, label, dur, item: null, labelKey: '' };
  }

  function updateNode(n, item) {
    const seg = item.seg;
    const media = S.media.get(seg.mediaId);
    const width = Math.max(2, item.dur * pps);
    const s = n.node.style;
    s.left = (item.start * pps).toFixed(2) + 'px';
    s.width = width.toFixed(2) + 'px';
    s.setProperty('--hue', String(st.hueOf(seg.mediaId)));
    s.setProperty('--gw', Math.min(9, Math.max(3, width / 3)).toFixed(1) + 'px');
    n.node.classList.toggle('selected', seg.id === S.selectedId);
    n.item = item;

    const name = media ? stripExt(media.name) : '?';
    const badges = [];
    if (Math.abs(seg.speed - 1) > 1e-3) badges.push(fmtNum(seg.speed, 2) + '×');
    if (M.hasZoom(seg)) {
      badges.push(Math.abs(seg.zoomFrom - seg.zoomTo) < 1e-6
        ? 'Z ' + fmtNum(seg.zoomFrom, 2) + '×'
        : 'Z ' + fmtNum(seg.zoomFrom, 1) + '→' + fmtNum(seg.zoomTo, 1) + '×');
    }
    const key = name + '|' + badges.join(',');
    if (n.labelKey !== key) {
      n.labelKey = key;
      n.label.replaceChildren(el('span', { class: 'nm', text: name }), ...badges.map((b) => el('span', { class: 'bd', text: b })));
    }
    n.dur.textContent = M.formatTime(item.dur);
    n.dur.classList.toggle('hide', width < 96);
  }

  /* ---------- drawing ---------- */

  // Draws the visible part of one segment (thumbnails + waveform). `ov` overrides in/out/geometry during trim drags.
  function drawNode(n, ov) {
    const item = n.item;
    if (!item) return;
    const seg = ov ? Object.assign({}, item.seg, { in: ov.in, out: ov.out }) : item.seg;
    const media = S.media.get(seg.mediaId);
    const leftPx = ov ? ov.leftPx : item.start * pps;
    const widthPx = ov ? ov.widthPx : item.dur * pps;
    const sl = scroll.scrollLeft;
    const x0 = clamp(Math.floor(sl - 300 - GUTTER - leftPx), 0, Math.max(0, Math.ceil(widthPx)));
    const x1 = clamp(Math.ceil(sl + scroll.clientWidth + 300 - GUTTER - leftPx), 0, Math.ceil(widthPx));
    const w = x1 - x0;
    const canvas = n.canvas;
    if (w <= 0) { canvas.style.display = 'none'; return; }
    canvas.style.display = 'block';
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(INNER_H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    canvas.style.width = w + 'px';
    canvas.style.height = INNER_H + 'px';
    canvas.style.left = x0 + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, INNER_H);

    if (media && media.thumbCount) {
      const aspect = media.displayWidth / media.displayHeight;
      const tw = clamp(Math.round(INNER_H * aspect), 48, 170);
      const k0 = Math.floor(x0 / tw);
      const k1 = Math.ceil(x1 / tw);
      for (let k = k0; k < k1; k++) {
        const srcT = clamp(seg.in + (((k + 0.5) * tw) / pps) * seg.speed, seg.in, seg.out);
        const idx = clamp(Math.floor((srcT / media.duration) * media.thumbCount), 0, media.thumbCount - 1);
        const img = thumbFor(media, idx);
        if (img) ctx.drawImage(img, k * tw - x0, 0, tw, INNER_H);
      }
    }

    if (media && media.waveform && media.waveform.length) {
      const peaks = media.waveform;
      const rate = 50;
      const maxH = INNER_H * 0.4;
      const dim = seg.mute || seg.volume === 0;
      ctx.fillStyle = colors.band;
      ctx.fillRect(0, INNER_H - maxH - 4, w, maxH + 4);
      ctx.fillStyle = colors.wave;
      ctx.globalAlpha = dim ? 0.3 : 1;
      for (let x = x0; x < x1; x++) {
        const a = seg.in + (x / pps) * seg.speed;
        const b = seg.in + ((x + 1) / pps) * seg.speed;
        const i0 = Math.floor(a * rate);
        if (i0 >= peaks.length) break;
        const i1 = Math.min(peaks.length - 1, Math.max(i0, Math.floor(b * rate)));
        let p = 0;
        for (let i = i0; i <= i1; i++) if (peaks[i] > p) p = peaks[i];
        const h = Math.max(1, (p / 255) * maxH);
        ctx.fillRect(x - x0, INNER_H - 2 - h, 1, h);
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawAll() {
    nodes.forEach((n) => drawNode(n));
  }
  const scheduleDraw = rafThrottle(drawAll);

  function tickSpec() {
    for (const [major, minorCount] of TICKS) if (major * pps >= 72) return { major, minorCount };
    return { major: 3600, minorCount: 6 };
  }

  function drawRuler() {
    const w = scroll.clientWidth;
    if (w <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(RULER_H * dpr);
    if (ruler.width !== pw || ruler.height !== ph) {
      ruler.width = pw;
      ruler.height = ph;
      ruler.style.width = w + 'px';
      ruler.style.height = RULER_H + 'px';
    }
    const ctx = ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.rulerBg;
    ctx.fillRect(0, 0, w, RULER_H);
    const { major, minorCount } = tickSpec();
    const minor = major / minorCount;
    const sl = scroll.scrollLeft;
    const i0 = Math.max(0, Math.floor((sl - GUTTER) / pps / minor) - 1);
    const i1 = Math.ceil((sl + w - GUTTER) / pps / minor) + 1;
    ctx.strokeStyle = colors.tick;
    ctx.fillStyle = colors.text;
    ctx.font = '10.5px "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = Math.round(GUTTER + i * minor * pps - sl) + 0.5;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, i % minorCount === 0 ? RULER_H - 12 : RULER_H - 6);
    }
    ctx.stroke();
    for (let i = i0; i <= i1; i++) {
      if (i % minorCount !== 0) continue;
      const x = Math.round(GUTTER + i * minor * pps - sl) + 0.5;
      ctx.fillText(M.formatTime(i * minor, major < 1), x + 4, 4);
    }
  }

  /* ---------- layout / render ---------- */

  function render() {
    const lay = st.layout();
    const viewW = scroll.clientWidth;
    if (autoFit) pps = lay.total > 0 ? fitPps(lay.total, viewW) : 60;
    zoomSlider.value = String(ppsToSlider(pps));
    fillRange(zoomSlider);
    const totalPx = Math.ceil(lay.total * pps);
    content.style.width = Math.max(viewW, GUTTER + totalPx + PAD_RIGHT) + 'px';
    track.style.left = GUTTER + 'px';
    track.style.width = totalPx + 'px';
    emptyMsg.hidden = lay.items.length > 0;

    const seen = new Set();
    lay.items.forEach((item) => {
      seen.add(item.seg.id);
      let n = nodes.get(item.seg.id);
      if (!n) {
        n = createNode(item.seg);
        nodes.set(item.seg.id, n);
        track.appendChild(n.node);
      }
      updateNode(n, item);
    });
    for (const [id, n] of nodes) {
      if (!seen.has(id)) { n.node.remove(); nodes.delete(id); }
    }
    drawRuler();
    updatePlayhead();
    scheduleDraw();
  }

  function updateSelection() {
    nodes.forEach((n, id) => n.node.classList.toggle('selected', id === S.selectedId));
  }

  function keepVisible(x) {
    const sl = scroll.scrollLeft;
    const w = scroll.clientWidth;
    if (x > sl + w - 30 || x < sl) scroll.scrollLeft = Math.max(0, x - w * 0.12);
  }

  function updatePlayhead() {
    playheadEl.style.transform = 'translateX(' + (GUTTER + S.playhead * pps).toFixed(2) + 'px)';
  }

  function onPlayhead() {
    updatePlayhead();
    if (!gesture || gesture.type !== 'scrub') keepVisible(GUTTER + S.playhead * pps);
  }

  /* ---------- zoom ---------- */

  function setPps(value, anchorClientX) {
    const next = clamp(value, MIN_PPS, MAX_PPS);
    if (Math.abs(next - pps) < 1e-6) return;
    const rect = scroll.getBoundingClientRect();
    const ax = anchorClientX !== undefined ? anchorClientX - rect.left : rect.width / 2;
    const anchorTime = (scroll.scrollLeft + ax - GUTTER) / pps;
    pps = next;
    autoFit = false;
    render();
    scroll.scrollLeft = Math.max(0, GUTTER + anchorTime * pps - ax);
    drawRuler();
    scheduleDraw();
  }

  function zoomBy(factor, anchorClientX) { setPps(pps * factor, anchorClientX); }

  function fit() {
    autoFit = true;
    render();
    scroll.scrollLeft = 0;
    drawRuler();
    scheduleDraw();
  }

  function resetView() { autoFit = true; }

  /* ---------- pointer interaction ---------- */

  function scrubTo(clientX) {
    const total = st.layout().total;
    VE.actions.seek(clamp(timeAtClientX(clientX), 0, total));
  }

  function beginScrub(e, captureEl) {
    try { captureEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    gesture = { type: 'scrub', pointerId: e.pointerId, captureEl };
    scrubTo(e.clientX);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const rect = scroll.getBoundingClientRect();
    if (e.clientY > rect.top + scroll.clientHeight) return; // horizontal scrollbar
    const head = e.target.closest ? e.target.closest('.ph-head') : null;
    if (e.target === ruler || head) { beginScrub(e, head || ruler); return; }
    const node = e.target.closest ? e.target.closest('.seg') : null;
    if (!node) {
      VE.actions.select(null);
      beginScrub(e, scroll);
      return;
    }
    const n = nodes.get(node.dataset.id);
    if (!n || !n.item) return;
    VE.actions.select(n.item.seg.id);
    scroll.setPointerCapture(e.pointerId);
    if (e.target.classList.contains('grip')) startTrim(e, n, e.target.classList.contains('l') ? 'l' : 'r');
    else startMove(e, n);
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (gesture.type === 'scrub') scrubTo(e.clientX);
    else if (gesture.type === 'move') moveGesture(e);
    else if (gesture.type === 'trim') trimGesture(e);
  }

  function onPointerUp(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    try { (g.captureEl || scroll).releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (g.type === 'move') endMove(g, e);
    else if (g.type === 'trim') endTrim(g);
  }

  function cancelGesture() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    try { (g.captureEl || scroll).releasePointerCapture(g.pointerId); } catch (err) { /* ignore */ }
    dropInd.style.display = 'none';
    render();
  }

  /* move (reorder) */

  function startMove(e, n) {
    gesture = { type: 'move', pointerId: e.pointerId, n, startX: e.clientX, startScroll: scroll.scrollLeft, started: false, newIndex: -1, origIndex: -1 };
  }

  function moveGesture(e) {
    const g = gesture;
    const dx = (e.clientX - g.startX) + (scroll.scrollLeft - g.startScroll);
    if (!g.started) {
      if (Math.abs(dx) < 4) return;
      g.started = true;
      g.n.node.classList.add('dragging');
    }
    g.n.node.style.transform = 'translateX(' + dx + 'px)';
    const lay = st.layout();
    const idx = lay.items.findIndex((i) => i.seg.id === g.n.item.seg.id);
    if (idx < 0) return;
    const dragged = lay.items[idx];
    const center = dragged.start * pps + dx + (dragged.dur * pps) / 2;
    let k = 0;
    lay.items.forEach((it, i) => { if (i !== idx && (it.start + it.dur / 2) * pps < center) k += 1; });
    g.newIndex = k;
    g.origIndex = idx;
    if (k === idx) {
      dropInd.style.display = 'none';
    } else {
      const others = lay.items.filter((_, i) => i !== idx);
      const x = k < others.length ? others[k].start * pps : (others[others.length - 1].start + others[others.length - 1].dur) * pps;
      dropInd.style.left = (GUTTER + x) + 'px';
      dropInd.style.display = 'block';
    }
  }

  function endMove(g, e) {
    g.n.node.classList.remove('dragging');
    g.n.node.style.transform = '';
    dropInd.style.display = 'none';
    const item = g.n.item;
    if (!g.started) {
      VE.actions.seek(clamp(timeAtClientX(e.clientX), item.start, item.start + item.dur));
      return;
    }
    if (g.newIndex >= 0 && g.newIndex !== g.origIndex) VE.actions.moveSegment(item.seg.id, g.newIndex);
  }

  /* trim (grips) */

  function startTrim(e, n, side) {
    const item = n.item;
    const seg = item.seg;
    const media = S.media.get(seg.mediaId);
    gesture = {
      type: 'trim', pointerId: e.pointerId, n, side, startX: e.clientX, startScroll: scroll.scrollLeft,
      orig: { in: seg.in, out: seg.out }, cur: { in: seg.in, out: seg.out },
      minDur: Math.max(M.LIMITS.minSourceDur, 1 / ((media && media.fps) || 30)),
      mediaDur: media ? media.duration : seg.out, speed: seg.speed, leftPx: item.start * pps,
    };
  }

  function trimGesture(e) {
    const g = gesture;
    const dx = (e.clientX - g.startX) + (scroll.scrollLeft - g.startScroll);
    const dSrc = (dx / pps) * g.speed;
    let nin = g.orig.in;
    let nout = g.orig.out;
    if (g.side === 'l') nin = clamp(g.orig.in + dSrc, 0, g.orig.out - g.minDur);
    else nout = clamp(g.orig.out + dSrc, g.orig.in + g.minDur, g.mediaDur);
    g.cur = { in: nin, out: nout };
    const widthPx = ((nout - nin) / g.speed) * pps;
    const leftPx = g.leftPx + (g.side === 'l' ? ((nin - g.orig.in) / g.speed) * pps : 0);
    g.n.node.style.left = leftPx.toFixed(2) + 'px';
    g.n.node.style.width = Math.max(2, widthPx).toFixed(2) + 'px';
    drawNode(g.n, { in: nin, out: nout, leftPx, widthPx });
    VE.actions.status(M.formatTime(nin) + ' – ' + M.formatTime(nout) + '  (' + M.formatTime((nout - nin) / g.speed) + ')');
  }

  function endTrim(g) {
    const changed = Math.abs(g.cur.in - g.orig.in) > 1e-4 || Math.abs(g.cur.out - g.orig.out) > 1e-4;
    VE.actions.status('');
    if (changed) VE.actions.trimSegment(g.n.item.seg.id, g.cur.in, g.cur.out);
    else render();
  }

  /* ---------- public ---------- */

  function thumbReady() { scheduleDraw(); }
  function waveformReady() { scheduleDraw(); }
  function themeChanged() { readColors(); drawRuler(); scheduleDraw(); }

  function init() {
    scroll = $('#tl-scroll');
    content = $('#tl-content');
    ruler = $('#tl-ruler');
    track = $('#tl-track');
    dropInd = $('#tl-drop');
    emptyMsg = $('#tl-empty');
    playheadEl = $('#tl-playhead');
    zoomSlider = $('#tl-zoom');
    readColors();

    scroll.addEventListener('pointerdown', onPointerDown);
    scroll.addEventListener('pointermove', onPointerMove);
    scroll.addEventListener('pointerup', onPointerUp);
    scroll.addEventListener('pointercancel', onPointerUp);
    scroll.addEventListener('scroll', () => { drawRuler(); scheduleDraw(); });
    scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelGesture(); });

    zoomSlider.addEventListener('input', () => setPps(sliderToPps(Number(zoomSlider.value))));
    $('#btn-tl-in').addEventListener('click', () => zoomBy(1.4));
    $('#btn-tl-out').addEventListener('click', () => zoomBy(1 / 1.4));
    $('#btn-tl-fit').addEventListener('click', fit);

    new ResizeObserver(rafThrottle(() => { render(); })).observe(scroll);
    st.bus.on('segments', render);
    st.bus.on('selection', updateSelection);
    st.bus.on('playhead', onPlayhead);
    VE.i18n.onChange(render);
    render();
  }

  VE.timeline = { init, render, fit, zoomBy, resetView, thumbReady, waveformReady, themeChanged, cancelGesture };
})();
