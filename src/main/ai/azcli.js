'use strict';
// Optional KEYLESS sign-in for Azure OpenAI and Microsoft Foundry (Microsoft Entra ID). Many companies switch API keys off for these
// resources; then the user's own Azure CLI ("az login") hands out a short-lived access token. This app never sees a password and stores
// nothing: the token lives in the memory of the main process (minutes) and travels only to the endpoint the user configured.
//
// The command is FIXED: az account get-access-token --resource <one of two constants> --query accessToken --output tsv
// Nothing the user typed is ever part of it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const AUDIENCES = { foundry: 'https://ai.azure.com', cognitive: 'https://cognitiveservices.azure.com' };
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,16384}$/;
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 45000;
// az.cmd / az.exe in a normal install location: no quotes, no cmd.exe metacharacters (%, ^, &, |, <, >, !).
const SAFE_PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9 _.()\-\\]+\.(?:cmd|bat|exe)$/i;

// Foundry endpoints take tokens for ai.azure.com; classic Azure OpenAI resources are documented with cognitiveservices.azure.com.
// The first audience is tried first; if the service answers 401 the caller retries with the other one.
const audiencesFor = (kind) => (kind === 'azure' ? [AUDIENCES.cognitive, AUDIENCES.foundry] : [AUDIENCES.foundry, AUDIENCES.cognitive]);

// Only the standard install folders of the Azure CLI (Program Files: writable by administrators only). Folders of the PATH are NOT searched: a
// directory that other users can write to must not be able to supply the program that is asked for a sign-in token.
function candidatePaths(env) {
  const list = [];
  for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (base) list.push(path.join(base, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin', 'az.cmd'));
  }
  return list;
}

function findAzCli(opts) {
  const o = opts || {};
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  const list = o.azPath ? [o.azPath] : candidatePaths(o.env || process.env);
  for (const p of list) if (SAFE_PATH_RE.test(p) && exists(p)) return p;
  return '';
}

function classify(stderr) {
  const s = String(stderr || '').toLowerCase();
  if (/az login|please run|not logged in|no subscription|interactive authentication|aadsts|az account set|refresh token|expired/.test(s)) return 'AZ_LOGIN';
  return 'AZ_FAILED';
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

// Runs the fixed command and resolves { ok:true, token } | { ok:false, code, detail }. `exec` is injectable for tests.
function runAz(azPath, audience, exec, signal) {
  const args = ['account', 'get-access-token', '--resource', audience, '--query', 'accessToken', '--output', 'tsv'];
  const opts = { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, cwd: os.tmpdir(), encoding: 'utf8' };
  if (signal) opts.signal = signal;
  let file = azPath;
  let fileArgs = args;
  if (/\.(?:cmd|bat)$/i.test(azPath)) {
    // .cmd files run through cmd.exe; the whole line is built here from constants and a path that passed SAFE_PATH_RE
    file = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    fileArgs = ['/d', '/s', '/c', '"' + '"' + azPath + '" ' + args.join(' ') + '"'];
    opts.windowsVerbatimArguments = true;
  }
  return new Promise((resolve) => {
    exec(file, fileArgs, opts, (err, stdout, stderr) => {
      if (err) {
        if (signal && signal.aborted) { resolve({ ok: false, code: 'ABORTED', detail: '' }); return; }
        if (err.code === 'ENOENT') { resolve({ ok: false, code: 'AZ_NOT_FOUND', detail: '' }); return; }
        if (err.killed || err.signal) { resolve({ ok: false, code: 'AZ_TIMEOUT', detail: '' }); return; }
        resolve({ ok: false, code: classify(stderr), detail: oneLine(stderr) });
        return;
      }
      const token = String(stdout || '').trim();
      if (!TOKEN_RE.test(token)) { resolve({ ok: false, code: 'AZ_OUTPUT', detail: '' }); return; }
      resolve({ ok: true, token });
    });
  });
}

// opts: { exec, azPath, env, now } - all optional (tests inject fakes).
function createAzTokens(opts) {
  const o = opts || {};
  const exec = o.exec || execFile;
  const now = o.now || Date.now;
  const cache = new Map();
  const locate = () => findAzCli({ azPath: o.azPath, env: o.env, exists: o.exists });
  return {
    available: () => !!locate(),
    async getToken(req) {
      const audience = req && req.audience;
      if (!Object.values(AUDIENCES).includes(audience)) return { ok: false, code: 'AZ_FAILED', detail: '' };
      const hit = cache.get(audience);
      if (hit && now() - hit.at < CACHE_MS) return { ok: true, token: hit.token };
      const az = locate();
      if (!az) return { ok: false, code: 'AZ_NOT_FOUND', detail: '' };
      const res = await runAz(az, audience, exec, req && req.signal);
      if (res.ok) cache.set(audience, { token: res.token, at: now() });
      return res;
    },
    forget(audience) { cache.delete(audience); },
    clear() { cache.clear(); },
  };
}

module.exports = { createAzTokens, findAzCli, audiencesFor, AUDIENCES, SAFE_PATH_RE };
