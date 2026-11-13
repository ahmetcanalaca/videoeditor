'use strict';
// The in-browser assistant in a real browser, with stand-ins for its two workers (no download, no graphics card): the settings dialog (the panel with its three steps and
// the model choice), the question before a download (where from, what is stored) and a "no", the progress of a download and of loading the model, "download and use"
// (the assistant is tried once and remembered), a request that edits the timeline through the real agent loop and provider adapter, the loading shown while the model comes
// back after "free memory", what is said when the engine fails or the files are gone, deleting a download, a computer that cannot run it, and English / light.
// The real workers, the real download and a real model are tested by tests/ib-live.test.js.
//   node tests/ib-web.test.js        (VE_BROWSER=<chrome|edge exe>; needs ffmpeg for the test videos: see tests/lib/media-tools.js)
const os = require('os');
const path = require('path');
const { open, checker } = require('./lib/site');

const SHOTS = process.env.VE_SHOTS || path.join(os.tmpdir(), 've-web-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the stand-ins: installed in the page before the assistant is first used (window.__veTest is only honoured with ?vetest in the address)
const FAKE = (support) => `(() => {
  const T = window.__veTest = window.__veTest || {};
  const S = window.__ib = { installed: {}, loadMs: 0, installMs: 0, chatMs: 20, failChat: false, mode: '', obey: true, calls: [], chats: [], terminated: 0 };
  T.ibSupport = ${JSON.stringify(support)};
  const KEYS = ['qwen3.5-2b', 'qwen3.5-4b'];
  T.ibSpawn = (kind) => {
    const w = { onmessage: null, onerror: null, terminated: false };
    const say = (m, ms) => setTimeout(() => { if (!w.terminated && w.onmessage) w.onmessage({ data: m }); }, ms || 3);
    w.terminate = () => { w.terminated = true; S.terminated++; };
    w.postMessage = (m) => {
      S.calls.push({ kind, t: m.t, model: m.model });
      if (kind === 'dl') {
        if (m.t === 'status') say({ t: 'done', id: m.id, models: KEYS.map((k) => ({ key: k, bytes: 1000, bytesInstalled: S.installed[k] ? 1000 : 0, files: 3, filesInstalled: S.installed[k] ? 3 : 0, installed: !!S.installed[k] })), storage: { usage: 5e6, quota: 1e10, persisted: true }, installing: '' });
        else if (m.t === 'install') {
          const steps = 4;
          for (let i = 1; i <= steps; i++) say({ t: 'progress', id: m.id, loaded: i * 100, total: 400, file: 'f' + i, index: i, count: steps }, (S.installMs / steps) * i);
          setTimeout(() => { S.installed[m.model] = true; }, S.installMs);
          say({ t: 'done', id: m.id, downloaded: 400, total: 400 }, S.installMs + 5);
        } else if (m.t === 'remove') { S.installed[m.model] = false; say({ t: 'done', id: m.id, removed: 3 }); }
      } else if (m.t === 'load') {
        const steps = ['read', 'read', 'init', 'warm'];
        steps.forEach((p, i) => say({ t: 'progress', id: m.id, phase: p, loaded: (i + 1) * 100, total: 400 }, (S.loadMs / steps.length) * (i + 1)));
        say({ t: 'done', id: m.id, loaded: m.model }, S.loadMs + 5);
      } else if (m.t === 'chat') {
        S.chats.push(m);
        if (S.failChat) { say({ t: 'error', id: m.id, code: 'IB_ENGINE', message: 'gpu lost', detail: 'device lost' }, 5); return; }
        const last = m.messages[m.messages.length - 1];
        const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        let out;
        const nudged = /NOTHING HAS BEEN CHANGED/.test(text);
        if (/How long is the video/.test(text)) out = 'The video is 30 seconds long.';
        else if (/Video ne kadar uzun/.test(text)) out = 'Video 30 saniyedir.';
        else if (/^TOOL RESULTS/.test(text)) out = 'Done: the first 3 seconds are removed.';
        else if (S.mode === 'claim' && !nudged) out = 'Siltim.'; // a small model: says it is done and calls no tool
        else if (S.mode === 'claim' && nudged && !S.obey) out = 'Siltim yine.';
        else out = JSON.stringify({ tool_calls: [{ name: 'remove_range', arguments: { first_seconds: 3 } }] });
        say({ t: 'done', id: m.id, result: { text: out, promptTokens: 1500, completionTokens: 20, finish: 'stop', reused: 0, firstMs: 1, ms: 5 } }, S.chatMs);
      }
    };
    return w;
  };
  return true;
})()`;
const SUPPORTED = { ok: true, f16: true, maxBuffer: 2147483648, gpu: { vendor: 'test', architecture: 'test', description: 'Test GPU' }, memoryGB: 16 };

(async () => {
  const check = checker('web in-browser assistant (browser, stand-in workers)');
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const ev = (expr) => app.evaluate(expr);
  const A = path.basename(app.fixtures.A);
  const status = () => ev('window.api.ai.status()');
  const dialogs = () => ev('(window.__veDialogs || [])');
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out }))');
  const waitIdle = (ms) => app.waitFor('!VE.ai.isRunning()', ms || 60000, 'the assistant to finish');
  const panel = () => ev(`(() => {
    const p = document.querySelector('[data-ib=panel]');
    if (!p) return null;
    const sel = document.querySelector('.form-grid select');
    const step = (k) => { const s = p.querySelector('[data-ib-step=' + k + ']'); return s ? { state: s.getAttribute('data-state'), status: s.querySelector('.st').textContent, hidden: s.querySelector('.flw-body').hidden } : null; };
    const radios = Array.from(p.querySelectorAll('input[type=radio]')).map((r) => ({ key: r.value, checked: r.checked, disabled: r.disabled, label: r.closest('label').textContent.replace(/\\s+/g, ' ').trim() }));
    const btn = (n) => { const b = p.querySelector('[data-ib=' + n + ']'); return b ? { hidden: b.hidden, disabled: b.disabled, label: b.textContent.trim() } : null; };
    return {
      provider: sel && sel.value, options: sel ? Array.from(sel.options).map((o) => o.value) : [],
      title: p.querySelector('.llm-title').textContent, steps: { gpu: step('gpu'), model: step('model'), use: step('use') },
      radios, use: btn('use'), cancel: btn('cancel'), remove: btn('remove'), unload: btn('unload'),
      progress: p.querySelector('[data-ib=progress]').hidden ? '' : p.querySelector('[data-ib=progress]').textContent,
      bar: p.querySelector('[data-ib=bar]').hidden ? 0 : parseInt(p.querySelector('[data-ib=bar] i').style.width, 10),
      note: p.querySelector('[data-ib=gpu-note]').hidden ? '' : p.querySelector('[data-ib=gpu-note]').textContent,
      storage: p.querySelector('[data-ib=storage]').hidden ? '' : p.querySelector('[data-ib=storage]').textContent,
      visible: p.offsetParent !== null, urlRows: Array.from(document.querySelectorAll('.form-grid input[type=text]')).filter((i) => !i.hidden && i.offsetParent !== null).length,
      text: p.textContent,
    };
  })()`);
  const resultLine = () => ev(`(() => { const r = document.querySelector('.ai-result'); return r && !r.hidden ? { cls: r.className, text: r.textContent } : null; })()`);
  const calls = (kind, t) => ev(`window.__ib.calls.filter((c) => c.kind === ${JSON.stringify(kind)} && c.t === ${JSON.stringify(t)}).length`);

  try {
    check('01 no console errors on load', app.errors.length === 0, app.errors);
    await ev(FAKE(SUPPORTED));
    const s0 = await status();
    check('02 nothing is set up: the default is the model in this tab (no key, no address, nothing installed); no worker was started, nothing downloaded', s0.provider === 'inbrowser' && s0.needs === 'model' && !s0.ready && s0.credential === 'none' && s0.effectiveBaseUrl === '' && (await ev('window.__ib.calls.length')) === 0, s0);

    /* ---------------- the settings dialog ---------------- */
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-ib=panel]') && !!document.querySelector('[data-ib-step=gpu] .st') && document.querySelector('[data-ib-step=gpu]').getAttribute('data-state') === 'ok'", 10000, 'the panel');
    const p0 = await panel();
    check('03 the dialog opens on "AI in the browser" with its panel (three steps, no address / key form): this computer is ready (the graphics card is named), the recommended model is chosen', p0.visible && p0.provider === 'inbrowser' && p0.options[0] === 'inbrowser' && p0.title === 'Tarayıcıda yapay zekâ' && p0.urlRows === 0 && p0.steps.gpu.state === 'ok' && /Test GPU/.test(p0.steps.gpu.status) && p0.radios.length === 2 && p0.radios.find((r) => r.checked).key === 'qwen3.5-2b', p0);
    const lab = (i) => p0.radios[i].label.replace(/\u00a0/g, ' ');
    check('04 the two models are offered with a tier name, the model name, its size and how much memory it uses, and the recommended one says so', /Dengeli · Qwen3\.5 2B · 1[.,]\d GB.*Önerilen.*5 GB bellek/.test(lab(0)) && /En iyi · Qwen3\.5 4B · 2[.,]\d GB.*10 GB bellek/.test(lab(1)) && p0.radios.every((r) => /İndirilmedi/.test(r.label)), p0.radios.map((r) => r.label));
    check('05 the third step offers "download and use"; there is nothing to cancel, delete or free yet; the storage line says how much room there is; the note says nothing is sent', p0.use.label === 'İndir ve kullan' && !p0.use.disabled && p0.cancel.hidden && p0.remove.hidden && p0.unload.hidden && /Tarayıcı deposu/.test(p0.storage) && /Neler indirilir, neler gönderilir/.test(p0.text), { use: p0.use, storage: p0.storage });
    await app.screenshot(path.join(SHOTS, 'web-ib-01-panel-tr-dark.png'));

    /* ---------------- the question before a download ---------------- */
    await ev('window.__veAnswers = [1]');
    await app.click('[data-ib=use]');
    await app.waitFor("(window.__veDialogs || []).length === 1", 10000, 'the question before the download');
    await sleep(300);
    const d1 = (await dialogs())[0];
    const line1 = await resultLine();
    check('06 before anything is downloaded the person is asked: which model and how big, where from (Hugging Face, the commit), that the files are checked and stored in the browser, that the network may block it; "Vazgeç" downloads nothing and starts no worker', /Qwen3\.5 2B/.test(d1.message) && /1[.,]\d GB/.test(d1.message) && /huggingface\.co\/onnx-community\/Qwen3\.5-2B-ONNX-OPT/.test(d1.detail) && /SHA-256/.test(d1.detail) && /tarayıcı deposu/i.test(d1.detail) && /Kurumsal ağlar/.test(d1.detail) && d1.buttons.join() === 'İndir,Vazgeç' && (await calls('dl', 'install')) === 0 && (await calls('engine', 'load')) === 0 && /İptal edildi/.test(line1 && line1.text) && !(await status()).ready, { d1, line1 });

    /* ---------------- download, load, try, remember ---------------- */
    await ev('window.__ib.installMs = 900; window.__ib.loadMs = 900; window.__veAnswers = [0]');
    await app.click('[data-ib=use]');
    await app.waitFor("(document.querySelector('[data-ib=progress]') || {}).textContent && /İndiriliyor/.test(document.querySelector('[data-ib=progress]').textContent)", 10000, 'the download progress');
    const pDown = await panel();
    check('07 while the files come in: the progress says how much of how much and which file, a bar fills, the model choice is locked, the button turns into "İptal"', /İndiriliyor: .* \/ .* \(%\d+\) · dosya \d\/4/.test(pDown.progress) && pDown.bar > 0 && pDown.radios.every((r) => r.disabled) && !pDown.cancel.hidden && pDown.use.disabled && pDown.steps.use.state === 'busy', pDown);
    await app.waitFor("/belleğe okunuyor|ekran kartına yükleniyor|ilk kullanıma|deneniyor/i.test((document.querySelector('[data-ib=progress]') || {}).textContent || '')", 10000, 'loading the model');
    check('08 then the model is read into memory, put on the graphics card and tried (each said in turn)', (await panel()).progress.length > 0, (await panel()).progress);
    await app.waitFor("!!document.querySelector('.ai-result') && /Hazır/.test(document.querySelector('.ai-result').textContent)", 20000, 'ready');
    const line2 = await resultLine();
    const s1 = await status();
    const pReady = await panel();
    const stored = await ev('localStorage.getItem("ve.web.ai.v1")');
    check('09 ready: the assistant answered a question in words (shown to the person), the setup is remembered - the model only: no key, no address - and the assistant can look at pictures', line2.cls.includes('ok') && /Hazır\. Asistan şöyle yanıt verdi: “Video 30 saniyedir\.”/.test(line2.text) && s1.provider === 'inbrowser' && s1.model === 'qwen3.5-2b' && s1.ready && s1.vision === true && s1.credential === 'none' && !/127\.0\.0\.1|localhost|https?:|sk-|key/i.test(stored.replace(/"auth":"key"/, '')) && JSON.parse(stored).model === 'qwen3.5-2b', { line2, s1, stored });
    check('10 the panel shows it: the model is "in memory, ready" and the assistant uses it; "delete" and "free memory" are there now', /Asistan bunu kullanıyor/.test(pReady.radios[0].label) && !pReady.remove.hidden && !pReady.unload.hidden && pReady.steps.use.state === 'ok' && pReady.use.label === 'Kullan', pReady);
    check('11 one install and one load - the engine worker was started once, and the test question went through the real agent loop (a request with the assistant\'s own system prompt and the timeline summary)', (await calls('dl', 'install')) === 1 && (await calls('engine', 'load')) === 1 && (await ev('window.__ib.chats.length')) === 1 && (await ev('window.__ib.chats[0].messages.length')) === 2 && /timeline_summary/.test(await ev('window.__ib.chats[0].messages[1].content')), await ev('window.__ib.calls'));
    await app.screenshot(path.join(SHOTS, 'web-ib-02-ready-tr-dark.png'));
    await ev('VE.modal.close()');

    /* ---------------- a request that edits the timeline ---------------- */
    await app.stage([A]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1', 30000, 'one clip');
    await ev('VE.ai.open()');
    await sleep(300);
    const chatsBefore = await ev('window.__ib.chats.length');
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const after = await segs();
    const eng = await ev('window.__ib.chats.slice(' + chatsBefore + ')');
    check('12 "Cut the first 3 seconds": the first 3 seconds are cut out, the answer and the list of what was done are shown', after.length === 1 && Math.abs(after[0].in - 3) < 0.05 && (await ev('VE.ai.debug().messages.some((m) => m.type === "ai" && /3 seconds/.test(m.text) && m.actions.length === 1)')) === true, after);
    check('13 two requests went to the model (the tool call, then the answer after the tool\'s result); the tools are WRITTEN INTO the prompt (the model has no tool calling), including find_in_video: the model in this tab can look at pictures', eng.length === 2 && /HOW TO CALL TOOLS/.test(eng[0].messages[0].content) && /find_in_video/.test(eng[0].messages[0].content) && /^TOOL RESULTS/.test(eng[1].messages[eng[1].messages.length - 1].content) && eng.every((e) => e.images.length === 0 && e.maxNewTokens === 1024), eng.map((e) => e.messages.length));
    check('14 the model stayed loaded (no second load) and nothing but this site was ever requested (no Hugging Face, no third party: the download worker is a stand-in here)', (await calls('engine', 'load')) === 1 && app.requests.every((u) => u.startsWith(app.origin) || u.startsWith('data:') || u.startsWith('blob:')), app.requests.filter((u) => !u.startsWith(app.origin)));
    await app.key('z', { ctrl: true });
    await sleep(200);
    check('15 ONE Ctrl+Z undoes everything the assistant did', (await segs())[0].in === 0, await segs());

    /* ---------------- a small model that says "done" and calls no tool ---------------- */
    await ev("window.__ib.mode = 'claim'; window.__ib.obey = true; true");
    const c0 = await ev('window.__ib.chats.length');
    const hist0 = await ev('VE.ai.debug().history.length');
    await ev("VE.ai.send('İlk 3 saniyeyi sil')");
    await waitIdle();
    const engC = await ev('window.__ib.chats.slice(' + c0 + ')');
    const cardC = await ev('VE.ai.debug().messages[VE.ai.debug().messages.length - 1]');
    const lastOf = (e) => e.messages[e.messages.length - 1].content;
    check('15a it says "Siltim" (done) without a tool call: it is reminded once - the reminder names the request, the timeline is untouched until it calls the tool - then does the edit, and the card shows the real result', engC.length === 3 && /NOTHING HAS BEEN CHANGED/.test(lastOf(engC[1])) && lastOf(engC[1]).includes('"İlk 3 saniyeyi sil"') && engC[1].messages.length === 4 && engC[1].messages[2].role === 'assistant' && engC[1].messages[2].content === 'Siltim.' && /^TOOL RESULTS/.test(lastOf(engC[2])) && (await segs())[0].in > 2.9 && cardC.type === 'ai' && /Done: the first 3 seconds/.test(cardC.text) && cardC.actions.length === 1, { n: engC.length, cardC, segs: await segs() });
    check('15b the model in this tab gets every request on its own: although the chat has earlier turns, the first request holds the system prompt and this request only (a small model copies earlier answers that were written in words)', hist0 > 0 && engC[0].messages.length === 2 && engC[0].messages[0].role === 'system' && /User request:\s*İlk 3 saniyeyi sil/.test(engC[0].messages[1].content) && !/Cut the first 3 seconds/.test(JSON.stringify(engC[0].messages)), { hist0, n: engC[0].messages.length });
    await app.key('z', { ctrl: true });
    await sleep(200);
    await ev('window.__ib.obey = false; true');
    const c1 = await ev('window.__ib.chats.length');
    await ev("VE.ai.send('İlk 3 saniyeyi sil')");
    await waitIdle();
    const engD = await ev('window.__ib.chats.slice(' + c1 + ')');
    const cardD = await ev('VE.ai.debug().messages[VE.ai.debug().messages.length - 1]');
    check('15c when it still calls no tool after the reminder, its claim is not shown as if it were true: the timeline is untouched and the card says so honestly (one reminder only, no loop)', engD.length === 2 && (await segs())[0].in === 0 && cardD.type === 'ai' && /Bunu yapamadım: model bir düzenleme aracı çağırmadı, zaman çizelgesi değişmedi/.test(cardD.text) && !/Siltim/.test(cardD.text) && cardD.actions.length === 0, { n: engD.length, cardD });
    await ev("window.__ib.mode = ''; window.__ib.obey = true; true");

    /* ---------------- after "free memory" the model comes back by itself, and the screen says so ---------------- */
    await ev('window.__ib.loadMs = 1600');
    await ev('window.api.ib.unload()');
    check('16 "free memory" ends the engine worker (the files stay)', (await ev('window.__ib.terminated')) === 1 && (await ev('window.api.ib.state().then((s) => s.loaded)')) === '' && (await ev('window.api.ib.state().then((s) => s.models.find((m) => m.key === "qwen3.5-2b").installed)')) === true, null);
    // (not awaited: the evaluation of a promise would wait for the whole request, and the loading text is gone by then)
    await ev("(() => { VE.ai.send('Cut the first 3 seconds'); return true; })()");
    await app.waitFor("/okunuyor|yükleniyor|hazırlanıyor/.test((document.querySelector('#ai-log .ai-working') || {}).textContent || '')", 10000, 'the loading text in the assistant');
    const live = await ev("document.querySelector('#ai-log .ai-working').textContent");
    await waitIdle();
    check('17 the next request loads it again while the assistant says what is happening (reading into memory / onto the graphics card / getting ready), then does the edit', /belleğe okunuyor|ekran kartına yükleniyor|ilk kullanıma hazırlanıyor/.test(live) && (await calls('engine', 'load')) === 2 && (await segs())[0].in > 2.9, { live, loads: await calls('engine', 'load'), segs: await segs() });
    await app.key('z', { ctrl: true });
    await sleep(200);

    /* ---------------- failures ---------------- */
    await ev('window.__ib.failChat = true');
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const err1 = await ev('VE.ai.debug().messages[VE.ai.debug().messages.length - 1]');
    check('18 the engine fails (a lost graphics device): the timeline is untouched, the card says what to do in words - no stack, no code soup - and the model counts as unloaded', err1.type === 'error' && err1.code === 'IB_ENGINE' && /Model yanıt veremedi/.test(err1.text) && (await segs())[0].in === 0 && (await ev('window.api.ib.state().then((s) => s.loaded)')) === '', err1);
    await ev('window.__ib.failChat = false');
    await ev("window.__ib.installed['qwen3.5-2b'] = false");
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const err2 = await ev('VE.ai.debug().messages[VE.ai.debug().messages.length - 1]');
    const loadsNow = await calls('engine', 'load');
    check('19 the files are gone from the browser\'s storage: the request says so before anything is loaded ("not downloaded"), and points to the settings', err2.type === 'error' && err2.code === 'IB_NOT_INSTALLED' && /indirilmemiş/.test(err2.text) && loadsNow === 2 && (await segs())[0].in === 0, { err2, loadsNow });
    await ev('VE.ai.close()');

    /* ---------------- delete a download ---------------- */
    await ev("window.__ib.installed['qwen3.5-2b'] = true");
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-ib=remove]') && !document.querySelector('[data-ib=remove]').hidden", 10000, 'the delete button');
    const askedBefore = (await dialogs()).length;
    await ev('window.__veAnswers = [1]; true');
    await app.click('[data-ib=remove]');
    await app.waitFor(`(window.__veDialogs || []).length === ${askedBefore + 1}`, 10000, 'the question before deleting');
    await sleep(300);
    const dRemove = (await dialogs())[askedBefore];
    check('20 "İndirileni sil" asks first (which model, that it would have to be downloaded again); "Vazgeç" deletes nothing', (await calls('dl', 'remove')) === 0 && /Qwen3\.5 2B/.test(dRemove.message) && /silinsin/.test(dRemove.message) && /yeniden indirilir/.test(dRemove.detail) && dRemove.buttons.join() === 'Sil,Vazgeç' && (await ev('window.__ib.installed["qwen3.5-2b"]')) === true, dRemove);
    await ev('window.__veAnswers = [0]; true');
    await app.click('[data-ib=remove]');
    await app.waitFor("window.__ib.installed['qwen3.5-2b'] === false", 10000, 'the files to be deleted');
    await app.waitFor("window.api.ai.status().then((s) => s.model === '')", 10000, 'the model of the assistant to be forgotten');
    await app.waitFor("!!document.querySelector('.ai-result') && /silindi/.test(document.querySelector('.ai-result').textContent)", 10000, 'the result line');
    const s2 = await status();
    check('21 deleting removes the files, forgets the model of the assistant (it is not ready any more) and says so', (await calls('dl', 'remove')) === 1 && s2.model === '' && !s2.ready && /silindi/.test((await resultLine()).text) && (await ev('window.__ib.installed["qwen3.5-2b"]')) === false, { s2, line: await resultLine() });
    await ev('VE.modal.close()');

    /* ---------------- English, light ---------------- */
    await app.click('#lang-switch button[data-lang=en]');
    await app.click('#btn-theme');
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-ib=panel]') && document.querySelector('[data-ib-step=gpu]').getAttribute('data-state') === 'ok'", 10000, 'the panel (English)');
    const pEn = await panel();
    check('22 in English: title, step names, tiers, buttons and the note are English', pEn.title === 'AI in the browser' && /Computer/.test(pEn.text) && /Balanced · Qwen3\.5 2B/.test(pEn.radios[0].label) && /Recommended/.test(pEn.radios[0].label) && /Best · Qwen3\.5 4B/.test(pEn.radios[1].label) && /Not downloaded/.test(pEn.radios[0].label) && pEn.use.label === 'Download and use' && /What is downloaded, what is sent\?/.test(pEn.text) && !/[ğüşıöçĞÜŞİÖÇ]/.test(pEn.text), { title: pEn.title, use: pEn.use, text: pEn.text.slice(0, 160) });
    await app.screenshot(path.join(SHOTS, 'web-ib-03-panel-en-light.png'));
    await ev('VE.modal.close()');
    await app.click('#lang-switch button[data-lang=tr]');
    await app.click('#btn-theme');
    check('23 no console errors during the whole run', app.errors.length === 0, app.errors);

    /* ---------------- a computer that cannot run it ---------------- */
    // (a project with unsaved changes makes the page ask before it is left: the test's project is thrown away)
    await ev('VE.state.S.dirty = false; true');
    await app.navigate(app.origin + app.server.base + 'index.html?vetest', "typeof VE !== 'undefined' && !!VE.actions");
    await ev(FAKE({ ok: false, code: 'IB_NO_F16', f16: false, maxBuffer: 2147483648, gpu: { vendor: 'test', architecture: 'old', description: 'Old GPU' }, memoryGB: 4 }));
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-ib=panel]') && document.querySelector('[data-ib-step=gpu]').getAttribute('data-state') === 'warn'", 10000, 'the warning');
    const pBad = await panel();
    check('24 a graphics card without 16-bit shaders: step 1 warns and says why in words, the model choice and the button are closed, nothing is started', pBad.steps.gpu.state === 'warn' && /16 bit/.test(pBad.note) && pBad.steps.model.state === 'off' && pBad.steps.model.hidden === true && pBad.steps.use.hidden === true && (await ev('window.__ib.calls.length')) === 0, pBad);
    await ev('VE.modal.close()');
    await app.navigate(app.origin + app.server.base + 'index.html?vetest', "typeof VE !== 'undefined' && !!VE.actions");
    await ev(FAKE({ ok: true, f16: true, maxBuffer: 2147483648, gpu: { vendor: 'test', architecture: 'small', description: 'Small PC GPU' }, memoryGB: 4 }));
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-ib=panel]') && document.querySelector('[data-ib-step=gpu]').getAttribute('data-state') === 'ok'", 10000, 'the panel (small computer)');
    const pSmall = await panel();
    check('25 a computer that reports little memory: the balanced model stays the recommended one, and the panel warns in words how much memory it needs (about 5 GB) and what to do', pSmall.radios.find((r) => r.checked).key === 'qwen3.5-2b' && /4 GB/.test(pSmall.note) && /5 GB/.test(pSmall.note) && /Belleği boşalt/.test(pSmall.note), { checked: pSmall.radios.find((r) => r.checked).key, note: pSmall.note });
    await ev('VE.modal.close()');
    check('26 no console errors on the other computers', app.errors.length === 0, app.errors);
  } catch (e) {
    check('ib-web test ran to the end', false, String((e && e.stack) || e));
  } finally {
    await app.close();
  }
  process.exitCode = check.summary() ? process.exitCode : 1;
})().catch((e) => { console.error('ib-web test crashed:', e); process.exit(1); });
