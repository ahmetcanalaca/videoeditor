'use strict';
// The models the built-in local assistant can use. Everything that makes a download trustworthy is pinned here:
//   - the exact repository REVISION (a commit, not "main"), so the bytes behind a URL never change,
//   - the size and the SHA-256 of every file (the SHA-256 values are the LFS object ids published by the model repository,
//     and were also checked against copies that had been downloaded and measured earlier),
//   - the hosts a download may talk to.
// A file is used only if its SHA-256 matches; there is no "trust on first use".

const HF = 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/';

const CATALOG = Object.freeze([
  Object.freeze({
    id: 'qwen3.5-4b',
    name: 'Qwen3.5-4B (Q4_K_M)',
    family: 'qwen3.5',
    // how this model writes bounding boxes: [x1,y1,x2,y2] on a 0..1000 grid (see perception/boxes.js)
    boxFormat: 'k1000',
    vision: true,
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-4B',
    source: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF',
    // memory the model + its cache needs while it is loaded (the app warns below this much free RAM)
    needsRamGb: 6,
    files: Object.freeze([
      Object.freeze({
        role: 'model',
        name: 'Qwen3.5-4B-Q4_K_M.gguf',
        aliases: [],
        url: HF + 'Qwen3.5-4B-Q4_K_M.gguf',
        size: 2740937888,
        sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
      }),
      Object.freeze({
        role: 'mmproj',
        name: 'Qwen3.5-4B-mmproj-F16.gguf',
        aliases: ['mmproj-F16.gguf'],
        url: HF + 'mmproj-F16.gguf',
        size: 672423616,
        sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864',
      }),
    ]),
  }),
]);

const DEFAULT_MODEL_ID = 'qwen3.5-4b';

// A download may only talk to these hosts (and subdomains of them): the model repository and its content delivery network.
const DOWNLOAD_HOSTS = Object.freeze(['huggingface.co', 'hf.co']);

function isAllowedDownloadUrl(raw, extraHosts) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return false; }
  const extra = extraHosts || [];
  // plain http only for the local servers that tests pass in as extra hosts
  const localTest = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && extra.includes(u.hostname);
  if (u.protocol !== 'https:' && !localTest) return false;
  if (u.username || u.password) return false;
  return DOWNLOAD_HOSTS.concat(extra).some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

function findModel(id, catalog) {
  return (catalog || CATALOG).find((m) => m.id === id) || null;
}

const totalBytes = (m) => m.files.reduce((s, f) => s + f.size, 0);

module.exports = { CATALOG, DEFAULT_MODEL_ID, DOWNLOAD_HOSTS, isAllowedDownloadUrl, findModel, totalBytes };
