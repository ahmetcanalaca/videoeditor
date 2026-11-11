'use strict';
// Unit tests of the web export's audio maths (js/web/engine/audio-dsp.js): resampler, downmix, WSOLA tempo chain.
const path = require('path');
const { pathToFileURL } = require('url');

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok && !process.env.VE_VERBOSE ? '' : '  -> ' + JSON.stringify(detail)));
  if (!ok) failed += 1;
}

const sine = (freq, rate, seconds, amp) => {
  const n = Math.round(rate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (amp || 0.5) * Math.sin((2 * Math.PI * freq * i) / rate);
  return a;
};

// frequency from positive-going zero crossings (accurate for a clean sine)
function freqOf(x, rate, from, to) {
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const frac = -x[i - 1] / (x[i] - x[i - 1]);
      const pos = i - 1 + frac;
      if (first < 0) first = pos;
      last = pos;
      n += 1;
    }
  }
  return n > 1 ? ((n - 1) * rate) / (last - first) : 0;
}

function rms(x, from, to) {
  let s = 0;
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function collect(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

(async () => {
  const dsp = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'web', 'engine', 'audio-dsp.js')).href);

  // ---- atempo chain
  check('atempo chain 1x is empty', dsp.atempoChain(1).length === 0);
  check('atempo chain 8x = 2,2,2', JSON.stringify(dsp.atempoChain(8)) === '[2,2,2]');
  check('atempo chain 0.25x = 0.5,0.5', JSON.stringify(dsp.atempoChain(0.25)) === '[0.5,0.5]');
  const ch3 = dsp.atempoChain(3);
  check('atempo chain 3x multiplies to 3', Math.abs(ch3.reduce((a, b) => a * b, 1) - 3) < 1e-9 && ch3.every((t) => t >= 0.5 && t <= 2), ch3);

  // ---- downmix
  const one = new Float32Array([0.5, -0.25]);
  const mono = dsp.downmixToStereo([one]);
  check('mono -> both channels', mono.L === one && mono.R === one);
  const six = [0, 1, 2, 3, 4, 5].map((i) => new Float32Array([i === 3 ? 1 : 0.5]));
  const dm = dsp.downmixToStereo(six);
  check('5.1 downmix stays within full scale and drops LFE', dm.L[0] <= 1 && dm.R[0] <= 1 && Math.abs(dm.L[0] - 0.5) < 1e-6, [dm.L[0], dm.R[0]]);

  // ---- resampler
  for (const [inRate, label] of [[44100, '44.1k->48k'], [32000, '32k->48k'], [96000, '96k->48k'], [22050, '22.05k->48k']]) {
    const x = sine(1000, inRate, 2, 0.5);
    const rs = new dsp.Resampler(inRate, 48000);
    const parts = [];
    const stepSize = 4096;
    for (let i = 0; i < x.length; i += stepSize) {
      const c = x.subarray(i, Math.min(x.length, i + stepSize));
      parts.push(rs.push(c, c).L);
    }
    parts.push(rs.flush().L);
    const y = collect(parts);
    const expectLen = Math.round(2 * 48000);
    check('resample ' + label + ': length', Math.abs(y.length - expectLen) <= 2, y.length + ' vs ' + expectLen);
    const f = freqOf(y, 48000, 4800, y.length - 4800);
    check('resample ' + label + ': frequency 1000 Hz', Math.abs(f - 1000) < 0.2, f);
    const a = rms(y, 4800, y.length - 4800) * Math.SQRT2;
    check('resample ' + label + ': amplitude 0.5', Math.abs(a - 0.5) < 0.005, a);
    // distortion: remove the ideal sine and look at what is left
    let err = 0;
    let n = 0;
    for (let i = 4800; i < y.length - 4800; i++) {
      const ideal = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000 + 0); // same phase: output sample i is input at i*ratio
      err += (y[i] - ideal) * (y[i] - ideal);
      n += 1;
    }
    const snr = 10 * Math.log10((0.125) / (err / n + 1e-30));
    check('resample ' + label + ': SNR > 60 dB', snr > 60, snr);
  }

  // ---- WSOLA
  const rate = 48000;
  for (const tempo of [0.5, 0.75, 1.25, 1.5, 2]) {
    const x = sine(440, rate, 4, 0.5);
    const w = new dsp.Wsola(tempo);
    const parts = [];
    for (let i = 0; i < x.length; i += 9000) {
      const c = x.subarray(i, Math.min(x.length, i + 9000));
      parts.push(w.push(c, c).L);
    }
    parts.push(w.finish().L);
    const y = collect(parts);
    const expected = x.length / tempo;
    check('wsola ' + tempo + 'x: length within 6%', Math.abs(y.length - expected) / expected < 0.06 + 3000 / expected, y.length + ' vs ' + expected);
    const f = freqOf(y, rate, 6000, Math.min(y.length, Math.round(expected)) - 6000);
    check('wsola ' + tempo + 'x: pitch preserved (440 Hz)', Math.abs(f - 440) < 3, f);
    const a = rms(y, 6000, Math.min(y.length, Math.round(expected)) - 6000) * Math.SQRT2;
    check('wsola ' + tempo + 'x: level preserved', Math.abs(a - 0.5) < 0.03, a);
  }

  // a stepped-pitch signal keeps its steps in the right (scaled) places: 300 + 100*floor(t) Hz, like the editor's test video
  {
    const x = new Float32Array(rate * 8);
    let phase = 0;
    for (let i = 0; i < x.length; i++) { phase += (2 * Math.PI * (300 + 100 * Math.floor(i / rate))) / rate; x[i] = 0.5 * Math.sin(phase); }
    const chain = new dsp.TempoChain(4);
    const parts = [];
    for (let i = 0; i < x.length; i += 7000) { const c = x.subarray(i, Math.min(x.length, i + 7000)); parts.push(chain.push(c, c).L); }
    parts.push(chain.finish().L);
    const y = collect(parts);
    check('chain 4x: length ~ input/4', Math.abs(y.length - x.length / 4) < 6000, y.length + ' vs ' + x.length / 4);
    const seg = rate / 4; // every input second lasts 0.25 s at 4x
    const bad = [];
    for (let s = 1; s < 7; s++) {
      const f = freqOf(y, rate, Math.round(s * seg + seg * 0.25), Math.round(s * seg + seg * 0.75));
      if (Math.abs(f - (300 + 100 * s)) > 25) bad.push([s, f]);
    }
    check('chain 4x: pitch steps keep their pitch and position', bad.length === 0, bad);
  }

  // timing of the push interface: result must not depend on how the input is chopped
  {
    const x = sine(523, rate, 3, 0.4);
    const run = (step) => {
      const w = new dsp.Wsola(1.5);
      const parts = [];
      for (let i = 0; i < x.length; i += step) { const c = x.subarray(i, Math.min(x.length, i + step)); parts.push(w.push(c, c).L); }
      parts.push(w.finish().L);
      return collect(parts);
    };
    const a = run(1000);
    const b = run(50000);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) same = false;
    check('wsola result independent of chunking', same, [a.length, b.length]);
  }

  console.log('\naudio-dsp: ' + (failed ? failed + ' FAILED' : 'all passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
