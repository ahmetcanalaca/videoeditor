'use strict';
// MANUAL test with the REAL llama-server (not part of `npm test`; needs the ~3.4 GB model files): what happens to the model process when the
// app is closed, when the model is stopped from the screen, or when the app is killed?
//   node tests/ui-llm-quit.js --models=<folder that contains qwen3.5-4b\...>        (VE_EXE=<VideoEditor.exe> tests the packaged application)
//   Q1  closing the window like a user does (not a kill): the app exits AND no llama-server is left
//   Q2  "Stop model" (pane button / llm:stop): the process is gone, the status says stopped, the next use starts it again
//   Q3  the app is killed hard (Task Manager, crash): the model process is stopped by the guard, or at the latest by the next start of the app
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, sleep, waitUntil } = require('./ui-lib');
const { OUT, step, assert, summary, ud } = require('./ui-helpers');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const MODELS = arg('models', '');
const SHOTS = path.join(OUT, 'shots');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// the llama-server processes that are children of this app (by parent id)
function llamaPids(parentPid) {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'llama-server.exe\'" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  let list = [];
  try { const j = JSON.parse(r.stdout || '[]'); list = Array.isArray(j) ? j : [j]; } catch (e) { list = []; }
  return list.filter((p) => !parentPid || p.ParentProcessId === parentPid).map((p) => p.ProcessId);
}
function closeMainWindow(pid) {
  spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
}

(async () => {
  if (!MODELS || !fs.existsSync(path.join(MODELS, 'qwen3.5-4b'))) { console.error('usage: node tests/ui-llm-quit.js --models=<folder that contains qwen3.5-4b\\...>'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const userData = ud('llm-quit');

  // start the app, point it at the model folder and let the open pane start the model (the same path a user takes)
  async function startWithModel(keep) {
    const app = await launch({ userData, port: 9442, keepUserData: !!keep });
    const ev = (e) => app.evaluate(e);
    const set = await ev(`window.api.llm.set({ modelDir: ${JSON.stringify(MODELS)} })`);
    assert(set.ok, 'llm:set ' + JSON.stringify(set.error));
    await ev('VE.ai.open()');
    await waitUntil(async () => (await ev("window.api.llm.status().then((s) => s.server.phase === 'ready' && s.model.state === 'ready')")) === true, 240000, 'the model to be started');
    const pids = llamaPids(app.child.pid);
    assert(pids.length === 1, 'expected ONE llama-server child of the app, found ' + JSON.stringify(pids));
    return { app, ev, pid: pids[0] };
  }

  let first = null;
  const only = arg('only', '').split(',').filter(Boolean);
  const want = (q) => !only.length || only.includes(q);
  try {
    if (want('Q1')) await step('Q1 closing the window (like a user): the app exits and NO llama-server is left', async () => {
      first = await startWithModel(false);
      console.log('      llama-server pid ' + first.pid + ' (child of the app, pid ' + first.app.child.pid + ')');
      closeMainWindow(first.app.child.pid);
      await waitUntil(() => first.app.exited() !== null, 20000, 'the app to exit after the window was closed');
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) { gone = !alive(first.pid); if (!gone) await sleep(100); }
      assert(gone, 'llama-server ' + first.pid + ' is still running after the app was closed');
      assert(llamaPids(first.app.child.pid).length === 0, 'a llama-server child is left');
      first = null;
    });

    if (want('Q2')) await step('Q2 "Stop model": the pane button stops the process, the status says stopped, and the next use starts it again', async () => {
      const s = await startWithModel(true);
      const btn = "document.querySelector('#ai-stop-model')";
      assert(await s.ev(`!!${btn} && !${btn}.hidden`), 'the stop button is not shown while the model runs');
      await s.app.screenshot(path.join(SHOTS, 'llm-quit-pane-running.png'));
      await s.ev(`${btn}.click()`);
      await waitUntil(async () => (await s.ev("window.api.llm.status().then((x) => x.server.phase)")) === 'stopped', 15000, 'the status to say stopped');
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) { gone = !alive(s.pid); if (!gone) await sleep(100); }
      assert(gone, 'llama-server ' + s.pid + ' is still running after "Stop model"');
      assert(await s.ev(`${btn}.hidden`), 'the stop button stays visible although nothing runs');
      // the next use starts it again on demand (ai:warm = what the first command triggers)
      await s.ev('window.api.ai.warm()');
      await waitUntil(async () => (await s.ev("window.api.llm.status().then((x) => x.server.phase)")) === 'ready', 240000, 'the model to start again');
      const again = llamaPids(s.app.child.pid);
      assert(again.length === 1 && again[0] !== s.pid, 'a new llama-server was expected: ' + JSON.stringify(again));
      // the same through the settings panel call
      const res = await s.ev('window.api.llm.stop()');
      assert(res.ok && res.status.server.phase === 'stopped', JSON.stringify(res).slice(0, 200));
      first = s; // closed in the next step
      // start once more for Q3
      await s.ev('window.api.ai.warm()');
      await waitUntil(async () => (await s.ev("window.api.llm.status().then((x) => x.server.phase)")) === 'ready', 240000, 'the model to start again (2)');
      s.pid = llamaPids(s.app.child.pid)[0];
      assert(s.pid, 'no llama-server for Q3');
    });

    if (want('Q3')) await step('Q3 the app is killed hard: the model process does not stay behind (guard) or is stopped by the next start of the app', async () => {
      const s = first || await startWithModel(true);
      const victim = s.pid;
      console.log('      killing the app (pid ' + s.app.child.pid + ') hard; llama-server pid ' + victim);
      s.app.cdp.close();
      s.app.child.kill(); // TerminateProcess on the main process only (what Task Manager "End task" on a hung app amounts to)
      await waitUntil(() => !alive(s.app.child.pid), 15000, 'the app to die'); // (a process killed by a signal reports no exit code)
      // other Chromium processes of the dead app end by themselves; give the guard / the system a moment
      let stillThere = alive(victim);
      for (let i = 0; i < 80 && stillThere; i++) { await sleep(100); stillThere = alive(victim); }
      console.log('      right after the kill: llama-server ' + (stillThere ? 'STILL RUNS (the next start has to stop it)' : 'is gone (Windows ends the children of a killed app: libuv puts them in a kill-on-close job; the pid-file clean-up of the next start is the fallback)'));
      if (stillThere) {
        const app2 = await launch({ userData, port: 9443, keepUserData: true });
        let gone = false;
        for (let i = 0; i < 120 && !gone; i++) { gone = !alive(victim); if (!gone) await sleep(100); }
        await app2.close();
        assert(gone, 'the leftover llama-server ' + victim + ' was not stopped by the next start of the app');
      }
      first = null;
    });
  } finally {
    if (first) { try { await first.app.close(); } catch (e) { /* ignore */ } }
  }
  const failed = summary('ui-llm-quit');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ui-llm-quit crashed:', e); process.exit(2); });
