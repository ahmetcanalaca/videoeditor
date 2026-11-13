'use strict';
// Unit tests (Node, no browser, no network) of scripts/vendor.js and its declared patches: a vendored file may be the official file of an npm package plus a few declared,
// deterministic changes (vendor-manifest.json: "patches"). `add` applies them (it needs the network; its two helpers are tested here), `verify` has to accept exactly
// "the official file plus the declared patches" and nothing else. A copy of the script runs on small trees made here.
//   node tests/vendor.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { checker } = require('./lib/check');

const WEB = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SCRIPT = path.join(WEB, 'scripts', 'vendor.js');
const { applyPatches, undoPatches } = require(SCRIPT);

const patches = [
  { find: 'AlphaNam', with: 'Alpha_Nam', count: 3, reason: 'test' },
  { prepend: '/* NOTICE: changed */\n', reason: 'test' },
];
// bytes that are not valid UTF-8 must come through untouched
const upstream = Buffer.concat([Buffer.from('var a="AlphaNameX";var b=["m","AlphaNameX"];export{c as AlphaNameX};\n'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a])]);
const patched = Buffer.concat([Buffer.from('/* NOTICE: changed */\n'), Buffer.from(upstream.toString('latin1').split('AlphaNam').join('Alpha_Nam'), 'latin1')]);

// a tree with one vendored file; o: { file, lockSha, upstreamSha, lockPatches (null = none), manifestPatches (null = none), onlyUpstreamHash }
function verifyTree(o) {
  const opt = Object.assign({ file: patched, lockSha: '', upstreamSha: sha(upstream), lockPatches: patches, manifestPatches: patches }, o);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 've-vendor-test-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'vendor', 'lib'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'vendor.js'));
    fs.writeFileSync(path.join(root, 'vendor', 'lib', 'a.js'), opt.file);
    const record = { path: 'lib/a.js', sha256: opt.lockSha || sha(opt.file), bytes: opt.file.length };
    if (opt.lockPatches || opt.onlyUpstreamHash) record.upstreamSha256 = opt.upstreamSha;
    if (opt.lockPatches) record.patches = opt.lockPatches;
    fs.writeFileSync(path.join(root, 'vendor', 'vendor-lock.json'), JSON.stringify({ generatedBy: 'test', packages: [{ name: 'pkg', version: '1.0.0', license: 'MIT', tarballIntegrity: 'sha512-x', source: '', files: [record] }] }, null, 2));
    const declared = { from: 'a.js', to: 'lib/a.js' };
    if (opt.manifestPatches) declared.patches = opt.manifestPatches;
    fs.writeFileSync(path.join(root, 'vendor', 'vendor-manifest.json'), JSON.stringify({ packages: [{ name: 'pkg', version: '1.0.0', license: 'MIT', files: [declared] }] }, null, 2));
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'vendor.js'), 'verify'], { encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const threw = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };
const without = (o, i) => o.filter((_, k) => k !== i);

(async () => {
  const check = checker('web vendor (declared patches)');

  /* ---------------- applying and undoing ---------------- */
  const applied = applyPatches(upstream, patches, 'test');
  check('01 the patches are applied to the official bytes: the text is replaced where it occurs, the notice is put in front, and every other byte - also those that are not valid UTF-8 - is as it was', Buffer.compare(applied, patched) === 0 && applied.length === upstream.length + patches[1].prepend.length + 3, { applied: applied.length, upstream: upstream.length });
  check('02 undoing them gives back exactly the official file', Buffer.compare(undoPatches(patched, patches), upstream) === 0 && sha(undoPatches(patched, patches)) === sha(upstream), null);
  check('03 a patch is refused when its text does not occur as often as it says, when the new text is already in the file, or when the new text contains the old one (it could not be undone)',
    /occurs 3 times, the patch says 2/.test(threw(() => applyPatches(upstream, [{ find: 'AlphaNam', with: 'X', count: 2 }], 't'))) &&
    /already in the file/.test(threw(() => applyPatches(Buffer.from('AlphaNam Alpha_Nam'), [{ find: 'AlphaNam', with: 'Alpha_Nam', count: 1 }], 't'))) &&
    /already in the file/.test(threw(() => applyPatches(upstream, [{ find: 'AlphaNam', with: 'AlphaNamX', count: 3 }], 't'))) &&
    /needs "find"/.test(threw(() => applyPatches(upstream, [{ find: '', with: 'x', count: 1 }], 't'))), null);
  check('04 undoing is refused (null) for a file that is not what the patches make: the notice is missing, the new text occurs a different number of times, the old text is still there',
    undoPatches(patched.subarray(patches[1].prepend.length), patches) === null &&
    undoPatches(Buffer.concat([patched, Buffer.from('Alpha_Nam')]), patches) === null &&
    undoPatches(Buffer.concat([patched, Buffer.from('AlphaNam')]), patches) === null, null);

  /* ---------------- verify ---------------- */
  const good = verifyTree({});
  check('05 verify accepts the official file plus the declared patches (and says so)', good.status === 0 && /1 file with a declared patch/.test(good.out), good);
  const plainFile = verifyTree({ file: upstream, lockSha: sha(patched) });
  check('06 verify refuses the official file when the patches were not applied (the hash of the lock is the patched one)', plainFile.status === 1 && /changed: lib\/a\.js/.test(plainFile.out), plainFile);
  const evil = Buffer.from(patched.toString('latin1').replace('var a', 'var z'), 'latin1');
  const otherEdit = verifyTree({ file: evil });
  check('07 verify refuses another change even when the lock was written for it: undoing the declared patches does not give the official file', otherEdit.status === 1 && /not the official file plus the declared patches: lib\/a\.js/.test(otherEdit.out), otherEdit);
  const wrongUpstream = verifyTree({ upstreamSha: sha(Buffer.from('some other file')) });
  check('08 verify refuses a lock whose official hash is not the one the patches lead back to', wrongUpstream.status === 1 && /not the official file plus the declared patches/.test(wrongUpstream.out), wrongUpstream);
  const noNotice = verifyTree({ file: Buffer.from(patched.subarray(patches[1].prepend.length)) });
  check('09 verify refuses the patched file without the notice that the licence asks for', noNotice.status === 1 && /not the official file plus the declared patches/.test(noNotice.out), noNotice);
  const drift = verifyTree({ manifestPatches: without(patches, 1) });
  check('10 verify refuses a manifest and a lock that declare different patches (one of them was edited without running "add")', drift.status === 1 && /vendor-manifest\.json are not the ones in vendor-lock\.json/.test(drift.out), drift);
  const quiet = verifyTree({ file: upstream, lockPatches: null, manifestPatches: null, onlyUpstreamHash: true });
  check('11 verify refuses an official hash that has no patches next to it', quiet.status === 1 && /an official hash without patches/.test(quiet.out), quiet);
  const unpatched = verifyTree({ file: upstream, lockPatches: null, manifestPatches: null });
  check('12 a file without patches is checked as before (SHA-256 only)', unpatched.status === 0 && !/declared patch/.test(unpatched.out), unpatched);

  /* ---------------- the real tree ---------------- */
  const real = spawnSync(process.execPath, [SCRIPT, 'verify'], { encoding: 'utf8' });
  const lock = JSON.parse(fs.readFileSync(path.join(WEB, 'vendor', 'vendor-lock.json'), 'utf8'));
  const record = lock.packages.find((p) => p.name === '@huggingface/transformers').files.find((f) => f.path === 'transformers/transformers.min.js');
  const bundle = fs.readFileSync(path.join(WEB, 'vendor', 'transformers', 'transformers.min.js')).toString('latin1');
  // (the old name is put together here: written out in one piece it would be the very string that made GitHub's secret scanning take a class name for an API key)
  const oldName = 'Mistral3For' + 'Conditional' + 'Generation';
  check('13 the real vendor folder: verify passes; transformers.min.js is the official file (its hash is in the lock) with the three declared changes - the class name of the Mistral 3 model with an underscore in three places, and the notice - and the 32-letter name no longer occurs',
    real.status === 0 && /^[0-9a-f]{64}$/.test(record.upstreamSha256) && record.upstreamSha256 !== record.sha256 && record.patches.length === 2 && record.patches[0].count === 3 &&
    bundle.startsWith('/* NOTICE: this is a MODIFIED copy') && !bundle.includes(oldName) && bundle.split('Mistral3For_ConditionalGeneration').length - 1 === 3, { status: real.status, out: real.stdout, record: { upstream: record.upstreamSha256, patched: record.sha256 } });

  process.exitCode = check.summary() ? process.exitCode : 1;
})().catch((e) => { console.error('vendor test crashed:', e); process.exit(1); });
