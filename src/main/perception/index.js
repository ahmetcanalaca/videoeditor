'use strict';
// find_in_video: the assistant's eyes. One object per assistant request (the Session of the agent), created by the AI IPC layer.
//   find({ object, color?, position?, attributes?, start?, end? }) -> { ok, phrase, position, intervals: [{ start, end, box? }], frames, step, seconds, notes }
// Times are seconds on the ORIGINAL timeline (see shared/agent-ops.js), boxes are fractions of the picture.
const { reconcile } = require('./query');
const { scan, chooseStep } = require('./scan');
const { createTimeMap, createFrameSource } = require('./frames');
const { parseTime } = require('../../shared/agent-ops');

const MAX_FINDS_PER_REQUEST = 4;

// opts: {
//   pieces: Session.originalMap(), fileOf(mediaId) -> path, ffmpegPath, procs,
//   vlm: { probe, ground }, userText, signal, onProgress(info), maxFrames, sides, extract? (tests), log
// }
function createPerception(opts) {
  const o = opts;
  const timeMap = createTimeMap(o.pieces.map((p) => ({ b0: p.b0, b1: p.b1, file: o.fileOf(p.mediaId), in: p.in, speed: p.speed })));
  const frame = createFrameSource({ ffmpegPath: o.ffmpegPath, timeMap, procs: o.procs, signal: o.signal, sides: o.sides, extract: o.extract });
  const results = new Map();
  let calls = 0;

  async function find(args) {
    const q = reconcile(args, o.userText);
    if (!q.ok) return { ok: false, error: q.error };
    if (++calls > MAX_FINDS_PER_REQUEST) return { ok: false, error: 'find_in_video was already used ' + MAX_FINDS_PER_REQUEST + ' times in this request. Work with the results you have.' };
    const total = timeMap.total;
    if (!(total > 0)) return { ok: false, error: 'The timeline is empty.' };
    const s0 = parseTime(args && args.start);
    const e0 = parseTime(args && args.end);
    if (Number.isNaN(s0) || Number.isNaN(e0)) return { ok: false, error: 'Invalid time value. Use seconds (e.g. 90) or m:ss (e.g. 1:30).' };
    const a = Math.min(Math.max(0, s0 === undefined ? 0 : s0), total);
    const b = Math.min(Math.max(0, e0 === undefined ? total : e0), total);
    if (!(b - a > 0.5)) return { ok: false, error: 'Empty or inverted search range. The video is ' + Math.round(total * 100) / 100 + ' s long.' };

    const key = [q.phrase, q.position, a.toFixed(2), b.toFixed(2)].join('|');
    if (results.has(key)) return Object.assign({}, results.get(key), { cached: true });

    const t0 = Date.now();
    if (o.onProgress) o.onProgress({ phase: 'start', object: q.phrase, position: q.position, done: 0, total: 0, step: chooseStep(b - a, o.maxFrames) });
    let r;
    try {
      r = await scan({
        phrase: q.phrase,
        position: q.position,
        ranges: [{ a, b }],
        frame,
        probe: o.vlm.probe,
        ground: o.vlm.ground,
        signal: o.signal,
        maxFrames: o.maxFrames,
        onProgress: (p) => { if (o.onProgress) o.onProgress(Object.assign({ object: q.phrase, position: q.position }, p)); },
      });
    } catch (e) {
      if (e && e.code === 'ABORTED') throw e;
      if (o.log) o.log('find_in_video failed: ' + (e && (e.code || e.message)));
      const code = e && e.code ? e.code : 'SCAN_FAILED';
      return { ok: false, error: 'Looking at the video failed (' + code + '). Tell the user that the video could not be examined.', code };
    }
    const out = {
      ok: true,
      phrase: q.phrase,
      object: q.object,
      color: q.color,
      position: q.position,
      range: { start: Math.round(a * 100) / 100, end: Math.round(b * 100) / 100 },
      intervals: r.intervals,
      frames: r.frames,
      probes: r.probes,
      step: r.step,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      notes: q.notes,
    };
    results.set(key, out);
    if (o.onProgress) o.onProgress({ phase: 'done', object: q.phrase, position: q.position, done: out.frames, total: out.frames, found: r.intervals.length });
    return out;
  }

  return { find, timeMap };
}

module.exports = { createPerception, MAX_FINDS_PER_REQUEST };
