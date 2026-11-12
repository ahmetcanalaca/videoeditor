'use strict';
// Single pictures cut out of the video for the vision model (JPEG, scaled down), with a small cache.
const crypto = require('crypto');
const { spawn } = require('child_process');
const { inputArgs } = require('../media-guard');

const MAX_JPEG = 8 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 45000;
const CACHE_SIZE = 64;

function codeError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// One picture at `seconds` of `file`, no larger than maxSide pixels on its long edge. ffmpeg turns phone videos upright by itself.
function extractJpeg(o) {
  return new Promise((resolve, reject) => {
    if (o.signal && o.signal.aborted) { reject(codeError('ABORTED', 'Cancelled')); return; }
    const side = Math.max(64, Math.min(2048, Math.round(o.maxSide || 512)));
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', Math.max(0, o.seconds).toFixed(3), ...inputArgs(o.file),
      '-frames:v', '1', '-an', '-sn', '-vf', "scale='min(" + side + ",iw)':'min(" + side + ",ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'];
    const child = spawn(o.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (o.procs) o.procs.track(child);
    const chunks = [];
    let size = 0;
    let err = '';
    let done = false;
    let timer = null;
    const onAbort = () => { try { child.kill(); } catch (e) { /* gone */ } finish(reject, codeError('ABORTED', 'Cancelled')); };
    function finish(fn, v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      fn(v);
    }
    timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish(reject, codeError('FRAME_TIMEOUT', 'Reading a picture from the video took too long')); }, o.timeoutMs || FRAME_TIMEOUT_MS);
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_JPEG) { try { child.kill(); } catch (e) { /* gone */ } finish(reject, codeError('FRAME_FAILED', 'The picture is unexpectedly large')); return; }
      chunks.push(d);
    });
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-400); });
    child.on('error', (e) => finish(reject, codeError('FRAME_FAILED', 'ffmpeg could not be started', { detail: String(e && e.message) })));
    child.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 200 && buf[0] === 0xff && buf[1] === 0xd8) finish(resolve, buf);
      else finish(reject, codeError('FRAME_FAILED', 'No picture at ' + o.seconds.toFixed(1) + ' s', { detail: err.trim() }));
    });
  });
}

// Time on the ORIGINAL timeline -> file and position in that file. pieces: [{ b0, b1, file, in, speed }] in timeline order.
function createTimeMap(pieces) {
  const list = pieces.filter((p) => p.b1 > p.b0);
  const total = list.length ? list[list.length - 1].b1 : 0;
  return {
    total,
    at(t) {
      const x = Math.min(Math.max(0, t), total);
      let p = list.find((q) => x >= q.b0 && x < q.b1);
      if (!p) p = list[list.length - 1];
      if (!p) return null;
      const span = (p.b1 - p.b0) * p.speed;
      const src = p.in + Math.min(Math.max(0, (x - p.b0) * p.speed), Math.max(0, span - 0.05));
      return { file: p.file, seconds: src };
    },
  };
}

// opts: { ffmpegPath, timeMap, procs, signal, sides: { probe, ground }, extract? (tests, the browser), maxBytes?, fallbackSides? }
// Returns frame(t, purpose) -> { key, jpeg, t }; key identifies the picture's CONTENT, so a still scene is asked about only once.
// maxBytes: a picture that is larger (a noisy, finely detailed scene) is cut again at the next smaller size of fallbackSides, until it fits; the picture is never larger
// than that (this is what makes "at most N pictures of at most X KB" true for the pictures that leave the computer).
function createFrameSource(opts) {
  const o = opts;
  const sides = Object.assign({ probe: 512, ground: 768 }, o.sides || {});
  const extract = o.extract || extractJpeg;
  const maxBytes = o.maxBytes > 0 ? o.maxBytes : 0;
  const fallbackSides = Array.isArray(o.fallbackSides) ? o.fallbackSides.slice().sort((a, b) => b - a) : [];
  const cache = new Map();
  return async function frame(t, purpose) {
    const loc = o.timeMap.at(t);
    if (!loc) throw codeError('FRAME_FAILED', 'The timeline is empty');
    const side = sides[purpose] || sides.probe;
    const ck = loc.file + '|' + loc.seconds.toFixed(2) + '|' + side;
    if (cache.has(ck)) { const hit = cache.get(ck); cache.delete(ck); cache.set(ck, hit); return hit; }
    const cut = (maxSide) => extract({ ffmpegPath: o.ffmpegPath, file: loc.file, seconds: loc.seconds, maxSide, signal: o.signal, procs: o.procs });
    let usedSide = side;
    let jpeg = await cut(side);
    if (maxBytes && jpeg.length > maxBytes) {
      for (const smaller of fallbackSides) {
        if (smaller >= usedSide) continue;
        usedSide = smaller;
        jpeg = await cut(usedSide);
        if (jpeg.length <= maxBytes) break;
      }
      if (jpeg.length > maxBytes) throw codeError('FRAME_FAILED', 'The picture is larger than the limit');
    }
    const out = { key: crypto.createHash('sha1').update(jpeg).digest('hex') + ':' + usedSide, jpeg, t };
    cache.set(ck, out);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return out;
  };
}

module.exports = { extractJpeg, createTimeMap, createFrameSource };
