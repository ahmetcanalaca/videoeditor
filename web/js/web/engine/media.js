// Media helpers of the web edition: probing, timeline thumbnails and audio waveform peaks. Everything runs in the page with the browser's own
// decoders (WebCodecs through Mediabunny); the file is only ever read from the user's disk, never uploaded.
import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from '../../../vendor/mediabunny/mediabunny.min.mjs';

export const WAVE_BUCKETS_PER_SEC = 50;

const fail = (code, message) => Object.assign(new Error(message || code), { code });

// Number of thumbnails for a media of the given duration (the same rule as the desktop app).
export function thumbCountFor(duration) {
  return Math.max(6, Math.min(150, Math.round(duration / 3)));
}

// Generation order: evenly spread first, then refine, so the strip fills in progressively.
export function thumbOrder(count) {
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

const VIDEO_CODEC_NAMES = { avc: 'h264', hevc: 'hevc', vp8: 'vp8', vp9: 'vp9', av1: 'av1' };

export function openInput(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

// Returns the description the editor works with (the same fields as the desktop app's ffprobe wrapper).
export async function probeFile(file) {
  const input = openInput(file);
  try {
    try { await input.getFormat(); } catch (e) { throw fail('PROBE_FAILED', 'unrecognised or unsupported container'); }
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw fail('NO_VIDEO', 'No video stream');
    const a = await input.getPrimaryAudioTrack();
    const codedW = await v.getCodedWidth();
    const codedH = await v.getCodedHeight();
    const displayWidth = await v.getDisplayWidth();
    const displayHeight = await v.getDisplayHeight();
    if (!(codedW > 0 && codedH > 0 && displayWidth > 0 && displayHeight > 0)) throw fail('PROBE_FAILED', 'Invalid video size');
    const rotation = await v.getRotation();
    const codec = await v.getCodec();
    let duration = await input.computeDuration();
    if (!(duration > 0)) duration = (await input.getDurationFromMetadata()) || 0;
    if (!(duration > 0)) throw fail('PROBE_FAILED', 'Unknown duration');
    let fps = 0;
    try { fps = (await v.computePacketStats(300)).averagePacketRate; } catch (e) { /* keep the default below */ }
    if (!(fps > 0 && fps < 300)) fps = 30;
    if (!(await v.canDecode())) throw fail('UNSUPPORTED_CODEC', 'This browser cannot decode ' + (codec || 'this video'));
    let hdr = false;
    try { hdr = !!(await v.hasHighDynamicRange()); } catch (e) { /* unknown */ }
    let acodec = '';
    let achannels = 0;
    let asampleRate = 0;
    if (a) {
      acodec = (await a.getCodec()) || '';
      achannels = await a.getNumberOfChannels();
      asampleRate = await a.getSampleRate();
    }
    return {
      duration,
      container: '',
      width: codedW,
      height: codedH,
      displayWidth,
      displayHeight,
      rotation,
      fps,
      vcodec: VIDEO_CODEC_NAMES[codec] || String(codec || ''),
      pixFmt: '',
      hdr,
      hasAudio: !!a,
      acodec,
      achannels,
      asampleRate,
      needsProxy: false,
      proxyReason: '',
      proxyMaybe: false,
    };
  } finally {
    input.dispose();
  }
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no thumbnail'))), type, quality));
}

// onThumb(index, blob) for every thumbnail, coarse to fine; token.cancelled stops the work.
export async function generateThumbs({ file, duration, count, onThumb, token, height }) {
  const input = openInput(file);
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) return;
    const first = await v.getFirstTimestamp();
    const sink = new CanvasSink(v, { height: height || 96, fit: 'contain', poolSize: 2 });
    for (const index of thumbOrder(count)) {
      if (token && token.cancelled) return;
      const t = Math.max(first, Math.min(Math.max(0, (index + 0.5) * duration / count), Math.max(0, duration - 0.1)));
      let wrapped = null;
      try { wrapped = await sink.getCanvas(t); } catch (e) { wrapped = null; }
      if (!wrapped) continue;
      let blob = null;
      try { blob = await canvasToBlob(wrapped.canvas, 'image/jpeg', 0.7); } catch (e) { blob = null; }
      if (blob && !(token && token.cancelled)) onThumb(index, blob);
    }
  } finally {
    input.dispose();
  }
}

// Peaks (0..255, sqrt-scaled) at WAVE_BUCKETS_PER_SEC per second, or null when there is no audio.
export async function extractWaveform({ file, duration, token }) {
  const input = openInput(file);
  try {
    const a = await input.getPrimaryAudioTrack();
    if (!a) return null;
    const sink = new AudioBufferSink(a);
    const total = Math.ceil(duration * WAVE_BUCKETS_PER_SEC) + 2;
    const peaks = new Float32Array(total);
    let last = 0;
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (token && token.cancelled) return null;
      const sr = buffer.sampleRate;
      const n = buffer.length;
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      const stride = Math.max(1, Math.floor(sr / 8000));
      for (let i = 0; i < n; i += stride) {
        let s = 0;
        for (let c = 0; c < chans.length; c++) s += chans[c][i];
        const v = Math.abs(s / chans.length);
        const bucket = Math.floor((timestamp + i / sr) * WAVE_BUCKETS_PER_SEC);
        if (bucket >= 0 && bucket < total) {
          if (v > peaks[bucket]) peaks[bucket] = v;
          if (bucket > last) last = bucket;
        }
      }
    }
    const count = Math.min(total, Math.max(last + 1, Math.ceil(duration * WAVE_BUCKETS_PER_SEC)));
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = Math.min(255, Math.round(Math.sqrt(Math.min(1, peaks[i])) * 255));
    return out;
  } finally {
    input.dispose();
  }
}
