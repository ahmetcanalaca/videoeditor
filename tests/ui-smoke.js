'use strict';
// Quick smoke test: start the app with a fixture video and report errors + a screenshot.
const path = require('path');
const { launch } = require('./ui-lib');
const h = require('./helpers');

(async () => {
  const fx = h.makeFixtures();
  const out = path.join(__dirname, 'out', 'ui');
  const app = await launch({ userData: path.join(out, 'ud-smoke'), files: [fx.A], port: 9341 });
  try {
    await app.waitFor("document.querySelectorAll('.seg').length === 1", 20000, 'segment on timeline');
    await new Promise((r) => setTimeout(r, 2500));
    console.log('lang:', await app.evaluate('document.documentElement.lang'), ' theme:', await app.evaluate("document.documentElement.getAttribute('data-theme')"));
    console.log('segments:', await app.evaluate('document.querySelectorAll(".seg").length'));
    console.log('title:', await app.evaluate('document.title'));
    await app.screenshot(path.join(out, 'smoke.png'));
    console.log('errors:', JSON.stringify(app.errors, null, 2));
    console.log('console (last 15):\n' + app.consoleLog.slice(-15).join('\n'));
    console.log('stderr:', app.log.err.slice(-800));
  } finally {
    await app.close();
  }
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
