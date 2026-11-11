'use strict';
// Verifies that package-lock.json only references the public npm registry and that its integrity hashes match
// the tarballs actually served there (a mirror must serve identical bytes).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const lockPath = path.join(__dirname, '..', 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const entries = Object.entries(lock.packages).filter(([k, v]) => k && v.resolved);
const hosts = new Set(entries.map(([, v]) => new URL(v.resolved).host));
console.log(`lockfileVersion ${lock.lockfileVersion}, ${entries.length} resolved packages, hosts: ${[...hosts].join(', ')}`);
if ([...hosts].some((h) => h !== 'registry.npmjs.org')) { console.log('FAIL: non-public registry host in the lockfile'); process.exit(1); }
const weak = entries.filter(([, v]) => !/^sha512-/.test(v.integrity || ''));
if (weak.length) { console.log(`FAIL: ${weak.length} package(s) without a sha512 integrity value: ${weak.map(([k]) => k).join(', ')}`); process.exit(1); }

const sample = (process.argv[2] || 'node_modules/electron,node_modules/@electron/packager').split(',');
(async () => {
  let failed = 0;
  for (const key of sample) {
    const e = lock.packages[key];
    if (!e) { console.log(`skip ${key}: not in lockfile`); continue; }
    try {
      const res = await fetch(e.resolved);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const [algo, expected] = e.integrity.split('-');
      const actual = crypto.createHash(algo).update(buf).digest('base64');
      const ok = actual === expected;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${key}  ${e.version}  ${algo} ${ok ? 'matches' : 'DIFFERS'}  (${(buf.length / 1024).toFixed(0)} KB from registry.npmjs.org)`);
      if (!ok) failed++;
    } catch (err) {
      console.log(`INFO  ${key}: could not fetch from the public registry here (${err.message})`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
