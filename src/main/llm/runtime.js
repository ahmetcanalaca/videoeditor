'use strict';
// Where the llama.cpp runtime (llama-server) lives, and which build to use.
//   packaged app : <resources>/llama/{cpu,vk}        (copied there by scripts/package.js from the pinned, SHA-256-checked vendor/llama)
//   development  : <project>/vendor/llama/{cpu,vk}   (npm run llama:fetch)
// "cpu" works everywhere; "vk" (Vulkan) uses the graphics chip - also an integrated one - and is clearly faster when the driver allows it.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXE = 'llama-server.exe';

function resolveRuntime(opts) {
  const o = opts || {};
  const roots = [];
  if (o.resourcesPath) roots.push(path.join(o.resourcesPath, 'llama'));
  roots.push(path.join(o.appRoot || path.join(__dirname, '..', '..', '..'), 'vendor', 'llama'));
  const out = { cpu: null, vk: null };
  for (const b of Object.keys(out)) {
    for (const r of roots) {
      const dir = path.join(r, b);
      if (fs.existsSync(path.join(dir, EXE))) { out[b] = dir; break; }
    }
  }
  return out;
}

const DEVICE_RE = /^\s*(Vulkan\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/gm;

// "Available devices:\n  Vulkan0: AMD Radeon(TM) Graphics (16269 MiB, 15456 MiB free)" -> [{ id, name, totalMiB, freeMiB }]
function parseDevices(text) {
  const out = [];
  let m;
  DEVICE_RE.lastIndex = 0;
  while ((m = DEVICE_RE.exec(String(text || ''))) !== null) out.push({ id: m[1], name: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) });
  return out;
}

// Asks the Vulkan build which graphics devices it can use. Never throws: a broken driver simply means "no devices".
function listDevices(vkDir, timeoutMs) {
  return new Promise((resolve) => {
    if (!vkDir) { resolve([]); return; }
    execFile(path.join(vkDir, EXE), ['--list-devices'], { cwd: vkDir, windowsHide: true, timeout: timeoutMs || 20000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve(err ? [] : parseDevices(String(stdout) + '\n' + String(stderr)));
    });
  });
}

module.exports = { resolveRuntime, parseDevices, listDevices, EXE };
