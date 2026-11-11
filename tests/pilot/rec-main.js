'use strict';
// Records a REAL AI chat UI (llama.cpp WebUI on a local model) like a screen recorder would, with GROUND TRUTH:
//   - frames: Electron capturePage() polled as fast as possible, each frame timestamped
//   - truth : the DOM tells whether the "Stop generation" button exists (= the AI is working) at every captured frame
//   - events: typing start/end, Enter pressed, scrolling, idle periods (known to the script)
// Scenario: idle -> type prompt 1 -> Enter -> AI works -> idle -> user scrolls the answer -> idle -> type prompt 2 -> Enter -> AI works -> idle.
//   npx electron rec-main.js --out=rec\run1 --url=http://127.0.0.1:18090/
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const URL_ = arg('url', 'http://127.0.0.1:18090/');
const OUT = path.resolve(arg('out', path.join(__dirname, 'rec', 'run1')));
const W = Number(arg('w', '1280'));
const H = Number(arg('h', '720'));
const P1 = arg('p1', 'Explain how binary search works in about 300 words and give a short Python example.');
const P2 = arg('p2', 'Now explain its time complexity in two short paragraphs.');
const MAXWAIT = Number(arg('maxwait', '120')) * 1000;
const THEME = arg('theme', '');
const IFRAME = arg('iframe', '0') === '1';
const IFRAME_X = Number(arg('iframex', '760'));
const IFRAME_Y = Number(arg('iframey', '0'));
const SCROLLX = Number(arg('scrollx', IFRAME ? '1000' : '700'));

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 've-rec-ud-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = `(() => { const s = document.querySelector('.stop-button, button[aria-label="Stop generation"]'); const ta = document.querySelector('textarea'); const sb = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Stop'); const r = sb ? sb.getBoundingClientRect() : null; return { gen: !!s, text: ta ? ta.value.length : -1, rect: r ? [r.x, r.y, r.width, r.height] : null }; })()`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, frame: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  await win.loadURL(URL_);
  await sleep(IFRAME ? 3500 : 2000);
  // the chat UI lives either in the page itself or in the first iframe (side panel layout)
  const target = () => (IFRAME ? wc.mainFrame.frames[0] : wc.mainFrame);
  if (THEME) await wc.executeJavaScript(`document.documentElement.classList.${THEME === 'dark' ? 'add' : 'remove'}('dark'); 0`);
  await target().executeJavaScript(`(document.querySelector('textarea')||{focus(){}}).focus(); 0`);

  const frames = [];
  const events = [];
  const pending = [];
  let running = true;
  const T0 = performance.now();
  const now = () => (performance.now() - T0) / 1000;
  const ev = (kind, extra) => { events.push(Object.assign({ t: Number(now().toFixed(3)), kind }, extra || {})); };

  const loop = (async () => {
    let i = 0;
    while (running) {
      const t0 = now();
      const [img, st] = await Promise.all([wc.capturePage(), target().executeJavaScript(STATE)]);
      const t1 = now();
      const n = ++i;
      const buf = img.toJPEG(88);
      pending.push(fs.promises.writeFile(path.join(OUT, 'f' + String(n).padStart(5, '0') + '.jpg'), buf));
      frames.push({ i: n, t: Number(((t0 + t1) / 2).toFixed(3)), gen: st.gen, text: st.text, rect: st.rect });
    }
  })();

  const type = async (text) => {
    ev('typing_start');
    for (const ch of text) {
      await wc.insertText(ch);
      await sleep(55 + Math.random() * 75);
    }
    ev('typing_end');
  };
  const submit = async () => {
    await sleep(700);
    ev('enter');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  };
  const waitDone = async () => {
    const t0 = performance.now();
    let seen = false;
    let idleSince = null;
    while (performance.now() - t0 < MAXWAIT) {
      await sleep(100);
      const last = frames[frames.length - 1];
      if (!last) continue;
      if (last.gen) { seen = true; idleSince = null; } else if (seen) { idleSince = idleSince || now(); if (now() - idleSince > 0.6) return; }
    }
    ev('timeout');
  };
  const scroll = async (secs) => {
    ev('scroll_start');
    const t0 = now();
    let dir = -1;
    while (now() - t0 < secs) {
      wc.sendInputEvent({ type: 'mouseWheel', x: SCROLLX, y: 300, deltaX: 0, deltaY: dir * 120, canScroll: true });
      await sleep(90);
      if (now() - t0 > secs / 2) dir = 1;
    }
    ev('scroll_end');
  };

  ev('start');
  await sleep(3000);
  await type(P1);
  await submit();
  await waitDone();
  ev('answer1_done_by_script');
  await sleep(2500);
  await scroll(3.0);
  await sleep(2500);
  await type(P2);
  await submit();
  await waitDone();
  ev('answer2_done_by_script');
  await sleep(3500);
  ev('end');
  running = false;
  await loop;
  await Promise.all(pending);
  // where the "Stop" button is in PAGE coordinates (what a user would draw on the preview): median of the rectangles seen while it existed
  const rects = frames.filter((f) => f.rect).map((f) => f.rect);
  let stopRect = null;
  if (rects.length) {
    const med = (k) => rects.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rects.length / 2)];
    stopRect = [Math.round(med(0) + (IFRAME ? IFRAME_X : 0)), Math.round(med(1) + (IFRAME ? IFRAME_Y : 0)), Math.round(med(2)), Math.round(med(3))];
  }
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ W, H, url: URL_, iframe: IFRAME, stopRect, frames, events }, null, 0));
  const dur = frames[frames.length - 1].t;
  console.log(`recorded ${frames.length} frames in ${dur.toFixed(1)} s (${(frames.length / dur).toFixed(1)} fps); stop button rect (page coords) = ${JSON.stringify(stopRect)}`);
  events.forEach((e) => console.log('  ' + e.t.toFixed(2).padStart(7) + '  ' + e.kind));
  const g = frames.filter((f) => f.gen);
  console.log('frames with Stop button: ' + g.length);
  app.exit(0);
});
