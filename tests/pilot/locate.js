'use strict';
// "Here is a screenshot (crop) of the indicator" -> where is it in the video, even if the screenshot was taken at another scale (Windows display scaling 100/125/150/175 %)
// and saved as a compressed JPEG? Multi-scale normalised cross-correlation in plain JavaScript (coarse search on a 4x smaller image, then refinement at full size).
//   node locate.js <video> <templateImage> <tw> <th> <t1,t2,..>
const { spawnSync } = require('child_process');
const path = require('path');

const FFMPEG = require('../../src/main/ffmpeg-paths').resolveBinaries({ resourcesPath: null }).ffmpeg;

function gray(args, w, h) {
  const r = spawnSync(FFMPEG, ['-v', 'error', ...args, '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = r.stdout[i];
  return f;
}

function resize(src, w, h, nw, nh) {
  const out = new Float32Array(nw * nh);
  const sx = w / nw; const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // area average over the source footprint (good for both shrinking and mild enlargement)
      const x0 = x * sx; const x1 = Math.min(w, (x + 1) * sx); const y0 = y * sy; const y1 = Math.min(h, (y + 1) * sy);
      let s = 0; let c = 0;
      for (let yy = Math.floor(y0); yy < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); yy++) for (let xx = Math.floor(x0); xx < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); xx++) { s += src[Math.min(h - 1, yy) * w + Math.min(w - 1, xx)]; c++; }
      out[y * nw + x] = s / c;
    }
  }
  return out;
}

// normalised cross-correlation of template t (tw x th) over image im (w x h); returns the best [score,x,y] inside the optional window
function ncc(im, w, h, t, tw, th, win) {
  const n = tw * th;
  let tm = 0; for (let i = 0; i < n; i++) tm += t[i]; tm /= n;
  const tz = new Float32Array(n); let tn = 0;
  for (let i = 0; i < n; i++) { tz[i] = t[i] - tm; tn += tz[i] * tz[i]; }
  tn = Math.sqrt(tn);
  if (tn < 1e-6) return [-1, 0, 0];
  const x0 = win ? Math.max(0, win[0]) : 0; const y0 = win ? Math.max(0, win[1]) : 0;
  const x1 = win ? Math.min(w - tw, win[2]) : w - tw; const y1 = win ? Math.min(h - th, win[3]) : h - th;
  let best = [-1, 0, 0];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let s = 0; let s2 = 0; let sp = 0;
      for (let j = 0; j < th; j++) { const row = (y + j) * w + x; const tr = j * tw; for (let i = 0; i < tw; i++) { const v = im[row + i]; s += v; s2 += v * v; sp += v * tz[tr + i]; } }
      const varI = s2 - (s * s) / n;
      if (varI < 1e-3) continue;
      const score = sp / (Math.sqrt(varI) * tn);
      if (score > best[0]) best = [score, x, y];
    }
  }
  return best;
}

function locate(frame, W, H, tmpl, tw, th) {
  const F = 4;
  const fs = resize(frame, W, H, Math.floor(W / F), Math.floor(H / F));
  const fw = Math.floor(W / F); const fh = Math.floor(H / F);
  const scales = []; for (let s = 0.4; s <= 2.6; s *= 1.1) scales.push(s);
  let cands = [];
  for (const s of scales) {
    const cw = Math.round(tw * s / F); const ch = Math.round(th * s / F);
    if (cw < 5 || ch < 5 || cw > fw / 2 || ch > fh / 2) continue;
    const ts = resize(tmpl, tw, th, cw, ch);
    const [sc, x, y] = ncc(fs, fw, fh, ts, cw, ch);
    cands.push({ s, sc, x: x * F, y: y * F });
  }
  cands.sort((a, b) => b.sc - a.sc);
  cands = cands.slice(0, 3);
  let best = null;
  for (const c of cands) {
    for (const s of [c.s / 1.05, c.s, c.s * 1.05]) {
      const cw = Math.round(tw * s); const ch = Math.round(th * s);
      const ts = resize(tmpl, tw, th, cw, ch);
      const [sc, x, y] = ncc(frame, W, H, ts, cw, ch, [c.x - 8, c.y - 8, c.x + 8, c.y + 8]);
      if (!best || sc > best.sc) best = { sc, x, y, w: cw, h: ch, s };
    }
  }
  return best;
}

module.exports = { locate, gray, resize, ncc };

if (require.main === module) {
  const [video, tmplFile, tw, th, times] = process.argv.slice(2);
  const W = 1280; const H = 720;
  const tmpl = gray(['-i', tmplFile], Number(tw), Number(th));
  times.split(',').forEach((t) => {
    const frame = gray(['-ss', t, '-i', video], W, H);
    const t0 = Date.now();
    const b = locate(frame, W, H, tmpl, Number(tw), Number(th));
    console.log(`frame t=${t}s  best match score ${b.sc.toFixed(3)} at (${b.x},${b.y}) size ${b.w}x${b.h} (template scale ${b.s.toFixed(2)})  [${((Date.now() - t0) / 1000).toFixed(2)} s]`);
  });
}
