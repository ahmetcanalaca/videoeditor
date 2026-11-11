// Audio processing of the web export: channel downmix, sample-rate conversion and pitch-preserving time stretch (WSOLA).
// Pure JavaScript, no dependencies and no browser APIs, so that the maths can be tested in Node.
// All audio here is planar float32 stereo ({ L, R }); the export runs everything at 48 kHz.

export const AUDIO_RATE = 48000;

/* ------------------------------------------------------------------ helpers */

function concat(parts, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// speed -> list of tempo factors, each in 0.5..2 (the same chain the desktop edition builds for FFmpeg's atempo)
export function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2 + 1e-9) { parts.push(2); s /= 2; }
  while (s < 0.5 - 1e-9) { parts.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-9) parts.push(s);
  return parts;
}

/* ------------------------------------------------------------------ downmix */

// channels: array of Float32Array (one per channel, WebCodecs / AAC channel order: FL FR FC LFE BL BR SL SR).
// Returns { L, R } (the arrays are reused for mono / stereo input, not copied).
export function downmixToStereo(channels) {
  const n = channels.length;
  if (n === 1) return { L: channels[0], R: channels[0] };
  if (n === 2) return { L: channels[0], R: channels[1] };
  const len = channels[0].length;
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const c = 0.7071067811865476;
  // [left gains, right gains] per input channel, normalised so that full-scale input cannot exceed full scale (like swresample)
  let gl;
  let gr;
  if (n === 3) { gl = [1, 0, c]; gr = [0, 1, c]; } else if (n === 4) { gl = [1, 0, c, 0]; gr = [0, 1, 0, c]; } else if (n === 5) { gl = [1, 0, c, c, 0]; gr = [0, 1, c, 0, c]; } else if (n === 6) { gl = [1, 0, c, 0, c, 0]; gr = [0, 1, c, 0, 0, c]; } else if (n >= 8) { gl = [1, 0, c, 0, c, 0, c, 0]; gr = [0, 1, c, 0, 0, c, 0, c]; } else { gl = [1, 0, 0, 0, 0, 0, 0]; gr = [0, 1, 0, 0, 0, 0, 0]; }
  const sumL = gl.reduce((a, b) => a + b, 0) || 1;
  const sumR = gr.reduce((a, b) => a + b, 0) || 1;
  for (let ch = 0; ch < Math.min(n, gl.length); ch++) {
    const a = gl[ch] / sumL;
    const b = gr[ch] / sumR;
    const src = channels[ch];
    if (a) for (let i = 0; i < len; i++) L[i] += src[i] * a;
    if (b) for (let i = 0; i < len; i++) R[i] += src[i] * b;
  }
  return { L, R };
}

/* ------------------------------------------------------------------ resampler */

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

// Streaming windowed-sinc resampler (Kaiser window, 16 zero crossings per side). The filter is symmetric, so there is no delay:
// output sample i is the input at i * inRate / outRate. Gain at DC is exactly 1 (weights are normalised per output sample).
export class Resampler {
  constructor(inRate, outRate) {
    this.passthrough = inRate === outRate;
    this.ratio = inRate / outRate;
    const fc = Math.min(1, outRate / inRate) * 0.96;
    const zeros = 16;
    this.half = Math.ceil(zeros / fc);
    this.fc = fc;
    const perUnit = 128;
    this.perUnit = perUnit;
    const beta = 8.6;
    const n = this.half * perUnit + 2;
    this.table = new Float32Array(n);
    const i0b = besselI0(beta);
    for (let j = 0; j < n; j++) {
      const x = j / perUnit;
      const r = x / this.half;
      const w = r >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const px = Math.PI * fc * x;
      this.table[j] = (x === 0 ? fc : (fc * Math.sin(px)) / px) * w;
    }
    this.base = -this.half; // absolute input index of the first stored sample (zeros before the start of the signal)
    this.bl = new Float32Array(this.half);
    this.br = new Float32Array(this.half);
    this.count = 0; // input samples received
    this.pos = 0; // absolute (fractional) input position of the next output sample
  }

  _append(L, R) {
    const keepFrom = Math.max(this.base, Math.floor(this.pos) - this.half);
    const drop = keepFrom - this.base;
    const keep = this.bl.length - drop;
    const nl = new Float32Array(keep + L.length);
    const nr = new Float32Array(keep + R.length);
    nl.set(this.bl.subarray(drop), 0);
    nr.set(this.br.subarray(drop), 0);
    nl.set(L, keep);
    nr.set(R, keep);
    this.bl = nl;
    this.br = nr;
    this.base = keepFrom;
    this.count += L.length;
  }

  _run(final) {
    const outL = [];
    const outR = [];
    const half = this.half;
    const perUnit = this.perUnit;
    const table = this.table;
    const end = this.base + this.bl.length; // absolute index one past the last stored sample
    const limit = final ? this.count : Infinity;
    let produced = 0;
    const cap = Math.ceil((end - this.pos) / this.ratio) + 2;
    let ol = new Float32Array(Math.max(cap, 0));
    let or = new Float32Array(Math.max(cap, 0));
    for (;;) {
      const c = this.pos;
      const first = Math.floor(c) - half + 1;
      const last = Math.floor(c) + half;
      if (last >= end || c >= limit) break;
      let sl = 0;
      let sr = 0;
      let sw = 0;
      for (let i = first; i <= last; i++) {
        const d = Math.abs(i - c) * perUnit;
        const j = Math.floor(d);
        const f = d - j;
        const w = table[j] + (table[j + 1] - table[j]) * f;
        const idx = i - this.base;
        sl += this.bl[idx] * w;
        sr += this.br[idx] * w;
        sw += w;
      }
      ol[produced] = sl / sw;
      or[produced] = sr / sw;
      produced += 1;
      this.pos += this.ratio;
    }
    if (produced) { outL.push(ol.subarray(0, produced)); outR.push(or.subarray(0, produced)); }
    ol = null; or = null;
    return { L: concat(outL, produced), R: concat(outR, produced) };
  }

  push(L, R) {
    if (this.passthrough) return { L, R };
    if (!L.length) return { L: new Float32Array(0), R: new Float32Array(0) };
    this._append(L, R);
    return this._run(false);
  }

  // Output for the samples that need look-ahead beyond the last input sample (treated as silence).
  flush() {
    if (this.passthrough) return { L: new Float32Array(0), R: new Float32Array(0) };
    const pad = new Float32Array(this.half + 2);
    const trueCount = this.count;
    this._append(pad, pad);
    this.count = trueCount;
    return this._run(true);
  }
}

/* ------------------------------------------------------------------ WSOLA time stretch */

const SYN_HOP = 1024; // synthesis hop; frames are 2 * hop long (42.7 ms at 48 kHz), 50 % overlap with a periodic Hann window
const SEARCH = 512; // +/- samples around the nominal position in which the best-matching frame start is searched
const DEC = 4; // decimation of the coarse correlation search

const HANN = (() => {
  const w = new Float32Array(2 * SYN_HOP);
  for (let i = 0; i < w.length; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / w.length));
  return w;
})();

// Waveform-similarity overlap-add: changes the tempo by `tempo` (0.5..2) without changing the pitch.
// Frame k reads the input around k * hop * tempo, shifted to the position whose waveform best continues the previous frame.
export class Wsola {
  constructor(tempo) {
    this.tempo = tempo;
    this.ha = SYN_HOP * tempo;
    this.k = 0;
    this.pPrev = 0;
    this.base = 0; // absolute index of the first stored input sample (always a multiple of DEC)
    this.xl = new Float32Array(0);
    this.xr = new Float32Array(0);
    this.d4 = new Float32Array(0); // decimated mono, d4[i] = mean of mono[base + DEC*i .. +DEC)
    this.count = 0; // input samples received so far (absolute end)
    this.tailL = new Float32Array(SYN_HOP);
    this.tailR = new Float32Array(SYN_HOP);
    this.finished = false;
  }

  _append(L, R) {
    const nominalNext = Math.round(this.ha * this.k);
    const needFrom = Math.max(0, Math.min(this.k === 0 ? 0 : this.pPrev + SYN_HOP, nominalNext - SEARCH - DEC));
    let drop = Math.max(0, needFrom - this.base);
    drop -= drop % DEC;
    const keep = this.xl.length - drop;
    const total = keep + L.length;
    const nl = new Float32Array(total);
    const nr = new Float32Array(total);
    nl.set(this.xl.subarray(drop), 0);
    nr.set(this.xr.subarray(drop), 0);
    nl.set(L, keep);
    nr.set(R, keep);
    this.xl = nl;
    this.xr = nr;
    this.base += drop;
    this.count += L.length;
    const n4 = Math.floor(total / DEC);
    const d4 = new Float32Array(n4);
    for (let i = 0; i < n4; i++) {
      const o = i * DEC;
      d4[i] = (nl[o] + nr[o] + nl[o + 1] + nr[o + 1] + nl[o + 2] + nr[o + 2] + nl[o + 3] + nr[o + 3]) / (2 * DEC);
    }
    this.d4 = d4;
  }

  _search(nominal) {
    const lo = Math.max(0, nominal - SEARCH);
    const hi = nominal + SEARCH;
    const refStart = this.pPrev + SYN_HOP;
    const n4 = SYN_HOP / DEC;
    // decimated reference (the second half of the previous frame, as it is in the input)
    const ref = new Float32Array(n4);
    for (let j = 0; j < n4; j++) {
      const o = refStart + j * DEC - this.base;
      ref[j] = (this.xl[o] + this.xr[o] + this.xl[o + 1] + this.xr[o + 1] + this.xl[o + 2] + this.xr[o + 2] + this.xl[o + 3] + this.xr[o + 3]) / (2 * DEC);
    }
    const c4lo = Math.ceil(lo / DEC);
    const c4hi = Math.floor(hi / DEC);
    const mid = Math.min(Math.max(Math.round(nominal / DEC), c4lo), c4hi);
    let best = mid;
    let bestScore = -Infinity;
    const score = (c4) => {
      const o = c4 - this.base / DEC;
      let dot = 0;
      let e = 0;
      for (let j = 0; j < n4; j++) { const v = this.d4[o + j]; dot += v * ref[j]; e += v * v; }
      return dot / Math.sqrt(e + 1e-9);
    };
    const maxOff = Math.max(mid - c4lo, c4hi - mid);
    for (let off = 0; off <= maxOff; off++) {
      for (const c4 of off === 0 ? [mid] : [mid - off, mid + off]) {
        if (c4 < c4lo || c4 > c4hi) continue;
        const s = score(c4);
        if (s > bestScore + 1e-12) { bestScore = s; best = c4; }
      }
    }
    // refine at full resolution around the coarse winner
    let bestC = best * DEC;
    let bestFine = -Infinity;
    for (let c = Math.max(lo, best * DEC - DEC + 1); c <= Math.min(hi, best * DEC + DEC - 1); c++) {
      let dot = 0;
      let e = 0;
      const o = c - this.base;
      const r = refStart - this.base;
      for (let j = 0; j < SYN_HOP; j += 2) {
        const v = this.xl[o + j] + this.xr[o + j];
        dot += v * (this.xl[r + j] + this.xr[r + j]);
        e += v * v;
      }
      const s = dot / Math.sqrt(e + 1e-9);
      if (s > bestFine + 1e-12) { bestFine = s; bestC = c; }
    }
    return bestC;
  }

  _produce(final) {
    const outL = [];
    const outR = [];
    let total = 0;
    for (;;) {
      const nominal = this.k === 0 ? 0 : Math.round(this.ha * this.k);
      if (final) { if (nominal - SEARCH >= this.count) break; } else {
        const needEnd = (this.k === 0 ? 0 : nominal + SEARCH) + 2 * SYN_HOP + DEC;
        if (this.count < needEnd) break;
      }
      const c = this.k === 0 ? 0 : this._search(nominal);
      const o = c - this.base;
      const L = new Float32Array(SYN_HOP);
      const R = new Float32Array(SYN_HOP);
      if (this.k === 0) {
        for (let i = 0; i < SYN_HOP; i++) { L[i] = this.xl[o + i]; R[i] = this.xr[o + i]; }
      } else {
        for (let i = 0; i < SYN_HOP; i++) {
          const w = HANN[i];
          L[i] = this.tailL[i] + this.xl[o + i] * w;
          R[i] = this.tailR[i] + this.xr[o + i] * w;
        }
      }
      for (let i = 0; i < SYN_HOP; i++) {
        const w = HANN[SYN_HOP + i];
        this.tailL[i] = this.xl[o + SYN_HOP + i] * w;
        this.tailR[i] = this.xr[o + SYN_HOP + i] * w;
      }
      this.pPrev = c;
      this.k += 1;
      outL.push(L);
      outR.push(R);
      total += SYN_HOP;
    }
    return { L: concat(outL, total), R: concat(outR, total) };
  }

  push(L, R) {
    if (!L.length) return { L: new Float32Array(0), R: new Float32Array(0) };
    this._append(L, R);
    return this._produce(false);
  }

  // Everything that is left, as if the input continued with silence.
  finish() {
    if (this.finished) return { L: new Float32Array(0), R: new Float32Array(0) };
    this.finished = true;
    // zeros after the end of the signal, enough for the last frame's search window; they are not part of the signal (count stays)
    const pad = new Float32Array(2 * SYN_HOP + 2 * SEARCH + 2 * DEC);
    const trueCount = this.count;
    this._append(pad, pad);
    this.count = trueCount;
    const out = this._produce(true);
    // the very last tail (the falling half of the last frame) is part of the stretched signal
    const L = new Float32Array(out.L.length + SYN_HOP);
    const R = new Float32Array(out.R.length + SYN_HOP);
    L.set(out.L, 0);
    R.set(out.R, 0);
    L.set(this.tailL, out.L.length);
    R.set(this.tailR, out.R.length);
    return { L, R };
  }
}

// Several WSOLA stages in a row (a speed of 8x is three stages of 2x, like the desktop edition's atempo chain).
export class TempoChain {
  constructor(speed) {
    this.stages = atempoChain(speed).map((t) => new Wsola(t));
  }

  get active() { return this.stages.length > 0; }

  push(L, R) {
    let cur = { L, R };
    for (const s of this.stages) {
      cur = s.push(cur.L, cur.R);
      if (!cur.L.length) break;
    }
    return cur;
  }

  finish() {
    let carry = { L: new Float32Array(0), R: new Float32Array(0) };
    for (const s of this.stages) {
      const fromCarry = carry.L.length ? s.push(carry.L, carry.R) : { L: new Float32Array(0), R: new Float32Array(0) };
      const tail = s.finish();
      const L = new Float32Array(fromCarry.L.length + tail.L.length);
      const R = new Float32Array(fromCarry.R.length + tail.R.length);
      L.set(fromCarry.L, 0); L.set(tail.L, fromCarry.L.length);
      R.set(fromCarry.R, 0); R.set(tail.R, fromCarry.R.length);
      carry = { L, R };
    }
    return carry;
  }
}
