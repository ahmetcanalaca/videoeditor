(function () {
  'use strict';
  // The assistant of the web edition: window.api.ai / window.api.llm, the browser side of what the desktop app's main process does
  // (src/main/ai/ipc.js). The agent loop, the provider adapters, the video-analysis client and the "look at the video" pipeline ARE the desktop
  // code (bundled unchanged, see js/web/ai/desktop-core.js); this file is the glue: settings, the key, which addresses may be contacted, running a
  // request, and the Local AI helper that runs the built-in model on the user's own computer.
  //
  // Where things go: every request leaves through the network worker (js/web/ai/net.js), which can reach only the providers' own addresses, this
  // computer, and the https addresses the user allowed here. Nothing is sent before the user has chosen a provider.
  const VEW = window.VE.web;
  const api = window.api;

  const LS_SETTINGS = 've.web.ai.v1'; // what the assistant is set up to use (never a secret)
  const SS_KEY = 've.web.ai.key.v1'; // the key of a cloud provider: this browser tab's session only
  const LS_HELPER = 've.web.ai.helper.v1'; // pairing with the Local AI helper: { port, key, vision } (the key only opens a server on this computer)
  const TEST_TIMEOUT_MS = 30000;
  const RUN_TIMEOUT_MS = 4 * 60 * 1000;
  const LOCAL_TEST_TIMEOUT_MS = 2 * 60 * 1000;
  const LOCAL_RUN_TIMEOUT_MS = 10 * 60 * 1000;
  const BUILTIN_TEST_TIMEOUT_MS = 4 * 60 * 1000;
  const BUILTIN_RUN_TIMEOUT_MS = 45 * 60 * 1000;
  const BUILTIN_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
  const CU_ANALYSIS_TIMEOUT_MS = 60 * 60 * 1000;
  const CU_TEST_TIMEOUT_MS = 45 * 1000;
  const SEG_KEYS = ['id', 'mediaId', 'in', 'out', 'speed', 'zoomFrom', 'zoomTo', 'fx', 'fy', 'volume', 'mute', 'fadeIn', 'fadeOut'];
  const EXPORT_DEFAULT = ['original', 'auto', 'auto', 'high'];
  const t = (key, vars) => window.VE.i18n.t(key, vars);

  let K = null; // { core, C } once the bundle is loaded
  let settings = null;
  let vault = { key: '', origin: '' };
  let helper = { port: 0, key: '', vision: true, model: '' };
  let helperState = { phase: 'unknown', error: '' }; // what the last connection test found: unknown | ready | unreachable | unauthorized
  let cuCache = { files: 0, bytes: 0 };
  let active = null;
  let discovering = false;
  let confirming = false;
  let cuMod = null;

  const fail = (code, message) => ({ ok: false, error: { code, message: message || '', status: 0, detail: '' } });
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const rd = (v, n) => Math.round(v * n) / n;

  /* ------------------------------------------------------------------ loading, settings, key */

  function readJson(storage, key) {
    try { return JSON.parse(storage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  // Printable ASCII without spaces: valid in an HTTP header and the shape of every provider's keys (src/main/ai/secrets.js)
  function validateKey(raw) {
    const key = String(raw == null ? '' : raw).trim();
    if (!key) return { ok: false, code: 'KEY_EMPTY' };
    if (key.length > 4096) return { ok: false, code: 'KEY_TOO_LONG' };
    if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, code: 'KEY_INVALID' };
    return { ok: true, key };
  }

  function sanitize(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const cu = o.cu && typeof o.cu === 'object' ? o.cu : {};
    return {
      provider: K.C.AI_PROVIDERS.includes(o.provider) ? o.provider : 'builtin',
      // 'entra' = an access token (Microsoft Entra ID) pasted instead of an API key; it travels as "Authorization: Bearer ..."
      auth: o.auth === 'entra' ? 'entra' : 'key',
      baseUrl: str(o.baseUrl, 300),
      model: str(o.model, 200),
      apiVersion: str(o.apiVersion, 40),
      shareNames: o.shareNames !== false,
      cu: {
        enabled: cu.enabled === true,
        endpoint: str(cu.endpoint, 300),
        analyzer: typeof cu.analyzer === 'string' && K.C.CU_ANALYZER_RE.test(cu.analyzer) ? cu.analyzer : K.C.CU_DEFAULT_ANALYZER,
        location: K.C.CU_LOCATIONS.includes(cu.location) ? cu.location : 'geography',
      },
    };
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* storage blocked: the setup is for this session only */ }
  }

  function saveVault() {
    try {
      if (vault.key) sessionStorage.setItem(SS_KEY, JSON.stringify({ k: vault.key, o: vault.origin })); else sessionStorage.removeItem(SS_KEY);
    } catch (e) { /* the key then lives in memory only */ }
  }

  function saveHelper() {
    try {
      if (helper.port && helper.key) localStorage.setItem(LS_HELPER, JSON.stringify({ port: helper.port, key: helper.key, vision: helper.vision !== false, model: helper.model })); else localStorage.removeItem(LS_HELPER);
    } catch (e) { /* the pairing is for this session only */ }
  }

  // The pairing with the Local AI helper as stored by this or another tab of the browser (nothing valid = not paired)
  function readHelper() {
    const h = readJson(localStorage, LS_HELPER);
    if (h && Number.isInteger(h.port) && h.port >= 1024 && h.port <= 65535 && typeof h.key === 'string' && validateKey(h.key).ok) return { port: h.port, key: h.key, vision: h.vision !== false, model: str(h.model, 120) };
    return { port: 0, key: '', vision: true, model: '' };
  }

  async function ensure() {
    if (K) return K;
    const [core, constants] = await Promise.all([import('./desktop-core.js'), import('./constants.js')]);
    K = { core, C: constants.constants };
    settings = sanitize(readJson(localStorage, LS_SETTINGS));
    const k = readJson(sessionStorage, SS_KEY);
    if (k && typeof k.k === 'string' && typeof k.o === 'string' && validateKey(k.k).ok) vault = { key: k.k, origin: k.o };
    helper = readHelper();
    // how much of the video analysis is remembered in this browser (shown in the settings); only looked at when the feature is on
    if (settings.cu.enabled) import('./web-cu.js').then((m) => m.cacheInfo()).then((info) => { cuCache = info; }, () => {});
    return K;
  }

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']); // (no IPv6 literal: the network worker's policy cannot name one)
  const isLoopbackHost = (url) => { try { return LOCAL_HOSTS.has(new URL(url).hostname); } catch (e) { return false; } };

  // Chrome / Edge ask the user before a page on the internet may talk to a program on this computer ("Local Network Access"). A refusal looks like a dead
  // server to a program (a failed fetch); the permission tells the two apart, so that the user is told what to do.
  async function loopbackPermission() {
    try { return (await navigator.permissions.query({ name: 'loopback-network' })).state; } catch (e) { return 'unknown'; }
  }

  async function explainNetworkError(info, st) {
    if (!info || info.code !== 'NETWORK') return info;
    const onThisComputer = st.provider === 'builtin' || (st.provider === 'local' && isLoopbackHost(st.effectiveBaseUrl));
    if (!onThisComputer) return info;
    // the browser records its decision a moment after the request has failed
    let state = await loopbackPermission();
    for (let i = 0; i < 8 && state === 'prompt'; i++) { await new Promise((r) => setTimeout(r, 250)); state = await loopbackPermission(); }
    return state === 'denied' ? Object.assign({}, info, { code: 'LNA_BLOCKED' }) : info;
  }

  const helperEndpoint = () => ({ baseUrl: 'http://127.0.0.1:' + helper.port + '/v1', origin: 'http://127.0.0.1:' + helper.port, key: helper.key, port: helper.port });

  function credentialOf(ai) {
    if (ai.provider === 'builtin') return 'none';
    if (ai.provider === 'local') return 'optional';
    if (ai.auth === 'entra' && (ai.provider === 'azure' || ai.provider === 'foundry')) return 'entra';
    return 'key';
  }

  function effectiveUrl(ai) {
    return K.core.net.validateBaseUrl(ai.baseUrl || K.core.providers.DEFAULT_BASE_URLS[ai.provider] || '');
  }

  // Does a request to this endpoint need the user's confirmation? Not when it stays on this computer, and not for the provider's own well-known address.
  // Everything else - an Azure / Foundry resource (anybody can create one under any name), a company gateway, a typo - is a place the prompts and the key
  // go to, so the user says yes once. While a key is being entered (`always`) the user is asked even when the address is on the saved list: every GitHub
  // Pages site of an account shares this browser storage, so another page could have put an address there, and the key is only kept for the tab anyway.
  function endpointNeedsOk(provider, url, always) {
    if (provider === 'builtin' || provider === 'local' || !url || !url.ok || url.local) return false;
    if (VEW.net.wellKnown.indexOf(url.origin) >= 0) return false;
    return !!always || !VEW.net.trust.has(url.origin);
  }

  /* ------------------------------------------------------------------ status */

  function cuStatus(ai, url, credential, keyMismatch, chatReady) {
    const base = { available: false, enabled: false, endpoint: '', effectiveEndpoint: '', analyzer: ai.cu.analyzer, location: ai.cu.location, needs: 'provider', ready: false, cache: cuCache };
    if (ai.provider !== 'foundry') return base;
    const cfg = ai.cu;
    let origin = '';
    if (cfg.endpoint) { const v = K.core.cu.validateEndpoint(cfg.endpoint); origin = v.ok ? v.origin : ''; } else if (url.ok) origin = K.core.cu.deriveEndpoint(url.url);
    let needs = null;
    if (!cfg.enabled) needs = 'off';
    else if (!chatReady) needs = 'chat';
    else if (!origin) needs = 'endpoint';
    else if (credential === 'key' && url.ok && origin !== url.origin) needs = 'origin'; // the key belongs to the address of the chat model and goes nowhere else
    else if (!isLoopbackHost(origin) && !VEW.net.trust.has(origin)) needs = 'confirm';
    return Object.assign(base, { available: true, enabled: cfg.enabled, endpoint: cfg.endpoint, effectiveEndpoint: origin, apiVersion: K.core.cu.API_VERSION, needs, ready: needs === null, cache: cuCache });
  }

  function builtinStatus() {
    const m = K.core.llmCatalog.CATALOG.find((x) => x.id === K.core.llmCatalog.DEFAULT_MODEL_ID);
    return {
      model: { id: m.id, name: m.name, license: m.license, licenseUrl: m.licenseUrl, source: m.source, total: K.core.llmCatalog.totalBytes(m), needsRamGb: m.needsRamGb, vision: !!m.vision },
      paired: !!(helper.port && helper.key),
      port: helper.port,
      defaultPort: K.C.LOCAL_AI_DEFAULT_PORT,
      served: helper.model,
      // what the last connection test found (nothing is probed while the status is read)
      connection: helperState.phase,
      error: helperState.error,
      // 'denied' when the browser refused the connection to this computer (Local Network Access), so that "blocked" is not shown as "not started"
      lna: helperState.lna || 'unknown',
      server: { phase: 'stopped', backend: null, port: helper.port, error: null, fallbackFrom: null, busy: 0, detectedGpu: null },
    };
  }

  function status() {
    const ai = settings;
    const builtin = ai.provider === 'builtin';
    const url = builtin ? { ok: true, url: '', origin: '', local: true } : effectiveUrl(ai);
    const credential = credentialOf(ai);
    const urlError = url.ok ? (ai.provider === 'local' && !url.local ? 'URL_NOT_LOCAL' : '') : url.code;
    // A key is only valid for the endpoint it was entered for: changing the endpoint without a new key must never send it elsewhere.
    const keyMismatch = !builtin && !!vault.key && url.ok && vault.origin !== url.origin;
    let needs = null;
    if (builtin) needs = helper.port && helper.key ? null : 'install';
    else if (credential === 'key' && !vault.key) needs = 'key';
    else if (credential === 'entra' && !vault.key) needs = 'key';
    else if (urlError) needs = 'url';
    else if ((credential === 'key' || credential === 'entra') && keyMismatch) needs = 'mismatch';
    else if (!ai.model) needs = 'model';
    const hasKey = builtin ? false : !!vault.key;
    return {
      hasKey,
      masked: hasKey ? (vault.key.length >= 12 ? '••••' + vault.key.slice(-4) : '••••') : '',
      persisted: false,
      // a browser has no secure store: the key is kept for this tab's session only (the settings dialog says so)
      encryptionAvailable: false,
      provider: ai.provider,
      auth: credential === 'entra' ? 'entra' : 'key',
      credential,
      baseUrl: ai.baseUrl,
      effectiveBaseUrl: url.ok && !urlError ? url.url : '',
      urlError,
      model: builtin ? K.core.llmCatalog.DEFAULT_MODEL_ID : ai.model,
      apiVersion: ai.apiVersion,
      shareNames: ai.shareNames,
      keyMismatch,
      needs,
      // the sign-in with an access token needs no command line tool on this computer
      azCli: true,
      ready: needs === null,
      // the Local AI helper's model can look at the video (find_in_video)
      vision: builtin && !!(helper.port && helper.key) && helper.vision !== false,
      builtin: builtinStatus(),
      cu: cuStatus(ai, url, credential, keyMismatch, needs === null),
    };
  }

  /* ------------------------------------------------------------------ the user decides where requests may go */

  // The user confirms that an address may receive a kind of traffic: kind 'key' = the text of the prompts and the API key / token, kind 'cu' = reduced
  // copies of the user's videos (a bigger decision than a prompt). The saved list lets a later request go without asking again, except when `force` is set
  // (a key is being entered: see endpointNeedsOk). -> '' when it is allowed, else an error code.
  async function ensureTrusted(kind, origin, force) {
    if (!force && VEW.net.trust.has(origin) && kind === 'key') return '';
    if (!force && kind === 'cu' && cuTrust().includes(origin)) return '';
    if (confirming) return 'BUSY';
    confirming = true;
    try {
      const choice = await api.messageBox({
        type: 'question', title: t('app.title'), message: t(kind === 'cu' ? 'web.trust.cuMsg' : 'web.trust.keyMsg', { origin }),
        detail: t(kind === 'cu' ? 'web.trust.cuDetail' : 'web.trust.keyDetail'), buttons: [t('web.trust.allow'), t('web.trust.cancel')], defaultId: 1, cancelId: 1,
      });
      if (choice !== 0) return kind === 'cu' ? 'CU_NOT_CONFIRMED' : 'ENDPOINT_NOT_CONFIRMED';
      if (kind === 'cu') {
        cuTrustAdd(origin);
        if (!(await VEW.net.trust.add(origin))) return 'CU_NOT_CONFIRMED'; // the network worker has to be allowed to reach it, too
        return '';
      }
      return (await VEW.net.trust.add(origin)) ? '' : 'ENDPOINT_NOT_CONFIRMED';
    } finally {
      confirming = false;
    }
  }

  // addresses the user allowed for video uploads (kept apart from the prompt list: uploading a video is a bigger decision)
  const LS_CU_TRUST = 've.web.ai.cutrust.v1';
  const cuTrust = () => { const j = readJson(localStorage, LS_CU_TRUST); return Array.isArray(j) ? j.filter((o) => typeof o === 'string').slice(0, 50) : []; };
  function cuTrustAdd(origin) {
    const list = cuTrust();
    if (!list.includes(origin)) { try { localStorage.setItem(LS_CU_TRUST, JSON.stringify(list.concat(origin).slice(-50))); } catch (e) { /* this session only */ } }
  }
  const cuTrusted = (origin) => cuTrust().includes(origin);

  /* ------------------------------------------------------------------ providers */

  // Anthropic only answers a browser's cross-origin request when it is asked for with this header (their name for "I know the key is visible to this page")
  function fetchFor(kind) {
    if (kind !== 'anthropic') return (u, i) => VEW.net.fetch(u, i);
    return (u, i) => VEW.net.fetch(u, Object.assign({}, i, { headers: Object.assign({}, i && i.headers, { 'anthropic-dangerous-direct-browser-access': 'true' }) }));
  }

  function providerFor(st, opts) {
    const o = opts || {};
    if (st.provider === 'builtin') {
      const ep = helperEndpoint();
      return K.core.providers.createProvider({ kind: 'local', baseUrl: ep.baseUrl, model: st.model, apiKey: ep.key, fetch: fetchFor('local'), timeoutMs: BUILTIN_REQUEST_TIMEOUT_MS });
    }
    const origin = effectiveUrl(settings).origin;
    // the key / token is handed out for the address it was entered for only
    const apiKey = st.hasKey && !st.keyMismatch && vault.origin === origin ? vault.key : '';
    return K.core.providers.createProvider({
      kind: st.provider, baseUrl: st.effectiveBaseUrl, model: st.model || (o.listOnly ? 'model-list' : ''), apiKey, bearer: st.credential === 'entra', fetch: fetchFor(st.provider), apiVersion: st.apiVersion || undefined,
    });
  }

  /* ------------------------------------------------------------------ the editor's state as the agent sees it */

  // The result of a request REPLACES the whole timeline in the renderer. A snapshot that was cut short or lost a clip on the way would therefore delete
  // clips: such a timeline is refused instead of being "repaired".
  function buildSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments) || !raw.segments.length) return { error: 'EMPTY_TIMELINE' };
    if (raw.segments.length > K.core.ops.MAX_PIECES) return { error: 'TOO_MANY_CLIPS' };
    const media = {};
    const segments = [];
    for (const s of raw.segments) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.mediaId !== 'string') return { error: 'SNAPSHOT_INVALID' };
      const m = VEW.getMedia(s.mediaId);
      if (!m) return { error: 'SNAPSHOT_INVALID' };
      if (!media[s.mediaId]) {
        const i = m.info;
        media[s.mediaId] = { id: s.mediaId, name: i.name, duration: i.duration, fps: i.fps, hasAudio: !!i.hasAudio, displayWidth: i.displayWidth, displayHeight: i.displayHeight };
      }
      const clean = {};
      for (const k of SEG_KEYS) clean[k] = s[k];
      segments.push(clean);
    }
    const exp = {};
    const e = raw.exportSettings && typeof raw.exportSettings === 'object' ? raw.exportSettings : {};
    const enums = K.core.ops.EXPORT_ENUMS;
    Object.keys(enums).forEach((k) => { exp[k] = enums[k].includes(String(e[k])) ? String(e[k]) : enums[k][0]; });
    return { segments, media, exportSettings: exp, playhead: Number(raw.playhead) || 0, selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : null };
  }

  /* ------------------------------------------------------------------ small helpers for the local server */

  async function readText(res, max) {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return (await res.text()).slice(0, max);
    const dec = new TextDecoder();
    let out = '';
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { try { await reader.cancel(); } catch (e) { /* gone */ } break; }
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  async function getJson(url, headers, signal, max) {
    const res = await VEW.net.fetch(url, { method: 'GET', headers: Object.assign({ accept: 'application/json' }, headers), signal });
    const text = await readText(res, max || 512 * 1024);
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  const tidyModel = (id) => (/[\\/]/.test(id) ? id.split(/[\\/]/).filter(Boolean).pop() : id);

  // POST /chat/completions of the Local AI helper (the same endpoint the provider uses), for the requests that are not a conversation: the vision
  // questions of find_in_video
  async function postChat(ep, body, signal) {
    const res = await VEW.net.fetch(ep.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ep.key }, body: JSON.stringify(body), signal });
    const text = await readText(res, 8 * 1024 * 1024);
    const AiError = K.core.providers.AiError;
    if (!res.ok) throw new AiError(res.status === 401 || res.status === 403 ? 'AUTH' : (res.status >= 500 ? 'SERVER' : 'BAD_REQUEST'), 'The local model answered HTTP ' + res.status, { status: res.status, detail: text.slice(0, 200) });
    try { return JSON.parse(text); } catch (e) { throw new AiError('BAD_RESPONSE', 'The local model returned a response that is not JSON'); }
  }

  /* ------------------------------------------------------------------ the assistant's eyes and its video analysis */

  function makePerception(ep, session, userText, signal, runId, extractor) {
    try {
      const vlm = K.core.perceptionVlm.createVlm({ boxFormat: 'k1000', chat: (body, sig) => postChat(ep, body, sig || signal) });
      return K.core.perception.createPerception({
        pieces: session.originalMap(),
        fileOf: (mediaId) => { if (!VEW.getMedia(mediaId)) throw new Error('media is gone'); return mediaId; },
        ffmpegPath: 'browser', // the desktop frame source wants one; the pictures come from the browser's decoder (extract below)
        procs: null,
        vlm,
        userText,
        signal,
        extract: extractor.extract,
        onProgress: (p) => VEW.emit('ai:step', Object.assign({ runId, kind: 'search' }, p)),
        log: () => {},
      });
    } catch (e) {
      return null; // without eyes the assistant still edits by time
    }
  }

  async function webCu() {
    if (!cuMod) cuMod = await import('./web-cu.js');
    return cuMod;
  }

  /* ------------------------------------------------------------------ api.ai */

  async function aiStatus() { await ensure(); return status(); }

  async function aiSave(req) {
    await ensure();
    const r = req && typeof req === 'object' ? req : {};
    if (!K.C.AI_PROVIDERS.includes(r.provider)) return fail('BAD_PROVIDER');
    const provider = r.provider;
    if (provider === 'builtin') {
      settings = sanitize(Object.assign({}, settings, { provider, auth: 'key', baseUrl: '', model: '', apiVersion: '', shareNames: r.shareNames !== false }));
      saveSettings();
      return { ok: true, keyCleared: false, status: status() };
    }
    const auth = r.auth === 'entra' && (provider === 'azure' || provider === 'foundry') ? 'entra' : 'key';
    // What portals show ("Target URI", project endpoint, a full API URL) is cleaned up first; deployment name and API version are picked up from it.
    const clean = K.core.endpoints.normalizeEndpoint(provider, typeof r.baseUrl === 'string' ? r.baseUrl : '', { model: typeof r.model === 'string' ? r.model : '', apiVersion: typeof r.apiVersion === 'string' ? r.apiVersion : '' });
    let normalized = '';
    if (clean.url) {
      const v = K.core.net.validateBaseUrl(clean.url);
      // a "local" model must be on this computer: say so instead of a scheme error for e.g. http://192.168.1.20 (or http://[::1], which the web edition cannot reach)
      if (provider === 'local' && (v.ok ? (!v.local || !isLoopbackHost(v.url)) : (v.code === 'URL_SCHEME' && !isLoopbackHost(clean.url)))) return fail('URL_NOT_LOCAL');
      if (v.ok && v.local && !isLoopbackHost(v.url)) return fail('URL_NOT_LOCAL');
      if (!v.ok) return fail(v.code);
      normalized = v.url;
    }
    const next = { provider, auth, baseUrl: normalized, model: clean.model, apiVersion: clean.apiVersion, shareNames: r.shareNames !== false, cu: settings.cu };
    const url = K.core.net.validateBaseUrl(normalized || K.core.providers.DEFAULT_BASE_URLS[provider] || '');
    // Where the requests go decides who receives the text of the prompts and the key. Apart from the provider's own address and this computer the
    // destination is confirmed by the user (again whenever a key is entered for it). Nothing is saved or sent before; an unconfirmed address is not saved.
    const newKey = typeof r.apiKey === 'string' && r.apiKey.trim() !== '';
    if (url.ok && endpointNeedsOk(provider, url, newKey)) {
      const err = await ensureTrusted('key', url.origin, newKey);
      if (err) return fail(err);
    }
    // Video analysis with Azure Content Understanding (Foundry only). Validated before anything is saved; switching it on needs the user's confirmation of the
    // address the video copies go to.
    if (provider !== 'foundry') {
      next.cu = { enabled: false, endpoint: '', analyzer: K.C.CU_DEFAULT_ANALYZER, location: 'geography' };
    } else if (r.cu && typeof r.cu === 'object' && !Array.isArray(r.cu)) {
      const c = r.cu;
      const analyzerText = typeof c.analyzer === 'string' ? c.analyzer.trim() : '';
      if (analyzerText && !K.C.CU_ANALYZER_RE.test(analyzerText)) return fail('CU_ANALYZER_INVALID');
      const location = c.location === undefined || c.location === '' ? 'geography' : c.location;
      if (!K.C.CU_LOCATIONS.includes(location)) return fail('CU_LOCATION_INVALID');
      let cuOrigin = '';
      const endpointText = typeof c.endpoint === 'string' ? c.endpoint.trim() : '';
      if (endpointText) {
        const v = K.core.cu.validateEndpoint(endpointText);
        if (!v.ok) return fail('CU_' + v.code);
        cuOrigin = v.origin;
      }
      const enabled = c.enabled === true;
      if (enabled) {
        const effective = cuOrigin || (url.ok ? K.core.cu.deriveEndpoint(url.url) : '');
        if (!effective) return fail('CU_NO_ENDPOINT');
        // an API key is bound to the address of the chat model: it is not sent to another address
        if (auth === 'key' && url.ok && effective !== url.origin) return fail('CU_ORIGIN_MISMATCH');
        if (!isLoopbackHost(effective)) {
          // when a new key or token is saved with this address and it is not the chat model's address (an Entra token may go there), ask even if it is on the list
          const err = await ensureTrusted('cu', effective, newKey && url.ok && effective !== url.origin);
          if (err) return fail(err);
        }
      }
      next.cu = { enabled, endpoint: cuOrigin, analyzer: analyzerText || K.C.CU_DEFAULT_ANALYZER, location };
    }
    if (typeof r.apiKey === 'string' && r.apiKey.trim()) {
      // the key and the endpoint it belongs to are kept together, so there has to be an endpoint
      if (!url.ok) return fail(url.code);
      const v = validateKey(r.apiKey);
      if (!v.ok) return fail(v.code);
      vault = { key: v.key, origin: url.origin };
      saveVault();
    }
    let keyCleared = false;
    if (vault.key && (!url.ok || vault.origin !== url.origin) && !(typeof r.apiKey === 'string' && r.apiKey.trim())) {
      vault = { key: '', origin: '' };
      saveVault();
      keyCleared = true;
    }
    settings = sanitize(next);
    saveSettings();
    return { ok: true, keyCleared, status: status() };
  }

  async function aiClearKey() {
    await ensure();
    vault = { key: '', origin: '' };
    saveVault();
    return { ok: true, status: status() };
  }

  async function aiTest() {
    await ensure();
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
      const AiError = K.core.providers.AiError;
      if (st.provider === 'builtin') {
        // 1. is anything there? (/health needs no key)  2. does the key open it, which model?  3. can it look at pictures?
        const ep = helperEndpoint();
        helperState = { phase: 'unreachable', error: '' };
        let health;
        try { health = await VEW.net.fetch(ep.origin + '/health', { method: 'GET', signal: controller.signal }); } catch (e) {
          if (controller.signal.aborted) throw new AiError('TIMEOUT', 'The request timed out');
          throw new AiError('NETWORK', 'The Local AI did not answer', { detail: String((e && e.message) || e).slice(0, 200) });
        }
        if (!health.ok) throw new AiError('NETWORK', 'The Local AI answered HTTP ' + health.status);
        const provider = providerFor(st);
        let models;
        try { models = await provider.listModels({ signal: controller.signal }); } catch (e) {
          if (e && e.code === 'AUTH') helperState = { phase: 'unauthorized', error: '' };
          throw e;
        }
        helper.model = tidyModel(models[0] || '');
        try {
          const props = await getJson(ep.origin + '/props', { authorization: 'Bearer ' + ep.key }, controller.signal, 1024 * 1024);
          if (props && props.modalities) helper.vision = !!props.modalities.vision;
        } catch (e) { /* older servers have no /props: the model is assumed to see (the desktop model does) */ }
        saveHelper();
        helperState = { phase: 'ready', error: '' };
        return { ok: true, models: models.slice(0, 300), modelOk: true, backend: undefined, vision: helper.vision !== false };
      }
      const provider = providerFor(st, { listOnly: true });
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
      return { ok: true, models: models.slice(0, 300), modelOk };
    } catch (e) {
      const info = await explainNetworkError(K.core.agent.aiErrorInfo(e), st);
      if (st.provider === 'builtin' && info.code === 'LNA_BLOCKED') helperState = { phase: 'unreachable', error: '', lna: 'denied' };
      return { ok: false, error: info };
    } finally {
      clearTimeout(timer);
      active = null;
    }
  }

  async function aiRun(req) {
    await ensure();
    const r = req && typeof req === 'object' ? req : {};
    const st = status();
    if (!st.ready) return fail('NOT_CONFIGURED');
    if (active) return fail('BUSY');
    const snapshot = buildSnapshot(r.snapshot);
    if (snapshot.error) return fail(snapshot.error);
    const controller = new AbortController();
    // the time limit of the request; it stands still while a video is being analysed (see makeAnalysis)
    const budget = { left: st.provider === 'builtin' ? BUILTIN_RUN_TIMEOUT_MS : (st.provider === 'local' ? LOCAL_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS), since: 0, timer: null };
    const arm = () => { budget.since = Date.now(); budget.timer = setTimeout(() => controller.abort(), Math.max(1000, budget.left)); };
    const disarm = () => { clearTimeout(budget.timer); budget.left -= Date.now() - budget.since; };
    arm();
    const runId = typeof r.runId === 'number' || typeof r.runId === 'string' ? r.runId : 0;
    active = { controller, runId };
    let extractor = null;
    try {
      const provider = providerFor(st);
      const prompt = String(r.prompt || '');
      let perceptionFactory;
      if (st.vision) {
        const frames = await import('./web-frames.js');
        extractor = frames.createFrameExtractor((id) => VEW.getMedia(id));
        const ep = helperEndpoint();
        perceptionFactory = (session) => makePerception(ep, session, prompt, controller.signal, runId, extractor);
      }
      let analysisFactory;
      if (st.cu && st.cu.ready) {
        const cu = await webCu();
        analysisFactory = (session) => cu.createAnalysis({
          core: K.core, status: st, session, runSignal: controller.signal, runId, hooks: { pause: disarm, resume: arm }, getMedia: (id) => VEW.getMedia(id), vault: () => vault, net: VEW.net,
          emit: (step) => VEW.emit('ai:step', Object.assign({ runId }, step)), confirmUpload: (plan) => confirmUpload(plan), timeoutMs: CU_ANALYSIS_TIMEOUT_MS, onCache: (info) => { cuCache = info; },
        });
      }
      return await K.core.agent.runAgent({
        provider,
        prompt: r.prompt,
        history: r.history,
        snapshot,
        lang: window.VE.i18n.getLanguage(),
        shareNames: st.shareNames,
        signal: controller.signal,
        onStep: (step) => VEW.emit('ai:step', Object.assign({ runId }, step)),
        perceptionFactory,
        analysisFactory,
      });
    } catch (err) {
      return { ok: false, error: await explainNetworkError(K.core.agent.aiErrorInfo(err), st) };
    } finally {
      clearTimeout(budget.timer);
      if (extractor) extractor.close();
      active = null;
    }
  }

  // Before every upload of a (reduced) copy of the user's video the user is asked, with what exactly would leave the computer.
  async function confirmUpload(plan) {
    const files = (plan.files || []).map((f) => f.name + ' (' + Math.round(f.seconds) + ' s)').join('\n');
    const choice = await api.messageBox({
      type: 'question', title: t('app.title'), message: t('web.cu.confirmMsg', { origin: plan.origin, mb: plan.megabytes, parts: plan.parts }),
      detail: t('web.cu.confirmDetail', { files, analyzer: plan.analyzer, location: plan.location }), buttons: [t('web.cu.upload'), t('web.trust.cancel')], defaultId: 1, cancelId: 1,
    });
    return choice === 0;
  }

  async function aiCancel(runId) {
    if (active && active.controller && (runId === undefined || active.runId === undefined || String(active.runId) === String(runId))) active.controller.abort();
    return true;
  }

  // "Find local servers": plain GET requests to a few ports of this computer, only when the user asks for it. Nothing is sent anywhere else.
  async function aiDiscover() {
    await ensure();
    if (discovering) return fail('BUSY');
    discovering = true;
    try {
      const names = { 8473: 'Video Editor Local AI', 11434: 'Ollama', 1234: 'LM Studio', 8080: 'llama.cpp', 5272: 'Foundry Local' };
      const servers = [];
      await Promise.all(K.C.DISCOVER_PORTS.map(async (port) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        try {
          const j = await getJson('http://127.0.0.1:' + port + '/v1/models', {}, ctrl.signal, 512 * 1024);
          const ids = j && Array.isArray(j.data) ? j.data.map((m) => m && m.id).filter((s) => typeof s === 'string' && s && s.length <= 300).map(tidyModel) : null;
          if (ids) servers.push({ name: names[port] || ('localhost:' + port), port, foundry: port === 5272, url: 'http://127.0.0.1:' + port + '/v1', models: ids });
        } catch (e) { /* nobody there, or it needs a key */ } finally { clearTimeout(timer); }
      }));
      servers.sort((a, b) => K.C.DISCOVER_PORTS.indexOf(a.port) - K.C.DISCOVER_PORTS.indexOf(b.port));
      return { ok: true, servers };
    } catch (err) {
      return { ok: false, error: K.core.agent.aiErrorInfo(err) };
    } finally {
      discovering = false;
    }
  }

  // "Test the connection" of the video analysis: two GET requests (the model deployments Content Understanding uses, and the analyzer). Nothing is uploaded.
  async function aiCuTest() {
    await ensure();
    const st = status();
    if (!st.cu.available) return fail('CU_NOT_AVAILABLE');
    if (!st.cu.enabled) return fail('CU_OFF');
    if (!st.cu.ready) return fail({ chat: 'NOT_CONFIGURED', endpoint: 'CU_NO_ENDPOINT', origin: 'CU_ORIGIN_MISMATCH', confirm: 'CU_NOT_CONFIRMED' }[st.cu.needs] || 'CU_NOT_READY');
    if (active) return fail('BUSY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CU_TEST_TIMEOUT_MS);
    active = { controller };
    try {
      const cu = await webCu();
      const res = await cu.test({ core: K.core, status: st, vault: () => vault, net: VEW.net, signal: controller.signal });
      return { ok: true, defaults: res.defaults, defaultsSet: res.defaultsSet, analyzer: res.analyzerId, apiVersion: res.apiVersion, location: res.processingLocation };
    } catch (e) {
      return { ok: false, error: K.core.agent.aiErrorInfo(e) };
    } finally {
      clearTimeout(timer);
      active = null;
    }
  }

  // The analysis results kept in this browser (descriptions and transcripts of the user's videos): deleted on request.
  async function aiCuClearCache() {
    await ensure();
    const cu = await webCu();
    const removed = await cu.clearCache();
    cuCache = { files: 0, bytes: 0 };
    return { ok: true, removed, status: status() };
  }

  /* ------------------------------------------------------------------ api.llm: the Local AI helper */

  async function llmPair(req) {
    await ensure();
    const port = Number(req && req.port);
    const v = validateKey(req && req.key);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail('URL_INVALID');
    if (!v.ok) return fail(v.code);
    helper = { port, key: v.key, vision: true, model: '' };
    helperState = { phase: 'unknown', error: '' };
    saveHelper();
    settings = sanitize(Object.assign({}, settings, { provider: 'builtin', auth: 'key', baseUrl: '', model: '', apiVersion: '' }));
    saveSettings();
    return { ok: true, status: status() };
  }

  async function llmForget() {
    await ensure();
    helper = { port: 0, key: '', vision: true, model: '' };
    helperState = { phase: 'unknown', error: '' };
    saveHelper();
    return { ok: true, status: status() };
  }

  const notAvailable = () => Promise.resolve(fail('NOT_AVAILABLE', 'There is nothing to install in the browser: the model runs in the Local AI helper on this computer.'));

  api.ai = {
    status: aiStatus, save: aiSave, clearKey: aiClearKey, test: aiTest, run: aiRun, cancel: aiCancel, discover: aiDiscover, cuTest: aiCuTest, cuClearCache: aiCuClearCache,
    warm() { return Promise.resolve({ ok: true, started: false }); },
  };
  api.llm = {
    status: async () => { await ensure(); return Object.assign({ ok: true }, builtinStatus()); },
    install: notAvailable,
    set: notAvailable,
    cancel() { return Promise.resolve(true); },
    stop() { return Promise.resolve({ ok: true }); },
    remove: llmForget,
    pickDir() { return Promise.resolve({ canceled: true }); },
    pair: llmPair,
    forget: llmForget,
  };

  /* ------------------------------------------------------------------ the pairing link of the Local AI helper: #local-ai=<port>.<key> */

  // The helper (web/local-ai/) opens this page with the port and a key it made, in the fragment (a fragment is never sent to a server). The user confirms
  // once; the fragment is removed from the address bar and the history entry at once.
  async function takePairingLink() {
    const m = /^#local-ai=(\d{4,5})\.([A-Za-z0-9_-]{16,128})$/.exec(location.hash);
    if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the fragment stays visible */ }
    await ensure();
    const port = Number(m[1]);
    const choice = await api.messageBox({ type: 'question', title: t('app.title'), message: t('web.pair.msg', { port }), detail: t('web.pair.detail'), buttons: [t('web.pair.connect'), t('web.trust.cancel')], defaultId: 0, cancelId: 1 });
    if (choice !== 0) return;
    const res = await llmPair({ port, key: m[2] });
    if (!res.ok) return;
    const test = await aiTest();
    if (window.VE.ai) {
      await window.VE.ai.refresh();
      if (test.ok) window.VE.ai.open();
    }
    if (window.VE.actions && window.VE.actions.toast) window.VE.actions.toast(t(test.ok ? 'web.pair.ok' : 'web.pair.failed'), test.ok ? 'success' : 'warning', 4200);
  }

  document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { takePairingLink(); }, 400); });
  window.addEventListener('hashchange', () => { takePairingLink(); });

  // The helper opens a NEW tab for the pairing link, while the tab with the user's project may be open already: that tab learns about the pairing here
  // (the event only reaches the OTHER tabs of this browser). Only the pairing is taken over: it is read and checked like at start, with the same effect as
  // pairing in this tab (the local model is the one in use). The other settings are read when a tab opens and never applied live: every GitHub Pages site of
  // an account shares this origin, so a storage event does not have to come from this editor.
  window.addEventListener('storage', (e) => {
    if (!K || e.storageArea !== localStorage || e.key !== LS_HELPER) return;
    helper = readHelper();
    helperState = { phase: 'unknown', error: '' };
    if (helper.port) settings = sanitize(Object.assign({}, settings, { provider: 'builtin', auth: 'key', baseUrl: '', model: '', apiVersion: '' }));
    if (window.VE && window.VE.ai && window.VE.ai.refresh) window.VE.ai.refresh();
  });
})();
