'use strict';
// Calibrates exporter.commandLength() against the real Windows CreateProcess limit (32,767 characters):
// the estimate must be conservative, i.e. anything the exporter lets through (<= its hard limit) really starts.
const { spawnSync } = require('child_process');
const { resolveBinaries } = require('../src/main/ffmpeg-paths');
const exporter = require('../src/main/exporter');

const bins = resolveBinaries({ resourcesPath: null });
let failures = 0;

function tryLen(target) {
  // arguments with spaces force quoting, which is the expensive case for the estimate
  const args = ['-hide_banner', '-version'];
  const token = 'a long argument with spaces ' + 'x'.repeat(40);
  while (exporter.commandLength(bins.ffmpeg, args.concat([token])) < target) args.push(token);
  const pad = target - exporter.commandLength(bins.ffmpeg, args) - 1;
  if (pad > 0) args.push('p'.repeat(pad));
  const est = exporter.commandLength(bins.ffmpeg, args);
  const r = spawnSync(bins.ffmpeg, args, { windowsHide: true, encoding: 'utf8' });
  return { est, ok: !r.error && r.status === 0, err: r.error ? r.error.code : '' };
}

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`);
  if (!cond) failures++;
}

for (const t of [30000, 31500, 32700]) {
  const r = tryLen(t);
  check(`a command line estimated at ${r.est} characters starts`, r.ok, r.err);
}
const over = tryLen(33500);
check(`a command line estimated at ${over.est} characters is refused by Windows (ENAMETOOLONG)`, !over.ok && over.err === 'ENAMETOOLONG', over.err);
check('the exporter hard limit leaves at least 1,000 characters of margin', 32767 - 31500 >= 1000);

const quoted = exporter.commandLength('C:\\x\\ffmpeg.exe', ['-i', 'a b.mp4']);
check('estimate counts quotes around arguments with spaces', quoted === 'C:\\x\\ffmpeg.exe'.length + 3 + 3 + 10, String(quoted));
process.exit(failures ? 1 : 0);
