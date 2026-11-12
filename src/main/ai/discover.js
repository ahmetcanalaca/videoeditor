'use strict';
// "Find local servers": looks on THIS computer (127.0.0.1 only) for model servers that speak the OpenAI protocol: Ollama, LM Studio,
// llama.cpp, Foundry Local. It runs only when the user presses the button and makes plain GET requests to loopback ports; nothing is sent.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const KNOWN = [
  { name: 'Ollama', port: 11434 },
  { name: 'LM Studio', port: 1234 },
  { name: 'llama.cpp', port: 8080 },
  { name: 'Foundry Local', port: 5272 }, // example endpoint of the Foundry Local docs; its real port is usually dynamic (see foundryCliPorts)
];
const MAX_BODY = 512 * 1024;
const PORT_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\b/gi;

function getJson(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let hard = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(hard); resolve(v); } };
    const req = http.get({ host: HOST, port, path: urlPath, timeout: timeoutMs, headers: { accept: 'application/json' }, agent: false }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(null); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); finish(null); } else chunks.push(c);
      });
      res.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(null); } });
      res.on('error', () => finish(null));
    });
    // the socket timeout only counts INACTIVITY: a server that trickles bytes must not be able to hold the search forever
    hard = setTimeout(() => { req.destroy(); finish(null); }, Math.max(timeoutMs * 2, 2000));
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s && s.length <= 300) : []);
// llama.cpp reports the model FILE as its id; the file name is what a person wants to see (the server ignores the name anyway)
const tidy = (id) => (/[\\/]/.test(id) ? id.split(/[\\/]/).filter(Boolean).pop() : id);

async function probePort(port, timeoutMs) {
  const [models, status, status14] = await Promise.all([getJson(port, '/v1/models', timeoutMs), getJson(port, '/openai/status', timeoutMs), getJson(port, '/status', timeoutMs)]);
  // Foundry Local reports its endpoints at /openai/status (before 0.14) or at /status (0.14 and later)
  const old = !!status && typeof status === 'object' && (Array.isArray(status.Endpoints) || 'ModelDirPath' in status);
  const modern = !!status14 && typeof status14 === 'object' && (Array.isArray(status14.endpoints) || typeof status14.modelCachePath === 'string');
  // Foundry Local 0.14 lists its whole catalogue at /v1/models (not the models that are on this computer), loads models only through its command line, and has its own option
  // in the settings (foundry/local.js): it is not offered here.
  if (modern) return { port, foundry: true, modern: true, models: [] };
  const foundry = old;
  let ids = models && Array.isArray(models.data) ? strings(models.data.map((m) => m && m.id)).map(tidy) : null;
  if (!ids && foundry) ids = strings(await getJson(port, '/openai/models', timeoutMs)).map(tidy);
  if (!ids) return null;
  return { port, foundry, models: ids };
}

// Foundry Local installs its command line as an app execution alias in the user's WindowsApps folder; the folders of the PATH are NOT searched
// (a program another user could plant in a shared tools folder would be run when the user presses "find local servers").
function findFoundryCli(env) {
  const names = ['foundry.exe'];
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
    }
  }
  return '';
}

function parsePorts(text) {
  const ports = [];
  let m;
  PORT_RE.lastIndex = 0;
  while ((m = PORT_RE.exec(String(text || ''))) !== null) {
    const n = Number(m[1]);
    if (n >= 1024 && n <= 65535 && !ports.includes(n)) ports.push(n);
  }
  return ports;
}

// Foundry Local starts on a dynamic port; its CLI reports the endpoint ("foundry server status"). Read-only, fixed arguments.
function foundryCliPorts(opts) {
  const o = opts || {};
  const exec = o.exec || execFile;
  const cli = o.cliPath !== undefined ? o.cliPath : findFoundryCli(o.env || process.env);
  if (!cli) return Promise.resolve([]);
  return new Promise((resolve) => {
    exec(cli, ['server', 'status'], { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024, cwd: os.tmpdir(), encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve(parsePorts(String(stdout || '') + '\n' + String(stderr || '')));
    });
  });
}

// opts: { ports?: number[] (replaces the well-known list: tests), timeoutMs?, exec?, cliPath?, env? }
async function discoverLocalServers(opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 1500;
  const nameOf = new Map(KNOWN.map((k) => [k.port, k.name]));
  let ports;
  if (Array.isArray(o.ports)) {
    ports = o.ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  } else {
    ports = KNOWN.map((k) => k.port);
    for (const p of await foundryCliPorts({ exec: o.exec, cliPath: o.cliPath, env: o.env })) if (!ports.includes(p)) ports.push(p);
  }
  const found = await Promise.all(ports.map((p) => probePort(p, timeoutMs)));
  return found.filter((f) => f && !f.modern).map((f) => ({
    name: f.foundry ? 'Foundry Local' : (nameOf.get(f.port) || 'OpenAI-compatible'),
    url: 'http://' + HOST + ':' + f.port + '/v1',
    models: f.models.slice(0, 300),
  }));
}

module.exports = { discoverLocalServers, foundryCliPorts, findFoundryCli, parsePorts, probePort };
