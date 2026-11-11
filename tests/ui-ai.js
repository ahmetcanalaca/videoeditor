'use strict';
// UI scenario: the AI assistant in the real app (CDP) against a local mock LLM server (OpenAI-compatible, 127.0.0.1).
// Covers: inactive state without a key, key entry + encrypted storage, agent runs applied as ONE undo step, history, errors, cancel,
// stale results, export tools, keyboard, context menu, key bound to its endpoint, restart persistence, export of the agent's edits.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, h } = require('./ui-helpers');

const KEY = 'TEST_KEY_not_a_real_secret_0123456789';
const SHOTS = path.join(OUT, 'shots');
const EXPORT_DIR = path.join(OUT, 'ai-export');
const EXPORT_FILE = path.join(EXPORT_DIR, 'ai-düzenlendi.mp4');

/* ---------------------------------------------------------------- mock LLM */

const llm = { requests: [], queue: [], url: '', port: 0, server: null, fallback: null };
const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const calls = (list) => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } } });
const agentCalls = () => llm.requests.filter((r) => r.method === 'POST' && r.body && Array.isArray(r.body.tools));

function startLlm() {
  llm.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* GET */ }
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      llm.requests.push(entry);
      let spec;
      if (req.method === 'GET' && /\/models$/.test(req.url)) spec = { json: { data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] } };
      else if (body && !body.tools) spec = text('OK'); // connection test
      else spec = llm.queue.length ? llm.queue.shift() : text('(no script)');
      const respond = () => {
        if (spec.destroy) { req.socket.destroy(); return; }
        if (spec.hang) return;
        res.writeHead(spec.status || 200, Object.assign({ 'content-type': 'application/json' }, spec.headers || {}));
        res.end(spec.text !== undefined ? spec.text : JSON.stringify(spec.json));
      };
      if (spec.delay) setTimeout(respond, spec.delay); else respond();
    });
  });
  return new Promise((resolve) => llm.server.listen(0, '127.0.0.1', () => { llm.port = llm.server.address().port; llm.url = 'http://127.0.0.1:' + llm.port; resolve(); }));
}

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

(async () => {
  const fx = h.makeFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  await startLlm();

  const userData = ud('ai');
  let app = await launch({ userData, files: [fx.A, fx.B], port: 9421, env: { VE_TEST_EXPORT_PATH: EXPORT_FILE } });
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ id: s.id, mediaId: s.mediaId, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const total = () => ev('VE.state.layout().total');
  const dbg = () => ev('VE.ai.debug()');
  const msgCount = async () => (await dbg()).messages.length;
  const modalText = () => ev("(document.querySelector('#modal-root .modal') || { textContent: '' }).textContent");
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  const waitReply = async (before, n) => app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + (n || 2)}; })()`, 25000, 'assistant reply');
  const lastMsg = async () => { const d = await dbg(); return d.messages[d.messages.length - 1]; };
  const fillSettings = (o) => ev(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const m = document.querySelector('#modal-root .modal');
    const sel = m.querySelector('select'); const ins = [...m.querySelectorAll('.form-grid input[type="text"]')]; const key = m.querySelector('input[type="password"]');
    ${o.provider ? `set(sel, ${JSON.stringify(o.provider)});` : ''}
    ${o.url !== undefined ? `set(ins[0], ${JSON.stringify(o.url)});` : ''}
    ${o.model !== undefined ? `set(ins[2], ${JSON.stringify(o.model)});` : ''}
    ${o.key !== undefined ? `set(key, ${JSON.stringify(o.key)});` : ''}
  })()`);
  const saveSettings = async () => {
    await ev("document.querySelector('#modal-root .modal-foot .btn.primary').click()");
    await app.waitFor("(() => { const r = document.querySelector('#modal-root .ai-result'); return !!r && !r.hidden && !r.classList.contains('busy'); })()", 20000, 'settings result');
    return ev("document.querySelector('#modal-root .ai-result').textContent");
  };
  const closeModal = async () => { await ev("(document.querySelector('#modal-root .modal-head .btn') || { click() {} }).click()"); await sleep(150); };

  try {
    await app.waitFor("VE.state.S.segments.length === 2 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import + thumbnails');
    await sleep(300);
    const orig = await segs();

    /* ---------------- no key: inactive ---------------- */

    await step('A01 without a key the AI part is deactivated and nothing goes out', async () => {
      assert((await ev("document.querySelector('#btn-ai').dataset.state")) === 'off', 'button state');
      assert(await ev("document.querySelector('#ai-pane').hidden"), 'pane must start closed');
      await app.click('#btn-ai');
      await sleep(400);
      assert(!(await ev("document.querySelector('#ai-pane').hidden")), 'pane did not open');
      assert(!(await ev("document.querySelector('#ai-banner').hidden")), 'setup banner missing');
      assert(await ev("document.querySelector('#ai-input').disabled"), 'input must be disabled');
      assert(await ev("document.querySelector('#ai-send').disabled"), 'send must be disabled');
      assert((await ev("document.querySelector('#ai-input').placeholder")) === 'Önce AI ayarlarını tamamlayın', 'placeholder');
      assert((await ev("document.querySelector('#ai-banner-title').textContent")) === 'Yerel yapay zekâ modeli kurulu değil', 'a fresh profile starts with the built-in model, which is not installed yet');
      assert((await ev("document.querySelector('#ai-state').textContent")) === 'Devre dışı', 'state chip');
      assert(await ev("document.querySelector('#inspector').inert"), 'inspector must be inert behind the pane');
      await ev("VE.ai.send('merhaba')");
      await sleep(400);
      assert(llm.requests.length === 0, 'a request was sent without a key: ' + llm.requests.length);
      const st = await ev('window.api.ai.status()');
      assert(st.hasKey === false && st.ready === false, JSON.stringify(st));
      await app.screenshot(path.join(SHOTS, 'tr-dark-ai-off.png'));
    });

    await step('A02 the renderer itself still cannot reach the network (CSP + blocked default session)', async () => {
      const r = await ev(`fetch(${JSON.stringify(llm.url + '/v1/models')}).then(() => 'reached', (e) => 'blocked')`);
      assert(r === 'blocked', 'renderer fetch result: ' + r);
      await sleep(200);
      assert(llm.requests.length === 0, 'the renderer reached the mock server');
    });

    await step('A03 Ctrl+K toggles the pane', async () => {
      await app.evaluate('document.activeElement && document.activeElement.blur()');
      await app.key('k', { ctrl: true });
      await sleep(250);
      assert(await ev("document.querySelector('#ai-pane').hidden"), 'Ctrl+K did not close the pane');
      await app.key('k', { ctrl: true });
      await sleep(250);
      assert(!(await ev("document.querySelector('#ai-pane').hidden")), 'Ctrl+K did not open the pane');
    });

    /* ---------------- settings + key ---------------- */

    await step('A04 settings dialog validates the endpoint and the key before anything is stored', async () => {
      await app.click('#ai-banner-btn');
      await app.waitFor("!!document.querySelector('#modal-root .modal input[type=\"password\"]')", 5000, 'settings dialog');
      await fillSettings({ provider: 'openai', url: 'http://example.com/v1', model: 'm', key: KEY });
      let msg = await saveSettings();
      assert(/https:\/\//.test(msg), 'scheme error expected, got: ' + msg);
      await fillSettings({ url: llm.url + '/v1', key: 'has a space' });
      msg = await saveSettings();
      assert(/geçersiz karakter/.test(msg), 'key error expected, got: ' + msg);
      assert(llm.requests.length === 0, 'requests were sent for invalid input');
      assert((await ev('window.api.ai.status()')).hasKey === false, 'an invalid key was stored');
    });

    await step('A05 save and test: models listed, ping sent with the key only in the Authorization header, key leaves the DOM', async () => {
      await fillSettings({ url: llm.url + '/v1', model: 'mock-model', key: KEY });
      const msg = await saveSettings();
      assert(/Bağlantı ve model çalışıyor/.test(msg), 'result: ' + msg);
      const list = llm.requests.filter((r) => r.method === 'GET');
      const ping = llm.requests.filter((r) => r.method === 'POST');
      assert(list.length === 1 && list[0].url === '/v1/models' && list[0].headers.authorization === 'Bearer ' + KEY, 'models request');
      assert(ping.length === 1 && ping[0].url === '/v1/chat/completions' && ping[0].body.model === 'mock-model', 'ping request');
      assert(!JSON.stringify(llm.requests.map((r) => r.body)).includes(KEY), 'key in a request body');
      assert(!JSON.stringify(llm.requests.map((r) => r.url)).includes(KEY), 'key in a URL');
      assert((await ev("document.querySelector('#modal-root input[type=\"password\"]').value")) === '', 'key must be cleared from the input');
      assert(/6789/.test(await modalText()) && !(await modalText()).includes(KEY), 'masked hint expected');
      const options = await ev("[...document.querySelectorAll('#ai-models option')].map((o) => o.value)");
      assert(options.includes('mock-model') && options.includes('mock-model-mini'), 'model suggestions ' + JSON.stringify(options));
      assert(!(await ev('document.documentElement.outerHTML')).includes(KEY), 'key found in the DOM');
      assert(!JSON.stringify(await ev('window.api.ai.status()')).includes(KEY), 'key found in status');
      await app.screenshot(path.join(SHOTS, 'tr-dark-ai-settings.png'));
      await closeModal();
      assert((await ev("document.querySelector('#ai-state').textContent")) === 'Hazır', 'state chip after setup');
      assert((await ev("document.querySelector('#btn-ai').dataset.state")) === 'ready', 'button state');
      assert(await ev("document.querySelector('#ai-banner').hidden"), 'banner must be hidden');
      assert(!(await ev("document.querySelector('#ai-input').disabled")), 'input must be enabled');
    });

    await step('A06 on disk: the key file is encrypted, settings.json has no key, no file in the profile contains it', async () => {
      const keyFile = path.join(userData, 'ai-key.json');
      assert(fs.existsSync(keyFile), 'ai-key.json missing');
      const raw = fs.readFileSync(keyFile, 'utf8');
      assert(!raw.includes(KEY) && JSON.parse(raw).enc === 'safeStorage', 'key file is not encrypted: ' + raw.slice(0, 80));
      await sleep(700);
      const settings = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8');
      assert(!settings.includes(KEY) && !/apiKey/i.test(settings), 'settings.json contains key material');
      const j = JSON.parse(settings);
      assert(j.ai.provider === 'openai' && j.ai.model === 'mock-model' && !('keyFor' in j.ai), 'ai settings ' + JSON.stringify(j.ai));
      const hits = scanForKey(userData);
      assert(hits.length === 0, 'the key was found in: ' + hits.join(', '));
    });

    /* ---------------- agent run ---------------- */

    await step('A07 a request applies the tool calls (ORIGINAL times) as ONE undo step; the pane shows the answer and the actions', async () => {
      llm.requests.length = 0;
      llm.queue.push(calls([['remove_range', { start: 0, end: 2 }], ['set_speed', { start: 4, end: 6, speed: 2 }], ['set_zoom', { start: 6, end: 7, mode: 'in', factor: 2, focus: 'top-left' }]]));
      llm.queue.push(text('İlk 2 saniyeyi kestim, 0:04–0:06 aralığını 2× hızlandırdım ve 0:06–0:07 aralığında yakınlaştırdım. Ctrl+Z ile geri alabilirsiniz.'));
      const before = await msgCount();
      await ask('ilk 2 saniyeyi kes, 4 ile 6. saniye arasını 2 kat hızlandır, 6-7 arası yakınlaştır');
      await waitReply(before);
      const list = await segs();
      assert(list.length === 5, 'segments: ' + list.length + ' ' + JSON.stringify(list));
      near(await total(), 10, 0.001, 'total');
      const a = list.filter((s) => s.mediaId === orig[0].mediaId);
      near(a[0].in, 2, 1e-6); near(a[0].out, 4, 1e-6);
      near(a[1].in, 4, 1e-6); near(a[1].out, 6, 1e-6); assert(a[1].speed === 2, 'speed');
      near(a[2].in, 6, 1e-6); near(a[2].out, 7, 1e-6); near(a[2].zoomTo, 2, 1e-6); near(a[2].fx, 0.25, 1e-6);
      const reqs = agentCalls();
      assert(reqs.length === 2, 'agent requests: ' + reqs.length);
      assert(reqs[0].body.tools.length === require('../src/shared/agent-ops').TOOL_DEFS.length && reqs[0].body.model === 'mock-model', 'tools/model');
      const sys = reqs[0].body.messages[0];
      const user = reqs[0].body.messages[reqs[0].body.messages.length - 1].content;
      assert(sys.role === 'system' && /ORIGINAL timeline/.test(sys.content), 'system prompt');
      assert(/<timeline_summary>/.test(user) && /A_audio_720p\.mp4/.test(user) && /4 ile 6/.test(user), 'timeline summary: ' + user.slice(0, 200));
      assert(reqs[1].body.messages.filter((m) => m.role === 'tool').length === 3, 'tool results were not sent back');
      assert(!JSON.stringify(llm.requests.map((r) => r.body)).includes(KEY), 'key in a body');
      const last = await lastMsg();
      assert(last.type === 'ai' && /Ctrl\+Z/.test(last.text) && last.actions.length === 3, JSON.stringify(last));
      const dom = await ev("({ user: document.querySelectorAll('.ai-msg.user').length, ai: document.querySelectorAll('.ai-msg.ai:not(.live)').length, acts: [...document.querySelectorAll('.ai-msg.ai .ai-actions li')].map((l) => l.textContent), undo: !document.querySelector('#ai-undo-row').hidden })");
      assert(dom.user === 1 && dom.ai === 1 && dom.acts.length === 3 && dom.undo, JSON.stringify(dom));
      assert(/Kaldırıldı: 00:00–00:02/.test(dom.acts[0]) && /Hız 2×: 00:04–00:06/.test(dom.acts[1]) && /Zoom 1×→2×: 00:06–00:07/.test(dom.acts[2]), dom.acts.join(' | '));
      await app.screenshot(path.join(SHOTS, 'tr-dark-ai-chat.png'));
    });

    await step('A08 ONE Ctrl+Z reverts the whole request; Ctrl+Y brings it back; the Undo button follows the state', async () => {
      await ev('document.activeElement && document.activeElement.blur()');
      await app.key('z', { ctrl: true });
      await sleep(250);
      let list = await segs();
      assert(list.length === 2 && Math.abs(list[0].in - orig[0].in) < 1e-9 && Math.abs(list[0].out - orig[0].out) < 1e-9, 'one undo must restore the original: ' + JSON.stringify(list));
      assert(await ev("document.querySelector('#ai-undo-row').hidden"), 'undo button must hide after undo');
      await app.key('y', { ctrl: true });
      await sleep(250);
      list = await segs();
      assert(list.length === 5, 'redo: ' + list.length);
      assert(!(await ev("document.querySelector('#ai-undo-row').hidden")), 'undo button must be back after redo');
      await app.click('#ai-undo');
      await sleep(250);
      assert((await segs()).length === 2, 'the Undo button must undo the request');
      await app.key('y', { ctrl: true });
      await sleep(250);
      assert((await segs()).length === 5, 'redo after the button');
    });

    await step('A09 a second request carries the earlier turn as plain text and a fresh timeline summary', async () => {
      llm.requests.length = 0;
      llm.queue.push(text('Hangi klibi yavaşlatmamı istersiniz?'));
      const before = await msgCount();
      await ask('şimdi biraz yavaşlat');
      await waitReply(before);
      const req = agentCalls()[0];
      const m = req.body.messages;
      assert(m[1].role === 'user' && /ilk 2 saniyeyi kes/.test(m[1].content) && m[2].role === 'assistant' && /Ctrl\+Z/.test(m[2].content), 'history ' + JSON.stringify(m.slice(1, 3)).slice(0, 300));
      assert(!m.some((x) => x.role === 'tool' || x.tool_calls), 'tool traces must not be replayed');
      const summary = JSON.parse(/<timeline_summary>\n([\s\S]*?)\n<\/timeline_summary>/.exec(m[m.length - 1].content)[1]);
      assert(summary.clip_count === 5, 'fresh summary: ' + summary.clip_count);
      assert((await segs()).length === 5, 'a question must not change the timeline');
      assert(await ev("document.querySelector('#ai-undo-row').hidden") === false, 'undo of the earlier request is still current');
    });

    await step('A10 exporting the agent\'s edit gives the expected video (ffprobe)', async () => {
      await ev('document.activeElement && document.activeElement.blur()');
      await app.key('e', { ctrl: true });
      await app.waitFor("!!document.querySelector('#modal-root .modal')", 5000, 'export dialog');
      await app.click('#modal-root .path-row .btn');
      await sleep(300);
      await ev("document.querySelector('#modal-root .btn.primary').click()");
      await app.waitFor("!!document.querySelector('#modal-root .result.ok')", 90000, 'export result');
      assert(fs.existsSync(EXPORT_FILE), 'export missing');
      const info = h.streamsOf(EXPORT_FILE);
      near(info.duration, 10, 0.25, 'exported duration');
      assert(info.v && info.a, 'streams');
      await closeModal();
    });

    /* ---------------- errors, cancel, stale ---------------- */

    const failing = async (specFactory, expected, label) => {
      llm.requests.length = 0;
      for (let i = 0; i < 4; i++) llm.queue.push(specFactory());
      const before = await msgCount();
      await ask('bir şey yap');
      await waitReply(before);
      const last = await lastMsg();
      assert(last.type === 'error' && expected.test(last.text), label + ': ' + JSON.stringify(last));
      assert((await segs()).length === 5, label + ': the timeline must not change');
      llm.queue.length = 0;
      return last;
    };

    await step('A11 provider errors are explained in Turkish, with a settings shortcut for key problems; nothing changes', async () => {
      const e401 = await failing(() => ({ status: 401, json: { error: { message: 'Incorrect API key provided: ' + KEY } } }), /API anahtarı geçersiz/, '401');
      assert(e401.code === 'AUTH' && !JSON.stringify(e401).includes(KEY), 'detail must not contain the key');
      assert(await ev("[...document.querySelectorAll('.ai-msg.err .btn')].some((b) => /Ayarları aç/.test(b.textContent))"), 'settings shortcut missing');
      assert(llm.requests.length === 1, '401 must not be retried: ' + llm.requests.length);
      await failing(() => ({ status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } }), /Hız sınırı/, '429');
      assert(llm.requests.length === 3, '429 should be retried twice: ' + llm.requests.length);
      await failing(() => ({ status: 500, json: { error: { message: 'oops' } } }), /yanıt veremiyor/, '500');
      await failing(() => ({ status: 200, text: '<html>not json</html>' }), /beklenmeyen bir yanıt/, 'bad json');
      await failing(() => ({ destroy: true }), /ulaşılamadı/, 'dropped connection');
      await failing(() => ({ status: 404, json: { error: { message: 'model not found' } } }), /Model veya uç nokta bulunamadı/, '404');
      await failing(() => ({ status: 429, json: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } }), /Kota veya bakiye/, 'quota');
      await app.screenshot(path.join(SHOTS, 'tr-dark-ai-errors.png'));
    });

    await step('A12 Stop cancels a running request: nothing applied, the pane is usable again', async () => {
      llm.requests.length = 0;
      llm.queue.push({ hang: true });
      const before = await msgCount();
      await ask('uzun iş');
      await app.waitFor('VE.ai.isRunning()', 5000, 'running');
      assert((await ev("document.querySelector('#ai-send').classList.contains('stop')")), 'send button must become Stop');
      assert((await ev("document.querySelector('#ai-state').textContent")) === 'Çalışıyor…', 'busy chip');
      assert(await ev("document.querySelector('#ai-input').disabled"), 'input disabled while running');
      await app.click('#ai-send');
      await waitReply(before);
      const last = await lastMsg();
      assert(last.type === 'info' && /İptal edildi/.test(last.text), JSON.stringify(last));
      assert((await segs()).length === 5, 'cancelled request changed the timeline');
      llm.queue.push(text('Tamam.'));
      const b2 = await msgCount();
      await ask('merhaba');
      await waitReply(b2);
      assert((await lastMsg()).text === 'Tamam.', 'pane not usable after cancel');
    });

    await step('A13 a result is discarded when the timeline changed while the assistant was working', async () => {
      llm.requests.length = 0;
      llm.queue.push(Object.assign(calls([['remove_range', { start: 0, end: 1 }]]), { delay: 900 }));
      llm.queue.push(text('Kestim.'));
      const before = await msgCount();
      await ask('ilk saniyeyi kes');
      await app.waitFor('VE.ai.isRunning()', 5000, 'running');
      await ev(`VE.actions.updateSegment(VE.state.S.segments[0].id, { volume: 0.5 })`);
      await waitReply(before, 3);
      const msgs = (await dbg()).messages;
      assert(msgs[msgs.length - 1].type === 'info' && /zaman çizelgesi değiştiği için/.test(msgs[msgs.length - 1].text), JSON.stringify(msgs.slice(-2)));
      assert((await segs()).length === 5, 'the stale result must not be applied');
      assert((await ev('VE.state.S.segments[0].volume')) === 0.5, 'the manual edit must survive');
    });

    await step('A14 export tools: settings change and the export dialog opens prefilled', async () => {
      llm.requests.length = 0;
      llm.queue.push(calls([['set_export_settings', { resolution: '1080', aspect: '9:16', quality: 'medium' }], ['open_export_dialog', {}]]));
      llm.queue.push(text('Dikey 1080p için hazırladım; dosyayı siz seçin.'));
      const before = await msgCount();
      await ask('dikey 1080p dışa aktar');
      await waitReply(before);
      await app.waitFor("!!document.querySelector('#modal-root .modal')", 5000, 'export dialog');
      const selects = await ev("[...document.querySelectorAll('#modal-root select')].map((s) => s.value)");
      assert(JSON.stringify(selects) === JSON.stringify(['1080', '9:16', 'auto', 'medium']), 'prefilled ' + JSON.stringify(selects));
      assert((await segs()).length === 5, 'no timeline change');
      await closeModal();
    });

    /* ---------------- keyboard, context menu ---------------- */

    await step('A15 keyboard: Shift+Enter makes a new line, Enter sends, Esc closes, Ctrl+Z in an empty box undoes the timeline', async () => {
      await ev("document.querySelector('#ai-input').focus()");
      await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.value = 'satır 1'; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const prevented = await ev(`(() => { const ta = document.querySelector('#ai-input'); const e = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }); ta.dispatchEvent(e); return e.defaultPrevented; })()`);
      assert(prevented === false, 'Shift+Enter must not be intercepted');
      await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const n = (await segs()).length;
      const undone = await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }); ta.dispatchEvent(e); return e.defaultPrevented; })()`);
      assert(undone === true, 'Ctrl+Z in the empty box must be handled by the app');
      await sleep(200);
      assert(JSON.stringify((await segs()).length) !== JSON.stringify(n) || (await ev('VE.state.canUndo()')) !== undefined, 'undo ran');
      await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); })()`);
      await sleep(250);
      assert(await ev("document.querySelector('#ai-pane').hidden"), 'Esc must close the pane');
      assert(!(await ev("document.querySelector('#inspector').inert")), 'inspector must be usable again');
      await ev('VE.ai.open()');
      await sleep(250);
    });

    await step('A16 the browser context menu stays off, except in text fields (paste an API key with the mouse)', async () => {
      const r = await ev(`(() => {
        const fire = (el) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
        return { body: fire(document.querySelector('#timeline-pane') || document.body), ta: fire(document.querySelector('#ai-input')) };
      })()`);
      assert(r.body === true && r.ta === false, JSON.stringify(r));
    });

    /* ---------------- language / theme screenshots ---------------- */

    await step('A17 English + light: pane texts follow the language, screenshots, 980x640 layout has no overflow', async () => {
      await app.click('#lang-switch button[data-lang=en]');
      await app.click('#btn-theme');
      await sleep(500);
      const t = await ev("({ title: document.querySelector('.ai-title').textContent, state: document.querySelector('#ai-state').textContent, ph: document.querySelector('#ai-input').placeholder, btn: document.querySelector('#btn-ai').title })");
      assert(t.title === 'AI Assistant' && t.state === 'Ready' && /cut 1:00/.test(t.ph) && /AI assistant/.test(t.btn), JSON.stringify(t));
      await app.screenshot(path.join(SHOTS, 'en-light-ai-chat.png'));
      await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 640, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
      const lay = await ev(`(() => {
        const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight, ai: r('#btn-ai'), exp: r('#btn-export'), lang: r('#lang-switch'), pane: r('#ai-pane'), input: r('#ai-input'), foot: r('.ai-foot'), title: r('#project-name') };
      })()`);
      assert(lay.sw <= lay.iw && lay.sh <= lay.ih, 'page overflows ' + JSON.stringify(lay));
      assert(lay.ai.r <= lay.exp.l + 1 && lay.lang.r <= lay.ai.l + 1, 'title bar buttons overlap ' + JSON.stringify(lay));
      assert(lay.pane.b <= lay.ih && lay.foot.b <= lay.pane.b + 1 && lay.input.r <= lay.pane.r, 'pane overflows ' + JSON.stringify(lay));
      await app.screenshot(path.join(SHOTS, 'layout-980x640-en-light-ai.png'));
      await app.cdp.send('Emulation.clearDeviceMetricsOverride');
      await app.click('#lang-switch button[data-lang=tr]');
      await app.click('#btn-theme');
      await sleep(400);
    });

    /* ---------------- key bound to endpoint, clear, restart ---------------- */

    await step('A18 changing the endpoint without a new key deletes the stored key (it is never sent elsewhere)', async () => {
      await app.click('#ai-settings');
      await app.waitFor("!!document.querySelector('#modal-root input[type=\"password\"]')", 5000, 'settings');
      await fillSettings({ url: 'http://localhost:' + llm.port + '/v1' });
      llm.requests.length = 0;
      const msg = await saveSettings();
      assert(/anahtar silindi/.test(msg), 'result: ' + msg);
      assert(llm.requests.length === 0, 'nothing may be sent to the new endpoint with the old key');
      const st = await ev('window.api.ai.status()');
      assert(st.hasKey === false && st.ready === false, JSON.stringify(st));
      assert(!fs.existsSync(path.join(userData, 'ai-key.json')), 'key file must be removed');
      assert(await ev("document.querySelector('#ai-input').disabled"), 'pane must be inactive again');
      await closeModal();
    });

    await step('A19 re-entering the key works; it survives an app restart (decrypted by Windows); deleting it removes the file', async () => {
      await app.click('#ai-banner-btn');
      await app.waitFor("!!document.querySelector('#modal-root input[type=\"password\"]')", 5000, 'settings');
      await fillSettings({ url: llm.url + '/v1', key: KEY, model: 'mock-model' });
      const msg = await saveSettings();
      assert(/Bağlantı ve model çalışıyor/.test(msg), msg);
      await closeModal();
      await sleep(600);
      await app.close();
      await sleep(500);
      app = await launch({ userData, files: [fx.A], port: 9422, keepUserData: true });
      await app.waitFor("VE.state.S.segments.length === 1", 25000, 'segment');
      await app.waitFor("(() => { const d = VE.ai.debug(); return !!d.status; })()", 8000, 'ai status');
      const st = await app.evaluate('window.api.ai.status()');
      assert(st.hasKey && st.ready && st.persisted && st.masked === '••••6789', JSON.stringify(st));
      assert(!JSON.stringify(st).includes(KEY), 'status leaks the key');
      llm.requests.length = 0;
      llm.queue.push(text('Merhaba!'));
      await app.evaluate("VE.ai.open()");
      await sleep(300);
      const before = (await app.evaluate('VE.ai.debug()')).messages.length;
      await app.evaluate(`(() => { const ta = document.querySelector('#ai-input'); ta.value = 'selam'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
      await app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + 2}; })()`, 20000, 'reply after restart');
      assert(agentCalls()[0].headers.authorization === 'Bearer ' + KEY, 'the restored key must be used');
      await app.click('#ai-settings');
      await app.waitFor("!!document.querySelector('#modal-root input[type=\"password\"]')", 5000, 'settings');
      await app.evaluate("[...document.querySelectorAll('#modal-root .modal-foot .btn')].find((b) => /Anahtarı sil/.test(b.textContent)).click()");
      await sleep(500);
      assert(!fs.existsSync(path.join(userData, 'ai-key.json')), 'key file must be gone after deleting the key');
      assert((await app.evaluate('window.api.ai.status()')).hasKey === false, 'key still present');
      assert((await app.evaluate("document.querySelector('#ai-input').disabled")) === true, 'pane must be inactive after deleting the key');
    });

    console.log('errors:', JSON.stringify(app.errors));
    await step('A20 no script errors or console errors during the whole run', async () => {
      assert(app.errors.length === 0, JSON.stringify(app.errors));
    });
  } finally {
    await app.close();
    await new Promise((r) => { llm.server.closeAllConnections(); llm.server.close(r); });
  }
  const failed = summary('ui-ai');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('UI-AI FAILED', e); process.exit(1); });
