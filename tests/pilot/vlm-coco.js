'use strict';
// Local vision-language model on NATURAL photos (COCO val2017 subset from fetch_coco_vlm.py):
//   ground : "where is the <class>?"        -> box (IoU >= 0.5 and centre-inside counted)
//   absent : same question, class NOT there -> must answer "none"
//   pos/neg: "is there a <class>?" YES/NO   -> recall / specificity
// Bounding-box convention of the model is not assumed: pixels, 0-1000, 0-1 and the y-first variants are all scored; the best one overall is the model's native convention.
//   node vlm-coco.js <port> <label> [maxPerKind]
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'coco_vlm');
const OUTDIR = path.join(__dirname, 'work', 'vlm');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = Number(process.argv[2]);
const LABEL = process.argv[3] || 'vlm';
const PER_KIND = Number(process.argv[4] || 999);
const tasks = JSON.parse(fs.readFileSync(path.join(DIR, 'tasks.json'), 'utf8'));

async function ask(file, prompt, maxTokens) {
  const img = fs.readFileSync(path.join(DIR, file));
  const body = { model: 'x', temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img.toString('base64') } }, { type: 'text', text: prompt }] }] };
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  const secs = (Date.now() - t0) / 1000;
  if (!j.choices) return { text: 'ERROR ' + JSON.stringify(j).slice(0, 200), secs, tokensIn: 0 };
  const m = j.choices[0].message;
  return { text: String(m.content || '').trim(), secs, tokensIn: j.usage ? j.usage.prompt_tokens : 0, tokensOut: j.usage ? j.usage.completion_tokens : 0, ppsec: j.timings ? j.timings.prompt_per_second : 0, gen: j.timings ? j.timings.predicted_per_second : 0 };
}

const article = (c) => (/^[aeiou]/i.test(c) ? 'an ' : 'a ') + c;
const GROUND = (c) => `Locate the ${c} in this image. Reply with only JSON in this format: [{"bbox_2d":[x1,y1,x2,y2],"label":"${c}"}]. If there is no ${c} in the image, reply with [].`;
const PRESENCE = (c) => `Is there ${article(c)} in this image? Answer with one word: YES or NO.`;

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const BOX_RE = new RegExp('\\[\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*\\]');
const parseBox = (text) => { const m = BOX_RE.exec(text); return m ? m.slice(1, 5).map(Number) : null; };
const CONV = {
  px: (b) => b,
  k1000: (b, t) => [b[0] * t.w / 1000, b[1] * t.h / 1000, b[2] * t.w / 1000, b[3] * t.h / 1000],
  unit: (b, t) => [b[0] * t.w, b[1] * t.h, b[2] * t.w, b[3] * t.h],
  k1000yx: (b, t) => [b[1] * t.w / 1000, b[0] * t.h / 1000, b[3] * t.w / 1000, b[2] * t.h / 1000],
  pxyx: (b) => [b[1], b[0], b[3], b[2]],
};
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  const u = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
};
const centreIn = (a, b) => { const cx = (a[0] + a[2]) / 2; const cy = (a[1] + a[3]) / 2; return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]; };

(async () => {
  const picked = []; const seen = {};
  for (const t of tasks) { const k = t.kind + ':' + t.cls; seen[k] = (seen[k] || 0) + 1; if (seen[k] <= PER_KIND) picked.push(t); }
  console.log('=== VLM natural photos: ' + LABEL + '  (' + picked.length + ' pictures, port ' + PORT + ')');
  const rows = [];
  for (const t of picked) {
    const isGround = t.kind === 'ground' || t.kind === 'absent';
    const r = await ask(t.file, isGround ? GROUND(t.cls) : PRESENCE(t.cls), isGround ? 120 : 8);
    const row = { kind: t.kind, cls: t.cls, file: t.file, w: t.w, h: t.h, answer: r.text.replace(/\s+/g, ' ').slice(0, 160), secs: r.secs, tokensIn: r.tokensIn, ppsec: r.ppsec, gen: r.gen };
    if (isGround) {
      const b = parseBox(r.text);
      row.box = b;
      if (t.kind === 'ground' && b) {
        row.iou = {}; row.centre = {};
        for (const [k, f] of Object.entries(CONV)) { const px = f(b, t); row.iou[k] = iou(px, t.box_px); row.centre[k] = centreIn(px, t.box_px); }
      }
    } else {
      row.said = /^\W*yes/i.test(r.text) ? true : /^\W*no/i.test(r.text) ? false : null;
      row.ok = row.said === (t.kind === 'pos');
    }
    rows.push(row);
    const brief = isGround ? (row.box ? 'box ' + row.box.map((x) => Math.round(x * 100) / 100).join(',') : 'none') : (row.said === null ? '?' : row.said ? 'YES' : 'NO') + (row.ok ? ' OK' : ' MISS');
    console.log(`  ${t.kind.padEnd(6)} ${t.cls.padEnd(7)} ${t.file}  ${brief}  ${r.secs.toFixed(1)} s (${r.tokensIn} in)`);
  }

  const g = rows.filter((r) => r.kind === 'ground');
  const conv = {};
  for (const k of Object.keys(CONV)) conv[k] = { iou: g.filter((r) => r.iou && r.iou[k] >= 0.5).length, centre: g.filter((r) => r.centre && r.centre[k]).length };
  const best = Object.keys(conv).sort((a, b) => conv[b].iou - conv[a].iou || conv[b].centre - conv[a].centre)[0];
  const abs = rows.filter((r) => r.kind === 'absent');
  const pos = rows.filter((r) => r.kind === 'pos'); const neg = rows.filter((r) => r.kind === 'neg');
  const secs = rows.map((r) => r.secs).sort((a, b) => a - b);
  const med = secs[Math.floor(secs.length / 2)];
  const mean = secs.reduce((a, b) => a + b, 0) / (secs.length || 1);
  const sum = {
    label: LABEL, pictures: rows.length,
    ground: { n: g.length, bestConvention: best, hitIoU50: conv[best] ? conv[best].iou : 0, hitCentre: conv[best] ? conv[best].centre : 0, perConvention: conv, answeredNone: g.filter((r) => !r.box).length },
    absent: { n: abs.length, correctNone: abs.filter((r) => !r.box).length, falseBoxes: abs.filter((r) => r.box).length },
    presence: { posN: pos.length, recall: pos.filter((r) => r.ok).length, negN: neg.length, specificity: neg.filter((r) => r.ok).length },
    secsPerPicture: { mean, median: med, min: secs[0], max: secs[secs.length - 1] },
    tokensPerPicture: Math.round(rows.reduce((a, r) => a + r.tokensIn, 0) / (rows.length || 1)),
    promptTokPerSec: Math.round(rows.filter((r) => r.ppsec).reduce((a, r) => a + r.ppsec, 0) / (rows.filter((r) => r.ppsec).length || 1)),
  };
  console.log('\n  GROUNDING (' + sum.ground.n + ' pictures, native box format = ' + best + '): IoU>=0.5 ' + sum.ground.hitIoU50 + '/' + sum.ground.n + ' | centre inside the object ' + sum.ground.hitCentre + '/' + sum.ground.n + ' | no box returned ' + sum.ground.answeredNone);
  console.log('  per format  ' + Object.entries(conv).map(([k, v]) => k + ': IoU ' + v.iou + ' / centre ' + v.centre).join('   '));
  console.log('  ABSENT object (hallucination check): correctly "none" ' + sum.absent.correctNone + '/' + sum.absent.n + ' | invented a box ' + sum.absent.falseBoxes);
  console.log('  PRESENCE yes/no: found when present ' + sum.presence.recall + '/' + sum.presence.posN + ' | said NO when absent ' + sum.presence.specificity + '/' + sum.presence.negN);
  console.log('  SPEED: mean ' + mean.toFixed(1) + ' s, median ' + med.toFixed(1) + ' s per picture, ' + sum.tokensPerPicture + ' prompt tokens (incl. image), prompt speed ' + sum.promptTokPerSec + ' tok/s');
  fs.writeFileSync(path.join(OUTDIR, LABEL + '.coco.json'), JSON.stringify({ summary: sum, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
