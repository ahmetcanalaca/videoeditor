// Zoom filter research: measures sub-pixel accuracy and smoothness of different FFmpeg zoom approaches.
const { spawnSync } = require('child_process');
const path = require('path');

const FF = require('../src/main/ffmpeg-paths').resolveBinaries({ resourcesPath: null }).ffmpeg;
const W = 960, H = 540, FPS = 30, N = 90;
const DOT = { x: 700, y: 200, r: 8 };
const Z0 = 1, Z1 = 3, FX = 0.75, FY = 0.35;

const src = `color=c=black:s=${W}x${H}:r=${FPS}:d=${N / FPS},format=yuv420p,` +
  `geq=lum='40+215*clip(${DOT.r}+0.5-hypot(X-${DOT.x},Y-${DOT.y}),0,1)':cb=128:cr=128`;

function runRaw(vf) {
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-vf', vf + ',format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
  const r = spawnSync(FF, args, { maxBuffer: 1024 * 1024 * 512 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}

function centroid(buf, frameIdx, w, h) {
  const off = frameIdx * w * h;
  let sw = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = buf[off + y * w + x] - 60;
      if (v > 0) { sw += v; sx += v * x; sy += v * y; }
    }
  }
  if (sw === 0) return null;
  return { x: sx / sw + 0.5, y: sy / sw + 0.5 };
}

const clip = (v, a, b) => Math.min(Math.max(v, a), b);
function expected(fn) {
  const z = Z0 * Math.pow(Z1 / Z0, fn / N);
  const X0 = clip(FX * W - W / (2 * z), 0, W - W / z);
  const Y0 = clip(FY * H - H / (2 * z), 0, H - H / z);
  return { x: (DOT.x + 0.5 - X0) * z, y: (DOT.y + 0.5 - Y0) * z, z };
}

function evaluate(name, vf, frameOffset = 0) {
  const t0 = Date.now();
  let buf;
  try { buf = runRaw(vf); } catch (e) { console.log(name, 'FAILED:', String(e.message).split('\n').slice(0, 3).join(' | ')); return; }
  const ms = Date.now() - t0;
  const frames = Math.floor(buf.length / (W * H));
  const ex = [], ey = [];
  for (let n = 0; n < frames; n++) {
    const c = centroid(buf, n, W, H);
    const e = expected(n + frameOffset);
    if (!c) { ex.push(NaN); ey.push(NaN); continue; }
    ex.push(c.x - e.x); ey.push(c.y - e.y);
  }
  const stats = (arr) => {
    const v = arr.filter(Number.isFinite);
    const max = Math.max(...v.map(Math.abs));
    const rms = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
    let jerk = 0;
    for (let i = 2; i < arr.length; i++) jerk = Math.max(jerk, Math.abs(arr[i] - 2 * arr[i - 1] + arr[i - 2]));
    return `max=${max.toFixed(3)} rms=${rms.toFixed(3)} jerk=${jerk.toFixed(3)}`;
  };
  console.log(`${name.padEnd(34)} frames=${frames} ${String(ms).padStart(5)}ms | X: ${stats(ex)} | Y: ${stats(ey)}`);
}

function persp(zExpr, corr = true, interp = 'cubic') {
  const Zs = `(${zExpr})`;
  const X0 = `clip(${FX}*W-W/(2*${Zs}),0,W-W/${Zs})`;
  const Y0 = `clip(${FY}*H-H/(2*${Zs}),0,H-H/${Zs})`;
  const c = corr ? `+(0.5/${Zs}-0.5)` : '';
  const x0 = `${X0}${c}`;
  const y0 = `${Y0}${c}`;
  const x1 = `${X0}${c}+W/${Zs}`;
  const y2 = `${Y0}${c}+H/${Zs}`;
  return `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':eval=frame:interpolation=${interp}`;
}

const zIn = `${Z0}*pow(${Z1 / Z0},in/${N})`;
const zInP1 = `${Z0}*pow(${Z1 / Z0},(in-1)/${N})`;
const zOn = `${Z0}*pow(${Z1 / Z0},on/${N})`;

console.log('== perspective variants ==');
evaluate('perspective in/N corr cubic', persp(zIn));
evaluate('perspective (in-1)/N corr cubic', persp(zInP1));
evaluate('perspective on/N corr cubic', persp(zOn));
evaluate('perspective in/N nocorr cubic', persp(zIn, false));
evaluate('perspective in/N corr linear', persp(zIn, true, 'linear'));

console.log('== scale+crop ==');
const zN = `${Z0}*pow(${Z1 / Z0},n/${N})`;
evaluate('scale eval=frame + crop (444)',
  `format=yuv444p,scale=w='trunc(${W}*(${zN})/2)*2':h='trunc(${H}*(${zN})/2)*2':eval=frame:flags=bicubic,` +
  `crop=${W}:${H}:x='clip(${FX}*iw-${W}/2,0,iw-${W})':y='clip(${FY}*ih-${H}/2,0,ih-${H})'`);
evaluate('scale eval=frame + crop (420)',
  `scale=w='trunc(${W}*(${zN})/2)*2':h='trunc(${H}*(${zN})/2)*2':eval=frame:flags=bicubic,` +
  `crop=${W}:${H}:x='clip(${FX}*iw-${W}/2,0,iw-${W})':y='clip(${FY}*ih-${H}/2,0,ih-${H})'`);

console.log('== zoompan ==');
evaluate('zoompan (no prescale)',
  `zoompan=z='${Z0}*pow(${Z1 / Z0},on/${N})':x='clip(${FX}*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip(${FY}*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${W}x${H}:fps=${FPS}`);
