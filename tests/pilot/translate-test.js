'use strict';
// Can the small local LLM turn what the user says about an object/part (Turkish or English) into the short ENGLISH phrase that CLIP / YOLOX / a VLM understand?
// This is the "brain -> perception" hand-over of the v3 design (find_in_video(query)).  Text only; no image.  Free-text, lenient scoring (see translate-test2.js for the strict one).
//   node translate-test.js <port> <label>
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]);
const LABEL = process.argv[3] || 'llm';
const OUTDIR = path.join(__dirname, 'work', 'vlm');
fs.mkdirSync(OUTDIR, { recursive: true });

// [command, [ [all-of regex strings], ... any group may match ] ]
const CASES = [
  ['Köpeği yakınlaştır', [['dog']]],
  ['Arabalar göründüğü yerleri hızlandır', [['car']]],
  ['Kırmızı arabanın olduğu kısmı kes', [['red', 'car']]],
  ['Adam bisiklete bindiği sahneyi yavaşlat', [['cycl'], ['man', 'bicycle'], ['man', 'bike'], ['person', 'bicycle'], ['person', 'bike']]],
  ['Kuşların uçtuğu kısma zoom yap', [['bird']]],
  ['Sağdaki köpeğe zoom yap', [['dog', 'right']]],
  ['Soldaki arabayı yakınlaştır', [['car', 'left']]],
  ['Kırmızı sırt çantasının göründüğü yerde yavaşla', [['red', 'backpack']]],
  ['Şapkalı kadın çıkınca hızlandır', [['woman', 'hat']]],
  ['Güneş gözlüklü adamı yakınlaştır', [['man', 'sunglasses']]],
  ['Mavi tişörtlü çocuğun olduğu bölümü sil', [['blue', 'shirt', '(boy|child|kid)']]],
  ['Sarı taksiyi takip et ve yakınlaştır', [['yellow', '(taxi|cab)']]],
  ['Denizdeki tekneyi yakınlaştır', [['boat']]],
  ['Masadaki dizüstü bilgisayarı yakınlaştır', [['laptop']]],
  ['Bebek göründüğünde yavaşlat', [['baby']]],
  ['Uçak havalandığı anı yavaşlat', [['(airplane|plane|aircraft)']]],
  ['Kedi çıkınca kes', [['cat']]],
  ['Kahverengi atın koştuğu yeri hızlandır', [['brown', 'horse']]],
  ['Ekranda hata mesajı belirince yakınlaştır', [['error']]],
  ['Çocuk gülünce yakınlaştır', [['(child|kid|boy|girl)']]],
  ['Zoom in on the dog', [['dog']]],
  ['Speed up the part where the red car appears', [['red', 'car']]],
  ['Slow down when the man on the right waves', [['man', 'right']]],
  ['Cut out the scene with the bicycle', [['bicycle']]],
];

const SYSTEM = 'You help a video editor. The user refers to something that is visible in the video. Reply with ONLY a short English phrase (2-6 words, lowercase, no quotes, no punctuation) describing what a computer-vision model should look for in the frames. Keep colours, positions (left/right) and attributes. Do not describe the editing action.';

(async () => {
  console.log('=== query hand-over test: ' + LABEL + ' (' + CASES.length + ' commands)');
  let ok = 0; let secs = 0; const rows = [];
  for (const [cmd, alts] of CASES) {
    const t0 = Date.now();
    const res = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', temperature: 0, max_tokens: 24, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: cmd }] }) });
    const j = await res.json();
    const s = (Date.now() - t0) / 1000; secs += s;
    const out = String((j.choices && j.choices[0].message.content) || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const pass = alts.some((g) => g.every((re) => new RegExp(re, 'i').test(out)));
    if (pass) ok++;
    rows.push({ cmd, out, pass, secs: s });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${s.toFixed(1)} s  "${cmd}"  ->  "${out}"`);
  }
  console.log(`\n  HAND-OVER: ${ok}/${CASES.length} correct (TR ${rows.slice(0, 20).filter((r) => r.pass).length}/20, EN ${rows.slice(20).filter((r) => r.pass).length}/4), avg ${(secs / CASES.length).toFixed(1)} s`);
  fs.writeFileSync(path.join(OUTDIR, LABEL + '.translate.json'), JSON.stringify({ label: LABEL, ok, n: CASES.length, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
