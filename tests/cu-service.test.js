'use strict';
// Tests of the video analysis service (src/main/ai/cu-service.js): parts of videos, cache, consent, mapping of scenes onto the original timeline,
// the size-limited answer for the model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/main/ai/cu-service');
const CU = require('../src/main/ai/content-understanding');
const { makeResult } = require('./cu-mock');

let failed = 0;
let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ±' + tol + ', got ' + a); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-cu-svc-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

// a timeline piece list like Session.originalMap(): b0/b1 on the original timeline, source in + speed
const piece = (mediaId, b0, b1, inn, speed) => ({ mediaId, b0, b1, in: inn || 0, speed: speed || 1 });

test('chunkBounds: one part up to twice the part length, a short remainder joins the last part', () => {
  eq(S.chunkBounds(100, 600), [{ index: 0, start: 0, end: 100 }]);
  eq(S.chunkBounds(600, 600), [{ index: 0, start: 0, end: 600 }]);
  eq(S.chunkBounds(1199, 600), [{ index: 0, start: 0, end: 1199 }]);
  eq(S.chunkBounds(1200, 600), [{ index: 0, start: 0, end: 600 }, { index: 1, start: 600, end: 1200 }]);
  eq(S.chunkBounds(1250, 600), [{ index: 0, start: 0, end: 600 }, { index: 1, start: 600, end: 1250 }]);
  eq(S.chunkBounds(0.2, 600).length, 1);
});

test('usedRanges / neededParts: only the parts of the files the timeline uses (here: the second part only)', () => {
  const pieces = [piece('m1', 0, 100, 700, 1), piece('m2', 100, 160, 10, 2)];
  const used = S.usedRanges(pieces, 0, 160);
  eq(used.map((u) => [u.clip, u.mediaId, u.s0, u.s1]), [[1, 'm1', 700, 800], [2, 'm2', 10, 130]]);
  const parts = S.neededParts(used, (id) => (id === 'm1' ? 1300 : 200), 600);
  eq(parts, [{ mediaId: 'm1', index: 1, start: 600, end: 1300 }, { mediaId: 'm2', index: 0, start: 0, end: 200 }]);
  // a range inside the first piece only
  eq(S.usedRanges(pieces, 10, 20).length, 1);
  eq(S.usedRanges(pieces, 500, 600).length, 0);
});

test('mapScenes: source time -> original timeline for speed 2, an offset piece, and a piece used twice', () => {
  // m1 used from 100 s to 160 s at speed 2 (30 s on the timeline at 0..30) and again from 100 s to 110 s at normal speed (30..40)
  const pieces = [piece('m1', 0, 30, 100, 2), piece('m1', 30, 40, 100, 1)];
  const records = new Map([['m1#0', {
    scenes: [
      { start: 90, end: 120, description: 'a dog', fields: {}, speech: [{ start: 105, end: 108, speaker: 'S1', text: 'hello dog' }] },
      { start: 120, end: 200, description: 'a car', fields: {}, speech: [] },
    ],
    shots: [95, 112, 130],
  }]]);
  const used = S.usedRanges(pieces, 0, 40);
  const scenes = S.mapScenes(used, records);
  // piece 1: scene 1 clipped to 100..120 -> timeline 0..10; scene 2 120..160 -> 10..30. piece 2: scene 1 clipped to 100..110 -> 30..40
  eq(scenes.map((s) => [s.id, s.start, s.end, s.clip, s.description]), [['s1', 0, 10, 1, 'a dog'], ['s2', 10, 30, 1, 'a car'], ['s3', 30, 40, 2, 'a dog']]);
  eq(scenes[0].speech.map((p) => [p.start, p.end, p.text]), [[2.5, 4, 'hello dog']], 'speech 105..108 at speed 2');
  eq(scenes[2].speech.map((p) => [p.start, p.end]), [[35, 38]], 'the same words in the second use');
  eq(scenes[0].shots, [6], 'shot at 112 is inside 100..120 (timeline 6); 95 is before the used range');
  eq(scenes[1].shots, [15], 'shot at 130 -> 10 + (130-120)/2');
});

test('mapScenes respects the requested range and drops slivers', () => {
  const pieces = [piece('m1', 0, 100, 0, 1)];
  const records = new Map([['m1#0', { scenes: [{ start: 0, end: 50, description: 'x', fields: {}, speech: [] }, { start: 50, end: 100, description: 'y', fields: {}, speech: [] }], shots: [] }]]);
  const scenes = S.mapScenes(S.usedRanges(pieces, 40, 60), records);
  eq(scenes.map((s) => [s.start, s.end]), [[40, 50], [50, 60]]);
  eq(S.mapScenes(S.usedRanges(pieces, 49.98, 50.0), records).length, 0, 'less than 0.05 s is not a range');
});

const bigScenes = (n) => Array.from({ length: n }, (_, i) => ({
  id: 's' + (i + 1), start: i * 10, end: i * 10 + 10, clip: 1,
  description: 'Scene ' + i + ': ' + 'a man walks a dog along the street while people pass by and cars wait at the light. '.repeat(4),
  fields: i % 7 === 0 ? { Tags: ['street', 'dog'] } : {},
  speech: [{ start: i * 10 + 1, end: i * 10 + 4, speaker: 'Speaker 1', text: 'Welcome everybody to the show, today we talk about many different things. '.repeat(3) }],
  shots: [i * 10 + 2, i * 10 + 5, i * 10 + 8],
}));

test('formatForModel: always below the budget (the agent cuts tool results at 20000 characters); long videos shrink the texts, then end with next_start', () => {
  for (const n of [3, 40, 120, 400, 2000]) {
    const f = S.formatForModel(bigScenes(n), { query: 'dog' });
    const size = JSON.stringify(f).length;
    ok(size < 19000, n + ' scenes -> ' + size + ' characters');
    ok(f.scenes.length >= 1);
    if (f.truncated) { ok(f.next_start > 0 && f.scenes.length < n, 'truncated list has a continuation'); eq(f.scenes[f.scenes.length - 1].id, 's' + f.scenes.length); }
    else eq(f.scenes.length, n);
  }
  const small = S.formatForModel(bigScenes(3), {});
  ok(small.scenes[0].description.length > 200 && small.scenes[0].speech && small.scenes[0].shot_changes.length === 3, 'short videos keep full detail');
  const huge = S.formatForModel(bigScenes(2000), {});
  ok(huge.truncated && huge.next_start !== null, 'a 5 hour video is cut with a continuation');
});

test('formatForModel: query marks the scenes that contain the words (case, accents and Turkish letters folded); no query, no marks', () => {
  const scenes = bigScenes(5);
  scenes[3].description = 'Bir KÖPEK sokakta koşuyor';
  scenes[1].speech[0].text = 'Thank you all for coming';
  const a = S.formatForModel(scenes, { query: 'köpek' });
  eq(a.matches, ['s4']);
  ok(a.scenes[3].match === true && !a.scenes[0].match);
  const b = S.formatForModel(scenes, { query: 'thank you' });
  ok(b.matches.includes('s2'));
  const c = S.formatForModel(scenes, {});
  eq(c.matches, undefined);
  ok(c.scenes.every((s) => s.match === undefined));
  eq(S.queryTokens('Köpeği, DOG! a'), ['kopegi', 'dog']);
});

test('AnalysisCache: round trip, damaged / foreign / expired files are ignored, clear, prune', () => {
  const dir = path.join(tmp, 'cache1');
  let now = Date.now();
  const cache = new S.AnalysisCache(dir, () => now);
  const key = 'a'.repeat(64);
  eq(cache.get(key), null);
  const rec = { scenes: [{ start: 0, end: 5, description: 'x', fields: {}, speech: [] }], shots: [1] };
  ok(cache.set(key, rec));
  const back = cache.get(key);
  eq(back.scenes, rec.scenes);
  eq(cache.info().files, 1);
  ok(!cache.set('../escape', rec) && cache.get('../escape') === null, 'only hex keys');
  fs.writeFileSync(path.join(dir, 'b'.repeat(64) + '.json'), '{not json', 'utf8');
  eq(cache.get('b'.repeat(64)), null, 'damaged');
  fs.writeFileSync(path.join(dir, 'c'.repeat(64) + '.json'), JSON.stringify({ v: 1, scenes: [{ start: 'x' }], shots: [] }), 'utf8');
  eq(cache.get('c'.repeat(64)), null, 'wrong shape');
  now += 31 * 24 * 3600 * 1000;
  eq(cache.get(key), null, 'older than 30 days');
  cache.prune();
  eq(cache.list().length, 0, 'expired files are removed by prune');
  now = Date.now();
  ok(cache.set(key, rec));
  eq(cache.clear(), 1);
  eq(cache.info().files, 0);
});

test('fingerprintFile: same content (other name) -> same; changed content or size -> different', async () => {
  const a = path.join(tmp, 'a.bin');
  const b = path.join(tmp, 'renamed.bin');
  const c = path.join(tmp, 'c.bin');
  const data = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 255;
  fs.writeFileSync(a, data);
  fs.writeFileSync(b, data);
  const d2 = Buffer.from(data);
  d2[data.length - 10] ^= 0xff;
  fs.writeFileSync(c, d2);
  const [fa, fb, fc] = await Promise.all([S.fingerprintFile(a), S.fingerprintFile(b), S.fingerprintFile(c)]);
  eq(fa, fb);
  ok(fa !== fc, 'a change near the end is noticed');
  fs.writeFileSync(path.join(tmp, 'tiny.bin'), 'x');
  ok(/^[0-9a-f]{64}$/.test(await S.fingerprintFile(path.join(tmp, 'tiny.bin'))));
});

/* ------------------------------------------------------------------ the service with fakes */

// two files: m1 1300 s (two parts of 600 s: 0-600, 600-1300), m2 200 s; the timeline: m1 100..400 and m1 700..760, m2 whole
function rig(over) {
  const o = over || {};
  const media = { m1: { id: 'm1', name: 'long.mp4', path: 'C:\\v\\long.mp4', duration: 1300, displayWidth: 1920, displayHeight: 1080, hasAudio: true }, m2: { id: 'm2', name: 'short.mp4', path: 'C:\\v\\short.mp4', duration: 200, displayWidth: 640, displayHeight: 360, hasAudio: false } };
  const pieces = o.pieces || [piece('m1', 0, 300, 100, 1), piece('m1', 300, 360, 700, 1), piece('m2', 360, 560, 0, 1)];
  const log = { proxies: [], analyses: [], consent: [], progress: [], deleted: [] };
  const client = {
    analyzerId: 'prebuilt-videoSearch', apiVersion: '2025-11-01', processingLocation: 'geography', origin: 'https://res.services.ai.azure.com',
    async analyze(req) {
      log.analyses.push(req.bytes.length);
      if (o.analyzeError) throw o.analyzeError;
      const part = log.proxies[log.proxies.length - 1];
      req.onStatus({ phase: 'uploading', elapsedMs: 0 });
      req.onStatus({ phase: 'waiting', status: 'running', elapsedMs: 1000 });
      return { result: makeResult(part.duration, { sceneSeconds: 20 }), usage: { videoHours: part.duration / 3600 }, operationId: 'op' + log.analyses.length };
    },
    async deleteResult(id) { log.deleted.push(id); return true; },
  };
  const cache = o.cache || new S.AnalysisCache(path.join(tmp, 'cache-' + Math.random().toString(36).slice(2)));
  const svc = S.createVideoAnalysis({
    client: () => client, cache, pieces, total: pieces[pieces.length - 1].b1,
    getMedia: (id) => media[id], tmpDir: tmp, ffmpegPath: 'ffmpeg', procs: null,
    fingerprint: async (p) => 'fp:' + p,
    makeProxy: async (a) => { log.proxies.push({ start: a.start, duration: a.duration, file: a.file }); fs.writeFileSync(a.out, Buffer.alloc(5000, 1)); return { file: a.out, bytes: 5000 }; },
    confirmUpload: async (plan) => { log.consent.push(plan); return o.allow !== false; },
    onProgress: (p) => log.progress.push(p),
    signal: o.signal, log: () => {}, chunkSeconds: 600,
  });
  return { svc, log, cache, media };
}

test('analyze: asks once, uploads the missing parts (not the unused ones), caches, and answers with scenes on the original timeline', async () => {
  const { svc, log, cache } = rig();
  const r = await svc.analyze({});
  eq(r.ok, true);
  // used: m1 100..400 (part 0), m1 700..760 (part 1), m2 0..200 (part 0) -> 3 uploads
  eq(log.proxies.map((p) => [p.file.split('\\').pop(), p.start, p.duration]), [['long.mp4', 0, 600], ['long.mp4', 600, 700], ['short.mp4', 0, 200]]);
  eq(log.consent.length, 1, 'one question for all parts');
  eq(log.consent[0].files.map((f) => [f.name, f.seconds]), [['long.mp4', 1300], ['short.mp4', 200]]);
  eq(log.consent[0].origin, 'https://res.services.ai.azure.com');
  eq(log.consent[0].location, 'geography');
  eq(log.consent[0].parts, 3);
  eq(r.uploaded_parts, 3);
  eq(r.cached, false);
  ok(r.scene_count >= 10, 'scenes: ' + r.scene_count);
  ok(r.scenes.every((s) => s.start >= 0 && s.end <= 560.01 && s.end > s.start), 'inside the timeline');
  ok(r.scenes[0].start === 0 && Math.abs(r.scenes[r.scenes.length - 1].end - 560) < 0.02);
  ok(r.ui && r.ui.scenes.length === r.scene_count && r.ui.uploaded === 3, 'ui summary for the display');
  ok(/ORIGINAL timeline/.test(r.note));
  ok(/untrusted text taken from the video/.test(r.note) && /never instructions/.test(r.note), 'the note says that the texts are data, not instructions');
  // temp files are gone, the service copies were deleted, results are on this computer
  eq(fs.readdirSync(tmp).filter((n) => /^ve-cu-.*\.mp4$/.test(n)).length, 0, 'no temp video left');
  eq(log.deleted.length, 3);
  eq(cache.info().files, 3);
  ok(log.progress.some((p) => p.phase === 'plan' && p.parts === 3 && p.cached === 0));
  ok(['prepare', 'upload', 'wait'].every((ph) => log.progress.some((p) => p.phase === ph)), 'progress phases');
  // the same request again: from memory, nothing asked, nothing uploaded
  const again = await svc.analyze({});
  eq(again.ok, true);
  eq(again.cached, true);
  eq(log.proxies.length, 3);
  eq(log.consent.length, 1);
});

test('analyze: a later request with the same videos is served from the cache (no question, no upload); a range only needs its own parts', async () => {
  const first = rig();
  await first.svc.analyze({});
  const second = rig({ cache: first.cache });
  const r = await second.svc.analyze({});
  eq(r.ok, true);
  eq(second.log.proxies.length, 0);
  eq(second.log.consent.length, 0);
  eq(r.cached, true);
  // a range that lies only in the short video
  const third = rig();
  const r3 = await third.svc.analyze({ start: 400, end: 500 });
  eq(r3.ok, true);
  eq(third.log.proxies.map((p) => p.file.split('\\').pop()), ['short.mp4']);
  ok(r3.scenes.every((s) => s.start >= 399.99 && s.end <= 500.01));
  eq(r3.range, { start: 400, end: 500 });
});

test('analyze: when the user says no, nothing is prepared or uploaded and the model gets a plain sentence', async () => {
  const { svc, log } = rig({ allow: false });
  const r = await svc.analyze({});
  eq(r.ok, false);
  eq(r.code, 'UPLOAD_DECLINED');
  ok(/did not allow/.test(r.error));
  eq(log.proxies.length, 0);
  eq(log.analyses.length, 0);
});

test('analyze: service errors become sentences for the model (with a code), never a stack trace or a secret', async () => {
  for (const [code, re] of [['AUTH', /credentials were rejected/], ['FORBIDDEN', /Cognitive Services User/], ['CU_NO_DEFAULTS', /model deployments/], ['CU_LOCATION', /processing location/i], ['RATE_LIMIT', /rate limited/], ['TIMEOUT', /too long/], ['NETWORK', /could not be reached/]]) {
    const { svc } = rig({ analyzeError: Object.assign(new Error('boom with key SECRETKEY'), { code, status: 401, detail: 'x' }) });
    const r = await svc.analyze({});
    eq(r.ok, false, code);
    eq(r.code, code);
    ok(re.test(r.error), code + ': ' + r.error);
    ok(!/SECRETKEY|boom/.test(r.error), 'no raw error text');
  }
  const odd = rig({ analyzeError: Object.assign(new Error('x'), { code: 'SOMETHING_NEW' }) });
  const r = await odd.svc.analyze({});
  ok(r.ok === false && /SOMETHING_NEW/.test(r.error));
});

test('analyze: cancelling is not an error result but an ABORTED exception', async () => {
  const ac = new AbortController();
  const { svc } = rig({ analyzeError: Object.assign(new Error('Cancelled'), { code: 'ABORTED' }) });
  let threw = null;
  try { await svc.analyze({}); } catch (e) { threw = e; }
  ok(threw && threw.code === 'ABORTED');
  ac.abort();
});

test('analyze: more than 2 hours of new video must be narrowed; argument checks; call limit per request', async () => {
  const long = rig({ pieces: [piece('m1', 0, 100, 0, 1)] });
  long.media.m1.duration = 3 * 3600;
  long.svc = S.createVideoAnalysis({ client: () => ({ analyzerId: 'a', apiVersion: 'v', processingLocation: 'geography', origin: 'https://x' }), cache: long.cache, pieces: [piece('m1', 0, 10800, 0, 1)], total: 10800, getMedia: (id) => long.media[id], fingerprint: async () => 'f', makeProxy: async () => { throw new Error('no'); }, confirmUpload: async () => true, chunkSeconds: 600 });
  const r = await long.svc.analyze({});
  eq([r.ok, r.code], [false, 'TOO_LONG']);
  const { svc } = rig();
  eq((await svc.analyze({ start: 'x' })).ok, false);
  const inverted = await svc.analyze({ start: 100, end: 50 });
  ok(inverted.ok === false && /inverted|Empty/.test(inverted.error));
  // MAX_FINDS different ranges are allowed, the next one is refused
  const t = rig();
  for (let i = 0; i < S.MAX_FINDS; i++) eq((await t.svc.analyze({ start: i * 10, end: i * 10 + 20 })).ok, true, 'call ' + i);
  const over = await t.svc.analyze({ start: 100, end: 130 });
  ok(over.ok === false && /already used/.test(over.error));
});

test('analyze: an unreadable or missing file is reported as such, nothing is asked', async () => {
  const { svc, log } = rig();
  const gone = S.createVideoAnalysis({
    client: () => ({ analyzerId: 'a', apiVersion: 'v', processingLocation: 'geography', origin: 'https://x' }), cache: new S.AnalysisCache(path.join(tmp, 'c-gone')), pieces: [piece('m1', 0, 100, 0, 1)], total: 100,
    getMedia: () => ({ path: 'C:\\nowhere\\x.mp4', duration: 100, name: 'x.mp4' }), fingerprint: async () => { throw new Error('ENOENT'); },
    makeProxy: async () => { throw new Error('no'); }, confirmUpload: async () => { log.consent.push(1); return true; }, chunkSeconds: 600,
  });
  const r = await gone.analyze({});
  eq([r.ok, r.code], [false, 'PROXY_FAILED']);
  eq(log.consent.length, 0);
  ok(svc);
});

test('the speech text for the model is cut at word boundaries and keeps its times', () => {
  const sp = [{ start: 1, end: 2.5, speaker: 'A', text: 'one two three' }, { start: 3, end: 4, speaker: '', text: 'four five six seven eight nine ten' }];
  eq(S.speechText(sp, 500), '[1-2.5] A: one two three [3-4] four five six seven eight nine ten');
  const cut = S.speechText(sp, 40);
  ok(cut.length <= 41 && cut.startsWith('[1-2.5] A: one two three'), cut);
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); passed++; console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
  }
  console.log('\ncu-service: ' + passed + '/' + queue.length + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
