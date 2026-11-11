'use strict';
// Shared helpers for the UI verification scripts.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');

const OUT = path.join(__dirname, 'out', 'ui');
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)${detail ? '  ' + detail : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms)\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function near(actual, expected, tol, label) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label || 'value'}: expected ${expected} ±${tol}, got ${actual}`);
}

function summary(title) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${title}: ${results.length - failed.length}/${results.length} passed ====`);
  failed.forEach((r) => console.log('  FAILED: ' + r.name));
  return failed.length;
}

const ud = (name) => path.join(OUT, 'ud-' + name);

// ---- image helpers (through ffmpeg) ----
function gray(args, w, hh) {
  const r = spawnSync(h.bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-vf', `scale=${w}:${hh}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 27 });
  if (r.status !== 0 || r.stdout.length < w * hh) throw new Error('ffmpeg gray failed: ' + (r.stderr && r.stderr.toString()));
  return r.stdout;
}
const pngGray = (png, w, hh) => gray(['-i', png], w, hh);
const videoGray = (file, t, w, hh) => gray(['-ss', String(t), '-i', file, '-frames:v', '1'], w, hh);

function psnr(a, b) {
  let mse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

function barX(buf, w, hh, thr) {
  let sw = 0; let sx = 0;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { if (buf[y * w + x] >= (thr || 225)) { sw++; sx += x + 0.5; } }
  return sw > 3 ? sx / sw / w : null;
}

function pngSize(png) {
  const r = spawnSync(h.bins.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png]);
  const [w, hh] = r.stdout.toString().trim().split(',').map(Number);
  return { w, h: hh };
}

module.exports = { OUT, results, step, assert, near, summary, ud, pngGray, videoGray, psnr, barX, pngSize, h };
