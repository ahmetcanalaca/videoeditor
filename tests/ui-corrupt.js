'use strict';
// Resilience test: a damaged video (bytes overwritten in the middle of the media data) must not hang or crash the app.
// Expected: the preview either plays through the damage or recovers (reload, then proxy); export still works.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, summary, ud, h } = require('./ui-helpers');

(async () => {
  const fx = h.makeFixtures();
  const damaged = path.join(h.FIX, 'G_damaged.mp4');
  const src = fs.readFileSync(fx.A);
  const buf = Buffer.from(src);
  const start = Math.floor(buf.length * 0.35);
  for (let i = 0; i < 60000 && start + i < buf.length - 4096; i++) buf[start + i] = (i * 131 + 17) & 0xff;
  fs.writeFileSync(damaged, buf);

  const app = await launch({ userData: ud('corrupt'), files: [damaged], port: 9362, env: { VE_TEST_EXPORT_PATH: path.join(OUT, 'damaged-export.mp4') } });
  try {
    await app.waitFor('VE.state.S.segments.length === 1', 20000, 'import damaged file');

    await step('G01 damaged file imports (ffprobe reads the intact header) and the first frame shows', async () => {
      await sleep(1200);
      const d = await app.evaluate('VE.player.debug()');
      assert(d.decks[d.active].mediaId, 'no media on the active deck');
    });

    await step('G02 playing through the damaged region never hangs: it finishes, or recovers (reload, then proxy + auto-resume)', async () => {
      await app.evaluate('VE.actions.seek(0)');
      await sleep(400);
      await app.evaluate('VE.player.play()');
      const t0 = Date.now();
      const trace = [];
      let lastPh = -1; let lastMove = Date.now();
      let finished = false;
      while (Date.now() - t0 < 60000) {
        await sleep(300);
        const s = await app.evaluate("({ ph: VE.state.S.playhead, playing: VE.player.isPlaying(), proxy: [...VE.state.S.media.values()][0].proxyState, err: VE.player.debug().decks.map((d) => d.error).join('|'), badge: document.querySelector('#proxy-badge').hidden ? '' : document.querySelector('#proxy-badge').textContent })");
        trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ph=${s.ph.toFixed(2)} playing=${s.playing} proxy=${s.proxy} err=${s.err} ${s.badge}`);
        if (Math.abs(s.ph - lastPh) > 0.001) { lastPh = s.ph; lastMove = Date.now(); }
        if (s.ph > 7.9 && !s.playing) { finished = true; break; }
        // frozen while "playing" (and no proxy is being built) is the failure we guard against
        if (s.playing) assert(Date.now() - lastMove < 10000, 'playback froze while still "playing":\n' + trace.slice(-8).join('\n'));
        if (!s.playing && s.proxy !== 'building') assert(Date.now() - lastMove < 6000, 'paused by an error without recovery:\n' + trace.slice(-8).join('\n'));
      }
      const s = await app.evaluate("({ ph: VE.state.S.playhead, playing: VE.player.isPlaying(), proxy: [...VE.state.S.media.values()][0].proxyState })");
      console.log('      trace (last 8):\n      ' + trace.slice(-8).join('\n      '));
      if (s.playing) await app.evaluate('VE.player.pause()');
      assert(finished, `did not reach the end: ph=${s.ph} proxy=${s.proxy}`);
      return `reached the end (proxy=${s.proxy})`;
    });

    await step('G03 after recovery the user can continue: seek + play works', async () => {
      await app.waitFor("(() => { const m = [...VE.state.S.media.values()][0]; return m.proxyState !== 'building'; })()", 40000, 'proxy finished (if any)');
      await app.evaluate('VE.actions.seek(0.5)');
      await sleep(600);
      await app.evaluate('VE.player.play()');
      await sleep(1200);
      const ph = await app.evaluate('VE.state.S.playhead');
      await app.evaluate('VE.player.pause()');
      assert(ph > 0.9, 'playhead did not advance: ' + ph);
    });

    await step('G04 exporting the damaged clip does not hang and reports a result (success or readable error)', async () => {
      await app.click('#btn-export');
      await app.waitFor("!!document.querySelector('#modal-root .path-row')", 5000, 'modal');
      await app.click('#modal-root .path-row .btn');
      await sleep(200);
      await app.evaluate("document.querySelector('#modal-root .btn.primary').click()");
      await app.waitFor("!!document.querySelector('#modal-root .result')", 60000, 'export result');
      const txt = await app.evaluate("document.querySelector('#modal-root .result').textContent");
      return txt.replace(/\s+/g, ' ').slice(0, 140);
    });

    await step('G05 no uncaught exceptions', async () => {
      const bad = app.errors.filter((e) => /exception/.test(e));
      assert(bad.length === 0, bad.join('\n'));
    });
  } finally {
    await app.close();
  }
  process.exit(summary('Resilience (damaged media)') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
