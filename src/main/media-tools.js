'use strict';
// Background media helpers: timeline thumbnails, audio waveform peaks and low-resolution preview proxies.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const procs = require('./procs');
const { inputArgs } = require('./media-guard');

const WAVE_RATE = 8000;
const WAVE_BUCKETS_PER_SEC = 50; // 160 samples per bucket

function removeQuiet(p) {
  try { fs.rmSync(p, { force: true, recursive: true }); } catch (e) { /* ignore */ }
}

// Number of thumbnails for a media of the given duration (coarse-to-fine generation order, see thumbOrder).
function thumbCountFor(duration) {
  return Math.max(6, Math.min(150, Math.round(duration / 3)));
}

// Generation order: evenly spread first, then refine, so the strip fills in progressively.
function thumbOrder(count) {
  const order = [];
  const seen = new Set();
  let stride = 1;
  while (stride * 2 < count) stride *= 2;
  for (; stride >= 1; stride = Math.floor(stride / 2)) {
    for (let i = 0; i < count; i += stride) {
      if (!seen.has(i)) { seen.add(i); order.push(i); }
    }
    if (stride === 1) break;
  }
  return order;
}

// token: { cancelled: boolean } lets the caller abort (e.g. when the media is removed or the app quits).
async function generateThumbs(opts) {
  const { ffmpegPath, file, duration, count, outDir, onThumb, token } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const queue = thumbOrder(count);
  const concurrency = 3;

  const one = (index) => new Promise((resolve) => {
    if (token && token.cancelled) { resolve(false); return; }
    const t = Math.min(Math.max(0, (index + 0.5) * duration / count), Math.max(0, duration - 0.1));
    const out = path.join(outDir, index + '.jpg');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', t.toFixed(3), ...inputArgs(file), '-frames:v', '1', '-an', '-sn', '-vf', 'scale=-2:96:flags=fast_bilinear', '-q:v', '5', '-y', out];
    const child = execFile(ffmpegPath, args, { windowsHide: true, timeout: 45000 }, (err) => {
      if (!err && fs.existsSync(out)) {
        if (onThumb) onThumb(index);
        resolve(true);
      } else {
        resolve(false);
      }
    });
    procs.track(child);
  });

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (queue.length && !(token && token.cancelled)) {
        const idx = queue.shift();
        await one(idx);
      }
    })());
  }
  await Promise.all(workers);
}

// Returns Uint8Array peaks (0..255, sqrt-scaled) at WAVE_BUCKETS_PER_SEC per second, or null if there is no audio.
function extractWaveform(opts) {
  const { ffmpegPath, file, token } = opts;
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs(file), '-vn', '-sn', '-ac', '1', '-ar', String(WAVE_RATE), '-f', 's16le', '-'];
    const child = procs.track(spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    const bucketSamples = WAVE_RATE / WAVE_BUCKETS_PER_SEC;
    let peaks = new Uint8Array(4096);
    let count = 0;
    let curMax = 0;
    let inBucket = 0;
    let leftover = null;

    const pushBucket = () => {
      if (count >= peaks.length) {
        const bigger = new Uint8Array(peaks.length * 2);
        bigger.set(peaks);
        peaks = bigger;
      }
      peaks[count++] = Math.min(255, Math.round(Math.sqrt(curMax / 32768) * 255));
      curMax = 0;
      inBucket = 0;
    };

    child.stdout.on('data', (chunk) => {
      if (token && token.cancelled) { try { child.kill(); } catch (e) { /* ignore */ } return; }
      let buf = chunk;
      if (leftover) { buf = Buffer.concat([leftover, chunk]); leftover = null; }
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(buf.readInt16LE(i * 2));
        if (v > curMax) curMax = v;
        if (++inBucket >= bucketSamples) pushBucket();
      }
      if (buf.length & 1) leftover = buf.subarray(buf.length - 1);
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      if (inBucket > 0) pushBucket();
      resolve(count > 0 ? peaks.slice(0, count) : null);
    });
  });
}

// Builds a 480p H.264/AAC proxy so that Chromium can preview formats it cannot decode natively (AVI, WMV, MKV/HEVC...).
function createProxy(opts) {
  const { ffmpegPath, file, outFile, duration, hasAudio, onProgress, token } = opts;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const part = outFile + '.part';
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...inputArgs(file), '-map', '0:v:0'];
  if (hasAudio) args.push('-map', '0:a:0');
  args.push('-vf', "scale=w='min(854,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p");
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '24', '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-ac', '2');
  args.push('-movflags', '+faststart', '-f', 'mp4', part);

  let child = null;
  const promise = new Promise((resolve, reject) => {
    child = procs.track(spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let buf = '';
    let tail = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && onProgress && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
    child.on('error', (e) => { removeQuiet(part); reject(e); });
    child.on('close', (code) => {
      if (token && token.cancelled) { removeQuiet(part); reject(new Error('cancelled')); return; }
      if (code !== 0) { removeQuiet(part); reject(new Error('proxy failed: ' + tail)); return; }
      try {
        fs.renameSync(part, outFile);
        resolve(outFile);
      } catch (e) {
        reject(e);
      }
    });
  });
  return { promise, cancel() { if (token) token.cancelled = true; if (child) { try { child.kill(); } catch (e) { /* ignore */ } } } };
}

module.exports = { thumbCountFor, thumbOrder, generateThumbs, extractWaveform, createProxy, WAVE_BUCKETS_PER_SEC };
