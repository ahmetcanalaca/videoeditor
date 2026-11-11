'use strict';
// MANUAL end-to-end check of the web edition with the REAL Local AI helper and the REAL model (Qwen3.5-4B, the one of the desktop app). Not part of
// `npm test`: it needs the desktop app's model and engine on this machine (≈3.4 GB) and takes several minutes.
//   1. the helper starts the real model (like a double-click on Start-Local-AI.cmd would) on a private data folder,
//   2. the page pairs with it by link, exactly as the helper's browser window would,
//   3. typed commands (English and Turkish) edit the timeline, each one undone by ONE Ctrl+Z,
//   4. "look at the video": a film made of real COCO photographs (the desktop app's e2e film, tests/pilot/coco_vlm) in which a dog is on screen for known
//      seconds - the assistant has to find those seconds with the page's own picture extraction and zoom in on the dog.
//   node tests/ai-real.test.js        (VE_ONLY=text skips the picture part, VE_ONLY=vision the typed commands, VE_FIRST=1 only the first picture query,
//                                      VE_SHOTS=<dir> saves a screenshot of the result, VE_BROWSER=<chrome|edge exe>)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open, checker } = require('./lib/site');
const h = require('./lib/media-tools');
const real = require('./lib/helper-real');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHOTOS = path.join(real.REPO, 'tests', 'pilot', 'coco_vlm');
const W = 960;
const HH = 540;

// [photo, seconds, has the object]: the same film as tests/e2e-find.js
const DOG = [
  ['000000231097', 4, 0], ['000000224200', 6, 1], ['000000166287', 4, 0], ['000000216419', 4, 0], ['000000392818', 5, 1], ['000000323496', 3, 0], ['000000347930', 6, 1],
  ['000000345466', 4, 0], ['000000002153', 4, 0], ['000000053529', 5, 1], ['000000360393', 5, 0], ['000000236784', 4, 1], ['000000240250', 6, 0],
];

function buildDogFilm(file) {
  const tasks = JSON.parse(fs.readFileSync(path.join(PHOTOS, 'tasks.json'), 'utf8'));
  const gt = (photo) => tasks.find((t) => t.file === photo + '.jpg' && t.kind === 'ground');
  let t = 0;
  const truth = [];
  DOG.forEach(([photo, secs, has]) => {
    if (has) {
      const g = gt(photo);
      let box = null;
      if (g) {
        // the photo is scaled to fit and centred: where is its ground-truth box in the frame?
        const s = Math.min(W / g.w, HH / g.h);
        const ox = (W - g.w * s) / 2;
        const oy = (HH - g.h * s) / 2;
        box = { x1: (ox + g.box_px[0] * s) / W, y1: (oy + g.box_px[1] * s) / HH, x2: (ox + g.box_px[2] * s) / W, y2: (oy + g.box_px[3] * s) / HH };
      }
      truth.push({ start: t, end: t + secs, box });
    }
    t += secs;
  });
  const args = [];
  DOG.forEach(([photo, secs]) => args.push('-loop', '1', '-framerate', '10', '-t', String(secs), '-i', path.join(PHOTOS, photo + '.jpg')));
  const chains = DOG.map((s, i) => `[${i}:v]scale=${W}:${HH}:force_original_aspect_ratio=decrease,pad=${W}:${HH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=10,format=yuv420p,noise=alls=5:allf=t[v${i}]`);
  const concat = DOG.map((s, i) => `[v${i}]`).join('') + `concat=n=${DOG.length}:v=1:a=0[out]`;
  h.ff([...args, '-filter_complex', chains.join(';') + ';' + concat, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-y', file]);
  return { total: t, truth };
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
  const check = checker('web ai (REAL model)');
  if (!real.available()) { console.log('SKIP: the desktop app\'s model and engine are not on this machine'); return; }
  const only = process.env.VE_ONLY || '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-web-ai-real-'));
  const dataDir = real.seed(path.join(tmp, 'Yerel AI', 'veri'));
  const PORT = 18574;
  const helper = real.start(dataDir, ['-Port', String(PORT), '-Site', 'http://127.0.0.1:1/']);
  let app = null;
  try {
    const up = await real.waitHealth(PORT, 240000);
    check('01 the helper started the real model', up, helper.output().slice(-800));
    if (!up) return;
    const key = real.readKey(dataDir);

    app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
    const ev = (expr) => app.evaluate(expr);
    const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy, volume: s.volume }))');
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const ask = async (text) => {
      const t0 = Date.now();
      await ev(`(() => { VE.ai.send(${JSON.stringify(text)}); return true; })()`);
      await sleep(500);
      await app.waitFor('!VE.ai.isRunning()', 900000, 'the assistant to finish: ' + text);
      const st = await ev('VE.ai.debug()');
      const last = st.messages.filter((m) => m.type === 'ai' || m.type === 'error').pop();
      return { secs: +((Date.now() - t0) / 1000).toFixed(1), segs: await segs(), reply: last ? String(last.text || last.message || '').slice(0, 200) : '', actions: last && last.actions ? last.actions.length : 0 };
    };
    const undo = async () => { await app.key('z', { ctrl: true }); await sleep(400); };

    await ev('window.__veAnswers = [0]');
    await ev("location.hash = '#local-ai=" + PORT + '.' + key + "'");
    await app.waitFor('window.api.ai.status().then((s) => s.ready)', 60000, 'paired');
    const st = await ev('window.api.ai.status()');
    check('02 the page paired with the real helper by link: ready, and the real model accepts pictures', st.ready && st.provider === 'builtin' && st.vision === true && st.builtin.port === PORT, st);

    /* ---------------- commands that edit the timeline ---------------- */
    await app.stage([path.basename(app.fixtures.A)]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1', 30000, 'one clip');
    const base = (await segs())[0];
    const dur = base.out - base.in;
    await ev('VE.ai.open()');
    await sleep(300);
    console.log('clip: ' + dur.toFixed(2) + ' s');

    const cases = [
      ['Cut the first 3 seconds', (r) => r.segs.length === 1 && near(r.segs[0].in, 3, 0.15) && near(r.segs[0].out, base.out, 0.15)],
      ['Videoyu 2 kat hızlandır', (r) => r.segs.length >= 1 && r.segs.every((s) => near(s.speed, 2, 0.01))],
      ['Split the video at 4 seconds and play the second part at half speed', (r) => r.segs.length === 2 && near(r.segs[0].out, 4, 0.15) && near(r.segs[0].speed, 1, 0.01) && near(r.segs[1].speed, 0.5, 0.01)],
      ['Son 2 saniyeyi sil', (r) => r.segs.length === 1 && near(r.segs[0].out, base.out - 2, 0.15) && near(r.segs[0].in, base.in, 0.05)],
      ['Zoom in to 1.5x over the whole video', (r) => r.segs.length >= 1 && r.segs.every((s) => Math.max(s.zoomFrom, s.zoomTo) >= 1.4 && Math.max(s.zoomFrom, s.zoomTo) <= 1.6)],
    ];
    for (const [text, ok] of only === 'vision' ? [] : cases) {
      const r = await ask(text);
      check('"' + text + '" (' + r.secs + ' s) edited the timeline as asked', ok(r) && r.actions >= 1, { reply: r.reply, segs: r.segs });
      await undo();
      const back = await segs();
      check('   ONE Ctrl+Z gives the original clip back', back.length === 1 && near(back[0].in, base.in, 0.001) && near(back[0].out, base.out, 0.001) && back[0].speed === 1 && back[0].zoomFrom === 1 && back[0].zoomTo === 1, back);
    }

    /* ---------------- look at the video ---------------- */
    if (only === 'text' || !fs.existsSync(path.join(PHOTOS, 'tasks.json'))) {
      console.log('SKIP the picture part');
    } else {
      const film = path.join(app.fixDir, 'dog_coco.mp4');
      const spec = buildDogFilm(film);
      console.log('dog film: ' + spec.total + ' s, the dog is on screen for ' + spec.truth.map((x) => x.start + '-' + x.end).join(', '));
      const questions = ['Zoom in on the dog while it is on screen', 'Köpek ekranda olduğu sürece köpeğe yakınlaştır'];
      for (const text of process.env.VE_FIRST === '1' ? questions.slice(0, 1) : questions) {
        await ev('window.__veAnswers = [1]');
        await app.click('#btn-new');
        await app.waitFor('VE.state.S.segments.length === 0 && VE.state.S.media.size === 0', 10000, 'a new project');
        await app.stage([path.basename(film)]);
        await app.click('#btn-add-empty');
        await app.waitFor('VE.state.S.segments.length === 1 && VE.state.S.media.size === 1', 60000, 'the dog film');
        const r = await ask(text);
        const zoomed = r.segs.filter((s) => Math.max(s.zoomFrom, s.zoomTo) > 1.05);
        const pred = [];
        zoomed.forEach((s) => { const last = pred[pred.length - 1]; if (last && s.in - last[1] < 0.3) last[1] = s.out; else pred.push([s.in, s.out]); });
        const sc = timeScore(spec.truth.map((x) => [x.start, x.end]), pred, spec.total);
        console.log('  "' + text + '": ' + r.secs + ' s; zoomed ' + pred.map((p) => p[0].toFixed(1) + '-' + p[1].toFixed(1)).join(', ') + ' | time-IoU ' + sc.iou + ' (hit ' + sc.tp + ' s, missed ' + sc.fn + ' s, false ' + sc.fp + ' s) | ' + r.reply);
        check('"' + text + '": the dog parts are found and zoomed (time-IoU ≥ 0.6, at most 6 s of false alarm)', sc.iou >= 0.6 && sc.fp <= 6, { sc, pred, truth: spec.truth.map((x) => [x.start, x.end]) });
        if (process.env.VE_SHOTS) { fs.mkdirSync(process.env.VE_SHOTS, { recursive: true }); await app.screenshot(path.join(process.env.VE_SHOTS, 'web-09-ai-find-dog-real-model-tr-dark.png')); }
        // the zoom aims at the dog: its box centre in the film (where the ground truth is known)
        const aimed = zoomed.map((s) => {
          const mid = (s.in + s.out) / 2;
          const t = spec.truth.find((x) => mid >= x.start && mid < x.end);
          if (!t || !t.box) return null;
          const cx = (t.box.x1 + t.box.x2) / 2;
          const cy = (t.box.y1 + t.box.y2) / 2;
          return Math.hypot(s.fx - cx, s.fy - cy);
        }).filter((x) => x !== null);
        check('   the zoom aims at the dog (the focus is within 0.25 of the box centre for most zoomed parts)', aimed.length > 0 && aimed.filter((d) => d <= 0.25).length >= Math.ceil(aimed.length * 0.6), aimed.map((d) => +d.toFixed(2)));
        await undo();
      }
    }
    check('no console errors during the whole run', app.errors.length === 0, app.errors);
  } finally {
    if (app) await app.close();
    await real.stop(dataDir);
    await Promise.race([helper.done, sleep(30000)]);
    try { helper.child.kill(); } catch (e) { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* the temp folder cleaner will do */ }
    process.exitCode = check.summary() ? process.exitCode : 1;
  }
})().catch((e) => { console.error('ai-real test crashed:', e); process.exit(1); });
