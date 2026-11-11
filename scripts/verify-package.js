'use strict';
// Release gate: proves that a packaged application was built from the CURRENT sources.
//
//   node scripts/verify-package.js [--app=<application folder>]      (default: dist/VideoEditor-win32-x64)
//
// Every file inside resources/app.asar has to be byte-identical to the file of the working tree (src/**; of package.json the packager keeps only
// some fields, each of them has to be equal), every source file has to be inside it, and nothing else may be (no installer/, tests/, scripts/,
// docs/, vendor/, node_modules/ ...). It runs at the end of
// "npm run package" and before the installer is built, so a stale package (an older build than the code: the reason for an already fixed bug to
// "come back") can never be handed out unnoticed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function* walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) yield* walk(path.join(dir, e.name), r);
    else yield r;
  }
}

// Returns a list of problems (empty = the package is current).
function verify(appDir) {
  const asarFile = path.join(appDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarFile)) return ['resources/app.asar is missing in ' + appDir];
  const asar = require('@electron/asar');
  const problems = [];
  const inAsar = new Set();
  for (const raw of asar.listPackage(asarFile, { isPack: false })) {
    const name = raw.replace(/^[\\/]+/, '').split(path.sep).join('/');
    let buf = null;
    try { buf = asar.extractFile(asarFile, raw.replace(/^[\\/]+/, '')); } catch (e) { continue; } // a directory
    inAsar.add(name);
    if (!(name === 'package.json' || name.startsWith('src/'))) { problems.push('unexpected file inside app.asar: ' + name); continue; }
    const real = path.join(ROOT, name);
    if (!fs.existsSync(real)) { problems.push('inside app.asar but not in the working tree: ' + name); continue; }
    if (name === 'package.json') {
      // the packager keeps only the fields the application needs (no scripts / devDependencies): every field it kept has to equal the source
      try {
        const a = JSON.parse(buf.toString('utf8'));
        const b = JSON.parse(fs.readFileSync(real, 'utf8'));
        for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push('package.json "' + k + '" differs from the working tree (the package is older than the code)');
      } catch (e) { problems.push('package.json inside app.asar is not readable'); }
      continue;
    }
    if (!buf.equals(fs.readFileSync(real))) problems.push('differs from the working tree (the package is older than the code): ' + name);
  }
  for (const rel of walk(path.join(ROOT, 'src'), 'src')) if (!inAsar.has(rel)) problems.push('source file missing inside app.asar: ' + rel);
  if (!inAsar.has('package.json')) problems.push('package.json is missing inside app.asar');
  return problems;
}

module.exports = { verify };

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--app='));
  const appDir = arg ? path.resolve(arg.slice(6)) : path.join(ROOT, 'dist', 'VideoEditor-win32-x64');
  const problems = verify(appDir);
  if (problems.length) {
    console.error('The package is NOT current (' + appDir + '):');
    for (const p of problems.slice(0, 40)) console.error('  - ' + p);
    if (problems.length > 40) console.error('  ... and ' + (problems.length - 40) + ' more');
    process.exit(1);
  }
  console.log('OK: every file of app.asar is identical to the working tree (' + appDir + ')');
}
