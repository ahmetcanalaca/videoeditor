'use strict';
// Tests of "found" in the edit engine: what find_in_video returns can be passed to every range tool (found="f1"), the tool is then applied to every
// part of the video where the thing was seen. Zoom gets the object's position as its focus point; keep_range keeps the found parts and removes the rest.
const M = require('../src/shared/model');
const A = require('../src/shared/agent-ops');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); passed++; } catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); failed++; }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ±' + tol + ', got ' + a); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const media = new Map([
  ['mA', { id: 'mA', name: 'A.mp4', duration: 100, fps: 30, hasAudio: true, displayWidth: 1920, displayHeight: 1080 }],
  ['mB', { id: 'mB', name: 'B.mp4', duration: 60, fps: 25, hasAudio: false, displayWidth: 1280, displayHeight: 720 }],
]);
const seg = (over) => Object.freeze(M.createSegment(media.get((over && over.mediaId) || 'mA'), over));
const outDur = (s) => (s.out - s.in) / s.speed;
const total = (r) => r.segments.reduce((sum, s) => sum + outDur(s), 0);
const make = (segs) => new A.Session({ segments: segs, media });
const one = () => make([seg({ id: 'a1', mediaId: 'mA', in: 0, out: 100 })]);
const two = () => make([seg({ id: 'c1', mediaId: 'mA', in: 0, out: 50 }), seg({ id: 'c2', mediaId: 'mB', in: 10, out: 40 })]);
const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
// a dog at 10-20 s (small, left) and again at 60-65 s (bigger, right)
const withDog = (s) => s.registerFound({ label: 'dog', intervals: [{ start: 10, end: 20, box: box(0.1, 0.4, 0.3, 0.6) }, { start: 60, end: 65, box: box(0.6, 0.3, 0.9, 0.8) }] });

test('registerFound: ids count up, intervals are sorted, clamped and empty ones dropped', () => {
  const s = one();
  eq(s.registerFound({ label: 'dog', intervals: [{ start: 60, end: 65 }, { start: 10, end: 20 }, { start: 50, end: 50 }, { start: 95, end: 130 }] }), 'f1');
  eq(s.registerFound({ label: 'x', intervals: [] }), 'f2');
  const f = s.found.get('f1');
  eq(f.intervals.length, 3);
  eq(f.intervals[0].start, 10);
  eq(f.intervals[2].end, 100, 'clamped to the timeline');
});

test('originalMap lists the pieces of the original timeline with their source positions', () => {
  const s = two();
  const m = s.originalMap();
  eq(m.length, 2);
  eq(m[0].b0, 0); eq(m[0].b1, 50); eq(m[0].mediaId, 'mA');
  eq(m[1].b0, 50); eq(m[1].b1, 80); eq(m[1].in, 10);
});

test('remove_range with found removes every part and closes the gaps', () => {
  const s = one();
  const id = withDog(s);
  const r = s.apply('remove_range', { found: id });
  ok(r.ok, r.error);
  near(total(s.result()), 85, 1e-6, 'total after removing 10 + 5 seconds');
  near(r.removed_seconds, 15, 1e-6);
  ok(/dog/.test(r.message) && /f1/.test(r.message));
});

test('occurrence picks one part: number, first, last; wrong numbers are explained', () => {
  const s = one();
  const id = withDog(s);
  ok(s.apply('remove_range', { found: id, occurrence: 2 }).ok);
  near(total(s.result()), 95, 1e-6);
  const s2 = one(); const id2 = withDog(s2);
  ok(s2.apply('remove_range', { found: id2, occurrence: 'first' }).ok);
  near(total(s2.result()), 90, 1e-6);
  const s3 = one(); const id3 = withDog(s3);
  ok(s3.apply('remove_range', { found: id3, occurrence: 'last' }).ok);
  near(total(s3.result()), 95, 1e-6);
  const bad = one(); const idb = withDog(bad);
  const r = bad.apply('remove_range', { found: idb, occurrence: 3 });
  eq(r.ok, false);
  ok(/1 to 2/.test(r.error), r.error);
  eq(total(bad.result()), 100, 'a failed call changes nothing');
});

test('keep_range with found keeps the found parts only', () => {
  const s = one();
  const id = withDog(s);
  const r = s.apply('keep_range', { found: id });
  ok(r.ok, r.error);
  const res = s.result();
  near(total(res), 15, 1e-6);
  eq(res.segments.length, 2);
  near(res.segments[0].in, 10, 1e-6); near(res.segments[0].out, 20, 1e-6);
  near(res.segments[1].in, 60, 1e-6); near(res.segments[1].out, 65, 1e-6);
});

test('keep_range with found and the found part at the very start or end', () => {
  const s = one();
  const id = s.registerFound({ label: 'sky', intervals: [{ start: 0, end: 30 }, { start: 90, end: 100 }] });
  ok(s.apply('keep_range', { found: id }).ok);
  near(total(s.result()), 40, 1e-6);
});

test('set_speed with found speeds up every part (and only those)', () => {
  const s = one();
  const id = withDog(s);
  const r = s.apply('set_speed', { found: id, speed: 2 });
  ok(r.ok, r.error);
  near(total(s.result()), 100 - 5 - 2.5, 1e-6);
  const fast = s.result().segments.filter((x) => x.speed === 2);
  eq(fast.length, 2);
});

test('set_zoom with found: focus is the centre of the object, factor follows its size, zoom is eased in and out', () => {
  const s = one();
  const id = withDog(s);
  const r = s.apply('set_zoom', { found: id, mode: 'in', occurrence: 1 });
  ok(r.ok, r.error);
  const res = s.result();
  const zoomed = res.segments.filter((x) => x.zoomFrom !== 1 || x.zoomTo !== 1);
  ok(zoomed.length >= 3, 'ramp in, hold, ramp out');
  zoomed.forEach((x) => { near(x.fx, 0.2, 1e-6, 'fx'); near(x.fy, 0.5, 1e-6, 'fy'); });
  const factor = Math.max(...zoomed.map((x) => Math.max(x.zoomFrom, x.zoomTo)));
  near(factor, 3, 0.01, '0.6 / 0.2 = 3x for an object 20 % wide');
  // starts at 1x, ends at 1x, holds in between
  near(zoomed[0].zoomFrom, 1, 1e-9);
  near(zoomed[zoomed.length - 1].zoomTo, 1, 1e-9);
  eq(res.actions.filter((x) => x.op === 'zoom').length, 1, 'one log entry per part');
  eq(res.actions[0].eased, true);
  near(total(res), 100, 1e-6, 'zoom does not change the length');
});

test('set_zoom with found: a focus or factor given by the model wins over the object box', () => {
  const s = one();
  const id = withDog(s);
  ok(s.apply('set_zoom', { found: id, occurrence: 1, mode: 'hold', factor: 2, focus: 'top-left' }).ok);
  const z = s.result().segments.filter((x) => x.zoomFrom !== 1 || x.zoomTo !== 1);
  z.forEach((x) => { near(x.fx, 0.25, 1e-9); near(x.fy, 0.25, 1e-9); });
  near(Math.max(...z.map((x) => x.zoomTo)), 2, 1e-6);
});

test('set_zoom with found without a box zooms to the centre; a short part is a single zoom', () => {
  const s = one();
  const id = s.registerFound({ label: 'blink', intervals: [{ start: 5, end: 5.8 }] });
  ok(s.apply('set_zoom', { found: id, mode: 'in', factor: 2 }).ok);
  const res = s.result();
  const z = res.segments.filter((x) => x.zoomTo !== 1);
  eq(z.length, 1);
  near(z[0].fx, 0.5, 1e-9);
});

test('a zoom that reaches the end of the video has no zoom-out ramp', () => {
  const s = one();
  const id = s.registerFound({ label: 'sunset', intervals: [{ start: 80, end: 100, box: box(0.4, 0.4, 0.6, 0.6) }] });
  ok(s.apply('set_zoom', { found: id }).ok);
  const z = s.result().segments.filter((x) => x.zoomFrom !== 1 || x.zoomTo !== 1);
  ok(z[z.length - 1].zoomTo > 1.5, 'still zoomed at the end');
});

test('autoZoomFactor: small objects zoom more, big ones less, never cut the object off', () => {
  near(A.autoZoomFactor(box(0.4, 0.4, 0.5, 0.5)), 3.5, 1e-9, 'tiny -> capped');
  near(A.autoZoomFactor(box(0.3, 0.3, 0.6, 0.6)), 2, 1e-9);
  near(A.autoZoomFactor(box(0.1, 0.1, 0.6, 0.6)), 1.25, 1e-9);
  const f = A.autoZoomFactor(box(0, 0, 0.95, 0.9));
  ok(f >= 1.1 && f * 0.95 <= 1.06, 'a big object stays inside: ' + f);
});

test('found narrowed by start/end: only the part of the found interval inside the range is used', () => {
  const s = one();
  const id = withDog(s);
  ok(s.apply('remove_range', { found: id, start: 15, end: 62 }).ok);
  near(total(s.result()), 100 - 5 - 2, 1e-6);
  const r = one();
  const id2 = withDog(r);
  const bad = r.apply('remove_range', { found: id2, start: 30, end: 40 });
  eq(bad.ok, false);
  ok(/not inside/.test(bad.error));
});

test('found: unknown id, nothing found, no id yet', () => {
  const s = one();
  let r = s.apply('remove_range', { found: 'f9' });
  eq(r.ok, false); ok(/Call find_in_video first/.test(r.error), r.error);
  const id = s.registerFound({ label: 'unicorn', intervals: [] });
  r = s.apply('remove_range', { found: id });
  eq(r.ok, false); ok(/Nothing was found/.test(r.error), r.error);
  r = s.apply('remove_range', { found: 'x' });
  ok(/Known ids: f1/.test(r.error), r.error);
});

test('found: parts that were already removed earlier in the same request are skipped, not fatal', () => {
  const s = one();
  const id = withDog(s);
  ok(s.apply('remove_range', { start: 8, end: 22 }).ok);
  const r = s.apply('set_speed', { found: id, speed: 2 });
  ok(r.ok, r.error);
  ok(/Skipped 1/.test(r.message), r.message);
  eq(s.apply('remove_range', { found: id, occurrence: 1 }).ok, false, 'only part: nothing left to remove');
});

test('found works across several clips and speeds on the original timeline', () => {
  const s = two();
  const id = s.registerFound({ label: 'car', intervals: [{ start: 45, end: 55 }] });
  ok(s.apply('remove_range', { found: id }).ok);
  const res = s.result();
  near(total(res), 70, 1e-6);
  eq(res.segments.length, 2);
  near(res.segments[0].out, 45, 1e-6);
  near(res.segments[1].in, 15, 1e-6);
});

test('set_volume and set_fade accept found; reset_effects undoes a zoom on a found part', () => {
  const s = one();
  const id = withDog(s);
  ok(s.apply('set_volume', { found: id, mute: true }).ok);
  ok(s.result().segments.filter((x) => x.mute).length === 2);
  ok(s.apply('set_fade', { found: id, fade_in: 0.5, fade_out: 0.5 }).ok);
  ok(s.apply('set_zoom', { found: id, mode: 'in' }).ok);
  ok(s.apply('reset_effects', { found: id }).ok);
  const z = s.result().segments.filter((x) => x.zoomFrom !== 1 || x.zoomTo !== 1);
  eq(z.length, 0);
});

test('tools that never take found still work and ignore nothing silently', () => {
  const s = one();
  const id = withDog(s);
  const r = s.apply('split_at', { times: [30], found: id });
  ok(r.ok, r.error);
  eq(s.result().segments.length, 2);
});

test('getToolDefs: without perception the original list; with it every range tool takes found and find_in_video exists', () => {
  eq(A.getToolDefs({ perception: false }), A.TOOL_DEFS);
  eq(A.getToolDefs(), A.TOOL_DEFS);
  const defs = A.getToolDefs({ perception: true });
  const names = defs.map((d) => d.name);
  ok(names.includes('find_in_video'));
  eq(defs.length, A.TOOL_DEFS.length + 1);
  for (const n of ['remove_range', 'keep_range', 'set_speed', 'set_zoom', 'set_volume', 'set_fade', 'reset_effects']) {
    const d = defs.find((x) => x.name === n);
    ok(d.parameters.properties.found && d.parameters.properties.occurrence, n + ' lacks found');
    ok(d.parameters.properties.start, n + ' lost its normal parameters');
  }
  ok(!A.TOOL_DEFS.find((d) => d.name === 'set_zoom').parameters.properties.found, 'the static list must stay untouched');
  const f = defs.find((d) => d.name === 'find_in_video');
  eq(f.parameters.required[0], 'object');
  ok(!A.TOOL_NAMES.includes('find_in_video'), 'find_in_video is run by the agent loop, not by the edit engine');
});

test('fuzz: random mixes of found and plain calls keep every invariant', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let run = 0; run < 150; run++) {
    const s = rnd() < 0.5 ? one() : two();
    const t = s.baseTotal;
    const ivs = [];
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) { const a = rnd() * (t - 2); ivs.push({ start: a, end: a + 0.2 + rnd() * 12, box: rnd() < 0.7 ? box(0.1 + rnd() * 0.3, 0.1 + rnd() * 0.3, 0.5 + rnd() * 0.4, 0.5 + rnd() * 0.4) : undefined }); }
    const id = s.registerFound({ label: 'thing', intervals: ivs });
    for (let k = 0; k < 4; k++) {
      const pick = Math.floor(rnd() * 7);
      const args = { found: id };
      if (rnd() < 0.3) args.occurrence = 1 + Math.floor(rnd() * 3);
      if (rnd() < 0.2) { args.start = rnd() * t; args.end = args.start + rnd() * 20; }
      if (pick === 0) s.apply('remove_range', args);
      else if (pick === 1) s.apply('keep_range', args);
      else if (pick === 2) s.apply('set_speed', Object.assign({ speed: 0.25 + rnd() * 9 }, args));
      else if (pick === 3) s.apply('set_zoom', Object.assign({ mode: ['in', 'out', 'hold', 'custom', 'none'][Math.floor(rnd() * 5)], zoom_from: 1 + rnd() * 3, zoom_to: 1 + rnd() * 3 }, args));
      else if (pick === 4) s.apply('set_volume', Object.assign({ volume_percent: rnd() * 220 }, args));
      else if (pick === 5) s.apply('set_fade', Object.assign({ fade_in: rnd() * 6, fade_out: rnd() * 6 }, args));
      else s.apply('reset_effects', args);
      const r = s.result();
      r.segments.forEach((x) => {
        const m = media.get(x.mediaId);
        ok(x.in >= -1e-9 && x.out <= m.duration + 1e-9 && x.out - x.in >= M.LIMITS.minSourceDur - 1e-9, 'segment bounds ' + JSON.stringify(x));
        ok(x.speed >= 0.25 - 1e-9 && x.speed <= 8 + 1e-9, 'speed');
        ok(x.zoomFrom >= 1 - 1e-9 && x.zoomTo <= 4 + 1e-9 && x.zoomTo >= 1 - 1e-9 && x.zoomFrom <= 4 + 1e-9, 'zoom');
        ok(x.fx >= 0 && x.fx <= 1 && x.fy >= 0 && x.fy <= 1, 'focus');
      });
      ok(r.segments.length >= 1 && r.segments.length <= A.MAX_PIECES, 'piece count');
    }
  }
});

console.log('\n==== agent-found: ' + passed + '/' + (passed + failed) + ' passed ====');
process.exit(failed ? 1 : 0);
