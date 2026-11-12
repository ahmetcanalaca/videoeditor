'use strict';
// "Local Network Access" (Chrome / Edge ask before a page on the internet may talk to a program on this computer), as the published site experiences it:
// the page is made to count as PUBLIC (--ip-address-space-overrides) and the model server (a stand-in for Ollama / LM Studio) is on loopback.
//   - the assistant's network worker really triggers the permission request (a refusal is a failed fetch: the server sees nothing),
//   - a refusal is told apart from "not started" (code LNA_BLOCKED, and the message says what to click),
//   - once the permission is granted, the worker reaches the server (no server header is needed for that),
//   - and settings that another page of the same origin wrote are never applied live to an open tab.
//   node tests/lna.test.js        (VE_BROWSER=<chrome|edge exe>; a browser with the permission "loopback-network": Chrome / Edge 142 or newer)
const net = require('net');
const path = require('path');
const { start } = require('../scripts/serve');
const { launch } = require('./lib/browser');
const { checker } = require('./lib/site');
const mock = require('./lib/mock-llm');

const WEB = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const check = checker('web lna');
  const PORT = await freePort();
  const srv = await start({ root: WEB, port: PORT, base: '/' });
  const llm = await mock.start({ chat: async () => ({ content: 'OK' }) });
  const app = await launch({ headless: process.env.VE_HEADED !== '1', args: ['--ip-address-space-overrides=127.0.0.1:' + PORT + '=public'] });
  const origin = 'http://127.0.0.1:' + PORT;
  const ev = (e) => app.evaluate(e);
  try {
    await app.navigate(origin + '/index.html?vetest', "typeof VE !== 'undefined' && !!VE.actions && !!VE.exportUI");
    const perm = () => ev("navigator.permissions.query({ name: 'loopback-network' }).then((s) => s.state, () => 'unsupported')");
    const before = await perm();
    if (before === 'unsupported') { console.log('SKIP: this browser has no "loopback-network" permission (Chrome / Edge 142 or newer)'); return; }
    check('01 the site counts as public and the browser has not decided yet: the permission is "prompt"', before === 'prompt', before);

    const saved = await ev(`window.api.ai.save({ provider: 'local', baseUrl: '${llm.url}/v1', model: 'mock-model', apiKey: '${llm.key}' })`);
    check('02 a model server on this computer is set up (no question: it is this computer)', saved.ok && saved.status.ready, saved.error || saved.status);
    const t1 = await ev('window.api.ai.test()');
    check('03 without the permission the assistant\'s worker cannot reach the server (the server saw nothing)', !t1.ok && llm.log.length === 0, { t1, seen: llm.log.length });
    check('04 the worker DID ask for the permission (headless refuses it: "denied"), and the refusal is told apart from "not started": LNA_BLOCKED', (await perm()) === 'denied' && t1.error && t1.error.code === 'LNA_BLOCKED', { perm: await perm(), error: t1.error });
    const said = await ev("VE.i18n.t('ai.err.LNA_BLOCKED')");
    check('05 the message says what to click (Site settings > Local network access > Allow) instead of "is the server running?"', /Site ayarları|Site settings/.test(said) && /Yerel ağ|Local network/i.test(said) && !/Yerel AI|Local AI/.test(said), said);

    // the user allows it
    await app.cdp.send('Browser.setPermission', { permission: { name: 'loopback-network' }, setting: 'granted', origin });
    const t2 = await ev('window.api.ai.test()');
    check('06 after "Allow" the worker reaches the server: connected, with the key, and the page origin is what the server sees', t2.ok === true && llm.log.some((e) => e.path === '/v1/models' && e.auth === 'Bearer ' + llm.key) && llm.log[0].origin === origin, { t2, origin: llm.log[0] && llm.log[0].origin });
    check('07 the permission is "granted" now', (await perm()) === 'granted');

    // every GitHub Pages site of an account shares this origin: settings written by another page are read when a tab opens, never applied live to an open one
    await ev(`(() => {
      localStorage.setItem('ve.web.ai.v1', JSON.stringify({ provider: 'openai', baseUrl: 'https://evil.example', model: 'x', auth: 'key' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 've.web.ai.v1', storageArea: localStorage }));
      return true;
    })()`);
    await sleep(300);
    const st = await ev('window.api.ai.status()');
    check('08 a change of the settings made elsewhere (storage event) is not applied live to this tab', st.provider === 'local' && st.effectiveBaseUrl === llm.url + '/v1', { provider: st.provider, base: st.effectiveBaseUrl });
    // what the browser logs about the refusal is expected; nothing else may be logged
    const unexpected = app.errors.filter((e) => !/Permission was denied for this request to access the `loopback` address space|net::ERR_FAILED/.test(String(e)));
    check('09 no console errors other than the browser\'s own note about the refusal', unexpected.length === 0, unexpected);
  } finally {
    await app.close();
    await llm.stop();
    await srv.close();
  }
  process.exitCode = check.summary() ? 0 : 1;
})().catch((e) => { console.error('lna test crashed:', e); process.exit(1); });
