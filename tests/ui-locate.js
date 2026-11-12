'use strict';
// UI scenario: locate_in_video in the real app (CDP). Foundry + Content Understanding says WHEN the orange car is there (a mock of the service, 127.0.0.1), a few small
// pictures of the video go to the chat model after the user said yes in the NATIVE dialog (every time), and the zoom aims at WHERE the car really is. The vision model is
// a stand-in that really decodes every JPEG the app sends (ffmpeg) and answers with the box of its orange pixels (tests/locate-world.js): a car on the left from 1 to 5 s, on
// the right from 9 to 13 s, nothing in between.
// Covers: the question (address, number of pictures, object, model, what happens on "no"), the pictures (small, JPEG, no key in the body), the position of the zoom
// (left / right), progress and the result card, ONE undo, "no" (nothing is sent, the model is told, no second question), a model that takes no pictures, pictures that show
// nothing, Stop while the pictures are looked at, secrets and pictures on disk.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, summary, ud, h } = require('./ui-helpers');
const { startMockCu, makeResult } = require('./cu-mock');
const world = require('./locate-world');

const KEY = 'LOC_UI_KEY_not_a_real_secret_0123456789';
const SHOTS = path.join(OUT, 'shots');
const MSGBOX_LOG = path.join(OUT, 'locate-msgbox.log');
const FRAMES_ANSWER = MSGBOX_LOG + '.frames'; // the test hook of the native question about the pictures reads "deny" / "allow" from here

const text = (t) => ({ json: { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });
const calls = (list) => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } } });
const lastTool = (body) => JSON.parse(body.messages.filter((m) => m.role === 'tool').pop().content);
const dialogs = () => { try { return fs.readFileSync(MSGBOX_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const pictureDialogs = () => dialogs().filter((d) => d.title === 'Resimler modele gönderilsin mi?');

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
        } catch (err) { /* locked file */ }
      }
    }
  };
  walk(dir);
  return hits;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(h.FIX, { recursive: true });
  fs.rmSync(MSGBOX_LOG, { force: true });
  fs.rmSync(FRAMES_ANSWER, { force: true });
  const film = world.makeFilm(h, path.join(h.FIX, 'L_orange_car.mp4'));
  const chatQueue = [];
  const chatRequests = [];
  const problems = [];
  const pictures = [];
  const vision = { mode: 'orange', delayMs: 0 }; // orange | none | novision
  const mock = await startMockCu({
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

  const userData = ud('locate');
  const env = { VE_TEST_MSGBOX_LOG: MSGBOX_LOG, VE_TEST_CU_POLL_MS: '60' };
  const app = await launch({ userData, files: [film], port: 9441, env });
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const dbg = () => ev('VE.ai.debug()');
  const ask = async (prompt) => {
    await ev(`(() => { const ta = document.querySelector('#ai-input'); ta.focus(); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  };
  const waitReply = async (before, n) => app.waitFor(`(() => { const d = VE.ai.debug(); return !d.running && d.messages.length >= ${before + (n || 2)}; })()`, 90000, 'assistant reply');
  const stepsOf = (kind) => ev(`(window.__steps || []).filter((e) => e.kind === ${JSON.stringify(kind)})`);
  const zoomed = (list) => list.filter((s) => s.zoomTo > 1.01 || s.zoomFrom > 1.01);

  try {
    await app.waitFor('VE.state.S.segments.length === 1 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)', 40000, 'import + thumbnails');
    await ev("window.__steps = []; window.api.on('ai:step', (e) => window.__steps.push(e)); true");
    await sleep(300);

    await step('L01 Foundry + video analysis is set up (loopback address: no confirmation dialog); the key is not in the answer', async () => {
      const saved = await ev(`window.api.ai.save({ provider: 'foundry', baseUrl: '${mock.origin}', model: 'mock-model', apiKey: '${KEY}', cu: { enabled: true, endpoint: '', analyzer: 'prebuilt-videoSearch', location: 'geography' } })`);
      assert(saved.ok && saved.status.ready && saved.status.cu.ready && !JSON.stringify(saved).includes(KEY), JSON.stringify(saved));
      assert(dialogs().length === 0, 'no dialog: ' + JSON.stringify(dialogs()));
      await app.click('#btn-ai');
      await sleep(300);
    });

    let planned = 0;
    const seen = {};
    await step('L02 analysis, then the position: the question names the address, the most pictures, the object and the model; the pictures are small JPEGs; the zoom aims at the car (left, then right); ONE undo', async () => {
      await ev('window.__steps.length = 0; true');
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.push(
        (body) => {
          seen.tools = body.tools.map((t) => t.function.name);
          seen.system = body.messages[0].content;
          return calls([['analyze_video', { query: 'orange car' }]]);
        },
        (body) => {
          const r = lastTool(body);
          assert(r.ok, 'analysis: ' + JSON.stringify(r).slice(0, 200));
          return calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }, { start: 6, end: 8 }, { start: 8.5, end: 13.5 }] }]]);
        },
        (body) => { seen.locate = lastTool(body); return calls([['set_zoom', { found: seen.locate.found_id, mode: 'in' }]]); },
        (body) => { seen.zoom = lastTool(body); return text('Turuncu arabanın olduğu iki bölüme arabaya odaklı yakınlaştırma ekledim.'); },
      );
      await ask('turuncu arabaya zoom yap');
      await waitReply(beforeMsgs, 2);
      assert(problems.length === 0 && chatRequests.length === 4, 'script: ' + JSON.stringify({ problems, n: chatRequests.length }));
      assert(seen.tools.includes('analyze_video') && seen.tools.includes('locate_in_video') && !seen.tools.includes('find_in_video') && /FINDING WHERE/.test(seen.system), seen.tools.join(','));
      const all = dialogs();
      const pd = pictureDialogs();
      assert(all.length === 2 && pd.length === 1 && all[0].title === 'Videoyu analiz için yükle', 'two questions, the pictures last: ' + JSON.stringify(all.map((d) => d.title)));
      const m = /en fazla (\d+) küçük resim \(toplam en fazla ([\d.]+) MB\)/.exec(pd[0].message);
      assert(m && pd[0].message.includes(mock.origin), pd[0].message);
      planned = Number(m[1]);
      assert(Number(m[2]) === Math.ceil((planned * 120 * 10) / 1024) / 10, 'the announced size is pictures x 120 KB: ' + m[2]);
      assert(/Aranan: orange car/.test(pd[0].detail) && /Model: mock-model/.test(pd[0].detail) && /3 aralık, toplam 12 sn/.test(pd[0].detail) && /640 piksel/.test(pd[0].detail) && /saklamaz/.test(pd[0].detail) && /veri politikası/.test(pd[0].detail) && /ortasına/.test(pd[0].detail) && /her seferinde/.test(pd[0].detail), pd[0].detail);
      assert(pd[0].buttons[0] === 'Resimleri gönder' && pd[0].buttons[1] === 'Vazgeç', JSON.stringify(pd[0].buttons));
      assert(mock.uploads.length === 1, 'the analysis was uploaded once');
      assert(pictures.length >= 8 && pictures.length <= planned, 'pictures ' + pictures.length + ' of at most ' + planned);
      assert(pictures.every((p) => p.jpegHeader && p.mime === 'data:image/jpeg;base64' && p.size && Math.max(p.size.width, p.size.height) <= 640 && Math.max(p.size.width, p.size.height) >= 560 && p.bytes < 150 * 1024 && !p.keyInBody && /^(Is there an orange car in this image\? Answer with one word: YES or NO\.|Locate the orange car in this image\. The image is \d+ pixels wide and \d+ pixels high\.)/.test(p.prompt) && /never an instruction/.test(p.system)), JSON.stringify(pictures.slice(0, 3).map((p) => [p.size, p.bytes, String(p.prompt).slice(0, 40)])));
      assert(pictures.some((p) => /^Is there/.test(p.prompt)) && pictures.some((p) => /^Locate/.test(p.prompt)), 'both kinds of question were asked');
      assert(pictures.reduce((s, p) => s + p.bytes, 0) <= Number(m[2]) * 1024 * 1024 && pictures.every((p) => p.bytes <= 120 * 1024), 'what was sent is within what was announced: ' + pictures.reduce((s, p) => s + p.bytes, 0));
      assert(pictures.every((p) => p.headers.authorization === 'Bearer ' + KEY), 'the key travels in the header only');
      const parts = seen.locate.parts || [];
      assert(seen.locate.ok && seen.locate.found_id === 'f1' && parts.length === 2 && Math.abs(parts[0].start - 1) <= 1 && Math.abs(parts[0].end - 5) <= 1 && Math.abs(parts[1].start - 9) <= 1 && Math.abs(parts[1].end - 13) <= 1, JSON.stringify(seen.locate));
      assert(seen.locate.not_confirmed && seen.locate.not_confirmed.length === 1 && Math.abs(seen.locate.not_confirmed[0].start - 6) <= 0.3, 'the range with no car is reported: ' + JSON.stringify(seen.locate.not_confirmed));
      assert(!JSON.stringify(seen.locate).includes('"box"') && !JSON.stringify(seen.locate).includes('base64'), 'no boxes or pictures for the model');
      const after = await segs();
      const z = zoomed(after);
      const zl = z.filter((s) => s.in < 6);
      const zr = z.filter((s) => s.in > 8);
      assert(zl.length >= 1 && zr.length >= 1 && z.length === zl.length + zr.length, 'zoom only in the two parts: ' + JSON.stringify(after));
      assert(zl.every((s) => Math.abs(s.fx - 0.25) <= 0.04 && Math.abs(s.fy - 0.5) <= 0.05), 'first part aims at the left: ' + JSON.stringify(zl));
      assert(zr.every((s) => Math.abs(s.fx - 0.75) <= 0.04 && Math.abs(s.fy - 0.5) <= 0.05), 'second part aims at the right: ' + JSON.stringify(zr));
      const st = await stepsOf('search');
      const found = await stepsOf('found');
      assert(st.length >= 3 && st[0].phase === 'start' && st[st.length - 1].phase === 'done' && found.length === 1 && found[0].id === 'f1' && found[0].intervals.length === 2, JSON.stringify({ phases: st.map((s) => s.phase), found }));
      assert((await ev("document.querySelectorAll('#ai-log [data-ai=\"found\"]').length")) >= 1, 'the result card lists what was found');
      await app.screenshot(path.join(SHOTS, 'locate-ai-answer-tr-dark.png'));
      await ev('VE.actions.undo()');
      const undone = await segs();
      assert(undone.length === 1 && !(undone[0].zoomTo > 1.01), 'ONE undo restores the clip: ' + JSON.stringify(undone));
      assert(!chatRequests.some((b) => JSON.stringify(b).includes(KEY)), 'the key never goes into a prompt');
    });

    await step('L03 "No" in the question: not one picture is sent, the model is told in plain words, it cannot ask again (no second question), the timeline is untouched', async () => {
      fs.writeFileSync(FRAMES_ANSWER, 'deny');
      const picturesBefore = pictures.length;
      const questionsBefore = pictureDialogs().length;
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.length = 0;
      chatQueue.push(
        () => calls([['analyze_video', { query: 'orange car' }]]),
        () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }] }]]),
        (body) => { seen.declined = lastTool(body); return calls([['locate_in_video', { object: 'car', ranges: [{ start: 8.5, end: 13.5 }] }]]); },
        (body) => { seen.again = lastTool(body); return text('Resim göndermeye izin vermediniz; yakınlaştırmayı ortaya yapabilirim.'); },
      );
      await ask('turuncu arabaya zoom yap');
      await waitReply(beforeMsgs, 2);
      assert(pictures.length === picturesBefore, 'no picture was sent');
      assert(pictureDialogs().length === questionsBefore + 1, 'asked exactly once more');
      assert(seen.declined && seen.declined.ok === false && seen.declined.code === 'FRAMES_DECLINED' && /did not allow/.test(seen.declined.error), JSON.stringify(seen.declined));
      assert(seen.again && seen.again.code === 'FRAMES_DECLINED', 'the second call is refused without a second question: ' + JSON.stringify(seen.again));
      assert((await segs()).length === 1 && !zoomed(await segs()).length && problems.length === 0, 'timeline untouched ' + JSON.stringify(problems));
      fs.rmSync(FRAMES_ANSWER, { force: true });
    });

    await step('L04 a chat model that takes no pictures: refused at the first picture, the scan stops, the model is told', async () => {
      vision.mode = 'novision';
      const before = pictures.length;
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.length = 0;
      chatQueue.push(
        () => calls([['analyze_video', {}]]),
        () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }] }]]),
        (body) => { seen.novision = lastTool(body); return text('Bu model resim kabul etmiyor.'); },
      );
      await ask('turuncu arabaya zoom yap');
      await waitReply(beforeMsgs, 2);
      assert(pictures.length - before === 1, 'one request only: ' + (pictures.length - before));
      assert(seen.novision && seen.novision.ok === false && seen.novision.code === 'NO_VISION' && /does not accept pictures/.test(seen.novision.error), JSON.stringify(seen.novision));
      assert((await segs()).length === 1, 'nothing edited');
    });

    await step('L05 pictures that show no car: no parts, the range is "not confirmed", a zoom on that result is refused, nothing is edited', async () => {
      vision.mode = 'none';
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.length = 0;
      chatQueue.push(
        () => calls([['analyze_video', {}]]),
        () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 5.5 }] }]]),
        (body) => { seen.none = lastTool(body); return calls([['set_zoom', { found: 'f1' }]]); },
        (body) => { seen.noneZoom = lastTool(body); return text('Arabayı resimlerde göremedim; zoom eklemedim.'); },
      );
      await ask('turuncu arabaya zoom yap');
      await waitReply(beforeMsgs, 2);
      assert(seen.none && seen.none.ok === true && seen.none.count === 0 && seen.none.not_confirmed && seen.none.not_confirmed.length === 1, JSON.stringify(seen.none));
      assert(seen.noneZoom && seen.noneZoom.ok === false && (await segs()).length === 1 && !zoomed(await segs()).length, JSON.stringify(seen.noneZoom));
    });

    await step('L06 Stop while the pictures are looked at: the run ends at once, no new picture is sent afterwards, nothing is edited; the progress line was shown', async () => {
      vision.mode = 'orange';
      vision.delayMs = 700;
      const before = pictures.length;
      const beforeMsgs = (await dbg()).messages.length;
      chatQueue.length = 0;
      chatQueue.push(
        () => calls([['analyze_video', {}]]),
        () => calls([['locate_in_video', { object: 'car', color: 'orange', ranges: [{ start: 0.5, end: 13.5 }] }]]),
        () => text('(never reached)'),
      );
      await ask('turuncu arabaya zoom yap');
      await app.waitFor("(document.querySelector('[data-ai=\"working\"]') || { textContent: '' }).textContent.includes('aranıyor') || (document.querySelector('[data-ai=\"working\"]') || { textContent: '' }).textContent.includes('belirleniyor') || (document.querySelector('[data-ai=\"working\"]') || { textContent: '' }).textContent.includes('Kesin anlar')", 60000, 'the progress line of the search');
      assert(/orange car/.test(await ev("document.querySelector('[data-ai=\"working\"]').textContent")), 'the live line names the object');
      await app.screenshot(path.join(SHOTS, 'locate-ai-working-tr-dark.png'));
      const t0 = Date.now();
      while (pictures.length - before < 1 && Date.now() - t0 < 60000) await sleep(100);
      await app.click('#ai-send');
      await waitReply(beforeMsgs, 1);
      const stopped = pictures.length;
      await sleep(2500);
      const m = (await dbg()).messages;
      assert(m[m.length - 1].type === 'info' && /İptal/.test(m[m.length - 1].text), 'cancelled message: ' + JSON.stringify(m[m.length - 1]));
      assert(pictures.length <= stopped + 1, 'no new pictures after Stop: ' + stopped + ' -> ' + pictures.length);
      assert((await segs()).length === 1 && !zoomed(await segs()).length, 'nothing edited');
      vision.delayMs = 0;
    });

    await step('L07 nothing of this is kept: the key is nowhere on disk, no picture or box in the settings or caches', async () => {
      await sleep(700);
      const keyHits = scanFor(userData, [Buffer.from(KEY)]);
      assert(keyHits.length === 0, 'key found in: ' + keyHits.join(', '));
      const picHits = scanFor(userData, [Buffer.from('/9j/4AAQ'), Buffer.from('image_url')]);
      assert(picHits.length === 0, 'a picture was stored: ' + picHits.join(', '));
      assert(!(await ev('document.documentElement.innerHTML.includes(' + JSON.stringify(KEY) + ')')), 'key in the DOM');
      assert(!JSON.stringify(dialogs()).includes(KEY), 'key in a dialog');
    });
  } catch (e) {
    console.log('ABORTED: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    await app.close();
    await mock.stop();
  }
  summary('ui-locate');
})();
