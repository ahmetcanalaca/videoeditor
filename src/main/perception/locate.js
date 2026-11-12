'use strict';
// locate_in_video: WHERE in the picture something is, inside time ranges that are already known. The Content Understanding analysis says WHEN ("the orange car is
// in these scenes") but has no positions; this looks at a few pictures taken inside those ranges and asks a vision model for a box around the thing, so that a zoom
// can aim at it - what find_in_video does with the built-in model, for a model that can only READ an analysis.
//
// Pictures of the user's video leave the computer here, so:
//   - nothing is cut out or sent before the user said yes (confirmFrames(plan), a dialog the page cannot answer for the user), every time; a "no" is remembered for
//     the rest of the request,
//   - the number of pictures is limited and announced in that dialog, each is at most PICTURE_SIDE pixels on its long edge,
//   - they go to the model the user chose for the chat, nowhere else (the vision model is injected: see cloud-vlm.js).
//
//   locate({ object, color?, position?, ranges: [{ start, end }] })
//     -> { ok, phrase, object, color, position, ranges, intervals: [{ start, end, box? }], unconfirmed: [{ start, end }], frames, probes, step, seconds, notes }
// Times are seconds on the ORIGINAL timeline (see shared/agent-ops.js), boxes are fractions of the picture.
const { reconcile } = require('./query');
const { scan, chooseStep, planCells } = require('./scan');
const { createTimeMap, createFrameSource } = require('./frames');
const { parseTime } = require('../../shared/agent-ops');

const MAX_LOCATES_PER_REQUEST = 3;
const MAX_RANGES = 12;
const MAX_RANGE_SECONDS = 300; // together: a long range needs many pictures
const MAX_FRAMES = 24; // pictures of the first pass, about
const MAX_PICTURES = 64; // requests (each carries one picture) of one call, at the very most
const PICTURE_SIDE = 640; // long edge in pixels of every picture that leaves the computer
const MAX_PICTURE_BYTES = 120 * 1024; // a picture that is larger (noise, fine detail) is cut again smaller, so no picture is larger than this
const FALLBACK_SIDES = [480, 360];
const LOCATE_TIMEOUT_MS = 5 * 60 * 1000; // the pictures of one call, counted from the user's "yes"

const r2 = (v) => Math.round(v * 100) / 100;

// What the model is told when something went wrong (it explains to the user in their language and falls back to what it knew before).
const MODEL_ERRORS = {
  FRAMES_DECLINED: 'The user did not allow sending pictures of the video to the model, so the position could not be found. Tell the user plainly that they can ask again and allow it. Do not ask for permission again in this request. Meanwhile zoom into the center or a side the user named, or ask what they prefer.',
  NO_VISION: 'The chat model does not accept pictures, so the position could not be found. Tell the user; zoom into the center or a side the user named instead.',
  LOCATE_BUDGET: 'The pictures needed for this are more than one call may use. Call locate_in_video again, once, with fewer or shorter ranges (the most important scenes only).',
  FRAMES_FAILED: 'Pictures could not be read from the video. Tell the user that the position could not be found.',
  AUTH: 'The model rejected the request (key or sign-in). Tell the user to check the key in the AI settings.',
  FORBIDDEN: 'Access to the model was denied. Tell the user.',
  RATE_LIMIT: 'The model is rate limited right now. Tell the user to try again in a minute; meanwhile zoom into the center or a side the user named.',
  TIMEOUT: 'The model took too long to answer. Tell the user; zoom into the center or a side the user named instead.',
  NETWORK: 'The model could not be reached. Tell the user to check the connection.',
  SERVER: 'The model service had an error. Tell the user to try again; zoom into the center or a side the user named instead.',
};

function readRanges(args, total) {
  const a = args && typeof args === 'object' ? args : {};
  let list = Array.isArray(a.ranges) ? a.ranges : [];
  if (!list.length && (a.start !== undefined || a.end !== undefined)) list = [{ start: a.start, end: a.end }];
  if (!list.length) return { error: 'ranges is required: the start and end (seconds on the original timeline) of the scenes where the thing appears, for example ranges=[{"start":1,"end":5.75}].' };
  if (list.length > MAX_RANGES) return { error: 'At most ' + MAX_RANGES + ' ranges at a time. Use the scenes that matter most.' };
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') return { error: 'Every range needs a start and an end, for example {"start":1,"end":5.75}.' };
    const s0 = parseTime(r.start);
    const e0 = parseTime(r.end);
    if (s0 === undefined || e0 === undefined || Number.isNaN(s0) || Number.isNaN(e0)) return { error: 'Invalid time value in ranges. Use seconds (e.g. 90) or m:ss (e.g. 1:30).' };
    const s = Math.min(Math.max(0, s0), total);
    const e = Math.min(Math.max(0, e0), total);
    if (e - s > 0.5) out.push({ start: s, end: e });
  }
  if (!out.length) return { error: 'The ranges are empty or inverted. The video is ' + r2(total) + ' s long.' };
  out.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.25) last.end = Math.max(last.end, r.end); else merged.push({ start: r.start, end: r.end });
  }
  const seconds = merged.reduce((s, r) => s + (r.end - r.start), 0);
  if (seconds > MAX_RANGE_SECONDS) return { error: 'Those ranges add up to ' + Math.round(seconds) + ' s; at most ' + MAX_RANGE_SECONDS + ' s can be looked at in one call. Use the scenes that matter most.' };
  return { ranges: merged, seconds };
}

// opts: {
//   pieces: Session.originalMap(), fileOf(mediaId) -> file, ffmpegPath, procs, extract? (the browser: pictures come from its own decoder),
//   vlm: { probe, ground, setBudget? } (see cloud-vlm.js), userText, signal (the request's), onProgress(info),
//   confirmFrames(plan) -> Promise<boolean>  plan: { object, ranges, seconds, pictures, megabytes },  maxFrames?, log,
//   hooks?: { pause(), resume() }  the request's own time limit stands still while the user decides and the pictures are looked at,
//   timeoutMs?  the limit of the pictures of one call (from the user's "yes"); after it the model is told once and is not given another try in this request
// }
function createLocator(opts) {
  const o = opts;
  const timeMap = createTimeMap(o.pieces.map((p) => ({ b0: p.b0, b1: p.b1, file: o.fileOf(p.mediaId), in: p.in, speed: p.speed })));
  // the request's cancel and this call's own time limit end the same work
  const controller = new AbortController();
  const abortWithRun = () => controller.abort();
  if (o.signal) { if (o.signal.aborted) abortWithRun(); else o.signal.addEventListener('abort', abortWithRun, { once: true }); }
  // the same size for both purposes: a picture that was looked at in the first pass is the one that is asked for a box (its answer is already known)
  const frame = createFrameSource({ ffmpegPath: o.ffmpegPath, timeMap, procs: o.procs, signal: controller.signal, sides: { probe: PICTURE_SIDE, ground: PICTURE_SIDE }, maxBytes: MAX_PICTURE_BYTES, fallbackSides: FALLBACK_SIDES, extract: o.extract });
  const results = new Map();
  let calls = 0;
  let declined = false;
  let timer = null;
  let timedOut = false;
  let finished = false;
  const progress = (p) => { if (o.onProgress) try { o.onProgress(p); } catch (e) { /* display only */ } };
  const aborted = () => Object.assign(new Error('Cancelled'), { code: 'ABORTED' });

  async function locateOnce(args) {
    if (controller.signal.aborted) throw aborted();
    const q = reconcile(args, o.userText);
    if (!q.ok) return { ok: false, error: q.error };
    const total = timeMap.total;
    if (!(total > 0)) return { ok: false, error: 'The timeline is empty.' };
    const rr = readRanges(args, total);
    if (rr.error) return { ok: false, error: rr.error };

    const key = [q.phrase, q.position, rr.ranges.map((r) => r.start.toFixed(2) + '-' + r.end.toFixed(2)).join(',')].join('|');
    if (results.has(key)) return Object.assign({}, results.get(key), { cached: true });
    if (declined) return { ok: false, code: 'FRAMES_DECLINED', error: MODEL_ERRORS.FRAMES_DECLINED };
    if (calls >= MAX_LOCATES_PER_REQUEST) return { ok: false, error: 'locate_in_video was already used ' + MAX_LOCATES_PER_REQUEST + ' times in this request. Work with the results you have.' };

    const step = chooseStep(rr.seconds, o.maxFrames || MAX_FRAMES);
    const cells = planCells(rr.ranges.map((r) => ({ a: r.start, b: r.end })), step).length;
    // the first pass needs one picture per cell; finding the exact edges of an appearance and asking for the boxes (a second question about the pictures that got a "yes")
    // need a few more. Every request carries one picture, so this is also the most pictures that can leave the computer.
    const pictures = Math.min(MAX_PICTURES, cells * 2 + 12);
    // The size that is announced is a limit, not a guess: every picture is at most MAX_PICTURE_BYTES (see createFrameSource) and there are at most `pictures` of them.
    const plan = { object: q.phrase, ranges: rr.ranges.length, seconds: r2(rr.seconds), pictures, megabytes: Math.max(0.1, Math.ceil((pictures * MAX_PICTURE_BYTES * 10) / (1024 * 1024)) / 10) };
    let allowed = false;
    try {
      allowed = o.confirmFrames ? !!(await o.confirmFrames(plan)) : false;
    } catch (e) {
      if (e && e.code === 'ABORTED') throw e;
      allowed = false; // a dialog that could not be shown is not a yes
    }
    if (!allowed) {
      declined = true;
      return { ok: false, code: 'FRAMES_DECLINED', error: MODEL_ERRORS.FRAMES_DECLINED };
    }
    calls++;
    if (o.vlm && typeof o.vlm.setBudget === 'function') o.vlm.setBudget(pictures);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, o.timeoutMs > 0 ? o.timeoutMs : LOCATE_TIMEOUT_MS); // from here on pictures are cut out and sent

    const t0 = Date.now();
    progress({ phase: 'start', object: q.phrase, position: q.position, done: 0, total: cells, step });
    let r;
    try {
      r = await scan({
        phrase: q.phrase,
        position: q.position,
        ranges: rr.ranges.map((x) => ({ a: x.start, b: x.end })),
        frame,
        probe: o.vlm.probe,
        ground: o.vlm.ground,
        signal: controller.signal,
        step,
        onProgress: (p) => progress(Object.assign({ object: q.phrase, position: q.position }, p)),
      });
    } catch (e) {
      progress({ phase: 'done', object: q.phrase, position: q.position, done: 0, total: 0, found: 0 });
      if (e && e.code === 'ABORTED') throw e;
      const code = e && e.code ? e.code : 'LOCATE_FAILED';
      if (o.log) o.log('locate_in_video failed: ' + code + (e && e.status ? ' HTTP ' + e.status : '') + (e && e.detail ? ' ' + String(e.detail).slice(0, 160) : ''));
      return { ok: false, code, error: MODEL_ERRORS[code] || ('Looking at the pictures failed (' + code + '). Tell the user that the position could not be found; zoom into the center or a side the user named instead.') };
    }
    progress({ phase: 'done', object: q.phrase, position: q.position, done: r.frames, total: r.frames, found: r.intervals.length });

    // ranges in which no picture showed the thing (it may be small, partly hidden, or only there for a moment): the model is told, it does not guess
    const covered = (rng) => r.intervals.reduce((s, iv) => s + Math.max(0, Math.min(iv.end, rng.end) - Math.max(iv.start, rng.start)), 0);
    const unconfirmed = rr.ranges.filter((rng) => covered(rng) < 0.5).map((rng) => ({ start: r2(rng.start), end: r2(rng.end) }));
    const out = {
      ok: true,
      phrase: q.phrase,
      object: q.object,
      color: q.color,
      position: q.position,
      ranges: rr.ranges.map((x) => ({ start: r2(x.start), end: r2(x.end) })),
      intervals: r.intervals,
      unconfirmed,
      frames: r.frames,
      probes: r.probes,
      step: r.step,
      seconds: r2((Date.now() - t0) / 1000),
      notes: q.notes,
    };
    results.set(key, out);
    return out;
  }

  // The call as a host makes it: the request's own time limit stands still while the user decides and the pictures are looked at; the pictures have a limit of
  // their own, and when it is reached the model is told once (TIMEOUT) and is not given another try in this request. Cancelling the request ends the call.
  // One call at a time: the agent waits for every tool call, and a second one that overlapped would share the budget and the timer of the first.
  let running = false;
  async function locate(args) {
    if (finished) return { ok: false, code: 'TIMEOUT', error: MODEL_ERRORS.TIMEOUT };
    if (running) return { ok: false, error: 'locate_in_video is already running. Wait for its result.' };
    running = true;
    if (o.hooks && o.hooks.pause) o.hooks.pause();
    try {
      return await locateOnce(args);
    } catch (e) {
      if (timedOut && !(o.signal && o.signal.aborted)) { finished = true; return { ok: false, code: 'TIMEOUT', error: MODEL_ERRORS.TIMEOUT }; }
      throw e;
    } finally {
      running = false;
      clearTimeout(timer);
      if (o.hooks && o.hooks.resume) o.hooks.resume();
    }
  }

  return { locate, timeMap };
}

module.exports = { createLocator, readRanges, MAX_LOCATES_PER_REQUEST, MAX_RANGES, MAX_RANGE_SECONDS, MAX_PICTURES, MAX_PICTURE_BYTES, PICTURE_SIDE, LOCATE_TIMEOUT_MS, MODEL_ERRORS };
