'use strict';
// MANUAL experiment: does the time of a vision question grow while many different pictures are asked about (prompt-cache / memory effects of the
// llama-server)? Sends N probes about different frames of a film and prints the time per call in blocks of 10.
//   node tests/pilot/vlm-drift.js [--film=car] [--n=60] [--side=512] [--phrase=car]
const fs = require('fs');
const path = require('path');
const { createVlm } = require('../../src/main/perception/vlm');
const { createFrameSource, createTimeMap } = require('../../src/main/perception/frames');
const H = require('../helpers');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const film = path.join(__dirname, '..', 'out', 'e2e-films', arg('film', 'car') + '.mp4');
const N = Number(arg('n', 60));
const SIDE = Number(arg('side', 512));
const PHRASE = arg('phrase', 'car');

(async () => {
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', 'llm-serve.json'), 'utf8'));
  const chat = async (body) => {
    const res = await fetch(info.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + info.key }, body: JSON.stringify(body) });
    return res.json();
  };
  const vlm = createVlm({ boxFormat: 'k1000', chat });
  const total = 51;
  const frame = createFrameSource({ ffmpegPath: H.bins.ffmpeg, timeMap: createTimeMap([{ b0: 0, b1: total, file: film, in: 0, speed: 1 }]), sides: { probe: SIDE } });
  const times = [];
  let tm = 0;
  for (let i = 0; i < N; i++) {
    const f = await frame(((i * 1.7) % (total - 1)) + 0.3, 'probe');
    const t0 = Date.now();
    const raw = await chat({ model: 'x', temperature: 0, max_tokens: 6, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + f.jpeg.toString('base64') } }, { type: 'text', text: 'Is there a ' + PHRASE + ' in this image? Answer with one word: YES or NO.' }] }] });
    const ms = Date.now() - t0;
    times.push(ms);
    tm += ms;
    if ((i + 1) % 10 === 0) {
      const last = times.slice(-10);
      console.log(`calls ${i - 8}-${i + 1}: mean ${(last.reduce((a, b) => a + b, 0) / 10 / 1000).toFixed(2)} s  (prompt tokens ${raw.usage && raw.usage.prompt_tokens}, timings ${raw.timings ? 'pp ' + Math.round(raw.timings.prompt_per_second) + ' t/s, cache_n ' + raw.timings.cache_n : '-'})`);
    }
  }
  void vlm;
  console.log(`total ${(tm / 1000).toFixed(1)} s for ${N} calls`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
