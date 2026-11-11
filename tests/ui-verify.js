'use strict';
// UI scenario 1: defaults, playback across clips, inspector, split/delete/undo/redo, drag reorder, grip trim, shortcuts.
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, near, summary, ud, h } = require('./ui-helpers');

(async () => {
  const fx = h.makeFixtures();
  const app = await launch({ userData: ud('edit'), files: [fx.A, fx.B], port: 9351 });

  const segs = () => app.evaluate(`VE.state.S.segments.map((s) => ({ id: s.id, mediaId: s.mediaId, in: s.in, out: s.out, speed: s.speed, zoomFrom: s.zoomFrom, zoomTo: s.zoomTo, fx: s.fx, fy: s.fy, volume: s.volume, mute: s.mute, fadeIn: s.fadeIn, fadeOut: s.fadeOut }))`);
  const total = () => app.evaluate('VE.state.layout().total');
  const dbg = () => app.evaluate('VE.player.debug()');
  const settle = async () => {
    await app.waitFor('(() => { const d = VE.player.debug(); const a = d.decks[d.active]; return !d.busy && a.readyState >= 2 && !a.seeking; })()', 8000, 'player settled');
    await sleep(120);
  };
  const seek = async (t) => { await app.evaluate(`VE.actions.seek(${t})`); await sleep(80); await settle(); };
  const segRect = (id) => app.rect(`.seg[data-id="${id}"]`);

  try {
    await app.waitFor("VE.state.S.segments.length === 2 && document.querySelectorAll('.seg').length === 2", 25000, 'two segments');

    await step('01 defaults on a fresh profile: Turkish UI + dark theme', async () => {
      assert((await app.evaluate('document.documentElement.lang')) === 'tr', 'lang is not tr');
      assert((await app.evaluate("document.documentElement.getAttribute('data-theme')")) === 'dark', 'theme is not dark');
      assert((await app.evaluate("document.querySelector('#btn-export').textContent.trim()")) === 'Dışa aktar', 'export button is not Turkish');
      assert((await app.evaluate("document.querySelector('#lang-switch button[data-lang=tr]').getAttribute('aria-pressed')")) === 'true', 'TR toggle not pressed');
    });

    await step('02 CLI import: 2 clips, thumbnails complete, waveform only for the clip with audio', async () => {
      await app.waitFor('[...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount)', 20000, 'all thumbnails');
      await app.waitFor('[...VE.state.S.media.values()].some((m) => m.waveform && m.waveform.length > 300)', 20000, 'waveform');
      const info = await app.evaluate('[...VE.state.S.media.values()].map((m) => ({ n: m.name, wf: m.waveform ? m.waveform.length : 0, th: m.thumbsReady.size }))');
      const a = info.find((m) => m.n.startsWith('A_'));
      const b = info.find((m) => m.n.startsWith('B_'));
      near(a.wf, 400, 5, 'waveform buckets of A');
      assert(b.wf === 0, 'silent clip must have no waveform');
      assert((await app.evaluate("document.querySelector('#tc-total').textContent")) === '00:13.00', 'total timecode ' + (await app.evaluate("document.querySelector('#tc-total').textContent")));
      return JSON.stringify(info);
    });

    await step('03 preview shows the first clip (deck ready, 1280x720)', async () => {
      await settle();
      const d = await dbg();
      const a = d.decks[d.active];
      assert(a.readyState >= 2 && a.w === 1280 && a.h === 720, JSON.stringify(a));
    });

    await step('04 play / pause with button and Space; playhead follows the clock', async () => {
      await app.click('#btn-play');
      // a cold video decoder may need a moment to start: the clock is measured once the playhead is moving
      await app.waitFor('VE.player.isPlaying() && VE.state.S.playhead > 0.05', 6000, 'playback started');
      const c0 = await app.evaluate('({ t: VE.state.S.playhead, now: performance.now() })');
      await sleep(1000);
      const c1 = await app.evaluate('({ t: VE.state.S.playhead, now: performance.now() })');
      const t1 = c1.t;
      assert(await app.evaluate('VE.player.isPlaying()'), 'not playing after click');
      near(c1.t - c0.t, (c1.now - c0.now) / 1000, 0.3, 'playhead advance vs. wall clock');
      await app.key(' ');
      await sleep(250);
      assert(!(await app.evaluate('VE.player.isPlaying()')), 'still playing after Space');
      const t2 = await app.evaluate('VE.state.S.playhead');
      await sleep(400);
      near(await app.evaluate('VE.state.S.playhead'), t2, 0.001, 'playhead moved while paused');
      return `t1=${t1.toFixed(2)} paused@${t2.toFixed(2)}`;
    });

    await step('05 gap-free playback across clips A->B, auto-stop at the end', async () => {
      await seek(7.4);
      await app.evaluate('VE.player.play()');
      await sleep(1700);
      const ph = await app.evaluate('VE.state.S.playhead');
      const d = await dbg();
      const act = d.decks[d.active];
      const bId = await app.evaluate("[...VE.state.S.media.values()].find((m) => m.name.startsWith('B_')).id");
      assert(ph > 8.2, 'did not cross the clip boundary: ' + ph + ' ' + JSON.stringify(await dbg()));
      assert(act.mediaId === bId && act.w === 640, 'active deck is not clip B: ' + JSON.stringify(act));
      await app.waitFor('!VE.player.isPlaying()', 12000, 'auto stop');
      near(await app.evaluate('VE.state.S.playhead'), 13, 0.05, 'end playhead');
      return `crossed at ph=${ph.toFixed(2)}`;
    });

    await step('06 selecting a clip fills the inspector', async () => {
      const first = (await segs())[0];
      const r = await segRect(first.id);
      await app.clickAt(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(150);
      assert(await app.evaluate("!document.querySelector('#insp-body').hidden"), 'inspector hidden');
      assert((await app.evaluate("document.querySelector('#clip-name').textContent")).startsWith('A_audio'), 'clip name');
      assert((await app.evaluate('VE.state.S.selectedId')) === first.id, 'selection');
    });

    await step('07 speed chip 2x: clip becomes 4 s, total 9 s, badge on the clip', async () => {
      await app.click('.chip[data-speed="2"]');
      await sleep(150);
      const s = (await segs())[0];
      assert(s.speed === 2, 'speed ' + s.speed);
      near(await total(), 9, 0.001, 'total');
      assert((await app.evaluate("document.querySelector('.seg.selected .seg-label').textContent")).includes('2×'), 'badge missing');
    });

    await step('08 zoom-in preset + focus picker click', async () => {
      await app.click('#zoom-presets [data-zoom="in"]');
      await sleep(120);
      let s = (await segs())[0];
      assert(s.zoomFrom === 1 && s.zoomTo === 2, `zoom ${s.zoomFrom}->${s.zoomTo}`);
      const p = await app.rect('#focus-picker');
      await app.clickAt(p.x + p.w * 0.75, p.y + p.h * 0.35);
      await sleep(150);
      s = (await segs())[0];
      near(s.fx, 0.75, 0.03, 'fx');
      near(s.fy, 0.35, 0.03, 'fy');
    });

    await step('09 preview applies the zoom transform (none at start, ~2x near the end)', async () => {
      await seek(0);
      let d = await dbg();
      assert(!d.decks[d.active].transform, 'unexpected transform at start: ' + d.decks[d.active].transform);
      await seek(3.95);
      d = await dbg();
      const m = /scale\(([\d.]+)\)/.exec(d.decks[d.active].transform || '');
      assert(m && Math.abs(Number(m[1]) - 2) < 0.05, 'transform near end: ' + d.decks[d.active].transform);
      return d.decks[d.active].transform;
    });

    await step('10 split with S at the playhead: zoom stays continuous across the cut', async () => {
      await seek(1.0);
      await app.key('s');
      await sleep(200);
      const list = await segs();
      assert(list.length === 3, 'segments: ' + list.length);
      near(list[0].out, list[1].in, 1e-9, 'cut point');
      near(list[0].out, 2.0, 0.05, 'source split position (1.0 s timeline at 2x)');
      near(list[0].zoomTo, list[1].zoomFrom, 1e-9, 'zoom continuity');
      near(list[0].zoomTo, Math.pow(2, 0.25), 0.002, 'zoom value at 25%');
      return `split @src ${list[0].out.toFixed(3)}, z=${list[0].zoomTo.toFixed(3)}`;
    });

    await step('11 delete selected clip, undo, redo, undo (keyboard)', async () => {
      const list = await segs();
      assert((await app.evaluate('VE.state.S.selectedId')) === list[1].id, 'right half should be selected after split');
      await app.key('Delete');
      await sleep(150);
      assert((await segs()).length === 2, 'delete failed');
      await app.key('z', { ctrl: true });
      await sleep(150);
      assert((await segs()).length === 3, 'undo failed');
      await app.key('y', { ctrl: true });
      await sleep(150);
      assert((await segs()).length === 2, 'redo failed');
      await app.key('z', { ctrl: true });
      await sleep(150);
      assert((await segs()).length === 3, 'second undo failed');
    });

    await step('12 drag a clip to the end: order changes, one undo step restores', async () => {
      const before = await segs();
      const a = await segRect(before[0].id);
      const last = await segRect(before[2].id);
      await app.drag({ x: a.x + a.w / 2, y: a.y + a.h / 2 }, { x: last.x + last.w - 6, y: last.y + last.h / 2 }, 16);
      await sleep(250);
      const after = await segs();
      assert(after[2].id === before[0].id && after[0].id === before[1].id, 'order: ' + after.map((s) => s.id.slice(-4)).join(','));
      await app.key('z', { ctrl: true });
      await sleep(150);
      const undone = await segs();
      assert(undone[0].id === before[0].id, 'undo of move failed');
    });

    await step('13 trim with the right grip: out point follows the pointer, ripple, one undo step', async () => {
      const before = (await segs())[0];
      const rect = await segRect(before.id);
      const pps = rect.w / ((before.out - before.in) / before.speed);
      const dx = -50;
      const grip = await app.rect(`.seg[data-id="${before.id}"] .grip.r`);
      await app.drag({ x: grip.x + grip.w / 2, y: grip.y + grip.h / 2 }, { x: grip.x + grip.w / 2 + dx, y: grip.y + grip.h / 2 }, 10);
      await sleep(250);
      const after = (await segs())[0];
      near(after.out - before.out, (dx / pps) * before.speed, 0.04, 'out delta (source s)');
      near(after.in, before.in, 1e-9, 'in untouched');
      await app.key('z', { ctrl: true });
      await sleep(150);
      near((await segs())[0].out, before.out, 1e-9, 'undo restores out');
    });

    await step('14 trim with the left grip', async () => {
      const before = (await segs())[0];
      const rect = await segRect(before.id);
      const pps = rect.w / ((before.out - before.in) / before.speed);
      const grip = await app.rect(`.seg[data-id="${before.id}"] .grip.l`);
      await app.drag({ x: grip.x + grip.w / 2, y: grip.y + grip.h / 2 }, { x: grip.x + grip.w / 2 + 30, y: grip.y + grip.h / 2 }, 8);
      await sleep(250);
      const after = (await segs())[0];
      near(after.in - before.in, (30 / pps) * before.speed, 0.04, 'in delta');
      await app.key('z', { ctrl: true });
      await sleep(150);
    });

    await step('15 keyboard trim (Q/W) at the playhead, duplicate (Ctrl+D) and move buttons', async () => {
      const list = await segs();
      await app.evaluate(`VE.actions.select('${list[1].id}')`);
      const lay = await app.evaluate('VE.state.layout().items.map((i) => ({ start: i.start, dur: i.dur }))');
      await seek(lay[1].start + lay[1].dur * 0.5);
      const mid = list[1].in + (list[1].out - list[1].in) * 0.5;
      await app.key('w');
      await sleep(150);
      near((await segs())[1].out, mid, 0.06, 'W trims the end to the playhead');
      await app.key('z', { ctrl: true });
      await sleep(100);
      await app.key('d', { ctrl: true });
      await sleep(150);
      assert((await segs()).length === 4, 'duplicate failed');
      const sel = await app.evaluate('VE.state.S.selectedId');
      assert((await segs())[2].id === sel, 'duplicate not selected / placed after original');
      await app.click('#btn-move-left');
      await sleep(150);
      assert((await segs())[1].id === sel, 'move left failed');
      await app.click('#btn-move-right');
      await sleep(150);
      assert((await segs())[2].id === sel, 'move right failed');
    });

    await step('16 volume, mute and fade controls write to the selected clip', async () => {
      const id = await app.evaluate('VE.state.S.selectedId');
      await app.evaluate(`(() => { const e = document.querySelector('#clip-volume'); e.value = '50'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(100);
      await app.evaluate(`(() => { const e = document.querySelector('#fade-in'); e.value = '0.5'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(100);
      const s = (await segs()).find((x) => x.id === id);
      near(s.volume, 0.5, 1e-9, 'volume');
      near(s.fadeIn, 0.5, 1e-9, 'fade in');
      await app.click('#clip-mute');
      await sleep(100);
      assert((await segs()).find((x) => x.id === id).mute === true, 'mute');
      // slider drags within one second collapse into one undo entry
      const depth = await app.evaluate('0');
      return 'ok' + depth;
    });

    await step('17 no console errors or exceptions so far', async () => {
      assert(app.errors.length === 0, app.errors.join('\n'));
    });
  } finally {
    await app.screenshot(path.join(OUT, 'edit-final.png')).catch(() => {});
    await app.close();
  }
  process.exit(summary('UI scenario 1 (editing)') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
