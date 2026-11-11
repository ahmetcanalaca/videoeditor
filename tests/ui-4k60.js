'use strict';
// 4K60 preview check in the real app: import time, native playback (no proxy), dropped frames, scrub latency.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, summary, ud, h } = require('./ui-helpers');

const OUT_FILE = path.join(OUT, 'export-4k60-ui.mp4');

(async () => {
  const H = path.join(h.FIX, 'H_4k60.mp4');
  fs.rmSync(OUT_FILE, { force: true });
  const t0 = Date.now();
  const app = await launch({ userData: ud('4k'), files: [H], port: 9364, env: { VE_TEST_EXPORT_PATH: OUT_FILE } });
  const quality = () => app.evaluate("(() => { const v = document.querySelector('.deck.active video'); const q = v.getVideoPlaybackQuality(); return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, t: v.currentTime, rs: v.readyState, w: v.videoWidth, h: v.videoHeight, rate: v.playbackRate }; })()");
  try {
    await app.waitFor('VE.state.S.segments.length === 1', 30000, 'import');
    await step('P01 import of the 4K60 file: probe, thumbnails and waveform', async () => {
      const tImport = Date.now() - t0;
      await app.waitFor('[...VE.state.S.media.values()].every((m) => m.thumbsReady.size === m.thumbCount && m.waveform)', 60000, 'thumbnails + waveform');
      const m = await app.evaluate('(() => { const m = [...VE.state.S.media.values()][0]; return { w: m.displayWidth, h: m.displayHeight, fps: m.fps, proxy: m.needsProxy, thumbs: m.thumbCount }; })()');
      assert(m.w === 3840 && m.h === 2160 && Math.abs(m.fps - 60) < 0.01 && !m.proxy, JSON.stringify(m));
      return `${m.w}x${m.h}@${m.fps}, ${m.thumbs} thumbnails + waveform ready ${((Date.now() - t0) / 1000).toFixed(1)} s after launch`;
    });

    await step('P02 native 4K60 playback in the preview: dropped frames over ~4 s', async () => {
      await app.evaluate('VE.actions.seek(0.5)');
      await sleep(800);
      await app.evaluate('VE.player.play()');
      await sleep(1000);
      const a = await quality();
      await sleep(4000);
      const b = await quality();
      await app.evaluate('VE.player.pause()');
      const frames = b.total - a.total;
      const dropped = b.dropped - a.dropped;
      const progressed = b.t - a.t;
      assert(b.w === 3840 && b.h === 2160, 'decoded size ' + b.w + 'x' + b.h);
      assert(frames > 0, 'no frames presented');
      return `presented ${frames} frames in ${progressed.toFixed(2)} s of media time (${(frames / progressed).toFixed(1)} fps), dropped ${dropped} (${((dropped / Math.max(frames + dropped, 1)) * 100).toFixed(1)} %)`;
    });

    await step('P03 scrubbing latency at 4K (seek -> frame shown)', async () => {
      const times = [];
      for (const t of [1.2, 4.7, 2.9, 5.5, 0.3]) {
        const t1 = Date.now();
        await app.evaluate(`VE.actions.seek(${t})`);
        await app.waitFor('(() => { const d = VE.player.debug(); const a = d.decks[d.active]; return !d.busy && a.readyState >= 2 && !a.seeking; })()', 8000, 'seek settled');
        times.push(Date.now() - t1);
      }
      return `seek->ready ms: ${times.join(', ')}`;
    });

    await step('P04 zoom preview at 4K (CSS transform) and 2x playback', async () => {
      await app.evaluate(`(() => { const s = VE.state.S.segments[0]; VE.actions.updateSegment(s.id, { zoomFrom: 1, zoomTo: 2, speed: 2, fx: 0.7, fy: 0.4 }, {}); })()`);
      await sleep(500);
      await app.evaluate('VE.actions.seek(0.2)');
      await sleep(700);
      await app.evaluate('VE.player.play()');
      await sleep(800);
      const a = await quality();
      await sleep(2000);
      const b = await quality();
      const tr = await app.evaluate("document.querySelector('.deck.active video').style.transform");
      await app.evaluate('VE.player.pause()');
      assert(/scale\(/.test(tr), 'no zoom transform while playing: ' + tr);
      return `2x speed + zoom: ${(b.total - a.total)} frames, dropped ${b.dropped - a.dropped}, media advanced ${(b.t - a.t).toFixed(2)} s in 2 s wall`;
    });

    await step('P05 no console errors', async () => { assert(app.errors.length === 0, app.errors.join('\n')); });

    await step('P06 export from the UI at 4K60: result card, then ffprobe of the file (3840x2160 @ 60, 120 frames, AAC)', async () => {
      await app.evaluate(`(() => { const s = VE.state.S.segments[0]; VE.actions.updateSegment(s.id, { speed: 1, zoomFrom: 1, zoomTo: 1, in: 0, out: 2 }, {}); })()`);
      await sleep(400);
      await app.click('#btn-export');
      await app.waitFor("!!document.querySelector('#modal-root .path-row')", 5000, 'export form');
      const summary = await app.evaluate("document.querySelector('#modal-root .summary').textContent");
      assert(/3840×2160/.test(summary) && /60/.test(summary), 'export summary: ' + summary);
      await app.click('#modal-root .path-row .btn');
      await sleep(250);
      await app.evaluate("document.querySelector('#modal-root .btn.primary').click()");
      await app.waitFor("!!document.querySelector('#modal-root .result')", 90000, 'export result');
      assert(await app.evaluate("!!document.querySelector('#modal-root .result.ok')"), 'export failed: ' + (await app.evaluate("document.querySelector('#modal-root .result').textContent")));
      const s = h.streamsOf(OUT_FILE);
      assert(Number(s.v.width) === 3840 && Number(s.v.height) === 2160 && s.v.avg_frame_rate === '60/1' && s.v.codec_name === 'h264', `${s.v.width}x${s.v.height} ${s.v.avg_frame_rate} ${s.v.codec_name}`);
      assert(h.countFrames(OUT_FILE) === 120, 'frames ' + h.countFrames(OUT_FILE));
      assert(s.a && s.a.codec_name === 'aac', 'audio');
      return `${s.v.width}x${s.v.height}@${s.v.avg_frame_rate} level ${s.v.level}, ${(fs.statSync(OUT_FILE).size / 1048576).toFixed(1)} MB`;
    });
  } finally {
    await app.close();
  }
  process.exit(summary('4K60 preview') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
