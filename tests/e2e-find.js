'use strict';
// MANUAL end-to-end measurement of find_in_video with the REAL built-in model (not part of `npm test`; needs the model files, ~3.4 GB).
//   1. node tests/llm-serve.js --models=<root>          (keeps the model running and writes tests/out/llm-serve.json)
//   2. node tests/e2e-find.js [--films=dog,car] [--probe=512] [--ground=768] [--max-frames=100] [--out=tests/out/e2e-find.json]
// Two "films" are built from real COCO photographs (tests/pilot/coco_vlm) whose content is known from the COCO annotations: dog photos mixed with
// photos that certainly contain NO dog (and the same for cars). Each query is run through the real code path of the app: ffmpeg frames, the
// vision model, the scan with edge refinement, box handling. The truth is compared with what was found: time accuracy, false alarms, missed parts,
// the box of the object (zoom focus), and how long it takes.
const fs = require('fs');
const path = require('path');
const { createVlm } = require('../src/main/perception/vlm');
const { createPerception } = require('../src/main/perception');
const { iou } = require('../src/main/perception/boxes');
const H = require('./helpers');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const FILMS = arg('films', 'dog,car').split(',');
const PROBE = Number(arg('probe', 512));
const GROUND = Number(arg('ground', 768));
const MAX_FRAMES = Number(arg('max-frames', 100));
const OUT = arg('out', path.join(__dirname, 'out', 'e2e-find.json'));
const PHOTOS = path.join(__dirname, 'pilot', 'coco_vlm');
const FILM_DIR = path.join(__dirname, 'out', 'e2e-films');
const W = 960;
const HH = 540;

const tasks = JSON.parse(fs.readFileSync(path.join(PHOTOS, 'tasks.json'), 'utf8'));
const gt = (file) => tasks.find((t) => t.file === file + '.jpg' && t.kind === 'ground');

// [photo, seconds, has the object]
const FILMS_SPEC = {
  dog: { object: 'dog', shots: [
    ['000000231097', 4, 0], ['000000224200', 6, 1], ['000000166287', 4, 0], ['000000216419', 4, 0], ['000000392818', 5, 1], ['000000323496', 3, 0], ['000000347930', 6, 1],
    ['000000345466', 4, 0], ['000000002153', 4, 0], ['000000053529', 5, 1], ['000000360393', 5, 0], ['000000236784', 4, 1], ['000000240250', 6, 0],
  ] },
  car: { object: 'car', shots: [
    ['000000052996', 4, 0], ['000000566282', 6, 1], ['000000338905', 4, 0], ['000000577932', 5, 1], ['000000061268', 4, 0], ['000000303818', 5, 1],
    ['000000037988', 4, 0], ['000000147338', 6, 1], ['000000232088', 4, 0], ['000000017207', 5, 1], ['000000017182', 4, 0],
  ] },
};

function buildFilm(name) {
  const spec = FILMS_SPEC[name];
  fs.mkdirSync(FILM_DIR, { recursive: true });
  const file = path.join(FILM_DIR, name + '.mp4');
  let t = 0;
  const truth = [];
  const boxes = [];
  spec.shots.forEach(([photo, secs, has]) => {
    if (has) {
      truth.push([t, t + secs]);
      const g = gt(photo);
      if (g) {
        // the photo is scaled to fit and centred: where is its ground-truth box in the frame?
        const s = Math.min(W / g.w, HH / g.h);
        const ox = (W - g.w * s) / 2;
        const oy = (HH - g.h * s) / 2;
        boxes.push({ start: t, end: t + secs, box: { x1: (ox + g.box_px[0] * s) / W, y1: (oy + g.box_px[1] * s) / HH, x2: (ox + g.box_px[2] * s) / W, y2: (oy + g.box_px[3] * s) / HH } });
      }
    }
    t += secs;
  });
  if (!fs.existsSync(file)) {
    const args = [];
    spec.shots.forEach(([photo, secs]) => args.push('-loop', '1', '-framerate', '10', '-t', String(secs), '-i', path.join(PHOTOS, photo + '.jpg')));
    const chains = spec.shots.map((s, i) => `[${i}:v]scale=${W}:${HH}:force_original_aspect_ratio=decrease,pad=${W}:${HH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=10,format=yuv420p,noise=alls=5:allf=t[v${i}]`);
    const concat = spec.shots.map((s, i) => `[v${i}]`).join('') + `concat=n=${spec.shots.length}:v=1:a=0[out]`;
    H.ff([...args, '-filter_complex', chains.join(';') + ';' + concat, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-y', file]);
  }
  return { name, file, total: t, truth, boxes, object: spec.object };
}

// seconds (0.1 s resolution) in both / only in the truth / only in the prediction
function timeScore(truth, pred, total) {
  const inside = (list, x) => list.some(([a, b]) => x >= a && x < b);
  let tp = 0; let fn = 0; let fp = 0;
  for (let x = 0.05; x < total; x += 0.1) {
    const a = inside(truth, x);
    const b = inside(pred, x);
    if (a && b) tp += 0.1; else if (a) fn += 0.1; else if (b) fp += 0.1;
  }
  return { tp: +tp.toFixed(1), fn: +fn.toFixed(1), fp: +fp.toFixed(1), iou: tp + fn + fp > 0 ? +(tp / (tp + fn + fp)).toFixed(3) : 1 };
}

(async () => {
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'llm-serve.json'), 'utf8'));
  let calls = 0;
  let callSecs = 0;
  const chat = async (body, signal) => {
    const t0 = Date.now();
    const res = await fetch(info.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + info.key }, body: JSON.stringify(body), signal });
    const json = await res.json();
    calls++;
    callSecs += (Date.now() - t0) / 1000;
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + JSON.stringify(json).slice(0, 200));
    return json;
  };
  const vlm = createVlm({ boxFormat: 'k1000', chat });
  const rows = [];
  console.log(`e2e  backend=${info.backend}  probe=${PROBE}px ground=${GROUND}px maxFrames=${MAX_FRAMES}\n`);

  const queries = [];
  for (const name of FILMS) {
    const film = buildFilm(name);
    queries.push({ film, object: film.object, truth: film.truth, label: film.object });
    if (name === FILMS[0]) queries.push({ film, object: 'giraffe', truth: [], label: 'giraffe (absent)' });
  }
  for (const q of queries) {
    const { film } = q;
    const perception = createPerception({
      pieces: [{ b0: 0, b1: film.total, mediaId: 'm', in: 0, speed: 1 }], fileOf: () => film.file, ffmpegPath: H.bins.ffmpeg, vlm,
      userText: 'find the ' + q.object, maxFrames: MAX_FRAMES, sides: { probe: PROBE, ground: GROUND },
    });
    calls = 0; callSecs = 0;
    const t0 = Date.now();
    const res = await perception.find({ object: q.object });
    const secs = (Date.now() - t0) / 1000;
    const pred = res.intervals.map((iv) => [iv.start, iv.end]);
    const sc = timeScore(q.truth, pred, film.total);
    // per true appearance: edges and box
    const per = q.truth.map(([a, b]) => {
      const m = res.intervals.filter((iv) => iv.end > a && iv.start < b).sort((x, y) => (Math.min(y.end, b) - Math.max(y.start, a)) - (Math.min(x.end, b) - Math.max(x.start, a)))[0];
      const g = film.boxes.find((x) => Math.abs(x.start - a) < 0.01);
      return { truth: [a, b], found: m ? [m.start, m.end] : null, startErr: m ? +(m.start - a).toFixed(2) : null, endErr: m ? +(m.end - b).toFixed(2) : null, boxIoU: m && m.box && g ? +iou(m.box, g.box).toFixed(2) : null, hasGt: !!g };
    });
    const row = { query: q.label, film: film.name, filmSeconds: film.total, truth: q.truth, pred, ...sc, secs: +secs.toFixed(1), frames: res.frames, probes: res.probes, calls, secsPerCall: +(callSecs / Math.max(1, calls)).toFixed(2), per };
    rows.push(row);
    console.log(`${q.label.padEnd(18)} film ${film.name} (${film.total}s): truth ${q.truth.length} parts, found ${res.intervals.length}; time-IoU ${sc.iou}  (hit ${sc.tp}s, missed ${sc.fn}s, false ${sc.fp}s)  ${secs.toFixed(0)} s, ${calls} model calls (${(callSecs / Math.max(1, calls)).toFixed(2)} s each)`);
    per.forEach((p) => console.log(`    truth ${p.truth.map((x) => x.toFixed(0)).join('-')}  ->  ${p.found ? p.found.map((x) => x.toFixed(1)).join('-') : 'MISSED'}   edges ${p.startErr}/${p.endErr}  box IoU ${p.boxIoU === null ? (p.hasGt ? 'n/a' : '-') : p.boxIoU}`));
    const extra = pred.filter(([a, b]) => !q.truth.some(([x, y]) => b > x && a < y));
    if (extra.length) console.log('    FALSE ALARM parts: ' + extra.map((e) => e.map((x) => x.toFixed(1)).join('-')).join(', '));
  }
  const present = rows.filter((r) => r.truth.length);
  const parts = present.reduce((s, r) => s + r.truth.length, 0);
  const hit = present.reduce((s, r) => s + r.per.filter((p) => p.found).length, 0);
  const boxes = present.flatMap((r) => r.per.filter((p) => p.boxIoU !== null).map((p) => p.boxIoU));
  const summary = { parts, hit, falseAlarmSecs: +rows.reduce((s, r) => s + r.fp, 0).toFixed(1), meanTimeIoU: +(present.reduce((s, r) => s + r.iou, 0) / Math.max(1, present.length)).toFixed(3), boxIoU50: boxes.filter((x) => x >= 0.5).length + '/' + boxes.length, meanSecs: +(rows.reduce((s, r) => s + r.secs, 0) / rows.length).toFixed(1) };
  console.log('\n==== e2e: parts found ' + hit + '/' + parts + ', false-alarm seconds ' + summary.falseAlarmSecs + ', mean time-IoU ' + summary.meanTimeIoU + ', boxes with IoU>=0.5: ' + summary.boxIoU50 + ', mean ' + summary.meanSecs + ' s per query ====');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ backend: info.backend, probe: PROBE, ground: GROUND, maxFrames: MAX_FRAMES, summary, rows }, null, 1));
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
