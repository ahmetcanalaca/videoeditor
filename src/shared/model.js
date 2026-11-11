/*
 * Shared timeline / zoom model.
 * Loaded as a classic script in the renderer (global VE.model) and with require() in the main process / tests.
 * Single source of truth for the maths used by BOTH the live preview and the FFmpeg export,
 * so that what you see in the preview is what ends up in the exported file.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VE = root.VE || {};
    root.VE.model = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    speedMin: 0.25,
    speedMax: 8,
    zoomMin: 1,
    zoomMax: 4,
    volumeMax: 2,
    fadeMax: 5,
    minSourceDur: 0.04,
  });

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  let idCounter = 0;
  function uid(prefix) {
    idCounter += 1;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + idCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  /* ---------- segments ---------- */

  function createSegment(media, overrides) {
    return Object.assign({
      id: uid('seg'),
      mediaId: media.id,
      in: 0,
      out: media.duration,
      speed: 1,
      zoomFrom: 1,
      zoomTo: 1,
      fx: 0.5,
      fy: 0.5,
      volume: 1,
      mute: false,
      fadeIn: 0,
      fadeOut: 0,
    }, overrides || {});
  }

  // Output duration of a segment (seconds on the timeline).
  function segDuration(seg) {
    return Math.max(0, (seg.out - seg.in) / seg.speed);
  }

  // Clamp every numeric property into its legal range (used on load and after edits).
  function sanitizeSegment(seg, media) {
    const s = Object.assign({}, seg);
    const mediaDur = media ? media.duration : Infinity;
    s.in = clamp(num(s.in, 0), 0, Math.max(0, mediaDur - LIMITS.minSourceDur));
    s.out = clamp(num(s.out, mediaDur), s.in + LIMITS.minSourceDur, mediaDur);
    s.speed = clamp(num(s.speed, 1), LIMITS.speedMin, LIMITS.speedMax);
    s.zoomFrom = clamp(num(s.zoomFrom, 1), LIMITS.zoomMin, LIMITS.zoomMax);
    s.zoomTo = clamp(num(s.zoomTo, 1), LIMITS.zoomMin, LIMITS.zoomMax);
    s.fx = clamp(num(s.fx, 0.5), 0, 1);
    s.fy = clamp(num(s.fy, 0.5), 0, 1);
    s.volume = clamp(num(s.volume, 1), 0, LIMITS.volumeMax);
    s.mute = !!s.mute;
    const dur = segDuration(s);
    s.fadeIn = clamp(num(s.fadeIn, 0), 0, Math.min(LIMITS.fadeMax, dur));
    s.fadeOut = clamp(num(s.fadeOut, 0), 0, Math.min(LIMITS.fadeMax, dur));
    return s;
  }

  /* ---------- timeline layout ---------- */

  function layout(segments) {
    const items = [];
    let t = 0;
    segments.forEach((seg, index) => {
      const dur = segDuration(seg);
      items.push({ seg, index, start: t, dur, end: t + dur });
      t += dur;
    });
    return { items, total: t };
  }

  // Finds the item that owns timeline time t. The last item also owns its end point.
  function locate(lay, t) {
    const items = lay.items;
    if (!items.length) return null;
    const tt = clamp(t, 0, lay.total);
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid].start <= tt) lo = mid; else hi = mid - 1;
    }
    const item = items[lo];
    const local = clamp(tt - item.start, 0, item.dur);
    const frac = item.dur > 0 ? local / item.dur : 0;
    return {
      item,
      index: lo,
      local,
      frac,
      srcTime: item.seg.in + local * item.seg.speed,
    };
  }

  /* ---------- zoom ---------- */

  // Zoom curve: constant zoom *rate* (geometric interpolation). Splitting a segment keeps the curve exactly continuous.
  function zoomAt(seg, frac) {
    const z0 = seg.zoomFrom;
    const z1 = seg.zoomTo;
    if (z0 === z1) return z0;
    return z0 * Math.pow(z1 / z0, clamp(frac, 0, 1));
  }

  // Visible window (normalised 0..1 coordinates of the source frame) for zoom z centred on (fx, fy), clamped to the frame.
  function cropWindow(z, fx, fy) {
    const w = 1 / z;
    const h = 1 / z;
    return {
      x: clamp(fx - w / 2, 0, 1 - w),
      y: clamp(fy - h / 2, 0, 1 - h),
      w,
      h,
    };
  }

  function hasZoom(seg) {
    return Math.abs(seg.zoomFrom - 1) > 1e-6 || Math.abs(seg.zoomTo - 1) > 1e-6;
  }

  function fadeFactor(seg, local, dur) {
    let f = 1;
    if (seg.fadeIn > 0) f = Math.min(f, clamp(local / seg.fadeIn, 0, 1));
    if (seg.fadeOut > 0) f = Math.min(f, clamp((dur - local) / seg.fadeOut, 0, 1));
    return f;
  }

  /* ---------- editing helpers ---------- */

  // Split a segment at fraction f (0..1) of its output duration. Zoom stays continuous across the cut.
  function splitSegment(seg, frac, idA, idB) {
    const srcMid = seg.in + (seg.out - seg.in) * frac;
    const zm = zoomAt(seg, frac);
    const dur = segDuration(seg);
    const a = Object.assign({}, seg, {
      id: idA || uid('seg'),
      out: srcMid,
      zoomTo: zm,
      fadeOut: 0,
      fadeIn: Math.min(seg.fadeIn, dur * frac),
    });
    const b = Object.assign({}, seg, {
      id: idB || uid('seg'),
      in: srcMid,
      zoomFrom: zm,
      fadeIn: 0,
      fadeOut: Math.min(seg.fadeOut, dur * (1 - frac)),
    });
    return [a, b];
  }

  /* ---------- canvas / export geometry ---------- */

  function parseAspect(str) {
    const m = /^(\d+):(\d+)$/.exec(String(str || ''));
    return m ? Number(m[1]) / Number(m[2]) : null;
  }

  // Output canvas size. `ref` is the first media on the timeline (display size, i.e. after rotation).
  function canvasSize(settings, ref) {
    const refW = ref ? ref.displayWidth : 1920;
    const refH = ref ? ref.displayHeight : 1080;
    const refAspect = refW / refH;
    const aspectSetting = settings && settings.aspect ? settings.aspect : 'auto';
    const explicit = aspectSetting === 'auto' ? null : parseAspect(aspectSetting);
    const resolution = settings && settings.resolution ? settings.resolution : 'original';
    if (resolution === 'original' && !explicit) {
      return { width: even(refW), height: even(refH) };
    }
    const aspect = explicit || refAspect;
    const short = resolution === 'original' ? Math.min(refW, refH) : Number(resolution);
    if (aspect >= 1) return { width: even(short * aspect), height: even(short) };
    return { width: even(short), height: even(short / aspect) };
  }

  // Largest rectangle with the source aspect that fits in the canvas (even numbers, centred).
  function fitRect(srcW, srcH, boxW, boxH, round) {
    const s = Math.min(boxW / srcW, boxH / srcH);
    let w = srcW * s;
    let h = srcH * s;
    if (round) {
      w = Math.min(boxW, even(w));
      h = Math.min(boxH, even(h));
      return { w, h, x: Math.floor((boxW - w) / 4) * 2, y: Math.floor((boxH - h) / 4) * 2 };
    }
    return { w, h, x: (boxW - w) / 2, y: (boxH - h) / 2 };
  }

  const STD_FPS = [
    { value: 24000 / 1001, expr: '24000/1001' },
    { value: 24, expr: '24' },
    { value: 25, expr: '25' },
    { value: 30000 / 1001, expr: '30000/1001' },
    { value: 30, expr: '30' },
    { value: 50, expr: '50' },
    { value: 60000 / 1001, expr: '60000/1001' },
    { value: 60, expr: '60' },
  ];

  function exportFps(settings, ref) {
    const s = settings && settings.fps ? settings.fps : 'auto';
    if (s !== 'auto' && Number(s) > 0) {
      const v = Number(s);
      return { value: v, expr: String(v) };
    }
    const src = ref && ref.fps > 0 ? ref.fps : 30;
    let best = null;
    let bestDiff = Infinity;
    for (const c of STD_FPS) {
      const d = Math.abs(c.value - src);
      if (d < bestDiff) { best = c; bestDiff = d; }
    }
    if (best && bestDiff / src < 0.002) return { value: best.value, expr: best.expr };
    const v = clamp(Math.round(src), 10, 60);
    return { value: v, expr: String(v) };
  }

  function frameCount(seg, fps) {
    return Math.max(1, Math.round(segDuration(seg) * fps.value));
  }

  /* ---------- formatting ---------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(sec, withFraction) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const totalCs = Math.round(sec * 100);
    const cs = totalCs % 100;
    const total = Math.floor(totalCs / 100);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const base = (h > 0 ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s);
    return withFraction === false ? base : base + '.' + pad2(cs);
  }

  return {
    LIMITS,
    clamp,
    even,
    uid,
    createSegment,
    segDuration,
    sanitizeSegment,
    layout,
    locate,
    zoomAt,
    cropWindow,
    hasZoom,
    fadeFactor,
    splitSegment,
    parseAspect,
    canvasSize,
    fitRect,
    exportFps,
    frameCount,
    formatTime,
  };
});
