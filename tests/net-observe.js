'use strict';
// OS-level proof that the application does not "phone home": start the real packaged exe (normal product mode - no test hooks, no debug port)
// with a throw-away profile, let it run, and every 2 seconds list the TCP connections and UDP endpoints owned by the exe's whole process tree.
// Anything connected to a non-loopback address is a failure. (The renderer's own network block is tested in ui-safety.js; this looks at what the
// operating system actually sees, including Chromium's own services such as the network service, crash reporter, updater, DNS prefetch.)
//
//   node tests/net-observe.js [--exe=<path to VideoEditor.exe>] [--seconds=25]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : dflt; };
const EXE = path.resolve(arg('exe', process.env.VE_EXE || path.join(ROOT, 'dist', 'VideoEditor-win32-x64', 'VideoEditor.exe')));
const SECONDS = Math.max(6, Number(arg('seconds', '25')) || 25);
const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', '::', '[::1]']);

if (!fs.existsSync(EXE)) { console.error('not found: ' + EXE); process.exit(2); }

const PS = (rootPid) => `
$root = ${rootPid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -gt $n)
$tcp = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids.Contains([int]$_.OwningProcess) } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids.Contains([int]$_.OwningProcess) } | Select-Object LocalAddress,LocalPort,OwningProcess)
$names = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { $_.Name })
[pscustomobject]@{ pids = @($ids); names = $names; tcp = $tcp; udp = $udp } | ConvertTo-Json -Depth 4 -Compress
`;

const sample = (pid) => {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS(pid)], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 've-net-'));
  console.log('exe      : ' + EXE);
  console.log('profile  : ' + profile + ' (throw-away)');
  const child = spawn(EXE, ['--user-data-dir=' + profile], { stdio: 'ignore', detached: false });
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  const seen = new Map(); // key -> row
  const udp = new Map();
  const names = new Set();
  let samples = 0;
  let maxProcs = 0;
  const t0 = Date.now();
  let diedByItself = false;
  let exitCodeEarly = null;
  try {
    await sleep(3000);
    while (Date.now() - t0 < SECONDS * 1000 && !exited) {
      const r = sample(child.pid);
      samples++;
      maxProcs = Math.max(maxProcs, Array.isArray(r.pids) ? r.pids.length : (r.pids ? 1 : 0));
      (r.names || []).forEach((n) => names.add(n));
      for (const c of r.tcp || []) seen.set([c.LocalAddress, c.LocalPort, c.RemoteAddress, c.RemotePort, c.State].join('|'), c);
      for (const u of r.udp || []) udp.set(u.LocalAddress + ':' + u.LocalPort, u);
      await sleep(2000);
    }
    diedByItself = exited; // (before our own kill below: that makes the exit event fire as well)
    exitCodeEarly = exitCode;
  } finally {
    // the process tree we started (by PID, nothing else)
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* already gone */ }
    await sleep(1500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const rows = [...seen.values()];
  const external = rows.filter((c) => c.State !== 2 && c.State !== 'Listen' && !LOOPBACK.has(String(c.RemoteAddress)));
  const listening = rows.filter((c) => c.State === 2 || c.State === 'Listen');
  const loop = rows.filter((c) => !external.includes(c) && !listening.includes(c));
  console.log('samples  : ' + samples + ' over ' + Math.round((Date.now() - t0) / 1000) + ' s · processes seen: ' + [...names].sort().join(', '));
  console.log('TCP listening sockets : ' + listening.length + (listening.length ? '  ' + listening.map((c) => c.LocalAddress + ':' + c.LocalPort).join(', ') : ''));
  console.log('TCP loopback / local  : ' + loop.length);
  console.log('TCP to other hosts    : ' + external.length);
  for (const c of external) console.log('   !! ' + c.LocalAddress + ':' + c.LocalPort + ' -> ' + c.RemoteAddress + ':' + c.RemotePort + ' state ' + c.State + ' (pid ' + c.OwningProcess + ')');
  console.log('UDP endpoints         : ' + udp.size + (udp.size ? '  ' + [...udp.keys()].join(', ') : ''));
  const exposed = listening.filter((c) => !LOOPBACK.has(String(c.LocalAddress)) || String(c.LocalAddress) === '0.0.0.0' || String(c.LocalAddress) === '::');
  if (exposed.length) console.log('   note: listening on all interfaces: ' + exposed.map((c) => c.LocalAddress + ':' + c.LocalPort).join(', '));
  // the check means nothing unless the application was really up the whole time (a refused start or a crash would "observe" no connections at all)
  const notRunning = diedByItself || samples < 3 || maxProcs < 3;
  if (diedByItself) console.log('   !! the application exited on its own (exit code ' + exitCodeEarly + ') - nothing could be observed');
  const bad = external.length > 0 || exposed.length > 0 || notRunning;
  console.log(bad ? 'RESULT: FAIL - ' + (notRunning ? 'the application was not running during the observation.' : 'the application talks to the network or listens on a non-loopback address.') : 'RESULT: PASS - the application ran for the whole observation, no connection to any other host and no listening socket reachable from the network.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
