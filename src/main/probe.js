'use strict';
// ffprobe wrapper: turns a media file into a normalised description used by the editor.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const procs = require('./procs');
const { assertLocalMediaPath, guardArgs, inputArgs } = require('./media-guard');

function execFileP(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, Object.assign({ windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, options), (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    procs.track(child);
  });
}

function parseRate(str) {
  if (!str || typeof str !== 'string') return 0;
  const parts = str.split('/');
  const n = Number(parts[0]);
  const d = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

function parseSar(str) {
  if (!str || typeof str !== 'string') return 1;
  const m = /^(\d+):(\d+)$/.exec(str);
  if (!m) return 1;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!n || !d) return 1;
  return n / d;
}

function rotationOf(stream) {
  let rot = 0;
  if (stream.tags && stream.tags.rotate !== undefined) rot = Number(stream.tags.rotate) || 0;
  if (Array.isArray(stream.side_data_list)) {
    for (const sd of stream.side_data_list) {
      if (sd && sd.rotation !== undefined) { rot = Number(sd.rotation) || 0; break; }
    }
  }
  return ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
}

// Duration fallback for files whose header has no duration (e.g. recorded WebM): read all packets without decoding.
// A hostile file must not be able to hang the import: the error output is drained (an unread pipe would block ffmpeg) and the scan has a time limit.
function scanDuration(ffmpegPath, filePath, timeoutMs) {
  return new Promise((resolve) => {
    const child = procs.track(spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...inputArgs(filePath), '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'], { windowsHide: true }));
    let last = 0;
    let buf = '';
    child.stderr.resume();
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* already gone */ } }, timeoutMs || 120000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) last = Math.max(last, Number(m[1]) / 1e6);
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve(0); });
    child.on('close', () => { clearTimeout(timer); resolve(last); });
  });
}

const DIRECT_VCODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const DIRECT_ACODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

// Decide whether Chromium can play the file directly; otherwise a low-resolution proxy is built for the preview.
function previewSupport(info) {
  const containerOk = /(^|,)(mov|mp4|matroska|webm|ogg)(,|$)/.test(info.container || '');
  const vcodec = info.vcodec;
  const eightBit420 = !info.pixFmt || /^(yuvj?420p|yuva420p)$/.test(info.pixFmt);
  let videoOk = DIRECT_VCODECS.has(vcodec);
  if (vcodec === 'h264' && !eightBit420) videoOk = false;
  const maybe = vcodec === 'hevc' && eightBit420; // depends on the machine; the renderer falls back to a proxy on error
  const audioOk = !info.hasAudio || DIRECT_ACODECS.has(info.acodec) || /^pcm_/.test(info.acodec || '');
  if (!containerOk) return { needsProxy: true, reason: 'container' };
  if (!videoOk && !maybe) return { needsProxy: true, reason: 'video' };
  if (!audioOk) return { needsProxy: true, reason: 'audio' };
  return { needsProxy: false, maybe };
}

async function probe(bins, filePath) {
  // URLs and device paths never reach ffprobe (UNC paths were already allowed or refused by the caller, depending on who chose the file)
  assertLocalMediaPath(filePath, { allowNetwork: true });
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    const err = new Error('File not found: ' + filePath);
    err.code = 'ENOENT';
    throw err;
  }
  if (!stat.isFile()) {
    const err = new Error('Not a file: ' + filePath);
    err.code = 'ENOTFILE';
    throw err;
  }

  let json;
  try {
    const { stdout } = await execFileP(bins.ffprobe, ['-v', 'error', ...guardArgs(), '-print_format', 'json', '-show_format', '-show_streams', filePath], { timeout: 60000 });
    json = JSON.parse(stdout);
  } catch (e) {
    const err = new Error('ffprobe failed: ' + (e.stderr || e.message));
    err.code = 'PROBE_FAILED';
    throw err;
  }

  const streams = Array.isArray(json.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) {
    const err = new Error('No video stream');
    err.code = 'NO_VIDEO';
    throw err;
  }

  const rotation = rotationOf(v);
  const swap = rotation === 90 || rotation === 270;
  const sar = parseSar(v.sample_aspect_ratio);
  const codedW = Number(v.width) || 0;
  const codedH = Number(v.height) || 0;
  if (!codedW || !codedH) {
    const err = new Error('Invalid video size');
    err.code = 'PROBE_FAILED';
    throw err;
  }
  let dispW = Math.round(codedW * (sar > 0 ? sar : 1));
  let dispH = codedH;
  if (swap) { const t = dispW; dispW = dispH; dispH = t; }

  let fps = parseRate(v.avg_frame_rate);
  if (!(fps > 0 && fps < 300)) fps = parseRate(v.r_frame_rate);
  if (!(fps > 0 && fps < 300)) fps = 30;

  let duration = Number(json.format && json.format.duration);
  if (!(duration > 0)) duration = Number(v.duration);
  if (!(duration > 0)) duration = await scanDuration(bins.ffmpeg, filePath);
  if (!(duration > 0)) {
    const err = new Error('Unknown duration');
    err.code = 'PROBE_FAILED';
    throw err;
  }

  const info = {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    duration,
    container: json.format && json.format.format_name ? json.format.format_name : '',
    width: codedW,
    height: codedH,
    displayWidth: dispW,
    displayHeight: dispH,
    rotation,
    fps,
    vcodec: v.codec_name || '',
    pixFmt: v.pix_fmt || '',
    hdr: /^(smpte2084|arib-std-b67)$/.test(v.color_transfer || ''),
    hasAudio: !!a,
    acodec: a ? (a.codec_name || '') : '',
    achannels: a ? Number(a.channels) || 0 : 0,
    asampleRate: a ? Number(a.sample_rate) || 0 : 0,
  };
  const support = previewSupport(info);
  info.needsProxy = support.needsProxy;
  info.proxyReason = support.reason || '';
  info.proxyMaybe = !!support.maybe;
  return info;
}

async function versionOf(binPath) {
  try {
    const { stdout } = await execFileP(binPath, ['-version'], { timeout: 15000 });
    const m = /version\s+(\S+)/.exec(stdout);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

module.exports = { probe, versionOf, previewSupport, execFileP };
