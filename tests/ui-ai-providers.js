'use strict';
// UI scenario: Microsoft Foundry, the Azure portal "Target URI", Microsoft Entra ID through the Azure CLI (a FAKE az.cmd) and a LOCAL
// model without any key - in the real app (CDP) against a mock OpenAI-compatible server on 127.0.0.1.
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, h } = require('./ui-helpers');

const KEY = 'TEST_KEY_not_a_real_secret_0123456789';
const TOKEN_A = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoiQSJ9.dG9rZW4tQS1ub3QtcmVhbC1mb3ItdGVzdHM';
const TOKEN_B = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoiQiJ9.dG9rZW4tQi1ub3QtcmVhbC1mb3ItdGVzdHM';
const SHOTS = path.join(OUT, 'shots');
const FAKE_DIR = path.join(OUT, 'fake-az');
const FAKE_AZ = path.join(FAKE_DIR, 'az.cmd');
const J = (v) => JSON.stringify(v);

/* ---------------------------------------------------------------- mock LLM */

const llm = { requests: [], queue: [], pings: [], fallback: null, url: '', port: 0, server: null };
const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const calls = (list) => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } } });
const agentCalls = () => llm.requests.filter((r) => r.method === 'POST' && r.body && Array.isArray(r.body.tools));
const pingCalls = () => llm.requests.filter((r) => r.method === 'POST' && r.body && !r.body.tools);

function startLlm() {
  llm.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* GET */ }
      llm.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      let spec;
      if (req.method === 'GET') spec = /\/models$/.test(req.url) ? { json: { data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] } } : { status: 404, json: {} };
      else if (body && !body.tools) spec = llm.pings.length ? llm.pings.shift() : text('OK'); // connection test
      else spec = llm.queue.length ? llm.queue.shift() : (llm.fallback || text('(no script)'));
      if (spec.destroy) { req.socket.destroy(); return; }
      res.writeHead(spec.status || 200, { 'content-type': 'application/json' });
      res.end(spec.text !== undefined ? spec.text : JSON.stringify(spec.json));
    });
  });
  return new Promise((resolve) => llm.server.listen(0, '127.0.0.1', () => { llm.port = llm.server.address().port; llm.url = 'http://127.0.0.1:' + llm.port; resolve(); }));
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/* ---------------------------------------------------------------- fake Azure CLI */

const azCalls = () => (fs.existsSync(path.join(FAKE_DIR, 'calls.log')) ? fs.readFileSync(path.join(FAKE_DIR, 'calls.log'), 'utf8').split(/\r?\n/).filter(Boolean) : []);
const azReset = () => { fs.rmSync(path.join(FAKE_DIR, 'calls.log'), { force: true }); fs.rmSync(path.join(FAKE_DIR, 'mode-login'), { force: true }); };
function writeFakeAz() {
  fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  fs.writeFileSync(FAKE_AZ, [
    '@echo off',
    '>>"%~dp0calls.log" echo %*',
    'if exist "%~dp0mode-login" ( >&2 echo ERROR: Please run \'az login\' to setup account. & exit /b 1 )',
    'echo %* | findstr /c:"cognitiveservices" >nul',
    'if %errorlevel%==0 ( echo ' + TOKEN_B + ' ) else ( echo ' + TOKEN_A + ' )',
    '',
  ].join('\r\n'));
}

function scanFor(dir, needles) {
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
          const buf = fs.readFileSync(p);
          if (needles.some((n) => buf.includes(n))) hits.push(p);
        } catch (err) { /* locked */ }
      }
    }
  };
  walk(dir);
  return hits;
}

(async () => {
  const fx = h.makeFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  writeFakeAz();
  await startLlm();
  const closedPort = await freePort();

  const userData = ud('aiprov');
  const app = await launch({ userData, files: [fx.A, fx.B], port: 9431, env: { VE_TEST_AZ_PATH: FAKE_AZ, VE_TEST_AI_PROBE_PORTS: llm.port + ',' + closedPort } });
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ id: s.id, mediaId: s.mediaId, in: s.in, out: s.out, speed: s.speed }))');
  const total = () => ev('VE.state.layout().total');
  const dbg = () => ev('VE.ai.debug()');
  const msgCount = async () => (await dbg()).messages.length;
  const lastMsg = async () => { const d = await dbg(); return d.messages[d.messages.length - 1]; };
  const modalText = () => ev("(document.querySelector('#modal-root .modal') || { textContent: '' }).textContent");
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${J(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  const waitReply = (before, n) => app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + (n || 2)}; })()`, 30000, 'assistant reply');
  const run = async (prompt, specs) => { llm.queue.push(...specs); const before = await msgCount(); await ask(prompt); await waitReply(before); return lastMsg(); };
  const openDialog = async () => {
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('#modal-root .modal input[type=\"password\"]')", 5000, 'settings dialog');
  };
  const closeModal = async () => { await ev("(document.querySelector('#modal-root .modal-head .btn') || { click() {} }).click()"); await sleep(150); };
  const fill = (o) => ev(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const m = document.querySelector('#modal-root .modal');
    const sels = m.querySelectorAll('select'); const ins = [...m.querySelectorAll('.form-grid input[type="text"]')]; const key = m.querySelector('input[type="password"]');
    ${o.provider !== undefined ? `set(sels[0], ${J(o.provider)});` : ''}
    ${o.auth !== undefined ? `set(sels[1], ${J(o.auth)});` : ''}
    ${o.url !== undefined ? `set(ins[0], ${J(o.url)});` : ''}
    ${o.version !== undefined ? `set(ins[1], ${J(o.version)});` : ''}
    ${o.model !== undefined ? `set(ins[2], ${J(o.model)});` : ''}
    ${o.key !== undefined ? `set(key, ${J(o.key)});` : ''}
  })()`);
  const fields = () => ev(`(() => { const m = document.querySelector('#modal-root .modal'); const s = m.querySelectorAll('select'); const i = [...m.querySelectorAll('.form-grid input[type="text"]')]; return { provider: s[0].value, auth: s[1].value, url: i[0].value, version: i[1].value, model: i[2].value }; })()`);
  const labels = () => ev("[...document.querySelectorAll('#modal-root .form-grid > label')].filter((l) => !l.hidden).map((l) => l.textContent)");
  const save = async () => {
    await ev("document.querySelector('#modal-root .modal-foot .btn.primary').click()");
    await app.waitFor("(() => { const r = document.querySelector('#modal-root .ai-result'); return !!r && !r.hidden && !r.classList.contains('busy'); })()", 25000, 'settings result');
    return ev("document.querySelector('#modal-root .ai-result').textContent");
  };
  const status = () => ev('window.api.ai.status()');
  const keyFile = path.join(userData, 'ai-key.json');

  try {
    await app.waitFor("VE.state.S.segments.length === 2 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import + thumbnails');
    await sleep(300);
    const orig = await segs();
    await ev('VE.ai.open()');
    await sleep(300);

    /* ---------------- dialog ---------------- */

    await step('P01 the dialog offers seven providers (the built-in model first); the fields follow the provider (API version, sign-in choice, local discovery)', async () => {
      await openDialog();
      const opts = await ev("[...document.querySelectorAll('#modal-root .modal select')[0].options].map((o) => o.value + '|' + o.textContent)");
      assert(opts.map((o) => o.split('|')[0]).join() === 'builtin,openai,azure,foundry,anthropic,gemini,local', opts.join(' ; '));
      assert(/Yerleşik yerel model/.test(opts[0]) && /Microsoft Foundry/.test(opts[3]) && /…openai\.azure\.com/.test(opts[2]) && /Yerel model \(Foundry Local, Ollama/.test(opts[6]), opts.join(' ; '));
      const want = {
        builtin: ['Sağlayıcı', 'Model klasörü', 'Çalışma biçimi', 'Boşta kapat (dk)'],
        openai: ['Sağlayıcı', 'Uç nokta (URL)', 'Model', 'API anahtarı'],
        azure: ['Sağlayıcı', 'Uç nokta (URL)', 'API sürümü', 'Model (dağıtım adı)', 'Oturum açma', 'API anahtarı'],
        foundry: ['Sağlayıcı', 'Uç nokta (URL)', 'Model (dağıtım adı)', 'Oturum açma', 'API anahtarı'],
        anthropic: ['Sağlayıcı', 'Uç nokta (URL)', 'Model', 'API anahtarı'],
        gemini: ['Sağlayıcı', 'Uç nokta (URL)', 'Model', 'API anahtarı'],
        local: ['Sağlayıcı', 'Uç nokta (URL)', 'Model', 'API anahtarı (isteğe bağlı)'],
      };
      for (const p of Object.keys(want)) {
        await fill({ provider: p });
        const got = await labels();
        assert(got.join('|') === want[p].join('|'), p + ': ' + got.join('|'));
        const ui = await ev(`(() => { const m = document.querySelector('#modal-root .modal'); const find = [...m.querySelectorAll('button')].find((b) => /Yerel sunucuları bul/.test(b.textContent)); const hint = m.querySelector('.hint'); return { find: !!find && !find.hidden && find.offsetParent !== null, hint: hint ? hint.textContent : '' }; })()`);
        assert(ui.find === (p === 'local'), p + ': discovery button visibility ' + ui.find);
        assert(ui.hint.length > 20, p + ': provider hint missing');
      }
      await fill({ provider: 'foundry', auth: 'entra' });
      assert((await labels()).join('|') === 'Sağlayıcı|Uç nokta (URL)|Model (dağıtım adı)|Oturum açma', 'Entra hides the key row: ' + (await labels()).join('|'));
      const hint = await ev("[...document.querySelectorAll('#modal-root .hint')].filter((h) => !h.hidden).map((h) => h.textContent).join(' ## ')");
      assert(/az login/.test(hint) && /Cognitive Services User/.test(hint), hint);
      assert(!/Azure CLI bu bilgisayarda bulunamadı/.test(hint), 'the fake az is found: ' + hint);
      await fill({ provider: 'openai', auth: 'key' });
      await closeModal();
    });

    /* ---------------- Foundry with a key ---------------- */

    await step('P02 Foundry (key): the project endpoint becomes the v1 route, the key goes as a bearer token, an agent request is applied as one undo step', async () => {
      await openDialog();
      await fill({ provider: 'foundry', url: llm.url + '/api/projects/proj1', model: 'dsv3', key: KEY });
      llm.requests.length = 0;
      const msg = await save();
      assert(/Bağlantı ve model çalışıyor/.test(msg), msg);
      assert(llm.requests.length === 1 && llm.requests[0].method === 'POST', 'Foundry has no model listing: ' + J(llm.requests.map((r) => r.method + ' ' + r.url)));
      const ping = llm.requests[0];
      assert(ping.url === '/api/projects/proj1/openai/v1/chat/completions', ping.url);
      assert(ping.headers.authorization === 'Bearer ' + KEY && !('api-key' in ping.headers), 'headers ' + J(ping.headers));
      assert(ping.body.model === 'dsv3' && !('temperature' in ping.body), J(ping.body));
      const st = await status();
      assert(st.provider === 'foundry' && st.credential === 'key' && st.auth === 'key' && st.ready && st.hasKey && st.needs === null, J(st));
      assert(st.baseUrl === llm.url + '/api/projects/proj1' && st.effectiveBaseUrl === st.baseUrl, 'stored endpoint ' + st.baseUrl);
      await closeModal();
      llm.requests.length = 0;
      const last = await run('ilk 2 saniyeyi kes', [calls([['remove_range', { start: 0, end: 2 }]]), text('İlk 2 saniyeyi kestim.')]);
      assert(last.type === 'ai' && /kestim/.test(last.text), J(last));
      assert(agentCalls().length === 2 && agentCalls().every((r) => r.url === '/api/projects/proj1/openai/v1/chat/completions' && r.headers.authorization === 'Bearer ' + KEY), 'requests ' + J(llm.requests.map((r) => r.url)));
      near(await total(), 11, 0.001, 'total after the cut');
      await ev('VE.actions.undo()');
      await sleep(200);
      near(await total(), 13, 0.001, 'one undo restores the timeline');
    });

    /* ---------------- Azure portal "Target URI" ---------------- */

    await step('P03 Azure OpenAI: the portal "Target URI" is cleaned up (resource address, deployment name, API version) and the classic route uses the api-key header', async () => {
      await openDialog();
      await fill({ provider: 'azure', url: llm.url + '/openai/deployments/dep-x/chat/completions?api-version=2025-01-01-preview', model: '', version: '', key: KEY });
      llm.requests.length = 0;
      const msg = await save();
      assert(/Bağlantı ve model çalışıyor/.test(msg), msg);
      const f = await fields();
      assert(f.url === llm.url && f.model === 'dep-x' && f.version === '2025-01-01-preview', J(f));
      const ping = llm.requests[0];
      assert(ping.url === '/openai/deployments/dep-x/chat/completions?api-version=2025-01-01-preview', ping.url);
      assert(ping.headers['api-key'] === KEY && !('authorization' in ping.headers), J(ping.headers));
      assert(!('model' in ping.body), 'the deployment is part of the URL on the classic route');
      await closeModal();
    });

    /* ---------------- Entra ID via the Azure CLI ---------------- */

    await step('P04 Entra ID (Azure CLI): no key is kept, a short-lived token is requested with a FIXED command, used as a bearer token and never stored', async () => {
      assert(fs.existsSync(keyFile), 'the key of the previous step must exist before the switch');
      azReset();
      await openDialog();
      await fill({ provider: 'foundry', auth: 'entra', url: llm.url, model: 'dsv3', version: '' });
      llm.requests.length = 0;
      const msg = await save();
      assert(/Bağlantı ve model çalışıyor/.test(msg), msg);
      assert(!fs.existsSync(keyFile), 'switching to Entra must delete the stored key');
      const st = await status();
      assert(st.provider === 'foundry' && st.auth === 'entra' && st.credential === 'entra' && st.ready && !st.hasKey && st.azCli === true && st.needs === null, J(st));
      const ping = llm.requests[0];
      assert(ping.url === '/openai/v1/chat/completions', ping.url);
      assert(ping.headers.authorization === 'Bearer ' + TOKEN_A && !('api-key' in ping.headers), 'ping headers ' + J(ping.headers));
      assert(J(azCalls()) === J(['account get-access-token --resource https://ai.azure.com --query accessToken --output tsv']), 'az calls ' + J(azCalls()));
      await closeModal();
      llm.requests.length = 0;
      const last = await run('ilk saniyeyi kes', [calls([['remove_range', { start: 0, end: 1 }]]), text('Kestim.')]);
      assert(last.type === 'ai', J(last));
      assert(agentCalls().every((r) => r.headers.authorization === 'Bearer ' + TOKEN_A), 'agent requests use the token');
      assert(azCalls().length === 1, 'the token is cached in memory: ' + azCalls().length + ' az calls');
      await ev('VE.actions.undo()');
      await sleep(200);
      const hits = scanFor(userData, [Buffer.from(TOKEN_A), Buffer.from(TOKEN_B), Buffer.from(KEY)]);
      assert(hits.length === 0, 'token/key found on disk: ' + hits.join(', '));
      const dom = await ev('document.documentElement.outerHTML');
      assert(!dom.includes(TOKEN_A) && !dom.includes(KEY) && !J(await status()).includes(TOKEN_A) && !J(await dbg()).includes(TOKEN_A), 'token reached the renderer');
      const settings = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8');
      assert(J(JSON.parse(settings).ai.auth) === '"entra"' && !settings.includes(TOKEN_A), 'settings.json: ' + settings.slice(0, 200));
    });

    await step('P05 a 401 for one token audience is retried once with the other audience, and the working audience is remembered', async () => {
      await openDialog();
      llm.pings.push({ status: 401, json: { error: { message: 'token audience is incorrect' } } });
      llm.requests.length = 0;
      azReset();
      const msg = await save(); // saving drops the cached tokens
      assert(/Bağlantı ve model çalışıyor/.test(msg), msg);
      const auths = pingCalls().map((r) => r.headers.authorization);
      assert(J(auths) === J(['Bearer ' + TOKEN_A, 'Bearer ' + TOKEN_B]), 'ping tokens ' + J(auths));
      assert(J(azCalls()) === J([
        'account get-access-token --resource https://ai.azure.com --query accessToken --output tsv',
        'account get-access-token --resource https://cognitiveservices.azure.com --query accessToken --output tsv',
      ]), 'az calls ' + J(azCalls()));
      await closeModal();
      llm.requests.length = 0;
      await run('merhaba', [text('Merhaba!')]);
      assert(agentCalls()[0].headers.authorization === 'Bearer ' + TOKEN_B, 'the audience that worked is tried first');
      assert(azCalls().length === 2, 'both tokens are cached: ' + azCalls().length);
    });

    await step('P06 not signed in to the Azure CLI: a clear message, nothing is applied or sent', async () => {
      await openDialog();
      fs.writeFileSync(path.join(FAKE_DIR, 'mode-login'), '');
      llm.requests.length = 0;
      const msg = await save();
      assert(/Azure CLI oturumu yok/.test(msg) && /az login/.test(msg), msg);
      assert(llm.requests.length === 0, 'no request without a token');
      await closeModal();
      const before = await msgCount();
      await ask('ilk saniyeyi kes');
      await waitReply(before);
      const last = await lastMsg();
      assert(last.type === 'error' && last.code === 'AZ_LOGIN' && /Azure CLI oturumu yok/.test(last.text), J(last));
      assert(llm.requests.length === 0, 'no request without a token');
      near(await total(), 13, 0.001, 'the timeline must not change');
      azReset();
    });

    /* ---------------- local model ---------------- */

    await step('P07 local model: "Find local servers" finds the mock (closed ports are ignored), no key is needed, the assistant becomes ready', async () => {
      await openDialog();
      await fill({ provider: 'local', url: '', model: '' });
      const finder = "[...document.querySelectorAll('#modal-root .modal button')].find((b) => /Yerel sunucuları bul/.test(b.textContent)).click()";
      await ev(finder);
      await app.waitFor("document.querySelectorAll('#modal-root .ai-found button').length === 1", 15000, 'found servers');
      const msg = await ev("document.querySelector('#modal-root .ai-result').textContent");
      assert(/1 yerel sunucu bulundu/.test(msg), msg);
      const label = await ev("document.querySelector('#modal-root .ai-found button').textContent");
      assert(label.includes('127.0.0.1:' + llm.port + '/v1') && /2 model/.test(label), label);
      const f = await fields();
      assert(f.url === llm.url + '/v1' && f.model === 'mock-model', 'the only result is filled in: ' + J(f));
      llm.requests.length = 0;
      const saved = await save();
      assert(/Bağlantı ve model çalışıyor/.test(saved), saved);
      const list = llm.requests.filter((r) => r.method === 'GET');
      const ping = pingCalls();
      assert(list.length === 1 && list[0].url === '/v1/models' && !('authorization' in list[0].headers), 'model listing ' + J(list));
      assert(ping.length === 1 && !('authorization' in ping[0].headers) && !('api-key' in ping[0].headers), 'the ping carries no credentials: ' + J(ping[0] && ping[0].headers));
      assert(ping[0].body.temperature === 0.2 && ping[0].body.max_tokens === 1024, 'bounded sampling for a small local model: ' + J(ping[0].body));
      const st = await status();
      assert(st.provider === 'local' && st.credential === 'optional' && st.ready && !st.hasKey && st.needs === null, J(st));
      await app.screenshot(path.join(SHOTS, 'tr-dark-ai-local.png'));
      await closeModal();
      assert((await ev("document.querySelector('#ai-state').textContent")) === 'Hazır', 'state chip');
      assert(await ev("document.querySelector('#ai-banner').hidden") && !(await ev("document.querySelector('#ai-input').disabled")), 'the assistant must be usable without a key');
      llm.requests.length = 0;
      const last = await run('son 3 saniyeyi yavaşlat', [calls([['set_speed', { start: 10, end: 13, speed: 0.5 }]]), text('Son 3 saniyeyi 0,5× yavaşlattım.')]);
      assert(last.type === 'ai' && last.actions.length === 1, J(last));
      assert(agentCalls().length === 2 && agentCalls().every((r) => !('authorization' in r.headers) && r.body.temperature === 0.2), 'local requests: ' + J(agentCalls().map((r) => r.headers)));
      near(await total(), 16, 0.001, 'slowing 3 s down to 0.5x adds 3 s');
      await app.screenshot(path.join(SHOTS, 'tr-dark-ai-local-chat.png'));
      await ev('VE.actions.undo()');
      await sleep(200);
    });

    await step('P08 a "local" model must really be local: any other address is refused before anything is stored or sent', async () => {
      await openDialog();
      const before = await status();
      for (const bad of ['https://example.com/v1', 'http://192.168.1.20:11434/v1', 'https://api.openai.com/v1']) {
        await fill({ provider: 'local', url: bad });
        llm.requests.length = 0;
        const msg = await save();
        assert(/bu bilgisayarı göstermeli/.test(msg), bad + ': ' + msg);
      }
      assert(llm.requests.length === 0, 'nothing may be sent');
      const after = await status();
      assert(after.baseUrl === before.baseUrl && after.provider === 'local', 'settings changed: ' + J(after));
      await fill({ url: 'http://localhost:' + llm.port });
      assert(/Bağlantı ve model çalışıyor/.test(await save()), 'localhost is fine');
      assert((await fields()).url === 'http://localhost:' + llm.port + '/v1', 'the missing /v1 is added: ' + (await fields()).url);
      await fill({ url: llm.url + '/v1' });
      assert(/Bağlantı ve model çalışıyor/.test(await save()));
      await closeModal();
    });

    await step('P09 local problems are explained: server not reachable (with a settings shortcut), model without tool calling, <think> text hidden', async () => {
      llm.requests.length = 0;
      llm.fallback = { destroy: true }; // Chromium itself retries a reset connection, so a finite script would be eaten up
      const down = await run('bir şey yap', []);
      llm.fallback = null;
      assert(down.type === 'error' && /Yerel sunucuya ulaşılamadı/.test(down.text) && down.fix === true, J(down));
      assert(await ev("[...document.querySelectorAll('.ai-msg.err .btn')].some((b) => /Ayarları aç/.test(b.textContent))"), 'settings shortcut missing');
      const noTools = await run('bir şey yap', [{ status: 400, json: { error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools' } } }]);
      assert(noTools.type === 'error' && noTools.code === 'NO_TOOLS' && /araç çağırmayı/.test(noTools.text) && noTools.fix === true, J(noTools));
      const think = await run('merhaba', [text('<think>kullanıcı selam veriyor, kısa cevap vereyim</think>\n\nMerhaba! Ne yapmamı istersiniz?')]);
      assert(think.type === 'ai' && think.text === 'Merhaba! Ne yapmamı istersiniz?', J(think));
      near(await total(), 13, 0.001, 'nothing may change');
      const dom = await ev("[...document.querySelectorAll('.ai-msg.ai .ai-text')].map((n) => n.textContent).join(' | ')");
      assert(!/<think>|kullanıcı selam/.test(dom), dom);
    });

    /* ---------------- English + light screenshots ---------------- */

    await step('P10 English + light: new texts, screenshots for the guide', async () => {
      await app.click('#lang-switch button[data-lang=en]');
      await app.click('#btn-theme');
      await sleep(400);
      await openDialog();
      await fill({ provider: 'foundry', auth: 'entra', url: 'https://myresource.services.ai.azure.com/api/projects/my-project', model: 'gpt-4o-mini' });
      await sleep(250);
      const t = await modalText();
      assert(/Microsoft Entra ID \(Azure CLI\)/.test(t) && /Sign-in/.test(t) && /Run “az login” once/.test(t) && /Foundry project address/.test(t), t.slice(0, 600));
      assert((await labels()).join('|') === 'Provider|Endpoint (URL)|Model (deployment name)|Sign-in', (await labels()).join('|'));
      await app.screenshot(path.join(SHOTS, 'en-light-ai-foundry-entra.png'));
      await fill({ provider: 'local', auth: 'key' });
      await sleep(200);
      const tl = await modalText();
      assert(/Find local servers/.test(tl) && /API key \(optional\)/.test(tl) && /nothing leaves the computer/.test(tl), tl.slice(0, 600));
      await closeModal();
      await app.click('#lang-switch button[data-lang=tr]');
      await app.click('#btn-theme');
      await sleep(300);
    });

    console.log('errors:', J(app.errors));
    await step('P11 no script errors or console errors during the whole run', async () => {
      assert(app.errors.length === 0, J(app.errors));
    });
    assert(orig.length === 2, 'sanity');
  } finally {
    await app.close();
    await new Promise((r) => { llm.server.closeAllConnections(); llm.server.close(r); });
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  }
  const failed = summary('ui-ai-providers');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('UI-AI-PROVIDERS FAILED', e); process.exit(1); });
