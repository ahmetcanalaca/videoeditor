'use strict';
// Video analysis with Azure Content Understanding (Foundry) in the web edition, in a real browser against the desktop app's mock of the service
// (tests/cu-mock.js, behind a small CORS proxy because a page is another origin): settings, "test the connection" (nothing is uploaded), a complete request
// (consent dialog, a reduced copy made IN THE PAGE and uploaded through the network worker, polling, the service copy deleted, scenes read by the model, ONE
// undo step), the result cache (no second upload), a declined upload, a service error, cancelling, the Entra token instead of a key, key hygiene.
//   node tests/cu.test.js        (VE_BROWSER=<chrome|edge exe>; needs ffmpeg/ffprobe for the test videos)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open, checker } = require('./lib/site');
const h = require('./lib/media-tools');
const mock = require('./lib/mock-llm');
const { startMockCu, makeResult } = require('../../tests/cu-mock');

const KEY = 'CU_WEB_KEY_not_a_real_secret_0123456789';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.CU_WEB_TOKEN_not_a_real_token.c2ln';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const calls = (list) => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } } });

(async () => {
  const check = checker('web cu');
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const ev = (expr) => app.evaluate(expr);
  const A = path.basename(app.fixtures.A);

  const chatQueue = [];
  const chatRequests = [];
  const problems = [];
  const cu = await startMockCu({
    key: KEY,
    polls: 1,
    result: (info) => makeResult(info.seconds || 8, { sceneSeconds: 2 }),
    chat: (entry, body) => {
      if (entry.method === 'GET') return { json: { data: [{ id: 'mock-model' }] } };
      if (body && !body.tools) return text('OK'); // connection test
      chatRequests.push(body);
      const f = chatQueue.shift();
      try { return f ? f(body) : text('(no script)'); } catch (e) { problems.push(String((e && e.message) || e)); return text('(script failed)'); }
    },
  });
  const proxy = await mock.corsProxy(cu.port);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo }))');
  const dbg = () => ev('VE.ai.debug()');
  const waitIdle = (ms) => app.waitFor('!VE.ai.isRunning()', ms || 120000, 'the assistant to finish');
  const ask = async (prompt) => { await ev(`(() => { VE.ai.send(${JSON.stringify(prompt)}); return true; })()`); await sleep(300); await waitIdle(); };
  const dialogs = () => ev('window.__veDialogs || []');
  const phases = () => ev("(window.__steps || []).filter((e) => e.kind === 'analysis').map((e) => e.phase)");
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  try {
    check('01 no console errors on load', app.errors.length === 0, app.errors);
    await app.stage([A]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1 && VE.state.S.media.size === 1', 30000, 'one clip');
    await ev("window.__steps = []; window.api.on('ai:step', (e) => window.__steps.push(e)); true");

    /* ---------------- settings ---------------- */
    const saved = await ev(`window.api.ai.save({ provider: 'foundry', baseUrl: '${proxy.origin}', model: 'mock-model', apiKey: '${KEY}', cu: { enabled: true, endpoint: '', analyzer: 'prebuilt-videoSearch', location: 'geography' } })`);
    check('02 Foundry + video analysis saved: ready, derived address = the Foundry address, the key is not in the answer', saved.ok && saved.status.ready && saved.status.cu.available && saved.status.cu.enabled && saved.status.cu.ready && saved.status.cu.effectiveEndpoint === proxy.origin && saved.status.cu.analyzer === 'prebuilt-videoSearch' && !JSON.stringify(saved).includes(KEY), saved);
    check('03 a loopback address needs no confirmation dialog', (await dialogs()).length === 0, await dialogs());
    const stored = await ev('JSON.stringify([localStorage.getItem("ve.web.ai.v1"), localStorage.getItem("ve.web.ai.cutrust.v1"), sessionStorage.getItem("ve.web.ai.key.v1")])');
    check('04 the key is only in sessionStorage (bound to its address), never in the settings', stored.split(KEY).length === 2 && JSON.parse(stored)[2].includes(KEY) && !JSON.parse(stored)[0].includes(KEY));

    /* ---------------- test the connection ---------------- */
    const t1 = await ev('window.api.ai.cuTest()');
    check('05 "test the connection": the model deployments are listed; nothing is uploaded (GET requests only)', t1.ok && JSON.stringify(t1).includes('gpt-4.1') && cu.uploads.length === 0 && cu.requests.filter((r) => r.path.startsWith('/contentunderstanding/')).every((r) => r.method === 'GET'), t1);
    cu.options.defaults = {};
    const t2 = await ev('window.api.ai.cuTest()');
    check('06 a resource without default model deployments is reported (defaultsSet false) so that the settings can explain what to do', t2.ok === true && t2.defaultsSet === false, t2);
    cu.options.defaults = { 'gpt-4.1': 'gpt41' };
    cu.options.key = 'another-key';
    const t3 = await ev('window.api.ai.cuTest()');
    check('07 a wrong key is reported as such', !t3.ok && /AUTH|key|anahtar/i.test(JSON.stringify(t3)), t3);
    cu.options.key = KEY;
    const t4 = await ev('window.api.ai.cuTest()');
    check('08 and it works again with the right key', t4.ok === true, t4);

    /* ---------------- a complete request ---------------- */
    await ev('VE.ai.open()');
    await sleep(300);
    chatQueue.push(
      (body) => {
        const names = body.tools.map((t) => t.function.name);
        if (!(names.includes('analyze_video') && !names.includes('find_in_video'))) throw new Error('tools: ' + names.join(','));
        if (!/READING THE VIDEO/.test(body.messages[0].content)) throw new Error('system prompt');
        return calls([['analyze_video', { query: 'dog' }]]);
      },
      (body) => {
        const tool = body.messages.filter((m) => m.role === 'tool').pop();
        const r = JSON.parse(tool.content);
        if (!(r.ok === true && r.scene_count >= 3 && Array.isArray(r.matches) && r.matches.length >= 1)) throw new Error('tool result: ' + tool.content.slice(0, 300));
        if ('ui' in r || tool.content.includes(KEY)) throw new Error('not a clean tool result');
        const dog = r.scenes.find((s) => s.match);
        if (!/dog/i.test(dog.description)) throw new Error('the matching scene is not about the dog: ' + dog.description);
        return calls([['set_speed', { start: dog.start, end: dog.end, speed: 2 }]]);
      },
      () => text('I made the scene with the dog twice as fast. Ctrl+Z undoes it.'),
    );
    await ev('window.__veAnswers = [0]'); // "upload and analyse"
    await ev('window.__steps.length = 0; true');
    await ask('speed up the scene with the dog');
    const dlg = await dialogs();
    check('09 one question before anything leaves: the address, the size and parts, the file and its length, the analyzer and location, and what happens to the copy', dlg.length === 1 && dlg[0].message.includes(proxy.origin) && /\d+ MB/.test(dlg[0].message) && /1 parça/.test(dlg[0].message) && /A_audio_720p\.mp4 \(8 s\)/.test(dlg[0].detail) && /prebuilt-videoSearch/.test(dlg[0].detail) && /sildirilir/.test(dlg[0].detail) && dlg[0].buttons.length === 2, dlg);
    check('10 the model got the scenes (no script problems)', problems.length === 0 && chatRequests.length === 3, { problems, n: chatRequests.length });
    check('11 exactly one upload, with the key header only (no Authorization), the processing location and API version', cu.uploads.length === 1 && cu.uploads[0].headers['ocp-apim-subscription-key'] === KEY && !cu.uploads[0].headers.authorization && cu.uploads[0].query.processingLocation === 'geography' && cu.uploads[0].query['api-version'] === '2025-11-01', cu.uploads[0] && { headers: cu.uploads[0].headers, query: cu.uploads[0].query });
    const up = cu.uploads[0];
    const proxyFile = path.join(os.tmpdir(), 've-web-cu-upload.mp4');
    fs.writeFileSync(proxyFile, up.bytes);
    const s = h.streamsOf(proxyFile);
    const probe = h.probeJson(proxyFile);
    const tags = (probe.format && probe.format.tags) || {};
    check('12 what was uploaded is a reduced copy made in the page: a real MP4, short side 480, with sound, the length of the clip, small (≈ 0.04 MB per second), with no location metadata', s.v && Math.min(s.v.width, s.v.height) === 480 && !!s.a && near(s.duration, 8, 0.5) && up.bytes.length < 700 * 1024 && !Object.keys(tags).some((k) => /location|gps|iso6709/i.test(k)), { v: s.v && [s.v.width, s.v.height], a: s.a && [s.a.channels, s.a.sample_rate, s.a.bit_rate], d: s.duration, bytes: up.bytes.length, tags });
    fs.rmSync(proxyFile, { force: true });
    await sleep(300);
    check('13 the copy on the service was deleted after the analysis', cu.deleted.length === 1, cu.deleted);
    const ph = await phases();
    check('14 progress was reported: start, plan, prepare, upload, wait, done', ['start', 'plan', 'prepare', 'upload', 'wait', 'done'].every((p) => ph.includes(p)), ph);
    const after = await segs();
    check('15 the scene with the dog (the first one) is twice as fast, the rest is untouched', after.length === 2 && after[0].speed === 2 && after[1].speed === 1 && near(after[0].in, 0, 0.3) && near(after[0].out, 2, 0.3), after);
    const msgs = (await dbg()).messages;
    const last = msgs[msgs.length - 1];
    check('16 the answer lists the analysis (scenes read, one part uploaded)', last.type === 'ai' && Array.isArray(last.analyses) && last.analyses[0].count >= 3 && last.analyses[0].uploaded === 1, last.analyses);
    await app.key('z', { ctrl: true });
    await sleep(300);
    const undone = await segs();
    check('17 ONE undo gives the original clip back', undone.length === 1 && undone[0].speed === 1, undone);
    check('18 the key never went into a prompt', !chatRequests.some((b) => JSON.stringify(b).includes(KEY)));

    /* ---------------- the same video again: the result is remembered in this browser ---------------- */
    const dialogsBefore = (await dialogs()).length;
    const uploadsBefore = cu.uploads.length;
    chatQueue.push(
      () => calls([['analyze_video', {}]]),
      (body) => {
        const r = JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content);
        if (!(r.ok && r.cached === true && r.uploaded_parts === 0)) throw new Error('not cached: ' + JSON.stringify({ ok: r.ok, cached: r.cached }));
        return calls([['set_zoom', { start: r.scenes[0].start, end: r.scenes[0].end, mode: 'in' }]]);
      },
      () => text('Zoomed in on the first scene.'),
    );
    await ask('zoom in on the first scene');
    const cache = await ev('window.api.ai.status().then((s) => s.cu.cache)');
    check('19 the second request: no question, no upload; the result comes from this browser', problems.length === 0 && (await dialogs()).length === dialogsBefore && cu.uploads.length === uploadsBefore && cache.files === 1 && cache.bytes > 100, { problems, cache });
    const rec = await ev(`new Promise((resolve) => { const r = indexedDB.open('ve-cu-cache', 1); r.onsuccess = () => { const q = r.result.transaction('analysis', 'readonly').objectStore('analysis').getAll(); q.onsuccess = () => resolve(JSON.stringify(q.result)); }; r.onerror = () => resolve('ERR'); })`);
    check('20 the stored record holds no key and no file name or path', rec !== 'ERR' && !rec.includes(KEY) && !/A_audio_720p|C:\\\\/.test(rec), rec.slice(0, 200));
    await app.key('z', { ctrl: true });
    await sleep(300);

    /* ---------------- a declined upload ---------------- */
    await ev('window.api.ai.cuClearCache()');
    const upBefore = cu.uploads.length;
    chatQueue.push(
      () => calls([['analyze_video', {}]]),
      (body) => {
        const tool = body.messages.filter((m) => m.role === 'tool').pop();
        if (!/did not allow the upload/i.test(tool.content)) throw new Error('declined sentence: ' + tool.content);
        return text('Understood, nothing was uploaded.');
      },
    );
    await ev('window.__veAnswers = [1]'); // cancel
    await ask('analyse the video');
    const m2 = (await dbg()).messages;
    check('21 "Cancel" in the upload question: nothing is uploaded, the model is told, the timeline is untouched', problems.length === 0 && cu.uploads.length === upBefore && (await segs()).length === 1 && m2[m2.length - 1].type === 'ai', { problems, uploads: cu.uploads.length - upBefore });

    /* ---------------- a service error ---------------- */
    cu.options.failOperation = { code: 'ModelDeploymentNotFound', message: 'Default model deployment for gpt-4.1 is not configured' };
    const beforeErr = JSON.stringify(await segs());
    chatQueue.push(
      () => calls([['analyze_video', {}]]),
      (body) => {
        const tool = body.messages.filter((m) => m.role === 'tool').pop();
        if (!(/model deployments/.test(tool.content) && /Content Understanding Studio/.test(tool.content) && !/ModelDeploymentNotFound|boom/.test(tool.content))) throw new Error('sentence for the model: ' + tool.content);
        return text('The model deployments are not set up for Content Understanding.');
      },
    );
    await ev('window.__veAnswers = [0]');
    await ask('find the scenes');
    cu.options.failOperation = null;
    check('22 a service error becomes a plain sentence for the model; nothing is edited; the analysis is not cached', problems.length === 0 && JSON.stringify(await segs()) === beforeErr && (await ev('window.api.ai.status().then((s) => s.cu.cache.files)')) === 0, problems);

    /* ---------------- stop during the analysis ---------------- */
    cu.options.polls = 100000;
    const deletedBefore = cu.deleted.length;
    chatQueue.push(() => calls([['analyze_video', {}]]), () => text('(never reached)'));
    await ev('window.__veAnswers = [0]; window.__steps.length = 0; true');
    await ev("(() => { VE.ai.send('analyse the video'); return true; })()");
    await app.waitFor("window.__steps.some((e) => e.kind === 'analysis' && e.phase === 'wait')", 60000, 'waiting for the service');
    await ev('VE.ai.cancel()');
    await waitIdle(20000);
    await sleep(600);
    const m3 = (await dbg()).messages;
    check('23 Stop during the analysis ends it at once; the copy on the service is deleted; nothing is edited', m3[m3.length - 1].type === 'info' && cu.deleted.length === deletedBefore + 1 && (await segs()).length === 1, { last: m3[m3.length - 1], deleted: cu.deleted.length - deletedBefore });
    cu.options.polls = 1;
    chatQueue.length = 0;

    /* ---------------- the Entra token instead of a key ---------------- */
    const entra = await ev(`window.api.ai.save({ provider: 'foundry', auth: 'entra', baseUrl: '${proxy.origin}', model: 'mock-model', apiKey: '${TOKEN}', cu: { enabled: true, endpoint: '', analyzer: 'prebuilt-videoSearch', location: 'geography' } })`);
    await ev('window.api.ai.cuClearCache()');
    cu.options.key = null;
    cu.options.bearer = TOKEN;
    const reqBefore = cu.requests.length;
    chatQueue.push(() => calls([['analyze_video', {}]]), () => text('Read.'));
    await ev('window.__veAnswers = [0]');
    await ask('read the video');
    const entries = cu.requests.slice(reqBefore).filter((r) => r.path.startsWith('/contentunderstanding/'));
    check('24 with an Entra access token: every request to the service carries Authorization: Bearer <token> and no key header', entra.ok && entries.length >= 3 && entries.every((r) => r.headers.authorization === 'Bearer ' + TOKEN && !r.headers['ocp-apim-subscription-key']), { ok: entra.ok, n: entries.length, hdr: entries.map((r) => Object.keys(r.headers).filter((k) => /auth|subscription/.test(k))) });
    check('25 the token is kept for this tab only, not in the settings', !(await ev('localStorage.getItem("ve.web.ai.v1")')).includes(TOKEN) && (await ev('sessionStorage.getItem("ve.web.ai.key.v1")')).includes(TOKEN));

    /* ---------------- settings the page must not accept ---------------- */
    const mismatch = await ev(`window.api.ai.save({ provider: 'foundry', auth: 'key', baseUrl: '${proxy.origin}', model: 'mock-model', apiKey: '${KEY}', cu: { enabled: true, endpoint: 'http://127.0.0.1:1', analyzer: 'prebuilt-videoSearch', location: 'geography' } })`);
    check('26 a video-analysis address on another host than the chat address is refused for key sign-in (the key is bound to its address)', !mismatch.ok && mismatch.error.code === 'CU_ORIGIN_MISMATCH', mismatch.error);
    const badName = await ev(`window.api.ai.save({ provider: 'foundry', auth: 'key', baseUrl: '${proxy.origin}', model: 'mock-model', apiKey: '${KEY}', cu: { enabled: true, endpoint: '', analyzer: 'bad analyzer name!', location: 'geography' } })`);
    check('27 an analyzer name with odd characters is refused', !badName.ok && badName.error.code === 'CU_ANALYZER_INVALID', badName.error);
    const other = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' })`);
    check('28 other providers have no video analysis: it is switched off', other.ok && other.status.cu.enabled === false && other.status.cu.available === false, other.status && other.status.cu);

    check('29 no console errors during the whole run', app.errors.length === 0, app.errors);
  } finally {
    await app.close();
    await proxy.stop();
    await cu.stop();
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('cu test crashed:', e); process.exit(1); });
