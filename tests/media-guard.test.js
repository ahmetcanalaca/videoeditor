'use strict';
// Security regression tests for src/main/media-guard.js (review finding 1: UNC / SMB / URL access triggered by a project file or a crafted media file).
//   G01 path rules           local paths pass; URLs and device paths never; UNC only when the user chose the file
//   G02 whitelist keeps every container the app offers working (each extension in VIDEO_EXT is generated and probed)
//   G03 HLS / DASH / ffconcat / SDP lookalikes named .mp4 are refused by ffprobe AND by the ffmpeg helpers (no network access is attempted)
//   G04 probe() and the exporter refuse URLs / device paths before any process is started
//   G05 -protocol_whitelist: ffmpeg refuses to open http:// even when a path slips through
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');
const guard = require('../src/main/media-guard');
const { probe } = require('../src/main/probe');
const mediaTools = require('../src/main/media-tools');
const exporter = require('../src/main/exporter');
const model = require('../src/shared/model');

const OUT = path.join(__dirname, 'out', 'guard');
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  /* ---------------------------------------------------------------- G01 */
  const kinds = {
    'C:\\Videos\\a.mp4': 'local', 'D:/Videos/a.mp4': 'local', 'a.mp4': 'local', '.\\x\\a.mp4': 'local', 'C:\\Klasör\\örnek şğı.mp4': 'local',
    '\\\\server\\share\\a.mp4': 'unc', '//server/share/a.mp4': 'unc', '\\\\?\\UNC\\server\\share\\a.mp4': 'unc',
    '\\\\?\\C:\\a.mp4': 'device', '\\\\.\\PhysicalDrive0': 'device', '\\\\.\\pipe\\x': 'device',
    'http://127.0.0.1/a.mp4': 'url', 'https://x/a.mp4': 'url', 'smb://x/y': 'url', 'file:///C:/a.mp4': 'url', 'concat:a|b': 'url', 'pipe:0': 'url', 'data:text/plain,x': 'url', 'rtsp://x/y': 'url',
    '': 'invalid', 'a\0b.mp4': 'invalid',
  };
  const wrong = Object.entries(kinds).filter(([p, k]) => guard.classify(p) !== k).map(([p, k]) => `${JSON.stringify(p)} -> ${guard.classify(p)} (wanted ${k})`);
  check('G01a every path form is classified correctly', wrong.length === 0, wrong.join('; '));

  const throwsFor = (p, opts) => { try { guard.assertLocalMediaPath(p, opts); return null; } catch (e) { return e; } };
  check('G01b local paths are accepted (also with Turkish letters)', ['C:\\Videos\\a.mp4', 'C:\\Klasör\\örnek şğı.mp4', 'a.mp4'].every((p) => throwsFor(p) === null));
  const unc = throwsFor('\\\\server\\share\\a.mp4');
  check('G01c a UNC path from a project file is refused (REMOTE_PATH)', !!unc && unc.code === 'REMOTE_PATH' && unc.kind === 'unc', unc && unc.message);
  check('G01d a UNC path the user chose is accepted (network shares are normal at work)', throwsFor('\\\\server\\share\\a.mp4', { allowNetwork: true }) === null && throwsFor('//server/share/a.mp4', { allowNetwork: true }) === null);
  check('G01e URLs and device paths are refused even for user-chosen files', ['http://x/a.mp4', 'smb://x/y', 'file:///C:/a.mp4', '\\\\?\\C:\\a.mp4', '\\\\.\\pipe\\x', 'concat:a|b'].every((p) => { const e = throwsFor(p, { allowNetwork: true }); return e && e.code === 'REMOTE_PATH'; }));

  /* ---------------------------------------------------------------- G02 */
  // one tiny clip per container of VIDEO_EXT in src/main/main.js; (extension, ffmpeg arguments)
  const src = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100'];
  const make = (ext, codecArgs) => {
    const file = path.join(OUT, 'sample.' + ext);
    h.ff([...src, ...codecArgs, '-t', '2', '-y', file]);
    return file;
  };
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  const mpeg2 = ['-c:v', 'mpeg2video', '-q:v', '5', '-c:a', 'mp2'];
  const samples = {
    mp4: [], m4v: ['-f', 'mp4'], mov: ['-f', 'mov'], mkv: [], webm: ['-c:v', 'libvpx', '-c:a', 'libvorbis'], avi: ['-c:v', 'mpeg4', '-c:a', 'libmp3lame'],
    wmv: ['-c:v', 'wmv2', '-c:a', 'wmav2'], flv: ['-c:v', 'flv', '-c:a', 'libmp3lame'], mpg: mpeg2, mpeg: mpeg2, ts: [], m2ts: ['-f', 'mpegts'], mts: ['-f', 'mpegts'],
    '3gp': ['-f', '3gp'], ogv: ['-c:v', 'libtheora', '-c:a', 'libvorbis'], vob: ['-f', 'vob', ...mpeg2], mxf: ['-c:v', 'mpeg2video', '-q:v', '5', '-c:a', 'pcm_s16le', '-ar', '48000', '-f', 'mxf'],
  };
  const okExt = []; const badExt = [];
  for (const [ext, extra] of Object.entries(samples)) {
    const codec = ['mpg', 'mpeg', 'vob', 'mxf', 'avi', 'wmv', 'flv', 'webm', 'ogv'].includes(ext) ? extra : [...x264, ...extra];
    try {
      const file = make(ext, codec);
      const info = await probe(h.bins, file);
      (info && info.duration > 1 ? okExt : badExt).push(ext);
    } catch (e) { badExt.push(ext + ' (' + String(e.message).split('\n')[0].slice(0, 90) + ')'); }
  }
  check(`G02 every container the app offers still imports (${okExt.length}/${Object.keys(samples).length})`, badExt.length === 0, badExt.length ? 'failed: ' + badExt.join('; ') : okExt.join(' '));

  /* ---------------------------------------------------------------- G03 */
  const share = '\\\\127.0.0.1\\ve_guard_test_share\\seg0.ts';
  const lookalikes = {
    'hls.mp4': '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n' + share + '\n#EXT-X-ENDLIST\n',
    'dash.mp4': '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><BaseURL>' + share.replace(/\\/g, '/') + '/</BaseURL><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1000" width="160" height="120"><BaseURL>v.mp4</BaseURL><SegmentBase indexRange="0-1"/></Representation></AdaptationSet></Period></MPD>\n',
    'concat.mp4': "ffconcat version 1.0\nfile '" + share.replace(/\\/g, '/') + "'\n",
    'sdp.mp4': 'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=x\nc=IN IP4 127.0.0.1\nt=0 0\nm=video 5004 RTP/AVP 96\na=rtpmap:96 H264/90000\n',
  };
  for (const [name, text] of Object.entries(lookalikes)) {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, text);
    // new behaviour: refused because the container is not on the whitelist (nothing is opened from inside the file)
    const t0 = Date.now();
    const e = await rejects(() => probe(h.bins, file));
    check(`G03 ${name} is refused by probe()`, !!e && e.code === 'PROBE_FAILED' && /whitelist|Invalid data|not found/i.test(e.message) && !/ve_guard_test_share/i.test(e.message), (e ? e.message.replace(/\s+/g, ' ').slice(0, 110) : 'accepted!') + `  (${Date.now() - t0} ms)`);
  }
  // the ffmpeg helpers (thumbnails) use the same whitelist: nothing is produced from a lookalike
  {
    const dir = path.join(OUT, 'thumbs');
    let made = 0;
    await mediaTools.generateThumbs({ ffmpegPath: h.bins.ffmpeg, file: path.join(OUT, 'hls.mp4'), duration: 4, count: 4, outDir: dir, onThumb: () => { made++; } });
    check('G03 the thumbnail helper produces nothing from an HLS lookalike', made === 0 && (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0), `thumbnails: ${made}`);
    const peaks = await mediaTools.extractWaveform({ ffmpegPath: h.bins.ffmpeg, file: path.join(OUT, 'concat.mp4'), token: { cancelled: false } });
    check('G03 the waveform helper produces nothing from a concat lookalike', peaks === null);
  }
  // control: WITHOUT the guard ffprobe does follow the DASH manifest inside the file to the location it names (modern FFmpeg already refuses
  // HLS under a non-standard name, unsafe concat paths and RTP; DASH is the remaining way in, and the whitelist closes the whole class)
  {
    const r = spawnSync(h.bins.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', path.join(OUT, 'dash.mp4')], { encoding: 'utf8' });
    check('G03 control: an unguarded ffprobe really loads content from the location named inside the DASH lookalike', /Error when loading first fragment/i.test(String(r.stderr)), String(r.stderr).replace(/\s+/g, ' ').slice(0, 110));
  }

  /* ---------------------------------------------------------------- G04 */
  for (const bad of ['http://127.0.0.1:9/a.mp4', '\\\\?\\C:\\a.mp4', 'smb://127.0.0.1/x/a.mp4']) {
    const e = await rejects(() => probe(h.bins, bad));
    check(`G04 probe() refuses ${bad} before starting ffprobe`, !!e && e.code === 'REMOTE_PATH', e && e.code);
  }
  {
    const fx = h.makeFixtures();
    const info = await probe(h.bins, fx.A);
    info.id = 'm_url';
    info.path = 'http://127.0.0.1:9/a.mp4';
    const seg = model.createSegment(info, { in: 0, out: 1 });
    const job = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: [seg], media: { m_url: info }, settings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'low' }, outPath: path.join(OUT, 'never.mp4') });
    const e = await rejects(() => job.promise);
    check('G04 the exporter refuses a URL as input (REMOTE_PATH) and writes nothing', !!e && e.code === 'REMOTE_PATH' && !fs.existsSync(path.join(OUT, 'never.mp4')), e && e.code);
  }

  /* ---------------------------------------------------------------- G05 */
  {
    const r = spawnSync(h.bins.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...guard.inputArgs('http://127.0.0.1:9/a.mp4'), '-f', 'null', '-'], { encoding: 'utf8', timeout: 20000 });
    check('G05 ffmpeg refuses http:// by protocol whitelist (no connection attempt)', r.status !== 0 && /whitelist/i.test(String(r.stderr)), String(r.stderr).replace(/\s+/g, ' ').slice(0, 120));
  }

  /* ---------------------------------------------------------------- G06 */
  {
    // a file that was swapped for a DASH lookalike AFTER it had been imported (e.g. on a network share): the export opens every input with the
    // format whitelist as well, so the manifest inside is not followed to the location it names
    const fx = h.makeFixtures();
    const info = await probe(h.bins, fx.A);
    info.id = 'm_dash';
    info.path = path.join(OUT, 'dash.mp4');
    const seg = model.createSegment(info, { in: 0, out: 1 });
    const out = path.join(OUT, 'dash-export.mp4');
    const job = exporter.runExport({ ffmpegPath: h.bins.ffmpeg, segments: [seg], media: { m_dash: info }, settings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'low' }, outPath: out });
    const e = await rejects(() => job.promise);
    const text = String((e && (e.details || '')) + ' ' + (e && e.message));
    check('G06 the exporter opens every input with the format whitelist (a DASH lookalike swapped in after the import is refused, nothing is fetched)', !!e && /not on whitelist/i.test(text) && !/first fragment/i.test(text) && !fs.existsSync(out), text.replace(/\s+/g, ' ').slice(0, 140));
    const args = exporter.buildArgs(exporter.buildPlan({ segments: [seg], media: { m_dash: info }, settings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'low' } }), 'graph.txt', 'out.part');
    const i = args.indexOf('-i');
    check('G06 every -i is preceded by -format_whitelist and -protocol_whitelist', i > 4 && args[i - 4] === '-format_whitelist' && args[i - 2] === '-protocol_whitelist', JSON.stringify(args.slice(Math.max(0, i - 5), i + 1)));
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall media-guard checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('crashed', e); process.exit(2); });
