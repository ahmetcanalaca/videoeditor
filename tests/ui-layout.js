'use strict';
// Layout verification at small / medium window sizes and high-DPI scaling, in both languages and both themes.
// The viewport is emulated through CDP (the real window keeps its size), so what is measured is the CSS layout.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, summary, ud, h } = require('./ui-helpers');

const SHOTS = path.join(OUT, 'shots');
const CAPTION_BUTTONS = 138; // width reserved by the native window controls (titleBarOverlay)

// [width, height, deviceScaleFactor]
const SIZES = [
  [1366, 700, 1], // 1366x768 laptop screen minus title bar / task bar
  [1100, 680, 1],
  [980, 640, 1], // the minimum window size of the app
  [1280, 680, 1.5], // 1920x1080 panel at 150 % scaling
];

(async () => {
  const fx = h.makeFixtures();
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = await launch({ userData: ud('layout'), files: [fx.A, fx.B], port: 9366 });
  const emulate = async (w, hh, dpr) => {
    await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: dpr, mobile: false });
    await sleep(500);
  };
  const metrics = () => app.evaluate(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const insp = document.querySelector('#inspector');
    return {
      vw: innerWidth, vh: innerHeight,
      scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
      exportBtn: r('#btn-export'), tbRight: r('.tb-right'), titleMid: r('.tb-title'), tbGroup: r('.tb-group'),
      canvas: r('#canvas'), transport: r('#transport'), timeline: r('#timeline-pane'), track: r('#tl-track'), tlToolbar: r('#tl-toolbar'),
      inspector: r('#inspector'), status: r('#statusbar'), preview: r('#preview-pane'),
      inspScroll: { sh: insp.scrollHeight, ch: insp.clientHeight },
      bars: [...document.querySelectorAll('#titlebar, #transport, #tl-toolbar, #statusbar')].map((e) => ({ id: e.id, sw: e.scrollWidth, cw: e.clientWidth })),
    };
  })()`);

  try {
    await app.waitFor("VE.state.S.segments.length === 2 && [...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)", 25000, 'import');
    await app.evaluate(`(() => {
      const S = VE.state.S; const M = VE.model;
      const A = [...S.media.values()].find((m) => m.name.startsWith('A_'));
      const B = [...S.media.values()].find((m) => m.name.startsWith('B_'));
      const s1 = M.createSegment(A, { in: 0, out: 4, zoomFrom: 1, zoomTo: 2, fx: 0.75, fy: 0.35 });
      const s2 = M.createSegment(A, { in: 4, out: 8, speed: 2, fadeOut: 0.4 });
      const s3 = M.createSegment(B, { in: 0, out: 5, zoomFrom: 2.2, zoomTo: 1, fx: 0.3, fy: 0.6 });
      VE.state.commit([s1, s2, s3], { selectedId: s1.id, playhead: 1.6 });
    })()`);
    await sleep(600);

    for (const [lang, theme] of [['tr', 'dark'], ['en', 'light']]) {
      const curLang = await app.evaluate('document.documentElement.lang');
      const curTheme = await app.evaluate("document.documentElement.getAttribute('data-theme')");
      if (curLang !== lang) await app.click(`#lang-switch button[data-lang="${lang}"]`);
      if (curTheme !== theme) await app.click('#btn-theme');
      await sleep(400);

      for (const [w, hh, dpr] of SIZES) {
        const tag = `${w}x${hh}${dpr !== 1 ? '@' + dpr : ''} ${lang}/${theme}`;
        await step(`L01 layout ${tag}: nothing overflows, clipped or collides with the window controls`, async () => {
          await emulate(w, hh, dpr);
          await app.evaluate("document.querySelector('#inspector').scrollTop = 0");
          const m = await metrics();
          assert(m.scrollW <= m.vw && m.scrollH <= m.vh, `page scrolls: scroll ${m.scrollW}x${m.scrollH} vs viewport ${m.vw}x${m.vh}`);
          m.bars.forEach((b) => assert(b.sw <= b.cw + 1, `${b.id} content is wider (${b.sw}) than its box (${b.cw})`));
          assert(m.exportBtn.r <= m.vw - CAPTION_BUTTONS + 4, `export button (right ${Math.round(m.exportBtn.r)}) runs under the window controls`);
          assert(m.tbRight.x >= m.tbGroup.r + 8, `title bar groups collide (${Math.round(m.tbGroup.r)} vs ${Math.round(m.tbRight.x)})`);
          assert(m.canvas.w >= 300 && m.canvas.h >= 168, `preview too small: ${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)}`);
          assert(m.canvas.b <= m.transport.y + 1 && m.canvas.r <= m.preview.r + 1, 'preview canvas leaves its pane');
          assert(m.track.b <= m.timeline.b, `timeline track (${Math.round(m.track.b)}) is cut off by its pane (${Math.round(m.timeline.b)})`);
          assert(m.status.b <= m.vh + 1, 'status bar is below the viewport');
          await app.screenshot(path.join(SHOTS, `layout-${w}x${hh}${dpr !== 1 ? '@' + dpr : ''}-${lang}-${theme}.png`));
          return `canvas ${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)}, inspector content ${m.inspScroll.sh}px in ${m.inspScroll.ch}px, title text ${Math.round(m.titleMid.w)}px`;
        });
      }

      await step(`L02 dialogs fit the smallest window (980x640) ${lang}/${theme}; closing them with Escape keeps the selected clip`, async () => {
        await emulate(980, 640, 1);
        const selBefore = await app.evaluate('VE.state.S.selectedId');
        assert(selBefore, 'a clip should be selected before opening dialogs');
        for (const [btn, label] of [['#btn-export', 'export'], ['#btn-about', 'about']]) {
          await app.click(btn);
          await app.waitFor("!!document.querySelector('#modal-root .modal')", 4000, label + ' dialog');
          await sleep(250);
          const b = await app.evaluate("(() => { const r = document.querySelector('#modal-root .modal').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight }; })()");
          assert(b.x >= 0 && b.y >= 0 && b.r <= b.vw && b.b <= b.vh, `${label} dialog leaves the viewport: ${JSON.stringify(b)}`);
          await app.screenshot(path.join(SHOTS, `layout-980x640-${lang}-${theme}-${label}.png`));
          await app.key('Escape');
          await sleep(200);
          assert(!(await app.evaluate("!!document.querySelector('#modal-root .modal')")), `${label} dialog did not close with Escape`);
        }
        assert((await app.evaluate('VE.state.S.selectedId')) === selBefore, 'Escape that closed a dialog also cleared the clip selection');
      });
    }

    await step('L03 empty state at the smallest size', async () => {
      await emulate(980, 640, 1);
      await app.evaluate('VE.state.commit([], { selectedId: null })');
      await sleep(500);
      const m = await metrics();
      assert(m.scrollW <= m.vw && m.scrollH <= m.vh, 'page scrolls in the empty state');
      assert(!(await app.evaluate("document.querySelector('#empty-state').hidden")), 'empty state hidden');
      await app.screenshot(path.join(SHOTS, 'layout-980x640-empty.png'));
    });

    await step('L04 no console errors', async () => { assert(app.errors.length === 0, app.errors.join('\n')); });
    await app.cdp.send('Emulation.clearDeviceMetricsOverride');
  } finally {
    await app.close();
  }
  process.exit(summary('Layout at small sizes / high DPI') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
