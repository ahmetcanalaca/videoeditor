'use strict';
// Referring expressions on natural photos: "the <class> on the left / right side". Truth = the instance on that side (COCO boxes).
// Scores with the model's native box format given on the command line (find it with vlm-coco.js: Qwen3.5 = k1000, Gemma 4 = k1000yx).
//   node vlm-refer.js <port> <label> <px|k1000|unit|k1000yx|pxyx>
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'coco_vlm');
const OUTDIR = path.join(__dirname, 'work', 'vlm');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = Number(process.argv[2]);
const LABEL = process.argv[3] || 'vlm';
const FORMAT = process.argv[4] || 'k1000';
const tasks = JSON.parse(fs.readFileSync(path.join(DIR, 'tasks_refer.json'), 'utf8'));

async function ask(file, prompt, maxTokens) {
  const img = fs.readFileSync(path.join(DIR, file));
  const body = { model: 'x', temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img.toString('base64') } }, { type: 'text', text: prompt }] }] };
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  const secs = (Date.now() - t0) / 1000;
  if (!j.choices) return { text: 'ERROR ' + JSON.stringify(j).slice(0, 200), secs };
  return { text: String(j.choices[0].message.content || '').trim(), secs };
}

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const BOX_RE = new RegExp('\\[\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*\\]');
const parseBox = (text) => { const m = BOX_RE.exec(text); return m ? m.slice(1, 5).map(Number) : null; };
const CONV = {
  px: (b) => b,
  k1000: (b, t) => [b[0] * t.w / 1000, b[1] * t.h / 1000, b[2] * t.w / 1000, b[3] * t.h / 1000],
  unit: (b, t) => [b[0] * t.w, b[1] * t.h, b[2] * t.w, b[3] * t.h],
  k1000yx: (b, t) => [b[1] * t.w / 1000, b[0] * t.h / 1000, b[3] * t.w / 1000, b[2] * t.h / 1000],
  pxyx: (b) => [b[1], b[0], b[3], b[2]],
}[FORMAT];
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  const u = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
};
const centreIn = (a, b) => { const cx = (a[0] + a[2]) / 2; const cy = (a[1] + a[3]) / 2; return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]; };

(async () => {
  console.log('=== VLM referring expressions: ' + LABEL + ' (' + tasks.length + ' questions, format ' + FORMAT + ')');
  const rows = [];
  for (const t of tasks) {
    const prompt = `Locate the ${t.cls} on the ${t.side} side of the image. Reply with only JSON in this format: [{"bbox_2d":[x1,y1,x2,y2],"label":"${t.cls}"}]. If there is none, reply with [].`;
    const r = await ask(t.file, prompt, 120);
    const b = parseBox(r.text);
    const px = b ? CONV(b, t) : null;
    const row = { file: t.file, cls: t.cls, side: t.side, box: b, iou: px ? iou(px, t.box_px) : 0, centre: px ? centreIn(px, t.box_px) : false, secs: r.secs };
    rows.push(row);
    console.log(`  ${t.cls.padEnd(7)} ${t.side.padEnd(5)} ${t.file}  IoU ${row.iou.toFixed(2)}  centre ${row.centre ? 'inside' : 'OUT   '}  ${r.secs.toFixed(1)} s`);
  }
  const hit = rows.filter((r) => r.iou >= 0.5).length;
  const cen = rows.filter((r) => r.centre).length;
  console.log(`\n  REFERRING (left/right): IoU>=0.5 ${hit}/${rows.length} | centre inside the right object ${cen}/${rows.length} | mean ${(rows.reduce((a, r) => a + r.secs, 0) / rows.length).toFixed(1)} s`);
  fs.writeFileSync(path.join(OUTDIR, LABEL + '.refer.json'), JSON.stringify({ label: LABEL, format: FORMAT, hit, centre: cen, n: rows.length, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
