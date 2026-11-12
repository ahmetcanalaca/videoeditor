#!/usr/bin/env node
'use strict';
// Draws the icons of the browser extension (extension/icons/icon-{16,32,48,128}.png) without any dependency: the logo of the app (gradient rounded square with a
// white play triangle) plus a green "connected" badge, so that the extension is not mistaken for the app. Run: node scripts/make-extension-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const C0 = [91, 140, 255];
const C1 = [139, 92, 246];
const GREEN = [34, 197, 94];
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const mix = (a, b, t) => a + (b - a) * t;

const sdRoundRect = (px, py, cx, cy, half, r) => {
  const qx = Math.abs(px - cx) - (half - r);
  const qy = Math.abs(py - cy) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
function sdTriangle(px, py, a, b, c) {
  const e = [[b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]], [a[0] - c[0], a[1] - c[1]]];
  const v = [[px - a[0], py - a[1]], [px - b[0], py - b[1]], [px - c[0], py - c[1]]];
  const dot = (u, w) => u[0] * w[0] + u[1] * w[1];
  const q = e.map((ei, i) => { const t = clamp(dot(v[i], ei) / dot(ei, ei), 0, 1); return [v[i][0] - ei[0] * t, v[i][1] - ei[1] * t]; });
  const s = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  const d = q.map((qi, i) => [dot(qi, qi), s * (v[i][0] * e[i][1] - v[i][1] * e[i][0])]);
  const m0 = Math.min(d[0][0], d[1][0], d[2][0]);
  const m1 = Math.min(d[0][1], d[1][1], d[2][1]);
  return -Math.sqrt(m0) * Math.sign(m1);
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const u = size / 64;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / u;
          const py = (y + (sy + 0.5) / SS) / u;
          const badge = sdCircle(px, py, 47, 47, 15);
          const inBg = sdRoundRect(px, py, 32, 32, 28, 14) < 0;
          if (!inBg && badge >= 0) continue;
          let c;
          if (badge < 0) c = badge < -4.2 ? GREEN : [255, 255, 255];
          else {
            const t = clamp((px + py) / 128, 0, 1);
            c = [mix(C0[0], C1[0], t), mix(C0[1], C1[1], t), mix(C0[2], C1[2], t)];
            if (sdTriangle(px, py, [24, 17], [24, 37], [41, 27]) - 2.4 < 0) c = [255, 255, 255];
          }
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) { buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); buf[i + 3] = Math.round((a / (SS * SS)) * 255); }
    }
  }
  return buf;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
SIZES.forEach((s) => fs.writeFileSync(path.join(OUT, 'icon-' + s + '.png'), png(render(s), s)));
console.log('extension icons written to ' + OUT + ': ' + SIZES.join(', ') + ' px');
