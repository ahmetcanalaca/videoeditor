'use strict';
// Turns the DOM ground truth of a rec-main.js run into truth.json: the intervals in which the Stop button existed (= "AI working"), the Enter presses, typing/scroll events.
//   node truth.js <runDir>
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2]);
const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const segs = []; let cur = null;
m.frames.forEach((f) => { if (f.gen && !cur) cur = { a: f.t }; if (!f.gen && cur) { cur.b = f.t; segs.push(cur); cur = null; } });
if (cur) { cur.b = m.frames[m.frames.length - 1].t; segs.push(cur); }
console.log('GROUND TRUTH "AI is working" (Stop button present) intervals:');
segs.forEach((s) => console.log('  ' + s.a.toFixed(2) + ' -> ' + s.b.toFixed(2) + '  (' + (s.b - s.a).toFixed(1) + ' s)'));
const enters = m.events.filter((e) => e.kind === 'enter').map((e) => e.t);
console.log('Enter pressed at: ' + enters.join(', '));
console.log('lag Enter -> Stop button appears: ' + segs.map((s, i) => (s.a - enters[i]).toFixed(2)).join(', ') + ' s');
fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify({ working: segs, enters, typing: m.events.filter((e) => /typing|scroll/.test(e.kind)) }));
