'use strict';
// Shared helpers for the export tests: fixture generation and measurement utilities built on ffmpeg/ffprobe.
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { resolveBinaries } = require('../src/main/ffmpeg-paths');

const bins = resolveBinaries({ resourcesPath: null });
const FIX = path.join(__dirname, 'fixtures');

function ff(args, opts) {
  const r = spawnSync(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], Object.assign({ maxBuffer: 1024 * 1024 * 512 }, opts));
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr ? r.stderr.toString() : '') + '\nargs: ' + args.join(' '));
  return r;
}

function probeJson(file) {
  const out = execFileSync(bins.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 1024 * 1024 * 64 });
  return JSON.parse(out.toString('utf8'));
}

function streamsOf(file) {
  const j = probeJson(file);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { v, a, duration: Number(j.format.duration), format: j.format, all: j.streams };
}

function countFrames(file) {
  const out = execFileSync(bins.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  return Number(out.toString().trim());
}

function barWidth(w) {
  return Math.max(6, Math.round(w / 128));
}

// Time-coded test pattern: flat dark background + faint grid + a white bar whose x position encodes time.
function patternSource(w, h, fps, dur, bg, pxPerSec) {
  const barW = barWidth(w);
  return `color=c=${bg}:s=${w}x${h}:r=${fps}:d=${dur},drawgrid=w=${Math.round(w / 8)}:h=${Math.round(h / 4)}:t=1:c=0x808080@0.35[bg];` +
    `color=c=white:s=${barW}x${h}:r=${fps}:d=${dur}[bar];[bg][bar]overlay=x='t*${pxPerSec}':y=0:eval=frame,format=yuv420p`;
}

function makeFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const f = {
    A: path.join(FIX, 'A_audio_720p.mp4'),
    B: path.join(FIX, 'B_silent_480p_25fps.mp4'),
    C: path.join(FIX, 'C_rotated_phone.mp4'),
    D: path.join(FIX, 'D_legacy.avi'),
    E: path.join(FIX, 'Türkçe Klasör', 'örnek_şğıİ video.mp4'),
    F: path.join(FIX, 'F_ntsc_1080p_mono.mp4'),
  };

  // A: 1280x720 @30 fps, 8 s, stereo audio whose pitch steps up every second: f(t) = 300 + 100*floor(t) Hz.
  if (!fs.existsSync(f.A)) {
    ff(['-f', 'lavfi', '-i', patternSource(1280, 720, 30, 8, '0x203040', 160),
      '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(300+100*floor(t))*t)|0.5*sin(2*PI*(300+100*floor(t))*t)':s=48000:d=8",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '128k', '-y', f.A]);
  }
  // B: 4:3 640x480 @25 fps, 5 s, NO audio track.
  if (!fs.existsSync(f.B)) {
    ff(['-f', 'lavfi', '-i', patternSource(640, 480, 25, 5, '0x502020', 128),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '12', '-an', '-y', f.B]);
  }
  // C: "phone" video: 1280x720 coded + 90 degree display rotation => displays as 720x1280.
  if (!fs.existsSync(f.C)) {
    ff(['-display_rotation', '90', '-i', f.A, '-t', '4', '-c', 'copy', '-y', f.C]);
  }
  // D: legacy AVI (mpeg4 + mp3) that Chromium cannot play => needs a preview proxy.
  if (!fs.existsSync(f.D)) {
    ff(['-f', 'lavfi', '-i', patternSource(480, 270, 24, 4, '0x203040', 120),
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=44100',
      '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-b:a', '96k', '-y', f.D]);
  }
  // E: same content as A (first 4 s) in a Turkish-named folder/file.
  if (!fs.existsSync(f.E)) {
    fs.mkdirSync(path.dirname(f.E), { recursive: true });
    ff(['-i', f.A, '-t', '4', '-c', 'copy', '-y', f.E]);
  }
  // F: NTSC 29.97 fps 1080p with a MONO 44.1 kHz audio track.
  if (!fs.existsSync(f.F)) {
    ff(['-f', 'lavfi', '-i', patternSource(1920, 1080, '30000/1001', 3, '0x203040', 240),
      '-f', 'lavfi', '-i', 'sine=frequency=600:duration=3:sample_rate=44100', '-ac', '1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-y', f.F]);
  }
  return f;
}

// Raw 8-bit luma of the frame displayed at time t.
function grayFrame(file, t, w, h) {
  const r = ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1024 * 1024 * 64 });
  const buf = r.stdout;
  if (buf.length < w * h) throw new Error(`short frame at t=${t}: ${buf.length} < ${w * h}`);
  return buf;
}

// Centroid (edge coordinates) of the bright bar. Returns null if no bar visible.
function barCentroid(buf, w, h, threshold) {
  const thr = threshold || 235;
  let sw = 0;
  let sx = 0;
  for (let y = 0; y < h; y += 2) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = buf[row + x];
      if (v >= thr) { sw += 1; sx += x + 0.5; }
    }
  }
  return sw > 8 ? sx / sw : null;
}

// Source time encoded by the bar in a frame of an (optionally scaled) output.
function barTime(file, t, outW, outH, srcW, pxPerSec) {
  const buf = grayFrame(file, t, outW, outH);
  const cx = barCentroid(buf, outW, outH);
  if (cx === null) return null;
  const xSrc = cx * (srcW / outW);
  return (xSrc - barWidth(srcW) / 2) / pxPerSec;
}

// Dominant frequency (Hz) of the audio in [t, t+win] using positive-going zero crossings.
function audioFreq(file, t, win) {
  const w = win || 0.2;
  const r = ff(['-ss', String(t), '-t', String(w), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1024 * 1024 * 16 });
  const b = r.stdout;
  const n = Math.floor(b.length / 2);
  if (n < 100) return 0;
  let crossings = 0;
  let prev = b.readInt16LE(0);
  for (let i = 1; i < n; i++) {
    const cur = b.readInt16LE(i * 2);
    if (prev < 0 && cur >= 0) crossings += 1;
    prev = cur;
  }
  return crossings / (n / 16000);
}

// Mean volume (dB) of [t, t+dur] via volumedetect.
function meanVolume(file, t, dur) {
  const args = ['-hide_banner', '-nostdin', '-ss', String(t), '-t', String(dur), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'];
  const r = spawnSync(bins.ffmpeg, args, { maxBuffer: 1024 * 1024 * 16 });
  const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(r.stderr.toString());
  if (!m) return null;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

// Average luma (0..255) of a frame.
function meanLuma(file, t, w, h) {
  const buf = grayFrame(file, t, w, h);
  let s = 0;
  for (let i = 0; i < buf.length; i += 7) s += buf[i];
  return s / Math.ceil(buf.length / 7);
}

module.exports = { bins, FIX, ff, probeJson, streamsOf, countFrames, makeFixtures, patternSource, barWidth, grayFrame, barCentroid, barTime, audioFreq, meanVolume, meanLuma };
