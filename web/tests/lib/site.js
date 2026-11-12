'use strict';
// Starts the static server + a real browser on the web edition; shared by all browser tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../../scripts/serve');
const { launch, sleep, waitUntil } = require('./browser');
const { checker } = require('./check');
const tools = require('./media-tools');

const SITE_ROOT = path.join(__dirname, '..', '..');
const READY = "typeof VE !== 'undefined' && !!VE.actions && !!VE.exportUI";

// opts: { base?, headers?, query?, headless?, width?, height?, fixturesDir?, args?, extensions? (folders of unpacked browser extensions to load; the page is opened once the first one is running) }
async function open(opts) {
  const o = opts || {};
  const fixDir = o.fixturesDir || path.join(os.tmpdir(), 've-web-fixtures');
  const fixtures = tools.makeFixtures(fixDir);
  const upDir = o.uploadsDir || path.join(os.tmpdir(), 've-web-uploads');
  fs.mkdirSync(upDir, { recursive: true });
  const server = await start({ root: SITE_ROOT, port: 0, base: o.base || '/', headers: o.headers, mounts: { '/__fixtures__/': fixDir }, uploads: upDir });
  let app;
  try {
    app = await launch({ headless: o.headless, width: o.width, height: o.height, args: o.args, extensions: o.extensions, userData: o.userData });
    if (o.extensions && o.extensions.length) {
      // a page that is opened before the browser has started the extension would not get its content script
      await waitUntil(async () => (await app.targets()).some((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url)), 30000, 'the extension\'s service worker');
      await sleep(600);
    }
    await app.navigate('http://127.0.0.1:' + server.port + server.base + 'index.html?vetest' + (o.query || ''), READY);
  } catch (e) {
    if (app) await app.close();
    await server.close();
    throw e;
  }
  app.server = server;
  app.fixtures = fixtures;
  app.fixDir = fixDir;
  app.upDir = upDir;
  app.origin = 'http://127.0.0.1:' + server.port;

  // Fixture files become File objects in the page (what the file picker would hand over); `kind` is 'media' or 'project'.
  app.stage = async function (names, kind) {
    const list = (Array.isArray(names) ? names : [names]).map((n) => n.split(path.sep).join('/'));
    await app.evaluate(`(async () => {
      const names = ${JSON.stringify(list)};
      const files = [];
      for (const n of names) {
        const url = '/__fixtures__/' + n.split('/').map(encodeURIComponent).join('/');
        const r = await fetch(url);
        if (!r.ok) throw new Error('fixture ' + n + ': HTTP ' + r.status);
        files.push(new File([await r.blob()], n.split('/').pop(), { lastModified: 1700000000000 }));
      }
      window.__veTest = window.__veTest || {};
      window.__veTest[${JSON.stringify(kind || 'media')}] = files;
      return files.length;
    })()`);
  };
  const baseClose = app.close;
  app.close = async function () {
    await baseClose();
    await server.close();
  };
  return app;
}

// (the assertion collector is in check.js, which needs no browser; it is re-exported here for the browser tests)
module.exports = { open, checker, SITE_ROOT };
