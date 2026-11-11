'use strict';
// Smoke test: the page loads without errors, defaults are right, a video imports (probe, thumbnails, waveform) and shows up on the timeline.
const path = require('path');
const { open, checker } = require('./lib/site');

(async () => {
  const check = checker('web smoke');
  const out = process.env.VE_SHOTS || path.join(require('os').tmpdir(), 've-web-shots');
  const app = await open({ headless: true });
  try {
    await app.evaluate('new Promise((r) => setTimeout(r, 400))');
    check('no console errors on load', app.errors.length === 0, app.errors);
    check('default language is Turkish', (await app.evaluate("document.documentElement.lang")) === 'tr');
    check('default theme is dark', (await app.evaluate("document.documentElement.getAttribute('data-theme')")) === 'dark');
    check('title is Turkish', (await app.evaluate("document.querySelector('.brand-name').textContent")) === 'Video Editör');
    check('capabilities: webcodecs', (await app.evaluate('VE.web.caps.webCodecs')) === true);
    check('only same-origin requests were made', app.requests.every((u) => u.startsWith(app.origin) || u.startsWith('data:') || u.startsWith('blob:')), app.requests.filter((u) => !u.startsWith(app.origin)));
    await app.screenshot(path.join(out, 'smoke-empty-tr-dark.png'));

    await app.stage('A_audio_720p.mp4');
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 1', 20000, 'video imported');
    const m = await app.evaluate('(() => { const m = Array.from(VE.state.S.media.values())[0]; return { name: m.name, duration: m.duration, w: m.displayWidth, h: m.displayHeight, fps: m.fps, hasAudio: m.hasAudio, vcodec: m.vcodec, thumbCount: m.thumbCount }; })()');
    check('probe: duration ~8 s', Math.abs(m.duration - 8) < 0.2, m);
    check('probe: 1280x720', m.w === 1280 && m.h === 720, m);
    check('probe: fps ~30', Math.abs(m.fps - 30) < 1, m);
    check('probe: audio present, h264', m.hasAudio && m.vcodec === 'h264', m);
    await app.waitFor('(() => { const m = Array.from(VE.state.S.media.values())[0]; return m.thumbsReady.size >= m.thumbCount; })()', 30000, 'thumbnails');
    check('all thumbnails generated', true);
    await app.waitFor('(() => { const m = Array.from(VE.state.S.media.values())[0]; return !!m.waveform && m.waveform.length >= 390; })()', 30000, 'waveform');
    const wf = await app.evaluate('(() => { const w = Array.from(VE.state.S.media.values())[0].waveform; let max = 0; for (const v of w) if (v > max) max = v; return { len: w.length, max }; })()');
    check('waveform ~50 buckets/s with signal', wf.len >= 395 && wf.len <= 410 && wf.max > 100, wf);
    const vid = await app.evaluate('(() => { const v = document.querySelector("#deck-a video, #deck-b video"); const all = Array.from(document.querySelectorAll("video")); return all.map((x) => ({ src: x.currentSrc.slice(0, 20), rs: x.readyState, w: x.videoWidth, dur: x.duration })); })()');
    check('preview video element loaded the blob', vid.some((v) => v.src.startsWith('blob:') && v.rs >= 2 && v.w === 1280), vid);
    await app.screenshot(path.join(out, 'smoke-loaded-tr-dark.png'));
    check('no console errors after import', app.errors.length === 0, app.errors);
  } catch (e) {
    check('smoke test ran to the end', false, String((e && e.stack) || e));
  } finally {
    await app.close();
  }
  process.exitCode = check.summary() ? process.exitCode : 1;
})();
