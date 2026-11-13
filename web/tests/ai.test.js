'use strict';
// The assistant of the web edition in a real browser, against stand-ins for the servers: a model server on this computer (with a key, and CORS because the page
// is another origin), a request that edits the timeline (one undo step), cancelling, a wrong key / nobody there, a model that cannot call tools (the tools go
// into the prompt), cloud providers (OpenAI, Azure with the confirmation of an unknown address, Anthropic's browser header, the key kept for the tab only)
// and the settings dialog (Foundry Local is a panel with four steps; this browser has no extension, so only the first is open - the extension itself is tested in
// fl-bridge.test.js, the whole path with the assistant in fl-web.test.js).
//   node tests/ai.test.js        (VE_BROWSER=<chrome|edge exe>; needs ffmpeg for the test videos: see tests/lib/media-tools.js)
const os = require('os');
const path = require('path');
const { open, checker } = require('./lib/site');
const mock = require('./lib/mock-llm');

const SHOTS = process.env.VE_SHOTS || path.join(os.tmpdir(), 've-web-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const check = checker('web ai');
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const ev = (expr) => app.evaluate(expr);
  const A = path.basename(app.fixtures.A);

  let scenario = 'cut';
  const chat = async (body) => {
    if (scenario === 'toolless') {
      // a model that cannot call tools: HTTP 400 for a request with tools; without them it answers in the JSON form the prompt asks for
      if (body.tools) return { httpStatus: 400, error: 'registry.example/library/tiny does not support tools' };
      const answered = body.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('TOOL RESULTS'));
      return answered ? { content: 'Done: the first 3 seconds are removed.' } : { content: JSON.stringify({ tool_calls: [{ name: 'remove_range', arguments: { first_seconds: 3 } }] }) };
    }
    const tools = body.messages.filter((m) => m.role === 'tool').length;
    return tools ? { content: 'Done: the first 3 seconds are removed.' } : { tool_calls: [{ name: 'remove_range', args: { first_seconds: 3 } }] };
  };
  const llm = await mock.start({ chat });
  const KEY = mock.KEY;
  const localSetup = (model) => `window.api.ai.save({ provider: 'local', baseUrl: '${llm.url}/v1', model: '${model || 'mock-model'}', apiKey: '${KEY}' })`;
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const status = () => ev('window.api.ai.status()');
  const aiState = () => ev('VE.ai.debug()');
  const dialogs = () => ev('(window.__veDialogs || []).length');
  const waitIdle = (ms) => app.waitFor('!VE.ai.isRunning()', ms || 120000, 'the assistant to finish');

  try {
    check('01 no console errors on load', app.errors.length === 0, app.errors);

    /* ---------------- nothing is set up; the helper program of the earlier versions is gone ---------------- */
    const s0 = await status();
    check('02 before anything is set up the assistant is off and wants a model: the default is the one in this tab (nothing to install, no key); nothing was contacted', s0.provider === 'inbrowser' && s0.needs === 'model' && !s0.ready && s0.vision === false && s0.credential === 'none' && !('builtin' in s0) && llm.log.length === 0, s0);
    // an earlier version kept the pairing key of its helper in this browser: it is removed as soon as the assistant starts
    await ev(`localStorage.setItem('ve.web.ai.helper.v1', JSON.stringify({ port: 8473, key: 'OLD_HELPER_KEY_not_real_0123456789' }))`);
    await app.navigate(app.origin + app.server.base + 'index.html?vetest', "typeof VE !== 'undefined' && !!VE.actions");
    await status();
    check('03 there is no helper any more: no window.api.llm, and the pairing key an earlier version left in the storage is removed', (await ev('typeof window.api.llm')) === 'undefined' && (await ev('localStorage.getItem("ve.web.ai.helper.v1")')) === null, null);
    // the pairing link of the old helper (#local-ai=PORT.KEY) is just ignored: no question, no request to that port
    await ev('window.__veAnswers = [0]');
    await ev("location.hash = '#local-ai=" + llm.port + '.' + KEY + "'");
    await sleep(700);
    check('04 the old pairing link does nothing: no dialog, nothing contacted, still not set up', (await dialogs()) === 0 && llm.log.length === 0 && !(await status()).ready, { dialogs: await dialogs(), requests: llm.log.length });
    await ev("history.replaceState(null, '', location.pathname + location.search)");
    await ev('window.__veAnswers = []');

    /* ---------------- a model server on this computer ---------------- */
    const sLocal = await ev(localSetup());
    check('05 a model server on this computer: saved with its key without any question (it is this computer); ready; a browser model does not look at the video by itself', sLocal.ok && sLocal.status.ready && sLocal.status.provider === 'local' && sLocal.status.vision === false && (await dialogs()) === 0, sLocal.error || sLocal.status);
    const stored = await ev('JSON.stringify([localStorage.getItem("ve.web.ai.v1"), sessionStorage.getItem("ve.web.ai.key.v1")])');
    check('06 the key is kept for this tab only (sessionStorage), never in localStorage; the status shows it masked', !JSON.parse(stored)[0].includes(KEY) && JSON.parse(stored)[1].includes(KEY) && !JSON.stringify(await status()).includes(KEY), stored.replace(KEY, '***'));
    const test = await ev('window.api.ai.test()');
    check('07 "test" asks for the models with the key; the page origin reached the server (CORS)', test.ok && test.models.includes('mock-model') && llm.log.some((e) => e.path === '/v1/models' && e.auth === 'Bearer ' + KEY) && llm.log[0].origin === app.origin, { test, origin: llm.log[0] && llm.log[0].origin });

    /* ---------------- a request that edits the timeline ---------------- */
    await app.stage([A]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1', 30000, 'one clip');
    await ev('VE.ai.open()');
    await sleep(300);
    check('08 the pane opens ready, with the example chips', (await aiState()).ready && (await ev("document.querySelectorAll('#ai-log .ai-chip').length")) >= 3);
    llm.log.length = 0;
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const st1 = await aiState();
    const after = await segs();
    check('09 the first 3 seconds are cut out of the timeline', after.length === 1 && Math.abs(after[0].in - 3) < 0.05, after);
    check('10 the answer and the list of what was done are shown', st1.messages.some((m) => m.type === 'ai' && /3 seconds/.test(m.text) && m.actions.length === 1) && (await ev("document.querySelectorAll('#ai-log .ai-actions li').length")) >= 1, st1.messages.map((m) => m.type));
    const chats = llm.log.filter((e) => e.path === '/v1/chat/completions');
    const first = chats[0].body;
    check('11 two round trips; the key is in the header; the tools of the editor are offered, but not find_in_video (a browser model does not look at the video itself)', chats.length === 2 && chats.every((e) => e.auth === 'Bearer ' + KEY) && first.model === 'mock-model' && first.tools.some((t) => t.function.name === 'remove_range') && !first.tools.some((t) => t.function.name === 'find_in_video'), { n: chats.length, model: first.model, tools: first.tools.map((t) => t.function.name) });
    check('12 the system prompt is the compact one of the desktop app and the timeline summary goes as text (no video, no picture)', typeof first.messages[0].content === 'string' && typeof first.messages[1].content === 'string' && /timeline_summary/.test(first.messages[1].content) && !JSON.stringify(first.messages).includes('image_url'), first.messages[0].content.slice(0, 80));
    await app.key('z', { ctrl: true });
    await sleep(200);
    check('13 ONE Ctrl+Z undoes everything the assistant did', (await segs())[0].in === 0, await segs());

    /* ---------------- cancelling ---------------- */
    llm.setDelay(4000);
    await ev("(() => { VE.ai.send('Cut the first 3 seconds'); return true; })()");
    await app.waitFor('VE.ai.isRunning()', 5000, 'running');
    await sleep(400);
    await ev('VE.ai.cancel()');
    await waitIdle(8000);
    const st2 = await aiState();
    check('14 cancelling stops the request: nothing changed, a note says so', (await segs())[0].in === 0 && st2.messages.some((m) => m.type === 'info'), st2.messages.map((m) => m.type + ':' + (m.text || '').slice(0, 30)));
    await sleep(600);
    check('15 the connection to the server was dropped (the request was really aborted)', llm.log.filter((e) => e.path === '/v1/chat/completions').pop().closed === true);
    llm.setDelay(0);

    /* ---------------- wrong key, nobody there ---------------- */
    await ev(`window.api.ai.save({ provider: 'local', baseUrl: '${llm.url}/v1', model: 'mock-model', apiKey: 'WRONG_KEY_WRONG_KEY_0123456789' })`);
    const bad = await ev('window.api.ai.test()');
    check('16 a wrong key is reported as such (401)', !bad.ok && bad.error.code === 'AUTH', bad);
    await ev(`window.api.ai.save({ provider: 'local', baseUrl: 'http://127.0.0.1:1025/v1', model: 'mock-model', apiKey: '${KEY}' })`);
    const gone = await ev('window.api.ai.test()');
    check('17 nobody listening is reported as a network error', !gone.ok && gone.error.code === 'NETWORK', gone);
    await ev(localSetup());
    check('18 the right setup works again', (await ev('window.api.ai.test()')).ok === true);

    /* ---------------- a model that cannot call tools: the tools go into the prompt ---------------- */
    scenario = 'toolless';
    await ev(localSetup('tiny-model'));
    llm.log.length = 0;
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const tl = llm.log.filter((e) => e.path === '/v1/chat/completions');
    const afterT = await segs();
    check('19 a model without tool calling: the request with tools is answered 400, then the tools are written into the prompt and the edit still happens', tl.length === 3 && !!tl[0].body.tools && !tl[1].body.tools && /HOW TO CALL TOOLS/.test(tl[1].body.messages[0].content) && afterT.length === 1 && Math.abs(afterT[0].in - 3) < 0.05, { n: tl.length, segs: afterT });
    await app.key('z', { ctrl: true });
    await sleep(200);
    check('20 ONE Ctrl+Z undoes that too', (await segs())[0].in === 0, await segs());
    scenario = 'cut';
    await ev(localSetup());

    /* ---------------- cloud providers (the network is replaced by a recorder) ---------------- */
    await ev(`(() => {
      window.__net = [];
      window.__veTest = window.__veTest || {};
      window.__veTest.netFetch = async (url, init) => {
        window.__net.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
        const isModels = /\\/models(\\?|$)/.test(url);
        const body = isModels ? { data: [{ id: 'gpt-test' }], models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] }
          : (/anthropic/.test(url) ? { content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }
            : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    })()`);
    await ev('(window.__veDialogs || []).length = 0');
    const SK = 'sk-TEST_not_a_real_secret_0123456789';
    const sOpenAI = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: '', model: 'gpt-test', apiKey: '${SK}' })`);
    check('21 OpenAI: its own address needs no confirmation', sOpenAI.ok && (await dialogs()) === 0 && sOpenAI.status.ready && sOpenAI.status.effectiveBaseUrl === 'https://api.openai.com/v1', sOpenAI.error || sOpenAI.status.effectiveBaseUrl);
    const tOpenAI = await ev('window.api.ai.test()');
    const net1 = await ev('window.__net');
    check('22 the key goes only to api.openai.com, in the Authorization header', tOpenAI.ok && net1.length >= 2 && net1.every((r) => r.url.startsWith('https://api.openai.com/') && r.headers.authorization === 'Bearer ' + SK), net1.map((r) => r.url));
    const keep = await ev('JSON.stringify([localStorage.getItem("ve.web.ai.v1"), localStorage.getItem("ve.web.trust.v1"), localStorage.getItem("ve.web.settings.v1")])');
    check('23 the key is kept for this tab only (sessionStorage), never in localStorage', !keep.includes(SK) && (await ev('sessionStorage.getItem("ve.web.ai.key.v1")')).includes(SK));
    check('24 the status shows a masked key only', (await status()).masked === '••••6789' && !JSON.stringify(await status()).includes(SK));

    const sAz1 = await ev(`(async () => { window.__veAnswers = [1]; return window.api.ai.save({ provider: 'azure', baseUrl: 'https://myres.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21', model: '', apiKey: 'AZ_TEST_KEY_not_real_12345' }); })()`);
    check('25 Azure resource: an unknown address is confirmed first - declined: refused, nothing saved, no key kept', !sAz1.ok && sAz1.error.code === 'ENDPOINT_NOT_CONFIRMED' && (await status()).provider === 'openai' && (await ev('VE.web.net.trust.list()')).length === 0, sAz1);
    const dlgAz = await ev('window.__veDialogs[window.__veDialogs.length - 1]');
    check('26 the question names the address and says what is sent there', /myres\.openai\.azure\.com/.test(dlgAz.message) && /API/.test(dlgAz.detail), dlgAz);
    const sAz2 = await ev(`(async () => { window.__veAnswers = [0]; return window.api.ai.save({ provider: 'azure', baseUrl: 'https://myres.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21', model: '', apiKey: 'AZ_TEST_KEY_not_real_12345' }); })()`);
    check('27 allowed: saved, the deployment and API version are taken from the pasted "Target URI", the address is remembered', sAz2.ok && sAz2.status.model === 'dep1' && sAz2.status.apiVersion === '2024-10-21' && (await ev('VE.web.net.trust.list()')).includes('https://myres.openai.azure.com'), sAz2.error || sAz2.status);
    await ev('window.__net.length = 0');
    const tAz = await ev('window.api.ai.test()');
    const netAz = await ev('window.__net');
    check('28 Azure: the request goes to the resource with the api-key header', tAz.ok && netAz.some((r) => r.url.startsWith('https://myres.openai.azure.com/openai/deployments/dep1/chat/completions') && r.headers['api-key'] === 'AZ_TEST_KEY_not_real_12345'), netAz.map((r) => r.url));
    // every GitHub Pages site of an account shares this browser storage: another page could have put an address on the saved list. Entering a key still asks.
    await ev("VE.web.net.trust.add('https://seeded.example.com')");
    await ev('(window.__veDialogs || []).length = 0');
    const seedUrl = 'https://seeded.example.com/openai/deployments/d1/chat/completions?api-version=2024-10-21';
    const sSeed1 = await ev(`(async () => { window.__veAnswers = [1]; return window.api.ai.save({ provider: 'azure', baseUrl: '${seedUrl}', model: '', apiKey: 'SEEDED_TEST_KEY_not_real_123' }); })()`);
    const stSeed1 = await status();
    check('29 an address that is already on the saved list still asks when a KEY is entered for it - declined: refused, the earlier setup and key are untouched', !sSeed1.ok && sSeed1.error.code === 'ENDPOINT_NOT_CONFIRMED' && (await dialogs()) === 1 && stSeed1.masked === '••••2345' && !stSeed1.baseUrl.includes('seeded'), { err: sSeed1.error, masked: stSeed1.masked, base: stSeed1.baseUrl });
    const sSeed2 = await ev(`(async () => { window.__veAnswers = [0]; return window.api.ai.save({ provider: 'azure', baseUrl: '${seedUrl}', model: '', apiKey: 'SEEDED_TEST_KEY_not_real_123' }); })()`);
    check('30 allowed: saved with the new key', sSeed2.ok && sSeed2.status.masked === '••••_123' && sSeed2.status.effectiveBaseUrl.startsWith('https://seeded.example.com'), sSeed2.error || { masked: sSeed2.status.masked, base: sSeed2.status.effectiveBaseUrl });
    await ev('(window.__veDialogs || []).length = 0');
    const sSeed3 = await ev(`window.api.ai.save({ provider: 'azure', baseUrl: '${seedUrl}', model: '' })`);
    check('31 saving the setup WITHOUT a new key does not ask again (the list is still what lets a later request go)', sSeed3.ok && (await dialogs()) === 0, sSeed3.error || sSeed3.status);
    await ev("VE.web.net.trust.remove('https://seeded.example.com')");
    await ev('window.__net.length = 0');
    await ev(`window.api.ai.save({ provider: 'anthropic', baseUrl: '', model: 'claude-test', apiKey: 'sk-ant-TEST_not_a_real_secret_1' })`);
    await ev('window.api.ai.test()');
    const netAn = await ev('window.__net');
    check('32 Anthropic: the browser header that lets a page call the API is added', netAn.length >= 1 && netAn.every((r) => r.headers['anthropic-dangerous-direct-browser-access'] === 'true' && r.headers['x-api-key'] === 'sk-ant-TEST_not_a_real_secret_1' && r.url.startsWith('https://api.anthropic.com/')), netAn);
    const sMove = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' })`);
    check('33 going to another provider without a new key drops the saved key (it is bound to its address)', sMove.ok && sMove.keyCleared === true && sMove.status.needs === 'key', sMove);
    const sV6 = await ev(`window.api.ai.save({ provider: 'local', baseUrl: 'http://[::1]:11434/v1', model: 'm' })`);
    const sLan = await ev(`window.api.ai.save({ provider: 'local', baseUrl: 'http://192.168.1.20:11434/v1', model: 'm' })`);
    check('34 a "local" model must be on this computer (127.0.0.1 / localhost); LAN addresses and IPv6 literals are refused', !sV6.ok && sV6.error.code === 'URL_NOT_LOCAL' && !sLan.ok && sLan.error.code === 'URL_NOT_LOCAL', [sV6.error, sLan.error]);
    const sHttp = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: 'http://example.com/v1', model: 'm', apiKey: 'abc' })`);
    check('35 plain http to a remote address is refused', !sHttp.ok && sHttp.error.code === 'URL_SCHEME', sHttp.error);
    const sFl = await ev(`window.api.ai.save({ provider: 'foundrylocal', baseUrl: 'http://evil.example', model: 'qwen3.5-4b', apiKey: 'sk-not-used' })`);
    check('36 "foundrylocal" is a provider of the web edition: it saves a model name only - no address, no key, no confirmation (the browser extension finds the server) - and it is not "ready to see pictures" until the model was asked', sFl.ok && sFl.status.provider === 'foundrylocal' && sFl.status.model === 'qwen3.5-4b' && sFl.status.ready && sFl.status.credential === 'none' && sFl.status.effectiveBaseUrl === '' && sFl.status.vision === false && sFl.status.cu.available === false && !sFl.status.urlError, sFl);
    const sFlBad = await ev(`window.api.ai.save({ provider: 'foundrylocal', model: '../shutdown' })`);
    const stAfter = await status();
    check('36b a model name that could change a request path is refused, and what was saved stays', !sFlBad.ok && sFlBad.error.code === 'FL_BAD_MODEL' && stAfter.model === 'qwen3.5-4b', { sFlBad, model: stAfter.model });
    await ev('VE.ai.refresh()');
    const seenByLlm = llm.log.length;
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const msgsNoExt = (await aiState()).messages;
    const lastNoExt = msgsNoExt[msgsNoExt.length - 1];
    check('36c without the extension a request says so at once (FL_NO_BRIDGE, with the shortcut to the settings) instead of waiting for an answer that never comes, and nothing was sent anywhere', !!lastNoExt && lastNoExt.type === 'error' && lastNoExt.code === 'FL_NO_BRIDGE' && lastNoExt.fix === true && /eklenti/i.test(lastNoExt.text) && llm.log.length === seenByLlm, lastNoExt);
    const useNoExt = await ev(`window.api.fl.use({ model: 'qwen3.5-4b' })`);
    check('36d "use this model" without the extension: FL_NO_BRIDGE', !useNoExt.ok && useNoExt.error.code === 'FL_NO_BRIDGE', useNoExt);
    const flState = await ev('window.api.fl.state()');
    check('36e the state says the extension is not there (and asks nothing else)', flState.ok && flState.bridge.present === false && flState.found === false && flState.ids.length === 0, flState);
    await ev('delete window.__veTest.netFetch');

    /* ---------------- local servers ---------------- */
    await ev(localSetup());
    const local = await status();
    check('37 a model server on this computer: configured with its key, no confirmation needed (it is this computer)', local.ready && local.provider === 'local' && local.vision === false, local);
    const found = await ev('window.api.ai.discover()');
    check('38 "find local servers" probes a few ports of this computer only; a server that needs a key is not listed', found.ok && Array.isArray(found.servers) && !found.servers.some((s) => s.port === llm.port), found);

    /* ---------------- the settings dialog: Foundry Local is a panel with four steps (here without the extension: the first step is open) ---------------- */
    await ev('VE.ai.refresh()');
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('.form-grid select')", 10000, 'the settings dialog');
    const saveLabel = await ev("VE.i18n.t('aiset.save')");
    const pick = (value) => ev(`(() => {
      const sel = document.querySelector('.form-grid select');
      sel.value = ${JSON.stringify(value)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const panel = document.querySelector('[data-fl=panel]');
      const save = Array.from(document.querySelectorAll('button.btn.primary')).find((b) => b.textContent === ${JSON.stringify(saveLabel)});
      const steps = panel ? Array.from(panel.querySelectorAll('[data-fl-step]')).map((s) => ({ step: s.getAttribute('data-fl-step'), state: s.getAttribute('data-state'), title: s.querySelector('.ti').textContent })) : [];
      const dl = panel ? panel.querySelector('a[data-fl=download]') : null;
      return {
        options: Array.from(sel.options).map((o) => o.value),
        panel: !!panel && panel.isConnected && panel.offsetParent !== null,
        title: panel ? panel.querySelector('.llm-title').textContent : '',
        steps,
        download: dl ? { href: dl.getAttribute('href'), download: dl.hasAttribute('download') } : null,
        links: panel ? Array.from(panel.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })) : [],
        commands: panel ? Array.from(panel.querySelectorAll('.flw-code')).map((c) => c.textContent) : [],
        hasPortInput: panel ? !!panel.querySelector('[data-fl=port], [data-fl=use-port]') : false,
        saveDisabled: !!save && save.disabled,
        urlRows: Array.from(document.querySelectorAll('.form-grid input[type=text]')).filter((i) => !i.hidden && i.offsetParent !== null).length,
        text: panel ? panel.textContent : '',
      };
    })()`);
    let fl = await pick('foundrylocal');
    // the panel asks the extension (hello, 1.5 s) and turns the first step to "to do" when nobody answers
    await app.waitFor("(document.querySelector('[data-fl-step=ext]') || {}).getAttribute && document.querySelector('[data-fl-step=ext]').getAttribute('data-state') === 'todo'", 15000, 'the first step to show that the extension is missing');
    fl = await pick('foundrylocal');
    check('39 the provider list has the model in this tab first, Foundry Local, and the six providers that work from a browser', JSON.stringify(fl.options) === JSON.stringify(['inbrowser', 'foundrylocal', 'openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local']), fl.options);
    check('40 choosing it shows the panel with four steps (extension, permission, Foundry Local, model); without the extension only the first is open, and there is no address / key form', fl.panel && fl.steps.map((s) => s.step).join() === 'ext,allow,server,model' && fl.steps[0].state === 'todo' && fl.steps.slice(1).every((s) => s.state === 'off') && fl.urlRows === 0 && !fl.saveDisabled, fl);
    const FL_RELEASE = 'https://github.com/ahmetcanalaca/videoeditor/releases/tag/foundry-bridge-v1.0.0';
    check('41 the first step offers the extension as a download from this site (a relative address: no third party), a how-to and how to check the zip (a command, and the release notes of this repository where its SHA-256 is written); the official Foundry Local page is the only other link; every link to another site is https, a new tab, noopener', fl.download && fl.download.href === 'extension/video-editor-foundry-bridge.zip' && fl.download.download === true && fl.links.filter((l) => l.target === '_blank').every((l) => (l.href === 'https://aka.ms/foundry-local-installer' || l.href === FL_RELEASE) && /noopener/.test(l.rel || '')) && fl.links.filter((l) => l.target === '_blank').length === 2 && fl.links.length === 3 && /Developer mode|Geliştirici modu/.test(fl.text) && fl.commands.includes('foundry server start') && fl.commands.includes('winget install Microsoft.FoundryLocal') && fl.commands.includes('Get-FileHash .\\video-editor-foundry-bridge.zip -Algorithm SHA256') && fl.hasPortInput === false, { download: fl.download, links: fl.links, commands: fl.commands });
    await app.screenshot(path.join(SHOTS, 'web-06-ai-settings-foundrylocal-tr-dark.png'));
    const lc = await pick('local');
    check('42 choosing the model server of this computer takes the panel away and the form is back', !lc.panel && !lc.saveDisabled && lc.urlRows >= 1, lc);
    await ev('VE.modal.close()');
    await ev('VE.ai.close()');
    // the same panel in English, light theme (for the screenshot)
    await app.click('#lang-switch button[data-lang=en]');
    await app.click('#btn-theme');
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('.form-grid select')", 10000, 'the settings dialog (English)');
    await pick('foundrylocal');
    await app.waitFor("(document.querySelector('[data-fl-step=ext]') || {}).getAttribute && document.querySelector('[data-fl-step=ext]').getAttribute('data-state') === 'todo'", 15000, 'the first step (English)');
    const flEn = await pick('foundrylocal');
    check('43 in English the panel is English (title, the four step names, the steps\' texts)', flEn.title === 'Connect Foundry Local' && flEn.steps.map((s) => s.title).join('|') === 'Browser extension|Permission for this site|Foundry Local|Model' && !/[ğüşıöçĞÜŞİÖÇ]/.test(flEn.text) && /Developer mode/.test(flEn.text), { title: flEn.title, steps: flEn.steps.map((s) => s.title), text: flEn.text.slice(0, 200) });
    await app.screenshot(path.join(SHOTS, 'web-09-ai-settings-foundrylocal-en-light.png'));
    await ev('VE.modal.close()');
    await app.click('#lang-switch button[data-lang=tr]');
    await app.click('#btn-theme');

    check('44 no console errors during the whole run', app.errors.length === 0, app.errors);
  } finally {
    await app.close();
    await llm.stop();
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('ai test crashed:', e); process.exit(1); });
