'use strict';
// Test cases for the export pipeline (see export.test.js for the harness).
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function run(ctx) {
  const { test, approx, truthy, seg, render, checkBasics, zoomReference, psnr, media, h, model, exporter, OUT, fixtures } = ctx;
  const A = media.A;

  await test('01 trim: A[2..5] -> 3 s, 90 frames, bar + audio follow the source', async () => {
    const { outPath } = await render('01_trim', [seg('A', 2, 5)]);
    const s = checkBasics(outPath, 3.0, 1280, 720, 90);
    truthy(s.a && s.a.codec_name === 'aac' && Number(s.a.sample_rate) === 48000 && Number(s.a.channels) === 2, 'audio stream not aac/48k/stereo');
    approx(h.barTime(outPath, 0.2, 1280, 720, 1280, 160), 2.2, 0.05, 'bar time @0.2');
    approx(h.barTime(outPath, 2.5, 1280, 720, 1280, 160), 4.5, 0.05, 'bar time @2.5');
    approx(h.audioFreq(outPath, 0.5, 0.2), 500, 15, 'audio freq @0.5');
    approx(s.a.duration ? Number(s.a.duration) : s.duration, 3.0, 0.1, 'audio duration');
    return `dur=${s.duration.toFixed(3)}`;
  });

  await test('02 split + delete middle: A[0..2] + A[5..8] -> 5 s, joins exact', async () => {
    const { outPath } = await render('02_split_delete', [seg('A', 0, 2), seg('A', 5, 8)]);
    checkBasics(outPath, 5.0, 1280, 720, 150);
    approx(h.barTime(outPath, 1.0, 1280, 720, 1280, 160), 1.0, 0.05, 'bar @1.0');
    approx(h.barTime(outPath, 59 / 30 - 0.01, 1280, 720, 1280, 160), 59 / 30, 0.04, 'last frame of seg 1');
    approx(h.barTime(outPath, 2.0 - 0.001, 1280, 720, 1280, 160), 5.0, 0.04, 'first frame of seg 2');
    approx(h.barTime(outPath, 2.5, 1280, 720, 1280, 160), 5.5, 0.05, 'bar @2.5');
    approx(h.audioFreq(outPath, 1.5, 0.2), 400, 15, 'audio @1.5');
    approx(h.audioFreq(outPath, 2.5, 0.2), 800, 15, 'audio @2.5 (source 5.5)');
    const s = h.streamsOf(outPath);
    approx(Number(s.a.duration), 5.0, 0.1, 'audio duration');
  });

  await test('03 merge A(audio 16:9 30fps) + B(silent 4:3 25fps): letterbox, silence padding, fps unify', async () => {
    const { outPath } = await render('03_merge', [seg('A', 0, 3), seg('B', 0, 2)]);
    const s = checkBasics(outPath, 5.0, 1280, 720, 150);
    approx(eval(s.v.avg_frame_rate), 30, 0.01, 'fps');
    // B is 640x480 -> 960x720 centred at x=160 (pillarbox)
    const buf = h.grayFrame(outPath, 4.0, 1280, 720);
    let leftSum = 0;
    let n = 0;
    for (let y = 100; y < 620; y += 20) for (let x = 0; x < 150; x++) { leftSum += buf[y * 1280 + x]; n++; }
    truthy(leftSum / n < 24, 'pillarbox bars are not black: ' + (leftSum / n));
    const cx = h.barCentroid(buf, 1280, 720);
    // B bar at local t=1.0 -> x=128 (+3 half width) of 640 -> *1.5 + 160
    approx(cx, 160 + (128 + 3) * 1.5, 4, 'B bar x');
    approx(h.audioFreq(outPath, 1.5, 0.2), 400, 15, 'A audio');
    const vol = h.meanVolume(outPath, 3.2, 1.6);
    truthy(vol < -80, 'B region must be silent, mean volume ' + vol);
    approx(Number(s.a.duration), 5.0, 0.1, 'audio duration');
  });

  await test('04 speed 2x: A[0..8] -> 4 s, pitch preserved (atempo)', async () => {
    const { outPath } = await render('04_speed2x', [seg('A', 0, 8, { speed: 2 })]);
    checkBasics(outPath, 4.0, 1280, 720, 120);
    approx(h.barTime(outPath, 1.0, 1280, 720, 1280, 160), 2.0, 0.08, 'bar @1.0');
    approx(h.barTime(outPath, 3.0, 1280, 720, 1280, 160), 6.0, 0.08, 'bar @3.0');
    approx(h.audioFreq(outPath, 1.0, 0.2), 500, 20, 'audio @1.0 (src 2.0..2.4)');
    approx(h.audioFreq(outPath, 3.0, 0.2), 900, 20, 'audio @3.0 (src 6.0..6.4)');
    approx(Number(h.streamsOf(outPath).a.duration), 4.0, 0.1, 'audio duration');
  });

  await test('05 slow motion 0.5x: A[2..6] -> 8 s', async () => {
    const { outPath } = await render('05_slow05', [seg('A', 2, 6, { speed: 0.5 })]);
    checkBasics(outPath, 8.0, 1280, 720, 240);
    approx(h.barTime(outPath, 2.0, 1280, 720, 1280, 160), 3.0, 0.08, 'bar @2.0');
    approx(h.barTime(outPath, 6.0, 1280, 720, 1280, 160), 5.0, 0.08, 'bar @6.0');
    approx(h.audioFreq(outPath, 4.0, 0.2), 700, 20, 'audio @4.0 (src 4.0)');
    approx(Number(h.streamsOf(outPath).a.duration), 8.0, 0.1, 'audio duration');
  });

  await test('06 extremes: 8x (A[0..8] -> 1 s) and 0.25x (A[0..2] -> 8 s)', async () => {
    const a = await render('06_speed8x', [seg('A', 0, 8, { speed: 8 })]);
    checkBasics(a.outPath, 1.0, 1280, 720, 30);
    approx(Number(h.streamsOf(a.outPath).a.duration), 1.0, 0.08, '8x audio duration');
    const b = await render('06_speed025x', [seg('A', 0, 2, { speed: 0.25 })]);
    checkBasics(b.outPath, 8.0, 1280, 720, 240);
    approx(Number(h.streamsOf(b.outPath).a.duration), 8.0, 0.1, '0.25x audio duration');
    approx(h.barTime(b.outPath, 4.0, 1280, 720, 1280, 160), 1.0, 0.08, '0.25x bar @4.0');
  });

  /* ---------- zoom: compare real output frames with an independent JS reference ---------- */
  async function zoomCheck(label, outPath, srcMedia, segObj, fps, frames, minPsnr) {
    const W = 1280;
    const H = 720;
    const nf = model.frameCount(segObj, { value: fps });
    const lines = [];
    for (const n of frames) {
      const tOut = Math.max(0, n / fps - 0.001);
      const exported = h.grayFrame(outPath, tOut, W, H);
      const srcT = Math.max(0, segObj.in + (n / fps) * segObj.speed - 0.001);
      const src = h.grayFrame(srcMedia.path, srcT, W, H);
      const z = model.zoomAt(segObj, n / nf);
      const ref = zoomReference(src, W, H, z, segObj.fx, segObj.fy);
      const p = psnr(exported, ref);
      lines.push(`n=${n} z=${z.toFixed(3)} psnr=${p.toFixed(1)}`);
      truthy(p >= minPsnr, `${label}: frame ${n} PSNR ${p.toFixed(1)} dB < ${minPsnr} dB (z=${z.toFixed(3)})`);
    }
    return lines.join(' | ');
  }

  await test('07 zoom IN 1.0->2.0 (centre): output frames match the reference geometry', async () => {
    const s = seg('A', 0, 4, { zoomFrom: 1, zoomTo: 2, fx: 0.5, fy: 0.5 });
    const { outPath } = await render('07_zoom_in', [s], { quality: 'high' });
    checkBasics(outPath, 4.0, 1280, 720, 120);
    return await zoomCheck('zoom in', outPath, A, s, 30, [0, 30, 60, 90, 119], 30);
  });

  await test('08 zoom OUT 2.5->1.0 (off-centre focus 0.7/0.3) on A[2..6]', async () => {
    const s = seg('A', 2, 6, { zoomFrom: 2.5, zoomTo: 1, fx: 0.7, fy: 0.3 });
    const { outPath } = await render('08_zoom_out', [s], { quality: 'high' });
    checkBasics(outPath, 4.0, 1280, 720, 120);
    return await zoomCheck('zoom out', outPath, A, s, 30, [0, 40, 80, 119], 30);
  });

  await test('09 static zoom 1.5x with clamped corner focus (0.1/0.9)', async () => {
    const s = seg('A', 0, 3, { zoomFrom: 1.5, zoomTo: 1.5, fx: 0.1, fy: 0.9 });
    const { outPath } = await render('09_zoom_static', [s], { quality: 'high' });
    checkBasics(outPath, 3.0, 1280, 720, 90);
    return await zoomCheck('static zoom', outPath, A, s, 30, [0, 45, 89], 30);
  });

  await test('10 zoom + speed 2x combined (1->3, focus 0.25/0.5)', async () => {
    const s = seg('A', 0, 8, { speed: 2, zoomFrom: 1, zoomTo: 3, fx: 0.25, fy: 0.5 });
    const { outPath } = await render('10_zoom_speed', [s], { quality: 'high' });
    checkBasics(outPath, 4.0, 1280, 720, 120);
    return await zoomCheck('zoom+speed', outPath, A, s, 30, [0, 60, 119], 28);
  });

  await test('11 zoom on a downscaled canvas (supersampling path, 480p output)', async () => {
    const s = seg('A', 0, 3, { zoomFrom: 1, zoomTo: 2.5, fx: 0.5, fy: 0.5 });
    const { outPath, plan } = await render('11_zoom_ss', [s], { resolution: 480, quality: 'high' });
    truthy(plan.items[0].k > 1.2, 'supersampling not engaged: k=' + plan.items[0].k);
    checkBasics(outPath, 3.0, 854, 480, 90);
    // last frame: window (1/z) of the source scaled to 854x480 must contain the bar's source region -> just compare with reference built from the full-res source
    const n = 89;
    const z = model.zoomAt(s, n / 90);
    const src = h.grayFrame(A.path, n / 30 - 0.001, 1280, 720);
    const ref = zoomReference(src, 1280, 720, z, 0.5, 0.5);
    const refFile = path.join(OUT, '11_ref.raw');
    fs.writeFileSync(refFile, Buffer.from(ref.map((v) => Math.round(v))));
    const r = h.ff(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '1280x720', '-i', refFile, '-vf', 'scale=854:480:flags=bicubic', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
    const exported = h.grayFrame(outPath, n / 30 - 0.001, 854, 480);
    const p = psnr(exported, r.stdout);
    truthy(p > 26, 'supersampled frame PSNR ' + p.toFixed(1));
    return `k=${plan.items[0].k.toFixed(2)} psnr=${p.toFixed(1)}`;
  });

  await test('12 rotated phone video (display matrix 90deg) exports upright 720x1280', async () => {
    const C = media.C;
    truthy(C.displayWidth === 720 && C.displayHeight === 1280 && C.rotation !== 0, `probe rotation/display size wrong: ${C.displayWidth}x${C.displayHeight} rot=${C.rotation}`);
    const { outPath } = await render('12_rotated', [seg('C', 0, 3)]);
    const s = checkBasics(outPath, 3.0, 720, 1280, 90);
    truthy(!s.v.side_data_list || !s.v.side_data_list.some((d) => d.rotation), 'output must not carry rotation metadata');
    // The source bar is vertical and moves horizontally; after rotation it must be a horizontal band moving vertically.
    const bandOf = (t) => {
      const buf = h.grayFrame(outPath, t, 720, 1280);
      let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1; let sy = 0; let cnt = 0;
      for (let y = 0; y < 1280; y++) for (let x = 0; x < 720; x++) {
        if (buf[y * 720 + x] >= 235) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sy += y + 0.5; cnt++; }
      }
      return { w: maxX - minX + 1, hgt: maxY - minY + 1, cy: sy / cnt };
    };
    const b1 = bandOf(0.5);
    const b2 = bandOf(2.5);
    truthy(b1.w > 680 && b1.hgt < 20, `bar must be a horizontal band, got ${b1.w}x${b1.hgt}`);
    truthy(Math.abs(b2.cy - b1.cy) > 300, `band must move vertically: ${b1.cy} -> ${b2.cy}`);
    return `band ${b1.w}x${b1.hgt}, cy ${b1.cy.toFixed(0)} -> ${b2.cy.toFixed(0)}`;
  });

  await test('13 Turkish / Unicode paths for input and output (ş ğ ı İ ö ç ü)', async () => {
    const outDir = path.join(OUT, 'Çıktı Klasörü ğüşiöç');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'çıktı_ŞĞİ video.mp4');
    const e = media.E;
    const { res } = await render('13_turkish', [seg('E', 0, 3.5)], {}, { outPath });
    truthy(fs.existsSync(outPath), 'output file missing');
    truthy(!fs.existsSync(outPath + '.part'), '.part left behind');
    checkBasics(outPath, 3.5, 1280, 720, 105);
    return `in=${path.basename(e.path)} out=${path.basename(outPath)} size=${res.size}`;
  });

  await test('14 fades: black at both ends, silent at the edges', async () => {
    const { outPath } = await render('14_fade', [seg('A', 0, 3, { fadeIn: 1, fadeOut: 1 })]);
    checkBasics(outPath, 3.0, 1280, 720, 90);
    const l0 = h.meanLuma(outPath, 0, 1280, 720);
    const lm = h.meanLuma(outPath, 1.5, 1280, 720);
    const l1 = h.meanLuma(outPath, 2.9, 1280, 720);
    truthy(l0 < 25 && l1 < 30 && lm > 40, `luma start ${l0.toFixed(1)} mid ${lm.toFixed(1)} end ${l1.toFixed(1)}`);
    const v0 = h.meanVolume(outPath, 0, 0.08);
    const vm = h.meanVolume(outPath, 1.2, 0.5);
    truthy(v0 < vm - 12, `audio fade-in: start ${v0} mid ${vm}`);
    return `luma ${l0.toFixed(0)}/${lm.toFixed(0)}/${l1.toFixed(0)} vol ${v0}/${vm}`;
  });

  await test('15 volume 50% (-6 dB) and mute (silence)', async () => {
    const full = await render('15_vol_full', [seg('A', 0, 2)]);
    const half = await render('15_vol_half', [seg('A', 0, 2, { volume: 0.5 })]);
    const mute = await render('15_vol_mute', [seg('A', 0, 2, { mute: true })]);
    const vf = h.meanVolume(full.outPath, 0.2, 1.5);
    const vh = h.meanVolume(half.outPath, 0.2, 1.5);
    const vm = h.meanVolume(mute.outPath, 0.2, 1.5);
    approx(vf - vh, 6.02, 1.0, 'half volume delta dB');
    truthy(vm < -80, 'mute not silent: ' + vm);
    truthy(h.streamsOf(mute.outPath).a, 'muted export must still have an audio track');
    return `full ${vf} half ${vh} mute ${vm}`;
  });

  await test('16 progress callbacks + cancel removes partial output', async () => {
    const segs = [];
    for (let i = 0; i < 12; i++) segs.push(seg('A', 0, 8));
    const outPath = path.join(OUT, '16_cancel.mp4');
    if (fs.existsSync(outPath)) fs.rmSync(outPath);
    const fractions = [];
    let cancelled = false;
    const job = exporter.runExport({
      ffmpegPath: h.bins.ffmpeg, segments: segs, media: ctx.mediaMap(), settings: Object.assign({}, ctx.DEFAULT_SETTINGS, { quality: 'high' }), outPath,
      onProgress: (p) => {
        fractions.push(p.fraction);
        if (!cancelled && p.fraction > 0.03) { cancelled = true; job.cancel(); }
      },
    });
    let err = null;
    try { await job.promise; } catch (e) { err = e; }
    truthy(err && err.code === 'CANCELLED', 'expected CANCELLED, got ' + (err && err.code));
    truthy(!fs.existsSync(outPath) && !fs.existsSync(outPath + '.part'), 'partial files not removed');
    truthy(fractions.length >= 2, 'no progress callbacks');
    for (let i = 1; i < fractions.length; i++) truthy(fractions[i] >= fractions[i - 1] - 1e-9, 'progress not monotonic');
    return `progress events=${fractions.length} cancelledAt=${(fractions[fractions.length - 1] * 100).toFixed(1)}%`;
  });

  await test('17 error handling: missing output folder, locked output, vanished input', async () => {
    // missing folder
    const e1 = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: [seg('A', 0, 1)], media: ctx.mediaMap(), settings: ctx.DEFAULT_SETTINGS, outPath: path.join(OUT, 'does', 'not', 'exist', 'x.mp4') });
    let c1 = null;
    try { await e1.promise; } catch (e) { c1 = e.code; }
    truthy(c1 === 'OUT_DIR', 'missing folder code: ' + c1);
    // locked output (file held open for writing by another handle)
    const lockPath = path.join(OUT, '17_locked.mp4');
    fs.writeFileSync(lockPath, 'x');
    const fd = fs.openSync(lockPath, 'r');
    // On Windows an open handle opened without share-delete makes rename/overwrite fail; node opens with sharing so emulate through a read-only attribute
    fs.closeSync(fd);
    fs.chmodSync(lockPath, 0o444);
    const e2 = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: [seg('A', 0, 1)], media: ctx.mediaMap(), settings: ctx.DEFAULT_SETTINGS, outPath: lockPath });
    let c2 = null;
    try { await e2.promise; } catch (e) { c2 = e.code; }
    fs.chmodSync(lockPath, 0o666);
    fs.rmSync(lockPath, { force: true });
    truthy(c2 === 'OUT_BUSY', 'read-only output code: ' + c2);
    // input vanished after import
    const tmp = path.join(OUT, '17_vanish.mp4');
    fs.copyFileSync(A.path, tmp);
    const info = await require('../src/main/probe').probe(h.bins, tmp);
    info.id = 'm_vanish';
    fs.rmSync(tmp);
    const mm = Object.assign({}, ctx.mediaMap(), { m_vanish: info });
    const s3 = model.createSegment(info, { in: 0, out: 2 });
    const e3 = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: [s3], media: mm, settings: ctx.DEFAULT_SETTINGS, outPath: path.join(OUT, '17_vanish_out.mp4') });
    let k3 = null;
    let code3 = null;
    try { await e3.promise; } catch (e) { code3 = e.code; k3 = e.kind; }
    truthy(code3 === 'FFMPEG_FAILED' && k3 === 'IO_PATH', `vanished input -> ${code3}/${k3}`);
    truthy(!fs.existsSync(path.join(OUT, '17_vanish_out.mp4.part')), '.part left behind after failure');
    return 'OUT_DIR, OUT_BUSY, FFMPEG_FAILED/IO_PATH';
  });

  await test('18 many segments (40 inputs, mixed speed/zoom/fade) via filter script file', async () => {
    const segs = [];
    let expected = 0;
    for (let i = 0; i < 40; i++) {
      const start = (i % 7) * 1.0;
      const s = seg('A', start, start + 0.4 + (i % 3) * 0.1, { speed: [1, 2, 0.5, 4][i % 4], zoomFrom: i % 5 === 0 ? 1 : 1, zoomTo: i % 5 === 0 ? 1.8 : 1, fx: 0.3 + (i % 4) * 0.1, fadeIn: i % 6 === 0 ? 0.1 : 0 });
      segs.push(s);
      expected += model.frameCount(s, { value: 30 }) / 30;
    }
    const { outPath, plan } = await render('18_many', segs, { quality: 'low' });
    const frames = h.countFrames(outPath);
    const exFrames = segs.reduce((a, s) => a + model.frameCount(s, { value: 30 }), 0);
    truthy(frames === exFrames, `frames ${frames} != ${exFrames}`);
    approx(h.streamsOf(outPath).duration, expected, 0.1, 'duration');
    return `segments=${segs.length} script=${exporter.buildFilterGraph(plan).length} chars frames=${frames}`;
  });

  await test('19 mixed orientations + 16:9 canvas @480p/25fps: portrait, 4:3 and 16:9 letterboxed together', async () => {
    const segs = [seg('C', 0, 2), seg('A', 0, 2), seg('B', 0, 2)];
    const { outPath } = await render('19_mixed', segs, { aspect: '16:9', resolution: 480, fps: 25, quality: 'low' });
    const s = checkBasics(outPath, 6.0, 854, 480, 150);
    approx(eval(s.v.avg_frame_rate), 25, 0.01, 'fps');
    // portrait clip (720x1280) centred in 854x480 => 270x480 content, black sides
    const buf = h.grayFrame(outPath, 1.0, 854, 480);
    let side = 0; let n = 0;
    for (let y = 40; y < 440; y += 10) for (let x = 0; x < 200; x++) { side += buf[y * 854 + x]; n++; }
    truthy(side / n < 24, 'portrait side bars not black: ' + side / n);
    return 'ok';
  });

  await test('20 project without any audio track exports video-only', async () => {
    const { outPath } = await render('20_noaudio', [seg('B', 0, 3)]);
    const s = checkBasics(outPath, 3.0, 640, 480, 75);
    truthy(!s.a, 'unexpected audio stream');
  });

  await test('21 legacy AVI (MPEG-4 + MP3) input exports to H.264/AAC mp4', async () => {
    const { outPath } = await render('21_avi', [seg('D', 0, 3)]);
    const s = checkBasics(outPath, 3.0, 480, 270, 72);
    truthy(s.a && s.a.codec_name === 'aac', 'audio stream');
    approx(h.audioFreq(outPath, 1.0, 0.3), 440, 20, 'AVI audio tone');
  });

  await test('22 NTSC 29.97 fps 1080p mono source: keeps 30000/1001 fps, stereo 48 kHz AAC, merges with a 30 fps clip', async () => {
    const { outPath } = await render('22_ntsc', [seg('F', 0, 3), seg('A', 0, 2)]);
    const s = h.streamsOf(outPath);
    truthy(s.v.avg_frame_rate === '30000/1001', 'fps ' + s.v.avg_frame_rate);
    truthy(Number(s.v.width) === 1920 && Number(s.v.height) === 1080, 'size ' + s.v.width + 'x' + s.v.height);
    truthy(Number(s.a.channels) === 2 && Number(s.a.sample_rate) === 48000, 'audio format');
    truthy(h.countFrames(outPath) === 150, 'frames ' + h.countFrames(outPath));
    approx(s.duration, 150 / (30000 / 1001), 0.1, 'duration');
    approx(h.audioFreq(outPath, 1.0, 0.3), 600, 25, 'mono tone survives upmix');
  });

  await test('23 the output may never be a source video of the project (also through case / hard-link aliases); the source stays intact', async () => {
    const copyPath = path.join(OUT, '23_source_copy.mp4');
    fs.copyFileSync(A.path, copyPath);
    const info = await require('../src/main/probe').probe(h.bins, copyPath);
    info.id = 'm_copy';
    const mm = Object.assign({}, ctx.mediaMap(), { m_copy: info });
    const before = fs.statSync(copyPath);
    const s = model.createSegment(info, { in: 0, out: 2 });
    const attempts = [copyPath, copyPath.toUpperCase().replace(/\.MP4$/, '.mp4')];
    const link = path.join(OUT, '23_hardlink.mp4');
    try { fs.rmSync(link, { force: true }); fs.linkSync(copyPath, link); attempts.push(link); } catch (e) { /* hard links unavailable on this volume */ }
    for (const target of attempts) {
      const job = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: [s], media: mm, settings: ctx.DEFAULT_SETTINGS, outPath: target });
      let code = null;
      try { await job.promise; } catch (e) { code = e.code; }
      truthy(code === 'OUT_IS_SOURCE', `${path.basename(target)} -> ${code}`);
    }
    const after = fs.statSync(copyPath);
    truthy(after.size === before.size && after.mtimeMs === before.mtimeMs, 'the source file was modified');
    truthy(!fs.existsSync(copyPath + '.part'), '.part left behind');
    fs.rmSync(link, { force: true });
    fs.rmSync(copyPath, { force: true });
    return `${attempts.length} aliases refused`;
  });

  await test('24 thread budget: few clips use up to 8 decoder threads, many clips drop to 1 (memory), 4K canvases cap the encoder', async () => {
    const plan = (n, key, canvasKey) => exporter.buildPlan({
      segments: Array.from({ length: n }, (_, i) => seg(key, 0, 1)), media: ctx.mediaMap(), settings: Object.assign({}, ctx.DEFAULT_SETTINGS, {}), outPath: 'x.mp4', canvasKey,
    });
    const one = exporter.threadPlan(plan(1, 'A'), 24);
    truthy(one.input === 8 && one.encoder === 0, 'single 720p clip: ' + JSON.stringify(one));
    const many = exporter.threadPlan(plan(120, 'F'), 24);
    truthy(many.input === 1, '120 x 1080p clips: ' + JSON.stringify(many));
    const forty = exporter.threadPlan(plan(40, 'F'), 24);
    truthy(forty.input >= 3 && forty.input <= 5, '40 x 1080p clips: ' + JSON.stringify(forty));
    const small = exporter.threadPlan(plan(1, 'A'), 2);
    truthy(small.input === 2, 'never more threads than cores: ' + JSON.stringify(small));
    const p4k = exporter.buildPlan({ segments: [seg('A', 0, 1)], media: ctx.mediaMap(), settings: Object.assign({}, ctx.DEFAULT_SETTINGS, { resolution: '1080' }), outPath: 'x.mp4' });
    p4k.canvas = { width: 3840, height: 2160 };
    truthy(exporter.threadPlan(p4k, 24).encoder === 12, '4K canvas caps the x264 pool at 12');
    return `1 clip: ${one.input}, 40 clips: ${forty.input}, 120 clips: ${many.input}`;
  });

  await test('25 150 cuts of a 1080p file (150 inputs, threads budgeted): exact length and frame count, no leftovers', async () => {
    const segs = [];
    for (let i = 0; i < 150; i++) segs.push(seg('F', (i % 12) * 0.2, (i % 12) * 0.2 + 0.1));
    const { outPath, plan } = await render('25_150cuts', segs, { quality: 'low' });
    const frames = h.countFrames(outPath);
    const expected = segs.reduce((a, s) => a + model.frameCount(s, plan.fps), 0);
    truthy(frames === expected, `frames ${frames} != ${expected}`);
    truthy(plan.items.length === 150, 'items');
    const left = fs.readdirSync(os.tmpdir()).filter((n) => /^ve-export-/.test(n) && fs.existsSync(path.join(os.tmpdir(), n, 'graph.txt')));
    truthy(left.length === 0, 'temp folders left behind: ' + left.join(','));
    return `frames=${frames}`;
  });

  await test('26 very long command lines: input paths are aliased (hard links) or the export is refused with TOO_MANY_CLIPS', async () => {
    const segs = [seg('A', 0, 0.5), seg('A', 1, 1.5), seg('E', 0, 0.5), seg('A', 3, 3.5)];
    const outPath = path.join(OUT, '26_alias.mp4');
    fs.rmSync(outPath, { force: true });
    const job = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: segs, media: ctx.mediaMap(), settings: ctx.DEFAULT_SETTINGS, outPath, commandLimits: { soft: 400, hard: 31500 } });
    await job.promise;
    const inputs = job.args.filter((a, i) => job.args[i - 1] === '-i');
    const aliased = inputs.every((p) => !path.isAbsolute(p));
    truthy(h.countFrames(outPath) === 60, 'frames ' + h.countFrames(outPath));
    truthy(!fs.existsSync(outPath + '.part'), '.part left');
    // refusal when even the aliased command line is too long
    const refused = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: segs, media: ctx.mediaMap(), settings: ctx.DEFAULT_SETTINGS, outPath: path.join(OUT, '26_refused.mp4'), commandLimits: { soft: 100, hard: 200 } });
    let code = null;
    try { await refused.promise; } catch (e) { code = e.code; }
    truthy(code === 'TOO_MANY_CLIPS', 'refusal code ' + code);
    truthy(!fs.existsSync(path.join(OUT, '26_refused.mp4')), 'refused export left a file');
    return aliased ? `aliased inputs: ${inputs.join(', ')}` : 'hard links unavailable on this volume: real paths kept (still exported)';
  });

  await test('27 final rename survives a short lock on the destination (antivirus scan): retried until released', async () => {
    const from = path.join(OUT, '27_from.tmp');
    const to = path.join(OUT, '27_to.mp4');
    fs.writeFileSync(from, 'new content');
    fs.writeFileSync(to, 'old content');
    // hold an exclusive lock on the destination for ~1.6 s from a helper process
    const ps = require('child_process').spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${to.replace(/'/g, "''")}','Open','Read','None'); Write-Output LOCKED; Start-Sleep -Milliseconds 1600; $f.Close()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => ps.stdout.on('data', (d) => { if (String(d).includes('LOCKED')) resolve(); }));
    let firstTry = null;
    try { fs.renameSync(from, to); firstTry = 'renamed'; } catch (e) { firstTry = e.code; }
    truthy(firstTry !== 'renamed', 'the lock helper did not block the rename (' + firstTry + ')');
    const t0 = Date.now();
    await exporter.renameWithRetry(from, to, 10, 400);
    truthy(fs.readFileSync(to, 'utf8') === 'new content' && !fs.existsSync(from), 'destination not replaced');
    // a persistent failure is still reported
    fs.writeFileSync(from, 'x');
    let err = null;
    try { await exporter.renameWithRetry(from, path.join(OUT, 'no-such-folder', 'x.mp4'), 3, 50); } catch (e) { err = e; }
    truthy(err && err.code === 'ENOENT', 'non-retryable errors are thrown immediately');
    fs.rmSync(from, { force: true });
    fs.rmSync(to, { force: true });
    return `first attempt: ${firstTry}, succeeded after ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  });
};
