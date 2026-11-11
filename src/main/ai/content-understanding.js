'use strict';
/*
 * Azure Content Understanding (Microsoft Foundry Tools): video analysis through the REST API.
 *
 * Wire format (checked against the official documentation, API version 2025-11-01 = GA):
 *   Quickstart ... https://learn.microsoft.com/azure/ai-services/content-understanding/quickstart/use-rest-api
 *   Limits ....... https://learn.microsoft.com/azure/ai-services/content-understanding/service-limits   (analyzeBinary: video <= 200 MB and <= 30 min,
 *                  min 320 x 240, max 1920 x 1080; frames are sampled at about 1 per second and scaled to 512 x 512)
 *   Reference .... https://learn.microsoft.com/rest/api/contentunderstanding/content-analyzers/analyze-binary?view=rest-contentunderstanding-2025-11-01
 *
 *   POST   {endpoint}/contentunderstanding/analyzers/{analyzerId}:analyzeBinary?api-version=..&processingLocation=..   body: the video bytes
 *          -> 202 Accepted + Operation-Location header
 *   GET    Operation-Location (poll)  -> { id, status: NotStarted | Running | Succeeded | Failed | Canceled, result?, error?, usage? }
 *   DELETE {endpoint}/contentunderstanding/analyzerResults/{id}?api-version=..      (204; the service keeps results for up to 24 hours otherwise)
 *   GET    {endpoint}/contentunderstanding/defaults                                    -> { modelDeployments: { "gpt-4.1": "<deployment>", ... } }
 *   GET    {endpoint}/contentunderstanding/analyzers/{analyzerId}
 * Authentication: header Ocp-Apim-Subscription-Key (resource key) or Authorization: Bearer (Microsoft Entra token for https://cognitiveservices.azure.com).
 * {endpoint} is the ROOT of the Foundry resource (https://NAME.services.ai.azure.com), not a project address.
 *
 * Pure module: fetch, sleep and the clock are injected; no Electron, no files. Key hygiene as in providers.js: a secret only ever travels in a header and is
 * scrubbed from every message that leaves this module.
 */
const crypto = require('crypto');
const { AiError } = require('./providers');
const { validateBaseUrl } = require('./net');

const API_VERSION = '2025-11-01';
const DEFAULT_ANALYZER = 'prebuilt-videoSearch';
const ANALYZER_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Where the service may process the data (analyze parameter processingLocation); the service's own default is "global" = any Azure data centre.
const LOCATIONS = ['geography', 'dataZone', 'global'];
const DEFAULT_LOCATION = 'geography';

const MAX_JSON = 24 * 1024 * 1024;
const MAX_SHOTS = 20000; // camera-shot times kept from one analysis (a 2-hour video has a few thousand)
const REQUEST_TIMEOUT_MS = 90 * 1000;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_FIRST_MS = 2000;
const POLL_MAX_MS = 8000;
const POLL_HICCUPS = 6; // consecutive failed polls (network, 5xx, 429) before an expensive operation is given up
const DELETE_WAIT_MS = 5000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeJson = (text) => { try { return JSON.parse(text); } catch (e) { return null; } };

/* ------------------------------------------------------------------ endpoint */

// The resource root a Content Understanding request goes to, derived from what the user typed for the chat model (project / resource address):
//   https://NAME.services.ai.azure.com[/api/projects/P]   -> same origin
//   https://NAME.cognitiveservices.azure.com              -> same origin
//   https://NAME.openai.azure.com                         -> https://NAME.services.ai.azure.com (the Foundry address of the same resource name)
//   http://127.0.0.1:PORT (tests, a local gateway)        -> same origin
// Anything else (a company gateway) is unknown: ''.
function deriveEndpoint(chatUrl) {
  const v = validateBaseUrl(chatUrl);
  if (!v.ok) return '';
  const host = new URL(v.origin).hostname.toLowerCase();
  if (v.local || /\.(?:services\.ai|cognitiveservices)\.azure\.com$/.test(host)) return v.origin;
  const m = /^([a-z0-9-]+)\.openai\.azure\.com$/.exec(host);
  return m ? 'https://' + m[1] + '.services.ai.azure.com' : '';
}

// What the user typed as "Content Understanding address": only the origin counts (a pasted project or API path is cut off).
function validateEndpoint(raw) {
  const v = validateBaseUrl(raw);
  if (!v.ok) return v;
  return { ok: true, origin: v.origin, local: v.local };
}

/* ------------------------------------------------------------------ errors */

function scrubAll(text, secrets) {
  let s = String(text == null ? '' : text);
  for (const k of secrets) if (k) s = s.split(k).join('***');
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// The service's own error object ({ error: { code, message, details[] } }) or a failed operation's `error`.
function serviceMessage(json) {
  const e = json && (json.error || json);
  if (!isObj(e)) return { code: '', message: typeof e === 'string' ? e : '' };
  return { code: typeof e.code === 'string' ? e.code : '', message: typeof e.message === 'string' ? e.message : '' };
}

// Failure of a request or of the analysis itself -> a code the UI has a sentence for.
function classifyService(status, code, message) {
  // only the start of the text matters; the cap keeps the patterns below cheap whatever the service sends
  const text = (code + ' ' + message).slice(0, 600).toLowerCase();
  if (/processing ?location|data ?zone|geograph/.test(text)) return 'CU_LOCATION';
  if (/default|deployment|model/.test(text) && /not (?:found|configured|set|specified)|missing|no .*(?:default|deployment)|must be|required|unavailable|disabled/.test(text)) return 'CU_NO_DEFAULTS';
  if (/unsupported|invalid (?:video|file|content|media|input)|corrupt|cannot be (?:read|decoded|processed)|too (?:large|long|short|small)|resolution|duration/.test(text)) return 'CU_UNSUPPORTED';
  if (status === 401) return 'AUTH';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'CU_UNSUPPORTED';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || status >= 500) return 'SERVER';
  return status ? 'BAD_REQUEST' : 'CU_FAILED';
}

function parseRetryAfter(header) {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, Math.min(Math.round(n * 1000), 60000));
  return null;
}

/* ------------------------------------------------------------------ client */

// opts: { endpoint (origin), fetch, auth(refresh?) -> Promise<{ name, value }>, analyzerId, apiVersion, processingLocation, sleep, now, timeoutMs,
//         maxWaitMs (longest wait for one analysis) }
function createCuClient(opts) {
  const o = opts || {};
  if (typeof o.fetch !== 'function' || typeof o.auth !== 'function') throw new AiError('URL', 'A fetch function and an auth function are required');
  const ep = validateEndpoint(o.endpoint);
  if (!ep.ok) throw new AiError('URL', 'The Content Understanding address is not valid');
  const analyzerId = ANALYZER_RE.test(String(o.analyzerId || '')) ? String(o.analyzerId) : DEFAULT_ANALYZER;
  const apiVersion = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-preview)?$/.test(String(o.apiVersion || '')) ? String(o.apiVersion) : API_VERSION;
  const location = LOCATIONS.includes(o.processingLocation) ? o.processingLocation : DEFAULT_LOCATION;
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const origin = ep.origin;
  const secrets = new Set();

  const abortableSleep = (ms, signal) => {
    if (!signal) return sleep(ms);
    if (signal.aborted) return Promise.reject(new AiError('ABORTED', 'Cancelled'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new AiError('ABORTED', 'Cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      sleep(ms).then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  };

  // The credential only ever goes to the configured origin: a URL the service hands back (Operation-Location) is checked first.
  function sameOrigin(url) {
    try { return new URL(url).origin === origin; } catch (e) { return false; }
  }

  // One HTTP exchange. Resolves { status, headers, text }; throws AiError for transport problems only (HTTP errors are the caller's business).
  async function exchange(spec, signal, refresh) {
    if (signal && signal.aborted) throw new AiError('ABORTED', 'Cancelled');
    if (!sameOrigin(spec.url)) throw new AiError('BAD_RESPONSE', 'The service referred to another address than the configured one; not followed');
    const cred = await o.auth(!!refresh);
    if (!cred || typeof cred.name !== 'string' || typeof cred.value !== 'string' || !cred.value) throw new AiError('AUTH', 'No credential available');
    secrets.add(cred.value);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, spec.timeoutMs || o.timeoutMs || REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const headers = Object.assign({ accept: 'application/json' }, spec.headers || {}, { [cred.name]: cred.value });
      const res = await o.fetch(spec.url, { method: spec.method, headers, body: spec.body, signal: controller.signal });
      const text = await readText(res, spec.maxBytes || MAX_JSON);
      return { status: res.status, ok: res.ok, headers: res.headers, text };
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (signal && signal.aborted) throw new AiError('ABORTED', 'Cancelled');
      if (timedOut) throw new AiError('TIMEOUT', 'The request timed out');
      throw new AiError('NETWORK', 'Network error', { detail: scrubAll(e && e.message, secrets) });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // exchange + one retry with a fresh credential after a 401 (an Entra token may have been revoked or expired early)
  async function call(spec, signal) {
    let r = await exchange(spec, signal, false);
    if (r.status === 401) r = await exchange(spec, signal, true);
    return r;
  }

  function httpFailure(r, what) {
    const json = safeJson(r.text);
    const sm = serviceMessage(json);
    const code = classifyService(r.status, sm.code, sm.message);
    const extra = { status: r.status, detail: scrubAll(sm.message || r.text.slice(0, 300), secrets), retryAfterMs: parseRetryAfter(r.headers && r.headers.get && r.headers.get('retry-after')) };
    return new AiError(code, what + ' (HTTP ' + r.status + ')', extra);
  }

  const url = (path, query) => origin + path + '?' + new URLSearchParams(Object.assign({ 'api-version': apiVersion }, query || {})).toString();

  // GET defaults + GET analyzer: nothing is uploaded or processed. -> { defaults: { model: deployment }, analyzerOk }
  async function testConnection(signal) {
    const d = await call({ method: 'GET', url: url('/contentunderstanding/defaults') }, signal);
    if (!d.ok) throw httpFailure(d, 'Content Understanding defaults');
    const dj = safeJson(d.text);
    const deployments = dj && isObj(dj.modelDeployments) ? dj.modelDeployments : null;
    if (!deployments) throw new AiError('BAD_RESPONSE', 'The service answered, but not like Content Understanding does');
    const defaults = {};
    for (const k of Object.keys(deployments).slice(0, 20)) if (typeof deployments[k] === 'string') defaults[k.slice(0, 80)] = deployments[k].slice(0, 80);
    const a = await call({ method: 'GET', url: url('/contentunderstanding/analyzers/' + encodeURIComponent(analyzerId)) }, signal);
    if (a.status === 404) throw new AiError('CU_NO_ANALYZER', 'Analyzer "' + analyzerId + '" does not exist', { status: 404 });
    if (!a.ok) throw httpFailure(a, 'Content Understanding analyzer');
    return { defaults, defaultsSet: Object.keys(defaults).length > 0, analyzerOk: true, apiVersion, analyzerId, processingLocation: location };
  }

  // Uploads the bytes and waits for the result. onStatus({ phase: 'uploading'|'waiting', status?, elapsedMs }) for the progress display.
  // -> { result (AnalysisResult), usage, operationId }
  async function analyze(req) {
    const r = req || {};
    if (!(r.bytes && r.bytes.length > 0)) throw new AiError('BAD_REQUEST', 'Nothing to analyze');
    const onStatus = typeof r.onStatus === 'function' ? r.onStatus : () => {};
    const signal = r.signal || null;
    const t0 = now();
    onStatus({ phase: 'uploading', elapsedMs: 0 });
    const post = await call({
      method: 'POST',
      url: url('/contentunderstanding/analyzers/' + encodeURIComponent(analyzerId) + ':analyzeBinary', { processingLocation: location }),
      headers: { 'content-type': r.contentType || 'application/octet-stream', 'x-ms-client-request-id': crypto.randomUUID() },
      body: r.bytes,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }, signal);
    if (post.status !== 202 && post.status !== 200) throw httpFailure(post, 'Content Understanding analyze');
    const opLoc = post.headers && post.headers.get ? post.headers.get('operation-location') : '';
    const postJson = safeJson(post.text);
    if (post.status === 200 && postJson && postJson.status === 'Succeeded' && postJson.result) return { result: postJson.result, usage: postJson.usage || null, operationId: '' };
    if (!opLoc || !sameOrigin(opLoc) || !/\/contentunderstanding\/analyzerResults\/[^/?#\s]+/.test(opLoc)) throw new AiError('BAD_RESPONSE', 'The service did not return a usable Operation-Location');
    const opId = decodeURIComponent(/\/analyzerResults\/([^/?#]+)/.exec(opLoc)[1]);
    const maxWait = o.maxWaitMs || 25 * 60 * 1000;
    let delay = POLL_FIRST_MS;
    let hiccups = 0;
    try {
      for (;;) {
        await abortableSleep(delay, signal);
        const elapsed = now() - t0;
        let res;
        try {
          res = await call({ method: 'GET', url: opLoc }, signal);
          if (!res.ok && (res.status === 429 || res.status >= 500 || res.status === 408)) throw httpFailure(res, 'Content Understanding result');
        } catch (e) {
          if (!(e instanceof AiError) || e.code === 'ABORTED' || !(e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'RATE_LIMIT' || e.code === 'SERVER') || ++hiccups > POLL_HICCUPS) throw e;
          delay = Math.min(POLL_MAX_MS, Math.max(delay, e.retryAfterMs || 0) * 1.5);
          continue;
        }
        hiccups = 0;
        if (!res.ok) throw httpFailure(res, 'Content Understanding result');
        const json = safeJson(res.text);
        if (!isObj(json)) throw new AiError('BAD_RESPONSE', 'The result is not JSON', { detail: scrubAll(res.text.slice(0, 200), secrets) });
        const status = String(json.status || '').toLowerCase();
        onStatus({ phase: 'waiting', status, elapsedMs: elapsed });
        if (status === 'succeeded') {
          if (!isObj(json.result)) throw new AiError('BAD_RESPONSE', 'The analysis succeeded but has no result');
          return { result: json.result, usage: isObj(json.usage) ? json.usage : null, operationId: opId };
        }
        if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
          const sm = serviceMessage(json.error);
          throw new AiError(classifyService(0, sm.code, sm.message), 'The analysis ' + (status === 'failed' ? 'failed' : 'was cancelled'), { detail: scrubAll((sm.code ? sm.code + ': ' : '') + sm.message, secrets) });
        }
        if (elapsed > maxWait) throw new AiError('TIMEOUT', 'The analysis did not finish in time');
        const hinted = parseRetryAfter(res.headers && res.headers.get && res.headers.get('retry-after'));
        delay = hinted != null ? Math.max(1000, hinted) : Math.min(POLL_MAX_MS, Math.round(delay * 1.25));
      }
    } catch (e) {
      // a cancelled / failed wait leaves a result at the service: ask for its deletion (best effort, bounded, never hides the error)
      if (e && e.code === 'ABORTED') await settleDelete(opId);
      throw e;
    }
  }

  // deleteResult, but never longer than a few seconds: the caller waits for it so that the request is not over (and the network window closed) before
  async function settleDelete(operationId) {
    let timer = null;
    try {
      await Promise.race([deleteResult(operationId), new Promise((resolve) => { timer = setTimeout(resolve, DELETE_WAIT_MS); })]);
    } catch (e) { /* best effort */ } finally {
      clearTimeout(timer);
    }
  }

  // The service keeps results for up to 24 hours; once they are stored on this computer the copy at the service is not needed any more.
  async function deleteResult(operationId) {
    if (!operationId || !/^[A-Za-z0-9._-]{1,128}$/.test(operationId)) return false;
    try {
      const res = await exchange({ method: 'DELETE', url: url('/contentunderstanding/analyzerResults/' + encodeURIComponent(operationId)), timeoutMs: 20000 }, null, false);
      return res.status === 204 || res.status === 200;
    } catch (e) {
      return false;
    }
  }

  return { testConnection, analyze, deleteResult: settleDelete, analyzerId, apiVersion, processingLocation: location, origin };
}

// Response text with a size limit (a broken or hostile server must not exhaust memory).
async function readText(res, max) {
  const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(len) && len > max) throw new AiError('BAD_RESPONSE', 'The service response is too large');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const all = await res.text();
    if (all.length > max) throw new AiError('BAD_RESPONSE', 'The service response is too large');
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
      throw new AiError('BAD_RESPONSE', 'The service response is too large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/* ------------------------------------------------------------------ result -> scenes */

const sec = (ms) => Math.round(Number(ms)) / 1000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// A field of the result ({ type, valueString | valueNumber | ... | valueArray | valueObject }) as a plain JSON value.
function fieldValue(f, depth) {
  if (!isObj(f) || depth > 4) return null;
  if (typeof f.valueString === 'string') return clip(f.valueString, 2000);
  for (const k of ['valueNumber', 'valueInteger']) if (typeof f[k] === 'number') return f[k];
  if (typeof f.valueBoolean === 'boolean') return f.valueBoolean;
  for (const k of ['valueDate', 'valueTime']) if (typeof f[k] === 'string') return clip(f[k], 40);
  if (Array.isArray(f.valueArray)) return f.valueArray.slice(0, 50).map((x) => fieldValue(x, depth + 1)).filter((x) => x !== null);
  if (isObj(f.valueObject)) {
    const out = {};
    for (const k of Object.keys(f.valueObject).slice(0, 30)) { const v = fieldValue(f.valueObject[k], depth + 1); if (v !== null) out[clip(k, 64)] = v; }
    return out;
  }
  return null;
}

function flattenFields(fields) {
  const out = {};
  if (!isObj(fields)) return out;
  for (const k of Object.keys(fields).slice(0, 60)) {
    const v = fieldValue(fields[k], 0);
    if (v !== null && !(Array.isArray(v) && !v.length)) out[clip(k, 64)] = v;
  }
  return out;
}

// "01:02.500" / "1:02:03.000" -> milliseconds
function vttTime(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(s).trim());
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0')) : null;
}

// Fallback when the result has no transcriptPhrases (returnDetails off): the WEBVTT block inside the markdown.
function phrasesFromMarkdown(markdown) {
  const out = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S+)\s+-->\s+(\S+)/.exec(lines[i]);
    if (!m) continue;
    const a = vttTime(m[1]);
    const b = vttTime(m[2]);
    const text = [];
    while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/-->/.test(lines[i + 1])) text.push(lines[++i]);
    const joined = text.join(' ').trim();
    const sp = /^<(?:v\s+)?([^>]+)>\s*(.*)$/.exec(joined);
    if (a !== null && b !== null && joined) out.push({ startTimeMs: a, endTimeMs: b, speaker: sp ? sp[1] : '', text: sp ? sp[2] : joined });
  }
  return out;
}

// AnalysisResult -> { scenes, shots, width, height, durationEnd }. Times are SECONDS from the start of the analysed video.
//   scene:  { start, end, description, fields, speech: [{ start, end, speaker, text }] }
function parseAnalysis(result) {
  const contents = isObj(result) && Array.isArray(result.contents) ? result.contents : [];
  const scenes = [];
  const shots = new Set();
  const phrases = new Map();
  let width = 0;
  let height = 0;
  for (const c of contents.slice(0, 5000)) {
    if (!isObj(c) || (c.kind && c.kind !== 'audioVisual')) continue;
    const a = num(c.startTimeMs);
    const b = num(c.endTimeMs);
    if (a === null || b === null || !(b > a)) continue;
    const fields = flattenFields(c.fields);
    // the description of the scene: the prebuilt analyzers call it Summary; a custom analyzer may use another text field
    let descKey = Object.keys(fields).find((k) => /^(?:summary|description|caption)$/i.test(k) && typeof fields[k] === 'string');
    if (!descKey) descKey = Object.keys(fields).find((k) => typeof fields[k] === 'string' && fields[k].length > 20);
    const description = descKey ? clip(fields[descKey], 1200) : '';
    if (num(c.width) > 0 && num(c.height) > 0) { width = c.width; height = c.height; }
    for (const t of (Array.isArray(c.cameraShotTimesMs) ? c.cameraShotTimesMs : []).slice(0, MAX_SHOTS)) if (num(t) !== null && shots.size < MAX_SHOTS) shots.add(t);
    const list = Array.isArray(c.transcriptPhrases) && c.transcriptPhrases.length ? c.transcriptPhrases : phrasesFromMarkdown(c.markdown);
    for (const p of list.slice(0, 20000)) {
      if (!isObj(p) || num(p.startTimeMs) === null || typeof p.text !== 'string' || !p.text.trim()) continue;
      const key = p.startTimeMs + '|' + p.text.slice(0, 40);
      if (!phrases.has(key)) phrases.set(key, { start: sec(p.startTimeMs), end: sec(num(p.endTimeMs) === null ? p.startTimeMs : p.endTimeMs), speaker: clip(p.speaker, 40), text: clip(p.text, 600) });
    }
    const extra = {};
    for (const k of Object.keys(fields)) if (k !== descKey) extra[k] = fields[k];
    scenes.push({ start: sec(a), end: sec(b), description, fields: extra, speech: [] });
  }
  scenes.sort((x, y) => x.start - y.start);
  // every phrase belongs to the scene that contains its start (or the nearest one before it)
  const speech = Array.from(phrases.values()).sort((x, y) => x.start - y.start);
  for (const p of speech) {
    let owner = null;
    for (const s of scenes) { if (p.start >= s.start - 0.001 && p.start < s.end) { owner = s; break; } }
    if (!owner) owner = scenes.filter((s) => s.start <= p.start).pop() || scenes[0];
    if (owner) owner.speech.push(p);
  }
  const lastEnd = scenes.length ? scenes[scenes.length - 1].end : 0;
  return { scenes, shots: Array.from(shots).sort((x, y) => x - y).map(sec), width, height, end: lastEnd };
}

module.exports = {
  API_VERSION, DEFAULT_ANALYZER, ANALYZER_RE, LOCATIONS, DEFAULT_LOCATION, MAX_JSON,
  deriveEndpoint, validateEndpoint, createCuClient, parseAnalysis, flattenFields, phrasesFromMarkdown, classifyService,
};
