'use strict';
// Tiny JSON settings store in the per-user data folder (no registry, no admin rights).
const fs = require('fs');
const path = require('path');
const { classify } = require('./media-guard');

const AI_PROVIDERS = ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local', 'builtin'];
// How the user signs in: an API key, or (Azure OpenAI / Microsoft Foundry only) Microsoft Entra ID through the Azure CLI.
const AI_AUTH = ['key', 'entra'];
// Built-in local model: where the graphics chip or the CPU runs it.
const LLM_BACKENDS = ['auto', 'cpu', 'vk'];
// Azure Content Understanding (video analysis of the Foundry provider): where the service may process the data, and what an analyzer is called.
// (The same values as ai/content-understanding.js; a test keeps them equal. This file must stay free of heavy requires.)
const CU_LOCATIONS = ['geography', 'dataZone', 'global'];
const CU_ANALYZER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CU_DEFAULT_ANALYZER = 'prebuilt-videoSearch';

const DEFAULTS = Object.freeze({
  language: 'tr',
  theme: 'dark',
  export: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' },
  lastDirs: { open: '', project: '', export: '' },
  previewVolume: 1,
  previewMuted: false,
  window: { width: 1320, height: 820, maximized: false },
  // AI assistant (optional). The API key is NOT part of the settings: see ai/secrets.js. cu = video analysis with Azure Content Understanding
  // (Foundry provider only; off until the user switches it on, and every upload is confirmed in a native dialog).
  ai: { provider: 'builtin', baseUrl: '', model: '', apiVersion: '', shareNames: true, auth: 'key', cu: { enabled: false, endpoint: '', analyzer: CU_DEFAULT_ANALYZER, location: 'geography' } },
  // The built-in local model (see llm/): folder of the model files ('' = the app's own data folder), graphics chip / CPU, minutes of idleness until it is unloaded (0 = never).
  llm: { modelDir: '', backend: 'auto', idleMinutes: 10 },
});

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, patch) {
  const out = Object.assign({}, target);
  for (const key of Object.keys(patch || {})) {
    if (isPlainObject(patch[key]) && isPlainObject(out[key])) out[key] = deepMerge(out[key], patch[key]);
    else out[key] = patch[key];
  }
  return out;
}

// Only values of the expected shape survive (defends against hand-edited or corrupted files).
function sanitize(s) {
  const out = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), isPlainObject(s) ? s : {});
  for (const k of Object.keys(DEFAULTS)) if (isPlainObject(DEFAULTS[k]) && !isPlainObject(out[k])) out[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
  if (out.language !== 'tr' && out.language !== 'en') out.language = 'tr';
  if (out.theme !== 'dark' && out.theme !== 'light') out.theme = 'dark';
  const e = out.export;
  if (!['original', '1080', '720', '480'].includes(String(e.resolution))) e.resolution = 'original';
  if (!['auto', '16:9', '9:16', '1:1', '4:3'].includes(String(e.aspect))) e.aspect = 'auto';
  if (!['auto', '24', '25', '30', '50', '60'].includes(String(e.fps))) e.fps = 'auto';
  if (!['high', 'medium', 'low'].includes(String(e.quality))) e.quality = 'high';
  e.resolution = String(e.resolution);
  e.fps = String(e.fps);
  out.previewVolume = Math.min(1, Math.max(0, Number(out.previewVolume) || 0));
  out.previewMuted = !!out.previewMuted;
  const w = out.window;
  w.width = Math.min(8000, Math.max(900, Number(w.width) || DEFAULTS.window.width));
  w.height = Math.min(6000, Math.max(600, Number(w.height) || DEFAULTS.window.height));
  w.maximized = !!w.maximized;
  // only the known sections and keys survive: a hand-edited file (or a script in the page) cannot grow settings.json with anything else
  for (const k of Object.keys(out)) if (!(k in DEFAULTS)) delete out[k];
  for (const k of ['export', 'window', 'lastDirs']) for (const key of Object.keys(out[k])) if (!(key in DEFAULTS[k])) delete out[k][key];
  // last-used folders are only ever offered to a file dialog: a folder on this computer (a network path would make Windows contact the share)
  for (const k of Object.keys(out.lastDirs)) {
    const v = out.lastDirs[k];
    out.lastDirs[k] = typeof v === 'string' && v.length <= 500 && path.isAbsolute(v) && classify(path.resolve(v)) === 'local' ? v : '';
  }
  const ai = out.ai;
  if (!AI_PROVIDERS.includes(ai.provider)) ai.provider = DEFAULTS.ai.provider;
  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  ai.baseUrl = text(ai.baseUrl, 300);
  ai.model = text(ai.model, 200);
  ai.apiVersion = text(ai.apiVersion, 40);
  ai.shareNames = ai.shareNames !== false;
  if (!AI_AUTH.includes(ai.auth) || (ai.provider !== 'azure' && ai.provider !== 'foundry')) ai.auth = 'key';
  const cu = isPlainObject(ai.cu) ? ai.cu : {};
  ai.cu = {
    enabled: cu.enabled === true,
    endpoint: text(cu.endpoint, 300),
    analyzer: typeof cu.analyzer === 'string' && CU_ANALYZER_RE.test(cu.analyzer) ? cu.analyzer : CU_DEFAULT_ANALYZER,
    location: CU_LOCATIONS.includes(cu.location) ? cu.location : DEFAULTS.ai.cu.location,
  };
  // Hand-edited files must never smuggle a secret into settings.json.
  for (const k of Object.keys(ai)) if (!(k in DEFAULTS.ai)) delete ai[k];
  const llm = out.llm;
  llm.modelDir = text(llm.modelDir, 300);
  // a folder on this computer only: a hand-edited file (or a compromised page through settings:set) must not point the model store at a network
  // share (NTLM hash leak, frozen main thread), a URL, a device path or a relative path (same rules as llm:set)
  if (llm.modelDir && (!path.isAbsolute(llm.modelDir) || classify(path.resolve(llm.modelDir)) !== 'local')) llm.modelDir = '';
  if (!LLM_BACKENDS.includes(llm.backend)) llm.backend = DEFAULTS.llm.backend;
  const idle = Math.round(Number(llm.idleMinutes));
  llm.idleMinutes = Number.isFinite(idle) ? Math.min(240, Math.max(0, idle)) : DEFAULTS.llm.idleMinutes;
  for (const k of Object.keys(llm)) if (!(k in DEFAULTS.llm)) delete llm[k];
  return out;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.timer = null;
    try {
      this.data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      this.data = sanitize({});
    }
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  update(patch) {
    this.data = sanitize(deepMerge(this.data, isPlainObject(patch) ? patch : {}));
    this.scheduleSave();
    return this.get();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // settings are a convenience; never crash because of them
    }
  }
}

module.exports = { SettingsStore, DEFAULTS, sanitize, AI_PROVIDERS, AI_AUTH, LLM_BACKENDS, CU_LOCATIONS, CU_ANALYZER_RE, CU_DEFAULT_ANALYZER };
