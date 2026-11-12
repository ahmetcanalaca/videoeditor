(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VEPolicy = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // The rules of the bridge, as pure functions (no browser API): what a page may ask for, how big things may be, how Foundry Local is recognised, which
  // pages are served. Loaded by the service worker (importScripts) and by the unit tests (require). Everything a page sends is untrusted: checkCall() is the
  // only way from a page's message to a request, and it knows four routes of Foundry Local - nothing else.

  const PROTOCOL = 1;
  // Foundry Local model ids: "qwen3.5-4b-generic-cpu:3" (the same rule as the desktop app, src/main/foundry/local.js)
  const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
  const LIMITS = {
    requestChars: 24 * 1024 * 1024, // a chat request with pictures (base64) is a few MB
    responseBytes: 8 * 1024 * 1024,
    statusBytes: 64 * 1024,
    messages: 400,
    timeoutMin: 1000,
    timeoutMax: 10 * 60 * 1000,
    timeoutDefault: 2 * 60 * 1000,
    concurrent: 2,
  };
  const PORT_MIN = 1024;
  const PORT_MAX = 65535;
  // where Foundry Local picks its port from when it is not fixed (observed: 54194 ... 63593), and the port that the documentation of the app recommends fixing
  const SCAN_RANGE = [49152, 65535];
  const DEFAULT_PORTS = [5272];

  // the routes of Foundry Local's local web service that the page may use (found in foundry_local.dll 0.14: /v1/models, /models/loaded, /models/load/{name},
  // /v1/chat/completions). What the page does not need is not here on purpose: /status (the extension reads it itself, to recognise Foundry Local; it names the
  // Windows user in the model cache path), /models/unload, /shutdown and everything else.
  const ROUTES = {
    models: { method: 'GET', path: () => '/v1/models' },
    loaded: { method: 'GET', path: () => '/models/loaded' },
    load: { method: 'GET', path: (id) => '/models/load/' + encodeURIComponent(id), id: true },
    chat: { method: 'POST', path: () => '/v1/chat/completions', body: true },
  };

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validPort = (n) => Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX;
  const baseOf = (port) => 'http://127.0.0.1:' + port;

  function clampTimeout(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return LIMITS.timeoutDefault;
    return Math.min(LIMITS.timeoutMax, Math.max(LIMITS.timeoutMin, Math.round(n)));
  }

  // What the messages of a chat request may contain besides text: pictures as JPEG data, which is all the app ever sends. A picture that is given as an address
  // (http:, file:) could make the model server fetch it. -> '' or what is wrong
  const IMAGE_PREFIX = 'data:image/jpeg;base64,';
  function badContent(messages) {
    for (const m of messages) {
      if (!isObj(m)) return 'message';
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (!isObj(part)) return 'content part';
        if (part.type === 'text') continue;
        if (part.type === 'image_url' && isObj(part.image_url) && typeof part.image_url.url === 'string' && part.image_url.url.startsWith(IMAGE_PREFIX)) continue;
        return 'content part';
      }
    }
    return '';
  }

  // message of a page -> { ok, route, method, path, body?, timeoutMs } | { ok: false, code, detail }
  function checkCall(msg) {
    const bad = (code, detail) => ({ ok: false, code, detail: detail || '' });
    if (!isObj(msg) || typeof msg.route !== 'string' || !Object.prototype.hasOwnProperty.call(ROUTES, msg.route)) return bad('ROUTE_NOT_ALLOWED');
    const r = ROUTES[msg.route];
    let path;
    if (r.id) {
      if (typeof msg.modelId !== 'string' || !MODEL_ID_RE.test(msg.modelId)) return bad('BAD_REQUEST', 'model id');
      path = r.path(msg.modelId);
    } else {
      path = r.path();
    }
    let body;
    if (r.body) {
      if (typeof msg.body !== 'string' || !msg.body) return bad('BAD_REQUEST', 'body');
      if (msg.body.length > LIMITS.requestChars) return bad('TOO_LARGE', 'body');
      let json;
      try { json = JSON.parse(msg.body); } catch (e) { return bad('BAD_REQUEST', 'body is not JSON'); }
      if (!isObj(json) || typeof json.model !== 'string' || !MODEL_ID_RE.test(json.model)) return bad('BAD_REQUEST', 'model');
      if (!Array.isArray(json.messages) || !json.messages.length || json.messages.length > LIMITS.messages) return bad('BAD_REQUEST', 'messages');
      // the bridge hands over whole answers: a stream would be cut at the size limit and cannot be cancelled by the page
      if (json.stream !== undefined && json.stream !== false) return bad('BAD_REQUEST', 'stream');
      const content = badContent(json.messages);
      if (content) return bad('BAD_REQUEST', content);
      // What is sent is what was checked: the object that was read, written again. (A body that names a key twice is read differently by different parsers.)
      body = JSON.stringify(json);
    } else if (msg.body !== undefined && msg.body !== null) {
      return bad('BAD_REQUEST', 'this route takes no body');
    }
    return { ok: true, route: msg.route, method: r.method, path, body, timeoutMs: clampTimeout(msg.timeoutMs) };
  }

  const sameBase = (a, b) => {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.protocol === y.protocol && x.hostname === y.hostname && x.port === y.port;
    } catch (e) { return false; }
  };

  // The answer of GET /status of Foundry Local: { artifact_qualified_model_management, endpoints: [url], modelCachePath, pid }. Anything else listening on the
  // port is not Foundry Local and gets nothing: the answer has to name the very address it was asked at.
  function isFoundryStatus(json, base) {
    if (!isObj(json)) return false;
    if (!Array.isArray(json.endpoints) || !json.endpoints.length || json.endpoints.length > 8) return false;
    if (!json.endpoints.every((e) => typeof e === 'string' && e.length <= 200)) return false;
    if (typeof json.modelCachePath !== 'string' || !json.modelCachePath || json.modelCachePath.length > 1000) return false;
    if (!Number.isInteger(json.pid) || json.pid <= 0) return false;
    return json.endpoints.some((e) => sameBase(e, base));
  }

  /* ---- which pages are served: the match patterns of the manifest's content script (the one list there is) ---- */

  function matchesPattern(url, pattern) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return false;
    const m = /^(https|http):\/\/([^/]+)(\/.*)$/.exec(String(pattern));
    if (!m) return false;
    if (m[1] + ':' !== u.protocol) return false;
    // (a port is not part of a match pattern: it matches every port)
    const host = m[2].toLowerCase();
    if (host.startsWith('*.') ? !(u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1))) : u.hostname !== host) return false;
    const re = new RegExp('^' + m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(u.pathname + u.search);
  }

  // -> the origin of the page when its address matches a pattern, else ''
  function originAllowed(url, patterns) {
    if (typeof url !== 'string' || !Array.isArray(patterns)) return '';
    return patterns.some((p) => matchesPattern(url, p)) ? new URL(url).origin : '';
  }

  const cleanLang = (v) => (v === 'tr' || v === 'en' ? v : '');

  return { PROTOCOL, MODEL_ID_RE, LIMITS, PORT_MIN, PORT_MAX, SCAN_RANGE, DEFAULT_PORTS, ROUTES, validPort, baseOf, clampTimeout, checkCall, isFoundryStatus, matchesPattern, originAllowed, cleanLang };
}));
