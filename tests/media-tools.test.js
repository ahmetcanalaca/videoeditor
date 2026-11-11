'use strict';
// Verifies probing, proxy decisions, thumbnails, waveform and proxy generation on the synthetic fixtures.
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const { probe } = require('../src/main/probe');
const mt = require('../src/main/media-tools');

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  const f = h.makeFixtures();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-mt-'));

  const A = await probe(h.bins, f.A);
  const B = await probe(h.bins, f.B);
  const C = await probe(h.bins, f.C);
  const D = await probe(h.bins, f.D);
  const E = await probe(h.bins, f.E);
  check('probe A (720p mp4 + audio)', A.displayWidth === 1280 && A.displayHeight === 720 && A.hasAudio && Math.abs(A.duration - 8) < 0.1 && Math.abs(A.fps - 30) < 0.01 && !A.needsProxy, JSON.stringify({ vcodec: A.vcodec, acodec: A.acodec, fps: A.fps, d: A.duration }));
  check('probe B (silent 4:3 25fps)', B.displayWidth === 640 && !B.hasAudio && Math.abs(B.fps - 25) < 0.01 && !B.needsProxy);
  check('probe C (rotated phone): display size swapped', C.displayWidth === 720 && C.displayHeight === 1280 && C.rotation !== 0, `rot=${C.rotation} ${C.displayWidth}x${C.displayHeight}`);
  check('probe D (AVI): needs proxy', D.needsProxy && D.proxyReason === 'container', JSON.stringify({ c: D.container, r: D.proxyReason }));
  check('probe E (Turkish path)', E.displayWidth === 1280 && E.name === path.basename(f.E), E.name);

  // thumbnails
  const thumbDir = path.join(tmp, 'thumbs');
  const count = mt.thumbCountFor(A.duration);
  const got = [];
  const t0 = Date.now();
  await mt.generateThumbs({ ffmpegPath: h.bins.ffmpeg, file: A.path, duration: A.duration, count, outDir: thumbDir, onThumb: (i) => got.push(i) });
  const files = fs.readdirSync(thumbDir);
  check('thumbnails generated', files.length === count && got.length === count, `${files.length}/${count} in ${Date.now() - t0} ms; first order=${got.slice(0, 6).join(',')}`);
  check('thumbnail order is coarse-to-fine', new Set(mt.thumbOrder(60)).size === 60 && mt.thumbOrder(60)[1] > 10);

  // waveform
  const peaks = await mt.extractWaveform({ ffmpegPath: h.bins.ffmpeg, file: A.path });
  check('waveform peaks (50/s)', peaks && Math.abs(peaks.length - 400) <= 3 && Math.max(...peaks) > 100, `len=${peaks && peaks.length} max=${peaks && Math.max(...peaks)}`);
  const none = await mt.extractWaveform({ ffmpegPath: h.bins.ffmpeg, file: B.path });
  check('waveform null for silent media', none === null);

  // proxy
  const progress = [];
  const proxy = mt.createProxy({ ffmpegPath: h.bins.ffmpeg, file: D.path, outFile: path.join(tmp, 'proxy', 'D.mp4'), duration: D.duration, hasAudio: D.hasAudio, onProgress: (p) => progress.push(p) });
  await proxy.promise;
  const ps = h.streamsOf(path.join(tmp, 'proxy', 'D.mp4'));
  const pinfo = await probe(h.bins, path.join(tmp, 'proxy', 'D.mp4'));
  check('proxy is H.264/AAC mp4, same duration, directly playable', ps.v.codec_name === 'h264' && ps.a.codec_name === 'aac' && Math.abs(ps.duration - D.duration) < 0.15 && !pinfo.needsProxy, `${ps.v.width}x${ps.v.height} dur=${ps.duration.toFixed(2)} vs ${D.duration.toFixed(2)}; progress events=${progress.length}`);

  // proxy of a portrait rotated source keeps upright aspect
  const proxyC = mt.createProxy({ ffmpegPath: h.bins.ffmpeg, file: C.path, outFile: path.join(tmp, 'proxy', 'C.mp4'), duration: C.duration, hasAudio: C.hasAudio });
  await proxyC.promise;
  const pc = h.streamsOf(path.join(tmp, 'proxy', 'C.mp4'));
  check('proxy of rotated clip is upright (portrait, no rotation tag)', Number(pc.v.height) > Number(pc.v.width) && !(pc.v.side_data_list && pc.v.side_data_list.length), `${pc.v.width}x${pc.v.height}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall media-tool checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
