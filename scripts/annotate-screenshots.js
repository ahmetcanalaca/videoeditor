'use strict';
// Draws the numbered callouts used by KULLANIM-KILAVUZU-USER-GUIDE.md onto two existing screenshots:
//   docs/screenshots/01-tr-dark-editor.png -> guide-overview-tr.png
//   docs/screenshots/03-en-dark-editor.png -> guide-overview-en.png
// Needs only the bundled ffmpeg and the Segoe UI Bold font that ships with Windows (npm run docs:shots).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveBinaries } = require('../src/main/ffmpeg-paths');

const SHOTS = path.join(__dirname, '..', 'docs', 'screenshots');
const FONT = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeuib.ttf');
const SIZE = 34;
const COLOR = '0xE8501A';

// [number, x, y] = top-left corner of the badge in screenshot pixels (1920x1128). A [tr, en] pair is used where the
// two languages lay the buttons out differently ("Sil" vs "Delete" is wider).
const BADGES = [
  [1, 492, 13], [2, [925, 960], 13], [3, [1184, 1214], 13], [4, 1722, 13], [5, 166, 92], [6, 548, 768],
  [7, 1846, 86], [8, [548, 590], 830], [9, 1566, 830], [10, 296, 866], [11, 1852, 962], [12, 880, 1088],
  [13, [1450, 1448], 62],
];
const JOBS = [
  { src: '01-tr-dark-editor.png', dst: 'guide-overview-tr.png', lang: 0 },
  { src: '03-en-dark-editor.png', dst: 'guide-overview-en.png', lang: 1 },
];

function filterChain(lang) {
  const font = FONT.replace(/\\/g, '/').replace(':', '\\:');
  const parts = [];
  for (const [n, xs, y] of BADGES) {
    const x = Array.isArray(xs) ? xs[lang] : xs;
    parts.push(`drawbox=x=${x - 2}:y=${y - 2}:w=${SIZE + 4}:h=${SIZE + 4}:color=white:t=fill`);
    parts.push(`drawbox=x=${x}:y=${y}:w=${SIZE}:h=${SIZE}:color=${COLOR}:t=fill`);
    parts.push(`drawtext=fontfile='${font}':text='${n}':fontsize=24:fontcolor=white:x=${x}+(${SIZE}-text_w)/2:y=${y}+(${SIZE}-text_h)/2`);
  }
  return parts.join(',');
}

function main() {
  if (!fs.existsSync(FONT)) { console.error('Font not found: ' + FONT); process.exit(1); }
  const { ffmpeg } = resolveBinaries({ resourcesPath: null });
  for (const job of JOBS) {
    const src = path.join(SHOTS, job.src);
    const dst = path.join(SHOTS, job.dst);
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', filterChain(job.lang), '-frames:v', '1', '-update', '1', dst], { encoding: 'utf8' });
    if (r.status !== 0) { console.error('ffmpeg failed for ' + job.dst + ': ' + r.stderr); process.exit(1); }
    console.log('wrote ' + path.relative(path.join(__dirname, '..'), dst));
  }
}

main();
