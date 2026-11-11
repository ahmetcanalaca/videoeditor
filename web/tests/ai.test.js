'use strict';
// The assistant of the web edition in a real browser, against stand-ins for the servers: pairing with the Local AI helper by link, a request that edits the
// timeline (one undo step), cancelling, a wrong key / nobody there, "look at the video" (find_in_video on a video with a red box that is "the dog" from
// 10 s to 20 s: the pictures go to the model as JPEG, the scan finds the interval and the place to zoom into), cloud providers (OpenAI, Azure with the
// confirmation of an unknown address, Anthropic's browser header, the key kept for the tab only) and the settings dialog.
//   node tests/ai.test.js        (VE_BROWSER=<chrome|edge exe>; needs ffmpeg for the test videos: see tests/lib/media-tools.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { open, checker } = require('./lib/site');
const h = require('./lib/media-tools');
const mock = require('./lib/mock-llm');

const SHOTS = process.env.VE_SHOTS || path.join(os.tmpdir(), 've-web-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is the "dog" (a big red box) in this picture, and where? JPEG (base64) -> { count, box: [x1,y1,x2,y2] on the 0..1000 grid } through ffmpeg.
function redBox(b64) {
  const W = 64;
  const H = 36;
  const r = spawnSync(h.bins.ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=' + W + ':' + H + ':flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: Buffer.from(b64, 'base64'), maxBuffer: 1 << 20 });
  const px = r.stdout;
  let count = 0;
  let x1 = W; let y1 = H; let x2 = -1; let y2 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (px[i] > 150 && px[i + 1] < 110 && px[i + 2] < 110) { count++; x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    }
  }
  return { count, box: count ? [Math.round((x1 / W) * 1000), Math.round((y1 / H) * 1000), Math.round(((x2 + 1) / W) * 1000), Math.round(((y2 + 1) / H) * 1000)] : null };
}

(async () => {
  const check = checker('web ai');
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const ev = (expr) => app.evaluate(expr);
  const A = path.basename(app.fixtures.A);

  // a 30 s video: grey, with a red box from 10 s to 20 s
  const dogName = 'D_red_box.mp4';
  h.ff(['-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360:r=25:d=30', '-vf', "drawbox=x=180:y=130:w=160:h=110:color=red:t=fill:enable='between(t,10,20)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(app.fixDir, dogName)]);

  let scenario = 'cut';
  const pictures = [];
  const chat = async (body) => {
    const first = body.messages[0];
    if (Array.isArray(first.content)) {
      // a question about a picture of find_in_video
      const img = first.content.find((p) => p.type === 'image_url').image_url.url;
      const text = first.content.find((p) => p.type === 'text').text;
      const b64 = img.replace(/^data:image\/jpeg;base64,/, '');
      pictures.push({ prefix: img.slice(0, 23), bytes: Buffer.from(b64, 'base64').length, magic: Buffer.from(b64, 'base64').slice(0, 2).toString('hex') });
      const px = redBox(b64);
      if (/one word: YES or NO/.test(text)) return { content: px.count >= 20 ? 'YES' : 'NO' };
      return { content: px.count >= 20 ? JSON.stringify([{ bbox_2d: px.box, label: 'dog' }]) : '[]' };
    }
    const tools = body.messages.filter((m) => m.role === 'tool').length;
    if (scenario === 'cut') return tools ? { content: 'Done: the first 3 seconds are removed.' } : { tool_calls: [{ name: 'remove_range', args: { first_seconds: 3 } }] };
    if (scenario === 'dog') {
      if (!tools) return { tool_calls: [{ name: 'find_in_video', args: { object: 'dog' } }] };
      if (tools === 1) return { tool_calls: [{ name: 'set_zoom', args: { found: 'f1', mode: 'in', factor: 2 } }] };
      return { content: 'Zoomed in on the dog.' };
    }
    return { content: 'OK' };
  };
  const llm = await mock.start({ chat });
  const KEY = mock.KEY;
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const status = () => ev('window.api.ai.status()');
  const aiState = () => ev('VE.ai.debug()');
  const waitIdle = (ms) => app.waitFor('!VE.ai.isRunning()', ms || 120000, 'the assistant to finish');

  try {
    check('01 no console errors on load', app.errors.length === 0, app.errors);

    /* ---------------- pairing with the Local AI helper (the link the helper opens) ---------------- */
    const s0 = await status();
    check('02 before anything is set up the assistant is off and asks for the Local AI (nothing contacted)', s0.provider === 'builtin' && s0.needs === 'install' && !s0.ready && llm.log.length === 0, s0.needs);
    await ev('window.__veAnswers = [0]');
    await ev("location.hash = '#local-ai=" + llm.port + '.' + KEY + "'");
    await app.waitFor("window.api.ai.status().then((s) => s.ready)", 30000, 'paired');
    const dlg = await ev('window.__veDialogs.map((d) => d.message + " | " + d.detail)');
    check('03 the user is asked once; the dialog names the port and never shows the key', dlg.length === 1 && dlg[0].includes(String(llm.port)) && !dlg[0].includes(KEY), dlg);
    check('04 the fragment (with the key) is removed from the address bar at once', (await ev('location.hash')) === '' && !(await ev('location.href')).includes(KEY));
    const s1 = await status();
    check('05 paired: ready, and the model of the helper can look at the video', s1.ready && s1.provider === 'builtin' && s1.vision === true && s1.builtin.paired && s1.builtin.port === llm.port, s1);
    const stored = await ev('JSON.stringify([localStorage.getItem("ve.web.ai.helper.v1"), localStorage.getItem("ve.web.ai.v1"), sessionStorage.getItem("ve.web.ai.key.v1")])');
    check('06 the pairing key is kept for the helper only; no cloud key exists', stored.includes(KEY) && !JSON.parse(stored)[1].includes(KEY) && JSON.parse(stored)[2] === null, stored.replace(KEY, '***'));

    await app.waitFor('window.api.ai.status().then((s) => s.builtin.connection === "ready")', 30000, 'the connection test that follows the pairing');
    const test = await ev('window.api.ai.test()');
    check('07 "test" asks /health (no key), then the models with the key; the page origin reached the server (CORS)', test.ok && test.models.includes('mock-model') && llm.log.some((e) => e.path === '/health' && !e.auth) && llm.log.some((e) => e.path === '/v1/models' && e.auth === 'Bearer ' + KEY) && llm.log[0].origin === app.origin, { test, origin: llm.log[0] && llm.log[0].origin });
    check('08 the vision of the model was read from /props', llm.log.some((e) => e.path === '/props'));

    /* ---------------- a request that edits the timeline ---------------- */
    await app.stage([A]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1', 30000, 'one clip');
    await ev('VE.ai.open()');
    await sleep(300);
    check('09 the pane opens ready, with the example chips', (await aiState()).ready && (await ev("document.querySelectorAll('#ai-log .ai-chip').length")) >= 3);
    llm.log.length = 0;
    await ev("VE.ai.send('Cut the first 3 seconds')");
    await waitIdle();
    const st1 = await aiState();
    const after = await segs();
    check('10 the first 3 seconds are cut out of the timeline', after.length === 1 && Math.abs(after[0].in - 3) < 0.05, after);
    check('11 the answer and the list of what was done are shown', st1.messages.some((m) => m.type === 'ai' && /3 seconds/.test(m.text) && m.actions.length === 1) && (await ev("document.querySelectorAll('#ai-log .ai-actions li').length")) >= 1, st1.messages.map((m) => m.type));
    const chats = llm.log.filter((e) => e.path === '/v1/chat/completions');
    const first = chats[0].body;
    check('12 two round trips; the key is in the header; the model name of the helper; tools incl. find_in_video (it can look)', chats.length === 2 && chats.every((e) => e.auth === 'Bearer ' + KEY) && first.model === 'qwen3.5-4b' && first.tools.some((t) => t.function.name === 'find_in_video') && first.tools.some((t) => t.function.name === 'remove_range'), { n: chats.length, model: first.model, tools: first.tools.map((t) => t.function.name) });
    check('13 the system prompt is the compact one of the desktop app and the timeline summary goes as text (no video, no picture)', /find_in_video/.test(first.messages[0].content) && typeof first.messages[1].content === 'string' && /timeline_summary/.test(first.messages[1].content) && !JSON.stringify(first.messages).includes('image_url'), first.messages[0].content.slice(0, 80));
    await app.key('z', { ctrl: true });
    await sleep(200);
    check('14 ONE Ctrl+Z undoes everything the assistant did', (await segs())[0].in === 0, await segs());

    /* ---------------- cancelling ---------------- */
    llm.setDelay(4000);
    await ev("(() => { VE.ai.send('Cut the first 3 seconds'); return true; })()");
    await app.waitFor('VE.ai.isRunning()', 5000, 'running');
    await sleep(400);
    await ev('VE.ai.cancel()');
    await waitIdle(8000);
    const st2 = await aiState();
    check('15 cancelling stops the request: nothing changed, a note says so', (await segs())[0].in === 0 && st2.messages.some((m) => m.type === 'info'), st2.messages.map((m) => m.type + ':' + (m.text || '').slice(0, 30)));
    await sleep(600);
    check('16 the connection to the server was dropped (the request was really aborted)', llm.log.filter((e) => e.path === '/v1/chat/completions').pop().closed === true);
    llm.setDelay(0);

    /* ---------------- wrong key, nobody there ---------------- */
    await ev("window.api.llm.pair({ port: " + llm.port + ", key: 'WRONG_KEY_WRONG_KEY_0123456789' })");
    const bad = await ev('window.api.ai.test()');
    check('17 a wrong key is reported as such (401) and the panel says so', !bad.ok && bad.error.code === 'AUTH' && (await status()).builtin.connection === 'unauthorized', bad);
    await ev('window.api.llm.pair({ port: 1025, key: "' + KEY + '" })');
    const gone = await ev('window.api.ai.test()');
    check('18 nobody listening is reported as a network error', !gone.ok && gone.error.code === 'NETWORK' && (await status()).builtin.connection === 'unreachable', gone);
    await ev('window.api.llm.pair({ port: ' + llm.port + ', key: "' + KEY + '" })');
    check('19 the right pairing works again', (await ev('window.api.ai.test()')).ok === true);

    /* ---------------- look at the video ---------------- */
    scenario = 'dog';
    await ev('window.__veAnswers = [1]'); // "do not save" the cut of the earlier test
    await app.click('#btn-new');
    await app.waitFor('VE.state.S.segments.length === 0 && VE.state.S.media.size === 0', 8000, 'a new project');
    await app.stage([dogName]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1 && VE.state.S.media.size === 1', 30000, 'the dog video');
    llm.log.length = 0;
    pictures.length = 0;
    await ev("VE.ai.send('Zoom in on the dog')");
    await waitIdle(180000);
    const dogSegs = await segs();
    const zoomedAt = (t) => dogSegs.find((s) => t >= s.in - 1e-6 && t < s.out - 1e-6);
    const z = (t) => { const s = zoomedAt(t); return !!s && (s.zoomFrom > 1.05 || s.zoomTo > 1.05); };
    check('20 find_in_video found the dog: zoomed from about 10 s to 20 s, the rest untouched', [11, 13, 15, 18, 19].every(z) && [1, 4, 7, 22, 26, 29].every((t) => !z(t)), dogSegs.map((s) => [s.in, s.out, s.zoomFrom, s.zoomTo]));
    const zs = dogSegs.filter((s) => s.zoomTo > 1.05);
    check('21 the zoom aims at the box (about 41 % from the left, 51 % from the top)', zs.length > 0 && zs.every((s) => Math.abs(s.fx - 0.406) < 0.06 && Math.abs(s.fy - 0.514) < 0.06), zs.map((s) => [s.fx, s.fy]));
    const stD = await aiState();
    const msgD = stD.messages.filter((m) => m.type === 'ai').pop();
    check('22 the answer lists what was found (the dog, its time ranges)', !!msgD && msgD.found.length === 1 && /dog/.test(msgD.found[0].label) && msgD.found[0].intervals.length === 1 && Math.abs(msgD.found[0].intervals[0].start - 10) <= 1.2 && Math.abs(msgD.found[0].intervals[0].end - 20) <= 1.2, msgD && msgD.found);
    check('23 the pictures went to the model as JPEG data URLs (identical pictures are asked about once), a few dozen at most', pictures.length >= 3 && pictures.length <= 90 && pictures.every((p) => p.prefix === 'data:image/jpeg;base64,' && p.magic === 'ffd8' && p.bytes > 500), { n: pictures.length, first: pictures[0] });
    check('24 ONE undo gives the original clip back', await (async () => { await app.key('z', { ctrl: true }); await sleep(200); const s = await segs(); return s.length === 1 && s[0].zoomFrom === 1 && s[0].zoomTo === 1; })());
    scenario = 'cut';

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
    await ev('window.__veDialogs.length = 0');
    const SK = 'sk-TEST_not_a_real_secret_0123456789';
    const sOpenAI = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: '', model: 'gpt-test', apiKey: '${SK}' })`);
    check('25 OpenAI: its own address needs no confirmation', sOpenAI.ok && (await ev('window.__veDialogs.length')) === 0 && sOpenAI.status.ready && sOpenAI.status.effectiveBaseUrl === 'https://api.openai.com/v1', sOpenAI.error || sOpenAI.status.effectiveBaseUrl);
    const tOpenAI = await ev('window.api.ai.test()');
    const net1 = await ev('window.__net');
    check('26 the key goes only to api.openai.com, in the Authorization header', tOpenAI.ok && net1.length >= 2 && net1.every((r) => r.url.startsWith('https://api.openai.com/') && r.headers.authorization === 'Bearer ' + SK), net1.map((r) => r.url));
    const keep = await ev('JSON.stringify([localStorage.getItem("ve.web.ai.v1"), localStorage.getItem("ve.web.ai.helper.v1"), localStorage.getItem("ve.web.trust.v1"), localStorage.getItem("ve.web.settings.v1")])');
    check('27 the key is kept for this tab only (sessionStorage), never in localStorage', !keep.includes(SK) && (await ev('sessionStorage.getItem("ve.web.ai.key.v1")')).includes(SK));
    check('28 the status shows a masked key only', (await status()).masked === '••••6789' && !JSON.stringify(await status()).includes(SK));

    const sAz1 = await ev(`(async () => { window.__veAnswers = [1]; return window.api.ai.save({ provider: 'azure', baseUrl: 'https://myres.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21', model: '', apiKey: 'AZ_TEST_KEY_not_real_12345' }); })()`);
    check('29 Azure resource: an unknown address is confirmed first - declined: refused, nothing saved, no key kept', !sAz1.ok && sAz1.error.code === 'ENDPOINT_NOT_CONFIRMED' && (await status()).provider === 'openai' && (await ev('VE.web.net.trust.list()')).length === 0, sAz1);
    const dlgAz = await ev('window.__veDialogs[window.__veDialogs.length - 1]');
    check('30 the question names the address and says what is sent there', /myres\.openai\.azure\.com/.test(dlgAz.message) && /API/.test(dlgAz.detail), dlgAz);
    const sAz2 = await ev(`(async () => { window.__veAnswers = [0]; return window.api.ai.save({ provider: 'azure', baseUrl: 'https://myres.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21', model: '', apiKey: 'AZ_TEST_KEY_not_real_12345' }); })()`);
    check('31 allowed: saved, the deployment and API version are taken from the pasted "Target URI", the address is remembered', sAz2.ok && sAz2.status.model === 'dep1' && sAz2.status.apiVersion === '2024-10-21' && (await ev('VE.web.net.trust.list()')).includes('https://myres.openai.azure.com'), sAz2.error || sAz2.status);
    await ev('window.__net.length = 0');
    const tAz = await ev('window.api.ai.test()');
    const netAz = await ev('window.__net');
    check('32 Azure: the request goes to the resource with the api-key header', tAz.ok && netAz.some((r) => r.url.startsWith('https://myres.openai.azure.com/openai/deployments/dep1/chat/completions') && r.headers['api-key'] === 'AZ_TEST_KEY_not_real_12345'), netAz.map((r) => r.url));
    // every GitHub Pages site of an account shares this browser storage: another page could have put an address on the saved list. Entering a key still asks.
    await ev("VE.web.net.trust.add('https://seeded.example.com')");
    await ev('window.__veDialogs.length = 0');
    const seedUrl = 'https://seeded.example.com/openai/deployments/d1/chat/completions?api-version=2024-10-21';
    const sSeed1 = await ev(`(async () => { window.__veAnswers = [1]; return window.api.ai.save({ provider: 'azure', baseUrl: '${seedUrl}', model: '', apiKey: 'SEEDED_TEST_KEY_not_real_123' }); })()`);
    const stSeed1 = await status();
    check('32a an address that is already on the saved list still asks when a KEY is entered for it - declined: refused, the earlier setup and key are untouched', !sSeed1.ok && sSeed1.error.code === 'ENDPOINT_NOT_CONFIRMED' && (await ev('window.__veDialogs.length')) === 1 && stSeed1.masked === '••••2345' && !stSeed1.baseUrl.includes('seeded'), { err: sSeed1.error, masked: stSeed1.masked, base: stSeed1.baseUrl });
    const sSeed2 = await ev(`(async () => { window.__veAnswers = [0]; return window.api.ai.save({ provider: 'azure', baseUrl: '${seedUrl}', model: '', apiKey: 'SEEDED_TEST_KEY_not_real_123' }); })()`);
    check('32b allowed: saved with the new key', sSeed2.ok && sSeed2.status.masked === '••••_123' && sSeed2.status.effectiveBaseUrl.startsWith('https://seeded.example.com'), sSeed2.error || { masked: sSeed2.status.masked, base: sSeed2.status.effectiveBaseUrl });
    await ev('window.__veDialogs.length = 0');
    const sSeed3 = await ev(`window.api.ai.save({ provider: 'azure', baseUrl: '${seedUrl}', model: '' })`);
    check('32c saving the setup WITHOUT a new key does not ask again (the list is still what lets a later request go)', sSeed3.ok && (await ev('window.__veDialogs.length')) === 0, sSeed3.error || sSeed3.status);
    await ev("VE.web.net.trust.remove('https://seeded.example.com')");
    await ev('window.__net.length = 0');
    await ev(`window.api.ai.save({ provider: 'anthropic', baseUrl: '', model: 'claude-test', apiKey: 'sk-ant-TEST_not_a_real_secret_1' })`);
    await ev('window.api.ai.test()');
    const netAn = await ev('window.__net');
    check('33 Anthropic: the browser header that lets a page call the API is added', netAn.length >= 1 && netAn.every((r) => r.headers['anthropic-dangerous-direct-browser-access'] === 'true' && r.headers['x-api-key'] === 'sk-ant-TEST_not_a_real_secret_1' && r.url.startsWith('https://api.anthropic.com/')), netAn);
    const sMove = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' })`);
    check('34 going to another provider without a new key drops the saved key (it is bound to its address)', sMove.ok && sMove.keyCleared === true && sMove.status.needs === 'key', sMove);
    const sV6 = await ev(`window.api.ai.save({ provider: 'local', baseUrl: 'http://[::1]:11434/v1', model: 'm' })`);
    const sLan = await ev(`window.api.ai.save({ provider: 'local', baseUrl: 'http://192.168.1.20:11434/v1', model: 'm' })`);
    check('35 a "local" model must be on this computer (127.0.0.1 / localhost); LAN addresses and IPv6 literals are refused', !sV6.ok && sV6.error.code === 'URL_NOT_LOCAL' && !sLan.ok && sLan.error.code === 'URL_NOT_LOCAL', [sV6.error, sLan.error]);
    const sHttp = await ev(`window.api.ai.save({ provider: 'openai', baseUrl: 'http://example.com/v1', model: 'm', apiKey: 'abc' })`);
    check('36 plain http to a remote address is refused', !sHttp.ok && sHttp.error.code === 'URL_SCHEME', sHttp.error);
    await ev('delete window.__veTest.netFetch');

    /* ---------------- local servers ---------------- */
    await ev(`window.api.ai.save({ provider: 'local', baseUrl: '${llm.url}/v1', model: 'mock-model', apiKey: '${KEY}' })`);
    const local = await ev('window.api.ai.status()');
    check('37 another local model server: configured with its key, no confirmation needed (it is this computer)', local.ready && local.provider === 'local' && local.vision === false, local);
    const found = await ev('window.api.ai.discover()');
    check('38 "find local servers" probes a few ports of this computer only; a server that needs a key is not listed', found.ok && Array.isArray(found.servers), found);

    /* ---------------- the settings dialog ---------------- */
    await ev("window.api.ai.save({ provider: 'builtin' })");
    await ev('VE.ai.refresh()');
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-llm=panel]')", 10000, 'the Local AI panel');
    await app.waitFor("!document.querySelector('[data-llm=hash]').hidden", 10000, 'the hash of the helper download');
    const panel = await ev(`(async () => {
      const p = document.querySelector('[data-llm=panel]');
      const a = p.querySelector('a[data-llm=download]');
      const info = await (await fetch(new URL('local-ai/info.json', document.baseURI))).json();
      const h = p.querySelector('[data-llm=hash]');
      const s = p.querySelector('a[data-llm=source]');
      return { href: a && a.getAttribute('href'), download: a && a.getAttribute('download'), state: p.querySelector('[data-llm=state]').dataset.state, steps: p.querySelectorAll('.llm-steps li').length, title: p.querySelector('.llm-title').textContent,
        hashText: h.textContent, sha: info.zip.sha256, bytes: info.zip.bytes, source: s && s.getAttribute('href'), rel: s && s.getAttribute('rel'), target: s && s.getAttribute('target') };
    })()`);
    check('39 the panel of the Local AI offers the helper download and the three steps', /local-ai\/VideoEditor-LocalAI\.zip$/.test(panel.href || '') && panel.download === 'VideoEditor-LocalAI.zip' && panel.steps === 3 && /Qwen3\.5-4B/.test(panel.title), panel);
    check('39b the panel shows the SHA-256 of the real download (from info.json) and a link to the readable source of the helper (new tab, no opener)', /^[0-9a-f]{64}$/.test(panel.sha) && panel.hashText.includes(panel.sha) && panel.source === 'https://github.com/ahmetcanalaca/videoeditor/tree/main/web/local-ai' && panel.target === '_blank' && /noopener/.test(panel.rel), panel);
    await app.screenshot(path.join(SHOTS, 'web-06-ai-settings-local-tr-dark.png'));
    await ev("document.querySelector('[data-llm=test]').click()");
    await app.waitFor("document.querySelector('[data-llm=state]').dataset.state === 'ready'", 15000, 'the panel shows the connection');
    check('40 "test the connection" in the panel finds the helper', true);
    await ev('VE.modal.close()');
    await ev('VE.ai.close()');

    check('41 no console errors during the whole run', app.errors.length === 0, app.errors);
  } finally {
    await app.close();
    await llm.stop();
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('ai test crashed:', e); process.exit(1); });
