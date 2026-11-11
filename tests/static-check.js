'use strict';
// Static consistency checks for the renderer: i18n key parity, HTML key coverage, CSS balance, script references.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const rend = path.join(root, 'src', 'renderer');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

// load i18n in a fake browser context
const sandbox = { window: {}, document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(rend, 'js', 'i18n.js'), 'utf8'), sandbox);
const dict = sandbox.VE.i18n.dict;
const trKeys = Object.keys(dict.tr);
const enKeys = Object.keys(dict.en);
check('i18n: TR and EN have identical keys', trKeys.length === enKeys.length && trKeys.every((k) => k in dict.en), `tr=${trKeys.length} en=${enKeys.length}; missingInEn=${trKeys.filter((k) => !(k in dict.en)).join(',')} missingInTr=${enKeys.filter((k) => !(k in dict.tr)).join(',')}`);
check('i18n: no empty strings', trKeys.every((k) => dict.tr[k] && dict.en[k]));
// placeholder parity ({name}, {p} ...)
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
const badPh = trKeys.filter((k) => ph(dict.tr[k]) !== ph(dict.en[k]));
check('i18n: placeholders match between languages', badPh.length === 0, badPh.join(','));

// every key referenced in HTML or in JS t('...') exists
const html = fs.readFileSync(path.join(rend, 'index.html'), 'utf8');
const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-html|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
const jsDir = path.join(rend, 'js');
for (const f of fs.readdirSync(jsDir)) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
}
const missing = [...used].filter((k) => !(k in dict.tr));
check('i18n: every referenced key exists', missing.length === 0, missing.join(', '));

// CSS braces balance
for (const f of ['app.css', 'theme.css']) {
  const css = fs.readFileSync(path.join(rend, 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  check(`css: ${f} braces balanced`, open === close, `${open}/${close}`);
}

// HTML <script src> and stylesheet links resolve
const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const absent = refs.filter((r) => !fs.existsSync(path.join(rend, r)));
check('html: all script/css references exist', absent.length === 0, absent.join(', '));

// element ids referenced by JS exist in HTML (checked for getElementById / $('#id') usages)
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set();
for (const f of fs.readdirSync(jsDir)) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  for (const m of src.matchAll(/\$\(\s*'#([\w-]+)'\s*\)/g)) jsIds.add(m[1]);
  for (const m of src.matchAll(/getElementById\(\s*'([\w-]+)'\s*\)/g)) jsIds.add(m[1]);
}
const unknownIds = [...jsIds].filter((i) => !ids.has(i));
check('js: all #ids used by scripts exist in index.html', unknownIds.length === 0, unknownIds.join(', '));

// user guide: image links resolve, in-page links have a target, TR and EN sections have the same structure
const guidePath = path.join(root, 'KULLANIM-KILAVUZU-USER-GUIDE.md');
if (fs.existsSync(guidePath)) {
  const guide = fs.readFileSync(guidePath, 'utf8');
  const images = [...guide.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const missingImages = images.filter((p) => !fs.existsSync(path.join(root, p)));
  check('guide: all image links resolve', images.length > 0 && missingImages.length === 0, missingImages.join(', '));
  const anchors = new Set([...guide.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
  const links = [...guide.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
  const deadLinks = links.filter((l) => !anchors.has(l));
  check('guide: all in-page links have a target', links.length > 0 && deadLinks.length === 0, deadLinks.join(', '));
  const [trPart, enPart] = guide.split('<a id="en"></a>');
  const count = (s, re) => (s.match(re) || []).length;
  const heads = [count(trPart, /^#{3,4} /gm), count(enPart || '', /^#{3,4} /gm)];
  const rows = [count(trPart, /^\| /gm), count(enPart || '', /^\| /gm)];
  check('guide: TR and EN sections have the same structure', !!enPart && heads[0] === heads[1] && rows[0] === rows[1], `headings tr=${heads[0]} en=${heads[1]}, table rows tr=${rows[0]} en=${rows[1]}`);
  // links to other documents of the package (e.g. the object-understanding study) must exist
  const docLinks = [...guide.matchAll(/\]\((docs\/[^)#]+\.md)\)/g)].map((m) => m[1]);
  const missingDocs = docLinks.filter((p) => !fs.existsSync(path.join(root, p)));
  check('guide: links to other documents resolve', docLinks.length > 0 && missingDocs.length === 0, missingDocs.join(', '));
  // the AI assistant chapter must exist in both languages (the table of contents and the FAQ link to it)
  const sectionsOk = ['tr-ai', 'en-ai'].every((a) => anchors.has(a));
  check('guide: the AI assistant section exists in both languages', sectionsOk, '');
}

process.exit(failures ? 1 : 0);
