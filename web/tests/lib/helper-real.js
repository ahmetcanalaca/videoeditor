'use strict';
// The REAL Local AI helper with the REAL model, for the tests that need one (tests/local-ai.test.js, tests/ai-real.test.js). It needs the desktop app's
// model (%APPDATA%\VideoEditor\models) and engine (vendor\llama) on this machine; nothing is downloaded: the data folder of the helper is seeded with hard
// links to the model files and copies of the engine, so a test can use a folder with spaces and Turkish letters in its name.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const WEB = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(WEB, '..');
const SRC = path.join(WEB, 'local-ai');
const PS = 'powershell.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pins = () => JSON.parse(fs.readFileSync(path.join(SRC, 'pins.json'), 'utf8'));
const desktopModelDir = () => path.join(process.env.APPDATA || '', 'VideoEditor', 'models', 'qwen3.5-4b');

// true when the desktop app's model and engine are here (and VE_SKIP_REAL is not set)
function available() {
  if (process.env.VE_SKIP_REAL === '1') return false;
  const p = pins();
  const haveModel = p.model.files.every((f) => { const file = path.join(desktopModelDir(), f.name); return fs.existsSync(file) && fs.statSync(file).size === f.size; });
  const haveRuntime = ['vk', 'cpu'].every((k) => fs.existsSync(path.join(REPO, 'vendor', 'llama', k, 'llama-server.exe')));
  return haveModel && haveRuntime;
}

// a data folder for the helper: dataDir (created), with the model as hard links and the engine copied; returns dataDir
function seed(dataDir) {
  const p = pins();
  const modelDir = path.join(dataDir, 'models', 'qwen3.5-4b');
  fs.mkdirSync(modelDir, { recursive: true });
  for (const f of p.model.files) fs.linkSync(path.join(desktopModelDir(), f.name), path.join(modelDir, f.name));
  for (const k of ['vk', 'cpu']) {
    const dst = path.join(dataDir, 'runtime', p.llama.tag, k);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, 'vendor', 'llama', k))) fs.copyFileSync(path.join(REPO, 'vendor', 'llama', k, f), path.join(dst, f));
  }
  return dataDir;
}

// runs local-ai.ps1 with Windows PowerShell like a double-click would; returns { child, output(), done: Promise<exit code> }
function start(dataDir, args) {
  const env = Object.assign({}, process.env, { VE_LOCALAI_LANG: 'en' });
  delete env.PSModulePath;
  const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SRC, 'local-ai.ps1'), '-DataDir', dataDir, '-NoBrowser'].concat(args || []), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, output: () => out, done: new Promise((res) => child.on('exit', (code) => res(code))) };
}

// -Stop (from "another window"); resolves with { code, out }
function stop(dataDir) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { VE_LOCALAI_LANG: 'en' });
    delete env.PSModulePath;
    const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SRC, 'local-ai.ps1'), '-DataDir', dataDir, '-Stop'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const request = (port, method, p, o) => new Promise((resolve) => {
  const opts = o || {};
  const body = opts.body ? JSON.stringify(opts.body) : null;
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({}, opts.headers || {}, body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), timeout: opts.timeout || 8000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
  if (body) req.write(body);
  req.end();
});

async function waitHealth(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await request(port, 'GET', '/health', { timeout: 1500 })).status === 200) return true;
    await sleep(500);
  }
  return false;
}

const readKey = (dataDir) => fs.readFileSync(path.join(dataDir, 'key.txt'), 'utf8').trim();

module.exports = { available, seed, start, stop, request, waitHealth, readKey, pins, SRC, REPO, WEB };
