'use strict';
// UI scenario 3: AVI preview proxy, rotated phone video, Turkish file names, broken/missing files, drag & drop, project save/open.
const fs = require('fs');
const path = require('path');
const { launch, sleep, waitUntil } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, pngGray, pngSize, h } = require('./ui-helpers');
const { spawnSync } = require('child_process');

const SHOTS = path.join(OUT, 'shots');
const MSGBOX_LOG = path.join(OUT, 'msgbox-misc.log');
const PROJ_DIR = path.join(OUT, 'Proje Klasörü');
const PROJ = path.join(PROJ_DIR, 'deneme projesi şğı.vedproj');

const logLines = () => (fs.existsSync(MSGBOX_LOG) ? fs.readFileSync(MSGBOX_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

(async () => {
  const fx = h.makeFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.rmSync(MSGBOX_LOG, { force: true });
  fs.writeFileSync(MSGBOX_LOG + '.choice', '1');
  const broken = path.join(OUT, 'bozuk dosya.mp4');
  fs.writeFileSync(broken, 'this is not a video');
  const missing = path.join(OUT, 'olmayan klasör', 'yok.mp4');

  const env = {
    VE_TEST_MSGBOX_LOG: MSGBOX_LOG,
    VE_TEST_PROJECT_PATH: PROJ,
    VE_TEST_OPEN_PATHS: [fx.D, fx.C, fx.E, broken, missing].join('|'),
  };
  const app = await launch({ userData: ud('misc'), port: 9354, env });
  const segs = () => app.evaluate('VE.state.S.segments.map((s) => ({ id: s.id, mediaId: s.mediaId, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy }))');
  const settle = async () => {
    await app.waitFor('(() => { const d = VE.player.debug(); const a = d.decks[d.active]; return !d.busy && a.readyState >= 2 && !a.seeking; })()', 15000, 'player settled');
    await sleep(200);
  };
  const seek = async (t) => { await app.evaluate(`VE.actions.seek(${t})`); await sleep(100); await settle(); };

  try {
    await app.waitFor("document.querySelector('#btn-add') !== null", 15000, 'ui');

    await step('M01 add videos: 3 import, broken + missing files are reported in one dialog', async () => {
      await app.click('#btn-add');
      await app.waitFor('VE.state.S.segments.length === 3', 20000, '3 segments');
      await sleep(500);
      const lines = logLines();
      const rep = lines.find((l) => /Dosyalar eklenemedi/.test(l.message || ''));
      assert(rep, 'failure report dialog missing: ' + JSON.stringify(lines));
      assert(/bozuk dosya\.mp4/.test(rep.detail) && /yok\.mp4/.test(rep.detail), 'detail lacks file names: ' + rep.detail);
      assert(/okunamadı|bulunamadı/.test(rep.detail), 'detail lacks reasons');
      return rep.detail.replace(/\n/g, ' | ');
    });

    await step('M02 AVI (not playable by Chromium) gets a preview proxy and plays', async () => {
      const dId = await app.evaluate("[...VE.state.S.media.values()].find((m) => m.name.endsWith('.avi')).id");
      const m = await app.evaluate(`(() => { const m = VE.state.S.media.get('${dId}'); return { needsProxy: m.needsProxy, state: m.proxyState, reason: m.proxyReason }; })()`);
      assert(m.needsProxy && m.reason === 'container', 'AVI should require a proxy: ' + JSON.stringify(m));
      await app.waitFor(`VE.state.S.media.get('${dId}').proxyState === 'ready'`, 30000, 'proxy ready');
      await seek(1.0);
      const d = await app.evaluate('VE.player.debug()');
      const a = d.decks[d.active];
      assert(a.mediaId === dId && a.readyState >= 2 && a.w === 480 && a.h === 270, 'deck: ' + JSON.stringify(a));
      const r = await app.rect('#canvas');
      const png = path.join(SHOTS, 'misc-avi-proxy.png');
      await app.screenshot(png, { x: r.x, y: r.y, width: r.w, height: r.h });
      const g = pngGray(png, 160, 90);
      let sum = 0; for (const v of g) sum += v;
      assert(sum / g.length > 25, 'preview of the AVI is black (mean luma ' + (sum / g.length).toFixed(1) + ')');
      return `proxy ready, deck ${a.w}x${a.h}`;
    });

    await step('M03 phone video with rotation metadata: portrait, upright, letterboxed on the landscape canvas', async () => {
      const lay = await app.evaluate('VE.state.layout().items.map((i) => ({ start: i.start, dur: i.dur, name: VE.state.S.media.get(i.seg.mediaId).name }))');
      const c = lay.find((i) => i.name.startsWith('C_rotated'));
      await seek(c.start + 1.0);
      const d = await app.evaluate('VE.player.debug()');
      const a = d.decks[d.active];
      assert(a.readyState >= 2, 'deck not ready');
      const box = await app.evaluate("(() => { const b = document.querySelector('.deck.active .vbox'); return { w: b.clientWidth, h: b.clientHeight }; })()");
      assert(box.h > box.w * 1.5, `video box is not portrait: ${box.w}x${box.h}`);
      const r = await app.rect('#canvas');
      const png = path.join(SHOTS, 'misc-rotated.png');
      await app.screenshot(png, { x: r.x, y: r.y, width: r.w, height: r.h });
      const sz = pngSize(png);
      const g = pngGray(png, sz.w, sz.h);
      // the source's vertical bar must appear as a HORIZONTAL band after rotation
      let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1;
      for (let y = 0; y < sz.h; y++) for (let x = 0; x < sz.w; x++) if (g[y * sz.w + x] >= 228) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      assert(maxX > 0, 'no bright band found');
      assert((maxX - minX + 1) > 2.5 * (maxY - minY + 1), `band is not horizontal: ${maxX - minX + 1}x${maxY - minY + 1}`);
      // and the black side bars are really black (pillarbox)
      let side = 0; const sx = Math.floor(sz.w * 0.12); const y0 = Math.floor(sz.h * 0.1); const y1 = Math.floor(sz.h * 0.9);
      for (let y = y0; y < y1; y++) for (let x = 0; x < sx; x++) side += g[y * sz.w + x];
      const sideMean = side / ((y1 - y0) * sx);
      assert(sideMean < 40, 'side bars are not dark: ' + sideMean);
      return `box ${box.w}x${box.h}, band ${maxX - minX + 1}x${maxY - minY + 1} px of ${sz.w}x${sz.h}`;
    });

    await step('M04 Turkish file name shown in the inspector', async () => {
      const list = await segs();
      const e = await app.evaluate("[...VE.state.S.media.values()].find((m) => m.name.includes('şğıİ')).id");
      const seg = list.find((s) => s.mediaId === e);
      await app.evaluate(`VE.actions.select('${seg.id}')`);
      await sleep(200);
      assert((await app.evaluate("document.querySelector('#clip-name').textContent")) === 'örnek_şğıİ video.mp4', 'name');
      await app.screenshot(path.join(SHOTS, 'misc-turkish-name.png'));
    });

    await step('M05 drag & drop of a file onto the window adds it (webUtils.getPathForFile); a REAL drop is reported to main (approved path), a drop fired by a script is not', async () => {
      const before = (await segs()).length;
      const r = await app.rect('#preview-pane');
      const a0 = (await app.evaluate('window.api.info()')).approvals;
      // a drop event made by a script in the page is not trusted: nothing is approved
      await app.evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'fake.mp4', { type: 'video/mp4' })); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
      await sleep(300);
      assert((await app.evaluate('window.api.info()')).approvals === a0, 'a script-made drop was approved');
      assert((await segs()).length === before, 'a script-made drop imported something');
      await app.dropFiles([fx.B], r.x + r.w / 2, r.y + r.h / 2);
      await app.waitFor(`VE.state.S.segments.length === ${before + 1}`, 15000, 'segment from drop');
      assert((await app.evaluate('window.api.info()')).approvals === a0 + 1, 'the real drop was not reported to main (approvals ' + a0 + ' -> ' + (await app.evaluate('window.api.info()')).approvals + ')');
      const last = (await segs()).pop();
      const name = await app.evaluate(`VE.state.S.media.get('${last.mediaId}').name`);
      assert(name.startsWith('B_silent'), 'wrong file: ' + name);
      assert(!(await app.evaluate("document.querySelector('#drop-overlay').classList.contains('show')")), 'drop overlay stuck');
    });

    await step('M06 save project (Ctrl+S) writes a readable .vedproj in a Turkish-named folder', async () => {
      await app.evaluate(`(() => { const s = VE.state.S.segments[0]; VE.actions.updateSegment(s.id, { speed: 2, zoomFrom: 1, zoomTo: 1.8, fx: 0.3, fy: 0.6 }, {}); })()`);
      await sleep(200);
      await app.evaluate("VE.state.S.exportSettings.aspect = '16:9'");
      await app.key('s', { ctrl: true });
      await app.waitFor('!VE.state.S.dirty', 8000, 'saved');
      assert(fs.existsSync(PROJ), 'project file missing');
      const doc = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
      assert(doc.app === 'VideoEditor' && doc.version === 1 && doc.segments.length === 4 && doc.media.length === 4, 'doc: ' + JSON.stringify({ s: doc.segments.length, m: doc.media.length }));
      assert(doc.media.every((m) => fs.existsSync(m.path)), 'media paths are not absolute/existing');
      assert(doc.settings.aspect === '16:9', 'export settings missing in project');
      const title = await app.evaluate("document.querySelector('#project-name').textContent");
      assert(title === 'deneme projesi şğı', 'title: ' + title);
      return `${doc.segments.length} segments, ${doc.media.length} media`;
    });

    await step('M06b dropping a project file onto the window opens it (a real drop is what approves the path for main; a path the page invents is not opened - see ui-safety S10)', async () => {
      const idsBefore = await app.evaluate('[...VE.state.S.media.keys()]');
      const r = await app.rect('#preview-pane');
      const a0 = (await app.evaluate('window.api.info()')).approvals;
      await app.dropFiles([PROJ], r.x + r.w / 2, r.y + r.h / 2);
      await app.waitFor(`(() => { const ids = [...VE.state.S.media.keys()]; return VE.state.S.segments.length === 4 && ids.length > 0 && ids.every((i) => !${JSON.stringify(idsBefore)}.includes(i)); })()`, 25000, 'project reopened by the drop');
      assert((await app.evaluate('window.api.info()')).approvals === a0 + 1, 'the dropped project was not reported to main');
      assert((await app.evaluate("document.querySelector('#project-name').textContent")) === 'deneme projesi şğı', 'title');
      assert(!(await app.evaluate('VE.state.S.dirty')), 'a freshly opened project is dirty');
    });

    await step('M07 no console errors in scenario 3 so far', async () => {
      assert(app.errors.length === 0, app.errors.join('\n'));
    });
  } finally {
    await app.close();
  }

  // ---- reopen the project through the command line (file association style) ----
  const doc0 = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
  const app2 = await launch({ userData: ud('misc2'), port: 9355, files: [PROJ], env: { VE_TEST_MSGBOX_LOG: MSGBOX_LOG } });
  try {
    await step('M08 opening the project restores clips, edits, export settings and title', async () => {
      await app2.waitFor('VE.state.S.segments.length === 4', 25000, 'project restored');
      const list = await app2.evaluate('VE.state.S.segments.map((s) => ({ in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy, name: VE.state.S.media.get(s.mediaId).name }))');
      doc0.segments.forEach((s, i) => {
        near(list[i].in, s.in, 1e-9, `seg ${i} in`);
        near(list[i].out, s.out, 1e-6, `seg ${i} out`);
        near(list[i].speed, s.speed, 1e-9, `seg ${i} speed`);
        near(list[i].zoomTo, s.zoomTo, 1e-9, `seg ${i} zoomTo`);
        near(list[i].fx, s.fx, 1e-9, `seg ${i} fx`);
        assert(list[i].name === doc0.media.find((m) => m.id === s.mediaId).name, `seg ${i} media`);
      });
      assert((await app2.evaluate('VE.state.S.exportSettings.aspect')) === '16:9', 'aspect not restored');
      assert(!(await app2.evaluate('VE.state.S.dirty')), 'restored project is dirty');
      assert((await app2.evaluate("document.querySelector('#project-name').textContent")) === 'deneme projesi şğı', 'title');
      await app2.waitFor('[...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)', 25000, 'thumbnails of the restored project');
      await app2.screenshot(path.join(SHOTS, 'misc-project-restored.png'));
    });
    await step('M09 no console errors after opening a project', async () => {
      assert(app2.errors.length === 0, app2.errors.join('\n'));
    });
  } finally {
    await app2.close();
  }

  // ---- project that references a missing file + a corrupt project file ----
  const doc1 = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
  const goneId = doc1.media[0].id;
  doc1.media[0].path = path.join(PROJ_DIR, 'kayıp video.mp4');
  const proj2 = path.join(PROJ_DIR, 'eksik medya.vedproj');
  fs.writeFileSync(proj2, JSON.stringify(doc1));
  const proj3 = path.join(PROJ_DIR, 'bozuk proje.vedproj');
  fs.writeFileSync(proj3, '{ not json');

  const before = logLines().length;
  const app3 = await launch({ userData: ud('misc3'), port: 9356, files: [proj2], env: { VE_TEST_MSGBOX_LOG: MSGBOX_LOG } });
  try {
    await step('M10 project with a missing media file opens, drops the dead clips and tells the user which file', async () => {
      await app3.waitFor('VE.state.S.segments.length > 0', 25000, 'partial project');
      const expected = doc1.segments.filter((s) => s.mediaId !== goneId).length;
      assert((await app3.evaluate('VE.state.S.segments.length')) === expected, `segments ${await app3.evaluate('VE.state.S.segments.length')} != ${expected}`);
      await sleep(600);
      const lines = logLines().slice(before);
      const dlg = lines.find((l) => /bulunamadı/.test(l.message || ''));
      assert(dlg && /kayıp video\.mp4/.test(dlg.detail), 'missing-file dialog: ' + JSON.stringify(lines));
    });
    await step('M11 opening a corrupt project file shows an error and keeps the app usable', async () => {
      const n0 = logLines().length;
      // open through the second-instance path (same as double-clicking another project while the app runs)
      const child = require('child_process').spawn(require(path.join(__dirname, '..', 'node_modules', 'electron')), [path.join(__dirname, '..'), '--user-data-dir=' + ud('misc3'), proj3], { env: Object.assign({}, process.env, { VE_TEST_MODE: '1', VE_TEST_MSGBOX_LOG: MSGBOX_LOG }), stdio: 'ignore' });
      await waitUntil(() => logLines().length > n0, 15000, 'invalid project dialog');
      const dlg = logLines().slice(n0).find((l) => /geçersiz|bozuk/.test(l.message || ''));
      assert(dlg, 'no invalid-project dialog: ' + JSON.stringify(logLines().slice(n0)));
      assert((await app3.evaluate('document.querySelectorAll(".seg").length')) > 0, 'existing project was lost');
      try { child.kill(); } catch (e) { /* ignore */ }
    });
  } finally {
    await app3.close();
  }

  // ---- project that references a network (UNC) path: never opened automatically, the user is told ----
  const doc4 = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
  const blockedId = doc4.media[0].id;
  const UNC_PATH = '\\\\127.0.0.1\\ve_blocked_share\\uzak video.mp4';
  doc4.media[0].path = UNC_PATH;
  const proj4 = path.join(PROJ_DIR, 'ag yolu.vedproj');
  fs.writeFileSync(proj4, JSON.stringify(doc4));
  const before4 = logLines().length;
  const app4 = await launch({ userData: ud('misc4'), port: 9357, files: [proj4], env: { VE_TEST_MSGBOX_LOG: MSGBOX_LOG } });
  try {
    await step('M12 a project whose media is a network path (\\\\server\\share) does not open it, drops those clips and explains why', async () => {
      await app4.waitFor('VE.state.S.segments.length > 0', 25000, 'partial project');
      const expected = doc4.segments.filter((s) => s.mediaId !== blockedId).length;
      assert((await app4.evaluate('VE.state.S.segments.length')) === expected, `segments ${await app4.evaluate('VE.state.S.segments.length')} != ${expected}`);
      assert((await app4.evaluate('[...VE.state.S.media.values()].every((m) => !/^\\\\\\\\/.test(m.path || ""))')), 'a network media was registered');
      await sleep(600);
      const lines = logLines().slice(before4);
      const dlg = lines.find((l) => /güvenlik/i.test(l.message || ''));
      assert(dlg && dlg.detail.includes('ve_blocked_share'), 'blocked-path dialog: ' + JSON.stringify(lines));
      assert(!lines.some((l) => /bulunamadı/.test(l.message || '')), 'the blocked path was reported as a missing file');
      assert(app4.errors.length === 0, app4.errors.join('\n'));
    });
  } finally {
    await app4.close();
  }

  process.exit(summary('UI scenario 3 (proxy, rotation, files, DnD, projects)') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
