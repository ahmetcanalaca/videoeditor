'use strict';
// MANUAL UI test of the built-in model with the REAL model files and the REAL runtime (not part of `npm test`; needs ~3.4 GB of model files and a few minutes).
//   node tests/ui-llm-real.js --models=<root with qwen3.5-4b\*.gguf> [--film=dog]
// Needs the films of tests/e2e-find.js (run it once to build them). The app downloads nothing here: the model folder is set to <root>.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud } = require('./ui-helpers');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const MODELS = arg('models', '');
const FILM = path.join(__dirname, 'out', 'e2e-films', arg('film', 'dog') + '.mp4');
const TRUTH = [[4, 10], [18, 23], [26, 32], [40, 45], [50, 54]];
const SHOTS = path.join(OUT, 'shots');

(async () => {
  if (!MODELS || !fs.existsSync(path.join(MODELS, 'qwen3.5-4b'))) { console.error('usage: node tests/ui-llm-real.js --models=<folder that contains qwen3.5-4b\\...>'); process.exit(2); }
  if (!fs.existsSync(FILM)) { console.error('film missing: run node tests/e2e-find.js once'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const userData = ud('llm-real');
  const app = await launch({ userData, files: [FILM], port: 9441 });
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const total = () => ev('VE.state.layout().total');
  const dbg = () => ev('VE.ai.debug()');
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  // waits for the answer and records what the live card showed
  async function answer(before, maxMs) {
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 600000)) {
      const s = await ev("(() => { const d = VE.ai.debug(); const w = document.querySelector('[data-ai=\"working\"]'); return { running: d.running, count: d.messages.length, text: w ? w.textContent : '' }; })()");
      if (s.text) seen.add(s.text.replace(/\d+/g, 'N'));
      if (!s.running && s.count >= before + 2) break;
      await sleep(300);
    }
    return { secs: (Date.now() - t0) / 1000, seen: [...seen] };
  }
  const zoomedParts = (list) => {
    // merge neighbouring zoomed pieces into parts (original time = source time: one clip, speed 1)
    const parts = [];
    list.filter((s) => s.zoomFrom > 1.02 || s.zoomTo > 1.02).forEach((s) => { const last = parts[parts.length - 1]; if (last && Math.abs(last[1] - s.in) < 0.05) last[1] = s.out; else parts.push([s.in, s.out]); });
    return parts;
  };

  try {
    await app.waitFor('VE.state.S.segments.length === 1 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)', 60000, 'import');
    const orig = await segs();
    const origTotal = await total();
    const set = await ev(`window.api.llm.set({ modelDir: ${JSON.stringify(MODELS)} })`);

    await step('R01 the real model folder is accepted; the files are verified (SHA-256) once and the assistant is ready', async () => {
      assert(set.ok && set.status.model.state === 'unverified', JSON.stringify(set.status && set.status.model.state));
      const st = await ev('window.api.ai.status()');
      assert(st.ready === true && st.vision === true, JSON.stringify({ r: st.ready, v: st.vision }));
      await ev('VE.ai.open()');
    });

    await step('R02 opening the pane verifies and starts the real model in the background (graphics chip when available)', async () => {
      const t0 = Date.now();
      await app.waitFor("window.api.llm.status().then((s) => s.server.phase === 'ready' && s.model.state === 'ready')", 180000, 'model started');
      const s = await ev('window.api.llm.status()');
      console.log('      model ready after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, running on ' + s.server.backend + (s.server.detectedGpu ? ' (' + s.server.detectedGpu.join(', ') + ')' : ''));
      assert(s.server.backend === 'vk' || s.server.backend === 'cpu', s.server.backend);
    });

    await step('R03 "Köpeği yakınlaştır": the real model examines the real photos and zooms in on the dog parts (5 of 5), one undo restores', async () => {
      const before = (await dbg()).messages.length;
      await ask('Köpeği yakınlaştır');
      const r = await answer(before);
      console.log(`      ${r.secs.toFixed(0)} s; live card: ${r.seen.join(' | ').slice(0, 300)}`);
      const msg = (await dbg()).messages.pop();
      console.log('      reply: ' + String(msg.text).replace(/\s+/g, ' ').slice(0, 200));
      assert(msg.type === 'ai' && msg.found && msg.found.length === 1, JSON.stringify(msg).slice(0, 300));
      const parts = zoomedParts(await segs());
      console.log('      zoomed parts: ' + parts.map((p) => p.map((x) => x.toFixed(1)).join('-')).join(', '));
      assert(parts.length === 5, 'parts: ' + parts.length);
      parts.forEach((p, i) => { near(p[0], TRUTH[i][0], 1.2, 'start ' + i); near(p[1], TRUTH[i][1], 1.2, 'end ' + i); });
      near(await total(), origTotal, 0.01, 'length unchanged');
      const zs = (await segs()).filter((s) => s.zoomFrom > 1.02 || s.zoomTo > 1.02);
      console.log('      focus points: ' + zs.map((s) => s.fx.toFixed(2) + ',' + s.fy.toFixed(2)).filter((x, i, a) => a.indexOf(x) === i).join('  '));
      await app.screenshot(path.join(SHOTS, 'llm-real-tr-dark-found.png'));
      await app.key('z', { ctrl: true });
      await app.waitFor('VE.state.S.segments.length === ' + orig.length, 4000, 'undo');
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'undo');
    });

    await step('R04 "Cut the parts with the dog" (English): the dog parts are removed', async () => {
      const before = (await dbg()).messages.length;
      await ask('Cut the parts with the dog');
      const r = await answer(before);
      console.log(`      ${r.secs.toFixed(0)} s`);
      const t = await total();
      console.log('      length ' + origTotal + ' -> ' + t.toFixed(1) + ' (truth: -26)');
      near(t, origTotal - 26, 3, 'removed seconds');
      await app.key('z', { ctrl: true });
      await app.waitFor('VE.state.S.segments.length === ' + orig.length, 4000, 'undo');
    });

    await step('R05 something that is not in the film: honest answer, nothing changes', async () => {
      const before = (await dbg()).messages.length;
      await ask('Zürafayı yakınlaştır');
      const r = await answer(before);
      const msg = (await dbg()).messages.pop();
      console.log(`      ${r.secs.toFixed(0)} s; reply: ${String(msg.text).replace(/\s+/g, ' ').slice(0, 160)}`);
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'the timeline changed');
    });

    await step('R06 stopping in the middle of a search works with the real model too', async () => {
      const before = (await dbg()).messages.length;
      await ask('Köpeği hızlandır');
      await app.waitFor("document.querySelector('[data-ai=\"search-bar\"]') !== null", 120000, 'search started');
      await sleep(2500);
      await app.click('#ai-send');
      const r = await answer(before, 60000);
      const msg = (await dbg()).messages.pop();
      console.log(`      stopped after ${r.secs.toFixed(1)} s; ${msg.type}: ${String(msg.text).slice(0, 60)}`);
      assert(msg.type === 'info', JSON.stringify(msg).slice(0, 200));
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'timeline changed after cancel');
      const st = await ev('window.api.llm.status()');
      assert(st.server.phase === 'ready', 'the model must keep running');
      // and the next request works at once
      const b2 = (await dbg()).messages.length;
      await ask('İlk 3 saniyeyi kes');
      const r2 = await answer(b2, 120000);
      console.log(`      next command after the cancel: ${r2.secs.toFixed(1)} s`);
      assert(Math.abs((await total()) - (origTotal - 3)) < 0.3, 'cut 3 s');
      await app.key('z', { ctrl: true });
    });

    await step('R07 no script or console errors', async () => {
      assert(app.errors.length === 0, app.errors.join(' | '));
    });
  } finally {
    await app.close();
  }
  const failed = summary('ui-llm-real');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ui-llm-real crashed:', e); process.exit(2); });
