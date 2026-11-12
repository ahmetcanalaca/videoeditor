'use strict';
// UI scenario: the built-in local model in the real app (CDP).
//   - a local "model repository" (HTTP, Range, throttled, can stall, can serve a damaged file) takes the place of huggingface.co (VE_TEST_LLM_CATALOG),
//   - an in-process stand-in for llama-server (tests/helpers/fake-llm-backend.js) takes the place of the real model: it "sees" RED pixels and is scripted
//     from the words of the request, so find_in_video runs through the REAL frame extraction, scan, box handling and edit engine.
// Covers: nothing is fetched before the click, install / progress / cancel / resume / checksum failure, folder + backend settings, vision examples,
// search progress, zoom / remove / not found / cancel, GPU -> CPU fallback, restart, pre-seeded files, remove, TR/EN x dark/light screenshots.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, h } = require('./ui-helpers');

const SHOTS = path.join(OUT, 'shots');
const WORK = path.join(OUT, 'llm');
const BACKEND = path.join(__dirname, 'helpers', 'fake-llm-backend.js');
const MSGBOX = path.join(WORK, 'msgbox.log');

const bytes = (seed, n) => {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += 32) crypto.createHash('sha256').update(seed + ':' + i).digest().copy(out, i, 0, Math.min(32, n - i));
  return out;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---------------------------------------------------------------- the "model repository" */

function startRepo(files) {
  const repo = { requests: [], stallAfter: Infinity, slowMs: 4, corrupt: new Set(), server: null, url: '' };
  repo.server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].slice(1);
    const f = files[name];
    repo.requests.push({ url: req.url, range: req.headers.range || '' });
    // like the real host (Hugging Face / its CDN): a Range header that is not "bytes=<digits>-" is a 400, not "ignored"
    if (req.headers.range !== undefined && !/^bytes=\d+-\d*$/.test(req.headers.range)) { res.writeHead(400); res.end(); return; }
    if (!f) { res.writeHead(404); res.end(); return; }
    let data = f;
    if (repo.corrupt.has(name)) { data = Buffer.from(f); data[data.length >> 1] ^= 0xff; }
    const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    if (start >= data.length) { res.writeHead(416, { 'content-range': 'bytes */' + data.length }); res.end(); return; }
    const headers = { 'content-type': 'application/octet-stream', 'content-length': data.length - start, 'accept-ranges': 'bytes' };
    if (m) headers['content-range'] = `bytes ${start}-${data.length - 1}/${data.length}`;
    res.writeHead(m ? 206 : 200, headers);
    let pos = start;
    let closed = false;
    res.on('close', () => { closed = true; });
    const pump = () => {
      if (closed) return;
      if (name === 'a.bin' && pos - start >= repo.stallAfter) { setTimeout(pump, 40); return; } // stalled until the test lifts the limit
      if (pos >= data.length) { res.end(); return; }
      const end = Math.min(pos + 65536, data.length);
      res.write(data.subarray(pos, end));
      pos = end;
      setTimeout(pump, repo.slowMs);
    };
    pump();
  });
  return new Promise((resolve) => repo.server.listen(0, '127.0.0.1', () => { repo.url = 'http://127.0.0.1:' + repo.server.address().port; resolve(repo); }));
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  // a 40 s test video: grey picture with a thin white bar that moves (so that no two pictures are identical), and a RED box (the "dog") on the left
  // at 10-20 s and 30-34 s
  fs.mkdirSync(h.FIX, { recursive: true });
  const dogVideo = path.join(h.FIX, 'dog_40s_v2.mp4');
  if (!fs.existsSync(dogVideo)) {
    h.ff(['-f', 'lavfi', '-i', "color=c=0x445566:s=320x180:r=10:d=40[bg];color=c=white:s=3x180:r=10:d=40[bar];[bg][bar]overlay=x='t*7':y=0:eval=frame,drawbox=x=64:y=54:w=64:h=72:color=red:t=fill:enable='between(t,10,20)+between(t,30,34)',format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '10', '-an', '-y', dogVideo]);
  }

  const A = bytes('model', 2500000);
  const B = bytes('mmproj', 900000);
  const repo = await startRepo({ 'a.bin': A, 'b.bin': B });
  const catalogFile = path.join(WORK, 'catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify([{
    id: 'qwen3.5-4b', name: 'Test model (fake)', family: 'qwen3.5', boxFormat: 'k1000', vision: true, license: 'Apache-2.0', licenseUrl: 'https://example.invalid/', source: 'https://example.invalid/', needsRamGb: 1,
    files: [
      { role: 'model', name: 'test-model.gguf', aliases: [], url: repo.url + '/a.bin', size: A.length, sha256: sha(A) },
      { role: 'mmproj', name: 'test-mmproj.gguf', aliases: [], url: repo.url + '/b.bin', size: B.length, sha256: sha(B) },
    ],
  }]));
  const cfgFile = path.join(WORK, 'fake-cfg.json');
  const backendLog = path.join(WORK, 'backend.log');
  const setCfg = (o) => fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ ffmpeg: h.bins.ffmpeg, log: backendLog, visionDelayMs: 0 }, o || {})));
  const logEntries = () => (fs.existsSync(backendLog) ? fs.readFileSync(backendLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  setCfg();
  fs.writeFileSync(MSGBOX, '');
  const otherDir = path.join(WORK, 'other-models');

  const userData = ud('llm');
  const env = {
    VE_TEST_LLM_CATALOG: catalogFile, VE_TEST_LLM_BACKEND: BACKEND, VE_TEST_LLM_FAKE_CFG: cfgFile, VE_TEST_LLM_STALL_MS: '20000',
    VE_TEST_MSGBOX_LOG: MSGBOX, VE_TEST_LLM_PICK_DIR: otherDir,
  };
  let app = await launch({ userData, files: [dogVideo], port: 9431, env });
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ id: s.id, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const total = () => ev('VE.state.layout().total');
  const dbg = () => ev('VE.ai.debug()');
  const llmStatus = () => ev('window.api.llm.status()');
  const aiStatus = () => ev('window.api.ai.status()');
  const txt = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || { textContent: '' }).textContent`);
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  const waitIdle = (count, ms) => app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${count}; })()`, ms || 40000, 'assistant reply');
  const closeModal = async () => { await ev("(document.querySelector('#modal-root .modal-head .btn') || { click() {} }).click()"); await sleep(150); };
  const openSettings = async () => {
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('#modal-root [data-llm=\"panel\"]')", 8000, 'settings dialog');
  };
  const clickLlm = (role) => ev(`document.querySelector('#modal-root [data-llm=${JSON.stringify(role)}]').click()`);
  const panelState = () => ev("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state");
  const modelDir = () => path.join(userData, 'models', 'qwen3.5-4b');
  const setLang = async (l) => { await app.click(`#lang-switch button[data-lang="${l}"]`); await sleep(200); };
  const setTheme = async (th) => { if ((await ev("document.documentElement.getAttribute('data-theme')")) !== th) { await app.click('#btn-theme'); await sleep(200); } };

  try {
    await app.waitFor("VE.state.S.segments.length === 1 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import + thumbnails');
    await sleep(300);
    const orig = await segs();
    const origTotal = await total();

    /* ---------------- before the click ---------------- */

    await step('L01 fresh profile: built-in model is the default provider, it is not installed, the assistant is off and NOTHING was fetched', async () => {
      const st = await aiStatus();
      assert(st.provider === 'builtin' && st.needs === 'install' && st.ready === false && st.credential === 'none', JSON.stringify(st).slice(0, 300));
      assert(st.builtin.model.state === 'missing' && st.builtin.model.total === A.length + B.length, JSON.stringify(st.builtin.model));
      assert(st.builtin.dir === path.join(userData, 'models'), 'model folder: ' + st.builtin.dir);
      assert(st.vision === true, 'vision capability');
      await app.click('#btn-ai');
      await app.waitFor("!document.querySelector('#ai-pane').hidden", 4000, 'pane');
      assert(!(await ev("document.querySelector('#ai-banner').hidden")), 'banner');
      assert((await txt('#ai-banner-title')) === 'Yerel yapay zekâ modeli kurulu değil', await txt('#ai-banner-title'));
      assert((await txt('#ai-banner-btn-label')) === 'Modeli kur…', 'banner button');
      assert(await ev("document.querySelector('#ai-input').disabled"), 'input must be disabled');
      await sleep(500);
      assert(repo.requests.length === 0, 'something was downloaded without a click: ' + JSON.stringify(repo.requests));
      assert(logEntries().length === 0, 'the model was started without being installed');
      assert(!fs.existsSync(path.join(userData, 'models')) || fs.readdirSync(path.join(userData, 'models')).length === 0, 'model folder should be empty');
      await app.screenshot(path.join(SHOTS, 'llm-tr-dark-banner.png'));
    });

    await step('L02 the settings dialog offers the built-in model first; address, model name and key fields are replaced by its panel', async () => {
      await app.click('#ai-banner-btn');
      await app.waitFor("!!document.querySelector('#modal-root [data-llm=\"panel\"]')", 8000, 'panel');
      const f = await ev(`(() => { const m = document.querySelector('#modal-root .modal'); const sel = m.querySelector('select');
        const grid = [...m.querySelectorAll('.form-grid')].find((g) => !g.closest('.llm-panel'));
        const q = (s) => m.querySelector(s);
        return {
          provider: sel.value, first: sel.options[0].value, count: sel.options.length,
          visibleCells: [...grid.children].filter((n) => !n.hidden).length, keyHidden: q('input[type="password"]').closest('.path-row').hidden,
          state: q('[data-llm="state"]').textContent, install: !q('[data-llm="install"]').hidden, installLabel: q('[data-llm="install"]').textContent,
          verify: !q('[data-llm="verify"]').hidden, cancel: !q('[data-llm="cancel"]').hidden, remove: !q('[data-llm="remove"]').hidden,
          dir: q('[data-llm="dir"]').value, backend: q('[data-llm="backend"]').value, idle: q('[data-llm="idle"]').value,
          share: !q('label.check').hidden, text: m.textContent };
      })()`);
      assert(f.provider === 'builtin' && f.first === 'builtin' && f.count === 8, JSON.stringify({ p: f.provider, f: f.first, c: f.count }));
      assert(f.visibleCells === 2 && f.keyHidden, 'only the provider row should be left in the form grid, visible cells: ' + f.visibleCells);
      assert(f.state === 'Kurulu değil' && f.install && /^İndir ve kur \(\d+ MB\)$/.test(f.installLabel), f.state + ' / ' + f.installLabel);
      assert(!f.verify && !f.cancel && !f.remove, 'buttons that do not apply must be hidden');
      assert(f.dir === path.join(userData, 'models') && f.backend === 'auto' && f.idle === '10', JSON.stringify({ d: f.dir, b: f.backend, i: f.idle }));
      assert(!f.share, 'the "send file names" option is meaningless for a model that never leaves the computer');
      assert(/Hiçbir şey bilgisayarınızdan çıkmaz/.test(f.text) && /huggingface\.co/.test(f.text), 'privacy text for the built-in model');
      await app.screenshot(path.join(SHOTS, 'llm-tr-dark-settings-missing.png'));
    });

    /* ---------------- install / progress / cancel / resume ---------------- */

    await step('L03 the download starts only on the click, shows progress in the dialog AND in the banner, can be cancelled and keeps the partial file', async () => {
      repo.slowMs = 25;
      repo.stallAfter = 1300000;
      await clickLlm('install');
      await app.waitFor("/İndiriliyor… \\d+%/.test(document.querySelector('#modal-root [data-llm=\"state\"]').textContent)", 12000, 'progress text');
      await app.waitFor("parseInt(document.querySelector('#modal-root .llm-bar i').style.width) > 20", 15000, 'progress bar');
      assert((await txt('#ai-banner-title')) === 'Model hazırlanıyor' && /İndiriliyor… \d+%/.test(await txt('#ai-banner-text')), 'banner: ' + (await txt('#ai-banner-text')));
      const btns = await ev(`(() => { const m = document.querySelector('#modal-root'); return { install: !m.querySelector('[data-llm="install"]').hidden, cancel: !m.querySelector('[data-llm="cancel"]').hidden, pick: m.querySelector('[data-llm="pick"]').disabled }; })()`);
      assert(!btns.install && btns.cancel && btns.pick, JSON.stringify(btns));
      assert(repo.requests.length >= 1 && repo.requests[0].url === '/a.bin', JSON.stringify(repo.requests));
      await clickLlm('cancel');
      await app.waitFor("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state === 'partial'", 12000, 'partial state');
      const part = path.join(modelDir(), 'test-model.gguf.part');
      assert(fs.existsSync(part) && fs.statSync(part).size > 300000 && fs.statSync(part).size < A.length, 'partial file: ' + (fs.existsSync(part) ? fs.statSync(part).size : 'missing'));
      assert(!fs.existsSync(path.join(modelDir(), 'test-model.gguf')), 'an unverified file got its real name');
      const text = await txt('#modal-root [data-llm="state"]');
      assert(/Yarım kalmış indirme \(\d+%\)/.test(text), text);
      assert(/İndirmeye devam et/.test(await txt('#modal-root [data-llm="install"]')), 'resume button');
      assert((await aiStatus()).needs === 'install', 'the assistant must stay off');
    });

    await step('L04 resuming continues with a Range request, both files are verified (SHA-256) and the assistant turns on', async () => {
      const before = repo.requests.length;
      repo.stallAfter = Infinity;
      repo.slowMs = 4;
      await clickLlm('install');
      await app.waitFor("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state === 'ready'", 30000, 'ready');
      const ranged = repo.requests.slice(before).filter((r) => r.url === '/a.bin');
      assert(ranged.length >= 1 && /^bytes=\d{5,}-$/.test(ranged[0].range), 'no ranged resume request: ' + JSON.stringify(repo.requests.slice(before)));
      const files = fs.readdirSync(modelDir()).sort();
      assert(JSON.stringify(files) === JSON.stringify(['test-mmproj.gguf', 'test-model.gguf']), 'files: ' + files);
      assert(sha(fs.readFileSync(path.join(modelDir(), 'test-model.gguf'))) === sha(A), 'content');
      assert(/Kurulu ve doğrulandı/.test(await txt('#modal-root [data-llm="state"]')), 'state text');
      assert(await ev("document.querySelector('#modal-root [data-llm=\"remove\"]').offsetParent !== null"), 'remove button');
      const st = await aiStatus();
      assert(st.ready && st.needs === null && st.provider === 'builtin', JSON.stringify(st).slice(0, 200));
      assert(await ev("document.querySelector('#ai-banner').hidden"), 'banner must disappear');
      assert(/Model kuruldu ve doğrulandı/.test(await txt('#modal-root .ai-result')), await txt('#modal-root .ai-result'));
      await app.screenshot(path.join(SHOTS, 'llm-tr-dark-settings-ready.png'));
    });

    await step('L05 another folder (picked in the dialog) is empty: a damaged download is refused, the file never gets its real name', async () => {
      await clickLlm('pick');
      await app.waitFor("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state === 'missing'", 8000, 'empty folder');
      assert((await ev("document.querySelector('#modal-root [data-llm=\"dir\"]').value")) === otherDir, 'folder shown');
      assert(await ev("!document.querySelector('#modal-root [data-llm=\"default\"]').hidden"), 'a way back to the default folder');
      repo.corrupt.add('b.bin');
      await clickLlm('install');
      await app.waitFor("/uyuşmuyor/.test(document.querySelector('#modal-root .ai-result').textContent) && !document.querySelector('#modal-root .ai-result').classList.contains('busy')", 30000, 'checksum error');
      const dir = path.join(otherDir, 'qwen3.5-4b');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      assert(!files.includes('test-mmproj.gguf') && !files.includes('test-mmproj.gguf.part'), 'a damaged file was left behind: ' + files);
      assert((await aiStatus()).builtin.model.state !== 'ready', 'a damaged model must not be ready');
      repo.corrupt.clear();
    });

    await step('L06 folder setting: only local absolute folders are accepted; back to the default folder the verified files are found again', async () => {
      for (const bad of ['\\\\attacker\\share\\models', 'models', 'http://example.com/m', 'C:\\x\0y']) {
        const r = await ev(`window.api.llm.set({ modelDir: ${JSON.stringify(bad)} })`);
        assert(r.ok === false && r.error.code === 'BAD_DIR', bad + ' -> ' + JSON.stringify(r));
      }
      const badBackend = await ev("window.api.llm.set({ backend: 'gpu9000' })");
      assert(badBackend.ok === false && badBackend.error.code === 'BAD_ARGS', JSON.stringify(badBackend));
      await clickLlm('default');
      await app.waitFor("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state === 'ready'", 8000, 'default folder again');
      await closeModal();
      assert((await aiStatus()).ready, 'ready again');
      const stored = await ev('window.api.setSettings({}).then((x) => x.llm)');
      assert(stored.modelDir === '' && stored.backend === 'auto' && stored.idleMinutes === 10, JSON.stringify(stored));
    });

    /* ---------------- using it ---------------- */

    await step('L07 opening the pane starts the model in the background; the intro offers the vision examples; the first request needs no waiting', async () => {
      await ev("document.querySelector('#ai-pane').hidden && VE.ai.open()");
      await app.waitFor("window.api.llm.status().then((s) => s.server.phase === 'ready')", 15000, 'model started by the pane');
      assert(logEntries().filter((e) => e.kind === 'start').length >= 1, 'the pane must have started the model: ' + JSON.stringify(logEntries()));
      await app.waitFor("!document.querySelector('#ai-input').disabled", 5000, 'input enabled');
      const chips = await ev("[...document.querySelectorAll('[data-ai=\"vision-examples\"] .ai-chip')].map((c) => c.textContent)");
      assert(chips.length === 3 && chips[0] === 'Köpeği yakınlaştır', JSON.stringify(chips));
      assert(/görüntüsüne bakabilir/.test(await txt('.ai-intro-note')), 'vision note');
      assert((await txt('#ai-state')) === 'Hazır', 'state chip');
      await app.screenshot(path.join(SHOTS, 'llm-tr-dark-pane-ready.png'));
    });

    await step('L08 "Köpeği yakınlaştır": the video is searched (live progress), the zoom lands on the found parts and aims at the object; ONE undo restores everything', async () => {
      setCfg({ visionDelayMs: 90 });
      const before = (await dbg()).messages.length;
      await ask('Köpeği yakınlaştır');
      const seen = new Set();
      let sawBar = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        const s = await ev("(() => { const d = VE.ai.debug(); const w = document.querySelector('[data-ai=\"working\"]'); return { running: d.running, count: d.messages.length, text: w ? w.textContent : '', bar: !!document.querySelector('[data-ai=\"search-bar\"]') }; })()");
        if (s.text) seen.add(s.text.replace(/\d+/g, 'N'));
        if (s.bar) sawBar = true;
        if (!s.running && s.count >= before + 2) break;
        await sleep(80);
      }
      const texts = [...seen].join(' | ');
      assert(/Videoda aranıyor: dog — N\/N/.test(texts) && sawBar, 'live progress missing: ' + texts);
      assert(/Kesin anlar bulunuyor: dog/.test(texts) || /Yeri belirleniyor: dog/.test(texts), 'later phases missing: ' + texts);
      const d = await dbg();
      const msg = d.messages[d.messages.length - 1];
      assert(msg.type === 'ai' && /bölümde değişiklik yaptım/.test(msg.text), JSON.stringify(msg).slice(0, 300));
      assert(msg.found.length === 1 && msg.found[0].label === 'dog' && msg.found[0].intervals.length === 2, JSON.stringify(msg.found));
      const [i1, i2] = msg.found[0].intervals;
      near(i1.start, 10, 0.8, 'start 1'); near(i1.end, 20, 0.8, 'end 1'); near(i2.start, 30, 0.8, 'start 2'); near(i2.end, 34, 0.8, 'end 2');
      const foundTexts = await ev("[...document.querySelectorAll('#ai-log [data-ai=\"found\"]')].map((li) => li.textContent)");
      assert(foundTexts.some((x) => /“dog”: 2 bölüm — 00:10–00:20, 00:30–00:34 · 20 kare incelendi/.test(x)), 'found line in the log: ' + JSON.stringify(foundTexts));
      const now = await segs();
      const zoomed = now.filter((s) => s.zoomFrom !== 1 || s.zoomTo !== 1);
      assert(zoomed.length >= 5, 'ramp in / hold / ramp out for two parts: ' + zoomed.length);
      near(Math.max(...zoomed.map((s) => Math.max(s.zoomFrom, s.zoomTo))), 1.5, 0.2, 'zoom factor from the object size');
      zoomed.forEach((s) => { near(s.fx, 0.3, 0.06, 'focus x'); near(s.fy, 0.5, 0.06, 'focus y'); });
      near(zoomed[0].in, 10, 0.8, 'zoom start'); near(zoomed[zoomed.length - 1].out, 34, 0.8, 'zoom end');
      near(await total(), origTotal, 0.01, 'zoom never changes the length');
      const log = logEntries();
      const agentReqs = log.filter((e) => e.kind === 'agent');
      assert(agentReqs.length === 3 && agentReqs.every((e) => e.tools === true), 'agent rounds: ' + JSON.stringify(agentReqs));
      const probes = log.filter((e) => e.kind === 'probe');
      assert(probes.length >= 20 && probes.length < 60 && probes.every((e) => e.phrase === 'dog' && e.maxTokens === 6), 'probes: ' + probes.length);
      assert(log.filter((e) => e.kind === 'ground').length <= 6, 'box requests');
      assert(!log.some((e) => e.kind === 'denied'), 'the private key was refused');
      await app.screenshot(path.join(SHOTS, 'llm-tr-dark-pane-found.png'));
      await app.key('z', { ctrl: true });
      await app.waitFor('VE.state.S.segments.length === ' + orig.length, 4000, 'undo');
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'one Ctrl+Z must restore the original timeline');
    });

    await step('L09 "Soldaki köpeği kes": the position the user wrote reaches the question; the found parts are removed', async () => {
      setCfg();
      const mark = logEntries().length;
      const before = (await dbg()).messages.length;
      await ask('Soldaki köpeği kes');
      await waitIdle(before + 2);
      const msg = (await dbg()).messages.pop();
      assert(msg.type === 'ai' && msg.found[0].label === 'dog (left)', JSON.stringify(msg).slice(0, 300));
      near(await total(), origTotal - 14, 1.6, 'cut length');
      const asked = logEntries().slice(mark).filter((e) => e.kind === 'probe');
      assert(asked.length > 10, 'probes');
      await app.key('z', { ctrl: true });
      await app.waitFor('VE.state.S.segments.length === ' + orig.length, 4000, 'undo');
    });

    await step('L10 something that is not in the video: honest answer, nothing changes, no false alarms', async () => {
      const before = (await dbg()).messages.length;
      await ask('Tek boynuzlu atı kes');
      await waitIdle(before + 2);
      const msg = (await dbg()).messages.pop();
      assert(/bulamadım/.test(msg.text) && msg.found.length === 1 && msg.found[0].intervals.length === 0, JSON.stringify(msg).slice(0, 300));
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'the timeline changed');
      assert(await ev("[...document.querySelectorAll('#ai-log [data-ai=\"found\"]')].some((li) => /bulunamadı/.test(li.textContent))"), 'not-found line');
    });

    await step('L11 stopping during the search ends it at once: nothing is applied and no more pictures are examined', async () => {
      setCfg({ visionDelayMs: 600 });
      const before = (await dbg()).messages.length;
      await ask('Köpeği hızlandır');
      await app.waitFor("document.querySelector('[data-ai=\"search-bar\"]') !== null", 20000, 'search started');
      await sleep(500);
      await app.click('#ai-send');
      await waitIdle(before + 2, 15000);
      const msg = (await dbg()).messages.pop();
      assert(msg.type === 'info' && /İptal edildi/.test(msg.text), JSON.stringify(msg));
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'timeline changed after cancel');
      await sleep(900); // a request that was already on its way may still be answered
      const n = logEntries().length;
      await sleep(1500);
      assert(logEntries().length === n, 'the model kept being asked after the cancel');
      assert((await llmStatus()).server.phase === 'ready', 'the model server must survive a cancelled request');
      setCfg();
    });

    await step('L12 a plain greeting is answered without looking at the video', async () => {
      const mark = logEntries().length;
      const before = (await dbg()).messages.length;
      await ask('merhaba');
      await waitIdle(before + 2);
      const msg = (await dbg()).messages.pop();
      assert(/Merhaba/.test(msg.text) && msg.found.length === 0, JSON.stringify(msg).slice(0, 200));
      assert(logEntries().slice(mark).every((e) => e.kind === 'agent'), 'the video was examined for a greeting');
    });

    /* ---------------- stopping the model by hand ---------------- */

    await step('L12b "Stop model": the header button unloads the model at once and the pane does not start it again by itself; the next command does; the settings panel has the same button', async () => {
      const btn = "document.querySelector('#ai-stop-model')";
      assert((await llmStatus()).server.phase === 'ready', 'the model should be running here');
      assert(await ev(`!${btn}.hidden && !${btn}.disabled`), 'the stop button is not shown while the model runs');
      const title = await ev(`${btn}.title`);
      assert(/durdur/i.test(title) && (await ev(`${btn}.getAttribute('aria-label')`)) === title, 'title / aria-label: ' + title);
      await ev(`${btn}.click()`);
      await app.waitFor("window.api.llm.status().then((s) => s.server.phase === 'stopped')", 8000, 'model stopped by the button');
      await app.waitFor(`${btn}.hidden`, 5000, 'the stop button hides when nothing runs');
      await sleep(1200);
      assert((await llmStatus()).server.phase === 'stopped', 'the pane started the model again by itself');
      // the next command starts it again on demand
      const before = (await dbg()).messages.length;
      await ask('merhaba');
      await waitIdle(before + 2);
      assert((await llmStatus()).server.phase === 'ready', 'the next command did not start the model');
      assert(await ev(`!${btn}.hidden`), 'the button must come back while the model runs');
      // the same button in the settings dialog
      await openSettings();
      const panelBtn = "document.querySelector('#modal-root [data-llm=\"stop\"]')";
      assert(await ev(`!${panelBtn}.hidden`), 'the panel has no stop button while the model runs');
      assert(/Modeli durdur/.test(await ev(`${panelBtn}.textContent`)), 'panel label');
      await ev(`${panelBtn}.click()`);
      await app.waitFor("window.api.llm.status().then((s) => s.server.phase === 'stopped')", 8000, 'model stopped from the panel');
      await app.waitFor(`${panelBtn}.hidden`, 5000, 'the panel button hides');
      await closeModal();
      // stopping a model that is not running is a harmless no-op
      const busy = await ev('window.api.llm.stop()');
      assert(busy.ok === true && busy.status.server.phase === 'stopped', 'stopping a stopped model: ' + JSON.stringify(busy).slice(0, 200));
    });

    /* ---------------- settings of a running model ---------------- */

    await step('L13 graphics chip that cannot start: the CPU build takes over automatically and the panel says so; changing the mode stops the model', async () => {
      assert((await ev("window.api.llm.set({ backend: 'cpu' })")).ok, 'set cpu');
      assert((await llmStatus()).server.phase === 'stopped', 'changing the mode must stop the model');
      assert((await ev("window.api.llm.set({ backend: 'auto' })")).ok, 'set auto');
      setCfg({ failVk: true });
      const t = await ev('window.api.ai.test()');
      assert(t.ok && t.backend === 'cpu', JSON.stringify(t));
      const s = (await llmStatus()).server;
      assert(s.phase === 'ready' && s.backend === 'cpu' && s.fallbackFrom === 'vk', JSON.stringify(s));
      await openSettings();
      const run = await txt('#modal-root [data-llm="run"]');
      assert(/Çalışıyor: işlemci/.test(run) && /işlemciye geçildi/.test(run), run);
      await closeModal();
      setCfg();
    });

    await step('L14 a model that cannot start gives a clear, translated error with a shortcut to the settings', async () => {
      assert((await ev("window.api.llm.set({ backend: 'vk' })")).ok, 'set vk');
      setCfg({ failAll: true });
      const before = (await dbg()).messages.length;
      await ask('Köpeği yakınlaştır');
      await waitIdle(before + 2);
      const msg = (await dbg()).messages.pop();
      assert(msg.type === 'error' && msg.code === 'LLM_START_FAILED' && /başlatılamadı/.test(msg.text) && msg.fix === true, JSON.stringify(msg).slice(0, 300));
      assert(JSON.stringify(await segs()) === JSON.stringify(orig), 'timeline changed');
      setCfg();
      assert((await ev("window.api.llm.set({ backend: 'auto' })")).ok, 'back to auto');
      const ok = await ev('window.api.ai.test()');
      assert(ok.ok, JSON.stringify(ok));
    });

    /* ---------------- restart / pre-seeded / remove ---------------- */

    await step('L15 restart: provider, folder and installed model are remembered (no new download, no new checksum run); the model is not running', async () => {
      const requestsBefore = repo.requests.length;
      await app.close();
      app = await launch({ userData, files: [dogVideo], port: 9432, env, keepUserData: true });
      await app.waitFor('VE.state.S.segments.length === 1', 20000, 'reload');
      const st = await aiStatus();
      assert(st.provider === 'builtin' && st.ready && st.builtin.model.state === 'ready' && st.builtin.server.phase === 'stopped', JSON.stringify(st.builtin.model) + JSON.stringify(st.builtin.server));
      assert(repo.requests.length === requestsBefore, 'a new download was started');
    });

    await step('L16 files that were copied there by hand (no verified record) are checked once, automatically, before the first use; a wrong file is refused', async () => {
      await app.close();
      fs.rmSync(path.join(userData, 'llm-verified.json'), { force: true });
      app = await launch({ userData, files: [dogVideo], port: 9433, env, keepUserData: true });
      await app.waitFor('VE.state.S.segments.length === 1', 20000, 'reload');
      let st = await aiStatus();
      assert(st.builtin.model.state === 'unverified' && st.ready === true && st.needs === null, 'pre-seeded files count as installed: ' + st.builtin.model.state);
      const t = await ev('window.api.ai.test()');
      assert(t.ok, JSON.stringify(t));
      st = await aiStatus();
      assert(st.builtin.model.state === 'ready', 'verified by the first use: ' + st.builtin.model.state);
      await app.close();
      fs.rmSync(path.join(userData, 'llm-verified.json'), { force: true });
      const f = path.join(modelDir(), 'test-mmproj.gguf');
      const buf = fs.readFileSync(f); buf[100] ^= 0xff; fs.writeFileSync(f, buf);
      app = await launch({ userData, files: [dogVideo], port: 9434, env, keepUserData: true });
      await app.waitFor('VE.state.S.segments.length === 1', 20000, 'reload');
      const startsBefore = logEntries().filter((e) => e.kind === 'start').length;
      const bad = await ev('window.api.ai.test()');
      assert(bad.ok === false && bad.error.code === 'HASH_MISMATCH', JSON.stringify(bad));
      const st2 = await aiStatus();
      assert(st2.builtin.model.state === 'bad' && st2.builtin.server.phase === 'stopped', 'a damaged model must never be started: ' + JSON.stringify(st2.builtin));
      assert(logEntries().filter((e) => e.kind === 'start').length === startsBefore, 'the model process was started');
    });

    await step('L17 repair by downloading again, then delete the model: files are gone and the assistant is off again', async () => {
      await app.click('#btn-ai');
      await sleep(300);
      await openSettings();
      assert(/Yeniden indir/.test(await txt('#modal-root [data-llm="install"]')), 'reinstall label: ' + (await txt('#modal-root [data-llm="install"]')));
      await clickLlm('install');
      await app.waitFor("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state === 'ready'", 30000, 'repaired');
      fs.writeFileSync(MSGBOX + '.choice', '0');
      await clickLlm('remove');
      await app.waitFor("document.querySelector('#modal-root [data-llm=\"state\"]').dataset.state === 'missing'", 15000, 'removed');
      assert(!fs.existsSync(modelDir()), 'model folder still exists: ' + (fs.existsSync(modelDir()) ? fs.readdirSync(modelDir()) : ''));
      const st = await aiStatus();
      assert(st.needs === 'install' && !st.ready, 'assistant must be off');
      await closeModal();
      assert(!(await ev("document.querySelector('#ai-banner').hidden")), 'banner back');
      fs.writeFileSync(MSGBOX + '.choice', '1');
    });

    /* ---------------- looks ---------------- */

    await step('L18 the panel in every language and theme (screenshots)', async () => {
      for (const [lang, theme] of [['tr', 'light'], ['en', 'dark'], ['en', 'light']]) {
        await setLang(lang);
        await setTheme(theme);
        await openSettings();
        const text = await txt('#modal-root .modal');
        if (lang === 'en') assert(/Built-in local model/.test(text) && /Download and install/.test(text) && /Not installed/.test(text), 'english texts: ' + text.slice(0, 300));
        else assert(/Yerleşik yerel model/.test(text) && /İndir ve kur/.test(text), 'turkish texts');
        await app.screenshot(path.join(SHOTS, `llm-${lang}-${theme}-settings.png`));
        await closeModal();
      }
      await setLang('tr');
      await setTheme('dark');
    });

    await step('L19 no script error and no console error; the renderer itself still cannot reach the network', async () => {
      assert(app.errors.length === 0, 'renderer errors: ' + app.errors.join(' | '));
      const r = await ev(`fetch(${JSON.stringify(repo.url + '/a.bin')}).then(() => 'reached', () => 'blocked')`);
      assert(r === 'blocked', 'renderer fetch: ' + r);
    });
  } finally {
    await app.close();
    repo.server.close();
  }
  const failed = summary('ui-llm');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ui-llm crashed:', e); process.exit(2); });
