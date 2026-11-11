'use strict';
// Tests of src/main/approvals.js: which paths the USER handed to the app (command line, real drop) and may therefore be network paths.
const { createApprovals, samePath, TTL_MS } = require('../src/main/approvals');

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log('PASS  ' + name); } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + String((e && e.message) || e)); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || 'values differ') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };

test('A01 an approved path is found however it is written (case, slash direction, relative parts); other paths are not', () => {
  const a = createApprovals();
  a.approve(['\\\\server\\share\\Videos\\Clip.MP4', 'C:\\Users\\x\\a.mp4']);
  eq(a.has('\\\\server\\share\\Videos\\Clip.MP4'), true);
  eq(a.has('//SERVER/share/videos/clip.mp4'), true, 'forward slashes and case');
  eq(a.has('\\\\server\\share\\Videos\\..\\Videos\\Clip.mp4'), true, '.. segments');
  eq(a.has('c:\\users\\x\\A.mp4'), true);
  eq(a.has('\\\\server\\share\\Videos\\Other.mp4'), false);
  eq(a.has('\\\\attacker\\share\\Clip.mp4'), false);
  eq(a.has(''), false);
  eq(a.has(undefined), false);
});

test('A02 an approval expires', () => {
  let t = 1000;
  const a = createApprovals({ now: () => t });
  a.approve(['\\\\server\\share\\a.mp4']);
  eq(a.has('\\\\server\\share\\a.mp4'), true);
  t += TTL_MS - 1;
  eq(a.has('\\\\server\\share\\a.mp4'), true, 'still valid just before the limit');
  t += 2;
  eq(a.has('\\\\server\\share\\a.mp4'), false, 'expired');
});

test('A03 junk is ignored and the list stays bounded', () => {
  const a = createApprovals();
  a.approve([null, 5, {}, '', 'x\0y', 'C:\\' + 'a'.repeat(2000), 'C:\\ok.mp4']);
  eq(a.size(), 1, 'only the one sane string counts');
  a.approve('not a list');
  eq(a.size(), 1);
  const many = Array.from({ length: 1200 }, (_, i) => 'C:\\v\\' + i + '.mp4');
  a.approve(many);
  eq(a.size() <= 501, true, 'at most 500 per call: ' + a.size());
  for (let k = 0; k < 6; k++) a.approve(Array.from({ length: 500 }, (_, i) => 'D:\\w' + k + '\\' + i + '.mp4'));
  eq(a.size() <= 2000, true, 'total cap: ' + a.size());
  eq(a.has('D:\\w5\\499.mp4'), true, 'the newest entries are kept');
});

test('A04 samePath compares like the file system does and never throws', () => {
  eq(samePath('C:\\A\\b.vedproj', 'c:/a/B.VEDPROJ'), true);
  eq(samePath('C:\\A\\b.vedproj', 'C:\\A\\c.vedproj'), false);
  eq(samePath('', 'C:\\x'), false);
  eq(samePath(null, null), false);
  eq(samePath('C:\\x\\..\\y\\p.vedproj', 'C:\\y\\p.vedproj'), true);
});

console.log(failures ? `\n${failures} of ${count} FAILED` : `\nall ${count} approval checks passed`);
process.exit(failures ? 1 : 0);
