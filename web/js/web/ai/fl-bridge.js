(function () {
  'use strict';
  // Page side of the Foundry Local bridge. Foundry Local's server sends no CORS headers, so a web page cannot read its answers; the browser extension in extension/
  // (installed by the user, approved per site) can, and carries a small, fixed set of requests for the page. This file is the page's end of that conversation:
  // window.postMessage to the extension's content script, which only exists on this site's pages once the extension is installed.
  //   VE.web.flBridge.detect()                         hello: is the extension there, which version, has the user approved this site?
  //   VE.web.flBridge.connect()                        asks the user for the approval (a window of the extension); call it from a click
  //   VE.web.flBridge.discover({ scan? })              where is Foundry Local? (scan: look through the dynamic port range; a click)
  //   VE.web.flBridge.call(route, { modelId?, body?, timeoutMs?, signal? })   one of the four routes: models loaded load chat
  //   VE.web.flBridge.fetchFor(AiError)                a fetch() for the provider adapters: POST /v1/chat/completions and GET /v1/models become routes
  // The page names neither an address nor a port: the extension knows where Foundry Local is, and checks that what answers there is Foundry Local. (A port other
  // than the ones it looks at - the last one, 5272 - is typed into the extension's own window, not into the page.)
  var VEW = window.VE.web;
  var PAGE = 've-fl-page'; // marks the messages of this page
  var EXT = 've-fl-ext'; // marks the messages of the extension
  var PROTOCOL = 1;
  var MIN_VERSION = [1, 0, 0]; // the oldest extension that has everything this page needs
  var HELLO_MS = 1500;
  var EXTRA_MS = 20000; // the page waits this long beyond the time limit it gave the extension
  var jobs = new Map();
  var seq = 0;
  var listening = false;

  function onMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || m.source !== EXT || m.type !== 'reply' || !Number.isSafeInteger(m.id)) return;
    var job = jobs.get(m.id);
    if (!job) return;
    jobs.delete(m.id);
    clearTimeout(job.timer);
    job.resolve(m.reply && typeof m.reply === 'object' ? m.reply : { ok: false, code: 'BAD_REPLY' });
  }

  // -> Promise<reply>; never rejects: { ok: false, code } when the extension does not answer in time
  function send(op, fields, waitMs, timeoutCode) {
    if (!listening) { window.addEventListener('message', onMessage, false); listening = true; }
    return new Promise(function (resolve) {
      var id = ++seq;
      var timer = setTimeout(function () { jobs.delete(id); resolve({ ok: false, code: timeoutCode || 'TIMEOUT' }); }, waitMs);
      jobs.set(id, { resolve: resolve, timer: timer, id: id });
      window.postMessage(Object.assign({ source: PAGE, id: id, op: op }, fields || {}), location.origin);
    });
  }
  send.lastId = function () { return seq; };

  var versionParts = function (v) { return String(v || '').split('.').map(function (n) { return parseInt(n, 10) || 0; }); };
  function atLeast(version, min) {
    var a = versionParts(version);
    for (var i = 0; i < 3; i++) { if ((a[i] || 0) !== min[i]) return (a[i] || 0) > min[i]; }
    return true;
  }

  var lang = function () { try { return window.VE.i18n.getLanguage() === 'en' ? 'en' : 'tr'; } catch (e) { return 'tr'; } };

  // -> { present, version, protocol, approved, base, compatible }
  function detect() {
    return send('hello', { lang: lang() }, HELLO_MS, 'NO_EXTENSION').then(function (r) {
      if (!r.ok) return { present: false, code: r.code, version: '', protocol: 0, approved: false, base: '', compatible: false };
      var compatible = r.protocol === PROTOCOL && atLeast(r.version, MIN_VERSION);
      return { present: true, version: String(r.version || ''), protocol: r.protocol | 0, approved: r.approved === true, base: typeof r.base === 'string' ? r.base : '', compatible: compatible };
    });
  }

  function connect() { return send('connect', { lang: lang() }, 4 * 60 * 1000, 'TIMEOUT'); }
  function discover(opts) {
    var o = opts || {};
    return send('discover', { scan: o.scan === true }, o.scan ? 120000 : 15000, 'TIMEOUT');
  }

  // One of the routes. -> { ok: true, status, text } (an HTTP error of Foundry Local is an answer too) | { ok: false, code }
  function call(route, opts) {
    var o = opts || {};
    if (o.signal && o.signal.aborted) return Promise.resolve({ ok: false, code: 'ABORTED' });
    var ms = Math.min(Math.max(Number(o.timeoutMs) || 120000, 1000), 600000);
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (r) { if (done) return; done = true; if (o.signal) o.signal.removeEventListener('abort', onAbort); resolve(r); };
      var fields = { route: route, timeoutMs: ms };
      if (typeof o.modelId === 'string') fields.modelId = o.modelId;
      if (typeof o.body === 'string') fields.body = o.body;
      var p = send('call', fields, ms + EXTRA_MS, 'TIMEOUT');
      var id = seq;
      var onAbort = function () {
        // the extension is told to stop (it closes the connection to Foundry Local); the caller does not wait for that
        send('abort', { target: id }, 5000, 'TIMEOUT');
        finish({ ok: false, code: 'ABORTED' });
      };
      if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
      p.then(finish);
    });
  }

  /* ---- a fetch() for the provider adapters of the assistant ---- */

  var CODES = {
    NO_EXTENSION: 'FL_NO_BRIDGE', EXTENSION_RELOADED: 'FL_NO_BRIDGE', INTERRUPTED: 'FL_NO_BRIDGE',
    NOT_APPROVED: 'FL_NOT_APPROVED', NOT_FOUND: 'FL_NOT_FOUND', NETWORK: 'NETWORK', TIMEOUT: 'TIMEOUT', TOO_LARGE: 'BAD_REQUEST', BAD_REQUEST: 'BAD_REQUEST', ROUTE_NOT_ALLOWED: 'BAD_REQUEST',
  };
  // the error that the adapters (and the assistant's error card) understand; AiError = the constructor of providers.js
  function bridgeError(AiError, code, detail) { return new AiError(CODES[code] || 'NETWORK', 'Foundry Local bridge: ' + code, { detail: detail || code }); }

  // only the two requests the adapters make; anything else is not served
  function routeOf(url, method) {
    var path;
    try { path = new URL(url).pathname; } catch (e) { return ''; }
    if (method === 'POST' && path === '/v1/chat/completions') return 'chat';
    if (method === 'GET' && path === '/v1/models') return 'models';
    return '';
  }

  // opts: { AiError, timeoutMs (of one request) }
  function fetchFor(opts) {
    var o = opts || {};
    return function bridgeFetch(url, init) {
      var i = init || {};
      var method = String(i.method || 'GET').toUpperCase();
      var route = routeOf(url, method);
      if (!route) return Promise.reject(new TypeError('Foundry Local bridge: this request is not served'));
      var signal = i.signal;
      var abortError = function () { return new DOMException('The request was cancelled', 'AbortError'); };
      return call(route, { body: typeof i.body === 'string' ? i.body : undefined, timeoutMs: o.timeoutMs, signal: signal }).then(function (r) {
        if (!r.ok) {
          if (r.code === 'ABORTED') throw abortError();
          throw bridgeError(o.AiError, r.code);
        }
        var nullBody = r.status < 200 || r.status === 204 || r.status === 205 || r.status === 304;
        return new Response(nullBody ? null : r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
      });
    };
  }

  VEW.flBridge = { PROTOCOL: PROTOCOL, MIN_VERSION: MIN_VERSION.join('.'), detect: detect, connect: connect, discover: discover, call: call, fetchFor: fetchFor, atLeast: atLeast, routeOf: routeOf, bridgeError: bridgeError };
}());
