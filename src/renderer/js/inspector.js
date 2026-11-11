(function () {
  'use strict';
  window.VE = window.VE || {};
  const { $, $$, el, clamp, fmtNum, fillRange } = VE.util;
  const M = VE.model;
  const st = VE.state;
  const S = st.S;
  const t = (key, vars) => VE.i18n.t(key, vars);

  const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4, 8];
  const SNAP = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', wmv3: 'WMV', wmv2: 'WMV', mjpeg: 'MJPEG', prores: 'ProRes' };

  const r = {};
  let skip = null; // id of the control that is being dragged: it must not be overwritten while the user holds it
  let pickerDrag = false;

  const speedToSlider = (s) => Math.round((Math.log(s / 0.25) / Math.log(32)) * 1000);
  const sliderToSpeed = (v) => 0.25 * Math.pow(32, v / 1000);
  const fmtSpeed = (s) => fmtNum(s, 2) + '×';

  function snapSpeed(s) {
    const v = clamp(s, M.LIMITS.speedMin, M.LIMITS.speedMax);
    for (const p of SNAP) if (Math.abs(v - p) / p < 0.03) return p;
    return Math.round(v * 100) / 100;
  }

  function zoomKind(seg) {
    const a = seg.zoomFrom;
    const b = seg.zoomTo;
    if (Math.abs(a - 1) < 1e-6 && Math.abs(b - 1) < 1e-6) return 'none';
    if (Math.abs(a - b) < 1e-6) return 'hold';
    return b > a ? 'in' : 'out';
  }

  function patch(p, key, skipId) {
    const seg = st.selectedSeg();
    if (!seg) return;
    skip = skipId || null;
    try {
      VE.actions.updateSegment(seg.id, p, { coalesce: key + ':' + seg.id });
    } finally {
      skip = null;
    }
  }

  function applyZoomPreset(kind) {
    const seg = st.selectedSeg();
    if (!seg) return;
    const base = Math.max(seg.zoomFrom, seg.zoomTo);
    const target = base > 1.05 ? base : 2;
    if (kind === 'none') patch({ zoomFrom: 1, zoomTo: 1 }, 'zoom');
    else if (kind === 'in') patch({ zoomFrom: 1, zoomTo: target }, 'zoom');
    else if (kind === 'out') patch({ zoomFrom: target, zoomTo: 1 }, 'zoom');
    else if (kind === 'hold') patch({ zoomFrom: target, zoomTo: target }, 'zoom');
  }

  function metaText(media) {
    const parts = [media.displayWidth + '×' + media.displayHeight, fmtNum(media.fps, 2) + ' fps', CODEC_NAMES[media.vcodec] || String(media.vcodec || '').toUpperCase()];
    if (media.hasAudio) parts.push(t('insp.audio').toLowerCase());
    return parts.join(' · ');
  }

  function focusThumbUrl(seg, media) {
    if (!media || !media.thumbCount) return '';
    const mid = (seg.in + seg.out) / 2;
    const idx = clamp(Math.floor((mid / media.duration) * media.thumbCount), 0, media.thumbCount - 1);
    for (let d = 0; d < media.thumbCount; d++) {
      for (const i of [idx - d, idx + d]) {
        if (i >= 0 && i < media.thumbCount && media.thumbsReady.has(i)) return 'vemedia://thumb/' + media.id + '/' + i;
      }
    }
    return '';
  }

  function layoutPicker(media) {
    const parentW = r.picker.parentElement.clientWidth - 24;
    if (parentW <= 40 || !media) return;
    const aspect = media.displayWidth / media.displayHeight;
    let w = parentW;
    let h = w / aspect;
    if (h > 132) { h = 132; w = h * aspect; }
    r.picker.style.width = Math.round(w) + 'px';
    r.picker.style.height = Math.round(h) + 'px';
  }

  function setPct(node, w) {
    node.style.left = (w.x * 100).toFixed(2) + '%';
    node.style.top = (w.y * 100).toFixed(2) + '%';
    node.style.width = (w.w * 100).toFixed(2) + '%';
    node.style.height = (w.h * 100).toFixed(2) + '%';
  }

  function renderPicker(seg, media, kind) {
    layoutPicker(media);
    const url = focusThumbUrl(seg, media);
    if (r.img.dataset.url !== url) {
      r.img.dataset.url = url;
      if (url) r.img.src = url; else r.img.removeAttribute('src');
    }
    r.img.hidden = !url;
    r.picker.classList.toggle('disabled', kind === 'none');
    r.dot.style.left = (seg.fx * 100).toFixed(2) + '%';
    r.dot.style.top = (seg.fy * 100).toFixed(2) + '%';
    r.rectFrom.hidden = kind === 'none' || kind === 'hold';
    r.rectTo.hidden = kind === 'none';
    if (!r.rectFrom.hidden) setPct(r.rectFrom, M.cropWindow(seg.zoomFrom, seg.fx, seg.fy));
    if (!r.rectTo.hidden) setPct(r.rectTo, M.cropWindow(seg.zoomTo, seg.fx, seg.fy));
  }

  function render() {
    const seg = st.selectedSeg();
    r.empty.hidden = !!seg;
    r.body.hidden = !seg;
    if (!seg) return;
    const media = st.mediaOf(seg);
    const item = st.layout().items.find((i) => i.seg.id === seg.id);
    const dur = item ? item.dur : M.segDuration(seg);

    r.swatch.style.setProperty('--hue', String(st.hueOf(seg.mediaId)));
    r.name.textContent = media ? media.name : '?';
    r.name.title = media ? media.path : '';
    r.meta.textContent = media ? metaText(media) : '';
    r.range.textContent = M.formatTime(seg.in) + ' – ' + M.formatTime(seg.out);
    r.length.textContent = M.formatTime(dur);

    r.speedOut.textContent = fmtSpeed(seg.speed);
    if (skip !== 'speed-range') {
      r.speedRange.value = String(speedToSlider(seg.speed));
      fillRange(r.speedRange);
    }
    r.chips.forEach((c) => c.classList.toggle('active', Math.abs(Number(c.dataset.speed) - seg.speed) < 0.001));

    const kind = zoomKind(seg);
    r.zoomPresets.forEach((b) => b.classList.toggle('active', b.dataset.zoom === kind));
    if (skip !== 'zoom-from') { r.zoomFrom.value = String(seg.zoomFrom); fillRange(r.zoomFrom); }
    if (skip !== 'zoom-to') { r.zoomTo.value = String(seg.zoomTo); fillRange(r.zoomTo); }
    r.zoomFromOut.textContent = fmtNum(seg.zoomFrom, 2) + '×';
    r.zoomToOut.textContent = fmtNum(seg.zoomTo, 2) + '×';
    if (media) renderPicker(seg, media, kind);

    const hasAudio = !!(media && media.hasAudio);
    r.volOut.textContent = Math.round(seg.volume * 100) + '%';
    if (skip !== 'clip-volume') { r.volume.value = String(Math.round(seg.volume * 100)); fillRange(r.volume); }
    r.volume.disabled = !hasAudio;
    r.mute.disabled = !hasAudio;
    r.mute.checked = !!seg.mute;
    r.noAudio.hidden = hasAudio;
    r.volHint.hidden = !(hasAudio && seg.volume > 1.001);

    const fmax = Math.max(0.1, Math.floor(Math.min(M.LIMITS.fadeMax, 3, dur) * 10) / 10);
    r.fadeIn.max = String(fmax);
    r.fadeOut.max = String(fmax);
    if (skip !== 'fade-in') { r.fadeIn.value = String(seg.fadeIn); fillRange(r.fadeIn); }
    if (skip !== 'fade-out') { r.fadeOut.value = String(seg.fadeOut); fillRange(r.fadeOut); }
    r.fadeInOut.textContent = fmtNum(seg.fadeIn, 1) + ' s';
    r.fadeOutOut.textContent = fmtNum(seg.fadeOut, 1) + ' s';
  }

  function thumbReady(mediaId) {
    const seg = st.selectedSeg();
    if (seg && seg.mediaId === mediaId && !r.img.dataset.url) render();
  }

  function init() {
    const ids = ['insp-empty', 'insp-body', 'clip-swatch', 'clip-name', 'clip-meta', 'clip-range', 'clip-length', 'speed-out', 'speed-range', 'speed-chips', 'zoom-presets', 'zoom-from', 'zoom-to', 'zoom-from-out', 'zoom-to-out', 'focus-picker', 'focus-img', 'focus-rect-from', 'focus-rect-to', 'focus-dot', 'vol-out', 'clip-volume', 'clip-mute', 'noaudio-hint', 'vol-hint', 'fade-in', 'fade-in-out', 'fade-out', 'fade-out-out', 'btn-reset-clip'];
    const camel = (id) => id.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    ids.forEach((id) => { r[camel(id)] = document.getElementById(id); });
    r.empty = r.inspEmpty;
    r.body = r.inspBody;
    r.swatch = r.clipSwatch;
    r.name = r.clipName;
    r.meta = r.clipMeta;
    r.range = r.clipRange;
    r.length = r.clipLength;
    r.picker = r.focusPicker;
    r.img = r.focusImg;
    r.rectFrom = r.focusRectFrom;
    r.rectTo = r.focusRectTo;
    r.dot = r.focusDot;
    r.volume = r.clipVolume;
    r.mute = r.clipMute;
    r.noAudio = r.noaudioHint;

    // speed
    r.chips = SPEED_PRESETS.map((p) => {
      const chip = el('button', { class: 'chip', type: 'button', text: fmtSpeed(p), dataset: { speed: String(p) } });
      chip.addEventListener('click', () => patch({ speed: p }, 'speed'));
      return chip;
    });
    r.chips.forEach((c) => r.speedChips.appendChild(c));
    r.speedRange.addEventListener('input', () => {
      patch({ speed: snapSpeed(sliderToSpeed(Number(r.speedRange.value))) }, 'speed', 'speed-range');
      fillRange(r.speedRange);
    });

    // zoom
    r.zoomPresets = $$('#zoom-presets .chip');
    r.zoomPresets.forEach((b) => b.addEventListener('click', () => applyZoomPreset(b.dataset.zoom)));
    r.zoomFrom.addEventListener('input', () => { patch({ zoomFrom: Number(r.zoomFrom.value) }, 'zoom', 'zoom-from'); fillRange(r.zoomFrom); });
    r.zoomTo.addEventListener('input', () => { patch({ zoomTo: Number(r.zoomTo.value) }, 'zoom', 'zoom-to'); fillRange(r.zoomTo); });

    const pick = (e) => {
      const rect = r.picker.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      patch({ fx: clamp((e.clientX - rect.left) / rect.width, 0, 1), fy: clamp((e.clientY - rect.top) / rect.height, 0, 1) }, 'focus');
    };
    r.picker.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      r.picker.setPointerCapture(e.pointerId);
      pickerDrag = true;
      pick(e);
    });
    r.picker.addEventListener('pointermove', (e) => { if (pickerDrag) pick(e); });
    const endPick = (e) => {
      pickerDrag = false;
      try { r.picker.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    r.picker.addEventListener('pointerup', endPick);
    r.picker.addEventListener('pointercancel', endPick);

    // audio
    r.volume.addEventListener('input', () => { patch({ volume: Number(r.volume.value) / 100 }, 'volume', 'clip-volume'); fillRange(r.volume); });
    r.mute.addEventListener('change', () => patch({ mute: r.mute.checked }, 'mute'));

    // fades
    r.fadeIn.addEventListener('input', () => { patch({ fadeIn: Number(r.fadeIn.value) }, 'fade', 'fade-in'); fillRange(r.fadeIn); });
    r.fadeOut.addEventListener('input', () => { patch({ fadeOut: Number(r.fadeOut.value) }, 'fade', 'fade-out'); fillRange(r.fadeOut); });

    r.btnResetClip.addEventListener('click', () => patch({ speed: 1, zoomFrom: 1, zoomTo: 1, fx: 0.5, fy: 0.5, volume: 1, mute: false, fadeIn: 0, fadeOut: 0 }, 'reset'));

    // Range inputs keep focus after a drag; release it so Space/arrow shortcuts keep working.
    $$('#inspector input[type="range"]').forEach((i) => i.addEventListener('change', () => i.blur()));

    st.bus.on('segments', render);
    st.bus.on('selection', render);
    VE.i18n.onChange(() => {
      r.chips.forEach((c) => { c.textContent = fmtSpeed(Number(c.dataset.speed)); });
      render();
    });
    new ResizeObserver(() => { const seg = st.selectedSeg(); if (seg) layoutPicker(st.mediaOf(seg)); }).observe($('#inspector'));
    render();
  }

  VE.inspector = { init, render, thumbReady };
})();
