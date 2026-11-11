'use strict';
// Stricter version of translate-test.js: the LLM must fill a STRUCTURED query (object / colour / position) for find_in_video.
// A case passes only if all three fields are right: no invented colour or position, nothing missing.
//   node translate-test2.js <port> <label>
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]);
const LABEL = process.argv[3] || 'llm';
const OUTDIR = path.join(__dirname, 'work', 'vlm');
fs.mkdirSync(OUTDIR, { recursive: true });

// [command, objectRegex, colour|null, position|null]
const CASES = [
  ['Köpeği yakınlaştır', 'dog', null, null],
  ['Arabalar göründüğü yerleri hızlandır', 'car', null, null],
  ['Kırmızı arabanın olduğu kısmı kes', 'car', 'red', null],
  ['Adam bisiklete bindiği sahneyi yavaşlat', 'cycl|bicycle|bike', null, null],
  ['Kuşların uçtuğu kısma zoom yap', 'bird', null, null],
  ['Sağdaki köpeğe zoom yap', 'dog', null, 'right'],
  ['Soldaki arabayı yakınlaştır', 'car', null, 'left'],
  ['Kırmızı sırt çantasının göründüğü yerde yavaşla', 'backpack', 'red', null],
  ['Şapkalı kadın çıkınca hızlandır', 'woman.*hat|hat.*woman', null, null],
  ['Güneş gözlüklü adamı yakınlaştır', 'man.*sunglass|sunglass.*man', null, null],
  ['Mavi tişörtlü çocuğun olduğu bölümü sil', 'child|kid|boy', 'blue', null],
  ['Sarı taksiyi takip et ve yakınlaştır', 'taxi|cab', 'yellow', null],
  ['Denizdeki tekneyi yakınlaştır', 'boat', null, null],
  ['Masadaki dizüstü bilgisayarı yakınlaştır', 'laptop', null, null],
  ['Bebek göründüğünde yavaşlat', 'baby', null, null],
  ['Uçak havalandığı anı yavaşlat', 'airplane|plane|aircraft', null, null],
  ['Kedi çıkınca kes', 'cat', null, null],
  ['Kahverengi atın koştuğu yeri hızlandır', 'horse', 'brown', null],
  ['Ekranda hata mesajı belirince yakınlaştır', 'error', null, null],
  ['Çocuk gülünce yakınlaştır', 'child|kid|boy|girl', null, null],
  ['Zoom in on the dog', 'dog', null, null],
  ['Speed up the part where the red car appears', 'car', 'red', null],
  ['Slow down when the man on the right waves', 'man', null, 'right'],
  ['Cut out the scene with the bicycle', 'bicycle|bike', null, null],
];

const SYSTEM = 'You help a video editor. The user (Turkish or English) refers to something that is visible in the video. Output ONLY one JSON object: {"object": "<short English noun phrase, no colour, no position, no action>", "color": "<English colour word the user said, or null>", "position": "<left|right|top|bottom|center, only if the user said it, otherwise null>"}. Never invent a colour or a position the user did not say. Do not include the editing action.';

(async () => {
  console.log('=== structured query hand-over: ' + LABEL + ' (' + CASES.length + ' commands)');
  let ok = 0; const rows = [];
  for (const [cmd, objRe, color, pos] of CASES) {
    const res = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', temperature: 0, max_tokens: 60, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: cmd }] }) });
    const j = await res.json();
    const text = String((j.choices && j.choices[0].message.content) || '');
    let q = null; const m = /\{[\s\S]*\}/.exec(text);
    try { q = m ? JSON.parse(m[0]) : null; } catch (e) { q = null; }
    const norm = (v) => (v == null || /^(null|none|)$/i.test(String(v).trim()) ? null : String(v).trim().toLowerCase());
    const o = q ? String(q.object || '').toLowerCase() : '';
    const okObj = new RegExp(objRe, 'i').test(o);
    const okCol = q ? norm(q.color) === color : false;
    const okPos = q ? norm(q.position) === pos : false;
    const pass = okObj && okCol && okPos;
    if (pass) ok++;
    rows.push({ cmd, got: q, pass, okObj, okCol, okPos });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  "${cmd}"  ->  ${q ? JSON.stringify(q) : text.slice(0, 80)}${pass ? '' : '   [object ' + (okObj ? 'ok' : 'WRONG') + ', colour ' + (okCol ? 'ok' : 'WRONG') + ', position ' + (okPos ? 'ok' : 'WRONG') + ']'}`);
  }
  const tr = rows.slice(0, 20).filter((r) => r.pass).length; const en = rows.slice(20).filter((r) => r.pass).length;
  console.log(`\n  STRUCTURED HAND-OVER: ${ok}/${CASES.length} fully correct (TR ${tr}/20, EN ${en}/4)`);
  fs.writeFileSync(path.join(OUTDIR, LABEL + '.translate2.json'), JSON.stringify({ label: LABEL, ok, n: CASES.length, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
