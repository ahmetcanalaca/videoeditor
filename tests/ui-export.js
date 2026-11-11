'use strict';
// UI scenario 2: export dialog (progress / done / cancel / errors), preview-vs-export (WYSIWYG) comparison,
// TR/EN x dark/light screenshots, persistence of language + theme, close-confirmation flows.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, sleep, waitUntil } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, pngGray, videoGray, psnr, barX, pngSize, h } = require('./ui-helpers');

const SHOTS = path.join(OUT, 'shots');
// VE_SHOT_EXPORT_DIR: export into a neutral folder, so that the screenshot of the finished export (docs/screenshots/09-...) shows no build path
const EXPORT_DIR = process.env.VE_SHOT_EXPORT_DIR ? path.resolve(process.env.VE_SHOT_EXPORT_DIR) : path.join(OUT, 'Çıktı Klasörü');
const EXPORT_FILE = path.join(EXPORT_DIR, 'dışa_aktarım örnek.mp4');
const MSGBOX_LOG = path.join(OUT, 'msgbox.log');

function closeMainWindow(pid) {
  spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
}

(async () => {
  const fx = h.makeFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.rmSync(MSGBOX_LOG, { force: true });
  fs.writeFileSync(MSGBOX_LOG + '.choice', '1');

  const userData = ud('export');
  const env = { VE_TEST_EXPORT_PATH: EXPORT_FILE, VE_TEST_MSGBOX_LOG: MSGBOX_LOG, VE_TEST_OPEN_PATHS: fx.A };
  let app = await launch({ userData, files: [fx.A, fx.B], port: 9352, env });

  const segs = () => app.evaluate('VE.state.S.segments.map((s) => ({ id: s.id, mediaId: s.mediaId, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo }))');
  const settle = async () => {
    await app.waitFor('(() => { const d = VE.player.debug(); const a = d.decks[d.active]; return !d.busy && a.readyState >= 2 && !a.seeking; })()', 8000, 'player settled');
    await sleep(160);
  };
  const seek = async (t) => { await app.evaluate(`VE.actions.seek(${t})`); await sleep(100); await settle(); };
  const modalText = () => app.evaluate("(document.querySelector('#modal-root .modal') || { textContent: '' }).textContent");

  try {
    await app.waitFor("VE.state.S.segments.length === 2 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import + thumbnails');

    // ---- crafted project: zoom in, speed 2x + fade out, zoom out on a 4:3 clip (letterboxed) ----
    const build = (extraCopies) => app.evaluate(`(() => {
      const S = VE.state.S; const M = VE.model;
      const A = [...S.media.values()].find((m) => m.name.startsWith('A_'));
      const B = [...S.media.values()].find((m) => m.name.startsWith('B_'));
      const s1 = M.createSegment(A, { in: 0, out: 4, zoomFrom: 1, zoomTo: 2, fx: 0.75, fy: 0.35 });
      const s2 = M.createSegment(A, { in: 4, out: 8, speed: 2, fadeOut: 0.4 });
      const s3 = M.createSegment(B, { in: 0, out: 5, zoomFrom: 2.2, zoomTo: 1, fx: 0.3, fy: 0.6 });
      const list = [s1, s2, s3];
      for (let i = 0; i < ${extraCopies}; i++) list.push(Object.assign({}, i % 2 ? s3 : s1, { id: M.uid('seg') }));
      VE.state.commit(list, { selectedId: s1.id, playhead: 0 });
      return list.length;
    })()`);

    await step('E01 crafted project: zoom-in, 2x speed + fade, letterboxed zoom-out (11 s)', async () => {
      assert((await build(0)) === 3, 'segments');
      await sleep(300);
      const total = await app.evaluate('VE.state.layout().total');
      near(total, 11, 0.001, 'total');
      await app.screenshot(path.join(SHOTS, 'tr-dark-editor.png'));
    });

    // ---- preview must equal the export: export first, then compare frames at several timeline positions ----
    await step('E02 export dialog: form values, Turkish default file chooser, summary', async () => {
      await app.click('#btn-export');
      await app.waitFor("!!document.querySelector('#modal-root .modal')", 5000, 'modal');
      const selects = await app.evaluate("[...document.querySelectorAll('#modal-root select')].map((s) => s.value)");
      assert(JSON.stringify(selects) === JSON.stringify(['original', 'auto', 'auto', 'high']), 'defaults ' + JSON.stringify(selects));
      const text = await modalText();
      assert(text.includes('1280×720') && text.includes('00:11.00') && text.includes('Çıktı dosyası'), 'summary/labels: ' + text);
      await app.screenshot(path.join(SHOTS, 'tr-dark-export-form.png'));
      // start without choosing a file -> warning toast, stays in the form
      await app.evaluate("document.querySelector('#modal-root .btn.primary').click()");
      await sleep(250);
      assert((await app.evaluate("document.querySelector('#toasts').textContent")).includes('çıktı dosyası'), 'missing-file toast');
      await app.click('#modal-root .path-row .btn');
      await sleep(300);
      assert((await app.evaluate("document.querySelector('#modal-root .path-row input').value")) === EXPORT_FILE, 'path not chosen');
    });

    await step('E03 export runs with live progress, ETA and speed, then shows the result', async () => {
      // make it long enough to observe progress
      await app.evaluate("document.querySelector('#modal-root .btn.primary').click()");
      await app.waitFor("!!document.querySelector('#modal-root .progress')", 8000, 'progress bar');
      let seen = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const info = await app.evaluate("(() => { const b = document.querySelector('#modal-root .progress > div'); const m = document.querySelector('#modal-root .progress-meta'); const r = document.querySelector('#modal-root .result'); return { w: b ? parseFloat(b.style.width) || 0 : -1, meta: m ? m.textContent : '', done: !!r }; })()");
        if (info.done) break;
        if (!seen && info.w > 8 && info.w < 95) { seen = info; await app.screenshot(path.join(SHOTS, 'tr-dark-export-progress.png')); }
        await sleep(60);
      }
      await app.waitFor("!!document.querySelector('#modal-root .result.ok')", 60000, 'export result');
      await app.screenshot(path.join(SHOTS, 'tr-dark-export-done.png'));
      return seen ? `progress seen at ${seen.w.toFixed(0)}% — ${seen.meta}` : 'finished before a progress frame could be sampled';
    });

    await step('E04 exported file: duration, size, codecs, frame count (ffprobe) — Turkish path', async () => {
      assert(fs.existsSync(EXPORT_FILE), 'file missing');
      assert(!fs.existsSync(EXPORT_FILE + '.part'), '.part left');
      const s = h.streamsOf(EXPORT_FILE);
      near(s.duration, 11, 0.12, 'duration');
      assert(s.v.codec_name === 'h264' && s.v.width === 1280 && s.v.height === 720 && s.v.pix_fmt === 'yuv420p', 'video ' + s.v.codec_name + ' ' + s.v.width + 'x' + s.v.height);
      assert(s.a && s.a.codec_name === 'aac', 'audio stream');
      near(h.countFrames(EXPORT_FILE), 330, 0, 'frame count');
      const txt = await modalText();
      assert(txt.includes('Dışa aktarma tamamlandı') && txt.includes('dışa_aktarım örnek.mp4'), 'result card text: ' + txt);
      return `${(fs.statSync(EXPORT_FILE).size / 1024).toFixed(0)} KB`;
    });

    await app.evaluate("document.querySelector('#modal-root .modal-foot .btn:last-child').click()"); // Close
    await sleep(200);

    const wy = [
      { t: 0.0, label: 'start of zoom-in', min: 30 },
      { t: 1.5, label: 'zoom-in 1.5 s', min: 30 },
      { t: 3.9, label: 'end of zoom-in', min: 30 },
      { t: 4.6, label: '2x speed clip', min: 20 },
      { t: 5.4, label: '2x speed clip, later', min: 20 },
      { t: 6.05, label: 'letterboxed clip, zoom 2.2x', min: 30 },
      { t: 8.0, label: 'letterboxed zoom-out', min: 30 },
      { t: 10.8, label: 'end of zoom-out', min: 30 },
    ];
    for (const w of wy) {
      await step(`E05 WYSIWYG @${w.t}s (${w.label}): preview frame == exported frame`, async () => {
        await seek(w.t);
        const r = await app.rect('#canvas');
        const png = path.join(SHOTS, `wysiwyg-preview-${w.t}.png`);
        await app.screenshot(png, { x: r.x, y: r.y, width: r.w, height: r.h });
        const W = 320; const H = 180;
        const pv = pngGray(png, W, H);
        // The preview samples the source at the playhead instant, the export at the start of an output frame:
        // they may differ by up to one frame, so the best of the neighbouring exported frames is used.
        let best = null;
        for (const k of [-1, 0, 1]) {
          const ex = videoGray(EXPORT_FILE, Math.max(0, w.t + k / 30 - 0.001), W, H);
          const p = psnr(pv, ex);
          if (!best || p > best.p) best = { p, k, ex };
        }
        const bp = barX(pv, W, H, 215);
        const be = barX(best.ex, W, H, 215);
        if (bp !== null || be !== null) {
          assert(bp !== null && be !== null, `bar visible in only one of them (preview=${bp}, export=${be})`);
          near(bp, be, 0.02, 'bar position (fraction of width)');
        }
        assert(best.p > w.min, `PSNR ${best.p.toFixed(1)} dB < ${w.min} dB`);
        return `PSNR=${best.p.toFixed(1)} dB (frame offset ${best.k}) bar preview=${bp === null ? '-' : bp.toFixed(3)} export=${be === null ? '-' : be.toFixed(3)}`;
      });
    }

    await step('E06 cancel: progress aborts, partial file removed, previous export untouched', async () => {
      const before = fs.statSync(EXPORT_FILE);
      await build(14); // long project (~100 s)
      await sleep(300);
      await app.click('#btn-export');
      await app.waitFor("!!document.querySelector('#modal-root .path-row')", 5000, 'modal');
      await app.click('#modal-root .path-row .btn');
      await sleep(200);
      await app.evaluate("document.querySelector('#modal-root .btn.primary').click()");
      await app.waitFor("(() => { const b = document.querySelector('#modal-root .progress > div'); return b && parseFloat(b.style.width) > 3; })()", 30000, 'progress > 3%');
      await app.screenshot(path.join(SHOTS, 'tr-dark-export-cancelling.png'));
      await app.evaluate("document.querySelector('#modal-root .modal-foot .btn').click()"); // Cancel
      await app.waitFor("!!document.querySelector('#modal-root .result')", 15000, 'cancel result');
      const txt = await modalText();
      assert(txt.includes('iptal edildi'), 'cancel text: ' + txt);
      assert(!(await app.evaluate("!!document.querySelector('#modal-root .result.ok')")), 'cancelled export reported as success');
      await sleep(400);
      assert(!fs.existsSync(EXPORT_FILE + '.part'), '.part left after cancel');
      const after = fs.statSync(EXPORT_FILE);
      assert(after.size === before.size && after.mtimeMs === before.mtimeMs, 'previous export was modified by the cancelled one');
      await app.screenshot(path.join(SHOTS, 'tr-dark-export-cancelled.png'));
      await app.evaluate("document.querySelector('#modal-root .modal-foot .btn').click()");
    });

    // ---- language / theme matrix ----
    await app.evaluate('(() => { VE.state.commit(VE.state.S.segments.slice(0, 3), { selectedId: VE.state.S.segments[0].id, playhead: 1.6 }); })()');
    await sleep(400);
    await settle();
    const combos = [['tr', 'dark'], ['tr', 'light'], ['en', 'light'], ['en', 'dark']];
    for (const [lang, theme] of combos) {
      await step(`E07 screenshots ${lang.toUpperCase()} / ${theme} (editor + export dialog)`, async () => {
        const curLang = await app.evaluate('document.documentElement.lang');
        const curTheme = await app.evaluate("document.documentElement.getAttribute('data-theme')");
        if (curLang !== lang) await app.click(`#lang-switch button[data-lang="${lang}"]`);
        if (curTheme !== theme) await app.click('#btn-theme');
        await sleep(450);
        assert((await app.evaluate('document.documentElement.lang')) === lang, 'lang not applied');
        assert((await app.evaluate("document.documentElement.getAttribute('data-theme')")) === theme, 'theme not applied');
        const exportLabel = await app.evaluate("document.querySelector('#btn-export').textContent.trim()");
        assert(exportLabel === (lang === 'tr' ? 'Dışa aktar' : 'Export'), 'export label ' + exportLabel);
        await app.evaluate("document.querySelector('#insp-body').scrollTop = 0; document.querySelector('#inspector').scrollTop = 0");
        // the guide's numbered screenshots need a stable geometry (1920x1128), whatever the size of the machine's screen
        await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 752, deviceScaleFactor: 1.5, mobile: false });
        await sleep(450);
        await app.screenshot(path.join(SHOTS, `${lang}-${theme}-editor.png`));
        await app.cdp.send('Emulation.clearDeviceMetricsOverride');
        await sleep(250);
        await app.click('#btn-export');
        await app.waitFor("!!document.querySelector('#modal-root .modal')", 4000, 'modal');
        await sleep(250);
        await app.screenshot(path.join(SHOTS, `${lang}-${theme}-export-form.png`));
        await app.key('Escape');
        await sleep(250);
        assert(!(await app.evaluate("!!document.querySelector('#modal-root .modal')")), 'Escape did not close the dialog');
      });
    }

    await step('E08 about dialog states the offline / no-API-key promise (both languages)', async () => {
      await app.click('#btn-about');
      await app.waitFor("!!document.querySelector('#modal-root .modal')", 5000, 'about');
      const en = await modalText();
      assert(/No API key/i.test(en) && /FFmpeg/.test(en), 'EN about: ' + en);
      await app.screenshot(path.join(SHOTS, 'en-dark-about.png'));
      await app.key('Escape');
      await sleep(200);
      await app.click('#lang-switch button[data-lang="tr"]');
      await sleep(250);
      await app.click('#btn-about');
      await app.waitFor("!!document.querySelector('#modal-root .modal')", 5000, 'about tr');
      const tr = await modalText();
      assert(/API anahtarı/.test(tr) && /çevrimdışı/i.test(tr), 'TR about: ' + tr);
      await app.screenshot(path.join(SHOTS, 'tr-dark-about.png'));
      await app.key('Escape');
      await sleep(200);
      await app.click('#lang-switch button[data-lang="en"]');
      await sleep(250);
    });

    await step('E09 empty state after "New project" (TR light + EN dark screenshots)', async () => {
      fs.writeFileSync(MSGBOX_LOG + '.choice', '1'); // "Don't save"
      await app.click('#btn-new');
      await app.waitFor('VE.state.S.segments.length === 0', 8000, 'empty project');
      await sleep(400);
      assert(!(await app.evaluate("document.querySelector('#empty-state').hidden")), 'empty state hidden');
      await app.screenshot(path.join(SHOTS, 'en-dark-empty.png'));
      await app.click('#btn-theme');
      await app.click('#lang-switch button[data-lang="tr"]');
      await sleep(450);
      await app.screenshot(path.join(SHOTS, 'tr-light-empty.png'));
      const log = fs.readFileSync(MSGBOX_LOG, 'utf8');
      assert(/Kaydedilmemiş değişiklikler|Unsaved changes/.test(log), 'unsaved-changes dialog was not shown: ' + log);
    });

    await step('E10 settings persisted: language + theme + export options on disk', async () => {
      await sleep(900);
      const file = path.join(userData, 'settings.json');
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert(s.language === 'tr' && s.theme === 'light', 'settings.json: ' + JSON.stringify(s));
      return JSON.stringify({ language: s.language, theme: s.theme, export: s.export });
    });

    await step('E11 no console errors or exceptions in the whole scenario', async () => {
      assert(app.errors.length === 0, app.errors.join('\n'));
    });

    // ---- close flows: dirty + Cancel keeps the app, dirty + Don't save quits ----
    await step('E12 closing with unsaved changes asks first; "Cancel" keeps the app open, "Don\'t save" quits', async () => {
      fs.writeFileSync(MSGBOX_LOG + '.choice', '1');
      await app.click('#btn-add'); // test hook imports the fixture without a native dialog
      await app.waitFor('VE.state.S.segments.length === 1', 10000, 'import through the add button');
      assert(await app.evaluate('VE.state.S.dirty'), 'project should be dirty after adding a clip');
      const lines0 = fs.readFileSync(MSGBOX_LOG, 'utf8').split('\n').filter(Boolean).length;
      fs.writeFileSync(MSGBOX_LOG + '.choice', '2'); // Cancel
      closeMainWindow(app.child.pid);
      await sleep(2000);
      assert(app.exited() === null, 'app closed although the user chose Cancel');
      const lines1 = fs.readFileSync(MSGBOX_LOG, 'utf8').split('\n').filter(Boolean);
      assert(lines1.length > lines0, 'no confirmation dialog on close');
      assert(/Kaydedilmemiş değişiklikler|Unsaved changes/.test(lines1[lines1.length - 1]), 'wrong dialog: ' + lines1[lines1.length - 1]);
      assert((await app.evaluate('VE.state.S.segments.length')) === 1, 'project changed by the cancelled close');
      fs.writeFileSync(MSGBOX_LOG + '.choice', '1'); // Don't save
      closeMainWindow(app.child.pid);
      await waitUntil(() => app.exited() !== null, 8000, 'app exit');
    });
  } finally {
    await app.close();
  }

  // ---- relaunch: persisted language/theme restored ----
  const app2 = await launch({ userData, keepUserData: true, port: 9353, env });
  try {
    await step('E13 relaunch restores the last language and theme', async () => {
      await app2.waitFor("document.querySelector('#btn-export') !== null", 15000, 'ui');
      assert((await app2.evaluate('document.documentElement.lang')) === 'tr', 'language not restored');
      assert((await app2.evaluate("document.documentElement.getAttribute('data-theme')")) === 'light', 'theme not restored');
      await app2.screenshot(path.join(SHOTS, 'tr-light-restored.png'));
      assert(app2.errors.length === 0, app2.errors.join('\n'));
    });
  } finally {
    await app2.close();
  }

  process.exit(summary('UI scenario 2 (export, WYSIWYG, i18n/theme)') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
