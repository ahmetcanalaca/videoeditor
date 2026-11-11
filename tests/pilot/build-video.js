'use strict';
// Builds a constant-frame-rate H.264 video from the timestamped frame dump of rec-main.js (what a screen recorder produces: frames are repeated when nothing changes).
//   node build-video.js <runDir> [fps]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FFMPEG = require('../../src/main/ffmpeg-paths').resolveBinaries({ resourcesPath: null }).ffmpeg;
const dir = path.resolve(process.argv[2]);
const fps = Number(process.argv[3] || 30);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const lines = ['ffconcat version 1.0'];
meta.frames.forEach((f, k) => {
  const next = meta.frames[k + 1];
  const d = next ? next.t - f.t : 0.1;
  lines.push("file '" + path.join(dir, 'f' + String(f.i).padStart(5, '0') + '.jpg').replace(/\\/g, '/') + "'");
  lines.push('duration ' + Math.max(0.001, d).toFixed(4));
});
lines.push("file '" + path.join(dir, 'f' + String(meta.frames[meta.frames.length - 1].i).padStart(5, '0') + '.jpg').replace(/\\/g, '/') + "'");
fs.writeFileSync(path.join(dir, 'list.txt'), lines.join('\n'));
const out = path.join(dir, 'rec.mp4');
const t0 = Date.now();
const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', 'fps=' + fps + ',format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out], { encoding: 'utf8' });
if (r.status !== 0) { console.log('ffmpeg failed', r.stderr); process.exit(1); }
console.log('built ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(1) + ' MB) in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
