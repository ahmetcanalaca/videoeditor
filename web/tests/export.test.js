'use strict';
// Export verification of the web edition: the real page renders real files (WebCodecs + Mediabunny) and the results are measured with ffprobe /
// ffmpeg - the same checks as the desktop edition's FFmpeg export tests, so both engines are held to the same timeline semantics.
//   node tests/export.test.js [case-prefix ...]        (VE_BROWSER=<chrome|edge exe>, headless unless VE_HEADED=1)
const fs = require('fs');
const path = require('path');
const { open, checker } = require('./lib/site');
const h = require('./lib/media-tools');

const only = process.argv.slice(2);
const OUT = process.env.VE_OUT || path.join(require('os').tmpdir(), 've-web-export');
const results = [];

// ---- model maths for the zoom reference (the page uses the same shared module) ----
const model = require('../js/shared/model.js');

function approx(actual, expected, tol, label) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label || 'value'}: expected ${expected} ±${tol}, got ${actual}`);
}
function truthy(cond, message) { if (!cond) throw new Error(message); }

function bilinear(buf, w, hh, x, y) {
  const cx = Math.min(Math.max(x, 0), w - 1);
  const cy = Math.min(Math.max(y, 0), hh - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, hh - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = buf[y0 * w + x0] * (1 - fx) + buf[y0 * w + x1] * fx;
  const b = buf[y1 * w + x0] * (1 - fx) + buf[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}
function zoomReference(src, w, hh, z, fx, fy) {
  const win = model.cropWindow(z, fx, fy);
  const X0 = win.x * w;
  const Y0 = win.y * hh;
  const out = new Float32Array(w * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) out[y * w + x] = bilinear(src, w, hh, X0 + (x + 0.5) / z - 0.5, Y0 + (y + 0.5) / z - 0.5);
  return out;
}
function psnr(a, b) {
  let mse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const fx = app.fixtures;
  const DEFAULT_SETTINGS = { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'medium' };

  // ---- the page side --------------------------------------------------------------------------------------------------------------------------
  // specs: [{ media: <file name>, in, out, speed, zoomFrom ... }] -> the exported file in OUT (or the error the page reported)
  async function render(name, specs, settings, opts) {
    const o = opts || {};
    const outFile = name + '.mp4';
    const target = path.join(app.upDir, outFile);
    try { fs.rmSync(target, { force: true }); } catch (e) { /* ignore */ }
    const r = await app.evaluate(`(async () => {
      const specs = ${JSON.stringify(specs)};
      const settings = ${JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, settings || {}))};
      const S = VE.state.S;
      const byName = new Map();
      S.media.forEach((m) => byName.set(m.name, m));
      const segments = specs.map((sp) => {
        const m = byName.get(sp.media);
        if (!m) throw new Error('media not imported: ' + sp.media);
        const ov = Object.assign({}, sp);
        delete ov.media;
        if (ov.out === null || ov.out === undefined) ov.out = m.duration;
        return VE.model.createSegment(m, ov);
      });
      window.__veTest = window.__veTest || {};
      ${o.opfs ? `const root = await navigator.storage.getDirectory(); window.__veTest.exportHandle = await root.getFileHandle(${JSON.stringify(outFile)}, { create: true }); window.__veTest.exportToMemory = false;`
    : 'window.__veTest.exportHandle = null; window.__veTest.exportToMemory = true;'}
      const outName = await window.api.pickExportPath(${JSON.stringify(outFile)});
      const progress = [];
      let cancelled = false;
      const done = new Promise((resolve) => { const off = window.api.on('export:done', (m) => { off(); resolve(m); }); });
      const offP = window.api.on('export:progress', (p) => {
        progress.push(p.fraction);
        ${o.cancelAt ? `if (!cancelled && p.fraction > ${o.cancelAt}) { cancelled = true; window.api.exportCancel(p.jobId); }` : ''}
      });
      const t0 = performance.now();
      const started = await window.api.exportStart({ segments, settings, outPath: outName });
      if (!started.ok) { offP(); return { ok: false, started }; }
      const msg = await done;
      offP();
      const ms = performance.now() - t0;
      if (!msg.ok) return { ok: false, error: msg.error, progress, ms, started };
      let blob = window.__veLastExport && window.__veLastExport.blob;
      ${o.opfs ? `blob = await window.__veTest.exportHandle.getFile();` : ''}
      const up = await fetch('/__upload__/' + encodeURIComponent(${JSON.stringify(outFile)}), { method: 'POST', body: blob });
      return { ok: up.ok, size: blob.size, progress, ms, started, result: msg.result };
    })()`);
    if (!r.ok) {
      const e = new Error('export failed: ' + JSON.stringify(r.error || r.started));
      e.page = r;
      throw e;
    }
    return { outPath: target, r };
  }

  function checkBasics(outPath, expectedDur, w, hh, frames, label) {
    const s = h.streamsOf(outPath);
    approx(s.duration, expectedDur, 0.1, (label || '') + ' duration');
    truthy(s.v.codec_name === 'h264', 'video codec ' + s.v.codec_name);
    truthy(s.v.pix_fmt === 'yuv420p', 'pix_fmt ' + s.v.pix_fmt);
    if (w) truthy(Number(s.v.width) === w && Number(s.v.height) === hh, `size ${s.v.width}x${s.v.height} != ${w}x${hh}`);
    if (frames) {
      const n = h.countFrames(outPath);
      truthy(n === frames, `frame count ${n} != ${frames}`);
    }
    return s;
  }

  async function test(name, fn) {
    if (only.length && !only.some((p) => name.startsWith(p))) return;
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      console.log(`PASS  ${name}  (${Date.now() - t0} ms)  ${detail || ''}`);
    } catch (e) {
      results.push({ name, ok: false });
      console.log(`FAIL  ${name}  (${Date.now() - t0} ms)\n      ${String(e.message).split('\n').join('\n      ')}`);
    }
  }

  try {
    // import the fixtures once (what the file picker would hand over): the same path as the "add video" button
    await app.stage([path.basename(fx.A), path.basename(fx.B), path.basename(fx.C), path.basename(fx.F), path.basename(fx.W), 'Türkçe Klasör/' + path.basename(fx.E)]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.media.size === 6', 60000, 'six media imported');
    await app.waitFor('Array.from(VE.state.S.media.values()).every((m) => m.thumbsReady.size >= m.thumbCount)', 60000, 'thumbnails');
    const A = path.basename(fx.A);
    const B = path.basename(fx.B);
    const C = path.basename(fx.C);
    const F = path.basename(fx.F);
    const W = path.basename(fx.W);
    const E = path.basename(fx.E);

    await test('01 trim: A[2..5] -> 3 s, 90 frames, bar + audio follow the source', async () => {
      const { outPath } = await render('01_trim', [{ media: A, in: 2, out: 5 }]);
      const s = checkBasics(outPath, 3.0, 1280, 720, 90);
      truthy(s.a && Number(s.a.sample_rate) === 48000 && Number(s.a.channels) === 2, 'audio stream not 48k/stereo: ' + JSON.stringify(s.a));
      approx(h.barTime(outPath, 0.2, 1280, 720, 1280, 160), 2.2, 0.06, 'bar time @0.2');
      approx(h.barTime(outPath, 2.5, 1280, 720, 1280, 160), 4.5, 0.06, 'bar time @2.5');
      approx(h.audioFreq(outPath, 0.5, 0.2), 500, 20, 'audio freq @0.5');
      approx(Number(s.a.duration || s.duration), 3.0, 0.12, 'audio duration');
      return `dur=${s.duration.toFixed(3)} acodec=${s.a.codec_name}`;
    });

    await test('02 split + delete middle: A[0..2] + A[5..8] -> 5 s, joins exact', async () => {
      const { outPath } = await render('02_split_delete', [{ media: A, in: 0, out: 2 }, { media: A, in: 5, out: 8 }]);
      checkBasics(outPath, 5.0, 1280, 720, 150);
      approx(h.barTime(outPath, 1.0, 1280, 720, 1280, 160), 1.0, 0.06, 'bar @1.0');
      approx(h.barTime(outPath, 59 / 30 - 0.01, 1280, 720, 1280, 160), 59 / 30, 0.05, 'last frame of seg 1');
      approx(h.barTime(outPath, 2.0 - 0.001, 1280, 720, 1280, 160), 5.0, 0.05, 'first frame of seg 2');
      approx(h.barTime(outPath, 2.5, 1280, 720, 1280, 160), 5.5, 0.06, 'bar @2.5');
      approx(h.audioFreq(outPath, 1.5, 0.2), 400, 20, 'audio @1.5');
      approx(h.audioFreq(outPath, 2.5, 0.2), 800, 20, 'audio @2.5 (source 5.5)');
      approx(Number(h.streamsOf(outPath).a.duration), 5.0, 0.12, 'audio duration');
    });

    await test('03 merge A(audio 16:9 30fps) + B(silent 4:3 25fps): letterbox, silence padding, fps unify', async () => {
      const { outPath } = await render('03_merge', [{ media: A, in: 0, out: 3 }, { media: B, in: 0, out: 2 }]);
      const s = checkBasics(outPath, 5.0, 1280, 720, 150);
      approx(eval(s.v.avg_frame_rate), 30, 0.01, 'fps');
      const buf = h.grayFrame(outPath, 4.0, 1280, 720);
      let leftSum = 0;
      let n = 0;
      for (let y = 100; y < 620; y += 20) for (let x = 0; x < 150; x++) { leftSum += buf[y * 1280 + x]; n++; }
      truthy(leftSum / n < 24, 'pillarbox bars are not black: ' + (leftSum / n));
      approx(h.barCentroid(buf, 1280, 720), 160 + (128 + 3) * 1.5, 5, 'B bar x');
      approx(h.audioFreq(outPath, 1.5, 0.2), 400, 20, 'A audio');
      const vol = h.meanVolume(outPath, 3.2, 1.6);
      truthy(vol < -80, 'B region must be silent, mean volume ' + vol);
      approx(Number(s.a.duration), 5.0, 0.12, 'audio duration');
    });

    await test('04 speed 2x: A[0..8] -> 4 s, pitch preserved (WSOLA)', async () => {
      const { outPath } = await render('04_speed2x', [{ media: A, in: 0, out: 8, speed: 2 }]);
      checkBasics(outPath, 4.0, 1280, 720, 120);
      approx(h.barTime(outPath, 1.0, 1280, 720, 1280, 160), 2.0, 0.1, 'bar @1.0');
      approx(h.barTime(outPath, 3.0, 1280, 720, 1280, 160), 6.0, 0.1, 'bar @3.0');
      approx(h.audioFreq(outPath, 1.0, 0.2), 500, 25, 'audio @1.0 (src 2.0..2.4)');
      approx(h.audioFreq(outPath, 3.0, 0.2), 900, 25, 'audio @3.0 (src 6.0..6.4)');
      approx(Number(h.streamsOf(outPath).a.duration), 4.0, 0.12, 'audio duration');
    });

    await test('05 slow motion 0.5x: A[2..6] -> 8 s', async () => {
      const { outPath } = await render('05_slow05', [{ media: A, in: 2, out: 6, speed: 0.5 }]);
      checkBasics(outPath, 8.0, 1280, 720, 240);
      approx(h.barTime(outPath, 2.0, 1280, 720, 1280, 160), 3.0, 0.1, 'bar @2.0');
      approx(h.barTime(outPath, 6.0, 1280, 720, 1280, 160), 5.0, 0.1, 'bar @6.0');
      approx(h.audioFreq(outPath, 4.0, 0.2), 700, 25, 'audio @4.0 (src 4.0)');
      approx(Number(h.streamsOf(outPath).a.duration), 8.0, 0.12, 'audio duration');
    });

    await test('06 extremes: 8x (A[0..8] -> 1 s) and 0.25x (A[0..2] -> 8 s)', async () => {
      const a = await render('06_speed8x', [{ media: A, in: 0, out: 8, speed: 8 }]);
      checkBasics(a.outPath, 1.0, 1280, 720, 30);
      approx(Number(h.streamsOf(a.outPath).a.duration), 1.0, 0.1, '8x audio duration');
      const b = await render('06_speed025x', [{ media: A, in: 0, out: 2, speed: 0.25 }]);
      checkBasics(b.outPath, 8.0, 1280, 720, 240);
      approx(Number(h.streamsOf(b.outPath).a.duration), 8.0, 0.15, '0.25x audio duration');
      approx(h.barTime(b.outPath, 4.0, 1280, 720, 1280, 160), 1.0, 0.1, '0.25x bar @4.0');
    });

    /* ---------- zoom: compare real output frames with an independent JS reference ---------- */
    function segOf(extra) { return Object.assign({ in: 0, out: 8, speed: 1, zoomFrom: 1, zoomTo: 1, fx: 0.5, fy: 0.5 }, extra); }
    function zoomCheck(label, outPath, srcFile, s, fps, frames, minPsnr) {
      const Wd = 1280;
      const Hd = 720;
      const nf = model.frameCount(s, { value: fps });
      const lines = [];
      for (const n of frames) {
        const tOut = Math.max(0, n / fps - 0.001);
        const exported = h.grayFrame(outPath, tOut, Wd, Hd);
        const srcT = Math.max(0, s.in + (n / fps) * s.speed - 0.001);
        const src = h.grayFrame(srcFile, srcT, Wd, Hd);
        const z = model.zoomAt(s, n / nf);
        const ref = zoomReference(src, Wd, Hd, z, s.fx, s.fy);
        const p = psnr(exported, ref);
        lines.push(`n=${n} z=${z.toFixed(3)} psnr=${p.toFixed(1)}`);
        truthy(p >= minPsnr, `${label}: frame ${n} PSNR ${p.toFixed(1)} dB < ${minPsnr} dB (z=${z.toFixed(3)})`);
      }
      return lines.join(' | ');
    }

    await test('07 zoom IN 1.0->2.0 (centre): output frames match the reference geometry', async () => {
      const s = segOf({ in: 0, out: 4, zoomFrom: 1, zoomTo: 2 });
      const { outPath } = await render('07_zoom_in', [Object.assign({ media: A }, s)], { quality: 'high' });
      checkBasics(outPath, 4.0, 1280, 720, 120);
      return zoomCheck('zoom in', outPath, fx.A, s, 30, [0, 30, 60, 90, 119], 30);
    });

    await test('08 zoom OUT 2.5->1.0 (off-centre focus 0.7/0.3) on A[2..6]', async () => {
      const s = segOf({ in: 2, out: 6, zoomFrom: 2.5, zoomTo: 1, fx: 0.7, fy: 0.3 });
      const { outPath } = await render('08_zoom_out', [Object.assign({ media: A }, s)], { quality: 'high' });
      checkBasics(outPath, 4.0, 1280, 720, 120);
      return zoomCheck('zoom out', outPath, fx.A, s, 30, [0, 40, 80, 119], 30);
    });

    await test('09 static zoom 1.5x with clamped corner focus (0.1/0.9)', async () => {
      const s = segOf({ in: 0, out: 3, zoomFrom: 1.5, zoomTo: 1.5, fx: 0.1, fy: 0.9 });
      const { outPath } = await render('09_zoom_static', [Object.assign({ media: A }, s)], { quality: 'high' });
      checkBasics(outPath, 3.0, 1280, 720, 90);
      return zoomCheck('static zoom', outPath, fx.A, s, 30, [0, 45, 89], 30);
    });

    await test('10 zoom + speed 2x combined (1->3, focus 0.25/0.5)', async () => {
      const s = segOf({ in: 0, out: 8, speed: 2, zoomFrom: 1, zoomTo: 3, fx: 0.25, fy: 0.5 });
      const { outPath } = await render('10_zoom_speed', [Object.assign({ media: A }, s)], { quality: 'high' });
      checkBasics(outPath, 4.0, 1280, 720, 120);
      return zoomCheck('zoom+speed', outPath, fx.A, s, 30, [0, 60, 119], 28);
    });

    await test('11 zoom on a downscaled canvas (supersampling path, 480p output)', async () => {
      const s = segOf({ in: 0, out: 3, zoomFrom: 1, zoomTo: 2.5, fx: 0.5, fy: 0.5 });
      const { outPath } = await render('11_zoom_ss', [Object.assign({ media: A }, s)], { resolution: '480', quality: 'high' });
      checkBasics(outPath, 3.0, 854, 480, 90);
      const n = 89;
      const z = model.zoomAt(s, n / 90);
      const src = h.grayFrame(fx.A, n / 30 - 0.001, 1280, 720);
      const ref = zoomReference(src, 1280, 720, z, 0.5, 0.5);
      const refFile = path.join(OUT, '11_ref.raw');
      fs.writeFileSync(refFile, Buffer.from(ref.map((v) => Math.round(v))));
      const r = h.ff(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '1280x720', '-i', refFile, '-vf', 'scale=854:480:flags=bicubic', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
      const exported = h.grayFrame(outPath, n / 30 - 0.001, 854, 480);
      const p = psnr(exported, r.stdout);
      truthy(p > 26, 'supersampled frame PSNR ' + p.toFixed(1));
      return `psnr=${p.toFixed(1)}`;
    });

    await test('12 rotated phone video (display matrix 90deg) exports upright 720x1280', async () => {
      const info = await app.evaluate(`(() => { const m = Array.from(VE.state.S.media.values()).find((x) => x.name === ${JSON.stringify(C)}); return { dw: m.displayWidth, dh: m.displayHeight, rot: m.rotation }; })()`);
      truthy(info.dw === 720 && info.dh === 1280 && info.rot !== 0, 'probe rotation/display size wrong: ' + JSON.stringify(info));
      const { outPath } = await render('12_rotated', [{ media: C, in: 0, out: 3 }]);
      const s = checkBasics(outPath, 3.0, 720, 1280, 90);
      truthy(!s.v.side_data_list || !s.v.side_data_list.some((d) => d.rotation), 'output must not carry rotation metadata');
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

    await test('13 Turkish / Unicode file names for input and output (ş ğ ı İ ö ç ü)', async () => {
      const { outPath } = await render('çıktı_ŞĞİ video', [{ media: E, in: 0, out: 3.5 }]);
      truthy(fs.existsSync(outPath), 'output file missing');
      checkBasics(outPath, 3.5, 1280, 720, 105);
      return `in=${E}`;
    });

    await test('14 fades: black at both ends, silent at the edges', async () => {
      const { outPath } = await render('14_fade', [{ media: A, in: 0, out: 3, fadeIn: 1, fadeOut: 1 }]);
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
      const full = await render('15_vol_full', [{ media: A, in: 0, out: 2 }]);
      const half = await render('15_vol_half', [{ media: A, in: 0, out: 2, volume: 0.5 }]);
      const mute = await render('15_vol_mute', [{ media: A, in: 0, out: 2, mute: true }]);
      const vf = h.meanVolume(full.outPath, 0.2, 1.5);
      const vh = h.meanVolume(half.outPath, 0.2, 1.5);
      const vm = h.meanVolume(mute.outPath, 0.2, 1.5);
      approx(vf - vh, 6.02, 1.0, 'half volume delta dB');
      truthy(vm < -80, 'mute not silent: ' + vm);
      truthy(h.streamsOf(mute.outPath).a, 'muted export must still have an audio track');
      return `full ${vf} half ${vh} mute ${vm}`;
    });

    await test('16 progress callbacks + cancel (memory target): CANCELLED, monotonic progress', async () => {
      const specs = [];
      for (let i = 0; i < 12; i++) specs.push({ media: A, in: 0, out: 8 });
      let err = null;
      let page = null;
      try { await render('16_cancel', specs, { quality: 'high' }, { cancelAt: 0.05 }); } catch (e) { err = e; page = e.page; }
      truthy(err && page && page.error && page.error.code === 'CANCELLED', 'expected CANCELLED, got ' + JSON.stringify(page && (page.error || page.started)));
      truthy(page.progress.length >= 2, 'no progress callbacks');
      for (let i = 1; i < page.progress.length; i++) truthy(page.progress[i] >= page.progress[i - 1] - 1e-9, 'progress not monotonic');
      return `events=${page.progress.length} cancelledAt=${(page.progress[page.progress.length - 1] * 100).toFixed(1)}%`;
    });

    await test('17 error codes: nothing to export, unknown media, no file chosen, second export while one runs', async () => {
      const codes = await app.evaluate(`(async () => {
        const out = {};
        window.__veTest = window.__veTest || {};
        window.__veTest.exportHandle = null; window.__veTest.exportToMemory = true;
        const name = await window.api.pickExportPath('x.mp4');
        out.empty = (await window.api.exportStart({ segments: [], settings: {}, outPath: name })).error.code;
        const S = VE.state.S;
        const m = Array.from(S.media.values())[0];
        const seg = VE.model.createSegment(m, { in: 0, out: 1 });
        out.unknown = (await window.api.exportStart({ segments: [Object.assign({}, seg, { mediaId: 'nope' })], settings: {}, outPath: name })).error.code;
        out.wrongPath = (await window.api.exportStart({ segments: [seg], settings: {}, outPath: 'other.mp4' })).error.code;
        const longSegs = []; for (let i = 0; i < 20; i++) longSegs.push(VE.model.createSegment(m, { in: 0, out: 8 }));
        const first = await window.api.exportStart({ segments: longSegs, settings: { quality: 'low' }, outPath: name });
        const second = await window.api.exportStart({ segments: [seg], settings: {}, outPath: name });
        out.busy = second.error && second.error.code;
        await window.api.exportCancel(first.jobId);
        await new Promise((r) => { const off = window.api.on('export:done', () => { off(); r(); }); });
        return out;
      })()`);
      truthy(codes.empty === 'EMPTY' && codes.unknown === 'MEDIA_MISSING' && codes.wrongPath === 'OUT_DIR' && codes.busy === 'BUSY', JSON.stringify(codes));
      return JSON.stringify(codes);
    });

    await test('18 many segments (40 inputs, mixed speed/zoom/fade): exact frame count and duration', async () => {
      const specs = [];
      const segsForCount = [];
      let expected = 0;
      for (let i = 0; i < 40; i++) {
        const start = (i % 7) * 1.0;
        const s = { media: A, in: start, out: start + 0.4 + (i % 3) * 0.1, speed: [1, 2, 0.5, 4][i % 4], zoomFrom: 1, zoomTo: i % 5 === 0 ? 1.8 : 1, fx: 0.3 + (i % 4) * 0.1, fadeIn: i % 6 === 0 ? 0.1 : 0 };
        specs.push(s);
        const m = { duration: 8, id: 'x' };
        const full = model.sanitizeSegment(model.createSegment(m, s), m);
        segsForCount.push(full);
        expected += model.frameCount(full, { value: 30 });
      }
      const { outPath, r } = await render('18_many', specs, { quality: 'low' });
      const frames = h.countFrames(outPath);
      truthy(frames === expected, `frames ${frames} != ${expected}`);
      approx(h.streamsOf(outPath).duration, expected / 30, 0.12, 'duration');
      return `segments=${specs.length} frames=${frames} in ${(r.ms / 1000).toFixed(1)} s`;
    });

    await test('19 mixed orientations + 16:9 canvas @480p/25fps: portrait, 4:3 and 16:9 letterboxed together', async () => {
      const { outPath } = await render('19_mixed', [{ media: C, in: 0, out: 2 }, { media: A, in: 0, out: 2 }, { media: B, in: 0, out: 2 }], { aspect: '16:9', resolution: '480', fps: '25', quality: 'low' });
      const s = checkBasics(outPath, 6.0, 854, 480, 150);
      approx(eval(s.v.avg_frame_rate), 25, 0.01, 'fps');
      const buf = h.grayFrame(outPath, 1.0, 854, 480);
      let side = 0; let n = 0;
      for (let y = 40; y < 440; y += 10) for (let x = 0; x < 200; x++) { side += buf[y * 854 + x]; n++; }
      truthy(side / n < 24, 'portrait side bars not black: ' + side / n);
    });

    await test('20 project without any audio track exports video-only', async () => {
      const { outPath } = await render('20_noaudio', [{ media: B, in: 0, out: 3 }]);
      const s = checkBasics(outPath, 3.0, 640, 480, 75);
      truthy(!s.a, 'unexpected audio stream');
    });

    await test('21 WebM (VP9 + Opus) input exports to H.264/AAC mp4', async () => {
      const { outPath } = await render('21_webm', [{ media: W, in: 0, out: 3 }]);
      const s = checkBasics(outPath, 3.0, 640, 360, 90);
      truthy(s.a && s.a.codec_name === 'aac', 'audio stream: ' + JSON.stringify(s.a && s.a.codec_name));
      approx(h.audioFreq(outPath, 1.0, 0.3), 500, 25, 'WebM audio tone');
    });

    await test('22 NTSC 29.97 fps 1080p mono source: keeps 30000/1001 fps, stereo 48 kHz AAC, merges with a 30 fps clip', async () => {
      const { outPath } = await render('22_ntsc', [{ media: F, in: 0, out: 3 }, { media: A, in: 0, out: 2 }]);
      const s = h.streamsOf(outPath);
      truthy(s.v.avg_frame_rate === '30000/1001', 'fps ' + s.v.avg_frame_rate);
      truthy(Number(s.v.width) === 1920 && Number(s.v.height) === 1080, 'size ' + s.v.width + 'x' + s.v.height);
      truthy(Number(s.a.channels) === 2 && Number(s.a.sample_rate) === 48000, 'audio format');
      truthy(h.countFrames(outPath) === 150, 'frames ' + h.countFrames(outPath));
      approx(s.duration, 150 / (30000 / 1001), 0.12, 'duration');
      approx(h.audioFreq(outPath, 1.0, 0.3), 600, 30, 'mono tone survives upmix');
    });

    await test('23 file target (OPFS handle = what the save picker returns): streamed, moov at the front, cancel leaves no file', async () => {
      const { outPath, r } = await render('23_opfs', [{ media: A, in: 0, out: 4, speed: 2, zoomFrom: 1, zoomTo: 1.5 }, { media: B, in: 0, out: 2 }], { quality: 'medium' }, { opfs: true });
      checkBasics(outPath, 4.0, 1280, 720, 120);
      const head = fs.readFileSync(outPath).subarray(0, 4096);
      const moov = head.indexOf('moov');
      const mdat = head.indexOf('mdat');
      truthy(moov > 0 && (mdat < 0 || moov < mdat), `fast start: moov at ${moov}, mdat at ${mdat}`);
      // cancel: the file the page created must not survive
      let page = null;
      try { await render('23_opfs_cancel', [{ media: A, in: 0, out: 8 }, { media: A, in: 0, out: 8 }, { media: A, in: 0, out: 8 }, { media: A, in: 0, out: 8 }, { media: A, in: 0, out: 8 }, { media: A, in: 0, out: 8 }], { quality: 'high' }, { opfs: true, cancelAt: 0.05 }); } catch (e) { page = e.page; }
      truthy(page && page.error && page.error.code === 'CANCELLED', 'expected CANCELLED: ' + JSON.stringify(page && page.error));
      const exists = await app.evaluate(`(async () => { const root = await navigator.storage.getDirectory(); try { const f = await (await root.getFileHandle('23_opfs_cancel.mp4')).getFile(); return f.size; } catch (e) { return -1; } })()`);
      truthy(exists === -1, 'cancelled export left a file of ' + exists + ' bytes');
      return `size=${r.size}`;
    });

    await test('24 150 cuts of a 1080p file: exact length and frame count', async () => {
      const specs = [];
      for (let i = 0; i < 150; i++) specs.push({ media: F, in: (i % 12) * 0.2, out: (i % 12) * 0.2 + 0.1 });
      const { outPath, r } = await render('24_150cuts', specs, { quality: 'low' });
      const frames = h.countFrames(outPath);
      truthy(frames === 150 * 3, `frames ${frames} != ${150 * 3}`);
      return `frames=${frames} in ${(r.ms / 1000).toFixed(1)} s`;
    });

    await test('25 speed: a 1080p / 60 s of editing renders at a usable rate (informational)', async () => {
      const specs = [{ media: F, in: 0, out: 3 }, { media: F, in: 0, out: 3 }, { media: F, in: 0, out: 3, zoomFrom: 1, zoomTo: 2 }, { media: F, in: 0, out: 3, speed: 2 }];
      const { outPath, r } = await render('25_speed', specs, { quality: 'medium' });
      const s = h.streamsOf(outPath);
      const x = s.duration / (r.ms / 1000);
      return `${s.duration.toFixed(1)} s of 1080p in ${(r.ms / 1000).toFixed(1)} s = ${x.toFixed(2)}x realtime`;
    });
    await test('26 the output may never be a source video (same handle, another handle of the same file, or a same-looking existing file); the source stays intact', async () => {
      const r = await app.evaluate(`(async () => {
        const root = await navigator.storage.getDirectory();
        const bytes = await (await fetch('/__fixtures__/' + encodeURIComponent(${JSON.stringify(A)}))).arrayBuffer();
        const h1 = await root.getFileHandle('src_copy.mp4', { create: true });
        const w = await h1.createWritable(); await w.write(bytes); await w.close();
        const file = await h1.getFile();
        window.__veTest = window.__veTest || {};
        window.__veTest.handles = new Map([[file, h1]]);
        window.__veTest.media = [file];
        const imp = await window.api.pickMedia();
        const media = imp.results[0].media;
        const seg = VE.model.createSegment(media, { in: 0, out: 1 });
        const out = {};
        const attempt = async (handle) => {
          window.__veTest.exportToMemory = false; window.__veTest.exportHandle = handle;
          const name = await window.api.pickExportPath('src_copy.mp4');
          const res = await window.api.exportStart({ segments: [seg], settings: {}, outPath: name });
          return res.ok ? 'STARTED' : res.error.code;
        };
        out.sameHandle = await attempt(h1);
        out.otherHandle = await attempt(await root.getFileHandle('src_copy.mp4'));
        // the page has no handle for the source (plain file) - the existing output file looks exactly like it
        await window.api.resetMedia();
        window.__veTest.handles = null;
        window.__veTest.media = [await h1.getFile()];
        const imp2 = await window.api.pickMedia();
        const seg2 = VE.model.createSegment(imp2.results[0].media, { in: 0, out: 1 });
        window.__veTest.exportHandle = await root.getFileHandle('src_copy.mp4');
        const name2 = await window.api.pickExportPath('src_copy.mp4');
        const res2 = await window.api.exportStart({ segments: [seg2], settings: {}, outPath: name2 });
        out.lookalike = res2.ok ? 'STARTED' : res2.error.code;
        out.sizeBefore = bytes.byteLength;
        out.sizeAfter = (await (await root.getFileHandle('src_copy.mp4')).getFile()).size;
        return out;
      })()`);
      truthy(r.sameHandle === 'OUT_IS_SOURCE' && r.otherHandle === 'OUT_IS_SOURCE' && r.lookalike === 'OUT_IS_SOURCE', JSON.stringify(r));
      truthy(r.sizeBefore === r.sizeAfter, 'the source file was modified: ' + JSON.stringify(r));
      return JSON.stringify(r);
    });
    await test('27 a result that cannot be built in memory (no file picker) is refused up front with TOO_LARGE', async () => {
      const r = await app.evaluate(`(async () => {
        const resp = await fetch('/__fixtures__/' + encodeURIComponent(${JSON.stringify(F)}));
        const f = new File([await resp.blob()], ${JSON.stringify(F)}, { lastModified: 1700000000000 });
        window.__veTest = window.__veTest || {};
        window.__veTest.handles = null;
        window.__veTest.media = [f];
        const imp = await window.api.pickMedia();
        const m = imp.results[0].media;
        const segs = []; for (let i = 0; i < 400; i++) segs.push(VE.model.createSegment(m, { in: 0, out: 3 }));
        window.__veTest.exportHandle = null; window.__veTest.exportToMemory = true;
        const name = await window.api.pickExportPath('big.mp4');
        const res = await window.api.exportStart({ segments: segs, settings: { quality: 'high' }, outPath: name });
        return res.ok ? 'STARTED' : res.error.code;
      })()`);
      truthy(r === 'TOO_LARGE', 'expected TOO_LARGE, got ' + r);
    });
  } catch (e) {
    console.log('FAIL  setup\n      ' + String((e && e.stack) || e));
    results.push({ name: 'setup', ok: false });
  } finally {
    console.log('errors in page:', JSON.stringify(app.errors));
    await app.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== web export: ${results.length - failed.length}/${results.length} passed ====`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('harness crashed:', e); process.exit(2); });
