#!/usr/bin/env node
'use strict';
// Packs the Local AI helper (web/local-ai/) for download:
//   <out>/local-ai/VideoEditor-LocalAI.zip   one folder with the helper's files (what the page offers as "Download the helper")
//   <out>/local-ai/<each file>               the same files on their own, so that they can be read before anything is downloaded
//   <out>/local-ai/info.json                 names, sizes and SHA-256 values of all of it (shown by the page, checkable by anyone)
// The zip is written here, by hand: files are stored (not compressed) with a fixed date, so the same sources always give the same bytes. Text files get
// Windows line endings (the helper runs on Windows; Notepad and cmd.exe like them).
//   node scripts/local-ai-pack.js [--out <dir>]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILES = ['Start-Local-AI.cmd', 'local-ai.ps1', 'messages.json', 'pins.json', 'README.txt'];
const FOLDER = 'VideoEditor-LocalAI';
const ZIP_NAME = 'VideoEditor-LocalAI.zip';
const FIXED_DATE = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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

function dosDateTime(d) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

// entries: [{ name, data: Buffer }] -> Buffer (a zip with stored entries)
function zip(entries, when) {
  const { time, date } = dosDateTime(when || FIXED_DATE);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// text with Windows line endings; a byte-order mark where the text is not plain ASCII (old Notepad versions need it to show UTF-8 right)
function windowsText(buf, file) {
  let s = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (!s.endsWith('\r\n')) s += '\r\n';
  const out = Buffer.from(s, 'utf8');
  return /\.txt$/i.test(file) && /[^\x00-\x7f]/.test(s) ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), out]) : out;
}

// opts: { root (the web/ folder), out } -> { info, published: [{ url, sha256 }] }
function pack(opts) {
  const root = path.resolve(opts.root);
  const outDir = path.join(path.resolve(opts.out), 'local-ai');
  const srcDir = path.join(root, 'local-ai');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const pins = JSON.parse(fs.readFileSync(path.join(srcDir, 'pins.json'), 'utf8'));

  const files = FILES.map((name) => {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) throw new Error('local-ai/' + name + ' is missing');
    return { name, data: windowsText(fs.readFileSync(src), name) };
  });
  const zipBuf = zip(files.map((f) => ({ name: FOLDER + '/' + f.name, data: f.data })));

  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(outDir, f.name), f.data);
  fs.writeFileSync(path.join(outDir, ZIP_NAME), zipBuf);
  const repo = pkg.repository && typeof pkg.repository.url === 'string' ? pkg.repository.url.replace(/\.git$/, '') : '';
  const repoOk = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo);
  const info = {
    format: 1,
    version: pkg.version,
    site: pkg.homepage,
    source: repoOk ? repo + '/tree/main/web/local-ai' : '',
    // how to check where the zip was built: the workflow that publishes the site attests the exact file (see SECURITY.md)
    verify: repoOk ? repo + '/blob/main/SECURITY.md#what-you-trust-when-you-run-the-local-ai-helper' : '',
    zip: { name: ZIP_NAME, folder: FOLDER, bytes: zipBuf.length, sha256: sha256(zipBuf) },
    files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
    model: { id: pins.model.id, name: pins.model.name, bytes: pins.model.files.reduce((s, f) => s + f.size, 0) },
    llama: { tag: pins.llama.tag },
  };
  const infoBuf = Buffer.from(JSON.stringify(info, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'info.json'), infoBuf);

  const published = files.map((f) => ({ url: 'local-ai/' + f.name, sha256: sha256(f.data) }));
  published.push({ url: 'local-ai/' + ZIP_NAME, sha256: info.zip.sha256 }, { url: 'local-ai/info.json', sha256: sha256(infoBuf) });
  return { info, published, dir: outDir };
}

module.exports = { pack, zip, crc32, FILES, FOLDER, ZIP_NAME };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : '';
  const root = path.resolve(__dirname, '..');
  const r = pack({ root, out: outArg || path.join(root, '_site') });
  console.log('packed ' + path.relative(process.cwd(), r.dir) + ': ' + r.info.zip.name + ' (' + r.info.zip.bytes + ' bytes, SHA-256 ' + r.info.zip.sha256 + ')');
}
