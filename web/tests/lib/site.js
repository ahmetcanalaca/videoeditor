'use strict';
// Starts the static server + a real browser on the web edition; shared by all browser tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../../scripts/serve');
const { launch } = require('./browser');
const tools = require('./media-tools');

const SITE_ROOT = path.join(__dirname, '..', '..');
const READY = "typeof VE !== 'undefined' && !!VE.actions && !!VE.exportUI";

// opts: { base?, headers?, query?, headless?, width?, height?, fixturesDir?, args? }
async function open(opts) {
  const o = opts || {};
  const fixDir = o.fixturesDir || path.join(os.tmpdir(), 've-web-fixtures');
  const fixtures = tools.makeFixtures(fixDir);
  const server = await start({ root: SITE_ROOT, port: 0, base: o.base || '/', headers: o.headers, mounts: { '/__fixtures__/': fixDir } });
  let app;
  try {
    app = await launch({ headless: o.headless, width: o.width, height: o.height, args: o.args });
    await app.navigate('http://127.0.0.1:' + server.port + server.base + 'index.html?vetest' + (o.query || ''), READY);
  } catch (e) {
    if (app) await app.close();
    await server.close();
    throw e;
  }
  app.server = server;
  app.fixtures = fixtures;
  app.fixDir = fixDir;
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

// A tiny assertion collector: prints PASS/FAIL lines and sets a failing exit code.
function checker(title) {
  const results = [];
  const fn = function (name, ok, detail) {
    results.push({ name, ok: !!ok });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && (!ok || process.env.VE_VERBOSE) ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
    if (!ok) process.exitCode = 1;
  };
  fn.summary = function () {
    const bad = results.filter((r) => !r.ok).length;
    console.log('\n' + title + ': ' + (results.length - bad) + '/' + results.length + ' passed' + (bad ? ' - ' + bad + ' FAILED' : ''));
    return bad === 0;
  };
  return fn;
}

module.exports = { open, checker, SITE_ROOT };
