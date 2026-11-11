// Zoom research part 2: chroma alignment, zoom-out, corner focus and 1080p speed for the perspective approach.
const { spawnSync } = require('child_process');
const path = require('path');
const FF = require('../src/main/ffmpeg-paths').resolveBinaries({ resourcesPath: null }).ffmpeg;

const clip = (v, a, b) => Math.min(Math.max(v, a), b);

function persp(W, H, N, Z0, Z1, FX, FY, interp = 'cubic') {
  const Zs = `(${Z0}*pow(${Z1 / Z0},(in-1)/${N}))`;
  const X0 = `clip(${FX}*W-W/(2*${Zs}),0,W-W/${Zs})`;
  const Y0 = `clip(${FY}*H-H/(2*${Zs}),0,H-H/${Zs})`;
  const c = `+(0.5/${Zs}-0.5)`;
  const x0 = `${X0}${c}`, y0 = `${Y0}${c}`;
  const x1 = `${X0}${c}+W/${Zs}`, y2 = `${Y0}${c}+H/${Zs}`;
  return `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':eval=frame:interpolation=${interp}`;
}

function planeCentroid(buf, frame, w, h, thr) {
  const off = frame * w * h;
  let sw = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = buf[off + y * w + x] - thr;
    if (v > 0) { sw += v; sx += v * x; sy += v * y; }
  }
  return sw ? { x: sx / sw, y: sy / sw } : null;
}

function chromaTest(name, Z0, Z1, FX, FY, pre = '', post = '') {
  const W = 960, H = 540, FPS = 30, N = 90;
  const DOT = { x: 700, y: 200 };
  const src = `color=c=black:s=${W}x${H}:r=${FPS}:d=${N / FPS},format=yuv420p,` +
    `geq=lum='40+215*clip(8.5-hypot(X-${DOT.x},Y-${DOT.y}),0,1)':` +
    `cb='128+100*clip(4.5-hypot(X-${(DOT.x + 0.5) / 2 - 0.5},Y-${(DOT.y + 0.5) / 2 - 0.5}),0,1)':cr=128`;
  const get = (plane) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-vf',
      pre + persp(W, H, N, Z0, Z1, FX, FY) + post + `,extractplanes=${plane}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
    const r = spawnSync(FF, args, { maxBuffer: 1024 * 1024 * 512 });
    if (r.status !== 0) throw new Error(r.stderr.toString());
    return r.stdout;
  };
  const yb = get('y'), ub = get('u');
  const frames = N;
  let maxDx = 0, maxDy = 0, maxExpErr = 0;
  for (let n = 0; n < frames; n++) {
    const cy = planeCentroid(yb, n, W, H, 60);
    const cu = planeCentroid(ub, n, W / 2, H / 2, 134);
    if (!cy || !cu) continue;
    // luma-edge coordinates
    const yx = cy.x + 0.5, yy = cy.y + 0.5;
    const ux = (cu.x + 0.5) * 2, uy = (cu.y + 0.5) * 2;
    maxDx = Math.max(maxDx, Math.abs(yx - ux));
    maxDy = Math.max(maxDy, Math.abs(yy - uy));
    const z = Z0 * Math.pow(Z1 / Z0, n / N);
    const X0 = clip(FX * W - W / (2 * z), 0, W - W / z);
    const Y0 = clip(FY * H - H / (2 * z), 0, H - H / z);
    maxExpErr = Math.max(maxExpErr, Math.abs(yx - (DOT.x + 0.5 - X0) * z), Math.abs(yy - (DOT.y + 0.5 - Y0) * z));
  }
  console.log(`${name.padEnd(26)} luma-vs-chroma max dx=${maxDx.toFixed(3)} dy=${maxDy.toFixed(3)} (luma px) | luma expected-position max err=${maxExpErr.toFixed(3)}`);
}

console.log('== chroma alignment & directions (420 direct) ==');
chromaTest('zoom in 1->3 (0.75,0.35)', 1, 3, 0.75, 0.35);
chromaTest('static 2x center', 2, 2, 0.5, 0.5);
console.log('== via yuv444p round trip ==');
chromaTest('444 zoom in 1->3', 1, 3, 0.75, 0.35, 'format=yuv444p,', ',format=yuv420p');
chromaTest('444 zoom out 3->1', 3, 1, 0.75, 0.35, 'format=yuv444p,', ',format=yuv420p');
chromaTest('444 static 2x center', 2, 2, 0.5, 0.5, 'format=yuv444p,', ',format=yuv420p');
chromaTest('444 static 1x (identity)', 1, 1, 0.5, 0.5, 'format=yuv444p,', ',format=yuv420p');
chromaTest('420 static 1x (identity)', 1, 1, 0.5, 0.5);

console.log('== 1080p speed (perspective, 120 frames) ==');
for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
  const N = 120;
  for (const [label, pre, post] of [['420', '', ',format=yuv420p'], ['444 round trip', 'format=yuv444p,', ',format=yuv420p']]) {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=30:d=${N / 30}`, '-vf',
      pre + persp(w, h, N, 1, 2, 0.5, 0.5) + post, '-f', 'null', '-'];
    const t0 = Date.now();
    const r = spawnSync(FF, args, { maxBuffer: 1024 * 1024 * 64 });
    const ms = Date.now() - t0;
    console.log(`${w}x${h} ${label}: status=${r.status} ${ms}ms for ${N} frames -> ${(N / (ms / 1000)).toFixed(1)} fps (includes testsrc2 generation)`);
  }
}
