'use strict';
// FFmpeg export pipeline. Pure Node (no Electron APIs) so that it can be unit-tested with plain `node`.
//
// One ffmpeg process renders the whole timeline: every segment is read with input-level -ss/-t (fast on long files),
// conformed to the output canvas (size / SAR / fps / pix_fmt / 48 kHz stereo audio) and joined with the concat filter.
//
// Zoom uses the `perspective` filter with eval=frame on 4:4:4 data: sub-pixel exact and free of the jitter that
// `zoompan` produces (measured: <=0.03 px error vs. ~6 px for zoompan, see tests/zoom-research*.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const model = require('../shared/model');
const procs = require('./procs');
const { assertLocalMediaPath, guardArgs } = require('./media-guard');

const AUDIO_RATE = 48000;

const QUALITY = {
  high: { crf: 18, preset: 'medium', audioBitrate: '192k' },
  medium: { crf: 22, preset: 'fast', audioBitrate: '160k' },
  low: { crf: 27, preset: 'veryfast', audioBitrate: '128k' },
};

function fmt(n, digits) {
  const d = digits === undefined ? 6 : digits;
  return String(Number(Number(n).toFixed(d)));
}

function codeError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// atempo only accepts 0.5..2.0 per instance in older builds, so long speed changes are chained.
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2 + 1e-9) { parts.push(2); s /= 2; }
  while (s < 0.5 - 1e-9) { parts.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-9) parts.push(s);
  return parts.map((f) => 'atempo=' + fmt(f, 6));
}

// Smooth, sub-pixel exact zoom. (ww x hh) is the working size the filter runs on.
// Index-space correction: output pixel i samples source index X0 + (i + 0.5)/z - 0.5.
// NOTE: perspective's `in` counter is 1-based, hence (in-1).
function perspectiveFilter(ww, hh, nf, seg) {
  const z0 = seg.zoomFrom;
  const z1 = seg.zoomTo;
  const animated = Math.abs(z1 - z0) > 1e-9;
  const base = 'sense=source:interpolation=cubic';
  if (!animated) {
    const win = model.cropWindow(z0, seg.fx, seg.fy);
    const c = 0.5 / z0 - 0.5;
    const x0 = win.x * ww + c;
    const y0 = win.y * hh + c;
    const x1 = x0 + ww / z0;
    const y2 = y0 + hh / z0;
    return `perspective=x0=${fmt(x0, 6)}:y0=${fmt(y0, 6)}:x1=${fmt(x1, 6)}:y1=${fmt(y0, 6)}:x2=${fmt(x0, 6)}:y2=${fmt(y2, 6)}:x3=${fmt(x1, 6)}:y3=${fmt(y2, 6)}:${base}`;
  }
  const Z = `(${fmt(z0, 9)}*pow(${fmt(z1 / z0, 9)},(in-1)/${nf}))`;
  const X0 = `clip(${fmt(seg.fx * ww, 6)}-${ww}/(2*${Z}),0,${ww}-${ww}/${Z})`;
  const Y0 = `clip(${fmt(seg.fy * hh, 6)}-${hh}/(2*${Z}),0,${hh}-${hh}/${Z})`;
  const c = `(0.5/${Z}-0.5)`;
  const x0 = `${X0}+${c}`;
  const y0 = `${Y0}+${c}`;
  const x1 = `${X0}+${c}+${ww}/${Z}`;
  const y2 = `${Y0}+${c}+${hh}/${Z}`;
  return `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':eval=frame:${base}`;
}

function buildPlan(input) {
  const segments = input.segments || [];
  const media = input.media || {};
  const rawSettings = input.settings || {};
  const settings = {
    resolution: ['original', '1080', '720', '480'].includes(String(rawSettings.resolution)) ? String(rawSettings.resolution) : 'original',
    aspect: ['auto', '16:9', '9:16', '1:1', '4:3'].includes(String(rawSettings.aspect)) ? String(rawSettings.aspect) : 'auto',
    fps: ['auto', '24', '25', '30', '50', '60'].includes(String(rawSettings.fps)) ? String(rawSettings.fps) : 'auto',
    quality: QUALITY[rawSettings.quality] ? rawSettings.quality : 'high',
  };
  if (!segments.length) throw codeError('EMPTY', 'Nothing to export');

  const first = media[segments[0].mediaId];
  if (!first) throw codeError('MEDIA_MISSING', 'Unknown media: ' + segments[0].mediaId);
  const canvas = model.canvasSize(settings, first);
  const fps = model.exportFps(settings, first);
  const quality = QUALITY[settings.quality] || QUALITY.high;

  const items = segments.map((raw, index) => {
    const m = media[raw.mediaId];
    if (!m) throw codeError('MEDIA_MISSING', 'Unknown media: ' + raw.mediaId);
    const seg = model.sanitizeSegment(raw, m);
    const nf = model.frameCount(seg, fps);
    const fit = model.fitRect(m.displayWidth, m.displayHeight, canvas.width, canvas.height, true);
    let k = 1;
    if (model.hasZoom(seg)) {
      // Run the zoom on a supersampled frame when the source has more detail than the output.
      k = Math.min(2, Math.max(seg.zoomFrom, seg.zoomTo), m.displayWidth / fit.w);
      if (!(k > 1.05)) k = 1;
    }
    return {
      index,
      seg,
      media: m,
      nf,
      outDur: nf / fps.value,
      fit,
      k,
      useAudio: !!(m.hasAudio && !seg.mute && seg.volume > 0),
    };
  });

  const includeAudio = items.some((it) => it.media.hasAudio);
  const totalDuration = items.reduce((sum, it) => sum + it.outDur, 0);
  return { canvas, fps, quality, items, includeAudio, totalDuration };
}

function buildFilterGraph(plan) {
  const { canvas, fps, items, includeAudio } = plan;
  const lines = [];

  items.forEach((it, i) => {
    const seg = it.seg;
    const { w: cw, h: ch, x: px, y: py } = it.fit;
    const v = [];
    v.push(`setpts=(PTS-STARTPTS)/${fmt(seg.speed, 6)}`);
    v.push(`fps=fps=${fps.expr}:round=near`);
    v.push('tpad=stop_mode=clone:stop_duration=1');
    v.push(`trim=end_frame=${it.nf}`);
    v.push(`setpts=N/(${fps.expr})/TB`);

    if (model.hasZoom(seg)) {
      const ww = it.k > 1 ? model.even(cw * it.k) : cw;
      const hh = it.k > 1 ? model.even(ch * it.k) : ch;
      v.push(`scale=${ww}:${hh}:flags=bicubic`);
      v.push('format=yuv444p');
      v.push(perspectiveFilter(ww, hh, it.nf, seg));
      if (it.k > 1) v.push(`scale=${cw}:${ch}:flags=bicubic`);
      v.push('format=yuv420p');
    } else {
      v.push(`scale=${cw}:${ch}:flags=bicubic`);
      v.push('format=yuv420p');
    }
    v.push('setsar=1');
    if (cw !== canvas.width || ch !== canvas.height) {
      v.push(`pad=${canvas.width}:${canvas.height}:${px}:${py}:color=black`);
    }
    if (seg.fadeIn > 0.001) v.push(`fade=t=in:st=0:d=${fmt(seg.fadeIn, 4)}`);
    if (seg.fadeOut > 0.001) v.push(`fade=t=out:st=${fmt(Math.max(0, it.outDur - seg.fadeOut), 4)}:d=${fmt(seg.fadeOut, 4)}`);
    lines.push(`[${i}:v:0]${v.join(',')}[v${i}]`);

    if (includeAudio) {
      if (it.useAudio) {
        const a = [];
        a.push(`aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`);
        const tempo = atempoChain(seg.speed);
        if (tempo.length) { a.push(...tempo); a.push('asetpts=PTS-STARTPTS'); }
        if (Math.abs(seg.volume - 1) > 1e-6) a.push(`volume=${fmt(seg.volume, 4)}`);
        if (seg.fadeIn > 0.001) a.push(`afade=t=in:st=0:d=${fmt(seg.fadeIn, 4)}`);
        if (seg.fadeOut > 0.001) a.push(`afade=t=out:st=${fmt(Math.max(0, it.outDur - seg.fadeOut), 4)}:d=${fmt(seg.fadeOut, 4)}`);
        a.push(`apad=whole_dur=${fmt(it.outDur, 6)}`);
        a.push(`atrim=end=${fmt(it.outDur, 6)}`);
        a.push('asetpts=PTS-STARTPTS');
        lines.push(`[${i}:a:0]${a.join(',')}[a${i}]`);
      } else {
        lines.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,aformat=sample_fmts=fltp,atrim=end=${fmt(it.outDur, 6)},asetpts=PTS-STARTPTS[a${i}]`);
      }
    }
  });

  const joined = items.map((_, i) => `[v${i}]` + (includeAudio ? `[a${i}]` : '')).join('');
  lines.push(`${joined}concat=n=${items.length}:v=1:a=${includeAudio ? 1 : 0}[outv]${includeAudio ? '[outa]' : ''}`);
  return lines.join(';\n');
}

// Every clip of the timeline is a separate ffmpeg input with its own demuxer and decoder. Left on "auto", each decoder
// starts up to 16 frame threads that hold ~2 frames each: ~110 MB per clip at 1080p, so 120 cuts of one file need
// 14.5 GB (measured). The decoder threads are therefore budgeted over all inputs (1..8 per input); the same project then
// needs 4.2 GB. The x264 pool is capped on 4K canvases (12 threads: -48 % memory for <= 5 % slower exports, measured).
const DECODER_BUDGET_BYTES = 0.8e9;

function threadPlan(plan, cores) {
  const n = Math.max(1, Math.round(cores || os.cpus().length));
  let weight = 0;
  for (const it of plan.items) weight += (it.media.width * it.media.height * 3) || 0;
  let input = Math.floor(DECODER_BUDGET_BYTES / Math.max(weight, 1));
  if (!Number.isFinite(input)) input = 4;
  input = Math.max(1, Math.min(8, n, input));
  const canvasPixels = plan.canvas.width * plan.canvas.height;
  return { input, encoder: canvasPixels > 2.5e6 ? Math.min(n, 12) : 0 };
}

// inputPaths (optional): one path per plan item, used instead of the media path (see aliasInputs).
function buildArgs(plan, scriptPath, partPath, inputPaths) {
  const args = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  const threads = threadPlan(plan);
  plan.items.forEach((it, i) => {
    if (it.seg.in > 0.0005) args.push('-ss', fmt(it.seg.in, 6));
    args.push('-threads', String(threads.input));
    args.push('-t', fmt(it.seg.out - it.seg.in, 6), ...guardArgs(), '-i', inputPaths ? inputPaths[i] : it.media.path);
  });
  // `-filter_complex_script` was removed in FFmpeg 8; `-/filter_complex <file>` (FFmpeg 7+) reads the filter graph from the file the same way.
  args.push('-/filter_complex', scriptPath);
  args.push('-map', '[outv]');
  if (plan.includeAudio) args.push('-map', '[outa]');
  args.push('-map_metadata', '-1', '-map_chapters', '-1');
  args.push('-c:v', 'libx264', '-preset', plan.quality.preset, '-crf', String(plan.quality.crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p');
  if (threads.encoder) args.push('-threads', String(threads.encoder));
  args.push('-r', plan.fps.expr);
  if (plan.includeAudio) args.push('-c:a', 'aac', '-b:a', plan.quality.audioBitrate, '-ar', String(AUDIO_RATE), '-ac', '2');
  args.push('-movflags', '+faststart', '-f', 'mp4', partPath);
  return args;
}

// Windows limits a command line to 32,767 characters and every clip is its own `-i`. Projects with many cuts of files in
// deeply nested folders can exceed it, so long input paths are replaced by short names (hard links in the temp folder,
// ffmpeg runs with that folder as its working directory). Where a link is impossible (other drive, network share, FAT) the
// real path is kept.
const CMD_SOFT_LIMIT = 30000;
const CMD_HARD_LIMIT = 31500;

function commandLength(exe, args) {
  let len = exe.length + 3;
  for (const a of args) len += a.length + 1 + (/[\s"]/.test(a) ? 2 + (a.match(/["\\]/g) || []).length : 0);
  return len;
}

function aliasInputs(plan, tempDir) {
  const aliases = new Map();
  let k = 0;
  for (const it of plan.items) {
    const real = it.media.path;
    if (aliases.has(real)) continue;
    const ext = path.extname(real).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const name = 'i' + (k++) + ext;
    try {
      fs.linkSync(real, path.join(tempDir, name));
      aliases.set(real, name);
    } catch (e) {
      aliases.set(real, null);
    }
  }
  return aliases;
}

// The same physical file, even when reached through another path (case, junction, subst drive, hard link).
function isSameFile(a, b) {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    if (sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev) return true;
  } catch (e) { /* the destination usually does not exist yet */ }
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Antivirus / indexer scans briefly lock a freshly written file: retry the final rename instead of failing a long export.
async function renameWithRetry(from, to, attempts, delayMs) {
  const max = attempts || 10;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) break;
      await sleep(delayMs || 500);
    }
  }
  throw lastErr;
}

// Maps ffmpeg's stderr to a stable error kind that the UI can translate.
function classifyFfmpegError(text) {
  const t = text || '';
  if (/No space left on device|disk full/i.test(t)) return 'DISK_FULL';
  if (/Permission denied|Access is denied|used by another process/i.test(t)) return 'PERMISSION';
  if (/Invalid data found when processing input|moov atom not found|corrupt|Invalid NAL|error while decoding/i.test(t)) return 'INPUT_CORRUPT';
  if (/Error opening input|No such file or directory|does not exist|Could not open|cannot find the (file|path)/i.test(t)) return 'IO_PATH';
  if (/Unknown encoder|Encoder .* not found|Unrecognized option|Option not found/i.test(t)) return 'ENCODER';
  if (/Cannot allocate memory|Out of memory|memory allocation/i.test(t)) return 'MEMORY';
  return 'UNKNOWN';
}

// Verify the destination can be written before spending minutes encoding.
function preflightOutput(outPath) {
  const dir = path.dirname(outPath);
  try {
    if (!fs.statSync(dir).isDirectory()) return 'OUT_DIR';
  } catch (e) {
    return 'OUT_DIR';
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    return 'OUT_DIR';
  }
  if (fs.existsSync(outPath)) {
    try {
      const fd = fs.openSync(outPath, 'r+');
      fs.closeSync(fd);
    } catch (e) {
      return 'OUT_BUSY';
    }
  }
  return null;
}

function removeQuiet(p) {
  try { fs.rmSync(p, { force: true, recursive: true }); } catch (e) { /* ignore */ }
}

// Starts an export. Returns { plan, args, promise, cancel }.
// options.commandLimits ({ soft, hard }) overrides the command-line limits (used by the tests).
function runExport(options) {
  const { ffmpegPath, outPath, onProgress, onLog } = options;
  const plan = buildPlan(options);
  const rejected = (err) => ({ plan, promise: Promise.reject(err), cancel() {} });

  // Every input was validated when it was imported (local path or a user-chosen share, container whitelist in ffprobe); URLs and device paths must never reach ffmpeg.
  for (const it of plan.items) {
    try { assertLocalMediaPath(it.media.path, { allowNetwork: true }); } catch (e) { return rejected(codeError('REMOTE_PATH', e.message)); }
  }

  // Never overwrite a source video of the project: the export reads it while writing, and the rename at the end would replace it.
  if (plan.items.some((it) => isSameFile(it.media.path, outPath))) {
    return rejected(codeError('OUT_IS_SOURCE', 'The output file is a source video of the project: ' + outPath));
  }
  const pre = preflightOutput(outPath);
  if (pre) return rejected(codeError(pre, 'Cannot write output: ' + outPath));

  const tempDir = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), 've-export-'));
  const scriptPath = path.join(tempDir, 'graph.txt');
  const partPath = outPath + '.part';
  fs.writeFileSync(scriptPath, buildFilterGraph(plan), 'utf8');
  const limits = Object.assign({ soft: CMD_SOFT_LIMIT, hard: CMD_HARD_LIMIT }, options.commandLimits);
  let args = buildArgs(plan, scriptPath, partPath);
  let cwd = null;
  if (commandLength(ffmpegPath, args) > limits.soft) {
    const aliases = aliasInputs(plan, tempDir);
    args = buildArgs(plan, scriptPath, partPath, plan.items.map((it) => aliases.get(it.media.path) || it.media.path));
    cwd = tempDir;
  }
  if (commandLength(ffmpegPath, args) > limits.hard) {
    removeQuiet(tempDir);
    return rejected(codeError('TOO_MANY_CLIPS', 'The command line of this project is too long (' + plan.items.length + ' clips)'));
  }
  if (options.logLevel) args[args.indexOf('-loglevel') + 1] = options.logLevel;

  let cancelled = false;
  let child = null;

  const promise = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const spawnOptions = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (cwd) spawnOptions.cwd = cwd;
    child = procs.track(spawn(ffmpegPath, args, spawnOptions));
    let stderrTail = '';
    let outBuf = '';
    let lastEmit = 0;
    const state = { outTime: 0, speed: 0, frame: 0, fps: 0 };

    const emit = (force) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastEmit < 120) return;
      lastEmit = now;
      const fraction = plan.totalDuration > 0 ? Math.min(1, state.outTime / plan.totalDuration) : 0;
      const eta = state.speed > 0 ? Math.max(0, (plan.totalDuration - state.outTime) / state.speed) : null;
      onProgress({ fraction, outTime: state.outTime, total: plan.totalDuration, speed: state.speed, fps: state.fps, frame: state.frame, eta, elapsed: (now - startedAt) / 1000 });
    };
    // FFmpeg 7+ no longer prints an initial progress block (0 %): report it ourselves so the UI shows the job at once.
    emit(true);

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString();
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const n = Number(val);
          if (Number.isFinite(n)) state.outTime = n / 1e6;
        } else if (key === 'speed') {
          const n = parseFloat(val);
          state.speed = Number.isFinite(n) ? n : 0;
        } else if (key === 'frame') {
          state.frame = Number(val) || 0;
        } else if (key === 'fps') {
          state.fps = Number(val) || 0;
        } else if (key === 'progress') {
          emit(val === 'end');
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (onLog) onLog(text);
      stderrTail = (stderrTail + text).slice(-6000);
    });

    child.on('error', (e) => {
      removeQuiet(tempDir);
      removeQuiet(partPath);
      reject(codeError('SPAWN_FAILED', 'Could not start ffmpeg: ' + e.message));
    });

    child.on('close', (code) => {
      removeQuiet(tempDir);
      if (cancelled) {
        removeQuiet(partPath);
        reject(codeError('CANCELLED', 'Export cancelled'));
        return;
      }
      if (code !== 0) {
        removeQuiet(partPath);
        reject(codeError('FFMPEG_FAILED', 'ffmpeg exited with code ' + code, { kind: classifyFfmpegError(stderrTail), details: stderrTail.trim(), exitCode: code }));
        return;
      }
      renameWithRetry(partPath, outPath).then(() => {
        let size = 0;
        try { size = fs.statSync(outPath).size; } catch (e) { /* ignore */ }
        state.outTime = plan.totalDuration;
        emit(true);
        resolve({ outPath, size, duration: plan.totalDuration, seconds: (Date.now() - startedAt) / 1000 });
      }, (e) => {
        removeQuiet(partPath);
        reject(codeError('OUT_BUSY', 'Could not finalise output: ' + e.message));
      });
    });
  });

  return {
    plan,
    args,
    promise,
    cancel() {
      cancelled = true;
      if (child) {
        try { child.kill(); } catch (e) { /* already gone */ }
      }
    },
  };
}

module.exports = { buildPlan, buildFilterGraph, buildArgs, threadPlan, commandLength, aliasInputs, isSameFile, renameWithRetry, runExport, classifyFfmpegError, atempoChain, perspectiveFilter, QUALITY, AUDIO_RATE };
