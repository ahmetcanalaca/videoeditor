'use strict';
// End-to-end safety check in the real app: exporting onto a source video must be refused with a readable message
// (Turkish and English) and must not touch the source file.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./ui-lib');
const { OUT, step, assert, summary, ud, h } = require('./ui-helpers');

(async () => {
  const fx = h.makeFixtures();
  // a private copy: the test must be able to prove that it was not modified
  const src = path.join(OUT, 'Kaynak Video (silinebilir).mp4');
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(fx.A, src);
  const before = fs.statSync(src);
  const hashBefore = require('crypto').createHash('sha256').update(fs.readFileSync(src)).digest('hex');

  const PROJECT = path.join(OUT, 'safety-proje (silinebilir).vedproj');
  fs.rmSync(PROJECT, { force: true });
  const MSGLOG = path.join(OUT, 'msgbox-safety.log');
  fs.rmSync(MSGLOG, { force: true });
  // VE_TEST_ENDPOINT_CONFIRM=deny: the native "may the assistant send its requests to this address?" dialog is answered with "Cancel" (and recorded)
  const app = await launch({ userData: ud('safety'), files: [src], port: 9367, env: { VE_TEST_EXPORT_PATH: src, VE_TEST_PROJECT_PATH: PROJECT, VE_TEST_ENDPOINT_CONFIRM: 'deny', VE_TEST_MSGBOX_LOG: MSGLOG } });
  const modalText = () => app.evaluate("(document.querySelector('#modal-root .modal') || { textContent: '' }).textContent");
  const runExport = async () => {
    await app.click('#btn-export');
    await app.waitFor("!!document.querySelector('#modal-root .path-row')", 5000, 'export form');
    await app.click('#modal-root .path-row .btn');
    await sleep(250);
    assert((await app.evaluate("document.querySelector('#modal-root .path-row input').value")) === src, 'the source path was not chosen');
    await app.evaluate("document.querySelector('#modal-root .btn.primary').click()");
    await app.waitFor("!!document.querySelector('#modal-root .result.err')", 20000, 'error card');
  };

  try {
    await app.waitFor('VE.state.S.segments.length === 1', 20000, 'import');
    await sleep(800);

    await step('S01 Turkish: exporting onto the source video is refused with a clear message', async () => {
      await runExport();
      const text = await modalText();
      assert(/Dışa aktarma başarısız/.test(text) && /kaynak video/.test(text) && /farklı bir ad/.test(text), 'message: ' + text);
      await app.screenshot(path.join(OUT, 'shots', 'tr-dark-export-refused.png'));
      await app.evaluate("document.querySelector('#modal-root .modal-foot .btn').click()");
      await sleep(300);
    });

    await step('S02 English: same refusal in English', async () => {
      await app.click('#lang-switch button[data-lang="en"]');
      await sleep(300);
      await runExport();
      const text = await modalText();
      assert(/Export failed/.test(text) && /same as a source video/.test(text) && /different name/.test(text), 'message: ' + text);
      await app.screenshot(path.join(OUT, 'shots', 'en-dark-export-refused.png'));
      await app.evaluate("document.querySelector('#modal-root .modal-foot .btn').click()");
    });

    await step('S03 the source file is byte-identical and no .part file exists', async () => {
      const after = fs.statSync(src);
      const hashAfter = require('crypto').createHash('sha256').update(fs.readFileSync(src)).digest('hex');
      assert(after.size === before.size && after.mtimeMs === before.mtimeMs && hashAfter === hashBefore, 'the source file changed');
      assert(!fs.existsSync(src + '.part'), '.part file left behind');
    });

    await step('S04 no console errors', async () => { assert(app.errors.length === 0, app.errors.join('\n')); });

    // ---- what a script in the page can and cannot ask main to do (security review: the page is the least trusted part) ----
    const J = (v) => JSON.stringify(v);

    await step('S06 the page can change only its own settings (theme, language, export, preview volume): the AI endpoint, model folder, last-used folders and unknown keys are ignored', async () => {
      const s = await app.evaluate(`window.api.setSettings(${J({ theme: 'light', ai: { provider: 'foundry', auth: 'entra', baseUrl: 'https://evil.example.org', model: 'x' }, llm: { modelDir: 'C:\\Windows', backend: 'cpu', idleMinutes: 0 }, lastDirs: { open: '\\\\attacker\\share' }, window: { width: 5000 }, evil: 'x' })})`);
      assert(s.theme === 'light', 'the theme (a page setting) was not applied');
      assert(s.ai.provider === 'builtin' && s.ai.baseUrl === '' && s.ai.auth === 'key' && s.ai.model === '', 'the page changed the AI settings: ' + J(s.ai));
      assert(s.llm.modelDir === '' && s.llm.backend === 'auto' && s.llm.idleMinutes === 10, 'the page changed the model settings: ' + J(s.llm));
      assert(s.lastDirs.open === '' && s.window.width !== 5000 && !('evil' in s), 'lastDirs / window / unknown key: ' + J({ l: s.lastDirs, w: s.window, e: s.evil }));
      await app.evaluate("window.api.setSettings({ theme: 'dark' })");
    });

    await step('S07 "save project" never writes where the page says: only to the project file main knows or the dialog; the file holds only known settings; no temp file is left', async () => {
      const evil = path.join(OUT, 'evil-startup.cmd');
      const evil2 = path.join(OUT, 'evil-note.txt');
      fs.rmSync(evil, { force: true });
      fs.rmSync(evil2, { force: true });
      const r1 = await app.evaluate(`window.api.projectSave(${J({ path: evil, segments: [], mediaIds: [], settings: { aspect: '16:9', quality: 'low', evil: 'x'.repeat(100000), nested: { a: 1 } } })})`);
      assert(!fs.existsSync(evil), 'a file was written to the path the page chose');
      assert(r1.path === PROJECT && fs.existsSync(PROJECT), 'the project must go to the dialog answer, not to the page path: ' + J(r1));
      const saved = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
      assert(saved.app === 'VideoEditor' && Array.isArray(saved.segments), 'not a project file');
      assert(Object.keys(saved.settings).every((k) => ['resolution', 'aspect', 'fps', 'quality'].includes(k)) && saved.settings.aspect === '16:9', 'settings in the project file: ' + J(saved.settings).slice(0, 200));
      const r2 = await app.evaluate(`window.api.projectSave(${J({ path: evil2, segments: [], mediaIds: [] })})`);
      assert(!fs.existsSync(evil2), 'a .txt file was written');
      assert(r2.path === PROJECT, J(r2));
      // the page may name the file main already knows: a silent save
      const r3 = await app.evaluate(`window.api.projectSave(${J({ path: PROJECT, segments: [], mediaIds: [] })})`);
      assert(r3.path === PROJECT && !r3.error, J(r3));
      assert(!fs.readdirSync(OUT).some((n) => /\.tmp$/.test(n)), 'a temp file was left behind');
    });

    await step('S08 an export goes only where the user picked it in the export dialog: a path chosen by a script (another file, a network share, a WebDAV name) is refused before anything happens', async () => {
      const seg = await app.evaluate('JSON.parse(JSON.stringify(VE.state.S.segments))');
      const mine = path.join(OUT, 'script-chosen.mp4');
      fs.rmSync(mine, { force: true });
      for (const p of [mine, '\\\\127.0.0.1\\ve_blocked_share\\x.mp4', '\\\\attacker@SSL\\DavWWWRoot\\x.mp4', '\\\\.\\pipe\\x.mp4']) {
        const r = await app.evaluate(`window.api.exportStart(${J({ segments: seg, settings: {}, outPath: p })})`);
        assert(r.ok === false && r.error && r.error.code === 'OUT_DIR', p + ' -> ' + J(r));
      }
      assert(!fs.existsSync(mine), 'an export file appeared');
    });

    await step('S09 paths sent by the page: web addresses, device paths and network shares are refused as media (REMOTE_PATH) and as projects; a normal local file still imports', async () => {
      const bad = ['\\\\127.0.0.1\\ve_blocked_share\\x.mp4', 'http://127.0.0.1:9/a.mp4', '\\\\.\\pipe\\x', '\\\\?\\C:\\a.mp4', 'smb://127.0.0.1/x/a.mp4'];
      const res = await app.evaluate(`window.api.importPaths(${J(bad)})`);
      assert(res.length === bad.length && res.every((r) => r.ok === false && r.error === 'REMOTE_PATH'), J(res));
      for (const p of ['\\\\127.0.0.1\\ve_blocked_share\\p.vedproj', 'http://127.0.0.1:9/p.vedproj', '\\\\.\\pipe\\p.vedproj']) {
        const r = await app.evaluate(`window.api.projectOpen(${J(p)})`);
        assert(r.error === 'INVALID_PROJECT', p + ' -> ' + J(r));
      }
      const ok = await app.evaluate(`window.api.importPaths(${J([src])})`);
      assert(ok.length === 1 && ok[0].ok === true, 'a local file must still import: ' + J(ok).slice(0, 200));
    });

    await step('S10 a script cannot make another file "the project": project:open with a path the user never handed over is refused, and a later silent save never writes there', async () => {
      const decoy = path.join(OUT, 'safety-decoy (silinebilir).vedproj');
      const body = JSON.stringify({ app: 'VideoEditor', version: 1, segments: [], media: [], settings: {} });
      fs.writeFileSync(decoy, body);
      const r = await app.evaluate(`window.api.projectOpen(${J(decoy)})`);
      assert(r.error === 'INVALID_PROJECT', 'a project that the user never opened was accepted: ' + J(r).slice(0, 200));
      const w = await app.evaluate(`window.api.projectSave(${J({ path: decoy, segments: [], mediaIds: [] })})`);
      assert(fs.readFileSync(decoy, 'utf8') === body, 'the decoy file was overwritten by a silent save');
      assert(w.path === PROJECT, 'the save did not go to the dialog answer: ' + J(w));
      fs.rmSync(decoy, { force: true });
    });

    await step('S11 a script cannot send the assistant to a server of its own: an address that is not the provider\'s own needs the user\'s OK in a native dialog (here: Cancel) - nothing is saved, no key is stored; the provider\'s own address and this computer need no question', async () => {
      const lines = () => (fs.existsSync(MSGLOG) ? fs.readFileSync(MSGLOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
      const n0 = lines().length;
      const r = await app.evaluate(`window.api.ai.save(${J({ provider: 'openai', baseUrl: 'https://evil.example.org/v1', model: 'm', apiKey: 'sk-test-0123456789abcdefghij' })})`);
      assert(r.ok === false && r.error.code === 'ENDPOINT_NOT_CONFIRMED', J(r).slice(0, 300));
      const asked = lines().slice(n0);
      assert(asked.length === 1 && asked[0].message === 'https://evil.example.org' && /adresi|address/i.test(asked[0].title), 'the dialog was not shown / recorded: ' + J(asked));
      const st = await app.evaluate('window.api.ai.status()');
      assert(st.provider === 'builtin' && !st.hasKey && st.baseUrl === '', 'the settings or the key changed: ' + J({ p: st.provider, k: st.hasKey, u: st.baseUrl }));
      assert(!fs.existsSync(path.join(ud('safety'), 'ai-key.json')), 'a key file was written for an address that was refused');
      assert(!fs.existsSync(path.join(ud('safety'), 'ai-endpoint-origins.json')), 'a refused address was remembered');
      // the provider's own address: no question
      const own = await app.evaluate(`window.api.ai.save(${J({ provider: 'openai', baseUrl: '', model: 'gpt-4o-mini', apiKey: 'sk-test-0123456789abcdefghij' })})`);
      assert(own.ok === true, J(own).slice(0, 300));
      assert(lines().length === n0 + 1, 'the provider\'s own address must not ask: ' + J(lines().slice(n0 + 1)));
      await app.evaluate('window.api.ai.clearKey()');
      await app.evaluate("window.api.ai.save({ provider: 'builtin' })");
      assert((await app.evaluate('window.api.ai.status()')).provider === 'builtin', 'could not restore the default assistant');
    });

    await step('S05 switches that open the app to debugging or redirect its traffic are refused in every spelling (--x, -x, /x): exit code 2, no port opens, unless the automated-test mode is on', async () => {
      const root = path.join(__dirname, '..');
      const exe = process.env.VE_EXE || require(path.join(root, 'node_modules', 'electron'));
      const env = Object.assign({}, process.env);
      delete env.VE_TEST_MODE;
      delete env.ELECTRON_RUN_AS_NODE;
      for (const sw of ['--remote-debugging-port=9452', '-remote-debugging-port=9452', '/remote-debugging-port=9452', '--inspect=9453', '--no-sandbox', '/no-sandbox', '--js-flags=--expose-gc', '--proxy-server=127.0.0.1:9', '--host-rules=MAP * 127.0.0.1']) {
        const args = (process.env.VE_EXE ? [] : [root]).concat([sw, '--user-data-dir=' + ud('safety-switch')]);
        const r = require('child_process').spawnSync(exe, args, { env, timeout: 40000, encoding: 'utf8' });
        assert(r.status === 2, sw + ': exit code ' + r.status + ' ' + String(r.stderr || '').slice(0, 200));
        assert(/is not allowed/.test(r.stderr || ''), sw + ': ' + String(r.stderr || '').slice(0, 200));
      }
    });
    await step('S05b product mode (no test hooks) starts normally: the guard must not refuse the app\'s own start, harmless switches work, the self-test runs and reports ok', async () => {
      const root = path.join(__dirname, '..');
      const exe = process.env.VE_EXE || require(path.join(root, 'node_modules', 'electron'));
      const env = Object.assign({}, process.env);
      delete env.VE_TEST_MODE;
      delete env.ELECTRON_RUN_AS_NODE;
      const report = path.join(OUT, 'selftest-product.json');
      fs.rmSync(report, { force: true });
      const args = (process.env.VE_EXE ? [] : [root]).concat(['--selftest-out=' + report, '--user-data-dir=' + ud('safety-product'), '--disable-gpu']);
      const r = require('child_process').spawnSync(exe, args, { env, timeout: 90000, encoding: 'utf8' });
      assert(r.status === 0, 'exit code ' + r.status + ' ' + String(r.stderr || '').slice(0, 300));
      const j = JSON.parse(fs.readFileSync(report, 'utf8'));
      assert(j.ok === true && /^\d+$/.test(String(j.llama && j.llama.cpu)), JSON.stringify(j).slice(0, 300));
      // a selftest path that is not an absolute local .json file is refused
      const bad = require('child_process').spawnSync(exe, (process.env.VE_EXE ? [] : [root]).concat(['--selftest-out=\\\\127.0.0.1\\x\\r.json', '--user-data-dir=' + ud('safety-product')]), { env, timeout: 60000, encoding: 'utf8' });
      assert(bad.status === 2, 'a network path for the self-test report was accepted: exit ' + bad.status);
    });
  } finally {
    await app.close();
    fs.rmSync(src, { force: true });
  }
  process.exit(summary('Export safety (never overwrite a source)') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
