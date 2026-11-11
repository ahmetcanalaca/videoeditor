'use strict';
// Looks for API keys, tokens, passwords, private keys and other secrets - in the SOURCE, in the PACKAGED application (the contents of app.asar
// included) and in what the installer carries (it is built from the packaged folder, and the installer test proves they are byte-identical).
// It also lists every web address that is written into the code, so that an unexpected endpoint (telemetry, a hard-coded service) cannot hide.
//
//   node scripts/secret-scan.js                scan the project and dist/VideoEditor-win32-x64 (if it exists)
//   node scripts/secret-scan.js --no-dist      source only
//   node scripts/secret-scan.js --app=<dir>    scan this application folder instead of dist/VideoEditor-win32-x64
//                                              (e.g. the folder the installer produced); add --no-src to skip the project sources
//   node scripts/secret-scan.js --json=<file>  also write the findings as JSON
//
// Exit code 1 when something that looks like a REAL secret is found outside the tests. Values that are clearly fake (the tests use
// TEST_KEY_not_a_real_secret_..., fake eyJ... tokens, example.com ...) are reported separately and never fail the scan.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const SKIP_DIST = args.includes('--no-dist');
const SKIP_SRC = args.includes('--no-src');
const APP_DIR = (args.find((a) => a.startsWith('--app=')) || '').slice(6);
const JSON_OUT = (args.find((a) => a.startsWith('--json=')) || '').slice(7);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coco_vlm']);
const SKIP_REL = [/^tests[\\/]out[\\/]/, /^tests[\\/]fixtures[\\/]/, /^vendor[\\/]ffmpeg[\\/]bin[\\/]/, /^vendor[\\/]llama[\\/](cpu|vk)[\\/]/, /^vendor[\\/]nsis[\\/]nsis-[\d.]+[\\/]/];
const BINARY_EXT = /\.(exe|dll|node|pak|bin|dat|gguf|png|jpe?g|gif|ico|webp|mp4|mkv|avi|mov|webm|wav|mp3|zip|7z|gz|tgz|br|woff2?|ttf|otf|so|lib|obj|asar|blob|snap|icu|lnk|cab)$/i;
const MAX_TEXT = 5 * 1024 * 1024;

// ---------------------------------------------------------------- what to look for
const PATTERNS = [
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'npmrc-auth', re: /:_auth(?:Token)?\s*=\s*\S+/g },
  { id: 'azure-account-key', re: /(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s*=\s*[A-Za-z0-9+/=%]{20,}/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'bearer-literal', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
  { id: 'url-credentials', re: /\bhttps?:\/\/[^/\s:@'"`]+:[^/\s:@'"`]{3,}@[^/\s'"`]+/g },
  // an assignment of a literal to something that is called key / secret / token / password
  { id: 'assigned-secret', re: /\b(?:api[-_ ]?key|apikey|secret|client[-_ ]?secret|access[-_ ]?token|auth[-_ ]?token|password|passwd|pwd)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi },
];
const FORBIDDEN_FILES = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.git-credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|secrets?\.(json|ya?ml|txt)|[^\\/]+\.(pem|pfx|p12|key|keystore|jks|kdbx|ppk))$/i;
// values that are obviously not real
const FAKE = /(TEST_KEY|not_a_real|fake|dummy|example|placeholder|your[-_ ]?(api[-_ ]?)?key|xxxx|0123456789|abcdef|<[^>]+>|\$\{|%[A-Z_]+%|REDACTED|changeme|sk-test|lorem)/i;
const SCRIPT_NAME = path.join('scripts', 'secret-scan.js');

// Shannon entropy in bits per character
function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// ---------------------------------------------------------------- collecting the files
function* walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_REL.some((re) => re.test(r + path.sep))) continue;
      yield* walk(path.join(dir, e.name), r);
    } else if (!SKIP_REL.some((re) => re.test(r))) {
      yield { rel: r, abs: path.join(dir, e.name) };
    }
  }
}

const findings = [];
const urls = new Map(); // host -> Set(files)
const stats = { files: 0, scanned: 0, skippedBinary: 0 };

function isTestFile(rel) { return /^tests[\\/]/.test(rel) || /^docs[\\/]internal[\\/]/.test(rel); }

function scanText(label, rel, text, opts) {
  stats.scanned++;
  const test = (opts && opts.test) || isTestFile(rel);
  const lines = text.split(/\r?\n/);
  const consider = (id, value, lineNo) => {
    const fake = FAKE.test(value);
    findings.push({ where: label, line: lineNo, id, sample: mask(value), kind: fake ? 'fake' : (test ? 'test' : 'REAL?') });
  };
  lines.forEach((line, i) => {
    if (line.length > 4000) return; // minified or generated data
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        if (p.id === 'assigned-secret') {
          // only literals that look like secrets: high entropy, no spaces or path separators, not a template
          const v = /["']([^"'\s]{12,})["']\s*$/.exec(m[0]);
          const val = v ? v[1] : '';
          if (!val || entropy(val) < 3.3 || /^[a-z]+([A-Z][a-z]+)+$/.test(val) || /[\\/]/.test(val)) continue;
        }
        consider(p.id, m[0], i + 1);
      }
    }
    // addresses written into the application code (src/; the asar contents are collected separately)
    if (/^src[\\/]/.test(rel) && !(opts && opts.asar)) {
      for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|127\.0\.0\.1)(?::\d+)?/g)) {
        const host = m[1].toLowerCase();
        if (!urls.has(host)) urls.set(host, new Set());
        urls.get(host).add(label);
      }
    }
  });
  // long random-looking values next to a secret-ish word on the same line (keys that no pattern knows)
  lines.forEach((line, i) => {
    if (line.length > 600 || !/(key|secret|token|passw)/i.test(line)) return;
    for (const m of line.matchAll(/["'`]([A-Za-z0-9+/=_-]{32,})["'`]/g)) {
      const v = m[1];
      if (FAKE.test(v) || /^[a-f0-9]{40,64}$/i.test(v) /* hex digests (SHA) are not keys */ || /^sha\d+-/.test(v) /* npm integrity values */ || /^[A-Za-z]+$/.test(v)) continue;
      if (entropy(v) >= 4.2 && !findings.some((f) => f.where === label && f.line === i + 1)) {
        findings.push({ where: label, line: i + 1, id: 'high-entropy-near-keyword', sample: mask(v), kind: test ? 'test' : 'REAL?' });
      }
    }
  });
}

function mask(v) {
  const s = String(v).replace(/\s+/g, ' ');
  return s.length <= 14 ? s : s.slice(0, 6) + '…' + s.slice(-4) + ' (' + s.length + ' chars)';
}

function scanFile(root, f, labelPrefix) {
  stats.files++;
  const label = (labelPrefix || '') + f.rel.split(path.sep).join('/');
  if (FORBIDDEN_FILES.test(f.rel)) findings.push({ where: label, line: 0, id: 'forbidden-file-name', sample: path.basename(f.rel), kind: isTestFile(f.rel) ? 'test' : 'REAL?' });
  if (path.join(root, f.rel).endsWith(SCRIPT_NAME)) return; // this file contains the patterns themselves
  if (BINARY_EXT.test(f.rel)) { stats.skippedBinary++; return; }
  let size = 0;
  try { size = fs.statSync(f.abs).size; } catch (e) { return; }
  if (size > MAX_TEXT) { stats.skippedBinary++; return; }
  let buf;
  try { buf = fs.readFileSync(f.abs); } catch (e) { return; }
  if (buf.includes(0)) { stats.skippedBinary++; return; }
  scanText(label, f.rel, buf.toString('utf8'));
}

async function scanAsar(asarFile, labelPrefix) {
  const asar = require('@electron/asar');
  const names = asar.listPackage(asarFile, { isPack: false }).map((n) => n.replace(/^[\\/]/, ''));
  let n = 0;
  for (const name of names) {
    if (BINARY_EXT.test(name)) { stats.skippedBinary++; continue; }
    let buf;
    try { buf = asar.extractFile(asarFile, name); } catch (e) { continue; } // directories
    if (!buf || buf.includes(0)) { stats.skippedBinary++; continue; }
    stats.files++;
    n++;
    scanText(labelPrefix + name.split(path.sep).join('/'), name, buf.toString('utf8'), { test: false, asar: true });
    // the asar listing is the application code: addresses in it count as the application's addresses
    for (const m of buf.toString('utf8').matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|127\.0\.0\.1)(?::\d+)?/g)) {
      const host = m[1].toLowerCase();
      if (!urls.has(host)) urls.set(host, new Set());
      urls.get(host).add(labelPrefix + name);
    }
  }
  return n;
}

// ---------------------------------------------------------------- run
(async () => {
  if (!SKIP_SRC) {
    console.log('Scanning the project sources ...');
    for (const f of walk(ROOT, '')) scanFile(ROOT, f, '');
  }

  const dist = APP_DIR ? path.resolve(APP_DIR) : path.join(ROOT, 'dist', 'VideoEditor-win32-x64');
  if (!SKIP_DIST && fs.existsSync(dist)) {
    console.log('Scanning the packaged application (' + (APP_DIR ? dist : 'dist/VideoEditor-win32-x64') + ', including the contents of app.asar) ...');
    const asarFile = path.join(dist, 'resources', 'app.asar');
    for (const f of walk(dist, '')) {
      // the Chromium / Electron runtime files are not ours (and are binary); documents and our own resources are scanned
      if (/^(locales|resources[\\/](llama|bin))[\\/]/.test(f.rel)) { if (FORBIDDEN_FILES.test(f.rel)) findings.push({ where: 'dist/' + f.rel.split(path.sep).join('/'), line: 0, id: 'forbidden-file-name', sample: path.basename(f.rel), kind: 'REAL?' }); continue; }
      if (/\.asar$/.test(f.rel)) continue;
      scanFile(dist, f, 'dist/');
    }
    if (fs.existsSync(asarFile)) {
      const n = await scanAsar(asarFile, 'dist/app.asar/');
      console.log('  app.asar: ' + n + ' text files read');
    }
  } else if (!SKIP_DIST) {
    console.log('(no packaged application in dist/ - only the sources were scanned)');
  }

  const user = os.userInfo().username;

  const real = findings.filter((f) => f.kind === 'REAL?');
  const test = findings.filter((f) => f.kind === 'test');
  const fake = findings.filter((f) => f.kind === 'fake');
  console.log('\nFiles seen: ' + stats.files + ' · text files scanned: ' + stats.scanned + ' · binaries skipped: ' + stats.skippedBinary);

  const show = (title, list) => {
    console.log('\n' + title + ': ' + list.length);
    const byId = new Map();
    for (const f of list) byId.set(f.id, (byId.get(f.id) || 0) + 1);
    if (list.length) console.log('  by type: ' + [...byId].map(([k, v]) => k + ' ×' + v).join(', '));
    for (const f of list.slice(0, 40)) console.log('  - ' + f.where + (f.line ? ':' + f.line : '') + '  [' + f.id + ']  ' + f.sample);
    if (list.length > 40) console.log('  … and ' + (list.length - 40) + ' more');
  };
  show('Possible REAL secrets (project sources, package, app.asar)', real);
  show('Secret-like values in tests / internal documents that are fake or test data (not shipped in the app)', test);
  show('Clearly fake placeholder values elsewhere (TEST_KEY_not_a_real_secret, example.com, ...)', fake);

  // addresses in the code
  const hosts = [...urls.keys()].sort();
  console.log('\nWeb addresses written into the code (' + hosts.length + ' hosts):');
  for (const h of hosts) console.log('  ' + h.padEnd(42) + [...urls.get(h)].slice(0, 2).join(', ') + (urls.get(h).size > 2 ? ' …' : ''));

  // a person's name in the package would be a leak too (build path, user name)
  let personalHits = 0;
  if (user && user.length > 3) {
    const needle = new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (!SKIP_DIST && fs.existsSync(dist)) {
      const asarFile = path.join(dist, 'resources', 'app.asar');
      const hits = [];
      const check = (label, text) => { if (needle.test(text)) hits.push(label); };
      for (const f of walk(dist, '')) {
        if (/^(locales|resources[\\/](llama|bin))[\\/]/.test(f.rel) || BINARY_EXT.test(f.rel) || /\.asar$/.test(f.rel)) continue;
        try { if (fs.statSync(f.abs).size <= MAX_TEXT) check('dist/' + f.rel.split(path.sep).join('/'), fs.readFileSync(f.abs, 'utf8')); } catch (e) { /* ignore */ }
      }
      if (fs.existsSync(asarFile)) {
        const asar = require('@electron/asar');
        for (const name of asar.listPackage(asarFile, { isPack: false }).map((n) => n.replace(/^[\\/]/, ''))) {
          if (BINARY_EXT.test(name)) continue;
          try { check('dist/app.asar/' + name, asar.extractFile(asarFile, name).toString('utf8')); } catch (e) { /* directory */ }
        }
      }
      personalHits = hits.length;
      console.log('\nThe builder\'s Windows user name appears in ' + hits.length + ' packaged text file(s)' + (hits.length ? ': ' + hits.slice(0, 5).join(', ') : '.'));
    }
  }

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ stats, findings, hosts, personalHits }, null, 2));
  console.log('\n' + (real.length ? 'RESULT: ' + real.length + ' possible real secret(s) - review the list above.' : 'RESULT: no real secret found in the sources or in the packaged application.'));
  process.exit(real.length ? 1 : 0);
})().catch((e) => { console.error('secret scan crashed:', e); process.exit(2); });
