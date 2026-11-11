// Export engine of the web edition. The timeline is rendered frame by frame in the page: the browser's own decoders (WebCodecs, through Mediabunny)
// produce the source frames, a canvas does the letterbox / zoom / fade maths, the browser's encoders (hardware when available) write H.264 + AAC,
// and Mediabunny muxes the result into an MP4 that is streamed straight into the file the user chose. Nothing leaves the computer.
//
// The timeline semantics are the desktop edition's (same shared model, same plan, same frame / sample counts):
//   - every clip is conformed to one canvas (letterbox) and one frame rate; frame n of a clip shows the source frame nearest to in + n/fps * speed
//   - zoom z(n) = z0 * (z1 / z0)^(n / nf), window centred on the focus point and clamped to the picture
//   - audio: 48 kHz stereo, tempo changes with WSOLA (pitch preserved), volume, linear fades, silence for muted / silent clips
import { Output, Mp4OutputFormat, StreamTarget, BufferTarget, CanvasSource, AudioSampleSource, AudioSample, CanvasSink, AudioBufferSink, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec } from '../../../vendor/mediabunny/mediabunny.min.mjs';
import { openInput } from './media.js';
import { AUDIO_RATE, Resampler, TempoChain, downmixToStereo } from './audio-dsp.js';

const M = window.VE.model;

const QUALITY = {
  high: { bpp: 0.2, audioBitrate: 192000 },
  medium: { bpp: 0.11, audioBitrate: 160000 },
  low: { bpp: 0.06, audioBitrate: 128000 },
  // not offered in the export dialog: the small copy of a video that the video analysis (Content Understanding) uploads (about 0.04 MB per second)
  proxy: { bpp: 0.03, audioBitrate: 48000, minBitrate: 2.5e5 },
};
const MIN_BITRATE = 1.5e6;
const MAX_BITRATE = 80e6;
const AUDIO_CHUNK = 24000; // samples per block handed to the encoder (0.5 s)
const MAX_LEAD = 5; // seconds one track may run ahead of the other

export function codeError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/* ------------------------------------------------------------------ plan */

// The same plan the desktop edition builds for FFmpeg (canvas, fps, per-clip frame counts, letterbox rectangle, zoom supersampling).
export function buildPlan(input) {
  const segments = input.segments || [];
  const media = input.media || {};
  const raw = input.settings || {};
  const settings = {
    resolution: ['original', '1080', '720', '480'].includes(String(raw.resolution)) ? String(raw.resolution) : 'original',
    aspect: ['auto', '16:9', '9:16', '1:1', '4:3'].includes(String(raw.aspect)) ? String(raw.aspect) : 'auto',
    fps: ['auto', '24', '25', '30', '50', '60'].includes(String(raw.fps)) ? String(raw.fps) : 'auto',
    quality: QUALITY[raw.quality] ? raw.quality : 'high',
  };
  if (!segments.length) throw codeError('EMPTY', 'Nothing to export');
  const first = media[segments[0].mediaId];
  if (!first) throw codeError('MEDIA_MISSING', 'Unknown media: ' + segments[0].mediaId);
  const canvas = M.canvasSize(settings, first);
  const fps = M.exportFps(settings, first);
  const quality = QUALITY[settings.quality];
  let startFrame = 0;
  const items = segments.map((rawSeg, index) => {
    const m = media[rawSeg.mediaId];
    if (!m) throw codeError('MEDIA_MISSING', 'Unknown media: ' + rawSeg.mediaId);
    const seg = M.sanitizeSegment(rawSeg, m);
    const nf = M.frameCount(seg, fps);
    const fit = M.fitRect(m.displayWidth, m.displayHeight, canvas.width, canvas.height, true);
    let k = 1;
    if (M.hasZoom(seg)) {
      // zoom on a supersampled frame when the source has more detail than the output (<= 2x)
      k = Math.min(2, Math.max(seg.zoomFrom, seg.zoomTo), m.displayWidth / fit.w);
      if (!(k > 1.05)) k = 1;
    }
    const item = { index, seg, media: m, nf, outDur: nf / fps.value, fit, k, startFrame, useAudio: !!(m.hasAudio && !seg.mute && seg.volume > 0) };
    startFrame += nf;
    return item;
  });
  const bitrate = Math.round(Math.min(MAX_BITRATE, Math.max(quality.minBitrate || MIN_BITRATE, canvas.width * canvas.height * fps.value * quality.bpp)));
  return {
    canvas, fps, settings, items, bitrate,
    audioBitrate: quality.audioBitrate,
    includeAudio: items.some((it) => it.media.hasAudio),
    totalFrames: startFrame,
    totalDuration: startFrame / fps.value,
  };
}

/* ------------------------------------------------------------------ helpers */

function describeError(e) {
  if (e && e.code && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code)) return e;
  const name = (e && e.name) || '';
  const msg = String((e && e.message) || e || '');
  let code = 'UNKNOWN';
  if (name === 'QuotaExceededError' || /quota|no space|disk full/i.test(msg)) code = 'DISK_FULL';
  else if (name === 'NotAllowedError' || name === 'SecurityError') code = 'PERMISSION';
  else if (name === 'NoModificationAllowedError' || name === 'InvalidStateError' && /file|stream|writable/i.test(msg)) code = 'OUT_BUSY';
  else if (name === 'NotFoundError' || name === 'NotReadableError') code = 'IO_PATH';
  else if (name === 'EncodingError' || /decod/i.test(msg)) code = 'INPUT_CORRUPT';
  else if (name === 'RangeError' || /out of memory|allocation/i.test(msg)) code = 'MEMORY';
  else if (/encoder/i.test(msg)) code = 'ENCODER';
  return codeError(code, msg, { details: (e && e.stack) || msg });
}

// Two producers (video, audio) run side by side; neither may get more than MAX_LEAD seconds ahead of the other.
class Pace {
  constructor() { this.t = { v: 0, a: 0 }; this.waiters = []; this.stopped = false; }
  set(kind, t) {
    this.t[kind] = t;
    this._wake();
  }
  stop() { this.stopped = true; this._wake(true); }
  _wake(all) {
    const keep = [];
    for (const w of this.waiters) { if (all || this.stopped || w.ok()) w.res(); else keep.push(w); }
    this.waiters = keep;
  }
  until(ok) {
    if (this.stopped || ok()) return Promise.resolve();
    return new Promise((res) => this.waiters.push({ ok, res }));
  }
}

/* ------------------------------------------------------------------ video */

async function videoTask(ctx, job) {
  const { plan, files, onFrame } = job;
  const { canvas, fps, items } = plan;
  const W = canvas.width;
  const H = canvas.height;
  const cv = job.canvas;
  const g = cv.getContext('2d', { alpha: false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const inputs = new Map();
  try {
    for (const it of items) {
      const { seg, media, nf, fit } = it;
      let rec = inputs.get(seg.mediaId);
      if (!rec) {
        const input = openInput(files[seg.mediaId]);
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw codeError('INPUT_CORRUPT', 'No video track in ' + media.name);
        rec = { input, track, first: await track.getFirstTimestamp() };
        inputs.set(seg.mediaId, rec);
      }
      const zoom = M.hasZoom(seg);
      const workW = zoom && it.k > 1 ? M.even(fit.w * it.k) : fit.w;
      const workH = zoom && it.k > 1 ? M.even(fit.h * it.k) : fit.h;
      const sink = new CanvasSink(rec.track, { width: workW, height: workH, fit: 'fill', poolSize: 3 });
      // "nearest source frame" (what FFmpeg's fps filter does) = the last frame at or before the time shifted by half a source frame
      const half = 0.5 / (media.fps > 0 ? media.fps : 30);
      const stamps = (function* () {
        for (let n = 0; n < nf; n++) yield Math.max(rec.first, seg.in + (n / fps.value) * seg.speed + half);
      })();
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const z0 = seg.zoomFrom;
      const z1 = seg.zoomTo;
      const gen = sink.canvasesAtTimestamps(stamps);
      let n = 0;
      try {
        for await (const wrapped of gen) {
          if (job.state.stop) throw codeError('CANCELLED', 'cancelled');
          const tOut = (it.startFrame + n) / fps.value;
          await job.pace.until(() => job.pace.t.a >= tOut - MAX_LEAD);
          if (job.state.stop) throw codeError('CANCELLED', 'cancelled');
          if (wrapped && wrapped.canvas) {
            const src = wrapped.canvas;
            if (fit.w !== W || fit.h !== H) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
            if (zoom) {
              const z = z0 === z1 ? z0 : z0 * Math.pow(z1 / z0, n / nf);
              const win = M.cropWindow(z, seg.fx, seg.fy);
              g.drawImage(src, win.x * src.width, win.y * src.height, win.w * src.width, win.h * src.height, fit.x, fit.y, fit.w, fit.h);
            } else {
              g.drawImage(src, fit.x, fit.y, fit.w, fit.h);
            }
            const f = M.fadeFactor(seg, n / fps.value, it.outDur);
            if (f < 0.9999) {
              g.globalAlpha = 1 - f;
              g.fillStyle = '#000';
              g.fillRect(0, 0, W, H);
              g.globalAlpha = 1;
            }
          }
          await job.vsrc.add(tOut, 1 / fps.value);
          n += 1;
          job.pace.set('v', (it.startFrame + n) / fps.value);
          onFrame(it.startFrame + n);
        }
      } finally {
        try { await gen.return(); } catch (e) { /* already closed */ }
      }
      if (n !== nf) throw codeError('INPUT_CORRUPT', 'Decoder returned ' + n + ' of ' + nf + ' frames for ' + media.name);
    }
  } finally {
    inputs.forEach((r) => { try { r.input.dispose(); } catch (e) { /* ignore */ } });
    job.pace.set('v', Infinity);
  }
}

/* ------------------------------------------------------------------ audio */

// Source audio of one clip as stereo 48 kHz chunks, already time-stretched (the clip's [in, out) range at its speed).
async function* clipAudio(rec, seg) {
  const sink = new AudioBufferSink(rec.track);
  const rs = new Resampler(rec.sampleRate, AUDIO_RATE);
  const chain = new TempoChain(seg.speed);
  let cursor = seg.in; // source time of the next sample we expect
  const through = (L, R) => {
    const r = rs.push(L, R);
    return chain.active ? chain.push(r.L, r.R) : r;
  };
  for await (const { buffer, timestamp } of sink.buffers(seg.in, seg.out)) {
    const sr = buffer.sampleRate;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    let from = 0;
    let to = channels[0].length;
    if (timestamp < cursor) from = Math.min(to, Math.round((cursor - timestamp) * sr));
    else if (timestamp - cursor > 0.5 / sr) {
      // a gap in the source audio: silence of the same length (capped, a broken file must not allocate gigabytes)
      const gap = Math.min(Math.round((timestamp - cursor) * sr), sr * 30);
      const z = new Float32Array(gap);
      const out = through(z, z);
      if (out.L.length) yield out;
      cursor = timestamp;
    }
    if (timestamp + to / sr > seg.out) to = Math.max(from, Math.floor((seg.out - timestamp) * sr));
    if (to <= from) continue;
    const part = channels.map((ch) => ch.subarray(from, to));
    const { L, R } = downmixToStereo(part);
    cursor = timestamp + to / sr;
    const out = through(L, R);
    if (out.L.length) yield out;
  }
  const tailRs = rs.flush();
  let out = chain.active && tailRs.L.length ? chain.push(tailRs.L, tailRs.R) : tailRs;
  if (out.L.length) yield out;
  if (chain.active) {
    out = chain.finish();
    if (out.L.length) yield out;
  }
}

function shapeBlock(L, R, startIdx, seg, outDur) {
  const vol = seg.volume;
  const fi = seg.fadeIn > 0.001 ? seg.fadeIn : 0;
  const fo = seg.fadeOut > 0.001 ? seg.fadeOut : 0;
  const foStart = outDur - fo;
  for (let i = 0; i < L.length; i++) {
    const t = (startIdx + i) / AUDIO_RATE;
    let gain = vol;
    if (fi && t < fi) gain *= t / fi;
    if (fo && t > foStart) gain *= Math.max(0, (outDur - t) / fo);
    const l = L[i] * gain;
    const r = R[i] * gain;
    L[i] = l > 1 ? 1 : l < -1 ? -1 : l;
    R[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  }
}

async function audioTask(ctx, job) {
  const { plan, files } = job;
  const { fps, items } = plan;
  const inputs = new Map();
  try {
    for (const it of items) {
      const { seg, media } = it;
      const s0 = Math.round((it.startFrame / fps.value) * AUDIO_RATE);
      const s1 = Math.round(((it.startFrame + it.nf) / fps.value) * AUDIO_RATE);
      const total = s1 - s0;
      let gen = null;
      if (it.useAudio) {
        let rec = inputs.get(seg.mediaId);
        if (!rec) {
          const input = openInput(files[seg.mediaId]);
          const track = await input.getPrimaryAudioTrack();
          if (!track) throw codeError('INPUT_CORRUPT', 'No audio track in ' + media.name);
          rec = { input, track, sampleRate: await track.getSampleRate() };
          inputs.set(seg.mediaId, rec);
        }
        gen = clipAudio(rec, seg);
      }
      const fifo = []; // { L, R, off }
      let fifoLen = 0;
      let done = !gen;
      let emitted = 0;
      try {
        while (emitted < total) {
          if (job.state.stop) throw codeError('CANCELLED', 'cancelled');
          const want = Math.min(AUDIO_CHUNK, total - emitted);
          while (fifoLen < want && !done) {
            let r;
            try { r = await gen.next(); } catch (e) { throw codeError('AUDIO', 'audio decode failed: ' + ((e && e.message) || e), { details: (e && e.stack) || '' }); }
            if (r.done) done = true;
            else { fifo.push({ L: r.value.L, R: r.value.R, off: 0 }); fifoLen += r.value.L.length; }
          }
          const L = new Float32Array(want);
          const R = new Float32Array(want);
          let filled = 0;
          while (filled < want && fifo.length) {
            const b = fifo[0];
            const take = Math.min(want - filled, b.L.length - b.off);
            L.set(b.L.subarray(b.off, b.off + take), filled);
            R.set(b.R.subarray(b.off, b.off + take), filled);
            b.off += take;
            filled += take;
            fifoLen -= take;
            if (b.off >= b.L.length) fifo.shift();
          }
          if (it.useAudio) shapeBlock(L, R, emitted, seg, it.outDur);
          const tStart = (s0 + emitted) / AUDIO_RATE;
          await job.pace.until(() => job.pace.t.v >= tStart - MAX_LEAD);
          if (job.state.stop) throw codeError('CANCELLED', 'cancelled');
          const data = new Float32Array(2 * want);
          data.set(L, 0);
          data.set(R, want);
          const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: AUDIO_RATE, timestamp: tStart });
          await job.asrc.add(sample);
          sample.close();
          emitted += want;
          job.pace.set('a', (s0 + emitted) / AUDIO_RATE);
        }
      } finally {
        if (gen) { try { await gen.return(); } catch (e) { /* already closed */ } }
      }
    }
  } finally {
    inputs.forEach((r) => { try { r.input.dispose(); } catch (e) { /* ignore */ } });
    job.pace.set('a', Infinity);
  }
}

/* ------------------------------------------------------------------ run */

async function execute(plan, req, state, report) {
  const { canvas, fps } = plan;
  const t0 = performance.now();
  let output = null;
  let fileWriter = null;
  let writerClosed = false;
  let existedBefore = 0;
  try {
    const vcodec = await getFirstEncodableVideoCodec(['avc'], { width: canvas.width, height: canvas.height, bitrate: plan.bitrate });
    if (!vcodec) throw codeError('ENCODER', 'H.264 encoding is not available for ' + canvas.width + 'x' + canvas.height);
    let acodec = null;
    if (plan.includeAudio) {
      acodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: AUDIO_RATE, bitrate: plan.audioBitrate });
      if (!acodec) throw codeError('ENCODER', 'No audio encoder available');
    }

    let target;
    if (req.handle && !req.toMemory) {
      try { existedBefore = (await req.handle.getFile()).size; } catch (e) { existedBefore = 0; }
      const writable = await req.handle.createWritable();
      fileWriter = writable.getWriter();
      // Mediabunny writes through a proxy so that the file stream stays under our control (abort on failure keeps the old file intact)
      const proxy = new WritableStream({
        write: (chunk) => fileWriter.write(chunk),
        close: () => { writerClosed = true; return fileWriter.close(); },
        abort: (reason) => { writerClosed = true; return fileWriter.abort(reason); },
      });
      target = new StreamTarget(proxy, { chunked: true, chunkSize: 8 * 1024 * 1024 });
    } else {
      target = new BufferTarget();
    }
    output = new Output({ format: new Mp4OutputFormat({ fastStart: req.handle && !req.toMemory ? 'reserve' : 'in-memory' }), target });

    const cv = new OffscreenCanvas(canvas.width, canvas.height);
    const vsrc = new CanvasSource(cv, { codec: vcodec, bitrate: plan.bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(vsrc, { frameRate: fps.value, maximumPacketCount: plan.totalFrames + 64 });
    let asrc = null;
    if (acodec) {
      asrc = new AudioSampleSource({ codec: acodec, bitrate: plan.audioBitrate });
      output.addAudioTrack(asrc, { maximumPacketCount: Math.ceil((plan.totalDuration * AUDIO_RATE) / 512 * 1.4) + 128 });
    }
    await output.start();

    const pace = new Pace();
    if (!asrc) pace.t.a = Infinity;
    let framesDone = 0;
    let lastReport = 0;
    const onFrame = (n) => {
      framesDone = n;
      const now = performance.now();
      if (now - lastReport < 120 && n < plan.totalFrames) return;
      lastReport = now;
      const fraction = Math.min(1, n / plan.totalFrames);
      const elapsed = (now - t0) / 1000;
      report({ fraction, elapsed, eta: fraction > 0.01 ? (elapsed * (1 - fraction)) / fraction : null, speed: elapsed > 0 ? (n / fps.value) / elapsed : 0 });
    };
    const job = { plan, files: req.files, state, pace, canvas: cv, vsrc, asrc, onFrame };
    const fail = (e) => { if (!state.error) state.error = e; state.stop = true; pace.stop(); throw e; };
    await Promise.all([
      videoTask(null, job).catch(fail),
      asrc ? audioTask(null, job).catch(fail) : Promise.resolve(),
    ]);
    if (state.stop) throw state.error || codeError('CANCELLED', 'cancelled');
    await output.finalize();
    if (fileWriter && !writerClosed) { writerClosed = true; await fileWriter.close(); }
    report({ fraction: 1, elapsed: (performance.now() - t0) / 1000, eta: 0, speed: plan.totalDuration / Math.max(0.001, (performance.now() - t0) / 1000) });
    if (target instanceof BufferTarget) {
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      return { blob, size: blob.size, vcodec, acodec };
    }
    const size = (await req.handle.getFile()).size;
    return { blob: null, size, vcodec, acodec };
  } catch (e) {
    const err = state.error || (e && e.code === 'CANCELLED' ? e : describeError(e));
    try { if (output) await output.cancel(); } catch (e2) { /* already stopped */ }
    if (fileWriter && !writerClosed) { writerClosed = true; try { await fileWriter.abort(); } catch (e2) { /* ignore */ } }
    if (req.handle && !req.toMemory && existedBefore === 0 && typeof req.handle.remove === 'function') {
      try { await req.handle.remove(); } catch (e2) { /* an empty file may stay; nothing was written */ }
    }
    throw err;
  }
}

// req: { segments, media (id -> probe info), files (id -> File), settings, outName, handle?, toMemory?, onProgress }
// -> { plan, promise, cancel }; the promise resolves with { blob?, size, vcodec, acodec } or rejects with a coded error (CANCELLED when cancelled)
export function runExport(req) {
  const plan = buildPlan({ segments: req.segments, media: req.media, settings: req.settings });
  const state = { stop: false, error: null };
  const report = (p) => { try { req.onProgress && req.onProgress(p); } catch (e) { /* progress is best effort */ } };
  const body = () => execute(plan, req, state, report);
  const promise = navigator.locks && navigator.locks.request
    ? navigator.locks.request('video-editor-export', { ifAvailable: true }, body) // a held lock keeps a background tab from being throttled
    : body();
  return {
    plan,
    promise,
    cancel() { state.stop = true; if (!state.error) state.error = codeError('CANCELLED', 'cancelled'); },
  };
}
