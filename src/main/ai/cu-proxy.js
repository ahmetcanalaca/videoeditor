'use strict';
// The reduced copy of a video that is uploaded for analysis. Content Understanding looks at about one picture per second, scaled to 512 x 512,
// and transcribes the speech, so a small copy gives the same result as the original at a fraction of the upload: at most 480 pixels on the short
// side (the service wants at least 320 x 240 and at most 1920 x 1080, so 4K sources must be reduced anyway), 10 pictures per second, mono 16 kHz
// speech audio. Metadata (GPS position, title, camera, ...) is not copied. The file is written to the temp folder and deleted by the caller
// right after the upload.
const fs = require('fs');
const { spawn } = require('child_process');
const { inputArgs } = require('../media-guard');

const MAX_BYTES = 150 * 1024 * 1024; // the service accepts 200 MB with analyzeBinary
const FPS = 10;

function codeError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// short side 320..480 (a source that is smaller than 320 is scaled up: the service has a minimum size)
function scaleFilter(info) {
  const dw = Number(info && info.displayWidth) || 1920;
  const dh = Number(info && info.displayHeight) || 1080;
  const short = Math.max(320, Math.min(480, Math.min(dw, dh)));
  return dw >= dh ? 'scale=-2:' + short : 'scale=' + short + ':-2';
}

function buildArgs(o) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    '-ss', Math.max(0, o.start).toFixed(3), '-t', Math.max(0.5, o.duration).toFixed(3), ...inputArgs(o.file),
    '-map', '0:v:0'];
  if (o.info && o.info.hasAudio) args.push('-map', '0:a:0?');
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', scaleFilter(o.info) + ',fps=' + FPS + ',format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-profile:v', 'main', '-g', String(FPS * 5),
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-ar', '16000',
    '-fs', String(MAX_BYTES), '-movflags', '+faststart', '-f', 'mp4', o.out);
  return args;
}

// o: { ffmpegPath, procs, file, info: { displayWidth, displayHeight, hasAudio }, start, duration (seconds of the SOURCE), out, signal, timeoutMs, onProgress(fraction) }
// -> { file, bytes }
function makeProxy(o) {
  return new Promise((resolve, reject) => {
    if (o.signal && o.signal.aborted) { reject(codeError('ABORTED', 'Cancelled')); return; }
    const args = buildArgs(o);
    const child = spawn(o.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (o.procs) o.procs.track(child);
    let err = '';
    let buf = '';
    let done = false;
    const cleanup = () => { try { fs.rmSync(o.out, { force: true }); } catch (e) { /* ignore */ } };
    const finish = (fn, v, failed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      if (failed) cleanup();
      fn(v);
    };
    const onAbort = () => { try { child.kill(); } catch (e) { /* gone */ } finish(reject, codeError('ABORTED', 'Cancelled'), true); };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish(reject, codeError('PROXY_TIMEOUT', 'Preparing the video took too long'), true); }, o.timeoutMs || Math.max(120000, o.duration * 4000));
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && o.onProgress) o.onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / Math.max(0.5, o.duration))));
      }
      if (buf.length > 4096) buf = '';
    });
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-600); });
    child.on('error', (e) => finish(reject, codeError('PROXY_FAILED', 'ffmpeg could not be started', { detail: String(e && e.message) }), true));
    child.on('close', (code) => {
      let size = 0;
      try { size = fs.statSync(o.out).size; } catch (e) { size = 0; }
      if (code === 0 && size > 1000) {
        if (size >= MAX_BYTES * 0.99) finish(reject, codeError('PROXY_TOO_LARGE', 'The reduced copy is larger than the service accepts'), true);
        else finish(resolve, { file: o.out, bytes: size });
      } else {
        finish(reject, codeError('PROXY_FAILED', 'The video could not be prepared for analysis', { detail: err.trim() }), true);
      }
    });
  });
}

module.exports = { makeProxy, buildArgs, scaleFilter, MAX_BYTES, FPS };
