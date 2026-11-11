'use strict';
// Generates the application icon (assets/icon.ico + PNGs) without any external dependency.
// The artwork matches the in-app logo: gradient rounded square with a white, rounded play triangle.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const C0 = [91, 140, 255];
const C1 = [139, 92, 246];

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const mix = (a, b, t) => a + (b - a) * t;

// signed distance to a rounded square (negative inside)
function sdRoundRect(px, py, cx, cy, half, r) {
  const qx = Math.abs(px - cx) - (half - r);
  const qy = Math.abs(py - cy) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// signed distance to a triangle (Inigo Quilez)
function sdTriangle(px, py, a, b, c) {
  const e0 = [b[0] - a[0], b[1] - a[1]];
  const e1 = [c[0] - b[0], c[1] - b[1]];
  const e2 = [a[0] - c[0], a[1] - c[1]];
  const v0 = [px - a[0], py - a[1]];
  const v1 = [px - b[0], py - b[1]];
  const v2 = [px - c[0], py - c[1]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const pq = (v, e) => {
    const t = clamp(dot(v, e) / dot(e, e), 0, 1);
    return [v[0] - e[0] * t, v[1] - e[1] * t];
  };
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

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const u = size / 64; // artwork is designed on a 64-unit grid
  const SS = 4; // 4x4 supersampling for clean edges at every size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / u;
          const py = (y + (sy + 0.5) / SS) / u;
          const dBg = sdRoundRect(px, py, 32, 32, 28, 14);
          const covBg = dBg < 0 ? 1 : 0;
          if (!covBg) continue;
          const t = clamp((px + py) / 128 + 0.0, 0, 1);
          let cr = mix(C0[0], C1[0], t);
          let cg = mix(C0[1], C1[1], t);
          let cb = mix(C0[2], C1[2], t);
          const dTri = sdTriangle(px, py, [27.4, 22.0], [27.4, 42.0], [44.8, 32.0]) - 2.4;
          if (dTri < 0) { cr = 255; cg = 255; cb = 255; }
          r += cr; g += cg; b += cb; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return buf;
}

/* ---- PNG encoder ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir[o] = p.size >= 256 ? 0 : p.size;
    dir[o + 1] = p.size >= 256 ? 0 : p.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
const pngs = SIZES.map((size) => ({ size, data: encodePng(render(size), size) }));
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs));
fs.writeFileSync(path.join(OUT, 'icon.png'), pngs.find((p) => p.size === 256).data);
fs.writeFileSync(path.join(OUT, 'icon-512.png'), encodePng(render(512), 512));
console.log('icons written to ' + OUT + ': ' + SIZES.join(', ') + ' px');
