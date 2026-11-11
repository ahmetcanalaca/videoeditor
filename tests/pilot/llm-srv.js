'use strict';
// Starts llama-server with an ARGUMENT ARRAY (no shell quoting problems), waits until it answers, keeps running until stopped.
//   node llm-srv.js --model=<file.gguf> [--port=18090] [--ctx=4096] [--threads=12] [--backend=cpu|vk] [--ngl=99] [--mmproj=<file>] [--thinking=0|1] [--extra="a b c"]
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer(o) {
  const backend = o.backend || 'cpu';
  const exe = path.join(ROOT, backend === 'vk' ? 'llama-vk' : 'llama-cpu', 'llama-server.exe');
  const args = ['-m', o.model, '--host', '127.0.0.1', '--port', String(o.port || 18090), '-c', String(o.ctx || 4096), '--jinja'];
  if (o.threads) args.push('-t', String(o.threads));
  if (backend === 'vk') args.push('-ngl', String(o.ngl == null ? 99 : o.ngl));
  else args.push('-ngl', '0');
  if (o.mmproj) args.push('--mmproj', o.mmproj); else args.push('--no-mmproj');
  if (o.thinking === '0') args.push('--chat-template-kwargs', '{"enable_thinking":false}');
  if (o.extra) args.push(...String(o.extra).split(' ').filter(Boolean));
  const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { text: '' };
  const keep = (d) => { log.text = (log.text + d.toString()).slice(-60000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return { child, log, args, exe };
}

async function waitReady(srv, port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (srv.child.exitCode !== null) throw new Error('llama-server exited early (' + srv.child.exitCode + ')\n' + srv.log.text.slice(-1500));
    if (await health(port)) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('llama-server not ready after ' + ms + ' ms\n' + srv.log.text.slice(-1500));
}

module.exports = { startServer, waitReady };

if (require.main === module) {
  const o = { model: arg('model'), port: Number(arg('port', '18090')), ctx: Number(arg('ctx', '4096')), threads: arg('threads'), backend: arg('backend', 'cpu'), ngl: arg('ngl'), mmproj: arg('mmproj'), thinking: arg('thinking', '0'), extra: arg('extra', '') };
  health(o.port).then((busy) => {
    if (busy) { console.log('FAILED port ' + o.port + ' is already served by another process'); process.exit(1); }
    const srv = startServer(o);
    console.log('exe : ' + srv.exe + '\nargs: ' + srv.args.join(' '));
    waitReady(srv, o.port, 240000).then((ms) => {
      console.log('READY pid=' + srv.child.pid + ' port=' + o.port + ' after ' + (ms / 1000).toFixed(1) + ' s');
      const hw = srv.log.text.split('\n').filter((l) => /device|Vulkan|backend|offload|model size|n_ctx|CPU/i.test(l)).slice(0, 8);
      hw.forEach((l) => console.log('  | ' + l.trim().slice(0, 150)));
    }).catch((e) => { console.log('FAILED ' + e.message); process.exit(1); });
    const stop = () => { try { srv.child.kill(); } catch (e) { /* gone */ } process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('exit', () => { try { srv.child.kill(); } catch (e) { /* gone */ } });
    srv.child.on('exit', (c) => { console.log('server exited ' + c); process.exit(0); });
  });
}
