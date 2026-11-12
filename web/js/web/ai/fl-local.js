// Foundry Local in the web edition: what the assistant needs besides the desktop code (desktop-core.js) and the bridge to the browser extension (fl-bridge.js).
//   - the model: which ids exist, which one is loaded, loading one (GET /models/load/{id or alias}), whether it can see pictures
//   - the provider of the assistant for a Foundry Local model: a plain provider (providers.js, kind "local", flavor "foundry") that, like the desktop app's
//     (src/main/foundry/local.js), loads the model when Foundry Local says "must be loaded before inference" and repeats the request
// Everything Foundry Local answers is untrusted text: ids are checked against MODEL_ID_RE, lists are capped.

// the rule of the desktop app (src/main/foundry/local.js) and of the extension (extension/policy.js)
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
// What suits a video assistant best (it has to look at pictures and follow instructions); the same list as the desktop app's. Aliases, as `foundry cache list` shows them.
export const PREFERRED = ['qwen3.5-4b', 'qwen3.5-2b', 'qwen3.5-0.8b', 'qwen3-vl-4b-instruct', 'qwen3-vl-2b-instruct'];
export const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_MODELS = 400;

export class FoundryError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'FoundryError';
    this.code = code;
    this.detail = detail || '';
  }
}

export const validId = (id) => typeof id === 'string' && MODEL_ID_RE.test(id);
const safeJson = (text) => { try { return JSON.parse(String(text || '').slice(0, 2 * 1024 * 1024)); } catch (e) { return null; } };
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* ------------------------------------------------------------------ what Foundry Local says */

// GET /v1/models -> the ids of the catalogue ({ data: [{ id }] }); only well-formed ids
export function parseModelIds(text) {
  const j = safeJson(text);
  const list = j && Array.isArray(j.data) ? j.data : [];
  const out = [];
  for (const m of list.slice(0, MAX_MODELS)) if (m && validId(m.id) && !out.includes(m.id)) out.push(m.id);
  return out;
}

// GET /models/loaded -> ["id", ...]
export function parseLoaded(text) {
  const j = safeJson(text);
  return Array.isArray(j) ? j.filter(validId).slice(0, 50) : [];
}

// The names the person can pick from: the recommended aliases that Foundry Local knows (an alias lets Foundry Local choose the variant that suits the computer), then
// every id of the catalogue. -> { recommended: [alias], ids: [id] }
export function suggestions(ids) {
  const list = Array.isArray(ids) ? ids.filter(validId) : [];
  const recommended = PREFERRED.filter((a) => list.some((id) => id.startsWith(a + '-')));
  const rank = (id) => { const i = PREFERRED.findIndex((a) => id.startsWith(a + '-')); return i < 0 ? 99 : i; };
  return { recommended, ids: list.slice().sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)) };
}

export const isRecommended = (name) => PREFERRED.some((a) => name === a || String(name).startsWith(a + '-'));

// the codes of the bridge (extension) -> the error the assistant shows
const BRIDGE_CODES = { NO_EXTENSION: 'FL_NO_BRIDGE', EXTENSION_RELOADED: 'FL_NO_BRIDGE', INTERRUPTED: 'FL_NO_BRIDGE', NOT_APPROVED: 'FL_NOT_APPROVED', NOT_FOUND: 'FL_NOT_FOUND', NETWORK: 'NETWORK', TIMEOUT: 'TIMEOUT', ABORTED: 'ABORTED', TOO_LARGE: 'BAD_REQUEST', BAD_REQUEST: 'BAD_REQUEST', ROUTE_NOT_ALLOWED: 'BAD_REQUEST' };
export const bridgeFailure = (code) => new FoundryError(BRIDGE_CODES[code] || 'NETWORK', 'The Foundry Local bridge failed: ' + code, code);

// GET /models/load/{id or alias} -> { modelId } | throws FoundryError
//   200 {"model_id": "...", "status": "loaded"}   400 "Model not cached: Model must be downloaded before loading"   404 "Model not found: No model matching '...'"
export async function loadModel(bridge, model, opts) {
  const o = opts || {};
  if (!validId(model)) throw new FoundryError('FL_BAD_MODEL', 'The model name is not valid');
  const r = await bridge.call('load', { modelId: model, timeoutMs: LOAD_TIMEOUT_MS, signal: o.signal });
  if (!r.ok) throw bridgeFailure(r.code);
  const j = safeJson(r.text);
  const said = clean(j && j.error && j.error.message ? j.error.message : r.text, 300);
  if (r.status === 200) {
    const id = j && typeof j.model_id === 'string' ? j.model_id : '';
    if (!validId(id)) throw new FoundryError('FL_LOAD_FAILED', 'Foundry Local answered without a model id', said);
    return { modelId: id };
  }
  if (r.status === 400 && /not cached|must be downloaded/i.test(said)) throw new FoundryError('FL_NOT_DOWNLOADED', 'The model is not downloaded', said);
  if (r.status === 404) throw new FoundryError('FL_BAD_MODEL', 'Foundry Local does not know this model', said);
  throw new FoundryError('FL_LOAD_FAILED', 'Foundry Local could not load the model', said || ('HTTP ' + r.status));
}

/* ------------------------------------------------------------------ the provider of the assistant */

// o: { model, inner (a provider of providers.js, kind "local", flavor "foundry", with the bridge's fetch), bridge, onPhase?(phase: 'loading'), signal? }
// A model that is not loaded (HTTP 400 "must be loaded before inference") is loaded, and the request is repeated.
export function createFoundryProvider(o) {
  const phase = (p) => { if (typeof o.onPhase === 'function') o.onPhase(p); };
  const notLoaded = (e) => !!e && /must be loaded/i.test(String(e.detail || '') + ' ' + String(e.message || ''));

  async function guarded(fn) {
    let loads = 0;
    for (;;) {
      try {
        return await fn(o.inner);
      } catch (e) {
        if (!e || e instanceof FoundryError || e.code === 'ABORTED') throw e;
        if (notLoaded(e) && loads < 2) {
          loads++;
          phase('loading');
          await loadModel(o.bridge, o.model, { signal: o.signal });
          continue;
        }
        throw e;
      }
    }
  }

  return {
    kind: 'local',
    model: o.model,
    toolsEmulated: () => (typeof o.inner.toolsEmulated === 'function' ? o.inner.toolsEmulated() : false),
    chat: (req) => guarded((p) => p.chat(req)),
    listModels: (req) => guarded((p) => p.listModels(req)),
  };
}

// Can the model look at pictures? A text model answers HTTP 400 "image or audio input requires a multimodal model"; the catalogue of Foundry Local's web service does
// not say (it only lists ids), so the question is asked: one small picture. -> true | false; anything else that goes wrong is thrown.
export async function probeVision(provider, pictureUrl, signal) {
  try {
    await provider.chat({
      system: 'Answer with one word.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What shape is in the picture?' }, { type: 'image_url', image_url: { url: pictureUrl } }] }],
      tools: [],
      signal,
    });
    return true;
  } catch (e) {
    const said = String((e && e.detail) || '') + ' ' + String((e && e.message) || '');
    if (e && (e.status === 400 || e.status === 422 || e.code === 'BAD_REQUEST') && /multimodal|image|vision|picture/i.test(said)) return false;
    throw e;
  }
}
