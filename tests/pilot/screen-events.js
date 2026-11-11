'use strict';
// Prototype of the "screen events" analysis that a v3 of the editor could run locally (no AI model needed):
//   A) activity segmentation   - which parts of the recording change at all, and where on the screen (grid cells)
//   B) region watching         - a rectangle the user marks (e.g. the "Stop generation" button) is compared with a reference crop taken from the same video
// Frames are decoded by the bundled ffmpeg and compared in plain JavaScript.
//   node screen-events.js activity <video> <truth.json> [fps]
//   node screen-events.js region   <video> <truth.json> <tref> <x,y,w,h> [fps]      (env TNEG=<seconds> adds the negative example: two-example rule)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = require('../../src/main/ffmpeg-paths').resolveBinaries({ resourcesPath: null }).ffmpeg;

// Decodes a video to raw 8-bit gray frames: { w, h, dt, frames: Buffer[] }
function decode(file, { fps, vf, w, h }) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-i', file, '-vf', vf + ',fps=' + fps + ',format=gray', '-f', 'rawvideo', '-'];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const size = w * h;
    const frames = [];
    let pend = Buffer.alloc(0);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      pend = pend.length ? Buffer.concat([pend, d]) : d;
      while (pend.length >= size) { frames.push(Buffer.from(pend.subarray(0, size))); pend = pend.subarray(size); }
    });
    p.on('close', (c) => (c === 0 ? resolve({ w, h, dt: 1 / fps, frames }) : reject(new Error('ffmpeg ' + c + ' ' + err.slice(0, 300)))));
  });
}

// Changed-pixel fraction between two frames (global and per grid cell)
function diff(a, b, w, h, T, gx, gy) {
  const cells = new Float64Array(gx * gy);
  const cw = w / gx;
  const ch = h / gy;
  let total = 0;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(gy - 1, Math.floor(y / ch));
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const d = a[row + x] - b[row + x];
      if (d > T || d < -T) { total++; cells[cy * gx + Math.min(gx - 1, Math.floor(x / cw))]++; }
    }
  }
  const per = cw * ch;
  return { global: total / (w * h), cells: Array.from(cells, (c) => c / per) };
}

// boolean per frame -> [{a,b}] in seconds; gaps <= minGap are bridged, segments < minLen dropped
function toSegments(flags, dt, minGap, minLen) {
  const segs = [];
  let cur = null;
  flags.forEach((f, k) => {
    const t = k * dt;
    if (f) { if (!cur) cur = { a: t, b: t + dt }; else cur.b = t + dt; }
    else if (cur && t - cur.b > minGap) { segs.push(cur); cur = null; }
  });
  if (cur) segs.push(cur);
  return segs.filter((s) => s.b - s.a >= minLen);
}

const iou = (x, y) => { const i = Math.max(0, Math.min(x.b, y.b) - Math.max(x.a, y.a)); const u = (x.b - x.a) + (y.b - y.a) - i; return u > 0 ? i / u : 0; };
function score(detected, truth) {
  return truth.map((t) => {
    let best = null;
    detected.forEach((d) => { const v = iou(d, t); if (!best || v > best.v) best = { d, v }; });
    return best && best.v > 0 ? { truth: t, det: best.d, startErr: best.d.a - t.a, endErr: best.d.b - t.b, iou: best.v } : { truth: t, det: null, iou: 0 };
  });
}
const f2 = (x) => x.toFixed(2);
const fmtSegs = (s) => s.map((x) => f2(x.a) + '-' + f2(x.b)).join('  ');

async function activity(video, truthFile, fps) {
  const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
  const W = 320; const H = 180;
  const t0 = Date.now();
  const dec = await decode(video, { fps, vf: 'scale=' + W + ':' + H + ':flags=area', w: W, h: H });
  const tDecode = Date.now() - t0;
  const t1 = Date.now();
  const feats = [];
  for (let k = 1; k < dec.frames.length; k++) feats.push(diff(dec.frames[k - 1], dec.frames[k], W, H, 14, 8, 6));
  const tDiff = Date.now() - t1;
  console.log(`activity @${fps} fps: ${dec.frames.length} frames decoded in ${(tDecode / 1000).toFixed(1)} s, compared in ${(tDiff / 1000).toFixed(2)} s (video ${(dec.frames.length * dec.dt).toFixed(1)} s)`);
  const dt = dec.dt;
  const inAny = (t, list) => list.some((s) => t >= s.a && t < s.b);
  const typing = []; const scrolls = [];
  let open = null;
  truth.typing.forEach((e) => { if (e.kind === 'typing_start') open = e.t; if (e.kind === 'typing_end' && open !== null) { typing.push({ a: open, b: e.t }); open = null; } if (e.kind === 'scroll_start') open = e.t; if (e.kind === 'scroll_end' && open !== null) { scrolls.push({ a: open, b: e.t }); open = null; } });
  const pct = (arr, q) => { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
  const phases = { idle: [], typing: [], working: [], scrolling: [] };
  feats.forEach((f, k) => {
    const t = (k + 1) * dt;
    if (inAny(t, truth.working)) phases.working.push(f.global);
    else if (inAny(t, typing)) phases.typing.push(f.global);
    else if (inAny(t, scrolls)) phases.scrolling.push(f.global);
    else phases.idle.push(f.global);
  });
  console.log('changed-pixel fraction of the screen per phase (median / p90 / max):');
  Object.keys(phases).forEach((k) => console.log('  ' + k.padEnd(9) + (phases[k].length ? [pct(phases[k], 0.5), pct(phases[k], 0.9), Math.max(...phases[k])].map((v) => (v * 100).toFixed(3) + '%').join(' / ') : '-') + '   (' + phases[k].length + ' frames)'));
  // generic segmentation of "something changes on screen"
  const THR = 0.0004;
  const flags = feats.map((f) => f.global > THR);
  const segs = toSegments(flags, dt, 1.0, 0.5).map((s) => ({ a: s.a + dt, b: s.b + dt }));
  console.log(`\nA) activity segments (changed > ${(THR * 100).toFixed(2)}% of pixels; gaps < 1 s bridged): ${fmtSegs(segs)}`);
  // where does each segment change? mean grid activity over the segment
  segs.forEach((s) => {
    const ks = feats.map((f, k) => ({ f, t: (k + 1) * dt })).filter((x) => x.t >= s.a && x.t < s.b);
    const cells = new Array(48).fill(0);
    ks.forEach((x) => x.f.cells.forEach((v, i) => { cells[i] += v / ks.length; }));
    const rows = [0, 1, 2, 3, 4, 5].map((r) => cells.slice(r * 8, r * 8 + 8).reduce((a, b) => a + b, 0) / 8);
    const bottom = rows[5] + rows[4];
    const top = rows[0] + rows[1] + rows[2] + rows[3];
    const mean = ks.reduce((a, x) => a + x.f.global, 0) / ks.length;
    s.mean = mean; s.bottomShare = bottom / (bottom + top + 1e-9);
    console.log(`   ${f2(s.a)}-${f2(s.b)}  (${f2(s.b - s.a)} s)  mean change ${(mean * 100).toFixed(2)}%  share in bottom 2 of 6 rows ${(s.bottomShare * 100).toFixed(0)}%`);
  });
  const sc = score(segs, truth.working);
  console.log('   -> best match with the true "AI working" intervals (WITHOUT knowing which segment is which):');
  sc.forEach((x) => console.log(`      truth ${f2(x.truth.a)}-${f2(x.truth.b)}  detected ${x.det ? f2(x.det.a) + '-' + f2(x.det.b) : 'none'}  start err ${x.det ? f2(x.startErr) : '-'} s  end err ${x.det ? f2(x.endErr) : '-'} s  IoU ${f2(x.iou)}`));
  return { segs, feats };
}

async function region(video, truthFile, tref, rect, fps) {
  const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
  const [x, y, w, h] = rect;
  const vf = 'crop=' + w + ':' + h + ':' + x + ':' + y;
  const t0 = Date.now();
  const dec = await decode(video, { fps, vf, w, h });
  const tDecode = Date.now() - t0;
  const ref = (await decode(video, { fps: 1000, vf: 'select=gte(t\\,' + tref + '),' + vf + ',trim=end_frame=1', w, h })).frames[0] || dec.frames[Math.round(tref * fps)];
  const t1 = Date.now();
  const mad = dec.frames.map((fr) => { let s = 0; for (let i = 0; i < fr.length; i++) s += Math.abs(fr[i] - ref[i]); return s / fr.length; });
  const tCmp = Date.now() - t1;
  console.log(`region ${rect.join(',')} @${fps} fps: ${dec.frames.length} crops decoded in ${(tDecode / 1000).toFixed(1)} s, compared in ${(tCmp / 1000).toFixed(3)} s`);
  const dt = dec.dt;
  const inAny = (t, list) => list.some((s) => t >= s.a && t < s.b);
  const inside = mad.filter((v, k) => inAny(k * dt, truth.working));
  const outside = mad.filter((v, k) => !inAny(k * dt, truth.working));
  const mx = (a) => Math.max(...a);
  const mn = (a) => Math.min(...a);
  console.log(`  mean abs difference to the reference crop: while working ${mn(inside).toFixed(1)}..${mx(inside).toFixed(1)}   otherwise ${mn(outside).toFixed(1)}..${mx(outside).toFixed(1)}  (gray levels)`);
  if (process.env.TNEG) {
    // two-example mode: the user shows the state (positive) and one moment where it is NOT there (negative). No threshold to tune: nearest example wins,
    // optionally with a margin.
    const neg = (await decode(video, { fps: 1000, vf: 'select=gte(t\\,' + process.env.TNEG + '),' + vf + ',trim=end_frame=1', w, h })).frames[0];
    const madN = dec.frames.map((fr) => { let s = 0; for (let i = 0; i < fr.length; i++) s += Math.abs(fr[i] - neg[i]); return s / fr.length; });
    let D = 0; for (let i = 0; i < ref.length; i++) D += Math.abs(ref[i] - neg[i]); D /= ref.length;
    console.log(`  positive example t=${tref} s, negative example t=${process.env.TNEG} s; distance between the two examples = ${D.toFixed(1)} gray levels`);
    for (const [name, flags] of [['nearest example wins', mad.map((v, k) => v < madN[k])], ['nearest AND closer than half the example distance', mad.map((v, k) => v < madN[k] && v < D / 2)]]) {
      const segs = toSegments(flags, dt, 0.5, 1.0);
      console.log(`B2) ${name} -> segments: ${fmtSegs(segs)}`);
      score(segs, truth.working).forEach((r) => console.log(`      truth ${f2(r.truth.a)}-${f2(r.truth.b)}  detected ${r.det ? f2(r.det.a) + '-' + f2(r.det.b) : 'none'}  start err ${r.det ? f2(r.startErr) : '-'} s  end err ${r.det ? f2(r.endErr) : '-'} s  IoU ${f2(r.iou)}`));
    }
  }
  // threshold chosen WITHOUT looking at the truth: halfway between the typical "close" and the typical "far" distance
  const sorted = mad.slice().sort((a, b) => a - b);
  const blind = (sorted[Math.floor(sorted.length * 0.1)] + sorted[Math.floor(sorted.length * 0.9)]) / 2;
  for (const [name, thr] of [['blind threshold (midway between 10th and 90th percentile)', blind], ['fixed 12 gray levels', 12]]) {
    const segs = toSegments(mad.map((v) => v < thr), dt, 0.5, 1.0);
    console.log(`B) ${name} = ${thr.toFixed(1)} -> segments: ${fmtSegs(segs)}`);
    score(segs, truth.working).forEach((r) => console.log(`      truth ${f2(r.truth.a)}-${f2(r.truth.b)}  detected ${r.det ? f2(r.det.a) + '-' + f2(r.det.b) : 'none'}  start err ${r.det ? f2(r.startErr) : '-'} s  end err ${r.det ? f2(r.endErr) : '-'} s  IoU ${f2(r.iou)}`));
  }
  return { mad };
}

module.exports = { decode, diff, toSegments, score };

if (require.main === module) {
  const [mode, video, truth, a, b, c] = process.argv.slice(2);
  const run = mode === 'activity' ? activity(video, truth, Number(a || 10)) : region(video, truth, Number(a), String(b).split(',').map(Number), Number(c || 10));
  run.catch((e) => { console.error(e); process.exit(1); });
}
