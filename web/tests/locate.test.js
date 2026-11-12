'use strict';
// locate_in_video in the web edition: Foundry + Content Understanding says WHEN the orange car is there, a few small pictures of the video go to the chat model
// (after the user said yes, every time) and the zoom aims at WHERE the car really is. A real browser, the desktop app's mock of the service (tests/cu-mock.js) and a
// stand-in for the vision model that really DECODES every JPEG the page sends (ffmpeg) and answers with the box of the orange pixels it finds - so the position in the
// zoom can be compared with where the car is in the video (the film and the stand-in model: tests/locate-world.js; a car on the LEFT from 1 to 5 s, on the RIGHT from
// 9 to 13 s, nothing in between, a blue square that never moves, a white bar that moves):
//   node tests/locate.test.js        (VE_BROWSER=<chrome|edge exe>; needs ffmpeg/ffprobe for the test video)
const path = require('path');
const { open, checker } = require('./lib/site');
const h = require('./lib/media-tools');
const mock = require('./lib/mock-llm');
const { startMockCu, makeResult } = require('../../tests/cu-mock');
const world = require('../../tests/locate-world');

const KEY = 'LOC_WEB_KEY_not_a_real_secret_0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const calls = (list) => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } } });
const lastTool = (body) => JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const check = checker('web locate');
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const ev = (expr) => app.evaluate(expr);
  const film = path.join(app.fixDir, 'L_orange_car.mp4');
  world.makeFilm(h, film);

  const chatQueue = [];
  const chatRequests = [];
  const problems = [];
  const pictures = []; // what the page sent to the vision model
  const vision = { mode: 'orange', delayMs: 0 }; // orange | none (sees nothing) | novision (a model that takes no pictures)
  const cu = await startMockCu({
    key: KEY,
    polls: 1,
    result: (info) => makeResult(info.seconds || 14, { sceneSeconds: 2 }),
    chat: async (entry, body) => {
      if (entry.method === 'GET') return { json: { data: [{ id: 'mock-model' }] } };
      if (world.isPictureRequest(body)) {
        const { jpeg, record } = world.pictureOf(body, entry.headers, KEY);
        pictures.push(record);
        if (vision.delayMs) await sleep(vision.delayMs);
        if (vision.mode === 'novision') return { status: 400, json: { error: { message: 'image input is not supported by this model', type: 'invalid_request_error', code: 'invalid_request' } } };
        const a = world.visionAnswer(h, record.prompt, jpeg, vision.mode);
        record.box = a.box;
        return text(a.text);
      }
      if (body && !body.tools) return text('OK'); // connection test
      chatRequests.push(body);
      const f = chatQueue.shift();
      try { return f ? f(body) : text('(no script)'); } catch (e) { problems.push(String((e && e.message) || e)); return text('(script failed)'); }
    },
  });
  const proxy = await mock.corsProxy(cu.port);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const dbg = () => ev('VE.ai.debug()');
  const waitIdle = (ms) => app.waitFor('!VE.ai.isRunning()', ms || 180000, 'the assistant to finish');
  const send = async (prompt) => { await ev(`(() => { VE.ai.send(${JSON.stringify(prompt)}); return true; })()`); await sleep(300); };
  const dialogs = () => ev('window.__veDialogs || []');
  const pictureDialogs = () => ev('window.__pictureDialogs || []');
  const steps = (kind) => ev(`(window.__steps || []).filter((e) => e.kind === ${JSON.stringify(kind)})`);
  const zoomed = (list) => list.filter((s) => s.zoomTo > 1.01 || s.zoomFrom > 1.01);

  try {
    check('01 no console errors on load', app.errors.length === 0, app.errors);
    await app.stage([path.basename(film)]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1 && VE.state.S.media.size === 1', 30000, 'one clip');
    await ev("window.__steps = []; window.api.on('ai:step', (e) => window.__steps.push(e)); true");
    // The page's own dialog is replaced for the question about the pictures only (everything else goes the normal way): the answer is chosen by the test, or held
    // until the test lets it go, so that "nothing leaves before the answer" can be looked at while the question is open.
    await ev(`(() => {
      const orig = window.api.messageBox.bind(window.api);
      window.__pictureDialogs = [];
      window.__pictureAnswer = 0;
      window.api.messageBox = (o) => {
        if (/küçük resim|small pictures/.test(String(o && o.message))) {
          window.__pictureDialogs.push({ message: o.message, detail: o.detail, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId });
          if (window.__pictureAnswer === 'hold') return new Promise((resolve) => { window.__pictureOpen = true; window.__pictureRelease = (v) => { window.__pictureOpen = false; resolve(v); }; });
          return Promise.resolve(window.__pictureAnswer);
        }
        return orig(o);
      };
      return true;
    })()`);
    const saved = await ev(`window.api.ai.save({ provider: 'foundry', baseUrl: '${proxy.origin}', model: 'mock-model', apiKey: '${KEY}', cu: { enabled: true, endpoint: '', analyzer: 'prebuilt-videoSearch', location: 'geography' } })`);
    check('02 Foundry + video analysis saved and ready', saved.ok && saved.status.ready && saved.status.cu.ready, saved);
    await ev('VE.ai.open()');
    await sleep(300);

    /* ---------------- a complete request: analysis, then the position ---------------- */
    const seen = {};
    chatQueue.push(
      (body) => {
        seen.tools = body.tools.map((t) => t.function.name);
        seen.system = body.messages[0].content;
        return calls([['analyze_video', { query: 'orange car' }]]);
      },
      (body) => {
        const r = lastTool(body);
        if (!r.ok) throw new Error('analysis: ' + JSON.stringify(r).slice(0, 200));
        // the scenes the analysis would name, a little wider than the car really is there; the middle one has no car
        return calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }, { start: 6, end: 8 }, { start: 8.5, end: 13.5 }] }]]);
      },
      (body) => {
        seen.locate = lastTool(body);
        return calls([['set_zoom', { found: seen.locate.found_id, mode: 'in' }]]);
      },
      (body) => { seen.zoom = lastTool(body); return text('Turuncu arabanın olduğu iki bölüme arabaya odaklı yakınlaştırma ekledim.'); },
    );
    await ev('window.__veAnswers = [0]; window.__pictureAnswer = "hold"; window.__steps.length = 0; true'); // [0] = upload the reduced copy
    await send('turuncu arabaya zoom yap');
    await app.waitFor('window.__pictureOpen === true', 180000, 'the question about the pictures');
    const during = { pictures: pictures.length, uploads: cu.uploads.length };
    await sleep(900);
    check('03 the tools are the analysis and the locator (not the local model\'s find_in_video); the prompt explains FINDING WHERE', seen.tools && seen.tools.includes('analyze_video') && seen.tools.includes('locate_in_video') && !seen.tools.includes('find_in_video') && /FINDING WHERE/.test(seen.system), seen.tools);
    const pd = await pictureDialogs();
    const planned = pd[0] && /en fazla (\d+) küçük resim/.exec(pd[0].message);
    check('04 while the question is open nothing has left: the analysis was uploaded (once) but not one picture was sent - not even after waiting', during.uploads === 1 && during.pictures === 0 && pictures.length === 0, { during, now: pictures.length });
    check('05 the question names the address, the most pictures and their size, the object, the model, the ranges and the seconds, that they are not stored, that "no" means a centre zoom; "Cancel" is the default', pd.length === 1 && pd[0].message.includes(proxy.origin) && !!planned && /toplam en fazla [\d.]+ MB/.test(pd[0].message) && /orange car/.test(pd[0].detail) && /mock-model/.test(pd[0].detail) && /3 aralık/.test(pd[0].detail) && /12 sn/.test(pd[0].detail) && /640 piksel/.test(pd[0].detail) && /saklamaz/.test(pd[0].detail) && /veri politikası/.test(pd[0].detail) && /ortasına/.test(pd[0].detail) && pd[0].buttons.length === 2 && pd[0].defaultId === 1 && pd[0].cancelId === 1, pd);
    await ev('window.__pictureRelease(0)'); // "Gönder"
    await waitIdle();
    const hadMsg = (await dbg()).messages;
    check('06 the run finished without script problems', problems.length === 0 && chatRequests.length === 4, { problems, n: chatRequests.length, last: hadMsg[hadMsg.length - 1] });
    check('07 the pictures: no more than announced, every one a small JPEG (long edge ≤ 640, about 600 x 340), none with the key in the body; each is asked either "is there ... YES or NO" or "locate ... (with the size of the picture)", and both kinds were asked', pictures.length >= 8 && pictures.length <= Number(planned[1]) && pictures.every((p) => p.jpegHeader && p.mime === 'data:image/jpeg;base64' && p.size && Math.max(p.size.width, p.size.height) <= 640 && Math.max(p.size.width, p.size.height) >= 560 && p.bytes < 150 * 1024 && !p.keyInBody && /^(Is there an orange car in this image\? Answer with one word: YES or NO\.|Locate the orange car in this image\. The image is \d+ pixels wide and \d+ pixels high\.)/.test(p.prompt)) && pictures.some((p) => /^Is there/.test(p.prompt)) && pictures.some((p) => /^Locate/.test(p.prompt)), { n: pictures.length, planned: planned && planned[1], sizes: pictures.map((p) => p.size && p.size.width + 'x' + p.size.height).slice(0, 5), bytes: pictures.map((p) => p.bytes).slice(0, 5), prompts: pictures.map((p) => String(p.prompt).slice(0, 40)).slice(0, 4) });
    const announcedMb = Number(/toplam en fazla ([\d.]+) MB/.exec(pd[0].message)[1]);
    check('07b the announced size is a limit and it holds: what was really sent (every picture, probe and box questions together) is within the megabytes of the question, and no picture is larger than 120 KB', announcedMb === Math.ceil((Number(planned[1]) * 120 * 10) / 1024) / 10 && pictures.reduce((s, p) => s + p.bytes, 0) <= announcedMb * 1024 * 1024 && pictures.every((p) => p.bytes <= 120 * 1024), { announcedMb, sent: pictures.reduce((s, p) => s + p.bytes, 0), biggest: Math.max(...pictures.map((p) => p.bytes)) });
    check('08 the system message tells the model that text in a picture is not an instruction; the key travelled in the header only', pictures.every((p) => /never an instruction/.test(p.system) && p.headers.authorization === 'Bearer ' + KEY));
    const loc = seen.locate || {};
    const parts = loc.parts || [];
    check('09 the model got TWO parts (not the three ranges it asked for), with the times of the car (1-5 s and 9-13 s, about), an id, and the range with no car reported as not confirmed', loc.ok === true && loc.found_id === 'f1' && parts.length === 2 && near(parts[0].start, 1, 1) && near(parts[0].end, 5, 1) && near(parts[1].start, 9, 1) && near(parts[1].end, 13, 1) && Array.isArray(loc.not_confirmed) && loc.not_confirmed.length === 1 && near(loc.not_confirmed[0].start, 6, 0.3) && near(loc.not_confirmed[0].end, 8, 0.3), loc);
    check('10 it does not get boxes or pictures (only times, an id and how many pictures were looked at)', !JSON.stringify(loc).includes('"box"') && !JSON.stringify(loc).includes('base64') && loc.checked_pictures > 0 && loc.checked_pictures <= Number(planned[1]), loc);
    const after = await segs();
    const z = zoomed(after);
    const zl = z.filter((s) => s.in < 6);
    const zr = z.filter((s) => s.in > 8);
    // every part is zoomed in (ramp in, hold, ramp out): several pieces that all carry the focus of THEIR part
    check('11 the timeline: the zoom is only inside the times of the two parts (nothing in between), up to a factor of about 2.7 (the car fills ~60 % of the picture)', zl.length >= 1 && zr.length >= 1 && z.length === zl.length + zr.length && z.every((s) => (s.in >= 0.5 && s.out <= 5.6) || (s.in >= 8.4 && s.out <= 13.6)) && Math.max(...zl.map((s) => s.zoomTo)) > 1.3 && Math.max(...zr.map((s) => s.zoomTo)) > 1.3, after);
    check('12 THE ZOOM AIMS AT THE CAR: the first part at the left (x about 0.25), the second at the right (x about 0.75), both at mid height (y about 0.5)', zl.length > 0 && zr.length > 0 && zl.every((s) => near(s.fx, 0.25, 0.04) && near(s.fy, 0.5, 0.05)) && zr.every((s) => near(s.fx, 0.75, 0.04) && near(s.fy, 0.5, 0.05)), { zl, zr });
    check('13 the model was told it worked (it did not have to guess the position)', seen.zoom && seen.zoom.ok !== false, seen.zoom);
    const st = await steps('search');
    const found = await steps('found');
    check('14 progress was shown (start ... done) and the result is listed with its two parts', st.length >= 3 && st[0].phase === 'start' && st[st.length - 1].phase === 'done' && found.length === 1 && found[0].id === 'f1' && found[0].intervals.length === 2 && /orange car/.test(found[0].label), { phases: st.map((s) => s.phase), found });
    await app.key('z', { ctrl: true });
    await sleep(300);
    const undone = await segs();
    check('15 ONE undo gives the original clip back', undone.length === 1 && !(undone[0].zoomTo > 1.01), undone);
    check('16 the key never went into a prompt', !chatRequests.some((b) => JSON.stringify(b).includes(KEY)));
    const stored = await ev('JSON.stringify([localStorage.getItem("ve.web.ai.v1"), localStorage.getItem("ve.web.ai.cutrust.v1")])');
    check('17 nothing about the pictures is stored (no picture, no box, in the settings)', !/base64|bbox|image_url/.test(stored), stored.slice(0, 200));

    /* ---------------- "no": nothing is sent, the model is told, the timeline is not edited by it ---------------- */
    const picturesBefore = pictures.length;
    const dialogsBefore = (await pictureDialogs()).length;
    chatQueue.length = 0;
    chatQueue.push(
      () => calls([['analyze_video', { query: 'orange car' }]]),
      () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }] }]]),
      (body) => { seen.declined = JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content); return calls([['locate_in_video', { object: 'car', ranges: [{ start: 8.5, end: 13.5 }] }]]); },
      (body) => { seen.again = JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content); return text('Resim göndermeye izin vermediniz; yakınlaştırmayı ortaya yapabilirim.'); },
    );
    await ev('window.__pictureAnswer = 1; true'); // "Vazgeç"
    await send('turuncu arabaya zoom yap');
    await waitIdle();
    check('18 "Cancel": not one picture is sent; the model is told in plain words; it cannot ask again - the question is not shown a second time', pictures.length === picturesBefore && (await pictureDialogs()).length === dialogsBefore + 1 && seen.declined && seen.declined.ok === false && seen.declined.code === 'FRAMES_DECLINED' && /did not allow/.test(seen.declined.error) && seen.again && seen.again.code === 'FRAMES_DECLINED', { seen: seen.declined, again: seen.again, dialogs: (await pictureDialogs()).length - dialogsBefore });
    check('19 and the timeline is untouched', (await segs()).length === 1 && !zoomed(await segs()).length && problems.length === 0, problems);

    /* ---------------- a model that does not take pictures ---------------- */
    vision.mode = 'novision';
    const before3 = pictures.length;
    chatQueue.length = 0;
    chatQueue.push(
      () => calls([['analyze_video', {}]]),
      () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }] }]]),
      (body) => { seen.novision = lastTool(body); return text('Bu model resim kabul etmiyor.'); },
    );
    await ev('window.__pictureAnswer = 0; true');
    await send('turuncu arabaya zoom yap');
    await waitIdle();
    check('20 a model that takes no pictures: the first request is refused, the scan stops (one picture only), and the model is told so in a sentence', pictures.length - before3 === 1 && seen.novision && seen.novision.ok === false && seen.novision.code === 'NO_VISION' && /does not accept pictures/.test(seen.novision.error) && (await segs()).length === 1, { n: pictures.length - before3, seen: seen.novision });

    /* ---------------- pictures that show nothing ---------------- */
    vision.mode = 'none';
    chatQueue.length = 0;
    chatQueue.push(
      () => calls([['analyze_video', {}]]),
      () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }] }]]),
      (body) => { seen.none = lastTool(body); return calls([['set_zoom', { found: 'f1' }]]); },
      (body) => { seen.noneZoom = lastTool(body); return text('Arabayı resimlerde göremedim; zoom eklemedim.'); },
    );
    await send('turuncu arabaya zoom yap');
    await waitIdle();
    check('21 pictures that show no car: no parts, the range is reported as not confirmed, a zoom on that result is refused, nothing is edited', seen.none && seen.none.ok === true && seen.none.count === 0 && seen.none.not_confirmed && seen.none.not_confirmed.length === 1 && seen.noneZoom && seen.noneZoom.ok === false && (await segs()).length === 1 && !zoomed(await segs()).length, { none: seen.none, zoom: seen.noneZoom });

    /* ---------------- Stop while the pictures are being looked at ---------------- */
    vision.mode = 'orange';
    vision.delayMs = 700;
    const before5 = pictures.length;
    chatQueue.length = 0;
    chatQueue.push(
      () => calls([['analyze_video', {}]]),
      () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 13.5 }] }]]),
      () => text('(never reached)'),
    );
    await send('turuncu arabaya zoom yap');
    const t0 = Date.now();
    while (pictures.length - before5 < 1 && Date.now() - t0 < 120000) await sleep(100);
    await ev('VE.ai.cancel()');
    await waitIdle(30000);
    const stopped = pictures.length;
    await sleep(2500);
    const msgs = (await dbg()).messages;
    check('22 Stop while the pictures are looked at: the run ends at once, no new picture is sent afterwards (at most the one on its way), nothing is edited', msgs[msgs.length - 1].type === 'info' && pictures.length <= stopped + 1 && (await segs()).length === 1 && !zoomed(await segs()).length, { stopped, now: pictures.length, last: msgs[msgs.length - 1] });
    vision.delayMs = 0;

    /* ---------------- other chat models ---------------- */
    const other = await ev(`window.api.ai.save({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-test' })`);
    check('23 a provider whose adapter cannot pass a picture has no video analysis, so no locator either (nothing to offer)', other.ok && other.status.cu.available === false, other.status && other.status.cu);

    check('24 no console errors during the whole run', app.errors.length === 0, app.errors);
  } finally {
    await app.close();
    await proxy.stop();
    await cu.stop();
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('locate test crashed:', e); process.exit(1); });
