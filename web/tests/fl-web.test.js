'use strict';
// Foundry Local in the web edition, the whole way: the extension (test build) in a real Chrome / Edge, a stand-in for Foundry Local on this computer (no CORS headers,
// like the real one), and the page doing everything through the settings dialog and the assistant - the four steps turn green by themselves (extension, the user's
// approval in the extension's own window, Foundry Local found, a model loaded and asked whether it sees pictures), then "turuncu arabaya zoom yap" runs find_in_video
// with pictures that a stand-in vision model really decodes (tests/locate-world.js: a car on the left from 1 to 5 s, on the right from 9 to 13 s), a model that is
// not loaded gets loaded, Foundry Local going away and coming back on another port is found again, and the approval can be withdrawn.
//   node tests/fl-web.test.js        (VE_BROWSER=<chrome|edge exe>; VE_HEADED=1 shows the browser; needs ffmpeg for the test film: see tests/lib/media-tools.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const pack = require('../scripts/pack-extension');
const { open, checker } = require('./lib/site');
const { sleep, waitUntil } = require('./lib/browser');
const h = require('./lib/media-tools');
const mock = require('./lib/mock-foundry');
const world = require('../../tests/locate-world');

const SHOTS = process.env.VE_SHOTS || path.join(os.tmpdir(), 've-web-shots');
const SW_URL = /^chrome-extension:\/\/([a-p]{32})\/background\.js$/;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const check = checker('web foundry local (end to end)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-fl-web-'));
  const extDir = path.join(tmp, 'ext');
  pack.buildFolder({ out: extDir, variant: 'test' });

  const queue = []; // scripted answers of the chat model, one per request that carries tools
  const chatRequests = [];
  const pictures = []; // what the page showed the vision model
  const probes = []; // the question "can you see pictures?"
  const pings = [];
  const problems = [];
  const calls = (list) => ({ tool_calls: list.map((c) => ({ name: c[0], args: c[1] })) });
  const lastTool = (body) => JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content);
  const chat = async (body, entry) => {
    if (world.isPictureRequest(body)) {
      const { jpeg, record } = world.pictureOf(body, entry.headers, null);
      if (/What shape is in the picture/.test(String(record.prompt))) { probes.push(record); return { content: 'circle' }; }
      pictures.push(record);
      const a = world.visionAnswer(h, record.prompt, jpeg, 'orange');
      record.box = a.box;
      return { content: a.text };
    }
    if (!body.tools || !body.tools.length) { pings.push(body); return { content: 'OK' }; }
    chatRequests.push(body);
    const f = queue.shift();
    try { return f ? f(body) : { content: '(no script)' }; } catch (e) { problems.push(String((e && e.message) || e)); return { content: '(script failed)' }; }
  };
  let mf = await mock.start({ chat });

  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820, extensions: [extDir], userData: path.join(tmp, 'profile') });
  const ev = (expr) => app.evaluate(expr);
  const swTarget = async () => (await app.targets()).find((t) => t.type === 'service_worker' && SW_URL.test(t.url));
  const extId = SW_URL.exec((await swTarget()).url)[1];
  const inSw = async (expr) => { const c = await app.attach(await swTarget()); try { return await c.evaluate(expr); } finally { c.close(); } };
  const consentTarget = async () => (await app.targets()).find((t) => t.url.startsWith('chrome-extension://' + extId + '/consent.html'));
  const answerConsent = async (allow) => {
    const t = await waitUntil(consentTarget, 15000, 'the approval window');
    const c = await app.attach(t);
    try {
      await waitUntil(() => c.evaluate("!document.getElementById('ask').hidden"), 10000, 'the approval window to fill');
      const shown = await c.evaluate("({ origin: document.getElementById('origin').textContent, title: document.getElementById('title').textContent })");
      // ("Allow" is disabled for the first moment: a click meant for the page must not approve)
      if (allow) await waitUntil(() => c.evaluate("!document.getElementById('allow').disabled"), 10000, 'the Allow button to be enabled');
      await c.evaluate("document.getElementById('" + (allow ? 'allow' : 'deny') + "').click(); true");
      return shown;
    } finally { c.close(); }
  };
  const step = (name) => ev(`(() => { const s = document.querySelector('[data-fl-step=${name}]'); return s ? { state: s.getAttribute('data-state'), status: s.querySelector('.st').textContent, bodyHidden: s.querySelector('.flw-body').hidden } : null; })()`);
  const waitStep = (name, state, ms) => app.waitFor(`(() => { const s = document.querySelector('[data-fl-step=${name}]'); return !!s && s.getAttribute('data-state') === ${JSON.stringify(state)}; })()`, ms || 20000, 'step ' + name + ' to be ' + state);
  const resultLine = () => ev(`(() => { const r = document.querySelector('.ai-result'); return r && !r.hidden ? { cls: r.className, text: r.textContent } : null; })()`);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const dbg = () => ev('VE.ai.debug()');
  const waitIdle = (ms) => app.waitFor('!VE.ai.isRunning()', ms || 240000, 'the assistant to finish');
  const send = async (prompt) => { await ev(`(() => { VE.ai.send(${JSON.stringify(prompt)}); return true; })()`); await sleep(300); };
  const steps = (kind) => ev(`(window.__steps || []).filter((e) => e.kind === ${JSON.stringify(kind)})`);
  const zoomed = (list) => list.filter((s) => s.zoomTo > 1.01 || s.zoomFrom > 1.01);
  const lastMessage = async () => { const m = (await dbg()).messages; return m[m.length - 1]; };

  try {
    check('01 no console errors on load', app.errors.length === 0, app.errors);
    const film = path.join(app.fixDir, 'L_orange_car.mp4');
    world.makeFilm(h, film);
    await app.stage([path.basename(film)]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1 && VE.state.S.media.size === 1', 30000, 'one clip');
    await ev("window.__steps = []; window.api.on('ai:step', (e) => window.__steps.push(e)); true");

    /* ---------------- the four steps ---------------- */
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('.form-grid select')", 10000, 'the settings dialog');
    await ev(`(() => { const sel = document.querySelector('.form-grid select'); sel.value = 'foundrylocal'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitStep('ext', 'ok');
    const s1 = await step('ext');
    check('02 the extension is seen at once (no reload of the page): step 1 is green with its version; step 2 waits for the user', /1\.0\.0/.test(s1.status) && s1.bodyHidden === true && (await step('allow')).state === 'todo' && (await step('server')).state === 'off' && (await step('model')).state === 'off', await Promise.all(['ext', 'allow', 'server', 'model'].map(step)));
    check('03 nothing is sent to Foundry Local before the approval', mf.log.length === 0, mf.paths());

    await app.click('[data-fl=allow]');
    const shown = await answerConsent(false);
    await waitStep('allow', 'todo');
    check('04 "Allow…" opens the extension\'s own window with this site\'s origin; "Deny" leaves step 2 open and says so', shown.origin === app.origin && (await step('allow')).state === 'todo' && mf.log.length === 0, shown);
    await app.click('[data-fl=allow]');
    await answerConsent(true);
    await waitStep('allow', 'ok');
    await waitStep('server', 'todo');
    const cmds = await ev("Array.from(document.querySelectorAll('[data-fl-step=server] .flw-code')).map((c) => c.textContent)");
    check('05 allowed: step 2 is green; Foundry Local is on a port nobody told the page about: step 3 asks for it and shows the commands (install, start, fix the port)', (await step('allow')).state === 'ok' && cmds.includes('foundry server start') && cmds.includes('foundry config set port 5272') && (await step('model')).state === 'off', cmds);

    // The port is given to the extension - its own window, which writes it into its storage; here the storage is written - not to the page: the page has no field for it
    check('05b the page has no field for a port: a page cannot name one (it is typed into the extension\'s own window)', (await ev("!document.querySelector('[data-fl=port], [data-fl=use-port]')")) === true, null);
    await inSw(`chrome.storage.local.set({ port: ${mf.port} })`);
    await app.click('[data-fl=recheck]');
    await waitStep('server', 'ok');
    await waitStep('model', 'todo');
    const s3 = await step('server');
    const dl = await ev("Array.from(document.querySelectorAll('#flw-models option')).map((o) => o.value)");
    check('06 the port is verified by the extension (the answer of /status names exactly that address): step 3 is green with the address; step 4 lists the catalogue, the recommended alias first', s3.status.includes('127.0.0.1:' + mf.port) && dl.length === 5 && dl[0] === 'qwen3.5-4b' && dl.includes('qwen3.5-4b-generic-cpu:3'), { s3, dl });
    await app.screenshot(path.join(SHOTS, 'web-fl-step4-open-tr-dark.png'));

    const modelValue = await ev("document.querySelector('[data-fl=model]').value");
    check('07 the model field starts with the recommended alias', modelValue === 'qwen3.5-4b', modelValue);
    await app.click('[data-fl=use]');
    await waitStep('model', 'ok', 60000);
    const line = await resultLine();
    const sUse = await ev('window.api.ai.status()');
    const paths = mf.paths();
    check('08 "Load and use": by ALIAS - Foundry Local picks the variant (qwen3.5-4b-generic-cpu:3) and says which; step 4 is green with that id', (await step('model')).status === 'qwen3.5-4b-generic-cpu:3' && paths.includes('GET /models/load/qwen3.5-4b') && mf.loaded.has('qwen3.5-4b-generic-cpu:3'), { step: await step('model'), paths });
    check('09 the model was asked a question and whether it sees pictures (a picture of 64 x 64 pixels): it does - saved as the model of the assistant, vision on, ready, no key, no address', probes.length === 1 && pings.length >= 1 && sUse.provider === 'foundrylocal' && sUse.model === 'qwen3.5-4b-generic-cpu:3' && sUse.vision === true && sUse.ready && sUse.credential === 'none' && sUse.effectiveBaseUrl === '' && /Hazır/.test(line && line.text) && /görüntüye de bakabilir/i.test(line.text), { probes: probes.length, line, sUse });
    check('10 the probe picture is small (a JPEG of 64 x 64) and the model was asked in the Foundry flavour (reasoning off, no key header)', probes[0].jpegHeader && probes[0].size.width === 64 && probes[0].size.height === 64 && mf.log.filter((e) => e.method === 'POST').every((e) => e.body.reasoning_effort === 'none' && !e.headers.authorization), probes[0].size);
    await app.screenshot(path.join(SHOTS, 'web-fl-ready-tr-dark.png'));
    await ev('VE.modal.close()');
    const stored = await ev('localStorage.getItem("ve.web.ai.v1")');
    check('11 what is remembered is the model and whether it sees pictures - no address, no key', JSON.parse(stored).provider === 'foundrylocal' && JSON.parse(stored).model === 'qwen3.5-4b-generic-cpu:3' && JSON.parse(stored).flVision.ok === true && JSON.parse(stored).baseUrl === '' && !/127\.0\.0\.1|localhost|:\d{4,5}|sk-/.test(stored), stored);

    /* ---------------- an edit by time ---------------- */
    await ev('VE.ai.open()');
    await ev('VE.ai.refresh()');
    await sleep(300);
    queue.push((body) => calls([['remove_range', { first_seconds: 3 }]]), () => ({ content: 'Done: the first 3 seconds are removed.' }));
    const before = chatRequests.length;
    await send('ilk 3 saniyeyi kes');
    await waitIdle();
    const afterCut = await segs();
    const req1 = chatRequests[before];
    const toolNames = req1.tools.map((t) => t.function.name);
    check('12 an edit by time goes through the extension to Foundry Local and is applied (the first 3 s are gone); the model was offered find_in_video because it sees pictures', problems.length === 0 && afterCut.length === 1 && near(afterCut[0].in, 3, 0.05) && toolNames.includes('find_in_video') && toolNames.includes('remove_range'), { problems, afterCut, toolNames });
    await app.key('z', { ctrl: true });
    await sleep(300);
    check('13 ONE Ctrl+Z undoes it', (await segs())[0].in === 0, await segs());

    /* ---------------- find_in_video: the pictures go to the model, the zoom aims at the car ---------------- */
    const seen = {};
    queue.length = 0;
    queue.push(
      (body) => { seen.system = body.messages[0].content; return calls([['find_in_video', { object: 'car', color: 'orange' }]]); },
      (body) => { seen.found = lastTool(body); return calls([['set_zoom', { found: seen.found.found_id || 'f1', mode: 'in' }]]); },
      (body) => { seen.zoom = lastTool(body); return { content: 'Turuncu arabanın olduğu bölümlere arabaya odaklı yakınlaştırma ekledim.' }; },
    );
    await ev('window.__steps.length = 0; true');
    await send('turuncu arabaya zoom yap');
    await waitIdle(300000);
    const msgs = (await dbg()).messages;
    const last = msgs[msgs.length - 1];
    check('14 the run finished without script problems and without an error', problems.length === 0 && last.type === 'ai', { problems, last });
    const f = seen.found || {};
    const iv = f.intervals || f.parts || [];
    check('15 find_in_video found the two times of the car (1-5 s and 9-13 s, about) with the pictures that were shown to the model through the extension: ' + pictures.length + ' pictures', f.ok !== false && iv.length === 2 && near(iv[0].start, 1, 1.1) && near(iv[0].end, 5, 1.1) && near(iv[1].start, 9, 1.1) && near(iv[1].end, 13, 1.1) && pictures.length >= 6, { f, pictures: pictures.length });
    const after = await segs();
    const z = zoomed(after);
    const zl = z.filter((s) => s.in < 6);
    const zr = z.filter((s) => s.in > 8);
    check('16 the zoom is only inside the two parts, up to a factor above 1.3', zl.length >= 1 && zr.length >= 1 && z.length === zl.length + zr.length && Math.max(...zl.map((s) => s.zoomTo)) > 1.3 && Math.max(...zr.map((s) => s.zoomTo)) > 1.3, after);
    check('17 THE ZOOM AIMS AT THE CAR: the first part at the left (x about 0.25), the second at the right (x about 0.75), both at mid height', zl.length > 0 && zr.length > 0 && zl.every((s) => near(s.fx, 0.25, 0.06) && near(s.fy, 0.5, 0.08)) && zr.every((s) => near(s.fx, 0.75, 0.06) && near(s.fy, 0.5, 0.08)), { zl, zr });
    const st = await steps('search');
    check('18 progress was shown (start ... done) and the pictures are small JPEGs of at most 768 px, asked "is there ... YES or NO" and "locate ...", and went nowhere but Foundry Local', st.length >= 3 && st[0].phase === 'start' && st[st.length - 1].phase === 'done' && pictures.every((p) => p.jpegHeader && Math.max(p.size.width, p.size.height) <= 768 && p.bytes < 400 * 1024) && pictures.some((p) => /Answer with one word: YES or NO/.test(p.prompt)) && pictures.some((p) => /^Locate/.test(String(p.prompt))), { phases: st.map((s) => s.phase), n: pictures.length });
    await app.key('z', { ctrl: true });
    await sleep(300);
    check('19 ONE undo gives the original clip back', !(zoomed(await segs()).length), await segs());

    /* ---------------- a model that is not loaded any more is loaded again by itself ---------------- */
    mf.loaded.clear();
    mf.log.length = 0;
    queue.length = 0;
    queue.push(() => calls([['remove_range', { first_seconds: 2 }]]), () => ({ content: 'Done.' }));
    await ev('window.__steps.length = 0; true');
    await send('ilk 2 saniyeyi kes');
    await waitIdle();
    const pathsLoad = mf.paths();
    const firstChat = pathsLoad.indexOf('POST /v1/chat/completions');
    const loadAt = pathsLoad.indexOf('GET /models/load/qwen3.5-4b-generic-cpu%3A3');
    const phases = (await ev("(window.__steps || []).filter((e) => e.kind === 'phase').map((e) => e.phase)"));
    check('20 Foundry Local says "must be loaded": the page loads that very model (by its id) and repeats the request; the live card showed "loading"', firstChat >= 0 && loadAt > firstChat && pathsLoad.indexOf('POST /v1/chat/completions', loadAt) > loadAt && phases.includes('loading') && (await segs())[0].in > 1.9, { pathsLoad, phases });
    await app.key('z', { ctrl: true });
    await sleep(300);

    /* ---------------- a model that only reads text ---------------- */
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('.form-grid select')", 10000, 'the settings dialog');
    await waitStep('model', 'ok');
    await ev(`(() => { const m = document.querySelector('[data-fl=model]'); m.value = 'qwen2.5-1.5b'; m.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await app.click('[data-fl=use]');
    await app.waitFor("(document.querySelector('.ai-result') || {}).textContent && /Hazır/.test(document.querySelector('.ai-result').textContent) && /Yalnızca metin/.test(document.querySelector('.ai-result').textContent)", 60000, 'the text model to be ready');
    const sText = await ev('window.api.ai.status()');
    check('21 a model that cannot see pictures (Foundry Local answers the probe with HTTP 400): saved, vision off, and the result line says it works with time ranges only', sText.model === 'qwen2.5-1.5b-instruct-generic-gpu:4' && sText.vision === false && sText.ready, sText);
    await ev('VE.modal.close()');
    queue.length = 0;
    queue.push((body) => calls([['remove_range', { first_seconds: 1 }]]), () => ({ content: 'Done.' }));
    const nReq = chatRequests.length;
    await send('ilk saniyeyi kes');
    await waitIdle();
    check('22 and then the assistant is not offered find_in_video', !chatRequests[nReq].tools.some((t) => t.function.name === 'find_in_video') && chatRequests[nReq].model === 'qwen2.5-1.5b-instruct-generic-gpu:4', chatRequests[nReq].tools.map((t) => t.function.name));
    await app.key('z', { ctrl: true });
    await sleep(300);
    // back to the model that sees pictures
    await ev(`window.api.fl.use({ model: 'qwen3.5-4b' })`);

    /* ---------------- Foundry Local goes away and comes back on another port ---------------- */
    await mf.stop();
    queue.length = 0;
    queue.push(() => calls([['remove_range', { first_seconds: 1 }]]), () => ({ content: 'Done.' }));
    await send('ilk saniyeyi kes');
    await waitIdle(120000);
    const gone = await lastMessage();
    check('23 Foundry Local is gone: a clear message that says what to type ("foundry server start") - not a hang, not "network error"', gone.type === 'error' && gone.code === 'FL_NOT_FOUND' && /foundry server start/.test(gone.text) && gone.fix === true, gone);
    mf = await mock.start({ chat });
    mf.loaded.add('qwen3.5-4b-generic-cpu:3');
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-fl-step=server]')", 10000, 'the panel');
    await waitStep('server', 'todo');
    if (mf.port >= 49152) {
      await app.click('[data-fl=scan]');
      await waitStep('server', 'ok', 120000);
      check('24 Foundry Local is back on another port: "Find automatically" (a click) scans the dynamic range and finds it (' + mf.port + ')', (await step('server')).status.includes('127.0.0.1:' + mf.port), await step('server'));
    } else {
      await inSw(`chrome.storage.local.set({ port: ${mf.port} })`);
      await app.click('[data-fl=recheck]');
      await waitStep('server', 'ok');
      console.log('NOTE: the stand-in is below the dynamic range (' + mf.port + '): the scan was not tested here (fl-bridge.test.js tests it)');
    }
    await ev('VE.modal.close()');
    queue.length = 0;
    queue.push(() => calls([['remove_range', { first_seconds: 1 }]]), () => ({ content: 'Done.' }));
    await send('ilk saniyeyi kes');
    await waitIdle();
    check('25 and the assistant works again, with the model that was loaded there', problems.length === 0 && (await lastMessage()).type === 'ai' && (await segs())[0].in > 0.9, await lastMessage());
    await app.key('z', { ctrl: true });
    await sleep(300);

    /* ---------------- the approval is the user's to withdraw ---------------- */
    const origin = app.origin;
    await inSw(`chrome.storage.local.get('approved').then((r) => { const a = r.approved || {}; delete a[${JSON.stringify(origin)}]; return chrome.storage.local.set({ approved: a }); })`);
    queue.length = 0;
    await send('ilk saniyeyi kes');
    await waitIdle(60000);
    const revoked = await lastMessage();
    check('26 after the user withdrew the approval (extension icon): the next request says so (FL_NOT_APPROVED, with the shortcut to the settings) and Foundry Local gets nothing', revoked.type === 'error' && revoked.code === 'FL_NOT_APPROVED' && revoked.fix === true && /izin/i.test(revoked.text), revoked);

    /* ---------------- the extension is removed: the next request says so ---------------- */
    // (the page notices at once; the extension's content script answers "hello" only while the extension is there)
    const bridge = await ev('VE.web.flBridge.detect()');
    check('27 the page can tell the extension is there (hello) - and with another page marker nothing answers', bridge.present === true && bridge.approved === false, bridge);
    await ev(`new Promise((resolve) => { const on = (e) => { if (e.data && e.data.source === 've-fl-ext' && e.data.type === 'reply' && e.data.id === 999) { window.__rogue = e.data.reply; } }; window.addEventListener('message', on); window.postMessage({ source: 'evil', id: 999, op: 'hello' }, location.origin); setTimeout(() => resolve(true), 800); })`);
    check('28 a message without the page marker is ignored by the extension (no reply)', (await ev('window.__rogue === undefined')) === true);

    const unexpected = app.errors.filter((e) => !/Failed to load resource|net::ERR_/.test(String(e)));
    check('90 no console errors during the whole run', unexpected.length === 0, unexpected);
  } finally {
    await app.close();
    await mf.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('fl-web test crashed:', e); process.exit(1); });
