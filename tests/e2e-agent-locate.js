'use strict';
// MANUAL end-to-end check of the whole locate_in_video flow with a REAL model as the CHAT model and the vision model (not part of `npm test`; needs the model files):
//   1. node tests/llm-serve.js --models=<root>             (keeps the built-in Qwen3.5-4B running, writes tests/out/llm-serve.json)
//   2. node tests/e2e-find.js --mode=cloud --films=car      (once: makes tests/out/e2e-films/car.mp4 from real COCO photographs)
//   3. node tests/e2e-agent-locate.js [--film=car] [--prompt="arabalara zoom yap"] [--runs=1]
// The agent runs with the FULL system prompt (as a cloud model gets it, compact: false), a fake Content Understanding analysis whose scenes are the real shots of the film,
// and the REAL locator: real frames (ffmpeg), the real vision model through its chat route, the user's yes given automatically. What is measured: does the model call
// analyze_video, then locate_in_video with the scenes of the analysis, then set_zoom(found=...); and where does the zoom of every part aim compared with the COCO box?
const fs = require('fs');
const path = require('path');
const { runAgent } = require('../src/main/ai/agent');
const { createProvider } = require('../src/main/ai/providers');
const { createLocator } = require('../src/main/perception/locate');
const { createCloudVlm } = require('../src/main/perception/cloud-vlm');
const M = require('../src/shared/model');
const H = require('./helpers');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const FILM = arg('film', 'car');
const PROMPT = arg('prompt', 'arabalara zoom yap');
const RUNS = Number(arg('runs', 1));
const PHOTOS = path.join(__dirname, 'pilot', 'coco_vlm');
const FILE = path.join(__dirname, 'out', 'e2e-films', FILM + '.mp4');
const W = 960;
const HH = 540;
const tasks = JSON.parse(fs.readFileSync(path.join(PHOTOS, 'tasks.json'), 'utf8'));
const SHOTS = {
  car: [['000000052996', 4, 0], ['000000566282', 6, 1], ['000000338905', 4, 0], ['000000577932', 5, 1], ['000000061268', 4, 0], ['000000303818', 5, 1], ['000000037988', 4, 0], ['000000147338', 6, 1], ['000000232088', 4, 0], ['000000017207', 5, 1], ['000000017182', 4, 0]],
  dog: [['000000231097', 4, 0], ['000000224200', 6, 1], ['000000166287', 4, 0], ['000000216419', 4, 0], ['000000392818', 5, 1], ['000000323496', 3, 0], ['000000347930', 6, 1], ['000000345466', 4, 0], ['000000002153', 4, 0], ['000000053529', 5, 1], ['000000360393', 5, 0], ['000000236784', 4, 1], ['000000240250', 6, 0]],
}[FILM];
const WORD = { car: 'car', dog: 'dog' }[FILM];

// the scenes of a (fake) analysis: the real shots of the film; the shots with the object are described as such
let t = 0;
const scenes = SHOTS.map(([photo, secs, has], i) => {
  const s = { id: 's' + (i + 1), start: t, end: t + secs, clip: 1, has, photo, description: has ? 'A ' + WORD + ' is shown on a street.' : 'A scene with people and objects, no ' + WORD + '.' };
  t += secs;
  return s;
});
const TOTAL = t;
const truth = scenes.filter((s) => s.has).map((s) => {
  const g = tasks.find((x) => x.file === s.photo + '.jpg' && x.kind === 'ground');
  if (!g) return { start: s.start, end: s.end, center: null };
  const k = Math.min(W / g.w, HH / g.h);
  const ox = (W - g.w * k) / 2;
  const oy = (HH - g.h * k) / 2;
  const b = { x1: (ox + g.box_px[0] * k) / W, y1: (oy + g.box_px[1] * k) / HH, x2: (ox + g.box_px[2] * k) / W, y2: (oy + g.box_px[3] * k) / HH };
  return { start: s.start, end: s.end, center: { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 } };
});

(async () => {
  if (!fs.existsSync(FILE)) { console.error('missing ' + FILE + ' - run e2e-find.js once first'); process.exit(1); }
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'llm-serve.json'), 'utf8'));
  const media = { mA: { id: 'mA', name: FILM + '.mp4', path: FILE, duration: TOTAL, fps: 10, hasAudio: false, displayWidth: W, displayHeight: HH } };
  const seg = () => M.createSegment(media.mA, { id: 'a', in: 0, out: TOTAL });
  for (let run = 1; run <= RUNS; run++) {
    const provider = createProvider({ kind: 'local', baseUrl: info.baseUrl, model: 'built-in', apiKey: info.key, fetch: (u, i) => fetch(u, i), timeoutMs: 300000 });
    const log = [];
    let plan = null;
    const analysis = {
      analyze: async (args) => {
        log.push('analyze_video ' + JSON.stringify(args));
        const q = String((args && args.query) || '').toLowerCase();
        const list = scenes.map((s) => ({ id: s.id, start: s.start, end: s.end, clip: 1, description: s.description, match: !!q && s.description.toLowerCase().includes(q.split(/\s+/)[0]) }));
        return { ok: true, range: { start: 0, end: TOTAL }, scene_count: list.length, scenes: list, truncated: false, next_start: null, matches: list.filter((s) => s.match).map((s) => s.id), uploaded_parts: 1, cached: false, note: 'Times are seconds on the ORIGINAL timeline.', ui: { scenes: list.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.description })), uploaded: 1, range: { start: 0, end: TOTAL } } };
      },
    };
    let pictures = 0;
    const locatorFactory = (session) => {
      const inner = createLocator({
        pieces: session.originalMap(), fileOf: () => FILE, ffmpegPath: H.bins.ffmpeg, procs: null,
        vlm: createCloudVlm({ provider: { chat: async (req) => { pictures++; return provider.chat(req); } } }),
        userText: PROMPT, confirmFrames: async (p) => { plan = p; return true; }, timeoutMs: 20 * 60 * 1000,
      });
      return { locate: async (args) => { log.push('locate_in_video ' + JSON.stringify(args)); const r = await inner.locate(args); log.push('  -> ' + (r.ok ? r.intervals.length + ' part(s), not confirmed: ' + JSON.stringify(r.unconfirmed) : 'ERROR ' + (r.code || '') + ' ' + r.error)); return r; } };
    };
    const t0 = Date.now();
    const r = await runAgent({
      provider, prompt: PROMPT, lang: 'tr', compact: false, signal: undefined,
      snapshot: { segments: [seg()], media, exportSettings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' }, playhead: 0, selectedId: null },
      analysisFactory: () => analysis, locatorFactory,
      onStep: (s) => { if (s.kind === 'action') log.push('  edit: ' + JSON.stringify(s.action).slice(0, 140)); },
    });
    console.log('\n=== run ' + run + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s) prompt: ' + JSON.stringify(PROMPT) + ' -> ok=' + r.ok + (r.ok ? '' : ' ' + JSON.stringify(r.error)));
    log.forEach((l) => console.log('  ' + l));
    if (r.ok) {
      console.log('  answer: ' + String(r.message).replace(/\s+/g, ' ').slice(0, 300));
      const z = r.segments.filter((s) => s.zoomTo > 1.01 || s.zoomFrom > 1.01);
      console.log('  plan: ' + JSON.stringify(plan) + '  pictures sent: ' + pictures);
      truth.forEach((g) => {
        const mine = z.filter((s) => s.in >= g.start - 1.5 && s.out <= g.end + 1.5);
        if (!mine.length) { console.log('  truth ' + g.start + '-' + g.end + ' (has ' + WORD + '): NO ZOOM'); return; }
        const fx = mine.reduce((s, x) => s + x.fx, 0) / mine.length;
        const fy = mine.reduce((s, x) => s + x.fy, 0) / mine.length;
        console.log('  truth ' + g.start + '-' + g.end + ': zoom focus (' + fx.toFixed(2) + ', ' + fy.toFixed(2) + ')' + (g.center ? '  object centre (' + g.center.x.toFixed(2) + ', ' + g.center.y.toFixed(2) + ')  error ' + Math.hypot(fx - g.center.x, fy - g.center.y).toFixed(3) : '  (no ground-truth box)'));
      });
      const stray = z.filter((s) => !truth.some((g) => s.in >= g.start - 1.5 && s.out <= g.end + 1.5));
      if (stray.length) console.log('  ZOOM OUTSIDE THE SHOTS WITH THE OBJECT: ' + JSON.stringify(stray.map((s) => [s.in, s.out])));
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
