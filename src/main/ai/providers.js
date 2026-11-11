'use strict';
/*
 * Provider-agnostic chat client with TOOL CALLING for the AI assistant (runs in the Electron main process).
 * The real fetch is injected (Electron session.fetch); tests inject Node's fetch against local mock servers.
 *
 * Normalized types
 *   ToolDef    = { name, description, parameters }   parameters: JSON-Schema subset { type:'object', properties, required } (type, properties, required, enum, description, items, minimum, maximum)
 *   ChatMsg    = { role:'user', content }
 *              | { role:'assistant', content, toolCalls?:[{ id, name, args }], raw? }
 *              | { role:'tool', results:[{ id, name, content, isError? }] }      results answer the toolCalls of the preceding assistant message
 *   ChatResult = { text, toolCalls:[{ id, name, args|null, argsError? }], raw, usage:{input,output}|null, stopReason:'end'|'tool_calls'|'length'|'filtered'|'other' }
 *   raw is the provider-native assistant payload (OpenAI: choices[0].message, Anthropic: content blocks, Gemini: candidate parts). It is stored on the
 *   assistant message and replayed verbatim (Gemini 3 and newer reject function-calling history without the thoughtSignature fields inside).
 *
 * Wire formats (checked against the official documentation):
 *   OpenAI Chat Completions + tools .... https://platform.openai.com/docs/api-reference/chat/create
 *   Azure OpenAI (classic + v1) ........ https://learn.microsoft.com/azure/foundry/openai/api-version-lifecycle  (v1: OpenAI clients with the key as Bearer on /openai/v1;
 *                                        classic: /openai/deployments/{deployment}/chat/completions?api-version=..., header api-key)
 *   Microsoft Foundry .................. https://learn.microsoft.com/azure/foundry/foundry-models/concepts/endpoints  (OpenAI-compatible v1 route of a resource: .../openai/v1, or of a
 *                                        project: https://RESOURCE.services.ai.azure.com/api/projects/PROJECT/openai/v1; API key or Microsoft Entra token as a bearer token)
 *   Local models ....................... Foundry Local, Ollama, LM Studio, llama.cpp: OpenAI-compatible server on this computer (no key needed, loopback only)
 *   Anthropic Messages + tool use ...... https://docs.anthropic.com/en/api/messages  and  .../build-with-claude/tool-use
 *   Gemini generateContent + functions . https://aistudio.google.com/docs/function-calling.md?generate-content=true  and  .../thought-signatures.md?generate-content=true
 *
 * Key hygiene: the key only ever travels in the auth header; it is never part of a URL, a thrown message, `detail` or `raw`.
 */

const PROVIDER_KINDS = ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local'];
const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1', azure: '', foundry: '', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com',
  local: 'http://127.0.0.1:11434/v1',
};
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const MAX_KEY = 16384; // Microsoft Entra access tokens are long; user-typed keys are limited to 4096 by the key store
// Wording of "this model cannot do tool calling" across Ollama, LM Studio, Azure/Foundry and OpenAI-compatible gateways.
const NO_TOOLS_RE = /(?:does(?:n't| not) support|not support(?:ed)?|unsupported|no support for)[^.\n]{0,60}\b(?:tools?|function[ _-]?calling|functions)\b|\b(?:tools?|function[ _-]?calling)\b[^.\n]{0,60}(?:not (?:supported|available|enabled)|unsupported)/i;
const AZURE_API_VERSION = '2024-10-21';
const ANTHROPIC_VERSION = '2023-06-01';

class AiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    const e = extra || {};
    this.name = 'AiError';
    this.code = code;
    this.status = e.status || 0;
    this.retryAfterMs = e.retryAfterMs == null ? null : e.retryAfterMs;
    this.detail = e.detail || '';
  }
}

/* ------------------------------------------------------------------ helpers */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function scrub(text, key) {
  let s = String(text == null ? '' : text);
  if (key) s = s.split(key).join('***');
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function parseArgs(value) {
  if (isObj(value)) return { args: value };
  if (value === undefined || value === null || value === '') return { args: {} };
  if (typeof value !== 'string') return { args: null, argsError: 'Arguments must be a JSON object' };
  try {
    const v = JSON.parse(value);
    return isObj(v) ? { args: v } : { args: null, argsError: 'Arguments must be a JSON object' };
  } catch (e) {
    return { args: null, argsError: 'Invalid JSON: ' + String(e.message).slice(0, 80) };
  }
}

function parseRetryAfter(header) {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  const d = Date.parse(header);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

function retryDelayFromBody(json) {
  const details = json && json.error && Array.isArray(json.error.details) ? json.error.details : [];
  for (const d of details) {
    const m = d && typeof d.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay) : null;
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  return null;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function httpError(cfg, res, text) {
  const json = safeJson(text);
  const err = json && json.error;
  const message = isObj(err) ? err.message : (typeof err === 'string' ? err : (json && json.message));
  const detail = scrub(message || text.slice(0, 300), cfg.apiKey);
  const status = res.status;
  const retryAfterMs = parseRetryAfter(res.headers && res.headers.get && res.headers.get('retry-after'));
  const hint = retryDelayFromBody(json);
  const extra = { status, detail, retryAfterMs: retryAfterMs != null ? retryAfterMs : hint };
  const codes = [isObj(err) && err.code, isObj(err) && err.type].filter((x) => typeof x === 'string');
  const quota = status === 402 || codes.some((c) => /insufficient_quota|billing_hard_limit_reached|billing_not_active/i.test(c)) || /credit balance is too low/i.test(String(message));
  if (quota) return new AiError('QUOTA', 'Quota or credit exhausted', extra);
  if ((status === 400 || status === 422 || status === 501) && NO_TOOLS_RE.test(String(message || text.slice(0, 500)))) return new AiError('NO_TOOLS', 'The model does not support tool calling', extra);
  if (status === 401) return new AiError('AUTH', 'Authentication failed', extra);
  if (status === 403) return new AiError('FORBIDDEN', 'Access denied', extra);
  if (status === 404) return new AiError('NOT_FOUND', 'Model or endpoint not found', extra);
  if (status === 429) return new AiError('RATE_LIMIT', 'Rate limit reached', extra);
  if (status === 408 || status >= 500) return new AiError('SERVER', 'Provider error (HTTP ' + status + ')', extra);
  return new AiError('BAD_REQUEST', 'The provider rejected the request (HTTP ' + status + ')', extra);
}

// Microsoft Foundry speaks the OpenAI "v1" protocol: https://RESOURCE.(openai|services.ai).azure.com/openai/v1 for a resource and
// https://RESOURCE.services.ai.azure.com/api/projects/PROJECT/openai/v1 for a project. The bare resource or project address is completed here.
function foundryPath(path) {
  if (/\/openai\/v1$/i.test(path)) return path;
  if (/\/openai$/i.test(path)) return path + '/v1';
  if (path === '' || /^\/models$/i.test(path)) return '/openai/v1';
  if (/^\/api\/projects\/[^/]+$/i.test(path)) return path + '/openai/v1';
  return path; // a gateway the user knows better
}

function validateConfig(o) {
  if (!o || !PROVIDER_KINDS.includes(o.kind)) throw new AiError('URL', 'Unknown provider kind');
  if (typeof o.fetch !== 'function') throw new AiError('URL', 'A fetch function is required');
  const raw = String(o.baseUrl == null ? '' : o.baseUrl).trim() || DEFAULT_BASE_URLS[o.kind];
  if (!raw) throw new AiError('URL', 'The endpoint URL is missing');
  let u;
  try { u = new URL(raw); } catch (e) { throw new AiError('URL', 'The endpoint URL is not valid'); }
  if (u.username || u.password || u.search || u.hash) throw new AiError('URL', 'The endpoint URL must not contain credentials, a query or a fragment');
  const local = LOCAL_HOSTS.includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AiError('URL', 'The endpoint must use https (http is only allowed for localhost)');
  if (o.kind === 'local' && !local) throw new AiError('URL', 'A local model must run on this computer (localhost or 127.0.0.1)');
  const key = String(o.apiKey == null ? '' : o.apiKey);
  // A local server needs no key; every other provider does (an Entra access token travels as the "key" with bearer: true).
  if ((key || o.kind !== 'local') && (!key || key.length > MAX_KEY || !/^[\x21-\x7e]+$/.test(key))) throw new AiError('URL', 'The API key has an invalid format');
  const model = String(o.model == null ? '' : o.model).trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new AiError('URL', 'The model name is invalid');
  const path = u.pathname.replace(/\/+$/, '');
  let basePath = path;
  if (o.kind === 'openai' && u.hostname === 'api.openai.com' && path === '') basePath = '/v1';
  else if (o.kind === 'local' && path === '') basePath = '/v1';
  else if (o.kind === 'foundry') basePath = foundryPath(path);
  return {
    kind: o.kind,
    baseUrl: u.origin + basePath,
    model,
    apiKey: key,
    bearer: o.bearer === true,
    fetch: o.fetch,
    apiVersion: String(o.apiVersion || AZURE_API_VERSION),
    sleep: typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // a model running on this computer may need a long time for the first answer (loading, CPU only)
    timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : (o.kind === 'local' ? 180000 : 90000),
    maxRetries: Number.isInteger(o.maxRetries) && o.maxRetries >= 0 ? o.maxRetries : 2,
  };
}

// A provider answer is a few KB; anything beyond this is a broken or hostile server and must not exhaust memory.
const MAX_BODY = 8 * 1024 * 1024;

async function readBody(res, max) {
  const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(len) && len > max) throw new AiError('BAD_RESPONSE', 'The provider response is too large');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const all = await res.text();
    if (all.length > max) throw new AiError('BAD_RESPONSE', 'The provider response is too large');
    return all;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
      throw new AiError('BAD_RESPONSE', 'The provider response is too large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

// One attempt. Resolves with parsed JSON; throws AiError.
async function sendOnce(cfg, spec, signal) {
  if (signal && signal.aborted) throw new AiError('ABORTED', 'Cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let res;
  let text;
  try {
    res = await cfg.fetch(spec.url, { method: spec.method || 'POST', headers: spec.headers, body: spec.body === undefined ? undefined : JSON.stringify(spec.body), signal: controller.signal });
    text = await readBody(res, MAX_BODY);
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (signal && signal.aborted) throw new AiError('ABORTED', 'Cancelled');
    if (timedOut) throw new AiError('TIMEOUT', 'The request timed out');
    throw new AiError('NETWORK', 'Network error', { detail: scrub(e && e.message, cfg.apiKey) });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (!res.ok) throw httpError(cfg, res, text);
  const json = safeJson(text);
  if (json === null) throw new AiError('BAD_RESPONSE', 'The provider returned a response that is not JSON', { status: res.status, detail: scrub(text.slice(0, 200), cfg.apiKey) });
  return json;
}

function abortableSleep(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(new AiError('ABORTED', 'Cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AiError('ABORTED', 'Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

async function send(cfg, spec, signal) {
  let attempt = 0;
  for (;;) {
    try {
      return await sendOnce(cfg, spec, signal);
    } catch (e) {
      if (!(e instanceof AiError)) throw e;
      const retryable = e.code === 'RATE_LIMIT' || e.code === 'SERVER' || e.code === 'NETWORK' || (e.code === 'TIMEOUT' && attempt < 1);
      if (!retryable || attempt >= cfg.maxRetries) throw e;
      const delay = Math.min(e.retryAfterMs != null ? e.retryAfterMs : 500 * Math.pow(2, attempt), 8000);
      attempt += 1;
      await abortableSleep(cfg.sleep, delay, signal);
    }
  }
}

const toolList = (tools) => (Array.isArray(tools) ? tools : []);
const emptySchema = () => ({ type: 'object', properties: {} });
const toText = (v) => (typeof v === 'string' ? v : JSON.stringify(v == null ? '' : v));

/* ------------------------------------------------------------------ OpenAI / Azure OpenAI */

function openaiMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: toText(m.content) });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ? String(m.content) : null };
      if (isObj(m.raw) && Array.isArray(m.raw.tool_calls) && m.raw.tool_calls.length) msg.tool_calls = m.raw.tool_calls;
      else if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args == null ? {} : c.args) } }));
      }
      if (!msg.tool_calls && msg.content === null) msg.content = '';
      out.push(msg);
    } else if (m.role === 'tool') {
      for (const r of m.results || []) out.push({ role: 'tool', tool_call_id: r.id, content: toText(r.content) });
    }
  }
  return out;
}

function openaiBody(cfg, req, withModel) {
  const body = {};
  if (withModel) body.model = cfg.model;
  body.messages = openaiMessages(req.system, req.messages);
  const tools = toolList(req.tools);
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || emptySchema() } }));
    body.tool_choice = 'auto';
  }
  // Cloud models keep their defaults (reasoning models reject sampling parameters). A small local model is steadier at a low
  // temperature and must not ramble until its context is full, so these two are only sent to a local server.
  if (cfg.kind === 'local') { body.temperature = 0.2; body.max_tokens = 1024; }
  return body;
}

// Reasoning models (DeepSeek-R1, Qwen3, ...) may put their thoughts into the content between <think> tags. They are not an answer.
const THINK_RE = /<think>[\s\S]*?(?:<\/think>|$)/gi;

function openaiParse(cfg, json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice || !isObj(choice.message)) throw new AiError('BAD_RESPONSE', 'The provider response has no message');
  let msg = choice.message;
  let text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '');
  if (/<think>/i.test(text)) {
    text = text.replace(THINK_RE, '').trim();
    msg = Object.assign({}, msg, { content: text || null });
  }
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((c) => c && isObj(c.function)).map((c, i) => {
    const p = parseArgs(c.function.arguments);
    const call = { id: c.id || 'call_' + (i + 1), name: String(c.function.name || ''), args: p.args };
    if (p.argsError) call.argsError = p.argsError;
    return call;
  });
  let stop = 'other';
  const fr = choice.finish_reason;
  if (fr === 'stop') stop = 'end'; else if (fr === 'tool_calls' || fr === 'function_call') stop = 'tool_calls'; else if (fr === 'length') stop = 'length'; else if (fr === 'content_filter') stop = 'filtered';
  if (toolCalls.length) stop = 'tool_calls';
  if (!text && !toolCalls.length && typeof msg.refusal === 'string' && msg.refusal) stop = 'filtered';
  const u = json.usage;
  return { text, toolCalls, raw: msg, usage: u ? { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 } : null, stopReason: stop };
}

// A local server usually needs no key: then no Authorization header is sent at all.
function openaiHeaders(cfg) {
  const h = { 'content-type': 'application/json' };
  if (cfg.apiKey) h.authorization = 'Bearer ' + cfg.apiKey;
  return h;
}

const OPENAI = {
  chat: (cfg, req) => ({ url: cfg.baseUrl + '/chat/completions', headers: openaiHeaders(cfg), body: openaiBody(cfg, req, true) }),
  parse: openaiParse,
  models: (cfg) => ({ method: 'GET', url: cfg.baseUrl + '/models', headers: openaiHeaders(cfg) }),
  parseModels: (json) => (json && Array.isArray(json.data) ? json.data.map((m) => m && m.id).filter((x) => typeof x === 'string') : []),
};

const azureV1 = (cfg) => /\/openai\/v1$/i.test(cfg.baseUrl);

const AZURE = {
  chat(cfg, req) {
    if (azureV1(cfg)) return { url: cfg.baseUrl + '/chat/completions', headers: openaiHeaders(cfg), body: openaiBody(cfg, req, true) };
    return {
      url: cfg.baseUrl + '/openai/deployments/' + encodeURIComponent(cfg.model) + '/chat/completions?api-version=' + encodeURIComponent(cfg.apiVersion),
      // an Entra ID access token (bearer: true) goes into Authorization, a resource key into api-key
      headers: cfg.bearer ? openaiHeaders(cfg) : { 'content-type': 'application/json', 'api-key': cfg.apiKey },
      body: openaiBody(cfg, req, false),
    };
  },
  parse: openaiParse,
  models: null, // data-plane keys cannot list deployments reliably
  parseModels: () => [],
};

// Chat Completions of the Foundry v1 route work for OpenAI models and for the other models of the catalog (DeepSeek, Llama, Grok, ...).
const FOUNDRY = {
  chat: (cfg, req) => ({ url: cfg.baseUrl + '/chat/completions', headers: openaiHeaders(cfg), body: openaiBody(cfg, req, true) }),
  parse: openaiParse,
  models: null, // the v1 route lists base models, not the deployments the user can call
  parseModels: () => [],
};

/* ------------------------------------------------------------------ Anthropic */

function anthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = last.content.concat(blocks); else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', [{ type: 'text', text: toText(m.content) }]);
    } else if (m.role === 'assistant') {
      let blocks;
      if (Array.isArray(m.raw) && m.raw.length) blocks = m.raw;
      else {
        blocks = [];
        if (m.content) blocks.push({ type: 'text', text: String(m.content) });
        for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: isObj(c.args) ? c.args : {} });
        if (!blocks.length) blocks.push({ type: 'text', text: '…' });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', (m.results || []).map((r) => {
        const block = { type: 'tool_result', tool_use_id: r.id, content: toText(r.content) };
        if (r.isError) block.is_error = true;
        return block;
      }));
    }
  }
  return out;
}

const anthropicHeaders = (cfg) => ({ 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION });

const ANTHROPIC = {
  chat(cfg, req) {
    const body = { model: cfg.model, max_tokens: 4096, messages: anthropicMessages(req.messages) };
    if (req.system) body.system = req.system;
    const tools = toolList(req.tools);
    if (tools.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || emptySchema() }));
      body.tool_choice = { type: 'auto' };
    }
    return { url: cfg.baseUrl + '/v1/messages', headers: anthropicHeaders(cfg), body };
  },
  parse(cfg, json) {
    const blocks = json && Array.isArray(json.content) ? json.content : null;
    if (!blocks) throw new AiError('BAD_RESPONSE', 'The provider response has no content');
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    const toolCalls = blocks.filter((b) => b && b.type === 'tool_use').map((b, i) => {
      const p = parseArgs(b.input);
      const call = { id: b.id || 'call_' + (i + 1), name: String(b.name || ''), args: p.args };
      if (p.argsError) call.argsError = p.argsError;
      return call;
    });
    let stop = 'other';
    const sr = json.stop_reason;
    if (sr === 'end_turn' || sr === 'stop_sequence') stop = 'end'; else if (sr === 'tool_use') stop = 'tool_calls'; else if (sr === 'max_tokens') stop = 'length'; else if (sr === 'refusal') stop = 'filtered';
    if (toolCalls.length) stop = 'tool_calls';
    const u = json.usage;
    return { text, toolCalls, raw: blocks, usage: u ? { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0 } : null, stopReason: stop };
  },
  models: (cfg) => ({ method: 'GET', url: cfg.baseUrl + '/v1/models?limit=100', headers: anthropicHeaders(cfg) }),
  parseModels: (json) => (json && Array.isArray(json.data) ? json.data.map((m) => m && m.id).filter((x) => typeof x === 'string') : []),
};

/* ------------------------------------------------------------------ Gemini */

const GEMINI_SCHEMA_KEYS = ['type', 'description', 'enum', 'minimum', 'maximum'];

// Gemini accepts an OpenAPI-style subset: unsupported keywords (additionalProperties, $schema, default, ...) are dropped.
function toGeminiSchema(schema) {
  if (!isObj(schema)) return { type: 'string' };
  const out = {};
  for (const k of GEMINI_SCHEMA_KEYS) if (schema[k] !== undefined) out[k] = schema[k];
  if (isObj(schema.properties)) {
    out.properties = {};
    for (const k of Object.keys(schema.properties)) out.properties[k] = toGeminiSchema(schema.properties[k]);
    if (Array.isArray(schema.required)) {
      const req = schema.required.filter((r) => r in out.properties);
      if (req.length) out.required = req;
    }
  }
  if (schema.items !== undefined) out.items = toGeminiSchema(schema.items);
  return out;
}

function geminiCallParts(parts) {
  return (parts || []).filter((p) => p && isObj(p.functionCall));
}

function geminiContents(messages) {
  const out = [];
  let lastCalls = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: toText(m.content) }] });
    } else if (m.role === 'assistant') {
      let parts;
      if (Array.isArray(m.raw) && m.raw.length) parts = m.raw;
      else {
        parts = [];
        if (m.content) parts.push({ text: String(m.content) });
        for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: isObj(c.args) ? c.args : {} } });
        if (!parts.length) parts.push({ text: '…' });
      }
      lastCalls = geminiCallParts(parts);
      out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: (m.results || []).map((r, i) => {
          const call = lastCalls[i] && lastCalls[i].functionCall;
          const parsed = typeof r.content === 'string' ? safeJson(r.content) : null;
          const fr = { name: r.name || (call && call.name) || 'tool', response: isObj(parsed) ? parsed : { result: toText(r.content) } };
          if (call && call.id) fr.id = call.id;
          return { functionResponse: fr };
        }),
      });
    }
  }
  return out;
}

const geminiHeaders = (cfg) => ({ 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey });

const GEMINI = {
  chat(cfg, req) {
    const model = cfg.model.replace(/^models\//, '');
    const body = { contents: geminiContents(req.messages) };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    const tools = toolList(req.tools);
    if (tools.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => {
          const decl = { name: t.name, description: t.description || '' };
          const params = toGeminiSchema(t.parameters || emptySchema());
          if (params.properties && Object.keys(params.properties).length) decl.parameters = params; // an empty OBJECT is rejected
          return decl;
        }),
      }];
    }
    return { url: cfg.baseUrl + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', headers: geminiHeaders(cfg), body };
  },
  parse(cfg, json) {
    const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
    if (!cand) {
      const block = json && json.promptFeedback && json.promptFeedback.blockReason;
      if (block) throw new AiError('FILTERED', 'The prompt was blocked', { detail: scrub(block, cfg.apiKey) });
      throw new AiError('BAD_RESPONSE', 'The provider response has no candidate');
    }
    const parts = cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
    const toolCalls = geminiCallParts(parts).map((p, i) => {
      const fc = p.functionCall;
      const parsed = parseArgs(fc.args);
      const call = { id: fc.id || 'call_' + (i + 1), name: String(fc.name || ''), args: parsed.args };
      if (parsed.argsError) call.argsError = parsed.argsError;
      return call;
    });
    let stop = 'other';
    const fr = cand.finishReason;
    if (fr === 'STOP') stop = 'end'; else if (fr === 'MAX_TOKENS') stop = 'length'; else if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(fr)) stop = 'filtered';
    if (toolCalls.length) stop = 'tool_calls';
    const u = json.usageMetadata;
    return { text, toolCalls, raw: parts, usage: u ? { input: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) } : null, stopReason: stop };
  },
  models: (cfg) => ({ method: 'GET', url: cfg.baseUrl + '/v1beta/models?pageSize=200', headers: geminiHeaders(cfg) }),
  parseModels: (json) => (json && Array.isArray(json.models)
    ? json.models.filter((m) => m && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent') && typeof m.name === 'string').map((m) => m.name.replace(/^models\//, ''))
    : []),
};

/* ------------------------------------------------------------------ public API */

const ADAPTERS = { openai: OPENAI, azure: AZURE, foundry: FOUNDRY, anthropic: ANTHROPIC, gemini: GEMINI, local: OPENAI };

function createProvider(opts) {
  const cfg = validateConfig(opts);
  const adapter = ADAPTERS[cfg.kind];
  return {
    kind: cfg.kind,
    model: cfg.model,
    async chat(req) {
      const r = req || {};
      const spec = adapter.chat(cfg, { system: r.system || '', messages: Array.isArray(r.messages) ? r.messages : [], tools: r.tools });
      const json = await send(cfg, spec, r.signal);
      return adapter.parse(cfg, json);
    },
    async listModels(req) {
      if (!adapter.models) return [];
      const json = await send(cfg, adapter.models(cfg), req && req.signal);
      return Array.from(new Set(adapter.parseModels(json))).sort();
    },
  };
}

module.exports = { createProvider, AiError, PROVIDER_KINDS, DEFAULT_BASE_URLS, toGeminiSchema };
