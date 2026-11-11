'use strict';
// "Local Network Access" (Chrome / Edge ask before a page on the internet may talk to a program on this computer), as the published site experiences it:
// the page is made to count as PUBLIC (--ip-address-space-overrides) and the model server (a stand-in for the Local AI helper) is on loopback.
//   - the assistant's network worker really triggers the permission request (a refusal is a failed fetch: the server sees nothing),
//   - a refusal is told apart from "not started" (code LNA_BLOCKED, the panel says what to click),
//   - once the permission is granted, the worker reaches the server (no server header is needed for that),
//   - and a pairing made in another tab of the browser is picked up by this one (storage event).
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
  const llm = await mock.start({});
  const app = await launch({ headless: process.env.VE_HEADED !== '1', args: ['--ip-address-space-overrides=127.0.0.1:' + PORT + '=public'] });
  const origin = 'http://127.0.0.1:' + PORT;
  const ev = (e) => app.evaluate(e);
  try {
    await app.navigate(origin + '/index.html?vetest', "typeof VE !== 'undefined' && !!VE.actions && !!VE.exportUI");
    const perm = () => ev("navigator.permissions.query({ name: 'loopback-network' }).then((s) => s.state, () => 'unsupported')");
    const before = await perm();
    if (before === 'unsupported') { console.log('SKIP: this browser has no "loopback-network" permission (Chrome / Edge 142 or newer)'); return; }
    check('01 the site counts as public and the browser has not decided yet: the permission is "prompt"', before === 'prompt', before);

    await ev('window.__veAnswers = [0]');
    await ev("location.hash = '#local-ai=" + llm.port + '.' + llm.key + "'");
    // the pairing tests the connection by itself; the browser's refusal shows up in the status
    await app.waitFor("window.api.ai.status().then((s) => s.builtin.paired && s.builtin.lna === 'denied')", 30000, 'paired, and refused by the browser');
    const t1 = await ev('window.api.ai.test()');
    check('02 without the permission the assistant\'s worker cannot reach the helper (the server saw nothing)', !t1.ok && llm.log.length === 0, { t1, seen: llm.log.length });
    check('03 the worker DID ask for the permission (headless refuses it: "denied"), and the refusal is told apart from "not started": LNA_BLOCKED', (await perm()) === 'denied' && t1.error && t1.error.code === 'LNA_BLOCKED', { perm: await perm(), error: t1.error });
    const st = await ev('window.api.ai.status()');
    check('04 the status says so, for the settings panel', st.builtin.lna === 'denied' && st.builtin.connection === 'unreachable', st.builtin);
    await ev('VE.ai.openSettings()');
    await app.waitFor("!!document.querySelector('[data-llm=state]')", 10000, 'the panel');
    const panel = await ev("(() => { const s = document.querySelector('[data-llm=state]'); return { state: s.dataset.state, text: s.textContent }; })()");
    check('05 the Local AI panel says what to click (Site settings > Local network access > Allow) instead of "is the helper running?"', panel.state === 'blocked' && /Site ayarları|Site settings/.test(panel.text) && /Yerel ağ|Local network/i.test(panel.text), panel);
    await ev('VE.modal.close()');

    // the user allows it
    await app.cdp.send('Browser.setPermission', { permission: { name: 'loopback-network' }, setting: 'granted', origin });
    const t2 = await ev('window.api.ai.test()');
    check('06 after "Allow" the worker reaches the helper: connected, with the key, and the page origin is what the server sees', t2.ok === true && llm.log.some((e) => e.path === '/v1/models' && e.auth === 'Bearer ' + llm.key) && llm.log[0].origin === origin, { t2, origin: llm.log[0] && llm.log[0].origin });
    check('07 the status is "ready" and the permission "granted"', (await ev('window.api.ai.status()')).builtin.connection === 'ready' && (await perm()) === 'granted');

    // another tab of the browser paired with a (new) helper: this tab picks it up
    await ev(`(() => {
      localStorage.setItem('ve.web.ai.helper.v1', JSON.stringify({ port: 18999, key: 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789', vision: true, model: 'other' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 've.web.ai.helper.v1', storageArea: localStorage }));
      return true;
    })()`);
    await sleep(300);
    const st3 = await ev('window.api.ai.status()');
    check('08 a pairing made in another tab (storage event) is picked up: new port, connection state reset', st3.builtin.port === 18999 && st3.builtin.paired && st3.builtin.connection === 'unknown', st3.builtin);
    // every GitHub Pages site of an account shares this origin: settings written by another page are read when a tab opens, never applied live to an open one
    await ev(`(() => {
      localStorage.setItem('ve.web.ai.v1', JSON.stringify({ provider: 'openai', baseUrl: 'https://evil.example', model: 'x', auth: 'key' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 've.web.ai.v1', storageArea: localStorage }));
      return true;
    })()`);
    await sleep(300);
    const st4 = await ev('window.api.ai.status()');
    check('08b a change of the settings made elsewhere (storage event) is not applied live to this tab: only the pairing is', st4.provider === 'builtin' && st4.builtin.port === 18999, { provider: st4.provider, port: st4.builtin.port });
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
