'use strict';
// Tests of the reduced copy that is uploaded for the video analysis (src/main/ai/cu-proxy.js), with real ffmpeg.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeProxy, scaleFilter, buildArgs } = require('../src/main/ai/cu-proxy');
const { bins, makeFixtures, streamsOf, ff, patternSource } = require('./helpers');

let failed = 0;
let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ±' + tol + ', got ' + a); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-cu-proxy-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const fx = makeFixtures();
const out = (n) => path.join(tmp, n);

test('scaleFilter: short side 480 (not larger than the source, not smaller than 320), portrait and landscape', () => {
  eq(scaleFilter({ displayWidth: 3840, displayHeight: 2160 }), 'scale=-2:480');
  eq(scaleFilter({ displayWidth: 1080, displayHeight: 1920 }), 'scale=480:-2');
  eq(scaleFilter({ displayWidth: 640, displayHeight: 360 }), 'scale=-2:360');
  eq(scaleFilter({ displayWidth: 160, displayHeight: 120 }), 'scale=-2:320', 'the service needs at least 320 x 240');
  eq(scaleFilter({ displayWidth: 100, displayHeight: 100 }), 'scale=-2:320');
  eq(scaleFilter(null), 'scale=-2:480');
});

test('the ffmpeg command: input guard, no metadata, no extra streams, size cap, speech audio only when there is audio', () => {
  const a = buildArgs({ file: 'C:\\v\\a.mp4', start: 5, duration: 20, out: 'o.mp4', info: { displayWidth: 1920, displayHeight: 1080, hasAudio: true } });
  ok(a.includes('-format_whitelist') && a.includes('-protocol_whitelist'), 'guarded input');
  eq(a[a.indexOf('-i') + 1], 'C:\\v\\a.mp4');
  ok(a.indexOf('-ss') < a.indexOf('-i'), 'input-level seek');
  ok(a.includes('-map_metadata') && a[a.indexOf('-map_metadata') + 1] === '-1');
  ok(a.includes('0:a:0?') && a.includes('-ac') && a[a.indexOf('-ac') + 1] === '1');
  ok(a.includes('-fs'), 'size cap');
  const silent = buildArgs({ file: 'x', start: 0, duration: 5, out: 'o.mp4', info: { displayWidth: 640, displayHeight: 360, hasAudio: false } });
  ok(!silent.includes('0:a:0?'), 'no audio map for a silent source');
});

test('proxy of a 720p video with audio: 854x480, 10 fps, mono 16 kHz AAC, the requested seconds, small', async () => {
  const progress = [];
  const r = await makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.A, info: { displayWidth: 1280, displayHeight: 720, hasAudio: true }, start: 2, duration: 4, out: out('a.mp4'), onProgress: (f) => progress.push(f) });
  ok(fs.existsSync(r.file) && r.bytes > 1000, 'file');
  const s = streamsOf(r.file);
  eq([s.v.width, s.v.height], [854, 480]);
  near(eval(s.v.r_frame_rate), 10, 0.01, 'fps');
  eq(s.v.codec_name, 'h264');
  eq([s.a.codec_name, Number(s.a.channels), Number(s.a.sample_rate)], ['aac', 1, 16000]);
  near(s.duration, 4, 0.3, 'duration');
  ok(r.bytes < 600 * 1024, 'size ' + r.bytes);
  ok(progress.length > 0 && progress.every((f) => f >= 0 && f <= 1), 'progress');
  ok(!s.format.tags || !Object.keys(s.format.tags).some((k) => /title|comment|location|artist/i.test(k)), 'no metadata copied: ' + JSON.stringify(s.format.tags));
});

test('proxy of a phone video (rotation metadata): comes out upright, portrait 480x854', async () => {
  const r = await makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.C, info: { displayWidth: 720, displayHeight: 1280, hasAudio: true }, start: 0, duration: 3, out: out('c.mp4') });
  const s = streamsOf(r.file);
  eq([s.v.width, s.v.height], [480, 854]);
  ok(!(s.v.side_data_list || []).some((d) => d.rotation), 'no rotation left in the copy');
});

test('proxy of a silent video has no audio stream; a tiny source is scaled up to the minimum size of the service', async () => {
  const silent = await makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.B, info: { displayWidth: 640, displayHeight: 480, hasAudio: false }, start: 0, duration: 2, out: out('b.mp4') });
  const sb = streamsOf(silent.file);
  ok(!sb.a, 'no audio stream');
  eq([sb.v.width, sb.v.height], [640, 480]);
  const tiny = out('tiny-src.mp4');
  ff(['-f', 'lavfi', '-i', patternSource(160, 120, 15, 2, '0x203040', 40), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', tiny]);
  const t = await makeProxy({ ffmpegPath: bins.ffmpeg, file: tiny, info: { displayWidth: 160, displayHeight: 120, hasAudio: false }, start: 0, duration: 2, out: out('tiny.mp4') });
  const st = streamsOf(t.file);
  ok(st.v.width >= 320 && st.v.height >= 240, st.v.width + 'x' + st.v.height);
});

test('Turkish characters in the path, a start near the end, NTSC 1080p with mono 44.1 kHz audio', async () => {
  const r = await makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.E, info: { displayWidth: 1280, displayHeight: 720, hasAudio: true }, start: 1, duration: 3, out: out('türkçe çıktı.mp4') });
  ok(r.bytes > 1000);
  const f = await makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.F, info: { displayWidth: 1920, displayHeight: 1080, hasAudio: true }, start: 0.5, duration: 2, out: out('f.mp4') });
  const s = streamsOf(f.file);
  eq([s.v.width, s.v.height, Number(s.a.channels), Number(s.a.sample_rate)], [854, 480, 1, 16000]);
});

test('failures: unreadable input and a missing file are PROXY_FAILED and leave no output; cancelling is ABORTED and leaves no output', async () => {
  let e = null;
  try { await makeProxy({ ffmpegPath: bins.ffmpeg, file: path.join(tmp, 'nope.mp4'), info: {}, start: 0, duration: 2, out: out('x1.mp4') }); } catch (err) { e = err; }
  ok(e && e.code === 'PROXY_FAILED', 'missing: ' + (e && e.code));
  ok(!fs.existsSync(out('x1.mp4')), 'no partial output');
  const junk = out('junk.mp4');
  fs.writeFileSync(junk, Buffer.alloc(5000, 7));
  e = null;
  try { await makeProxy({ ffmpegPath: bins.ffmpeg, file: junk, info: {}, start: 0, duration: 2, out: out('x2.mp4') }); } catch (err) { e = err; }
  ok(e && e.code === 'PROXY_FAILED', 'junk: ' + (e && e.code));
  ok(!fs.existsSync(out('x2.mp4')));
  const ac = new AbortController();
  e = null;
  const p = makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.A, info: { displayWidth: 1280, displayHeight: 720, hasAudio: true }, start: 0, duration: 8, out: out('x3.mp4'), signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  try { await p; } catch (err) { e = err; }
  ok(e && e.code === 'ABORTED', 'abort: ' + (e && e.code));
  await new Promise((r) => setTimeout(r, 400));
  ok(!fs.existsSync(out('x3.mp4')), 'no partial output after cancel');
  const pre = new AbortController();
  pre.abort();
  e = null;
  try { await makeProxy({ ffmpegPath: bins.ffmpeg, file: fx.A, info: {}, start: 0, duration: 2, out: out('x4.mp4'), signal: pre.signal }); } catch (err) { e = err; }
  ok(e && e.code === 'ABORTED');
});

test('a remote path is refused by the input guard (ffmpeg never opens a URL)', async () => {
  let e = null;
  try { await makeProxy({ ffmpegPath: bins.ffmpeg, file: 'http://127.0.0.1:9/x.mp4', info: {}, start: 0, duration: 2, out: out('x5.mp4') }); } catch (err) { e = err; }
  ok(e && e.code === 'PROXY_FAILED', 'url: ' + (e && e.code));
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); passed++; console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
  }
  console.log('\ncu-proxy: ' + passed + '/' + queue.length + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
