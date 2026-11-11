'use strict';
// Local vision-language model test on frames of the screen recording (OpenAI-compatible llama-server started with --mmproj).
//   1) STATE: "is the AI generating an answer right now?"  (ground truth: the Stop button exists in the DOM)
//   2) WHERE: "give the bounding box of the stop button"    (ground truth: the DOM rectangle of that button)
//   node vlm-test.js <video> <meta.json> <port> <label> [grounding=1]       (env VLM_ONLY_GROUND=1 skips the state part)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = require('../../src/main/ffmpeg-paths').resolveBinaries({ resourcesPath: null }).ffmpeg;
const [video, metaFile, port, label, grounding] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const PORT = Number(port);

const jpeg = (t) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { maxBuffer: 1 << 26 });
  return r.stdout;
};
const truthGen = (t) => { let best = meta.frames[0]; for (const f of meta.frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f; return best.gen; };

async function ask(img, prompt, maxTokens) {
  const body = { model: 'x', temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img.toString('base64') } }, { type: 'text', text: prompt }] }] };
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  const secs = (Date.now() - t0) / 1000;
  if (!j.choices) return { text: 'ERROR ' + JSON.stringify(j).slice(0, 200), secs, tokensIn: 0 };
  const m = j.choices[0].message;
  return { text: String(m.content || '').trim(), secs, tokensIn: j.usage ? j.usage.prompt_tokens : 0, tps: j.timings ? j.timings.prompt_per_second : 0 };
}

const STATE_PROMPT = 'This is a screenshot of a chat application with an AI assistant. Is the AI assistant generating an answer right now? Hint: while it is generating, the round send button at the bottom right of the message box is replaced by a square stop button and a spinner may be visible. Reply with only one word: YES or NO.';
const TIMES = [1.5, 7.0, 11.9, 13.0, 25, 45, 50, 52.5, 56, 63, 70, 90, 97.5];
const TRUTH_RECT = [995, 655, 1027, 687];

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
};

(async () => {
  console.log('=== VLM ' + label + ' on ' + PORT);
  let ok = 0; let n = 0; let totalSecs = 0; let tin = 0;
  for (const t of (process.env.VLM_ONLY_GROUND === '1' ? [] : TIMES)) {
    const img = jpeg(t);
    const r = await ask(img, STATE_PROMPT, 8);
    const gen = truthGen(t);
    const said = /^\W*yes/i.test(r.text) ? true : /^\W*no/i.test(r.text) ? false : null;
    const hit = said === gen;
    n++; if (hit) ok++; totalSecs += r.secs; tin = r.tokensIn;
    console.log(`  t=${String(t).padEnd(5)} truth=${gen ? 'WORKING' : 'idle   '}  model="${r.text.replace(/\s+/g, ' ').slice(0, 30)}"  ${hit ? 'OK ' : 'MISS'}  ${r.secs.toFixed(1)} s  (${r.tokensIn} prompt tokens)`);
  }
  console.log(`  STATE accuracy: ${ok}/${n}   avg ${(totalSecs / (n || 1)).toFixed(1)} s per image (${tin} prompt tokens per image)`);
  if (grounding === '1') {
    console.log('  --- WHERE is the stop button? (true rectangle 995,655-1027,687 in the 1280x720 frame; IoU>=0.5 counts as found)');
    let found = 0; let cnt = 0;
    for (const t of [13.0, 25, 45, 70, 90]) {
      const img = jpeg(t);
      const r = await ask(img, 'Find the square stop button at the bottom right of the message box. Reply only with its bounding box as JSON: {"bbox":[x1,y1,x2,y2]} in pixel coordinates of this image (width 1280, height 720).', 60);
      const bm = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/.exec(r.text);
      const nums = bm ? bm.slice(1, 5).map(Number) : [];
      let best = 0; let conv = '-';
      if (nums.length === 4) {
        const cands = { 'pixels': nums, '0-1000': [nums[0] * 1.28, nums[1] * 0.72, nums[2] * 1.28, nums[3] * 0.72], '0-1': [nums[0] * 1280, nums[1] * 720, nums[2] * 1280, nums[3] * 720] };
        for (const [k, v] of Object.entries(cands)) { const q = iou(v, TRUTH_RECT); if (q > best) { best = q; conv = k; } }
      }
      cnt++; if (best >= 0.5) found++;
      console.log(`  t=${String(t).padEnd(5)} answer="${r.text.replace(/\s+/g, ' ').slice(0, 60)}"  best IoU ${best.toFixed(2)} (${conv})  ${r.secs.toFixed(1)} s`);
    }
    console.log(`  GROUNDING: ${found}/${cnt} found with IoU>=0.5`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
