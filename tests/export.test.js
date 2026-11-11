'use strict';
// End-to-end export verification: renders real files with the production exporter and measures the results with ffprobe/ffmpeg.
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const model = require('../src/shared/model');
const { probe } = require('../src/main/probe');
const exporter = require('../src/main/exporter');

const OUT = path.join(__dirname, 'out');
const only = process.argv.slice(2);
const results = [];
let fixtures;
let media = {}; // key -> media info (with id)

function approx(actual, expected, tol, label) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label || 'value'}: expected ${expected} ±${tol}, got ${actual}`);
  }
}

function truthy(cond, message) {
  if (!cond) throw new Error(message);
}

async function test(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail || '' });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)  ${detail || ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms)\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}

function seg(key, inT, outT, extra) {
  const m = media[key];
  return model.createSegment(m, Object.assign({ in: inT, out: outT === null ? m.duration : outT }, extra || {}));
}

function mediaMap() {
  const map = {};
  Object.values(media).forEach((m) => { map[m.id] = m; });
  return map;
}

const DEFAULT_SETTINGS = { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'medium' };

async function render(name, segments, settings, extra) {
  fs.mkdirSync(OUT, { recursive: true });
  const outPath = (extra && extra.outPath) || path.join(OUT, name + '.mp4');
  if (fs.existsSync(outPath)) fs.rmSync(outPath);
  const job = exporter.runExport(Object.assign({
    ffmpegPath: h.bins.ffmpeg,
    segments,
    media: mediaMap(),
    settings: Object.assign({}, DEFAULT_SETTINGS, settings || {}),
    outPath,
  }, extra || {}));
  const res = await job.promise;
  return { outPath, plan: job.plan, res };
}

function checkBasics(outPath, expectedDur, w, hh, frames, label) {
  const s = h.streamsOf(outPath);
  approx(s.duration, expectedDur, 0.08, (label || '') + ' duration');
  truthy(s.v.codec_name === 'h264', 'video codec ' + s.v.codec_name);
  truthy(s.v.pix_fmt === 'yuv420p', 'pix_fmt ' + s.v.pix_fmt);
  if (w) truthy(Number(s.v.width) === w && Number(s.v.height) === hh, `size ${s.v.width}x${s.v.height} != ${w}x${hh}`);
  if (frames) {
    const n = h.countFrames(outPath);
    truthy(n === frames, `frame count ${n} != ${frames}`);
  }
  return s;
}

/* ---------- reference rendering for zoom checks (independent JS implementation) ---------- */

// Bilinear sample of a gray image at index-space coordinates.
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
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = bilinear(src, w, hh, X0 + (x + 0.5) / z - 0.5, Y0 + (y + 0.5) / z - 0.5);
    }
  }
  return out;
}

function psnr(a, b) {
  let mse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/* ====================================================================================== */

async function main() {
  fixtures = h.makeFixtures();
  for (const k of Object.keys(fixtures)) {
    const info = await probe(h.bins, fixtures[k]);
    info.id = 'm_' + k;
    media[k] = info;
  }
  const ctx = { OUT, test, approx, truthy, seg, render, mediaMap, checkBasics, zoomReference, psnr, media, DEFAULT_SETTINGS, h, model, exporter, fixtures };
  await require('./export.cases')(ctx);
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log('\n==== SUMMARY ====');
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => {
  console.error('Test harness crashed:', e);
  process.exit(2);
});
