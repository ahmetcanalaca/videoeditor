'use strict';
// MANUAL end-to-end trial (not part of `npm test`): the real app (UI -> IPC -> isolated network session -> a REAL local model server -> edit
// engine -> timeline). Needs a running local model server with tool calling, see tests/local-llm-trial.js.
//   set VE_LOCAL_URL=http://127.0.0.1:18080/v1 & set VE_LOCAL_MODEL=qwen2.5-3b & node tests\ui-local-real.js
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, ud, h } = require('./ui-helpers');

const URL_BASE = process.env.VE_LOCAL_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.VE_LOCAL_MODEL || 'qwen2.5:3b';
const SHOTS = path.join(OUT, 'shots');

(async () => {
  const fx = h.makeFixtures();
  const app = await launch({ userData: ud('ailocalreal'), files: [fx.A, fx.B], port: 9441 });
  const ev = (expr) => app.evaluate(expr);
  let failed = 0;
  const check = (name, cond, info) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (info ? '  ' + info : '')); if (!cond) failed++; };
  try {
    await app.waitFor("VE.state.S.segments.length === 2 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import');
    await sleep(300);
    const saved = await ev(`window.api.ai.save({ provider: 'local', baseUrl: ${JSON.stringify(URL_BASE)}, model: ${JSON.stringify(MODEL)}, apiVersion: '', shareNames: true, auth: 'key', apiKey: '' })`);
    check('local provider saved without a key', saved.ok && saved.status.ready && !saved.status.hasKey, JSON.stringify(saved.status));
    const test = await ev('window.api.ai.test()');
    check('connection test against the real server', test.ok && test.modelOk === true, JSON.stringify(test).slice(0, 200));
    await ev('VE.ai.refresh()');
    await ev('VE.ai.open()');
    await sleep(400);
    const total0 = await ev('VE.state.layout().total');
    const prompt = 'İlk 2 saniyeyi kes, 4 ile 6. saniye arasını 2 kat hızlandır';
    const before = (await ev('VE.ai.debug()')).messages.length;
    const t0 = Date.now();
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + 2}; })()`, 240000, 'reply from the real local model');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const dbg = await ev('VE.ai.debug()');
    const last = dbg.messages[dbg.messages.length - 1];
    const segs = await ev('VE.state.S.segments.map((s) => ({ in: +s.in.toFixed(2), out: +s.out.toFixed(2), speed: s.speed }))');
    const total1 = await ev('VE.state.layout().total');
    console.log(`reply after ${secs}s: ${JSON.stringify(last).slice(0, 400)}`);
    console.log('segments:', JSON.stringify(segs), ' total', total0, '->', total1);
    check('the real model answered with an applied edit (not an error)', last.type === 'ai' && last.actions && last.actions.length >= 1, last.type);
    check('the timeline changed as ONE undo step', total1 < total0 - 0.5, `${total0} -> ${total1}`);
    await app.screenshot(path.join(SHOTS, 'tr-dark-ai-local-real-model.png'));
    await ev('VE.actions.undo()');
    await sleep(250);
    check('one Ctrl+Z restores the project', Math.abs((await ev('VE.state.layout().total')) - total0) < 0.01);
    console.log('errors:', JSON.stringify(app.errors));
    check('no script/console errors', app.errors.length === 0);
  } finally {
    await app.close();
  }
  console.log(failed ? `==== ui-local-real: ${failed} FAILED ====` : '==== ui-local-real: all passed ====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('UI-LOCAL-REAL FAILED', e); process.exit(1); });
