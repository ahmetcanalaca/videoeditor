'use strict';
// Keeps the web edition's copies of the desktop code current. The desktop sources under src/ stay the single source of truth for the
// editing model, the assistant's agent loop, the provider adapters, the video-analysis client and the "look at the video" pipeline; the web edition
// does not fork them, it bundles them:
//
//   node scripts/sync-desktop.js            writes the generated files
//   node scripts/sync-desktop.js --check    exits 1 when a generated file is missing or out of date, or when an adapted renderer file differs from the
//                                           desktop original in a way nobody accepted (run by the tests and the CI)
//   node scripts/sync-desktop.js --accept   records the (reviewed) differences of the adapted renderer files; --show <file> lists them
//
// Generated files (never edit them by hand):
//   js/shared/model.js, js/shared/agent-ops.js   byte-for-byte copies (classic scripts / Node modules)
//   js/web/ai/desktop-core.js                    the CommonJS modules below, wrapped in a tiny module registry so that they run unchanged in the page
//                                                (their few Node built-ins come from js/web/ai/node-shims.js)
//   local-ai/pins.json                           what the Local AI helper may download (model files, llama.cpp builds): sizes, URLs, SHA-256 values
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const WEB = path.resolve(__dirname, '..');

const COPIES = [
  ['src/shared/model.js', 'js/shared/model.js'],
  ['src/shared/agent-ops.js', 'js/shared/agent-ops.js'],
];

// id = repository-relative path without ".js": the same names the modules use for each other in their require() calls
const BUNDLE_OUT = 'js/web/ai/desktop-core.js';
const MODULES = [
  'src/shared/model',
  'src/shared/agent-ops',
  'src/main/ai/agent',
  'src/main/ai/providers',
  'src/main/ai/net',
  'src/main/ai/endpoints',
  'src/main/ai/content-understanding',
  'src/main/ai/cu-service',
  'src/main/perception/query',
  'src/main/perception/boxes',
  'src/main/perception/scan',
  'src/main/perception/frames',
  'src/main/perception/vlm',
  'src/main/perception/index',
  'src/main/llm/catalog',
];

// export name -> module id
const EXPORTS = {
  model: 'src/shared/model',
  ops: 'src/shared/agent-ops',
  agent: 'src/main/ai/agent',
  providers: 'src/main/ai/providers',
  net: 'src/main/ai/net',
  endpoints: 'src/main/ai/endpoints',
  cu: 'src/main/ai/content-understanding',
  cuService: 'src/main/ai/cu-service',
  perceptionQuery: 'src/main/perception/query',
  perceptionBoxes: 'src/main/perception/boxes',
  perceptionScan: 'src/main/perception/scan',
  perceptionFrames: 'src/main/perception/frames',
  perceptionVlm: 'src/main/perception/vlm',
  perception: 'src/main/perception/index',
  llmCatalog: 'src/main/llm/catalog',
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lf = (s) => String(s).replace(/\r\n/g, '\n');

// The renderer files of the web edition are copies of the desktop app's (web/js, web/css) with a few deliberate changes (no Electron, no "show in folder", ...).
// Nothing generates them, so this guards against drift instead: for every pair, the lines that differ are fingerprinted and compared with the recorded
// fingerprint (scripts/adaptations.json). A change of a desktop file, or of the web copy, shows up here until somebody has looked at it and accepted it:
//   node scripts/sync-desktop.js --accept     records the current differences (after reviewing them!)
const ADAPTED = [
  ['src/renderer/css/app.css', 'css/app.css'],
  ['src/renderer/css/theme.css', 'css/theme.css'],
].concat(['ai', 'app', 'boot', 'exportui', 'i18n', 'icons', 'inspector', 'player', 'state', 'timeline', 'util'].map((n) => ['src/renderer/js/' + n + '.js', 'js/' + n + '.js']));
const ADAPT_FILE = 'scripts/adaptations.json';

function adaptation(from, to) {
  const count = (text) => { const m = new Map(); for (const l of lf(text).split('\n')) m.set(l, (m.get(l) || 0) + 1); return m; };
  const a = count(fs.readFileSync(path.join(REPO, from), 'utf8'));
  const b = count(fs.readFileSync(path.join(WEB, to), 'utf8'));
  const removed = [];
  const added = [];
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) || 0); i++) removed.push(l);
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) || 0); i++) added.push(l);
  removed.sort();
  added.sort();
  return { removed, added, digest: sha(Buffer.from(JSON.stringify([removed, added]))).slice(0, 16) };
}

// The pinned downloads of the Local AI helper (web/local-ai/): the model files and the llama.cpp builds, with the same sizes, URLs and SHA-256 values as
// the desktop app uses (src/main/llm/catalog.js, vendor/llama/llama-pin.json). The helper checks every file against them before it starts anything.
const PINS_OUT = 'local-ai/pins.json';
function buildPins() {
  const { CATALOG, DEFAULT_MODEL_ID } = require(path.join(REPO, 'src', 'main', 'llm', 'catalog.js'));
  const model = CATALOG.find((m) => m.id === DEFAULT_MODEL_ID);
  const llama = JSON.parse(fs.readFileSync(path.join(REPO, 'vendor', 'llama', 'llama-pin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(WEB, 'package.json'), 'utf8'));
  const consts = fs.readFileSync(path.join(WEB, 'js', 'web', 'ai', 'constants.js'), 'utf8');
  const port = /LOCAL_AI_DEFAULT_PORT:\s*(\d+)/.exec(consts);
  if (!model || !pkg.homepage || !port) throw new Error('pins: the model, the homepage or the default port is missing');
  const pins = {
    generated: 'GENERATED by scripts/sync-desktop.js from src/main/llm/catalog.js and vendor/llama/llama-pin.json - do not edit',
    site: pkg.homepage,
    defaultPort: Number(port[1]),
    model: {
      id: model.id,
      name: model.name,
      dir: model.id,
      license: model.license,
      source: model.source,
      needsRamGb: model.needsRamGb,
      files: model.files.map((f) => ({ role: f.role, name: f.name, aliases: f.aliases.slice(), url: f.url, size: f.size, sha256: f.sha256 })),
    },
    llama: {
      tag: llama.tag,
      assets: { cpu: { url: llama.assets.cpu.url, zipSha256: llama.assets.cpu.zipSha256 }, vk: { url: llama.assets.vk.url, zipSha256: llama.assets.vk.zipSha256 } },
      files: { cpu: llama.files.cpu, vk: llama.files.vk },
    },
  };
  return JSON.stringify(pins, null, 2) + '\n';
}

function buildBundle() {
  const parts = [];
  const hashes = [];
  for (const id of MODULES) {
    const file = path.join(REPO, id + '.js');
    const raw = fs.readFileSync(file);
    hashes.push('//   ' + sha(raw).slice(0, 16) + '  ' + id + '.js');
    parts.push("'" + id + "': function (module, exports, require) {\n" + lf(raw.toString('utf8')).replace(/\n*$/, '\n') + '},');
  }
  const out = [
    '// GENERATED by scripts/sync-desktop.js from the desktop sources - do not edit (run `node scripts/sync-desktop.js` after changing src/).',
    '// Sources (first 16 hex digits of the SHA-256 of each file):',
    hashes.join('\n'),
    '// The CommonJS modules of the desktop app, running unchanged in the page: a tiny registry gives each one its own `module` and `require`.',
    "import { shims } from './node-shims.js';",
    '',
    'const SOURCES = {',
    parts.join('\n'),
    '};',
    '',
    'const cache = Object.create(null);',
    'const dirOf = (id) => id.slice(0, id.lastIndexOf(\'/\'));',
    'function resolveId(from, spec) {',
    "  if (spec[0] !== '.') return spec;",
    '  const out = [];',
    "  for (const p of (dirOf(from) + '/' + spec).split('/')) {",
    "    if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p);",
    '  }',
    "  return out.join('/').replace(/\\.js$/, '');",
    '}',
    'function load(id) {',
    '  if (cache[id]) return cache[id].exports;',
    '  const factory = SOURCES[id];',
    '  if (!factory) {',
    '    if (Object.prototype.hasOwnProperty.call(shims, id)) return shims[id];',
    "    throw Object.assign(new Error('Module is not available in the browser: ' + id), { code: 'MODULE_NOT_AVAILABLE' });",
    '  }',
    '  const module = { exports: {} };',
    '  cache[id] = module;',
    '  factory.call(module.exports, module, module.exports, (spec) => load(resolveId(id, spec)));',
    '  return module.exports;',
    '}',
    '',
    Object.keys(EXPORTS).map((name) => 'export const ' + name + " = load('" + EXPORTS[name] + "');").join('\n'),
    '',
  ].join('\n');
  return out;
}

function expected() {
  const files = new Map();
  for (const [from, to] of COPIES) files.set(to, fs.readFileSync(path.join(REPO, from)));
  files.set(BUNDLE_OUT, Buffer.from(buildBundle(), 'utf8'));
  files.set(PINS_OUT, Buffer.from(buildPins(), 'utf8'));
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const accept = process.argv.includes('--accept');
  const problems = [];
  for (const [to, buf] of expected()) {
    const dest = path.join(WEB, to);
    let have = null;
    try { have = fs.readFileSync(dest); } catch (e) { /* missing */ }
    const textual = to.endsWith('desktop-core.js') || to.endsWith('pins.json');
    const same = have && (textual ? lf(have.toString('utf8')) === lf(buf.toString('utf8')) : have.equals(buf));
    if (same) continue;
    if (check) { problems.push(to + (have ? ' is out of date' : ' is missing')); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log('wrote ' + to + ' (' + Math.round(buf.length / 1024) + ' KB)');
  }

  // the adapted copies of the renderer
  const current = {};
  for (const [from, to] of ADAPTED) current[to] = adaptation(from, to).digest;
  if (accept) {
    fs.writeFileSync(path.join(WEB, ADAPT_FILE), JSON.stringify(current, null, 2) + '\n');
    console.log('recorded the differences of ' + ADAPTED.length + ' adapted renderer files in ' + ADAPT_FILE);
  } else if (check) {
    let recorded = {};
    try { recorded = JSON.parse(fs.readFileSync(path.join(WEB, ADAPT_FILE), 'utf8')); } catch (e) { problems.push(ADAPT_FILE + ' is missing'); }
    for (const [from, to] of ADAPTED) {
      if (recorded[to] !== current[to]) problems.push(to + ' differs from ' + from + ' in a way nobody has accepted yet (a desktop change that the web copy lacks, or a change of the web copy); review: node scripts/sync-desktop.js --show ' + to);
    }
  }
  if (process.argv.includes('--show')) {
    const want = process.argv[process.argv.indexOf('--show') + 1];
    const pair = ADAPTED.find((p) => p[1] === want);
    if (!pair) { console.error('no such adapted file: ' + want); process.exit(2); }
    const d = adaptation(pair[0], pair[1]);
    console.log(d.removed.map((l) => '- ' + l).join('\n') + '\n' + d.added.map((l) => '+ ' + l).join('\n'));
    return;
  }
  if (check) {
    if (problems.length) {
      console.error('desktop sync check FAILED:\n  ' + problems.join('\n  ') + '\nrun: node scripts/sync-desktop.js   (generated files)   /   node scripts/sync-desktop.js --accept   (reviewed renderer differences)');
      process.exit(1);
    }
    console.log('desktop sync OK: ' + COPIES.length + ' copies + ' + MODULES.length + ' bundled modules + the pins of the Local AI helper + ' + ADAPTED.length + ' adapted renderer files');
  }
}

if (require.main === module) main();
module.exports = { MODULES, EXPORTS, COPIES, ADAPTED, buildBundle, buildPins, adaptation };
