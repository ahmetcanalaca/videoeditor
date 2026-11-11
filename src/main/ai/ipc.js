'use strict';
// Main-process side of the AI assistant: status, settings + API key, connection test, running a request, cancelling.
// Everything that touches the secret or the network lives here; the renderer only ever sees a masked key hint.
const path = require('path');
const { KeyStore } = require('./secrets');
const { OriginTrust, FILES: TRUST_FILES } = require('./origin-trust');
const { validateBaseUrl, createAiNet, LOCAL_HOSTS } = require('./net');
const { normalizeEndpoint } = require('./endpoints');
const { runAgent, aiErrorInfo, buildSystemPrompt, compactTools } = require('./agent');
const { EXPORT_ENUMS, MAX_PIECES, getToolDefs } = require('../../shared/agent-ops');
const { AI_PROVIDERS, CU_ANALYZER_RE, CU_LOCATIONS, CU_DEFAULT_ANALYZER } = require('../settings');

const SEG_KEYS = ['id', 'mediaId', 'in', 'out', 'speed', 'zoomFrom', 'zoomTo', 'fx', 'fy', 'volume', 'mute', 'fadeIn', 'fadeOut'];
const TEST_TIMEOUT_MS = 30000;
const RUN_TIMEOUT_MS = 4 * 60 * 1000;
// A model on this computer may have to be loaded into memory first and answers slowly on a CPU.
const LOCAL_TEST_TIMEOUT_MS = 2 * 60 * 1000;
const LOCAL_RUN_TIMEOUT_MS = 10 * 60 * 1000;
// The built-in model also LOOKS at the video (minutes of work on a long video; the user can stop it any time).
const BUILTIN_TEST_TIMEOUT_MS = 4 * 60 * 1000;
const BUILTIN_RUN_TIMEOUT_MS = 45 * 60 * 1000;
const BUILTIN_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// Analysing the video with Content Understanding (upload + waiting for the service) is not counted against the request's own time limit; it has its own.
const CU_ANALYSIS_TIMEOUT_MS = 60 * 60 * 1000;
const CU_TEST_TIMEOUT_MS = 45 * 1000;

// How the assistant signs in: 'key' (API key, required), 'entra' (Azure CLI token, Azure OpenAI / Foundry only), 'optional' (local server),
// 'none' (the built-in model: a random key is made for every start of its private server, see llm/server.js).
function credentialOf(ai) {
  if (ai.provider === 'builtin') return 'none';
  if (ai.provider === 'local') return 'optional';
  if (ai.auth === 'entra' && (ai.provider === 'azure' || ai.provider === 'foundry')) return 'entra';
  return 'key';
}

function isLoopbackHost(url) {
  try { return LOCAL_HOSTS.has(new URL(url).hostname); } catch (e) { return false; }
}

// ctx: { handle(channel, fn), getSettings(), updateSettings(patch), getMedia(id) -> info|null, send(channel, payload), getLang(),
//        userDataPath, tempDir?, safeStorage, session, llm (the built-in model, see llm/ipc.js; optional), getBins() -> { ffmpeg }, procs,
//        confirmEndpoint(origin, kind) -> Promise<boolean> (native dialog: may the requests - kind 'key': prompts + API key, kind 'entra': a
//        Microsoft Entra ID token, kind 'cu': reduced copies of the user's videos - be sent to this origin?),
//        confirmUpload(plan) -> Promise<boolean> (native dialog before each upload for the video analysis) }
function registerAiIpc(ctx) {
  let providers = null;
  const P = () => providers || (providers = require('./providers'));
  let cuMod = null;
  let cuSvc = null;
  let cuCache = null;
  const CU = () => cuMod || (cuMod = require('./content-understanding'));
  const SVC = () => cuSvc || (cuSvc = require('./cu-service'));
  const analysisCache = () => cuCache || (cuCache = new (SVC().AnalysisCache)(path.join(ctx.userDataPath, 'cu-cache')));
  let keyStore = null;
  const trusts = {};
  let aiNet = null;
  let azTokens = null;
  let allowedOrigin = '';
  let active = null;
  let discovering = false;
  let confirming = false;
  const goodAudience = new Map();

  const store = () => keyStore || (keyStore = new KeyStore({ file: path.join(ctx.userDataPath, 'ai-key.json'), safeStorage: ctx.safeStorage }));
  // kind: 'entra' (where the Entra token may go) or 'key' (where the prompts and the API key may go, apart from the provider's own address)
  const trust = (kind) => trusts[kind] || (trusts[kind] = new OriginTrust(path.join(ctx.userDataPath, TRUST_FILES[kind])));
  const net = () => aiNet || (aiNet = createAiNet({ ses: ctx.session.fromPartition('ai-net'), getOrigin: () => allowedOrigin }));
  const testHooks = process.env.VE_TEST_MODE === '1';
  const az = () => azTokens || (azTokens = require('./azcli').createAzTokens({ azPath: testHooks && process.env.VE_TEST_AZ_PATH ? process.env.VE_TEST_AZ_PATH : undefined }));

  function effectiveUrl(ai) {
    return validateBaseUrl(ai.baseUrl || P().DEFAULT_BASE_URLS[ai.provider] || '');
  }

  // Does a request to this endpoint need the user's confirmation? Not when it stays on this computer, and not for the provider's own well-known
  // address (api.openai.com, api.anthropic.com, generativelanguage.googleapis.com). Everything else - an Azure / Foundry resource (anybody can create
  // one under any name), a company gateway, a typo - is a place the prompts and the key go to, so the user says yes once, in a native dialog.
  function endpointNeedsOk(provider, url) {
    if (provider === 'builtin' || provider === 'local' || !url || !url.ok || url.local) return false;
    const own = P().DEFAULT_BASE_URLS[provider];
    try { if (own && new URL(own).origin === url.origin) return false; } catch (e) { /* no well-known address */ }
    return true;
  }

  // Video analysis with Azure Content Understanding: Foundry provider only, off until the user switches it on. `needs` = the first thing that is missing.
  function cuStatus(ai, url, credential, keyMismatch, chatReady) {
    const base = { available: false, enabled: false, endpoint: '', effectiveEndpoint: '', analyzer: ai.cu.analyzer, location: ai.cu.location, needs: 'provider', ready: false, cache: { files: 0, bytes: 0 } };
    if (ai.provider !== 'foundry') return base;
    const cfg = ai.cu;
    let origin = '';
    if (cfg.endpoint) { const v = CU().validateEndpoint(cfg.endpoint); origin = v.ok ? v.origin : ''; } else if (url.ok) origin = CU().deriveEndpoint(url.url);
    let needs = null;
    if (!cfg.enabled) needs = 'off';
    else if (!chatReady) needs = 'chat';
    else if (!origin) needs = 'endpoint';
    else if (credential === 'key' && url.ok && origin !== url.origin) needs = 'origin'; // the key belongs to the address of the chat model and goes nowhere else
    else if (!isLoopbackHost(origin) && !trust('cu').has(origin)) needs = 'confirm';
    else if (credential === 'entra' && !trust('entra').has(origin)) needs = 'entra';
    return Object.assign(base, { available: true, enabled: cfg.enabled, endpoint: cfg.endpoint, effectiveEndpoint: origin, apiVersion: CU().API_VERSION, needs, ready: needs === null, cache: analysisCache().info() });
  }

  function status() {
    const ai = ctx.getSettings().ai;
    const builtin = ai.provider === 'builtin' && !!ctx.llm;
    const info = store().info();
    // the built-in model has no URL and no key of the user's: its private server is addressed by the app itself
    const url = builtin ? { ok: true, url: '', origin: '', local: true } : effectiveUrl(ai);
    const credential = credentialOf(ai);
    // a model "on this computer" must really be on this computer: its endpoint is never allowed to point elsewhere
    const urlError = url.ok ? (ai.provider === 'local' && !url.local ? 'URL_NOT_LOCAL' : '') : url.code;
    // A key is only valid for the endpoint it was entered for: changing the endpoint without a new key must never send it elsewhere.
    // (The binding is part of the encrypted key record itself, see secrets.js.)
    const keyMismatch = !builtin && info.hasKey && url.ok && store().origin() !== url.origin;
    // the first thing that is still missing (drives the "assistant is off" banner)
    let needs = null;
    if (builtin) needs = ctx.llm.isInstalled() ? null : 'install';
    else if (credential === 'key' && !info.hasKey) needs = 'key';
    else if (urlError) needs = 'url';
    else if (credential === 'key' && keyMismatch) needs = 'mismatch';
    else if (!ai.model) needs = 'model';
    return Object.assign({}, info, {
      provider: ai.provider,
      auth: credential === 'entra' ? 'entra' : 'key',
      credential,
      baseUrl: ai.baseUrl,
      effectiveBaseUrl: url.ok && !urlError ? url.url : '',
      urlError,
      model: builtin ? ctx.llm.model.id : ai.model,
      apiVersion: ai.apiVersion,
      shareNames: ai.shareNames,
      keyMismatch: !!keyMismatch,
      needs,
      azCli: az().available(),
      ready: needs === null,
      // the built-in model can look at the video (find_in_video)
      vision: builtin && !!ctx.llm.model.vision,
      builtin: ctx.llm ? ctx.llm.status() : null,
      cu: cuStatus(ai, url, credential, keyMismatch, needs === null),
    });
  }

  // POST /chat/completions of the built-in model's private server (the same endpoint the provider uses), for the requests that are not a conversation:
  // the vision questions of find_in_video and the warm-up.
  async function postChat(ep, body, signal) {
    const res = await net().fetch(ep.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ep.key }, body: JSON.stringify(body), signal });
    const text = await res.text();
    if (!res.ok) throw new (P().AiError)(res.status === 401 || res.status === 403 ? 'AUTH' : (res.status >= 500 ? 'SERVER' : 'BAD_REQUEST'), 'The local model answered HTTP ' + res.status, { status: res.status, detail: text.slice(0, 200) });
    try { return JSON.parse(text); } catch (e) { throw new (P().AiError)('BAD_RESPONSE', 'The local model returned a response that is not JSON'); }
  }

  // Runs fn(provider, endpoint) with the network window open for exactly this endpoint. The caller closes the window again (finally).
  // Entra ID: the Azure CLI supplies a short-lived token; a 401 is retried once with the other token audience (Foundry / Azure OpenAI).
  async function withProvider(st, signal, fn, opts) {
    if (st.provider === 'builtin') {
      // the private server of the built-in model: started on demand, a random key for this start, loopback only
      return ctx.llm.use(async (ep) => {
        allowedOrigin = ep.origin;
        const provider = P().createProvider({ kind: 'local', baseUrl: ep.baseUrl, model: st.model, apiKey: ep.key, fetch: net().fetch, timeoutMs: BUILTIN_REQUEST_TIMEOUT_MS });
        return fn(provider, ep);
      }, { signal });
    }
    allowedOrigin = effectiveUrl(ctx.getSettings().ai).origin;
    // The Entra token works for every Azure resource of this user: it is only ever sent to an endpoint the user confirmed (see origin-trust.js).
    if (st.credential === 'entra' && !trust('entra').has(allowedOrigin)) throw new (P().AiError)('ENTRA_NOT_CONFIRMED', 'This endpoint has not been confirmed for Microsoft Entra ID sign-in');
    // Likewise the prompts and the key only go to the provider's own address or to one the user confirmed.
    if (st.credential !== 'entra' && endpointNeedsOk(st.provider, effectiveUrl(ctx.getSettings().ai)) && !trust('key').has(allowedOrigin)) {
      throw new (P().AiError)('ENDPOINT_NOT_CONFIRMED', 'This address has not been confirmed as a destination for the assistant\'s requests');
    }
    const model = st.model || (opts && opts.listOnly ? 'model-list' : '');
    const base = { kind: st.provider, baseUrl: st.effectiveBaseUrl, model, fetch: net().fetch, apiVersion: st.apiVersion || undefined };
    if (st.credential !== 'entra') {
      // the store hands the key out for the endpoint it was entered for only
      const apiKey = st.hasKey && !st.keyMismatch ? store().get(allowedOrigin) : '';
      return fn(P().createProvider(Object.assign({}, base, { apiKey })));
    }
    const tokens = az();
    const azcli = require('./azcli');
    // the audience that worked last time is tried first (saves a failed round trip on every request)
    const memo = st.provider + '|' + st.effectiveBaseUrl;
    const preferred = goodAudience.get(memo);
    const audiences = azcli.audiencesFor(st.provider).sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    let last = null;
    for (const audience of audiences) {
      const tok = await tokens.getToken({ audience, signal });
      if (!tok.ok) throw new (P().AiError)(tok.code, 'Azure CLI: ' + tok.code, { detail: tok.detail });
      try {
        const out = await fn(P().createProvider(Object.assign({}, base, { apiKey: tok.token, bearer: true })));
        goodAudience.set(memo, audience);
        return out;
      } catch (e) {
        if (!(e && e.code === 'AUTH')) throw e;
        tokens.forget(audience);
        last = e;
      }
    }
    throw last;
  }

  const fail = (code, message) => ({ ok: false, error: { code, message: message || '', status: 0, detail: '' } });

  // The user confirms (native dialog, once) that an origin may receive a kind of traffic (see origin-trust.js). -> '' when it is confirmed, else an error code.
  async function ensureTrusted(kind, origin) {
    if (trust(kind).has(origin)) return '';
    if (confirming) return 'BUSY';
    confirming = true;
    try {
      const confirmed = ctx.confirmEndpoint ? await ctx.confirmEndpoint(origin, kind) : false;
      if (!confirmed || !trust(kind).add(origin)) return kind === 'entra' ? 'ENTRA_NOT_CONFIRMED' : (kind === 'cu' ? 'CU_NOT_CONFIRMED' : 'ENDPOINT_NOT_CONFIRMED');
      return '';
    } finally {
      confirming = false;
    }
  }

  // The result of a request REPLACES the whole timeline in the renderer. A snapshot that was cut short or lost a clip on the way
  // would therefore delete clips: such a timeline is refused instead of being "repaired".
  function buildSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments) || !raw.segments.length) return { error: 'EMPTY_TIMELINE' };
    if (raw.segments.length > MAX_PIECES) return { error: 'TOO_MANY_CLIPS' };
    const media = {};
    const segments = [];
    for (const s of raw.segments) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.mediaId !== 'string') return { error: 'SNAPSHOT_INVALID' };
      const info = ctx.getMedia(s.mediaId);
      if (!info) return { error: 'SNAPSHOT_INVALID' };
      if (!media[s.mediaId]) {
        media[s.mediaId] = { id: s.mediaId, name: info.name, duration: info.duration, fps: info.fps, hasAudio: !!info.hasAudio, displayWidth: info.displayWidth, displayHeight: info.displayHeight };
      }
      const clean = {};
      for (const k of SEG_KEYS) clean[k] = s[k];
      segments.push(clean);
    }
    const exp = {};
    const e = raw.exportSettings && typeof raw.exportSettings === 'object' ? raw.exportSettings : {};
    for (const k of Object.keys(EXPORT_ENUMS)) exp[k] = EXPORT_ENUMS[k].includes(String(e[k])) ? String(e[k]) : EXPORT_ENUMS[k][0];
    return { segments, media, exportSettings: exp, playhead: Number(raw.playhead) || 0, selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : null };
  }

  ctx.handle('ai:status', () => status());

  ctx.handle('ai:save', async (e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    if (!AI_PROVIDERS.includes(r.provider)) return fail('BAD_PROVIDER');
    const provider = r.provider;
    if (provider === 'builtin') {
      // nothing to enter: the model is installed from its own panel (llm:*). A key stored for another provider stays as it is
      // (it is bound to that provider's address and never leaves the app anyway).
      if (!ctx.llm) return fail('BAD_PROVIDER');
      ctx.updateSettings({ ai: { provider, auth: 'key', baseUrl: '', model: '', apiVersion: '', shareNames: r.shareNames !== false } });
      return { ok: true, keyCleared: false, status: status() };
    }
    const auth = r.auth === 'entra' && (provider === 'azure' || provider === 'foundry') ? 'entra' : 'key';
    // What portals show ("Target URI", project endpoint, a full API URL) is cleaned up first; deployment name and API version are picked up from it.
    const clean = normalizeEndpoint(provider, typeof r.baseUrl === 'string' ? r.baseUrl : '', { model: typeof r.model === 'string' ? r.model : '', apiVersion: typeof r.apiVersion === 'string' ? r.apiVersion : '' });
    let normalized = '';
    if (clean.url) {
      const v = validateBaseUrl(clean.url);
      // a "local" model must be on this computer: say so instead of a scheme error for e.g. http://192.168.1.20
      if (provider === 'local' && (v.ok ? !v.local : (v.code === 'URL_SCHEME' && !isLoopbackHost(clean.url)))) return fail('URL_NOT_LOCAL');
      if (!v.ok) return fail(v.code);
      normalized = v.url;
    }
    const next = { provider, auth, baseUrl: normalized, model: clean.model, apiVersion: clean.apiVersion, shareNames: r.shareNames !== false };
    const url = validateBaseUrl(normalized || P().DEFAULT_BASE_URLS[provider] || '');
    // Where the requests go decides who receives the text of the prompts and the key / token. Apart from the provider's own address and this computer
    // the destination is confirmed by the user, once, in a native dialog (a script in the page cannot click it); the Entra token of a sign-in works for
    // every Azure resource of the user, so it has its own list. Nothing is saved or sent before; an unconfirmed address is not saved.
    const kind = !url.ok ? '' : (auth === 'entra' ? 'entra' : (endpointNeedsOk(provider, url) ? 'key' : ''));
    if (kind) {
      const err = await ensureTrusted(kind, url.origin);
      if (err) return fail(err);
    }
    // Video analysis with Azure Content Understanding (Foundry only). Validated before anything is saved; switching it on needs the user's native
    // confirmation of the address the video copies go to (and, with Microsoft Entra ID, of the address the token goes to).
    if (provider !== 'foundry') {
      next.cu = { enabled: false };
    } else if (r.cu && typeof r.cu === 'object' && !Array.isArray(r.cu)) {
      const c = r.cu;
      const analyzerText = typeof c.analyzer === 'string' ? c.analyzer.trim() : '';
      if (analyzerText && !CU_ANALYZER_RE.test(analyzerText)) return fail('CU_ANALYZER_INVALID');
      const location = c.location === undefined || c.location === '' ? 'geography' : c.location;
      if (!CU_LOCATIONS.includes(location)) return fail('CU_LOCATION_INVALID');
      let cuOrigin = '';
      const endpointText = typeof c.endpoint === 'string' ? c.endpoint.trim() : '';
      if (endpointText) {
        const v = CU().validateEndpoint(endpointText);
        if (!v.ok) return fail('CU_' + v.code);
        cuOrigin = v.origin;
      }
      const enabled = c.enabled === true;
      if (enabled) {
        const effective = cuOrigin || (url.ok ? CU().deriveEndpoint(url.url) : '');
        if (!effective) return fail('CU_NO_ENDPOINT');
        // an API key is bound to the address of the chat model (see secrets.js): it is not sent to another address
        if (auth === 'key' && url.ok && effective !== url.origin) return fail('CU_ORIGIN_MISMATCH');
        if (!isLoopbackHost(effective)) {
          const err = await ensureTrusted('cu', effective);
          if (err) return fail(err);
        }
        if (auth === 'entra') {
          const err = await ensureTrusted('entra', effective);
          if (err) return fail(err);
        }
      }
      next.cu = { enabled, endpoint: cuOrigin, analyzer: analyzerText || CU_DEFAULT_ANALYZER, location };
    }
    let keyCleared = false;
    // A key that cannot be stored or removed as asked fails the whole save: the settings stay as they were.
    if (auth === 'entra') {
      // keyless sign-in: no secret is kept around (also a leftover record of a failed earlier deletion)
      const cleared = store().clear();
      if (!cleared.ok) return fail(cleared.code);
      az().clear();
      goodAudience.clear();
    } else if (typeof r.apiKey === 'string' && r.apiKey.trim()) {
      // the key and the endpoint it belongs to are stored together (one encrypted record), so there has to be an endpoint
      if (!url.ok) return fail(url.code);
      const set = store().set(r.apiKey, url.origin);
      if (!set.ok) return fail(set.code);
    } else if (store().has() && (!url.ok || store().origin() !== url.origin)) {
      const cleared = store().clear();
      if (!cleared.ok) return fail(cleared.code);
      keyCleared = true;
    }
    ctx.updateSettings({ ai: next });
    return { ok: true, keyCleared, status: status() };
  });

  ctx.handle('ai:clear-key', () => {
    const cleared = store().clear();
    return cleared.ok ? { ok: true, status: status() } : Object.assign(fail(cleared.code), { status: status() });
  });

  ctx.handle('ai:test', async () => {
    const st = status();
    if (st.needs === 'install') return fail('NOT_INSTALLED');
    if (st.needs === 'key') return fail('NO_KEY');
    if (st.urlError) return fail(st.urlError);
    if (st.needs === 'mismatch') return fail('KEY_MISMATCH');
    if (active) return fail('BUSY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), st.provider === 'builtin' ? BUILTIN_TEST_TIMEOUT_MS : (st.provider === 'local' ? LOCAL_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS));
    active = { controller };
    try {
      return await withProvider(st, controller.signal, async (provider, ep) => {
        let models = [];
        try {
          models = await provider.listModels({ signal: controller.signal });
        } catch (e) {
          // not every endpoint lists models; a bad key or an unreachable server is reported either way
          if (e && (e.code === 'AUTH' || e.code === 'FORBIDDEN' || e.code === 'NETWORK' || e.code === 'ABORTED')) throw e;
        }
        let modelOk = null;
        if (st.model) {
          await provider.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], tools: [], signal: controller.signal });
          modelOk = true;
        }
        return { ok: true, models: models.slice(0, 300), modelOk, backend: st.provider === 'builtin' && ep ? ep.backend : undefined };
      }, { listOnly: true });
    } catch (e) {
      return { ok: false, error: aiErrorInfo(e) };
    } finally {
      clearTimeout(timer);
      allowedOrigin = '';
      active = null;
    }
  });

  // The agent's view of the video: find_in_video looks at pictures of the video through the built-in model (see perception/).
  function makePerception(ep, session, userText, signal, runId) {
    const bins = ctx.getBins ? ctx.getBins() : {};
    if (!bins || !bins.ffmpeg) return null;
    try {
      const { createPerception } = require('../perception');
      const { createVlm } = require('../perception/vlm');
      const vlm = createVlm({ boxFormat: ctx.llm.model.boxFormat, chat: (body, sig) => postChat(ep, body, sig || signal) });
      return createPerception({
        pieces: session.originalMap(),
        fileOf: (mediaId) => { const info = ctx.getMedia(mediaId); if (!info || !info.path) throw new Error('media is gone'); return info.path; },
        ffmpegPath: bins.ffmpeg,
        procs: ctx.procs,
        vlm,
        userText,
        signal,
        onProgress: (p) => ctx.send('ai:step', Object.assign({ runId, kind: 'search' }, p)),
        log: ctx.log,
      });
    } catch (e) {
      return null; // without eyes the assistant still edits by time
    }
  }

  // Credential for Content Understanding: the key of the Foundry provider (header Ocp-Apim-Subscription-Key) or the Microsoft Entra token of the Azure CLI
  // (audience https://cognitiveservices.azure.com, cached for minutes by azcli.js). Handed to the client per request, never kept here.
  function cuAuth(st, signal) {
    return async (refresh) => {
      if (st.credential === 'entra') {
        const tokens = az();
        const audience = require('./azcli').AUDIENCES.cognitive;
        if (refresh) tokens.forget(audience);
        const tok = await tokens.getToken({ audience, signal });
        if (!tok.ok) throw new (P().AiError)(tok.code, 'Azure CLI: ' + tok.code, { detail: tok.detail });
        return { name: 'Authorization', value: 'Bearer ' + tok.token };
      }
      // the store hands the key out for the address it was entered for only (for key sign-in the status requires the same address for both services)
      const key = st.hasKey && !st.keyMismatch ? store().get(st.cu.effectiveEndpoint) : '';
      if (!key) throw new (P().AiError)('AUTH', 'No API key');
      return { name: 'Ocp-Apim-Subscription-Key', value: key };
    };
  }

  // (tests only: waiting between two polls can be shortened, see VE_TEST_MODE)
  const pollSleep = testHooks && Number(process.env.VE_TEST_CU_POLL_MS) > 0 ? (ms) => new Promise((r) => setTimeout(r, Math.min(ms, Number(process.env.VE_TEST_CU_POLL_MS)))) : undefined;
  const cuClientOf = (st, signal) => CU().createCuClient({
    endpoint: st.cu.effectiveEndpoint, fetch: net().fetch, auth: cuAuth(st, signal), analyzerId: st.cu.analyzer, processingLocation: st.cu.location, sleep: pollSleep,
  });

  // The agent's way of reading the video: analyze_video (see cu-service.js). hooks.pause / hooks.resume stop and restart the time limit of the request
  // while the upload and the service's work are running (they have a limit of their own).
  function makeAnalysis(st, session, runSignal, runId, hooks) {
    const bins = ctx.getBins ? ctx.getBins() : {};
    if (!bins || !bins.ffmpeg) return null;
    const origin = st.cu.effectiveEndpoint;
    const analysisController = new AbortController();
    const abortWithRun = () => analysisController.abort();
    if (runSignal.aborted) abortWithRun(); else runSignal.addEventListener('abort', abortWithRun, { once: true });
    const svc = SVC().createVideoAnalysis({
      client: () => cuClientOf(st, analysisController.signal),
      cache: analysisCache(),
      pieces: session.originalMap(),
      total: session.baseTotal,
      getMedia: (id) => ctx.getMedia(id),
      ffmpegPath: bins.ffmpeg,
      procs: ctx.procs,
      tmpDir: ctx.tempDir,
      confirmUpload: (plan) => (ctx.confirmUpload ? ctx.confirmUpload(plan) : Promise.resolve(false)),
      onProgress: (p) => ctx.send('ai:step', { runId, kind: 'analysis', phase: p.phase, index: p.index, parts: p.parts, cached: p.cached, fraction: p.fraction, megabytes: p.megabytes, elapsedMs: p.elapsedMs }),
      signal: analysisController.signal,
      log: ctx.log,
    });
    return {
      async analyze(args) {
        hooks.pause();
        const before = allowedOrigin;
        const timer = setTimeout(abortWithRun, CU_ANALYSIS_TIMEOUT_MS);
        try {
          allowedOrigin = origin; // the network window of the assistant opens for the Content Understanding address while it works
          return await svc.analyze(args);
        } finally {
          clearTimeout(timer);
          allowedOrigin = before;
          hooks.resume();
        }
      },
    };
  }

  ctx.handle('ai:run', async (e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    const st = status();
    if (!st.ready) return fail('NOT_CONFIGURED');
    if (active) return fail('BUSY');
    const snap = buildSnapshot(r.snapshot);
    if (snap.error) return fail(snap.error);
    const snapshot = snap;
    const controller = new AbortController();
    // the time limit of the request; it stands still while a video is being analysed (see makeAnalysis)
    const budget = { left: st.provider === 'builtin' ? BUILTIN_RUN_TIMEOUT_MS : (st.provider === 'local' ? LOCAL_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS), since: 0, timer: null };
    const arm = () => { budget.since = Date.now(); budget.timer = setTimeout(() => controller.abort(), Math.max(1000, budget.left)); };
    const disarm = () => { clearTimeout(budget.timer); budget.left -= Date.now() - budget.since; };
    arm();
    const runId = typeof r.runId === 'number' || typeof r.runId === 'string' ? r.runId : 0;
    active = { controller, runId };
    try {
      if (st.provider === 'builtin' && ctx.llm.serverInfo().phase !== 'ready') ctx.send('ai:step', { runId, kind: 'phase', phase: 'loading' });
      return await withProvider(st, controller.signal, (provider, ep) => runAgent({
        provider,
        prompt: r.prompt,
        history: r.history,
        snapshot,
        lang: ctx.getLang(),
        shareNames: st.shareNames,
        signal: controller.signal,
        onStep: (step) => ctx.send('ai:step', Object.assign({ runId }, step)),
        perceptionFactory: st.vision && ep ? (session) => makePerception(ep, session, String(r.prompt || ''), controller.signal, runId) : undefined,
        analysisFactory: st.cu && st.cu.ready ? (session) => makeAnalysis(st, session, controller.signal, runId, { pause: disarm, resume: arm }) : undefined,
      }));
    } catch (err) {
      return { ok: false, error: aiErrorInfo(err) };
    } finally {
      clearTimeout(budget.timer);
      allowedOrigin = '';
      active = null;
    }
  });

  // "Test the connection" of the video analysis: two GET requests (the model deployments Content Understanding uses, and the analyzer). Nothing is uploaded.
  ctx.handle('ai:cu-test', async () => {
    const st = status();
    if (!st.cu.available) return fail('CU_NOT_AVAILABLE');
    if (!st.cu.enabled) return fail('CU_OFF');
    if (!st.cu.ready) return fail({ chat: 'NOT_CONFIGURED', endpoint: 'CU_NO_ENDPOINT', origin: 'CU_ORIGIN_MISMATCH', confirm: 'CU_NOT_CONFIRMED', entra: 'ENTRA_NOT_CONFIRMED' }[st.cu.needs] || 'CU_NOT_READY');
    if (active) return fail('BUSY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CU_TEST_TIMEOUT_MS);
    active = { controller };
    allowedOrigin = st.cu.effectiveEndpoint;
    try {
      const res = await cuClientOf(st, controller.signal).testConnection(controller.signal);
      return { ok: true, defaults: res.defaults, defaultsSet: res.defaultsSet, analyzer: res.analyzerId, apiVersion: res.apiVersion, location: res.processingLocation };
    } catch (e) {
      return { ok: false, error: aiErrorInfo(e) };
    } finally {
      clearTimeout(timer);
      allowedOrigin = '';
      active = null;
    }
  });

  // The analysis results kept on this computer (descriptions and transcripts of the user's videos): deleted on request.
  ctx.handle('ai:cu-clear-cache', () => {
    const removed = analysisCache().clear();
    return { ok: true, removed, status: status() };
  });

  ctx.handle('ai:cancel', (e, runId) => {
    if (active && (runId === undefined || active.runId === undefined || String(active.runId) === String(runId))) active.controller.abort();
    return true;
  });

  // The assistant pane was opened: start the built-in model in the background so that the first request does not have to wait for it.
  ctx.handle('ai:warm', () => {
    const st = status();
    if (st.provider !== 'builtin' || !st.ready || active) return { ok: true, started: false };
    ctx.llm.warm();
    return { ok: true, started: true };
  });

  // "Find local servers": plain GET requests to a few loopback ports, only when the user asks for it. Nothing is sent anywhere else.
  ctx.handle('ai:discover', async () => {
    if (discovering) return fail('BUSY');
    discovering = true;
    try {
      const opts = {};
      if (testHooks && process.env.VE_TEST_AI_PROBE_PORTS) opts.ports = process.env.VE_TEST_AI_PROBE_PORTS.split(',').map(Number).filter(Number.isInteger);
      return { ok: true, servers: await require('./discover').discoverLocalServers(opts) };
    } catch (err) {
      return { ok: false, error: aiErrorInfo(err) };
    } finally {
      discovering = false;
    }
  });

  return { abortAll() { if (active) active.controller.abort(); } };
}

module.exports = { registerAiIpc };
