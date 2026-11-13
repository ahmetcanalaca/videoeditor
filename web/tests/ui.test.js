'use strict';
// UI verification of the web edition in a real browser: defaults, language / theme (and that they are remembered), import by button and by
// drag & drop, editing with the keyboard and the inspector, undo / redo, merge order, export through the dialog, projects (save, open, relink),
// error messages, small windows. Screenshots go to VE_SHOTS (default: the temp folder).
//   node tests/ui.test.js            (VE_BROWSER=<chrome|edge exe>, headless unless VE_HEADED=1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open, checker } = require('./lib/site');
const h = require('./lib/media-tools');

const SHOTS = process.env.VE_SHOTS || path.join(os.tmpdir(), 've-web-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const check = checker('web ui');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 've-web-ui-'));
  const app = await open({ headless: process.env.VE_HEADED !== '1', width: 1366, height: 820 });
  const fx = app.fixtures;
  const A = path.basename(fx.A);
  const B = path.basename(fx.B);
  const C = path.basename(fx.C);
  const ev = (expr) => app.evaluate(expr);
  const segs = () => ev('VE.state.S.segments.map((s) => ({ id: s.id, name: (VE.state.S.media.get(s.mediaId) || {}).name, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy, volume: s.volume, mute: s.mute, fadeIn: s.fadeIn, fadeOut: s.fadeOut }))');
  const total = () => ev('VE.state.layout().total');
  const lang = () => ev('document.documentElement.lang');
  const theme = () => ev("document.documentElement.getAttribute('data-theme')");
  const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || { textContent: '' }).textContent`);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  try {
    /* ---------------- defaults ---------------- */
    check('01 no console errors on load', app.errors.length === 0, app.errors);
    check('02 Turkish and dark by default', (await lang()) === 'tr' && (await theme()) === 'dark', { lang: await lang(), theme: await theme() });
    check('03 only same-origin requests so far (no CDN, no font, no telemetry)', app.requests.every((u) => u.startsWith(app.origin) || /^(data|blob):/.test(u)), app.requests.filter((u) => !u.startsWith(app.origin)));
    check('04 the AI button is offered; the assistant stays off until it is set up (nothing is contacted)', (await ev("document.querySelector('#btn-ai').hidden")) === false && (await ev('window.api.ai.status().then((s) => s.provider === "inbrowser" && s.needs === "model" && s.ready === false)')) === true);
    await app.screenshot(path.join(SHOTS, 'web-01-empty-tr-dark.png'));

    /* ---------------- language and theme are remembered ---------------- */
    await app.click('#lang-switch button[data-lang=en]');
    await sleep(200);
    check('05 English: texts and html lang change', (await lang()) === 'en' && /Export/.test(await text('#btn-export')) && /Drag your videos/i.test(await text('#empty-state .empty-title')), await text('#empty-state .empty-title'));
    await app.click('#btn-theme');
    await sleep(200);
    check('06 light theme applied', (await theme()) === 'light');
    const stored = await ev("JSON.parse(localStorage.getItem('ve.web.settings.v1'))");
    check('07 choices are stored in this browser only (localStorage)', stored.language === 'en' && stored.theme === 'light', stored);
    await app.navigate(app.origin + app.server.base + 'index.html?vetest', "typeof VE !== 'undefined' && !!VE.actions");
    check('08 after a reload: English + light are back', (await lang()) === 'en' && (await theme()) === 'light', { lang: await lang(), theme: await theme() });
    await app.screenshot(path.join(SHOTS, 'web-02-empty-en-light.png'));
    await app.click('#lang-switch button[data-lang=tr]');
    await app.click('#btn-theme');
    await sleep(200);
    check('09 and back to Turkish + dark', (await lang()) === 'tr' && (await theme()) === 'dark');

    /* ---------------- import ---------------- */
    await app.stage([A, B, C]);
    await app.click('#btn-add-empty');
    await app.waitFor('VE.state.S.segments.length === 3', 30000, 'three clips');
    check('10 three videos imported: three clips in the order chosen', JSON.stringify((await segs()).map((s) => s.name)) === JSON.stringify([A, B, C]), await segs());
    await app.waitFor('Array.from(VE.state.S.media.values()).every((m) => m.thumbsReady.size >= m.thumbCount && (!m.hasAudio || (m.waveform && m.waveform.length > 10)))', 60000, 'thumbnails + waveforms');
    check('11 thumbnails and waveforms are generated for all', true);
    check('12 the last imported clip is selected and the inspector shows its name', /C_rotated_phone/.test(await text('#clip-name')), await text('#clip-name'));
    const dur = await total();
    check('13 timeline length = 8 + 5 + 4 s', near(dur, 17, 0.2), dur);
    await app.screenshot(path.join(SHOTS, 'web-03-editor-tr-dark.png'));

    /* ---------------- keyboard editing ---------------- */
    await ev('VE.state.setPlayhead(2.0, "user")');
    await ev('VE.state.select(VE.state.S.segments[0].id)');
    await sleep(150);
    await app.key('s');
    await sleep(200);
    let s1 = await segs();
    check('14 S splits the clip at the playhead (A -> two clips, same total length)', s1.length === 4 && near(s1[0].out, 2, 0.05) && near(s1[1].in, 2, 0.05) && near(await total(), dur, 0.05), s1.map((s) => [s.name, s.in, s.out]));
    await app.key('z', { ctrl: true });
    await sleep(150);
    check('15 Ctrl+Z undoes the split', (await segs()).length === 3);
    await app.key('y', { ctrl: true });
    await sleep(150);
    check('16 Ctrl+Y redoes it', (await segs()).length === 4);
    await app.key('z', { ctrl: true });
    await app.key('z', { ctrl: true, shift: true });
    await sleep(150);
    check('17 Ctrl+Shift+Z also redoes', (await segs()).length === 4);

    // trim the second half of A from its start: playhead at 3 s, Q
    await ev('VE.state.select(VE.state.S.segments[1].id); VE.state.setPlayhead(3.0, "user")');
    await sleep(100);
    await app.key('q');
    await sleep(150);
    s1 = await segs();
    check('18 Q trims the start of the selected clip to the playhead', near(s1[1].in, 3, 0.05) && near(s1[1].out, 8, 0.05), s1[1]);
    await app.key('Delete');
    await sleep(150);
    s1 = await segs();
    check('19 Delete removes the selected clip', s1.length === 3 && s1[1].name === B, s1.map((s) => s.name));
    await app.key('z', { ctrl: true });
    await sleep(100);

    /* ---------------- inspector: speed, zoom, volume, fade ---------------- */
    await ev('VE.state.select(VE.state.S.segments[0].id)');
    await sleep(100);
    await app.click('#speed-chips .chip:nth-child(5)');
    await sleep(150);
    let sel = (await segs())[0];
    check('20 the 2x speed chip sets the speed', sel.speed === 2, sel.speed);
    await app.click('#zoom-presets [data-zoom=in]');
    await sleep(150);
    sel = (await segs())[0];
    check('21 "zoom in" preset: end zoom above start zoom', sel.zoomTo > sel.zoomFrom + 0.4, sel);
    await ev(`(() => { const i = document.querySelector('#clip-volume'); i.value = 50; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ev(`(() => { const i = document.querySelector('#fade-in'); i.value = 1; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(150);
    sel = (await segs())[0];
    check('22 volume 50% and fade-in 1 s', near(sel.volume, 0.5, 0.01) && near(sel.fadeIn, 1, 0.01), sel);
    await app.click('#btn-reset-clip');
    await sleep(150);
    sel = (await segs())[0];
    check('23 reset clip restores speed, zoom, volume and fade', sel.speed === 1 && sel.zoomFrom === 1 && sel.zoomTo === 1 && sel.volume === 1 && sel.fadeIn === 0, sel);

    /* ---------------- order (merge) ---------------- */
    const firstId = (await segs())[0].id;
    await ev('VE.state.select(VE.state.S.segments[0].id)');
    await app.key('ArrowRight', { alt: true });
    await sleep(150);
    check('24 Alt+Right moves the clip behind the next one', (await segs())[1].id === firstId, (await segs()).map((s) => s.id));
    await app.click('#btn-undo');
    await sleep(100);
    check('25 the Undo button works', (await segs())[0].id === firstId);

    /* ---------------- playback ---------------- */
    await ev('VE.state.setPlayhead(0, "user")');
    await sleep(200);
    await app.click('#btn-play');
    await sleep(900);
    const ph1 = await ev('VE.state.S.playhead');
    await app.key(' ');
    await sleep(200);
    const ph2 = await ev('VE.state.S.playhead');
    await sleep(500);
    const ph3 = await ev('VE.state.S.playhead');
    check('26 play advances the playhead, Space pauses it', ph1 > 0.3 && near(ph2, ph3, 0.05), { ph1, ph2, ph3 });

    /* ---------------- drag & drop ---------------- */
    const n0 = (await segs()).length;
    const dropped = await ev(`(async () => {
      const r = await fetch('/__fixtures__/' + encodeURIComponent(${JSON.stringify(path.basename(fx.W))}));
      const f = new File([await r.blob()], ${JSON.stringify(path.basename(fx.W))}, { lastModified: 1700000000000 });
      const dt = new DataTransfer();
      dt.items.add(f);
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const shown = document.querySelector('#drop-overlay').classList.contains('show');
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return shown;
    })()`);
    await app.waitFor('VE.state.S.segments.length === ' + (n0 + 1), 20000, 'dropped video');
    check('27 dropping a video shows the overlay and adds it to the timeline', dropped === true && (await segs())[n0].name === path.basename(fx.W), await segs());

    /* ---------------- bad file ---------------- */
    await ev(`(async () => {
      const f = new File([new Uint8Array(2048)], 'bozuk dosya.mp4', { lastModified: 1 });
      window.__veTest.media = [f];
    })()`);
    await app.click('#btn-add');
    await app.waitFor("/bozuk dosya/.test(document.querySelector('#toasts').textContent)", 15000, 'error toast');
    const toast = await text('#toasts');
    check('28 an unreadable file is reported in Turkish with its name, nothing is added', /bozuk dosya\.mp4/.test(toast) && /okunamadı|desteklenmiyor/i.test(toast) && (await segs()).length === n0 + 1, toast);

    /* ---------------- export through the dialog ---------------- */
    await app.stage([A], 'media');
    await ev('window.__veTest.exportToMemory = true');
    await app.key('e', { ctrl: true });
    await app.waitFor("!!document.querySelector('#modal-root .modal')", 5000, 'export dialog');
    check('29 Ctrl+E opens the export dialog (Turkish)', /Dışa aktar/.test(await text('#modal-root .modal-head')), await text('#modal-root .modal-head'));
    await app.click('#modal-root .path-row .btn');
    await app.waitFor("document.querySelector('#modal-root .path-row input').value.length > 0", 5000, 'file chosen');
    await ev(`(() => { const s = document.querySelectorAll('#modal-root select'); const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }; set(s[0], '480'); set(s[3], 'low'); })()`);
    await app.screenshot(path.join(SHOTS, 'web-04-export-dialog-tr-dark.png'));
    await ev('VE.state.select(null)');
    await app.click('#modal-root .modal-foot .btn.primary');
    await app.waitFor("/tamamlandı/.test(document.querySelector('#modal-root .modal').textContent)", 120000, 'export done');
    await app.screenshot(path.join(SHOTS, 'web-05-export-done-tr-dark.png'));
    const lastExport = await ev('window.__veLastExport ? { size: window.__veLastExport.size, name: window.__veLastExport.name } : null');
    check('30 the dialog reports the finished export; the file was produced in memory (no picker in the test)', lastExport && lastExport.size > 10000, lastExport);
    // measure it
    await ev(`(async () => { await fetch('/__upload__/ui-export.mp4', { method: 'POST', body: window.__veLastExport.blob }); return true; })()`);
    const outFile = path.join(app.upDir, 'ui-export.mp4');
    const so = h.streamsOf(outFile);
    check('31 the exported file: H.264 + AAC, 480p, the project length', so.v.codec_name === 'h264' && so.a && Number(so.v.height) === 480 && near(so.duration, await total(), 0.5), { v: so.v.codec_name, h: so.v.height, dur: so.duration, total: await total() });
    await app.click('#modal-root .modal-foot .btn:not(.primary)');
    await sleep(150);

    /* ---------------- project: save, new, open (with relink) ---------------- */
    const before = await segs();
    await ev('window.__veTest.projectToMemory = true');
    await app.key('s', { ctrl: true });
    await app.waitFor('!!window.__veLastProject', 8000, 'project saved');
    const proj = JSON.parse(await ev('window.__veLastProject.text'));
    check('32 Ctrl+S writes a .vedproj with the segments and the file names (no paths)', proj.app === 'VideoEditor' && proj.segments.length === before.length && proj.media.every((m) => m.name && !/[\\/]/.test(m.name)), { segs: proj.segments.length, media: proj.media.map((m) => m.name) });
    // new project (clean: the save above marked it clean)
    await app.click('#btn-new');
    await app.waitFor('VE.state.S.segments.length === 0', 8000, 'new project');
    check('33 "new" clears the timeline and releases the media', (await ev('VE.state.S.media.size')) === 0);
    // open: the project file is staged as the picker result; the videos are asked for again (relink)
    await ev(`(async () => {
      const text = window.__veLastProject.text;
      window.__veTest.project = [new File([text], 'test.vedproj', { type: 'application/json', lastModified: 1 })];
    })()`);
    await app.stage(Array.from(new Set(proj.media.map((m) => m.name))), 'media');
    await ev('window.__veAnswers = [0]'); // the relink dialog: "choose the videos"
    await app.click('#btn-open');
    await app.waitFor('VE.state.S.segments.length === ' + before.length, 30000, 'project opened');
    const after = await segs();
    check('34 opening the project restores every clip and edit (same order, in/out, speed)', after.length === before.length && after.every((s, i) => s.name === before[i].name && near(s.in, before[i].in, 1e-6) && near(s.out, before[i].out, 1e-6) && s.speed === before[i].speed), after);
    const dialogs = await ev('window.__veDialogs || []');
    check('35 the relink dialog explained that browsers do not know file paths', dialogs.some((d) => /yollar|yeniden seçmeniz/i.test(d.message)), dialogs.map((d) => d.message));

    /* ---------------- about ---------------- */
    await app.click('#btn-about');
    await app.waitFor("!!document.querySelector('#modal-root .about-grid')", 5000, 'about');
    const about = await text('#modal-root .modal-body');
    check('36 the about dialog names the version, browser and video engine, and says nothing leaves the computer', /4\.\d/.test(about) && /Edge|Chrome/.test(about) && /Mediabunny/.test(about) && /bilgisayarınızdan çıkmaz/.test(about), about.slice(0, 300));
    await app.key('Escape');
    await sleep(150);

    /* ---------------- small window ---------------- */
    await app.evaluate('0');
    await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 640, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const overflow = await ev('({ x: document.documentElement.scrollWidth > innerWidth + 1, y: document.documentElement.scrollHeight > innerHeight + 1 })');
    check('37 at 980x640 nothing overflows the window', !overflow.x && !overflow.y, overflow);
    await app.screenshot(path.join(SHOTS, 'web-06-small-980x640-tr-dark.png'));
    await app.cdp.send('Emulation.clearDeviceMetricsOverride');

    check('38 no console errors during the whole run', app.errors.length === 0, app.errors);
    check('39 every request of the whole run stayed on this origin', app.requests.every((u) => u.startsWith(app.origin) || /^(data|blob):/.test(u)), app.requests.filter((u) => !u.startsWith(app.origin)));
  } catch (e) {
    check('ui test ran to the end', false, String((e && e.stack) || e));
    try { await app.screenshot(path.join(SHOTS, 'web-failure.png')); } catch (e2) { /* ignore */ }
  } finally {
    await app.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  process.exitCode = check.summary() ? process.exitCode : 1;
})();
