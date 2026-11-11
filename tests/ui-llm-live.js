'use strict';
// MANUAL live test of the one-click model download against the REAL host (huggingface.co and its CDN): it starts the download in the real app, lets
// ~25 MB arrive, cancels, resumes (Range request) for another ~15 MB, cancels again and removes the partial files. Needs internet; downloads ~40 MB.
//   node tests/ui-llm-live.js
// (The unit tests use a local server; this one exists because such a server cannot tell whether the REAL host accepts our requests - it once
// answered HTTP 400 to a "Range: bytes=-1-" header that only a fresh download sent.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { step, assert, summary, ud } = require('./ui-helpers');

const MB = 1048576;
const DIR = path.join(os.tmpdir(), 've-live-dl');

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const app = await launch({ userData: ud('llm-live'), port: 9442 });
  const ev = (expr) => app.evaluate(expr);
  const model = async () => (await ev('window.api.llm.status()')).model;
  const partSize = () => {
    const d = path.join(DIR, 'qwen3.5-4b');
    if (!fs.existsSync(d)) return 0;
    return fs.readdirSync(d).filter((n) => n.endsWith('.part')).reduce((s, n) => s + fs.statSync(path.join(d, n)).size, 0);
  };
  async function runUntil(minBytes, label) {
    await ev('(window.__dlDone = false, window.__dl = window.api.llm.install().then((r) => { window.__dlDone = true; return r; }), 0)');
    const t0 = Date.now();
    let have = 0;
    while (Date.now() - t0 < 120000) {
      have = partSize();
      if (have >= minBytes) break;
      const done = await ev('window.__dlDone === true');
      if (done) break;
      await sleep(500);
    }
    const secs = (Date.now() - t0) / 1000;
    await ev('window.api.llm.cancel()');
    const res = await ev('window.__dl.then((r) => ({ ok: r.ok, code: r.error && r.error.code, detail: r.error && r.error.detail }))');
    console.log(`      ${label}: ${(have / MB).toFixed(1)} MB on disk after ${secs.toFixed(1)} s (${(have / MB / Math.max(secs, 0.1)).toFixed(1)} MB/s), result ${JSON.stringify(res)}`);
    return { have, res };
  }

  try {
    await step('H01 the real model folder is a temp folder; nothing is downloaded before the click', async () => {
      const r = await ev(`window.api.llm.set({ modelDir: ${JSON.stringify(DIR)} })`);
      assert(r.ok, JSON.stringify(r));
      const m = await model();
      assert(m.state === 'missing', m.state);
      assert(partSize() === 0, 'files appeared without a click');
    });

    let first = 0;
    await step('H02 a fresh download starts on the real host (no malformed Range header), data arrives, cancel keeps the partial file', async () => {
      const r = await runUntil(25 * MB, 'first run');
      first = r.have;
      assert(r.have >= 25 * MB, 'only ' + r.have + ' bytes arrived: ' + JSON.stringify(r.res));
      assert(r.res.ok === false && r.res.code === 'ABORTED', JSON.stringify(r.res));
      const m = await model();
      assert(m.state === 'partial', m.state);
    });

    await step('H03 resuming continues from the bytes on disk (Range request accepted by the real host)', async () => {
      const r = await runUntil(first + 15 * MB, 'second run');
      assert(r.have >= first + 15 * MB, 'the download did not continue: ' + r.have + ' bytes, first run ' + first + ' ' + JSON.stringify(r.res));
      assert(r.res.code === 'ABORTED', JSON.stringify(r.res));
    });

    await step('H04 removing the model deletes the partial files', async () => {
      const r = await ev('window.api.llm.remove()');
      assert(r.ok, JSON.stringify(r));
      assert(partSize() === 0, 'partial files left');
    });

    await step('H05 no script or console errors', async () => {
      assert(app.errors.length === 0, app.errors.join(' | '));
    });
  } finally {
    await app.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  const failed = summary('ui-llm-live');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ui-llm-live crashed:', e); process.exit(2); });
