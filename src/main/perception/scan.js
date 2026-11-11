'use strict';
// Finds WHEN something is visible in the video. Works like a person skimming a film:
//   1. look at one picture every few seconds (coarse pass, "is there a dog in this picture?"),
//   2. find the exact moment each appearance starts and ends (bisection between a picture with and one without it),
//   3. ask the model to draw a box around the thing in a few pictures of each appearance (this also confirms it: a picture that got a
//      "yes" but no box was a false alarm), and keep the median box as the place to zoom into.
// The frame extractor and the model are injected, so everything here is tested with a fake world (tests/perception.test.js).
const { inPosition, medianBox, representative } = require('./boxes');

const MIN_STEP = 2;
const MAX_STEP = 12;
const DEFAULT_MAX_FRAMES = 100;
const EVIDENCE = 3; // pictures per appearance that get a box request (up to 5 for long ones)

function abortError() {
  const e = new Error('Cancelled');
  e.code = 'ABORTED';
  return e;
}

// Seconds between two coarse pictures: about maxFrames pictures over everything that is scanned, between 2 and 12 seconds apart.
function chooseStep(totalSeconds, maxFrames) {
  const raw = totalSeconds / Math.max(1, maxFrames || DEFAULT_MAX_FRAMES);
  return Math.min(MAX_STEP, Math.max(MIN_STEP, Math.round(raw * 2) / 2));
}

// ranges: [{ a, b }] (seconds, ascending, disjoint) -> cells of about `step` seconds with the sample time in the middle
function planCells(ranges, step) {
  const cells = [];
  ranges.forEach((r, ri) => {
    const len = r.b - r.a;
    if (!(len > 0.001)) return;
    const n = Math.max(1, Math.round(len / step));
    const w = len / n;
    for (let k = 0; k < n; k++) cells.push({ ri, a: r.a + k * w, b: r.a + (k + 1) * w, t: r.a + (k + 0.5) * w, first: k === 0, last: k === n - 1 });
  });
  return cells;
}

function pickEvidence(count, max) {
  const n = Math.min(count, max);
  if (n <= 0) return [];
  if (n === 1) return [Math.floor((count - 1) / 2)];
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(Math.round((i * (count - 1)) / (n - 1)));
  return Array.from(new Set(idx));
}

// opts: {
//   phrase, position,
//   ranges: [{ a, b }],
//   frame(t, purpose) -> Promise<{ key, ... }>      purpose: 'probe' | 'ground'
//   probe(frame, phrase, position, signal) -> Promise<boolean>
//   ground(frame, phrase, position, signal) -> Promise<[{ x1, y1, x2, y2 }]>
//   signal, onProgress({ phase, done, total }), maxFrames, step, minLen, refineTo
// }
async function scan(opts) {
  const o = opts;
  const signal = o.signal || null;
  const check = () => { if (signal && signal.aborted) throw abortError(); };
  const ranges = o.ranges.filter((r) => r.b - r.a > 0.001);
  const totalSeconds = ranges.reduce((s, r) => s + (r.b - r.a), 0);
  if (!totalSeconds) return { intervals: [], frames: 0, probes: 0, step: 0, grounded: 0, failedFrames: 0 };
  const step = o.step > 0 ? o.step : chooseStep(totalSeconds, o.maxFrames);
  const minLen = o.minLen !== undefined ? o.minLen : 0.3;
  const refineTo = o.refineTo > 0 ? o.refineTo : 0.5;
  const cells = planCells(ranges, step);
  const stats = { frames: cells.length, probes: 0, step, grounded: 0, failedFrames: 0 };
  const progress = { done: 0, total: cells.length };
  const report = (phase) => { if (o.onProgress) o.onProgress({ phase, done: progress.done, total: progress.total, step }); };

  const cache = new Map(); // frame content + question -> yes/no (a still picture is asked once)
  async function probeFrame(frame) {
    const key = frame.key ? frame.key + '|' + o.phrase + '|' + (o.position || '') : null;
    if (key && cache.has(key)) return cache.get(key);
    check();
    const hit = !!(await o.probe(frame, o.phrase, o.position, signal));
    stats.probes++;
    if (key) cache.set(key, hit);
    return hit;
  }
  async function probeAt(t) {
    check();
    let frame;
    try { frame = await o.frame(t, 'probe'); } catch (e) { if (e && e.code === 'ABORTED') throw e; stats.failedFrames++; return false; }
    return probeFrame(frame);
  }

  /* ---- 1. coarse pass (the next picture is cut out while the model looks at this one) ---- */
  const hits = new Array(cells.length).fill(false);
  const frames = new Array(cells.length).fill(null);
  report('scan');
  let pending = cells.length ? o.frame(cells[0].t, 'probe').then((f) => ({ f }), (e) => ({ e })) : null;
  for (let k = 0; k < cells.length; k++) {
    check();
    const cur = await pending;
    pending = k + 1 < cells.length ? o.frame(cells[k + 1].t, 'probe').then((f) => ({ f }), (e) => ({ e })) : null;
    if (cur.e) {
      if (cur.e.code === 'ABORTED') throw cur.e;
      stats.failedFrames++;
    } else {
      frames[k] = cur.f;
      hits[k] = await probeFrame(cur.f);
    }
    progress.done = k + 1;
    report('scan');
    if (stats.failedFrames > Math.max(3, cells.length * 0.4)) {
      const e = new Error('Too many pictures could not be read from the video');
      e.code = 'FRAMES_FAILED';
      throw e;
    }
  }

  /* ---- 2. runs of "yes" and their exact edges ---- */
  const runs = [];
  for (let k = 0; k < cells.length; k++) {
    if (!hits[k]) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === k - 1 && cells[last.to].ri === cells[k].ri) last.to = k; else runs.push({ from: k, to: k });
  }
  progress.total += runs.length * 2 * Math.max(1, Math.ceil(Math.log2(Math.max(step, refineTo) / refineTo)));
  async function bisect(tNeg, tPos) {
    let lo = tNeg;
    let hi = tPos;
    while (Math.abs(hi - lo) > refineTo) {
      const mid = (lo + hi) / 2;
      if (await probeAt(mid)) hi = mid; else lo = mid;
      progress.done++;
      report('refine');
    }
    return (lo + hi) / 2;
  }
  const found = [];
  for (const run of runs) {
    const c0 = cells[run.from];
    const c1 = cells[run.to];
    let start = c0.a;
    let end = c1.b;
    const before = run.from > 0 && !c0.first ? run.from - 1 : -1;
    const after = run.to + 1 < cells.length && !c1.last ? run.to + 1 : -1;
    if (before >= 0 && cells[before].ri === c0.ri) start = await bisect(cells[before].t, c0.t);
    if (after >= 0 && cells[after].ri === c1.ri) end = await bisect(cells[after].t, c1.t);
    start = Math.max(start, ranges[c0.ri].a);
    end = Math.min(end, ranges[c1.ri].b);
    found.push({ run, start, end });
  }

  /* ---- 3. a box in a few pictures of every appearance (also the confirmation) ---- */
  const kept = [];
  progress.total += found.reduce((s, f) => s + pickEvidence(f.run.to - f.run.from + 1, f.run.to - f.run.from + 1 >= 8 ? EVIDENCE + 2 : EVIDENCE).length, 0);
  for (const f of found) {
    const count = f.run.to - f.run.from + 1;
    const picks = pickEvidence(count, count >= 8 ? EVIDENCE + 2 : EVIDENCE).map((i) => f.run.from + i);
    const boxes = [];
    for (const k of picks) {
      check();
      let frame = frames[k];
      try { frame = await o.frame(cells[k].t, 'ground'); } catch (e) { if (e && e.code === 'ABORTED') throw e; /* the coarse picture will do */ }
      if (frame) {
        const raw = await o.ground(frame, o.phrase, o.position, signal);
        stats.grounded++;
        const rep = representative((raw || []).filter((b) => inPosition(b, o.position)));
        if (rep) boxes.push(rep);
      }
      progress.done++;
      report('ground');
    }
    if (!boxes.length) continue; // "yes" in the coarse pass but nothing to draw a box around: a false alarm
    kept.push({ start: f.start, end: f.end, box: medianBox(boxes), samples: count, boxes: boxes.length });
  }

  /* ---- 4. merge appearances that are only one missed picture apart, drop slivers ---- */
  const merged = [];
  for (const iv of kept.sort((x, y) => x.start - y.start)) {
    const last = merged[merged.length - 1];
    if (last && iv.start - last.end <= step * 1.25) {
      const bl = last.boxList.concat(iv.box ? [iv.box] : []);
      Object.assign(last, { end: Math.max(last.end, iv.end), samples: last.samples + iv.samples, boxList: bl, box: medianBox(bl) });
    } else merged.push(Object.assign({}, iv, { boxList: iv.box ? [iv.box] : [] }));
  }
  const intervals = merged
    .filter((iv) => iv.end - iv.start >= minLen)
    .map((iv) => ({ start: Math.round(iv.start * 100) / 100, end: Math.round(iv.end * 100) / 100, box: iv.box || undefined, samples: iv.samples }));
  return Object.assign({ intervals }, stats);
}

module.exports = { scan, chooseStep, planCells, pickEvidence, DEFAULT_MAX_FRAMES };
