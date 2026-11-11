'use strict';
// Draws the picture on the left side of the installer's welcome and finish pages (installer/welcome.bmp, 164 x 314, the size NSIS wants):
// the app logo on a dark gradient above a few "timeline clips" with a playhead. No external dependency (same approach as scripts/make-icons.js).
//   node scripts/make-installer-art.js
const fs = require('fs');
const path = require('path');

const W = 164;
const H = 314;
const OUT = path.join(__dirname, '..', 'installer', 'welcome.bmp');

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const mix = (a, b, t) => a + (b - a) * t;
const mixc = (c0, c1, t) => [mix(c0[0], c1[0], t), mix(c0[1], c1[1], t), mix(c0[2], c1[2], t)];

function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdTriangle(px, py, a, b, c) {
  const e0 = [b[0] - a[0], b[1] - a[1]];
  const e1 = [c[0] - b[0], c[1] - b[1]];
  const e2 = [a[0] - c[0], a[1] - c[1]];
  const v0 = [px - a[0], py - a[1]];
  const v1 = [px - b[0], py - b[1]];
  const v2 = [px - c[0], py - c[1]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const pq = (v, e) => { const t = clamp(dot(v, e) / dot(e, e), 0, 1); return [v[0] - e[0] * t, v[1] - e[1] * t]; };
  const q0 = pq(v0, e0);
  const q1 = pq(v1, e1);
  const q2 = pq(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const d0 = [dot(q0, q0), s * (v0[0] * e0[1] - v0[1] * e0[0])];
  const d1 = [dot(q1, q1), s * (v1[0] * e1[1] - v1[1] * e1[0])];
  const d2 = [dot(q2, q2), s * (v2[0] * e2[1] - v2[1] * e2[0])];
  const m = [Math.min(d0[0], d1[0], d2[0]), Math.min(d0[1], d1[1], d2[1])];
  return -Math.sqrt(m[0]) * Math.sign(m[1]);
}

const BLUE = [91, 140, 255];
const VIOLET = [139, 92, 246];
const TOP = [24, 30, 46];
const BOTTOM = [10, 12, 18];
// the clips of the little timeline: x, width, row, colour
const CLIPS = [
  [14, 70, 0, BLUE], [88, 62, 0, [58, 70, 110]],
  [14, 38, 1, [58, 70, 110]], [56, 94, 1, VIOLET],
  [14, 100, 2, VIOLET], [118, 32, 2, BLUE],
];

function shade(px, py) {
  // background: vertical gradient with a soft glow behind the logo
  let c = mixc(TOP, BOTTOM, clamp(py / H, 0, 1));
  const glow = Math.exp(-(Math.hypot(px - 82, py - 96) ** 2) / (2 * 60 * 60));
  c = mixc(c, [60, 80, 160], glow * 0.35);
  // logo: gradient squircle with a white rounded play triangle (the artwork of assets/icon.ico on a 64-unit grid, here 104 px wide)
  const u = 104 / 64;
  const lx = (px - (82 - 52)) / u;
  const ly = (py - (96 - 52)) / u;
  if (sdRoundRect(lx, ly, 32, 32, 28, 28, 14) < 0) {
    const t = clamp((lx + ly) / 128, 0, 1);
    c = mixc(BLUE, VIOLET, t);
    if (sdTriangle(lx, ly, [27.4, 22.0], [27.4, 42.0], [44.8, 32.0]) - 2.4 < 0) c = [255, 255, 255];
  }
  // timeline clips
  for (const [x, w, row, col] of CLIPS) {
    const cy = 196 + row * 26;
    if (sdRoundRect(px, py, x + w / 2, cy, w / 2, 10, 5) < 0) {
      c = mixc(col, [255, 255, 255], 0.06);
      // a lighter line along the top of the clip
      if (py < cy - 6) c = mixc(c, [255, 255, 255], 0.14);
    }
  }
  // the playhead
  if (Math.abs(px - 66) < 1 && py > 178 && py < 282) c = [255, 93, 115];
  if (Math.hypot(px - 66, py - 178) < 4.2) c = [255, 93, 115];
  return c;
}

function render() {
  const SS = 3;
  const rowBytes = W * 3; // 492: a multiple of 4, so no padding
  const pixels = Buffer.alloc(rowBytes * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0; let g = 0; let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      const o = (H - 1 - y) * rowBytes + x * 3; // BMP rows run bottom to top
      pixels[o] = Math.round(b / n);
      pixels[o + 1] = Math.round(g / n);
      pixels[o + 2] = Math.round(r / n);
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10); // offset of the pixel data
  header.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  header.writeInt32LE(W, 18);
  header.writeInt32LE(H, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

function make() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render());
  return OUT;
}

module.exports = { make, OUT };

if (require.main === module) console.log('wrote ' + make());
