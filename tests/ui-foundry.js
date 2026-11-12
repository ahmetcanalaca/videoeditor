'use strict';
// UI scenario: Foundry Local in the AI settings and in the assistant - in the real app (CDP), against a FAKE command line (tests/fake-foundry-cli.js) and a mock server that
// behaves like Foundry Local 0.14: it answers HTTP 400 for a model that is not loaded, HTTP 500 for `tools`, and looks at the pictures it is sent (a car on the left, then on
// the right). Scenarios: not installed (official links), the model list, a download with progress and cancel, start, save + test (the model is loaded on demand), a request
// with the tools in the prompt, find_in_video through the pictures (a zoom that aims at the car), a server that disappeared (restarted), a server that cannot be started.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, h } = require('./ui-helpers');
const world = require('./locate-world');

const J = JSON.stringify;
const SHOTS = path.join(OUT, 'shots');
const HOME = path.join(OUT, 'fl-home');
const EMPTY_HOME = path.join(OUT, 'fl-home-empty');
const STATE = path.join(OUT, 'fl-state.json');
const OPEN_LOG = path.join(OUT, 'fl-open.log');
const CLI = path.join(__dirname, 'fake-foundry-cli.js');
const FOUNDRY_500 = { error: { code: null, message: "Inference failed: chat_session.cc:1233 fl::`anonymous-namespace'::BuildToolCallContextForRequest structured tool calling requires model-published opening and closing tool markers", param: null, type: 'server_error' } };

// (the fake command line rewrites this file from another process: a read that meets a half-written file is repeated)
const readState = () => {
  let last;
  for (let i = 0; i < 40; i++) {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { last = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  throw last;
};
const patchState = (patch) => fs.writeFileSync(STATE, J(Object.assign(readState(), patch)));
const cliCalls = () => readState().calls || [];
const daemonFile = path.join(HOME, '.foundry', 'daemon.json');

/* ---------------------------------------------------------------- mock Foundry Local server */

const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const toolText = (name, args) => text(J({ tool_calls: [{ name, arguments: args }] }));

function startServer(pid) {
  const srv = { requests: [], statusHits: 0, url: '', pid, server: null };
  srv.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(J(body)); };
      if (req.url === '/status') { srv.statusHits++; send(200, { artifact_qualified_model_management: true, endpoints: [srv.url], modelCachePath: 'C:\\models', pid: srv.pid }); return; }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* GET */ }
      srv.requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      if (req.url !== '/v1/chat/completions' || !body) { send(404, { error: { message: 'No mapping for ' + req.url } }); return; }
      const loaded = readState().models.filter((m) => m.loaded).map((m) => m.id);
      if (!loaded.includes(body.model)) { send(400, { error: { code: null, message: "Model not loaded: Model '" + body.model + "' must be loaded before inference", type: 'invalid_request_error' } }); return; }
      if (body.tools) { send(500, FOUNDRY_500); return; }
      let out;
      if (world.isPictureRequest(body)) {
        const pic = world.pictureOf(body, req.headers);
        out = text(world.visionAnswer(h, pic.record.prompt, pic.jpeg, 'orange').text);
      } else {
        const last = body.messages[body.messages.length - 1];
        const lastText = typeof last.content === 'string' ? last.content : '';
        const said = (re) => body.messages.some((m) => m.role === 'assistant' && re.test(String(m.content)));
        if (/^TOOL RESULTS/.test(lastText)) {
          const found = /"found_id":"(f\d+)"/.exec(lastText);
          if (said(/"set_zoom"/)) out = text('Yakınlaştırdım. Ctrl+Z ile geri alabilirsiniz.');
          else if (said(/"find_in_video"/) && found) out = toolText('set_zoom', { found: found[1], mode: 'in' });
          else out = text('Tamam.');
        } else if (/Arabayı yakınlaştır/.test(lastText)) out = toolText('find_in_video', { object: 'car' });
        else if (/yakınlaştır/.test(lastText)) out = toolText('set_zoom', { start: 2, end: 4, mode: 'in' });
        else out = text('OK');
      }
      send(200, out.json);
    });
  });
  return new Promise((resolve) => srv.server.listen(0, '127.0.0.1', () => {
    srv.url = 'http://127.0.0.1:' + srv.server.address().port;
    srv.close = () => new Promise((r) => { srv.server.closeAllConnections(); srv.server.close(r); });
    resolve(srv);
  }));
}

const MODELS = [
  { alias: 'qwen3.5-4b', id: 'qwen3.5-4b-generic-cpu:3', type: 'Multimodal', device: 'Cpu', fileSizeMb: 3085, cached: true, loaded: false },
  { alias: 'qwen3.5-4b', id: 'qwen3.5-4b-generic-gpu:4', type: 'Multimodal', device: 'Gpu', fileSizeMb: 4185, cached: false, loaded: false },
  { alias: 'qwen2.5-1.5b', id: 'qwen2.5-1.5b-instruct-generic-gpu:4', type: 'Chat', device: 'Gpu', fileSizeMb: 1546, cached: false, loaded: false },
  { alias: 'whisper-tiny', id: 'openai-whisper-tiny-generic-cpu:2', type: 'Speech', device: 'Cpu', fileSizeMb: 300, cached: false, loaded: false },
];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(EMPTY_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.foundry'), { recursive: true });
  fs.mkdirSync(EMPTY_HOME, { recursive: true });
  fs.rmSync(OPEN_LOG, { force: true });
  const film = world.makeFilm(h, path.join(OUT, 'locate-world-film.mp4'));
  const A = await startServer(4711);
  const B = await startServer(4712);
  fs.writeFileSync(STATE, J({ home: HOME, url: A.url, pid: 4711, running: false, models: MODELS, downloadStepMs: 100, calls: [] }));

  /* ============================================================ app 1: Foundry Local is not installed */
  const userData1 = ud('flmissing');
  let app = await launch({ userData: userData1, files: [film], port: 9451, env: { VE_TEST_FL_HOME: EMPTY_HOME, VE_TEST_OPEN_LOG: OPEN_LOG } });
  let ev = (expr) => app.evaluate(expr);
  const modal = () => "document.querySelector('#modal-root .modal')";
  const openDialog = async () => { await ev('VE.ai.openSettings()'); await app.waitFor(`!!${modal()} && !!${modal()}.querySelector('select')`, 8000, 'settings dialog'); };
  const closeModal = async () => { await ev("(document.querySelector('#modal-root .modal-head .btn') || { click() {} }).click()"); await sleep(200); };
  const choose = (p) => ev(`(() => { const s = ${modal()}.querySelectorAll('select')[0]; s.value = ${J(p)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const fl = (role) => `${modal()}.querySelector('[data-fl="${role}"]')`;
  const shown = (role) => ev(`(() => { const e = ${fl(role)}; return !!e && !e.hidden && e.offsetParent !== null; })()`);
  const flText = (role) => ev(`(() => { const e = ${fl(role)}; return e ? e.textContent : null; })()`);
  const flState = () => ev(`${fl('state')}.dataset.state`);
  const result = () => ev("(() => { const r = document.querySelector('#modal-root .ai-result'); return r && !r.hidden ? r.textContent : ''; })()");
  const waitState = (s, ms) => app.waitFor(`!!${fl('state')} && ${fl('state')}.dataset.state === ${J(s)}`, ms || 15000, 'Foundry panel state ' + s);
  const clickFl = async (role) => { await ev(`${fl(role)}.click()`); };

  try {
    await app.waitFor("VE.state.S.segments.length >= 1", 25000, 'film imported');
    await sleep(300);

    await step('FL01 not installed: the panel says so and offers the OFFICIAL download (installer link, guide, winget command); the buttons open exactly those addresses', async () => {
      await openDialog();
      await choose('foundrylocal');
      await app.waitFor(`!!${fl('panel')}`, 8000, 'panel');
      await waitState('missing');
      assert(/Foundry Local bu bilgisayarda kurulu değil/.test(await flText('state')), await flText('state'));
      assert(await shown('install') && !(await shown('models')), 'install box shown, model box hidden');
      assert((await ev(`${fl('command')}.value`)) === 'winget install Microsoft.FoundryLocal', 'command');
      assert(/resmî sayfasından/.test(await flText('install')), await flText('install'));
      const rows = await ev(`[...${modal()}.querySelectorAll('.form-grid > label')].filter((l) => !l.hidden && l.offsetParent !== null).map((l) => l.textContent)`);
      assert(!rows.includes('Uç nokta (URL)') && !rows.includes('API anahtarı'), 'no address / key rows: ' + rows.join('|'));
      assert(!(await ev(`!!([...${modal()}.querySelectorAll('button')].find((b) => /Yerel sunucuları bul/.test(b.textContent) && b.offsetParent !== null))`)), 'no local discovery here');
      await clickFl('get');
      await clickFl('docs');
      await sleep(400);
      const opened = fs.readFileSync(OPEN_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
      assert(opened.join(' ') === 'https://aka.ms/foundry-local-installer https://learn.microsoft.com/azure/foundry-local/get-started', opened.join(' '));
      await app.screenshot(path.join(SHOTS, 'fl-tr-dark-missing.png'));
    });

    await step('FL02 saving without a model, and a request with Foundry Local chosen but not installed, give clear messages (no crash, nothing sent)', async () => {
      await ev(`${modal()}.querySelector('.modal-foot .btn.primary').click()`);
      await app.waitFor("(() => { const r = document.querySelector('#modal-root .ai-result'); return !!r && !r.hidden && !r.classList.contains('busy'); })()", 15000, 'result');
      assert(/Önce bir model seçin/.test(await result()), await result());
      await closeModal();
      // choose it through the API with a model id (as a hand-edited settings file could), then test the connection
      const saved = await ev("window.api.ai.save({ provider: 'foundrylocal', model: 'qwen3.5-4b-generic-cpu:3' })");
      assert(saved.ok && saved.status.provider === 'foundrylocal' && saved.status.baseUrl === '' && saved.status.ready, J(saved));
      const t = await ev('window.api.ai.test()');
      assert(t.ok === false && t.error.code === 'FL_NOT_INSTALLED', J(t));
      const bad = await ev("window.api.ai.save({ provider: 'foundrylocal', model: 'a b; calc.exe' })");
      assert(bad.ok === false && bad.error.code === 'FL_BAD_MODEL', J(bad));
      const st = await ev('window.api.ai.status()');
      assert(st.provider === 'foundrylocal' && st.model === 'qwen3.5-4b-generic-cpu:3', 'the bad save changed nothing: ' + J(st));
      await ev("window.api.ai.save({ provider: 'builtin' })");
    });

    assert(app.errors.length === 0, 'renderer errors: ' + app.errors.join('\n'));
  } finally {
    await app.close();
  }

  /* ============================================================ app 2: installed, the server is not running yet */
  app = await launch({
    userData: ud('flinstalled'), files: [film], port: 9452,
    env: { VE_TEST_FL_HOME: HOME, VE_TEST_FL_CLI_JS: CLI, VE_FAKE_FL_STATE: STATE, VE_TEST_OPEN_LOG: OPEN_LOG },
  });
  ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const msgCount = async () => (await ev('VE.ai.debug()')).messages.length;
  const lastMsg = async () => { const d = await ev('VE.ai.debug()'); return d.messages[d.messages.length - 1]; };
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${J(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  const run = async (prompt, waitMs) => {
    const before = await msgCount();
    await ask(prompt);
    await app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + 2}; })()`, waitMs || 120000, 'assistant reply');
    return lastMsg();
  };
  const chatRequests = (srv) => srv.requests.filter((r) => r.url === '/v1/chat/completions');
  const optionList = () => ev(`[...${fl('model')}.options].map((o) => o.value + '|' + o.textContent + '|' + o.parentElement.label)`);

  try {
    await app.waitFor('VE.state.S.segments.length >= 1', 25000, 'film imported');
    await sleep(300);
    await ev('VE.ai.open()');
    await sleep(300);

    await step('FL03 installed but stopped: the list starts with what is on this computer (no catalogue request, no network), "Show all models" asks Foundry Local for its catalogue (downloaded first, recommended first, speech models left out), with what each model can do', async () => {
      await openDialog();
      await choose('foundrylocal');
      await app.waitFor(`!!${fl('model')} && ${fl('model')}.options.length > 0`, 15000, 'model list');
      await waitState('stopped');
      assert(/kurulu ama çalışmıyor/.test(await flText('state')), await flText('state'));
      assert(!(await shown('install')) && (await shown('models')), 'model box shown, install box hidden');
      const first = await optionList();
      assert(first.length === 1 && first[0].startsWith('qwen3.5-4b-generic-cpu:3|★ qwen3.5-4b · CPU · 3 GB · görüntüye bakar|Bu bilgisayarda'), 'only what is downloaded: ' + first.join(' ; '));
      assert(await shown('catalog') && /Microsoft’un model listesini internetten alır/.test(await flText('catalog-hint')) && /donanım bileşenlerini de indirebilir/.test(await flText('catalog-hint')), 'the button and what it costs: ' + await flText('catalog-hint'));
      assert(cliCalls().some((c) => /^cache list/.test(c)) && !cliCalls().some((c) => /^model list/.test(c)), 'no catalogue request yet: ' + cliCalls().join(' / '));
      await app.screenshot(path.join(SHOTS, 'fl-tr-dark-initial.png'));
      await clickFl('catalog');
      await app.waitFor(`${fl('model')}.options.length === 3`, 15000, 'the catalogue');
      await waitState('stopped');
      assert(cliCalls().some((c) => /^model list/.test(c)) && !(await shown('catalog')), 'the catalogue was asked for after the click: ' + cliCalls().join(' / '));
      const opts = await optionList();
      assert(opts.length === 3 && opts[0].startsWith('qwen3.5-4b-generic-cpu:3|★ qwen3.5-4b · CPU · 3 GB · görüntüye bakar|Bu bilgisayarda'), opts.join(' ; '));
      assert(opts[1].startsWith('qwen3.5-4b-generic-gpu:4|★ qwen3.5-4b · GPU') && /İndirilebilir$/.test(opts[1]) && opts[2].startsWith('qwen2.5-1.5b-instruct-generic-gpu:4|qwen2.5-1.5b · GPU · 1,5 GB|'), opts.join(' ; '));
      assert(!opts.some((o) => /whisper/.test(o)), 'speech models are not offered');
      assert(/videonun görüntüsüne bakabilir/.test(await flText('info')) && /indirildi/.test(await flText('info')), await flText('info'));
      assert(!(await shown('download')) && (await shown('start')) && (await shown('refresh')), 'download hidden for a downloaded model');
      assert(!(await ev(`!!${modal()}.querySelector('label.check') && ${modal()}.querySelector('label.check').offsetParent !== null`)), 'no "send file names" option');
      await app.screenshot(path.join(SHOTS, 'fl-tr-dark-stopped.png'));
    });

    await step('FL04 a model that is not downloaded: the warning says what will be fetched, a click downloads it with a progress bar, the list then shows it as downloaded', async () => {
      await ev(`(() => { const s = ${fl('model')}; s.value = 'qwen3.5-4b-generic-gpu:4'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(150);
      assert(await shown('download') && /İndir \(4,1 GB\)/.test(await flText('download')), await flText('download'));
      assert(/Henüz indirilmedi/.test(await flText('warn')) && /4,1 GB/.test(await flText('warn')), await flText('warn'));
      await clickFl('download');
      await app.waitFor(`${fl('state')}.dataset.state === 'download'`, 8000, 'download state');
      await app.waitFor(`parseInt(${modal()}.querySelector('.llm-bar i').style.width) >= 20`, 8000, 'progress bar');
      assert(/İndiriliyor: qwen3\.5-4b-generic-gpu:4 · %\d+/.test(await flText('state')), await flText('state'));
      assert((await shown('cancel')) && !(await shown('download')), 'cancel instead of download');
      await app.screenshot(path.join(SHOTS, 'fl-tr-dark-downloading.png'));
      await waitState('stopped', 20000);
      const opts = await optionList();
      assert(/^qwen3\.5-4b-generic-gpu:4\|.*\|Bu bilgisayarda/.test(opts.find((o) => o.startsWith('qwen3.5-4b-generic-gpu:4'))), opts.join(' ; '));
      assert(cliCalls().includes('model download qwen3.5-4b-generic-gpu:4'), cliCalls().join(' / '));
      assert(/Model indirildi/.test(await result()), await result());
    });

    await step('FL05 a download can be cancelled: the model stays "available", nothing is left half-registered', async () => {
      await ev(`(() => { const s = ${fl('model')}; s.value = 'qwen2.5-1.5b-instruct-generic-gpu:4'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(150);
      await clickFl('download');
      await app.waitFor(`${fl('state')}.dataset.state === 'download' && parseInt(${modal()}.querySelector('.llm-bar i').style.width) >= 10`, 8000, 'download running');
      await clickFl('cancel');
      await waitState('stopped', 15000);
      await sleep(600);
      assert(/iptal edildi/.test(await result()), await result());
      const opts = await optionList();
      assert(/İndirilebilir$/.test(opts.find((o) => o.startsWith('qwen2.5-1.5b'))), opts.join(' ; '));
      assert(readState().models.find((m) => m.id.startsWith('qwen2.5-1.5b')).cached === false, 'not cached');
    });

    await step('FL06 "Start" starts Foundry Local through its command line; the panel shows the address and version it found in daemon.json', async () => {
      await clickFl('start');
      await waitState('running', 20000);
      assert(/çalışıyor \(127\.0\.0\.1:\d+ · sürüm 0\.14\.0\)/.test(await flText('state')), await flText('state'));
      assert(!(await shown('start')), 'the start button goes away');
      assert(cliCalls().includes('server start --idle-timeout 30'), cliCalls().join(' / '));
      assert(A.statusHits > 0, 'asked /status');
    });

    await step('FL07 save + test: the model is loaded on demand (HTTP 400 "must be loaded" -> load -> ok), thinking is switched off, the choice is stored without any address', async () => {
      await ev(`(() => { const s = ${fl('model')}; s.value = 'qwen3.5-4b-generic-cpu:3'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(150);
      A.requests.length = 0;
      await ev(`${modal()}.querySelector('.modal-foot .btn.primary').click()`);
      await app.waitFor("(() => { const r = document.querySelector('#modal-root .ai-result'); return !!r && !r.hidden && !r.classList.contains('busy'); })()", 40000, 'test result');
      const msg = await result();
      assert(/Foundry Local hazır: qwen3\.5-4b-generic-cpu:3/.test(msg) && /görüntüye de bakabilir/.test(msg), msg);
      const chats = chatRequests(A);
      assert(chats.length === 2 && chats[0].body.model === 'qwen3.5-4b-generic-cpu:3', 'a refused request, then the real one: ' + chats.length);
      assert(chats[1].body.reasoning_effort === 'none' && !('tools' in chats[1].body), J(chats[1].body).slice(0, 300));
      assert(cliCalls().includes('model load qwen3.5-4b-generic-cpu:3'), cliCalls().join(' / '));
      const st = await ev('window.api.ai.status()');
      assert(st.provider === 'foundrylocal' && st.model === 'qwen3.5-4b-generic-cpu:3' && st.ready && st.vision === true && st.needs === null && st.baseUrl === '' && st.hasKey === false, J(st));
      await sleep(700); // settings.json is written 400 ms after the last change
      const settingsFile = fs.readFileSync(path.join(ud('flinstalled'), 'settings.json'), 'utf8');
      assert(/"provider":\s*"foundrylocal"/.test(settingsFile) && !/127\.0\.0\.1/.test(settingsFile), 'the address of a server that changes at every start is not stored');
      await app.screenshot(path.join(SHOTS, 'fl-tr-dark-ready.png'));
      await closeModal();
    });

    await step('FL08 a command with the tools in the prompt (the server refuses `tools` with HTTP 500): the assistant still zooms - one undo step', async () => {
      A.requests.length = 0;
      const before = await segs();
      const last = await run('2 ile 4 arasını yakınlaştır');
      assert(last.type === 'ai' && /Yakınlaştırdım/.test(last.text), J(last).slice(0, 300));
      const z = (await segs()).filter((s) => s.zoomTo > s.zoomFrom);
      assert(z.length === 1 && near(z[0].in, 2, 0.01, 'zoom in') === undefined && near(z[0].out, 4, 0.01, 'zoom out') === undefined, J(await segs()));
      const chats = chatRequests(A);
      assert(chats.length === 3, 'refused attempt, tool call, final answer: ' + chats.length);
      assert('tools' in chats[0].body && !('tools' in chats[1].body) && !('tools' in chats[2].body), 'only the first request carries tools');
      assert(/HOW TO CALL TOOLS/.test(chats[1].body.messages[0].content) && chats[1].body.reasoning_effort === 'none', 'protocol in the system prompt');
      assert(chats[2].body.messages.some((m) => m.role === 'user' && /^TOOL RESULTS/.test(m.content)) && chats[2].body.messages.every((m) => m.role !== 'tool'), 'results go back as a user message');
      await ev('VE.actions.undo()');
      await sleep(250);
      assert((await segs()).length === before.length && (await segs()).every((s) => s.zoomTo === s.zoomFrom), 'one undo restores the timeline');
    });

    await step('FL09 find_in_video through Foundry Local: the model really looks at the pictures, the zoom aims at the car (left, then right)', async () => {
      A.requests.length = 0;
      const last = await run('Arabayı yakınlaştır', 240000);
      assert(last.type === 'ai' && /Yakınlaştırdım/.test(last.text), J(last).slice(0, 300));
      const pictures = chatRequests(A).filter((r) => world.isPictureRequest(r.body));
      assert(pictures.length >= 8, 'pictures were asked about: ' + pictures.length);
      assert(pictures.every((r) => r.body.model === 'qwen3.5-4b-generic-cpu:3' && r.body.reasoning_effort === 'none' && r.body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' && /^data:image\/jpeg;base64,/.test(p.image_url.url)))), 'JPEG data URLs to the chosen model');
      const z = (await segs()).filter((s) => s.zoomFrom > 1 || s.zoomTo > 1);
      const zl = z.filter((s) => s.out <= 6);
      const zr = z.filter((s) => s.in >= 8);
      assert(zl.length >= 1 && zr.length >= 1 && zl.length + zr.length === z.length, 'zoom segments on both appearances: ' + J(z));
      assert(zl.every((s) => Math.abs(s.fx - world.TRUTH.left.cx) <= 0.05 && Math.abs(s.fy - world.TRUTH.left.cy) <= 0.06), 'left part aims at the left: ' + J(zl));
      assert(zr.every((s) => Math.abs(s.fx - world.TRUTH.right.cx) <= 0.05 && Math.abs(s.fy - world.TRUTH.right.cy) <= 0.06), 'right part aims at the right: ' + J(zr));
      assert(z.every((s) => s.in >= world.TRUTH.left.from - 1.6 && s.out <= world.TRUTH.right.to + 1.6) && !z.some((s) => s.in > 5.5 && s.out < 8.5), 'nothing zoomed in the empty middle');
      await ev('VE.actions.undo()');
      await sleep(250);
    });

    await step('FL10 the server disappeared (crash): the next command starts Foundry Local again - its address changes - loads the model again and goes through', async () => {
      await A.close();
      // what Foundry Local does after a crash: daemon.json is left behind pointing to a dead address; the next start writes a new one
      patchState({ url: B.url, pid: 4712, running: false, calls: [] });
      B.requests.length = 0;
      const last = await run('2 ile 4 arasını yakınlaştır');
      assert(last.type === 'ai' && /Yakınlaştırdım/.test(last.text), J(last).slice(0, 300));
      const calls = cliCalls();
      assert(calls.filter((c) => c === 'server start --idle-timeout 30').length === 1 && calls.includes('model load qwen3.5-4b-generic-cpu:3'), calls.join(' / '));
      assert(chatRequests(B).length >= 3, 'the requests went to the new server: ' + chatRequests(B).length);
      assert(JSON.parse(fs.readFileSync(daemonFile, 'utf8')).web_urls[0] === B.url, 'daemon.json was rewritten');
      await ev('VE.actions.undo()');
      await sleep(250);
    });

    await step('FL11 a server that cannot be started: the card says so in words and offers the settings (no raw error, no hang)', async () => {
      await B.close();
      patchState({ startFails: true, calls: [] });
      const last = await run('2 ile 4 arasını yakınlaştır', 90000);
      assert(last.type === 'error' && last.code === 'FL_START_FAILED' && /Foundry Local başlatılamadı/.test(last.text) && last.fix === true, J(last).slice(0, 300));
      assert(last.detail === 'cannot bind the port', 'detail: ' + last.detail);
      patchState({ startFails: false });
    });

    await step('FL12 English: the whole panel switches language, in the light theme as well', async () => {
      await ev("VE.i18n.setLanguage('en')");
      if ((await ev("document.documentElement.getAttribute('data-theme')")) !== 'light') { await app.click('#btn-theme'); await sleep(250); }
      await openDialog();
      await choose('foundrylocal');
      await app.waitFor(`!!${fl('model')} && ${fl('model')}.options.length > 0`, 20000, 'model list');
      assert(/Show all models/.test(await flText('catalog')) && /asks Microsoft’s model list over the internet/.test(await flText('catalog-hint')), await flText('catalog-hint'));
      await clickFl('catalog');
      await app.waitFor(`${fl('model')}.options.length === 3`, 20000, 'the catalogue');
      const opts = await optionList();
      assert(/sees pictures/.test(opts[0]) && /On this computer \(downloaded\)$/.test(opts[0]) && /Available to download$/.test(opts[opts.length - 1]), opts.join(' ; '));
      assert(/Foundry Local runs the models/.test(await flText('panel')) && /What is sent\?/.test(await flText('notice')), await flText('panel'));
      await app.screenshot(path.join(SHOTS, 'fl-en-light-panel.png'));
      await closeModal();
      await ev("VE.i18n.setLanguage('tr')");
      await app.click('#btn-theme');
      await sleep(250);
    });

    assert(app.errors.length === 0, 'renderer errors: ' + app.errors.join('\n'));
  } finally {
    await app.close();
    await A.close().catch(() => {});
    await B.close().catch(() => {});
  }

  const failed = summary('ui-foundry');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('UI-FOUNDRY FAILED', e); process.exit(1); });
