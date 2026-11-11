// Stand-ins for the few Node.js built-ins that the desktop AI modules `require`. The desktop sources are bundled into js/web/ai/desktop-core.js
// by scripts/sync-desktop.js and run unchanged in the page; this file is what their `require('crypto')` / `require('path')` ... resolve to.
// Only what those modules really use is here; anything else throws a clear error instead of silently doing nothing.

const notInBrowser = (what) => () => { throw Object.assign(new Error(what + ' is not available in the browser'), { code: 'NOT_IN_BROWSER' }); };

/* ---------------------------------------------------------------- SHA-1 / SHA-256 (synchronous; Web Crypto only has async digests) */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Pads a message the way SHA-1 and SHA-256 both do: 0x80, zeros, the length in bits as a 64-bit big-endian number.
function padded(msg) {
  const l = msg.length;
  const total = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(l / 0x20000000));
  dv.setUint32(total - 4, (l << 3) >>> 0);
  return { dv, total };
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const rotl = (x, n) => (x << n) | (x >>> (32 - n));

function sha256Bytes(msg) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const { dv, total } = padded(msg);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0]; let b = H[1]; let c = H[2]; let d = H[3]; let e = H[4]; let f = H[5]; let g = H[6]; let h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

function sha1Bytes(msg) {
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const { dv, total } = padded(msg);
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) >>> 0;
    let a = H[0]; let b = H[1]; let c = H[2]; let d = H[3]; let e = H[4];
    for (let i = 0; i < 80; i++) {
      let f; let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

const HASHES = { sha256: sha256Bytes, sha1: sha1Bytes };
const textBytes = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : (v instanceof Uint8Array ? v : new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength)));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

// the bytes of a digest or of random data, with the encodings Node's Buffer has that the desktop code uses
function encoded(bytes) {
  return { length: bytes.length, bytes, toString(enc) { return enc === 'base64' ? b64(bytes) : hex(bytes); } };
}

const crypto = {
  createHash(alg) {
    const fn = HASHES[String(alg).toLowerCase()];
    if (!fn) throw new Error('createHash: only sha1 and sha256 exist in the browser build');
    const parts = [];
    return {
      update(data) { parts.push(textBytes(data)); return this; },
      digest(enc) {
        let size = 0;
        parts.forEach((p) => { size += p.length; });
        const all = new Uint8Array(size);
        let o = 0;
        parts.forEach((p) => { all.set(p, o); o += p.length; });
        const out = fn(all);
        return enc === 'hex' ? hex(out) : (enc === 'base64' ? b64(out) : out);
      },
    };
  },
  randomBytes(n) { return encoded(globalThis.crypto.getRandomValues(new Uint8Array(n))); },
  randomUUID() { return globalThis.crypto.randomUUID(); },
};

/* ---------------------------------------------------------------- the rest: only what the code touches when it is NOT used for a file on disk */

const path = {
  join(...parts) { return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'); },
  basename(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || ''; },
};
const os = { tmpdir: () => '/tmp' };
// The video analysis keeps its results in the browser (see web-cu.js) and never touches a file system: these are never called on that path.
const fs = {
  rmSync() { /* nothing to remove */ },
  promises: { readFile: notInBrowser('fs.readFile'), open: notInBrowser('fs.open') },
  statSync: notInBrowser('fs.statSync'),
  readFileSync: notInBrowser('fs.readFileSync'),
  readdirSync: notInBrowser('fs.readdirSync'),
  mkdirSync: notInBrowser('fs.mkdirSync'),
  writeFileSync: notInBrowser('fs.writeFileSync'),
  renameSync: notInBrowser('fs.renameSync'),
};

export const shims = {
  crypto,
  path,
  os,
  fs,
  child_process: { spawn: notInBrowser('child_process.spawn'), execFile: notInBrowser('child_process.execFile') },
  // resolved ids of desktop modules that only make sense with ffmpeg on disk
  'src/main/media-guard': { inputArgs: () => [] },
};

export { sha256Bytes, sha1Bytes };
