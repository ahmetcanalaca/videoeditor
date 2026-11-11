'use strict';
// Stress test for the preview player: repeatedly play across a clip boundary to the end of the timeline and report stalls.
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const h = require('./helpers');

(async () => {
  const fx = h.makeFixtures();
  const out = path.join(__dirname, 'out', 'ui');
  const app = await launch({ userData: path.join(out, 'ud-stress'), files: [fx.A, fx.B], port: 9361 });
  const rounds = Number(process.argv[2] || 6);
  let stalls = 0;
  try {
    await app.waitFor('VE.state.S.segments.length === 2', 20000, 'import');
    await sleep(1500);
    for (let i = 0; i < rounds; i++) {
      await app.evaluate('VE.actions.seek(7.4)');
      await sleep(400);
      await app.evaluate('VE.player.play()');
      const t0 = Date.now();
      const trace = [];
      let stopped = false;
      while (Date.now() - t0 < 12000) {
        await sleep(250);
        const d = await app.evaluate('({ ph: VE.state.S.playhead, d: VE.player.debug() })');
        const a = d.d.decks[d.d.active];
        trace.push(`${((Date.now() - t0) / 1000).toFixed(2)}s ph=${d.ph.toFixed(2)} play=${d.d.playing} busy=${d.d.busy} hidden=${d.d.hidden} idx=${d.d.curIndex} act=${d.d.active} [0:${d.d.decks[0].mediaId ? d.d.decks[0].mediaId.slice(0, 4) : '-'} rs${d.d.decks[0].readyState} t${d.d.decks[0].currentTime.toFixed(2)} p${d.d.decks[0].paused ? 1 : 0} err=${d.d.decks[0].error}] [1:${d.d.decks[1].mediaId ? d.d.decks[1].mediaId.slice(0, 4) : '-'} rs${d.d.decks[1].readyState} t${d.d.decks[1].currentTime.toFixed(2)} p${d.d.decks[1].paused ? 1 : 0} err=${d.d.decks[1].error}] proxy=${await app.evaluate("[...VE.state.S.media.values()].map((m) => m.proxyState).join('/')")}`);
        if (!d.d.playing) { stopped = true; break; }
      }
      const ph = await app.evaluate('VE.state.S.playhead');
      const ok = stopped && ph > 12.9;
      console.log(`round ${i + 1}: ${ok ? 'ok' : (stopped ? 'EARLY STOP' : 'STALLED')} at ph=${ph.toFixed(2)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (!ok) { stalls++; console.log(trace.join('\n')); await app.evaluate('VE.player.pause()'); }
    }
    console.log('errors:', JSON.stringify(app.errors));
  } finally {
    await app.close();
  }
  console.log(stalls ? `${stalls} stall(s)` : 'no stalls');
  process.exit(stalls ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
