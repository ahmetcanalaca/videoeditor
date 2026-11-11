'use strict';
// Optional verification + benchmark: 4K (3840x2160) @ 60 fps sources through the real export pipeline.
// Not part of `npm test` (it is slow and CPU heavy): run with `node tests/export-4k60.test.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');
const model = require('../src/shared/model');
const { probe } = require('../src/main/probe');
const exporter = require('../src/main/exporter');

const OUT = path.join(__dirname, 'out', '4k60');
fs.mkdirSync(OUT, { recursive: true });
const results = [];

function approx(a, e, tol, label) { if (!(Math.abs(a - e) <= tol)) throw new Error(`${label}: expected ${e} ±${tol}, got ${a}`); }
function truthy(c, m) { if (!c) throw new Error(m); }

// Peak working set (MB) of all ffmpeg.exe processes, sampled while an export runs.
function startMemSampler() {
  let peak = 0;
  const timer = setInterval(() => {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    for (const line of (r.stdout || '').split('\n')) {
      const m = /"ffmpeg\.exe","\d+","[^"]*","\d+","([\d.,\s]+) K"/i.exec(line);
      if (m) peak = Math.max(peak, Number(m[1].replace(/[^\d]/g, '')) / 1024);
    }
  }, 400);
  return () => { clearInterval(timer); return peak; };
}

async function test(name, fn) {
  if (process.argv.length > 2 && !process.argv.slice(2).some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)  ${detail || ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}

(async () => {
  const fx = h.makeFixtures();
  const H = path.join(h.FIX, 'H_4k60.mp4');
  if (!fs.existsSync(H)) {
    console.log('generating the 4K60 fixture (6 s, H.264) ...');
    const t0 = Date.now();
    h.ff(['-f', 'lavfi', '-i', h.patternSource(3840, 2160, 60, 6, '0x203040', 480),
      '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(300+100*floor(t))*t)|0.5*sin(2*PI*(300+100*floor(t))*t)':s=48000:d=6",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '160k', '-y', H]);
    console.log(`fixture ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(fs.statSync(H).size / 1048576).toFixed(1)} MB`);
  }

  const media = {};
  const I = path.join(h.FIX, 'I_4k60_hevc10.mp4');
  if (!fs.existsSync(I)) {
    console.log('generating the 4K60 HEVC 10-bit fixture (2 s, like a phone/camera clip) ...');
    const t0 = Date.now();
    h.ff(['-f', 'lavfi', '-i', h.patternSource(3840, 2160, 60, 2, '0x203040', 480),
      '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(300+100*floor(t))*t)|0.5*sin(2*PI*(300+100*floor(t))*t)':s=48000:d=2",
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:keyint=60', '-c:a', 'aac', '-b:a', '160k', '-y', I]);
    console.log(`fixture ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(fs.statSync(I).size / 1048576).toFixed(1)} MB`);
  }
  for (const [k, p] of Object.entries({ H, I, A: fx.A, F: fx.F })) { const i = await probe(h.bins, p); i.id = 'm_' + k; media[k] = i; }
  const mediaMap = () => Object.fromEntries(Object.values(media).map((m) => [m.id, m]));
  const seg = (k, a, b, extra) => model.createSegment(media[k], Object.assign({ in: a, out: b }, extra || {}));

  async function render(name, segments, settings) {
    const outPath = path.join(OUT, name + '.mp4');
    fs.rmSync(outPath, { force: true });
    const stop = startMemSampler();
    const t0 = Date.now();
    const job = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments, media: mediaMap(), settings: Object.assign({ resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'medium' }, settings || {}), outPath });
    await job.promise;
    const wall = (Date.now() - t0) / 1000;
    return { outPath, wall, plan: job.plan, peakMB: stop(), speed: job.plan.totalDuration / wall };
  }
  const fmt = (r) => `${r.plan.totalDuration.toFixed(1)} s of video in ${r.wall.toFixed(1)} s = ${r.speed.toFixed(2)}x realtime, ffmpeg peak ${r.peakMB.toFixed(0)} MB`;

  await test('K1 probe: 3840x2160 @ 60 fps H.264 is read correctly and plays natively (no proxy)', async () => {
    const m = media.H;
    truthy(m.displayWidth === 3840 && m.displayHeight === 2160, 'size');
    approx(m.fps, 60, 0.01, 'fps');
    truthy(!m.needsProxy, 'unexpected proxy');
    return `${m.vcodec} ${m.displayWidth}x${m.displayHeight} @${m.fps} fps, ${(m.size / 1048576).toFixed(1)} MB`;
  });

  await test('K2 trim only, quality "medium": output stays 3840x2160 @ 60 fps with sound, content in sync', async () => {
    const r = await render('k2_trim', [seg('H', 1, 4)]);
    const s = h.streamsOf(r.outPath);
    truthy(Number(s.v.width) === 3840 && Number(s.v.height) === 2160, 'size ' + s.v.width + 'x' + s.v.height);
    truthy(s.v.avg_frame_rate === '60/1', 'fps ' + s.v.avg_frame_rate);
    approx(s.duration, 3.0, 0.1, 'duration');
    truthy(h.countFrames(r.outPath) === 180, 'frames ' + h.countFrames(r.outPath));
    truthy(s.a && s.a.codec_name === 'aac' && Number(s.a.sample_rate) === 48000, 'audio');
    approx(h.barTime(r.outPath, 0.5, 3840, 2160, 3840, 480), 1.5, 0.04, 'bar time @0.5');
    approx(h.audioFreq(r.outPath, 0.5, 0.2), 400, 15, 'audio freq @0.5 (source t=1.5)');
    return `${fmt(r)}, level ${s.v.level}, ${(fs.statSync(r.outPath).size / 1048576).toFixed(1)} MB`;
  });

  await test('K3 quality "high" (x264 medium, crf 18)', async () => {
    const r = await render('k3_high', [seg('H', 0, 3)], { quality: 'high' });
    truthy(h.countFrames(r.outPath) === 180, 'frames');
    return `${fmt(r)}, ${(fs.statSync(r.outPath).size / 1048576).toFixed(1)} MB`;
  });

  await test('K4 zoom in 1->2 at 4K60: frames equal an independent reference', async () => {
    const s = seg('H', 0, 3, { zoomFrom: 1, zoomTo: 2, fx: 0.7, fy: 0.4 });
    const r = await render('k4_zoom', [s]);
    truthy(h.countFrames(r.outPath) === 180, 'frames');
    const W = 3840; const HH = 2160;
    const clip = (v, a, b) => Math.min(Math.max(v, a), b);
    const lines = [];
    for (const n of [0, 90, 179]) {
      const z = model.zoomAt(s, n / 180);
      const win = model.cropWindow(z, s.fx, s.fy);
      const exported = h.grayFrame(r.outPath, Math.max(0, n / 60 - 0.001), W, HH);
      const src = h.grayFrame(H, Math.max(0, n / 60 - 0.001), W, HH);
      const X0 = win.x * W; const Y0 = win.y * HH;
      let mse = 0; let cnt = 0;
      for (let y = 0; y < HH; y += 3) {
        for (let x = 0; x < W; x += 3) {
          const sx = clip(X0 + (x + 0.5) / z - 0.5, 0, W - 1); const sy = clip(Y0 + (y + 0.5) / z - 0.5, 0, HH - 1);
          const x0 = Math.floor(sx); const y0 = Math.floor(sy); const x1 = Math.min(x0 + 1, W - 1); const y1 = Math.min(y0 + 1, HH - 1);
          const fx = sx - x0; const fy = sy - y0;
          const v = (src[y0 * W + x0] * (1 - fx) + src[y0 * W + x1] * fx) * (1 - fy) + (src[y1 * W + x0] * (1 - fx) + src[y1 * W + x1] * fx) * fy;
          const d = exported[y * W + x] - v; mse += d * d; cnt++;
        }
      }
      const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / (mse / cnt));
      lines.push(`n=${n} z=${z.toFixed(2)} psnr=${psnr.toFixed(1)}`);
      truthy(psnr > 32, `frame ${n}: PSNR ${psnr.toFixed(1)} dB`);
    }
    return `${fmt(r)} | ${lines.join(' | ')}`;
  });

  await test('K5 speed 2x at 60 fps: 6 s -> 3 s, 180 frames, pitch preserved', async () => {
    const r = await render('k5_speed2', [seg('H', 0, 6, { speed: 2 })]);
    truthy(h.countFrames(r.outPath) === 180, 'frames');
    approx(h.streamsOf(r.outPath).duration, 3.0, 0.1, 'duration');
    approx(h.barTime(r.outPath, 1.0, 3840, 2160, 3840, 480), 2.0, 0.06, 'bar @1.0');
    approx(h.audioFreq(r.outPath, 1.0, 0.2), 500, 25, 'audio @1.0');
    return fmt(r);
  });

  await test('K6 slow motion 0.5x at 60 fps: 2 s -> 4 s, 240 frames', async () => {
    const r = await render('k6_slow', [seg('H', 1, 3, { speed: 0.5 })]);
    truthy(h.countFrames(r.outPath) === 240, 'frames ' + h.countFrames(r.outPath));
    approx(h.streamsOf(r.outPath).duration, 4.0, 0.1, 'duration');
    return fmt(r);
  });

  await test('K7 merge 4K60 + 720p30 clip: canvas = first clip (3840x2160 @60), second clip conformed', async () => {
    const r = await render('k7_merge', [seg('H', 0, 2), seg('A', 0, 2)]);
    const s = h.streamsOf(r.outPath);
    truthy(Number(s.v.width) === 3840 && s.v.avg_frame_rate === '60/1', 'canvas');
    truthy(h.countFrames(r.outPath) === 240, 'frames ' + h.countFrames(r.outPath));
    approx(s.duration, 4.0, 0.1, 'duration');
    return fmt(r);
  });

  await test('K8 everyday case: 4K60 -> 1080p60 (resolution option), medium quality', async () => {
    const r = await render('k8_1080p', [seg('H', 0, 6)], { resolution: '1080' });
    const s = h.streamsOf(r.outPath);
    truthy(Number(s.v.width) === 1920 && Number(s.v.height) === 1080 && s.v.avg_frame_rate === '60/1', 'size/fps ' + s.v.width + 'x' + s.v.height + ' ' + s.v.avg_frame_rate);
    truthy(h.countFrames(r.outPath) === 360, 'frames');
    return fmt(r);
  });

  await test('K9 fps option: 4K60 -> 30 fps', async () => {
    const r = await render('k9_30fps', [seg('H', 0, 4)], { fps: '30' });
    const s = h.streamsOf(r.outPath);
    truthy(s.v.avg_frame_rate === '30/1', 'fps ' + s.v.avg_frame_rate);
    truthy(h.countFrames(r.outPath) === 120, 'frames');
    return fmt(r);
  });

  await test('K10 4K60 with zoom on 6 clips (6 decoders opened at once): memory stays reasonable', async () => {
    const segs = [];
    for (let i = 0; i < 6; i++) segs.push(seg('H', i * 0.8, i * 0.8 + 1, { zoomFrom: 1, zoomTo: 1.6, fx: 0.3 + i * 0.08, fy: 0.5 }));
    const r = await render('k10_many_zoom', segs);
    truthy(h.countFrames(r.outPath) === 360, 'frames ' + h.countFrames(r.outPath));
    truthy(r.peakMB < 4500, `ffmpeg peak memory ${r.peakMB.toFixed(0)} MB is too high`);
    return fmt(r);
  });

  await test('K11 phone/camera style 4K60 HEVC 10-bit: probe flags it for a preview proxy, export is 8-bit H.264 3840x2160 @ 60 fps', async () => {
    const m = media.I;
    truthy(m.vcodec === 'hevc' && /10/.test(m.pixFmt), `probe ${m.vcodec} ${m.pixFmt}`);
    truthy(m.needsProxy, 'a 10-bit HEVC clip must be flagged for a preview proxy');
    approx(m.fps, 60, 0.01, 'fps');
    const r = await render('k11_hevc10', [seg('I', 0, 2)]);
    const s = h.streamsOf(r.outPath);
    truthy(s.v.codec_name === 'h264' && s.v.pix_fmt === 'yuv420p', 'codec/pix_fmt ' + s.v.codec_name + ' ' + s.v.pix_fmt);
    truthy(Number(s.v.width) === 3840 && Number(s.v.height) === 2160 && s.v.avg_frame_rate === '60/1', 'size/fps');
    truthy(h.countFrames(r.outPath) === 120, 'frames ' + h.countFrames(r.outPath));
    approx(h.barTime(r.outPath, 1.0, 3840, 2160, 3840, 480), 1.0, 0.05, 'bar @1.0');
    return `${m.vcodec} ${m.pixFmt} -> ${s.v.codec_name} ${s.v.pix_fmt}; ${fmt(r)}`;
  });

  await test('K12 HEVC 10-bit 4K60 with zoom and 2x speed', async () => {
    const r = await render('k12_hevc_zoom', [seg('I', 0, 2, { zoomFrom: 1, zoomTo: 1.8, fx: 0.6, fy: 0.4, speed: 2 })]);
    truthy(h.countFrames(r.outPath) === 60, 'frames ' + h.countFrames(r.outPath));
    return fmt(r);
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`CPU: ${os.cpus()[0].model.trim()} x${os.cpus().length}, RAM ${(os.totalmem() / 1073741824).toFixed(0)} GB`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
