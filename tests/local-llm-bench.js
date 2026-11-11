'use strict';
// MANUAL benchmark of the AI assistant against a REAL local model server (not part of `npm test`).
// It drives exactly the code the app uses (local provider adapter + agent loop + edit engine) with the SAME commands in English
// and in Turkish, and with a second set in which the assistant is given "video analysis facts" (timestamped screen events such as
// "prompt submitted" / "answer finished") that a future analysis module would supply.
//
//   Start a server (OpenAI protocol + tool calling), e.g.
//     llama-server -m model.gguf --jinja -c 8192 --port 18080 --chat-template-kwargs "{\"enable_thinking\":false}"
//   Then:
//     set VE_LOCAL_URL=http://127.0.0.1:18080/v1
//     set VE_LOCAL_MODEL=any-name
//     set VE_LOCAL_KEY=<key>                   (only for the built-in model's private server: node tests/llm-serve.js prints it into tests/out/llm-serve.json)
//     set VE_BENCH_OUT=C:\temp\result.json        (optional JSON result)
//     set VE_BENCH_SETS=core,facts,vision   VE_BENCH_LANGS=en,tr   VE_BENCH_ONLY=C1,F3   (all optional)
//     node tests\local-llm-bench.js
const fs = require('fs');
const M = require('../src/shared/model');
const { createProvider } = require('../src/main/ai/providers');
const { runAgent } = require('../src/main/ai/agent');

const URL_BASE = process.env.VE_LOCAL_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.VE_LOCAL_MODEL || 'local';
const API_KEY = process.env.VE_LOCAL_KEY || ''; // the built-in model's private server needs its key (see tests/llm-serve.js)
const SETS = (process.env.VE_BENCH_SETS || 'core,facts,facts-iv,facts-ref').split(',').map((s) => s.trim());
const LANGS = (process.env.VE_BENCH_LANGS || 'en,tr').split(',').map((s) => s.trim());
const ONLY = (process.env.VE_BENCH_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = process.env.VE_BENCH_OUT || '';
const FULL_PROMPT = process.env.VE_BENCH_FULL_PROMPT === '1';

const mkSnapshot = (duration) => {
  const media = { mA: { id: 'mA', name: 'recording.mp4', duration, fps: 30, hasAudio: true, displayWidth: 1920, displayHeight: 1080 } };
  return { segments: [M.createSegment(media.mA, { id: 'a', in: 0, out: duration })], media, exportSettings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' }, playhead: 0, selectedId: null };
};

// ---- checking helpers: sample the ORIGINAL time axis and look at the piece that covers each sample --------------------
const at = (segs, t) => segs.find((s) => t >= s.in - 1e-6 && t < s.out - 1e-6);
const eps = (x, y, tol) => Math.abs(x - y) <= tol;
const normal = (s) => !!s && eps(s.speed, 1, 0.01) && eps(s.zoomFrom, 1, 0.01) && eps(s.zoomTo, 1, 0.01) && !s.mute && eps(s.volume, 1, 0.01) && !s.fadeIn && !s.fadeOut;
const IS = {
  removed: (s) => !s,
  speed: (v) => (s) => !!s && eps(s.speed, v, Math.max(0.05, v * 0.02)),
  fast: (s) => !!s && s.speed > 1.2,
  slow: (s) => !!s && s.speed < 0.9,
  zoomin: (s) => !!s && s.zoomTo > s.zoomFrom + 0.2,
  zoomout: (s) => !!s && s.zoomTo < s.zoomFrom - 0.2,
  muted: (s) => !!s && (s.mute || s.volume === 0),
  topleft: (s) => !!s && s.zoomTo > s.zoomFrom + 0.2 && s.fx < 0.4 && s.fy < 0.4,
  fastzoom: (v) => (s) => !!s && eps(s.speed, v, 0.1) && s.zoomTo > s.zoomFrom + 0.2,
};
// spec: [{ r:[a,b], is: predicate }]; every sample inside (shrunk by tol) must satisfy `is`, every sample outside all ranges (grown by tol) must be untouched
function checkSpec(segs, duration, spec, tol, restPred) {
  const rest = restPred || normal;
  for (const sp of spec) {
    for (let t = sp.r[0] + tol; t < sp.r[1] - tol; t += 0.5) if (!sp.is(at(segs, t))) return false;
  }
  for (let t = 0.25; t < duration; t += 0.5) {
    if (spec.some((sp) => t > sp.r[0] - tol && t < sp.r[1] + tol)) continue;
    if (!rest(at(segs, t))) return false;
  }
  return true;
}
const total = (segs) => segs.reduce((t, s) => t + (s.out - s.in) / s.speed, 0);
const fmt = (segs) => segs.map((s) => `[${s.in.toFixed(1)}-${s.out.toFixed(1)}${s.speed !== 1 ? ' x' + s.speed : ''}${s.zoomFrom !== 1 || s.zoomTo !== 1 ? ' z' + s.zoomFrom + '>' + s.zoomTo : ''}${s.mute || s.volume !== 1 ? ' vol' + (s.mute ? 0 : s.volume) : ''}${s.fadeOut ? ' fo' + s.fadeOut : ''}]`).join(' ');

const D = 100;
const CORE = [
  { id: 'C1', en: 'Cut the first 10 seconds', tr: 'İlk 10 saniyeyi kes', ok: (r) => r.changed && checkSpec(r.segments, D, [{ r: [0, 10], is: IS.removed }], 0.8) },
  { id: 'C2', en: 'Speed up the part from 0:20 to 0:30 by 2x', tr: '0:20 ile 0:30 arasını 2 kat hızlandır', ok: (r) => checkSpec(r.segments, D, [{ r: [20, 30], is: IS.speed(2) }], 0.8) },
  { id: 'C3', en: 'Zoom in from 0:30 to 0:40', tr: '30. saniyeden 40. saniyeye kadar yakınlaştır', ok: (r) => checkSpec(r.segments, D, [{ r: [30, 40], is: IS.zoomin }], 0.8) },
  { id: 'C4', en: 'Slow down the last 5 seconds', tr: 'Son 5 saniyeyi yavaşlat', ok: (r) => checkSpec(r.segments, D, [{ r: [95, 100], is: IS.slow }], 0.8) },
  { id: 'C5', en: 'Cut the first 5 seconds, speed up 20-30 by 2x and zoom in between 40 and 45', tr: 'İlk 5 saniyeyi kes, 20-30 arasını 2x hızlandır ve 40-45 arasında yakınlaştır', ok: (r) => checkSpec(r.segments, D, [{ r: [0, 5], is: IS.removed }, { r: [20, 30], is: IS.speed(2) }, { r: [40, 45], is: IS.zoomin }], 0.8) },
  { id: 'C6', en: 'Remove the section from 1:00 to 1:10', tr: '1:00 ile 1:10 arasını sil', ok: (r) => checkSpec(r.segments, D, [{ r: [60, 70], is: IS.removed }], 0.8) },
  { id: 'C7', en: 'Zoom in from 0:10 to 0:15, then zoom out from 0:15 to 0:20', tr: '10 ile 15. saniye arasını yakınlaştır, sonra 15-20 arasında uzaklaştır', ok: (r) => checkSpec(r.segments, D, [{ r: [10, 15], is: IS.zoomin }, { r: [15, 20], is: IS.zoomout }], 0.8) },
  { id: 'C8', en: 'How long is this video?', tr: 'Bu video kaç saniye?', ok: (r) => !r.changed && /100|1:40|1 min|1 dakika|100/.test(r.message) },
  { id: 'C9', en: 'Keep only the part from 0:30 to 1:00', tr: 'Sadece 0:30 ile 1:00 arası kalsın', ok: (r) => checkSpec(r.segments, D, [{ r: [0, 30], is: IS.removed }, { r: [60, 100], is: IS.removed }], 0.8, (s) => normal(s)) },
  { id: 'C10', en: 'Mute the last 10 seconds', tr: 'Son 10 saniyenin sesini kapat', ok: (r) => checkSpec(r.segments, D, [{ r: [90, 100], is: IS.muted }], 0.8) },
  { id: 'C11', en: 'Add a 3 second fade out at the end', tr: 'Sonda 3 saniyelik bir solma ekle', ok: (r) => { const l = r.segments[r.segments.length - 1]; return r.changed && !!l && eps(l.out, 100, 0.1) && eps(l.fadeOut, 3, 0.2) && !r.segments.some((s) => s !== l && (s.fadeOut || s.fadeIn)); } },
  { id: 'C12', en: 'Play 0:40-0:50 at half speed', tr: '40-50 arasını yarı hızda oynat', ok: (r) => checkSpec(r.segments, D, [{ r: [40, 50], is: IS.speed(0.5) }], 0.8) },
  { id: 'C13', en: 'Remove the first 5 seconds and the last 5 seconds', tr: 'İlk 5 ve son 5 saniyeyi sil', ok: (r) => checkSpec(r.segments, D, [{ r: [0, 5], is: IS.removed }, { r: [95, 100], is: IS.removed }], 0.8) },
  { id: 'C14', en: 'Zoom into the top left corner from 0:10 to 0:20', tr: '10 ile 20. saniye arasında sol üst köşeyi yakınlaştır', ok: (r) => checkSpec(r.segments, D, [{ r: [10, 20], is: IS.topleft }], 0.8) },
  { id: 'C15', en: 'Zoom in on the dog', tr: 'Köpeği yakınlaştır', ok: (r) => !r.changed },
  { id: 'C16', en: 'Add background music', tr: 'Arka plana müzik ekle', ok: (r) => !r.changed },
];

// ---- set 2: the assistant is told what an automatic analysis of a SCREEN RECORDING found ---------------------------------
const FD = 120;
// All times in the facts are plain SECONDS (the unit of the tools): a first trial with "m:ss.s" text made a 4B model write 0:58.4 as 0.584.
const FACTS = [
  '- 8.2 s: the user starts typing in the prompt box (typing_started)',
  '- 21.6 s: prompt submitted, Enter pressed (prompt_submitted)',
  '- 23.1 s: the AI starts writing its answer (answer_started)',
  '- 58.4 s: the AI answer is finished, the screen is static again (answer_finished)',
  '- 72.0 s: the user starts typing in the prompt box (typing_started)',
  '- 85.3 s: prompt submitted, Enter pressed (prompt_submitted)',
  '- 86.0 s: the AI starts writing its answer (answer_started)',
  '- 101.7 s: the AI answer is finished (answer_finished)',
].join('\n');
// Same information, but as NAMED INTERVALS (what an analysis module would really deliver: "state" ranges, not single points), so that the
// model only has to copy a range instead of pairing two events.
const FACTS_IV = [
  '- the user is typing in the prompt box: 8.2-21.6 s and 72.0-85.3 s',
  '- the prompt is submitted (Enter pressed) at 21.6 s and at 85.3 s',
  '- the AI is working on the answer (from prompt submitted until the answer is finished): 21.6-58.4 s and 85.3-101.7 s',
  '- the AI is writing the answer (text appears on screen): 23.1-58.4 s and 86.0-101.7 s',
  '- nothing is happening (idle): 58.4-72.0 s',
].join('\n');

const FACT_CASES = [
  { id: 'F1', en: 'Speed up everything from the moment the first prompt is submitted until the AI answer finishes, 6x. Keep the rest at normal speed.', tr: 'İlk prompt gönderildiği andan AI cevabı bitene kadar olan kısmı 6 kat hızlandır, kalanı normal hızda kalsın.', ok: (r) => checkSpec(r.segments, FD, [{ r: [21.6, 58.4], is: IS.speed(6) }], 1.2) },
  { id: 'F2', en: 'For both prompts, speed up the waiting time (from prompt submitted until the answer is finished) by 4x', tr: 'Her iki prompt için de bekleme süresini (prompt gönderilmesinden cevap bitene kadar) 4 kat hızlandır', ok: (r) => checkSpec(r.segments, FD, [{ r: [21.6, 58.4], is: IS.speed(4) }, { r: [85.3, 101.7], is: IS.speed(4) }], 1.2) },
  { id: 'F3', en: 'Cut out the typing parts (from when the user starts typing until the prompt is submitted)', tr: 'Yazma kısımlarını kes (kullanıcının yazmaya başlamasından prompt gönderilene kadar)', ok: (r) => checkSpec(r.segments, FD, [{ r: [8.2, 21.6], is: IS.removed }, { r: [72.0, 85.3], is: IS.removed }], 1.2) },
  { id: 'F4', en: 'Zoom in while the AI writes its first answer (from answer start until answer finished)', tr: 'AI ilk cevabı yazarken (cevap başlayınca bitene kadar) yakınlaştır', ok: (r) => checkSpec(r.segments, FD, [{ r: [23.1, 58.4], is: IS.zoomin }], 1.5) },
  { id: 'F5', en: 'Zoom in and speed up 3x during the second answer (from answer start until answer finished)', tr: 'İkinci cevap sırasında (cevap başlayınca bitene kadar) yakınlaştır ve 3 kat hızlandır', ok: (r) => checkSpec(r.segments, FD, [{ r: [86.0, 101.7], is: IS.fastzoom(3) }], 1.5) },
  { id: 'F6', en: 'Remove the pause between the end of the first answer and the moment the user starts typing again', tr: 'İlk cevabın bitişi ile kullanıcının tekrar yazmaya başlaması arasındaki boşluğu sil', ok: (r) => checkSpec(r.segments, FD, [{ r: [58.4, 72.0], is: IS.removed }], 1.2) },
];

// The compact prompt tells the model to refuse anything it must "see"; with analysis facts that rule is replaced (this is what v3 would do).
function withFacts(real, facts) {
  return {
    kind: real.kind,
    chat: (req) => real.chat(Object.assign({}, req, {
      system: String(req.system).replace(/- If the user asks to find or recognise something[^\n]*\n/, '')
        + '\n\nVIDEO ANALYSIS (automatic analysis of this screen recording; the timestamps are correct, in seconds of the original video):\n' + facts
        + '\nWhen the user refers to one of these events, use its timestamp. You still cannot see the video yourself.',
    })),
  };
}

// Third style: the model does not copy numbers at all - it picks a detected STATE and an occurrence, the engine looks up the times.
// (test-only emulation: the tools get two extra parameters and Session.apply resolves them; in v3 this would be part of the engine)
const ops = require('../src/shared/agent-ops');
const STATES = { typing: [[8.2, 21.6], [72.0, 85.3]], ai_working: [[21.6, 58.4], [85.3, 101.7]], ai_writing: [[23.1, 58.4], [86.0, 101.7]], idle: [[58.4, 72.0]] };
const FACTS_REF = [
  'DETECTED STATES of this screen recording (automatic analysis). To edit one of them pass `state` and `occurrence` ("1", "2", ... or "all") to the tool INSTEAD of start/end; the app looks up the times:',
  '- typing: the user is typing the prompt into the input box (before sending it). Occurrences: #1 (8.2-21.6 s), #2 (72.0-85.3 s)',
  '- ai_working: from the prompt being submitted until the AI answer is finished. Occurrences: #1 (21.6-58.4 s), #2 (85.3-101.7 s)',
  '- ai_writing: the answer text appears on screen. Occurrences: #1 (23.1-58.4 s), #2 (86.0-101.7 s)',
  '- idle: a pause between actions, nothing happens on screen. Occurrences: #1 (58.4-72.0 s)',
].join('\n');
function addStateParams(tools) {
  return tools.map((t) => {
    const props = t.parameters && t.parameters.properties;
    if (!props || !props.start) return t;
    const copy = JSON.parse(JSON.stringify(t));
    copy.parameters.properties.state = { type: 'string', enum: Object.keys(STATES), description: 'A detected state (instead of start/end).' };
    copy.parameters.properties.occurrence = { type: 'string', description: '"1", "2", ... or "all" occurrences of the state.' };
    return copy;
  });
}
let resolverInstalled = false;
function installStateResolver() {
  if (resolverInstalled) return;
  resolverInstalled = true;
  const orig = ops.Session.prototype.apply;
  ops.Session.prototype.apply = function (name, args) {
    if (args && typeof args === 'object' && args.state) {
      const list = STATES[String(args.state)];
      if (!list) return { ok: false, error: 'Unknown state "' + args.state + '". Available: ' + Object.keys(STATES).join(', ') };
      const occ = String(args.occurrence == null ? '1' : args.occurrence).toLowerCase();
      const picks = occ === 'all' ? list : [list[Number(occ) - 1]].filter(Boolean);
      if (!picks.length) return { ok: false, error: 'State "' + args.state + '" has ' + list.length + ' occurrence(s); occurrence ' + occ + ' does not exist.' };
      let last = null;
      for (const [a, b] of picks) {
        const a2 = Object.assign({}, args, { start: a, end: b });
        delete a2.state; delete a2.occurrence;
        last = orig.call(this, name, a2);
        if (!last.ok) return last;
      }
      return last;
    }
    return orig.call(this, name, args);
  };
}
function withStates(real) {
  installStateResolver();
  return {
    kind: real.kind,
    chat: (req) => real.chat(Object.assign({}, req, {
      system: String(req.system).replace(/- If the user asks to find or recognise something[^\n]*\n/, '') + '\n\n' + FACTS_REF + '\nYou still cannot see the video yourself.',
      tools: addStateParams(req.tools || []),
    })),
  };
}

// ---- set 3 ("vision"): the assistant has find_in_video. The pictures are not examined here: a canned perception answers (through the REAL
// request clean-up of src/main/perception/query.js), so this measures what the language model does with the tool: does it look when it must,
// pass the right words (object in English, colour / position only when written), edit with found="f1" and leave everything else alone.
const { reconcile } = require('../src/main/perception/query');
const WORLD = {
  dog: { intervals: [[10, 20], [60, 65]], box: { x1: 0.1, y1: 0.4, x2: 0.3, y2: 0.6 } },
  car: { intervals: [[30, 40]], box: { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.8 }, needs: { color: 'red' } },
  cat: { intervals: [[45, 55]], box: { x1: 0.4, y1: 0.3, x2: 0.6, y2: 0.7 } },
  person: { intervals: [[5, 15], [50, 60]], box: { x1: 0.05, y1: 0.2, x2: 0.3, y2: 0.9 }, needs: { position: 'left' } },
  giraffe: { intervals: [[20, 28]], box: { x1: 0.3, y1: 0.1, x2: 0.6, y2: 0.9 } },
  horse: { intervals: [[70, 80]], box: { x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.8 } },
};
const SYNONYMS = { dogs: 'dog', puppy: 'dog', cars: 'car', vehicle: 'car', automobile: 'car', cats: 'cat', kitten: 'cat', people: 'person', man: 'person', woman: 'person', human: 'person', persons: 'person' };
function cannedPerception(userText) {
  const asked = [];
  return {
    asked,
    async find(args) {
      const q = reconcile(args, userText);
      if (!q.ok) return { ok: false, error: q.error };
      asked.push({ object: q.object, color: q.color, position: q.position });
      const w = WORLD[SYNONYMS[q.object] || q.object];
      let intervals = [];
      if (w) {
        // a colour / position that the user wrote and the world does not have finds nothing (as the real scan would for a wrong guess)
        const bad = w.needs && ((q.color && w.needs.color && q.color !== w.needs.color) || (q.position && w.needs.position && q.position !== w.needs.position));
        const s0 = ops.parseTime(args.start);
        const e0 = ops.parseTime(args.end);
        if (!bad) {
          intervals = w.intervals
            .map(([a, b]) => ({ start: Math.max(a, Number.isFinite(s0) ? s0 : 0), end: Math.min(b, Number.isFinite(e0) ? e0 : 1e9), box: w.box }))
            .filter((iv) => iv.end - iv.start > 0.5);
        }
      }
      return { ok: true, phrase: q.phrase, object: q.object, color: q.color, position: q.position, intervals, frames: 50, step: 2, seconds: 1 };
    },
  };
}
const zoomed = (s) => !!s && (s.zoomFrom > 1.05 || s.zoomTo > 1.05);
const untouched = (r) => !r.changed;
const VISION = [
  { id: 'V1', en: 'Zoom in on the dog', tr: 'Köpeği yakınlaştır', ok: (r) => checkSpec(r.segments, D, [{ r: [10, 20], is: zoomed }, { r: [60, 65], is: zoomed }], 1.2) },
  { id: 'V2', en: 'Cut the parts with the red car', tr: 'Kırmızı arabanın olduğu yeri kes', ok: (r, p) => checkSpec(r.segments, D, [{ r: [30, 40], is: IS.removed }], 0.8) && p.asked.some((a) => a.object === 'car' && a.color === 'red') },
  { id: 'V3', en: 'Speed up the parts where the cat appears 3x', tr: 'Kedinin göründüğü yerleri 3 kat hızlandır', ok: (r) => checkSpec(r.segments, D, [{ r: [45, 55], is: IS.speed(3) }], 0.8) },
  { id: 'V4', en: 'Keep only the parts with people', tr: 'Sadece insanların olduğu kısımlar kalsın', ok: (r) => checkSpec(r.segments, D, [{ r: [0, 5], is: IS.removed }, { r: [15, 50], is: IS.removed }, { r: [60, 100], is: IS.removed }], 0.8, (s) => normal(s)) && Math.abs(total(r.segments) - 20) < 1 },
  { id: 'V5', en: 'Zoom in on the person on the left', tr: 'Soldaki kişiye zoom yap', ok: (r, p) => checkSpec(r.segments, D, [{ r: [5, 15], is: zoomed }, { r: [50, 60], is: zoomed }], 1.2) && p.asked.some((a) => a.position === 'left') },
  { id: 'V6', en: 'Zoom in on the unicorn', tr: 'Tek boynuzlu atı yakınlaştır', ok: untouched },
  { id: 'V7', en: 'Cut the part from 0:10 to 0:20', tr: '0:10 ile 0:20 arasını kes', ok: (r, p) => checkSpec(r.segments, D, [{ r: [10, 20], is: IS.removed }], 0.8) && p.asked.length === 0 },
  { id: 'V8', en: 'Slow down the dog parts to half speed and cut the first 5 seconds', tr: 'Köpeğin olduğu yerleri yarı hıza düşür ve ilk 5 saniyeyi kes', ok: (r) => checkSpec(r.segments, D, [{ r: [0, 5], is: IS.removed }, { r: [10, 20], is: IS.speed(0.5) }, { r: [60, 65], is: IS.speed(0.5) }], 0.8) },
  { id: 'V9', en: 'Mute the part where the dog barks', tr: 'Köpeğin havladığı yerin sesini kapat', ok: (r) => !r.changed || /visible|appear|seen|görül|görün/i.test(r.message) }, // either leaves it alone or says honestly that it went by what is VISIBLE
  { id: 'V10', en: 'Add a 2 second fade out at the end', tr: 'Sona 2 saniyelik kararma ekle', ok: (r, p) => { const l = r.segments[r.segments.length - 1]; return r.changed && !!l && eps(l.fadeOut, 2, 0.3) && p.asked.length === 0; } },
  { id: 'V11', en: 'Delete the parts with the cat', tr: 'Kedinin olduğu kısımları sil', ok: (r) => checkSpec(r.segments, D, [{ r: [45, 55], is: IS.removed }], 0.8) },
  { id: 'V12', en: 'Zoom in on the dog only in the first minute', tr: 'Köpeği sadece ilk dakikada yakınlaştır', ok: (r) => checkSpec(r.segments, D, [{ r: [10, 20], is: zoomed }, { r: [60, 65], is: (s) => !s || !zoomed(s) }], 1.2) },
  // nouns the model has to translate (it once turned "zürafa" into "zebra")
  { id: 'V13', en: 'Zoom in on the giraffe', tr: 'Zürafayı yakınlaştır', ok: (r, p) => checkSpec(r.segments, D, [{ r: [20, 28], is: zoomed }], 1.2) && p.asked.some((a) => a.object === 'giraffe') },
  { id: 'V14', en: 'Cut the parts with the horse', tr: 'Atın olduğu yerleri kes', ok: (r, p) => checkSpec(r.segments, D, [{ r: [70, 80], is: IS.removed }], 0.8) && p.asked.some((a) => a.object === 'horse') },
];

(async () => {
  console.log(`Bench  url=${URL_BASE}  model=${MODEL}  sets=${SETS}  langs=${LANGS}  prompt=${FULL_PROMPT ? 'full' : 'compact'}\n`);
  const real = createProvider({ kind: 'local', baseUrl: URL_BASE, model: MODEL, apiKey: API_KEY, fetch: globalThis.fetch, timeoutMs: 600000 });
  const jobs = [];
  if (SETS.includes('core')) CORE.forEach((c) => LANGS.forEach((l) => jobs.push({ set: 'core', lang: l, c, snap: mkSnapshot(D), provider: real })));
  if (SETS.includes('vision')) VISION.forEach((c) => LANGS.forEach((l) => jobs.push({ set: 'vision', lang: l, c, snap: mkSnapshot(D), provider: real, vision: true })));
  if (SETS.includes('facts')) FACT_CASES.forEach((c) => LANGS.forEach((l) => jobs.push({ set: 'facts', lang: l, c, snap: mkSnapshot(FD), provider: withFacts(real, FACTS) })));
  if (SETS.includes('facts-iv')) FACT_CASES.forEach((c) => LANGS.forEach((l) => jobs.push({ set: 'facts-iv', lang: l, c, snap: mkSnapshot(FD), provider: withFacts(real, FACTS_IV) })));
  if (SETS.includes('facts-ref')) FACT_CASES.forEach((c) => LANGS.forEach((l) => jobs.push({ set: 'facts-ref', lang: l, c, snap: mkSnapshot(FD), provider: withStates(real) })));
  const rows = [];
  for (const j of jobs) {
    if (ONLY.length && !ONLY.includes(j.c.id)) continue;
    const t0 = Date.now();
    let r;
    const prompt = j.c[j.lang];
    const perception = j.vision ? cannedPerception(prompt) : undefined;
    try { r = await runAgent({ provider: j.provider, prompt, snapshot: j.snap, lang: j.lang, compact: FULL_PROMPT ? false : undefined, perception }); } catch (e) { r = { ok: false, error: { code: 'THROWN', message: String(e && e.message) } }; }
    const secs = (Date.now() - t0) / 1000;
    let pass = false;
    try { pass = !!(r.ok && j.c.ok(r, perception)); } catch (e) { pass = false; }
    rows.push({ set: j.set, id: j.c.id, lang: j.lang, pass, secs: Number(secs.toFixed(1)), tokIn: r.usage ? r.usage.input : 0, tokOut: r.usage ? r.usage.output : 0, toolCalls: r.toolCalls || 0, error: r.ok ? '' : (r.error && r.error.code) || '' });
    console.log(`${j.c.id} [${j.lang}] ${pass ? 'PASS' : 'FAIL'}  ${secs.toFixed(1)}s  in=${r.usage ? r.usage.input : '-'} out=${r.usage ? r.usage.output : '-'}  "${prompt}"`);
    if (!pass) console.log(`     ${r.ok ? 'timeline: ' + fmt(r.segments) + (perception ? ' | asked: ' + JSON.stringify(perception.asked) : '') + ' | reply: ' + String(r.message).replace(/\s+/g, ' ').slice(0, 140) : 'ERROR ' + r.error.code + ' ' + (r.error.message || '')}`);
  }
  const sum = (set, lang) => { const x = rows.filter((q) => q.set === set && (!lang || q.lang === lang)); return { pass: x.filter((q) => q.pass).length, n: x.length }; };
  const lines = [];
  for (const set of SETS) for (const l of LANGS) { const s = sum(set, l); lines.push(`${set}/${l}: ${s.pass}/${s.n}`); }
  const avg = (k) => rows.length ? rows.reduce((a, q) => a + q[k], 0) / rows.length : 0;
  console.log(`\n==== bench: ${lines.join('  ')}  | avg ${avg('secs').toFixed(1)} s/command, ${avg('tokIn').toFixed(0)} prompt + ${avg('tokOut').toFixed(0)} output tokens ====`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, url: URL_BASE, rows }, null, 1));
  process.exit(0);
})().catch((e) => { console.error('BENCH FAILED', e); process.exit(1); });
