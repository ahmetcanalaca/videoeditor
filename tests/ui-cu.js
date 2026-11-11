'use strict';
// UI scenario: video analysis with Azure Content Understanding in the real app (CDP) against a mock of the Foundry chat endpoint and of the
// Content Understanding service (127.0.0.1). Covers: settings section, connection test, a complete request (consent dialog, reduced copy uploaded,
// polling, scenes read by the model, ONE undo step), cache (no second upload), declined upload, service errors, cancelling, key hygiene,
// address binding of the key, settings that the page cannot change, TR / EN and dark / light screenshots.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, h } = require('./ui-helpers');
const { startMockCu, makeResult } = require('./cu-mock');

const KEY = 'CU_UI_KEY_not_a_real_secret_0123456789';
const SHOTS = path.join(OUT, 'shots');
const MSGBOX_LOG = path.join(OUT, 'cu-msgbox.log');

const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const calls = (list) => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } } });

function scanForKey(dir) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          if (fs.statSync(p).size > 80 * 1024 * 1024) continue;
          if (fs.readFileSync(p).includes(KEY)) hits.push(p);
        } catch (err) { /* locked file */ }
      }
    }
  };
  walk(dir);
  return hits;
}

const dialogs = () => { try { return fs.readFileSync(MSGBOX_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };

(async () => {
  const fx = h.makeFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(MSGBOX_LOG, { force: true });
  const chatQueue = [];
  const chatRequests = [];
  const mock = await startMockCu({
    key: KEY,
    polls: 1,
    result: (info) => makeResult(info.seconds || 8, { sceneSeconds: 2 }),
    chat: (entry, body) => {
      if (entry.method === 'GET') return { json: { data: [{ id: 'mock-model' }] } };
      if (body && !body.tools) return text('OK'); // connection test
      chatRequests.push(body);
      const f = chatQueue.shift();
      return f ? f(body) : { json: text('(no script)') };
    },
  });

  const userData = ud('cu');
  const env = { VE_TEST_MSGBOX_LOG: MSGBOX_LOG, VE_TEST_CU_POLL_MS: '60' };
  let app = await launch({ userData, files: [fx.A], port: 9431, env });
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ id: s.id, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo }))');
  const dbg = () => ev('VE.ai.debug()');
  const modalText = () => ev("(document.querySelector('#modal-root .modal') || { textContent: '' }).textContent");
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  const waitReply = async (before, n) => app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + (n || 2)}; })()`, 40000, 'assistant reply');
  const set = (selector, value) => ev(`(() => { const el = document.querySelector('#modal-root ${selector}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const check = (selector, on) => ev(`(() => { const el = document.querySelector('#modal-root ${selector}'); if (el.checked !== ${!!on}) el.click(); })()`);
  const saveSettings = async () => {
    await ev("document.querySelector('#modal-root .modal-foot .btn.primary').click()");
    await app.waitFor("(() => { const r = document.querySelector('#modal-root .ai-result'); return !!r && !r.hidden && !r.classList.contains('busy'); })()", 25000, 'settings result');
    return ev("document.querySelector('#modal-root .ai-result').textContent");
  };
  const openSettings = async () => {
    if (await ev("document.querySelector('#ai-pane').hidden")) { await app.click('#btn-ai'); await sleep(300); }
    await app.click('#ai-settings');
    await app.waitFor("!!document.querySelector('#modal-root .modal')", 8000, 'settings dialog');
    await sleep(250);
  };
  const closeModal = async () => { await ev("(document.querySelector('#modal-root .modal-head .btn') || { click() {} }).click()"); await sleep(200); };
  const stepsLog = async () => ev('window.__steps || []');

  try {
    await app.waitFor("VE.state.S.segments.length === 1 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import + thumbnails');
    await ev("window.__steps = []; window.api.on('ai:step', (e) => window.__steps.push(e)); true");
    await sleep(300);

    /* ---------------- settings ---------------- */

    await step('C01 the video analysis section only exists for the Foundry provider, is off by default and says what is sent', async () => {
      await app.click('#btn-ai');
      await sleep(300);
      await openSettings();
      assert(await ev("document.querySelector('#modal-root [data-ai=\"cu-section\"]').hidden"), 'hidden for the built-in model');
      await set('select', 'foundry');
      assert(!(await ev("document.querySelector('#modal-root [data-ai=\"cu-section\"]').hidden")), 'visible for Foundry');
      assert(!(await ev("document.querySelector('#modal-root [data-ai=\"cu-enable\"]').checked")), 'off by default');
      assert(await ev("document.querySelector('#modal-root .cu-details').hidden"), 'details are folded while it is off');
      const t = await modalText();
      assert(/Azure Content Understanding/.test(t), 'title');
      await set('select', 'openai');
      assert(await ev("document.querySelector('#modal-root [data-ai=\"cu-section\"]').hidden"), 'hidden for OpenAI');
      await set('select', 'foundry');
    });

    await step('C02 switching it on shows the privacy note (what is uploaded, consent, cost); saving makes the video analysis ready; the key is not in settings.json', async () => {
      await set('.form-grid input[type="text"]', mock.origin);
      await set('input[type="password"]', KEY);
      const inputs = await ev("[...document.querySelectorAll('#modal-root .form-grid input[type=\"text\"]')].map((i) => i.placeholder)");
      const modelIdx = inputs.findIndex((p) => p === 'my-deployment');
      await ev(`(() => { const el = document.querySelectorAll('#modal-root .form-grid input[type="text"]')[${modelIdx}]; el.value = 'mock-model'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await check('[data-ai="cu-enable"]', true);
      assert(!(await ev("document.querySelector('#modal-root .cu-details').hidden")), 'details open');
      const t = await modalText();
      assert(/küçültülmüş bir kopyası/.test(t) && /her seferinde sizin onayınızla/.test(t) && /Ücret Azure aboneliğinize/.test(t), 'privacy note');
      assert(/Foundry adresinizden türetilir: http:\/\/127\.0\.0\.1:\d+/.test(t), 'derived address is shown');
      assert(!/hiçbir zaman gönderilmez/.test(t), 'the general note no longer claims that nothing is sent');
      assert(/Video analizi açıkken/.test(t), 'the "what is sent" note mentions the analysis');
      await app.screenshot(path.join(SHOTS, 'cu-settings-tr-dark.png'));
      const r = await saveSettings();
      assert(/Bağlantı ve model çalışıyor/.test(r) && /Video analizi hazır/.test(r), 'result: ' + r);
      const st = await ev('window.api.ai.status()');
      assert(st.cu.available && st.cu.enabled && st.cu.ready && st.cu.effectiveEndpoint === mock.origin && st.cu.analyzer === 'prebuilt-videoSearch' && st.cu.location === 'geography', JSON.stringify(st.cu));
      await sleep(700); // settings.json is written 400 ms after the last change
      const settingsJson = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8');
      assert(!settingsJson.includes(KEY), 'no key in settings.json');
      const saved = JSON.parse(settingsJson);
      assert(saved.ai.cu.enabled === true && saved.ai.cu.location === 'geography', JSON.stringify(saved.ai.cu));
      assert(dialogs().length === 0, 'a loopback address needs no confirmation dialog: ' + JSON.stringify(dialogs()));
    });

    await step('C03 "test the connection": model deployments are listed; a resource without defaults and a wrong key are explained; nothing is uploaded', async () => {
      await app.click('#modal-root [data-ai="cu-test"]');
      await app.waitFor("/Content Understanding çalışıyor/.test(document.querySelector('#modal-root .ai-result').textContent)", 15000, 'test ok');
      assert(/gpt-4\.1/.test(await ev("document.querySelector('#modal-root .ai-result').textContent")), 'deployments listed');
      mock.options.defaults = {};
      await app.click('#modal-root [data-ai="cu-test"]');
      await app.waitFor("/varsayılan model dağıtımları/.test(document.querySelector('#modal-root .ai-result').textContent)", 15000, 'no defaults');
      mock.options.defaults = { 'gpt-4.1': 'gpt41' };
      mock.options.key = 'another-key';
      await app.click('#modal-root [data-ai="cu-test"]');
      await app.waitFor("document.querySelector('#modal-root .ai-result').classList.contains('err')", 15000, 'wrong key');
      mock.options.key = KEY;
      assert(mock.uploads.length === 0, 'the test uploads nothing');
      assert(mock.requests.filter((r) => r.path.startsWith('/contentunderstanding/')).every((r) => r.method === 'GET'), 'only GET requests');
      await closeModal();
    });

    /* ---------------- a complete request ---------------- */

    await step('C04 a request that needs the video content: consent dialog, reduced copy uploaded, scenes reach the model, the edit is ONE undo step', async () => {
      await ev("window.__steps.length = 0; true");
      const before = await segs();
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.push(
        (body) => {
          const names = body.tools.map((t) => t.function.name);
          assert(names.includes('analyze_video') && !names.includes('find_in_video'), 'tools: ' + names.join(','));
          assert(/READING THE VIDEO/.test(body.messages[0].content), 'system prompt');
          return calls([['analyze_video', { query: 'dog' }]]);
        },
        (body) => {
          const tool = body.messages.filter((m) => m.role === 'tool').pop();
          const r = JSON.parse(tool.content);
          assert(r.ok === true && r.scene_count >= 3 && Array.isArray(r.matches) && r.matches.length >= 1, 'tool result: ' + tool.content.slice(0, 300));
          assert(!('ui' in r) && !tool.content.includes(KEY), 'clean tool result');
          const dog = r.scenes.find((s) => s.match);
          assert(/dog/i.test(dog.description), 'the matching scene is about the dog: ' + dog.description);
          return calls([['set_speed', { start: dog.start, end: dog.end, speed: 2 }]]);
        },
        () => text('Köpeğin olduğu sahneyi 2 kat hızlandırdım. Ctrl+Z ile geri alabilirsiniz.'),
      );
      await ask('köpeğin olduğu sahneyi hızlandır');
      await waitReply(beforeMsgs, 2);
      // native confirmation (test hook: logged and allowed)
      const up = dialogs().filter((d) => d.title === 'Videoyu analiz için yükle');
      assert(up.length === 1, 'one upload question: ' + JSON.stringify(dialogs()));
      assert(/A_audio_720p\.mp4 \(0:08\)/.test(up[0].message) && up[0].message.includes(mock.origin) && /aynı coğrafya/.test(up[0].detail), up[0].message);
      assert(up[0].buttons[0] === 'Yükle ve analiz et' && up[0].buttons[1] === 'İptal', JSON.stringify(up[0].buttons));
      // what was uploaded
      assert(mock.uploads.length === 1, 'uploads: ' + mock.uploads.length);
      const u0 = mock.uploads[0];
      assert(u0.headers['ocp-apim-subscription-key'] === KEY && !u0.headers.authorization, 'key header only');
      assert(u0.query.processingLocation === 'geography' && u0.query['api-version'] === '2025-11-01', JSON.stringify(u0.query));
      const proxy = path.join(os.tmpdir(), 've-cu-ui-upload.mp4');
      fs.writeFileSync(proxy, u0.bytes);
      const s = h.streamsOf(proxy);
      assert(s.v.height === 480 && s.v.width === 854, 'reduced picture: ' + s.v.width + 'x' + s.v.height);
      assert(s.a && Number(s.a.channels) === 1 && Number(s.a.sample_rate) === 16000, 'mono speech audio');
      near(s.duration, 8, 0.4, 'duration of the copy');
      assert(u0.bytes.length < 800 * 1024, 'small: ' + u0.bytes.length);
      fs.rmSync(proxy, { force: true });
      await sleep(300);
      assert(mock.deleted.length === 1, 'the service copy was deleted: ' + mock.deleted.length);
      // progress was shown, the model got the scenes, the edit is one step
      const phases = (await stepsLog()).filter((e) => e.kind === 'analysis').map((e) => e.phase);
      for (const p of ['start', 'plan', 'prepare', 'upload', 'wait', 'done']) assert(phases.includes(p), 'phase ' + p + ' in ' + phases.join(','));
      const after = await segs();
      assert(after.length === 2 && after[0].speed === 2 && after[1].speed === 1 && near(after[0].in, 0, 0.3, 'in') === undefined && near(after[0].out, 2, 0.3, 'out') === undefined, 'sped-up scene: ' + JSON.stringify(after));
      const m = (await dbg()).messages;
      const last = m[m.length - 1];
      assert(last.type === 'ai' && Array.isArray(last.analyses) && last.analyses[0].count >= 3 && last.analyses[0].uploaded === 1, JSON.stringify(last.analyses));
      assert(/Video analizi: \d+ sahne okundu · 1 parça yüklendi/.test(await ev("document.querySelector('#ai-log .ai-analysis summary').textContent")), 'analysis line');
      await app.screenshot(path.join(SHOTS, 'cu-ai-answer-tr-dark.png'));
      await ev('VE.actions.undo()');
      const undone = await segs();
      assert(undone.length === 1 && undone[0].speed === 1, 'ONE undo restores the timeline: ' + JSON.stringify(undone));
      await ev('VE.actions.redo()');
      // a click on a scene moves the playhead there
      await ev("document.querySelector('#ai-log .ai-analysis summary').click()");
      await sleep(150);
      await ev("document.querySelectorAll('#ai-log .ai-scene')[2].click()");
      await sleep(200);
      near(await ev('VE.state.S.playhead'), 4, 0.6, 'playhead at the third scene');
      await app.screenshot(path.join(SHOTS, 'cu-ai-scenes-tr-dark.png'));
      assert(!(chatRequests.some((b) => JSON.stringify(b).includes(KEY))), 'the key never goes to the chat endpoint inside a prompt');
    });

    await step('C05 the same video again: no question, no upload (results are kept on this computer)', async () => {
      const dialogsBefore = dialogs().length;
      const uploadsBefore = mock.uploads.length;
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.push(() => calls([['analyze_video', {}]]), (body) => {
        const r = JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content);
        assert(r.ok && r.cached === true && r.uploaded_parts === 0, 'cached: ' + JSON.stringify({ ok: r.ok, cached: r.cached }));
        return calls([['set_zoom', { start: r.scenes[0].start, end: r.scenes[0].end, mode: 'in' }]]);
      }, () => text('İlk sahneye yakınlaştırma ekledim.'));
      await ask('ilk sahneyi yakınlaştır');
      await waitReply(beforeMsgs, 2);
      assert(mock.uploads.length === uploadsBefore, 'no second upload');
      assert(dialogs().length === dialogsBefore, 'no second question');
      assert(/bu bilgisayardaki sonuçlardan/.test(await ev("[...document.querySelectorAll('#ai-log .ai-analysis summary')].pop().textContent")), 'shown as "from this computer"');
      const st = await ev('window.api.ai.status()');
      assert(st.cu.cache.files === 1 && st.cu.cache.bytes > 100, JSON.stringify(st.cu.cache));
      const files = fs.readdirSync(path.join(userData, 'cu-cache'));
      assert(files.length === 1 && /^[0-9a-f]{64}\.json$/.test(files[0]), files.join(','));
      const rec = fs.readFileSync(path.join(userData, 'cu-cache', files[0]), 'utf8');
      assert(!rec.includes(KEY) && !/A_audio_720p|C:\\\\/.test(rec), 'the cache holds no key and no file name');
    });

    /* ---------------- failures ---------------- */

    await step('C06 a service error becomes a plain answer; nothing is edited; the state is usable again', async () => {
      await ev('window.api.ai.cuClearCache()');
      mock.options.failOperation = { code: 'ModelDeploymentNotFound', message: 'Default model deployment for gpt-4.1 is not configured' };
      const before = await segs();
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.push(() => calls([['analyze_video', {}]]), (body) => {
        const tool = body.messages.filter((m) => m.role === 'tool').pop();
        assert(/model deployments/.test(tool.content) && /Content Understanding Studio/.test(tool.content) && !/ModelDeploymentNotFound|boom/.test(tool.content), 'sentence for the model: ' + tool.content);
        return text('Content Understanding için model dağıtımları ayarlı değil; Studio’da bir kez ayarlamanız gerekiyor.');
      });
      await ask('sahneleri bul');
      await waitReply(beforeMsgs, 2);
      assert(JSON.stringify(await segs()) === JSON.stringify(before), 'nothing edited');
      mock.options.failOperation = null;
      assert(!(await ev('VE.ai.debug().running')), 'idle again');
      assert((await ev('window.api.ai.status()')).cu.cache.files === 0, 'a failed analysis is not cached');
    });

    await step('C07 Stop during the analysis ends it at once: "cancelled", the service copy is deleted, the time limit does not matter', async () => {
      mock.options.polls = 100000;
      const deletedBefore = mock.deleted.length;
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.push(() => calls([['analyze_video', {}]]), () => text('(never reached)'));
      await ask('videoyu analiz et');
      await app.waitFor("(document.querySelector('[data-ai=\"working\"]') || { textContent: '' }).textContent.includes('analiz ediyor')", 20000, 'waiting for the service');
      await app.screenshot(path.join(SHOTS, 'cu-ai-working-tr-dark.png'));
      await app.click('#ai-send');
      await waitReply(beforeMsgs, 1);
      const m = (await dbg()).messages;
      assert(m[m.length - 1].type === 'info' && /İptal/.test(m[m.length - 1].text), 'cancelled message: ' + JSON.stringify(m[m.length - 1]));
      await sleep(500);
      assert(mock.deleted.length === deletedBefore + 1, 'deleted after cancel');
      mock.options.polls = 1;
      chatQueue.length = 0;
    });

    await step('C08 settings the page must not be able to change: ai.cu through settings:set is ignored; a CU address on another host is refused for key sign-in', async () => {
      await ev("window.api.setSettings({ ai: { cu: { enabled: false, endpoint: 'https://evil.example.com' } } })");
      const st = await ev('window.api.ai.status()');
      assert(st.cu.enabled && st.cu.endpoint === '', 'unchanged: ' + JSON.stringify(st.cu));
      await openSettings();
      await set('[data-ai="cu-endpoint"]', 'http://127.0.0.1:1');
      const r = await saveSettings();
      assert(/aynı olmalı/.test(r), 'mismatch refused: ' + r);
      assert((await ev('window.api.ai.status()')).cu.endpoint === '', 'not saved');
      await set('[data-ai="cu-endpoint"]', '');
      await set('[data-ai="cu-analyzer"]', 'bad analyzer name!');
      const r2 = await saveSettings();
      assert(/Çözümleyici adı/.test(r2), 'analyzer name refused: ' + r2);
      await set('[data-ai="cu-analyzer"]', 'prebuilt-videoSearch');
      await set('[data-ai="cu-location"]', 'dataZone');
      const r3 = await saveSettings();
      assert(/Video analizi hazır/.test(r3), r3);
      assert((await ev('window.api.ai.status()')).cu.location === 'dataZone', 'location saved');
      await set('[data-ai="cu-location"]', 'geography');
      await saveSettings();
      await closeModal();
    });

    /* ---------------- restart: declined upload ---------------- */

    await step('C09 after a restart the settings are kept; when the user declines the upload nothing is uploaded and the model says so', async () => {
      // Chromium writes the key of the OS encryption ("Local State") up to ~10 s after its first use; a kill before that loses it (the real app flushes on quit)
      await sleep(11000);
      await app.close();
      app = await launch({ userData, files: [fx.A], port: 9432, env: Object.assign({ VE_TEST_UPLOAD_CONFIRM: 'deny' }, env), keepUserData: true });
      await app.waitFor("VE.state.S.segments.length === 1", 25000, 'import');
      await sleep(400);
      const st = await ev('window.api.ai.status()');
      assert(st.cu.enabled && st.cu.ready && st.cu.location === 'geography', JSON.stringify(st));
      const uploadsBefore = mock.uploads.length;
      const dialogsBefore = dialogs().length;
      const before = await segs();
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.push(() => calls([['analyze_video', { query: 'dog' }]]), (body) => {
        const tool = body.messages.filter((m) => m.role === 'tool').pop();
        assert(/did not allow the upload/.test(tool.content), 'declined: ' + tool.content);
        return text('Yükleme izni verilmedi; hangi zaman aralığı olduğunu yazar mısınız?');
      });
      await app.click('#btn-ai');
      await sleep(300);
      await ask('köpeği yakınlaştır');
      await waitReply(beforeMsgs, 2);
      assert(mock.uploads.length === uploadsBefore, 'nothing uploaded');
      assert(dialogs().length === dialogsBefore + 1, 'the question was asked');
      assert(JSON.stringify(await segs()) === JSON.stringify(before), 'nothing edited');
    });

    await step('C10 secrets: the key is nowhere on disk or in the page, the dialogs do not show it, and the renderer still cannot reach the service', async () => {
      const hits = scanForKey(userData);
      assert(hits.length === 0, 'key found in: ' + hits.join(', '));
      assert(!(await ev('document.documentElement.innerHTML.includes(' + JSON.stringify(KEY) + ')')), 'key in the DOM');
      assert(!JSON.stringify(dialogs()).includes(KEY), 'key in a dialog');
      const reach = await ev(`fetch(${JSON.stringify(mock.origin + '/contentunderstanding/defaults')}).then(() => 'reached', () => 'blocked')`);
      assert(reach === 'blocked', 'renderer fetch: ' + reach);
      const tmpLeft = fs.readdirSync(os.tmpdir()).filter((n) => /^ve-cu-.*\.mp4$/.test(n));
      assert(tmpLeft.length === 0, 'no reduced copy left behind: ' + tmpLeft.join(','));
    });

    await step('C11 English UI: settings section and the answer card; light theme', async () => {
      await ev("document.querySelector('#lang-switch [data-lang=\"en\"]').click()");
      await sleep(300);
      await ev("window.api.ai.cuClearCache()");
      await openSettings();
      const t = await modalText();
      assert(/Video analysis \(Azure Content Understanding\)/.test(t) && /reduced copy/.test(t) && /Same geography \(recommended\)/.test(t), 'EN settings text');
      await ev("document.querySelector('#btn-theme').click()");
      await sleep(300);
      await app.screenshot(path.join(SHOTS, 'cu-settings-en-light.png'));
      await closeModal();
      await ev("document.querySelector('#btn-theme').click()");
    });
  } catch (e) {
    console.log('ABORTED: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    await app.close();
    await mock.stop();
  }
  summary('ui-cu');
})();
