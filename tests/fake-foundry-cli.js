'use strict';
// A FAKE Foundry Local command line for the UI tests (tests/ui-foundry.js): the app starts it as `node fake-foundry-cli.js <args>` (VE_TEST_FL_CLI_JS) and reads what it
// prints. State lives in the JSON file named by VE_FAKE_FL_STATE; the fake SERVER is a mock in the test process that reads the same file ("loaded" models).
const fs = require('fs');
const path = require('path');

const file = process.env.VE_FAKE_FL_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
state.calls = state.calls || [];
state.calls.push(args.join(' '));

const out = (s) => process.stdout.write(s + '\n');
const model = (id) => state.models.find((m) => m.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = (m) => ({ alias: m.alias, id: m.id, displayName: m.id.replace(/:\d+$/, ''), source: 'Public', type: m.type, device: m.device, executionProvider: m.device + 'ExecutionProvider', fileSizeMb: m.fileSizeMb, cached: !!m.cached, loaded: !!m.loaded, license: 'apache-2.0', supportsToolCalling: m.tools !== false });

(async () => {
  const [a, b, c] = args;
  if (a === 'server' && b === 'start') {
    if (state.startFails) { save(); process.stderr.write('cannot bind the port\n'); process.exit(1); }
    state.running = true;
    // a new start: nothing is loaded any more (the model has to be loaded again)
    state.models.forEach((m) => { m.loaded = false; });
    fs.mkdirSync(path.join(state.home, '.foundry'), { recursive: true });
    fs.writeFileSync(path.join(state.home, '.foundry', 'daemon.json'), JSON.stringify({ pid: state.pid, web_urls: [state.url], daemon_version: '0.14.0' }));
    save();
    out('● success: Server ready (' + state.url + ')');
  } else if (a === 'cache' && b === 'list') {
    save();
    out(JSON.stringify({ models: state.models.filter((m) => m.cached).map(entry) }));
  } else if (a === 'model' && b === 'list') {
    save();
    out(JSON.stringify({ models: state.models.map(entry) }));
  } else if (a === 'model' && b === 'download') {
    const m = model(c);
    if (!m) { save(); out("● error: No model matching '" + c + "' was found in the catalog."); process.exit(3); }
    save();
    out('■ Downloading model (' + c + ')');
    for (let p = 0; p <= 100; p += 10) { out(c + ': ' + p + '%'); await sleep(state.downloadStepMs || 60); }
    const again = JSON.parse(fs.readFileSync(file, 'utf8'));
    again.models.find((x) => x.id === c).cached = true;
    again.calls = state.calls;
    fs.writeFileSync(file, JSON.stringify(again));
    out("● success: Downloaded '" + c + "' to the local cache.");
  } else if (a === 'model' && b === 'load') {
    const m = model(c);
    if (!m) { save(); out("● error: No model matching '" + c + "' was found in the catalog."); process.exit(3); }
    if (!m.cached) { save(); out("● error: model '" + c + "' is not downloaded"); process.exit(1); }
    if (state.loadFails) { save(); process.stderr.write('out of memory\n'); process.exit(1); }
    await sleep(state.loadMs || 100);
    m.loaded = true;
    save();
    out("● success: Loaded '" + m.alias + "' into memory.");
  } else if (a === 'model' && b === 'unload') {
    const m = model(c);
    if (m) m.loaded = false;
    save();
    out("● success: Unloaded '" + c + "' from memory.");
  } else {
    save();
    process.stderr.write('unknown command\n');
    process.exit(2);
  }
})();
