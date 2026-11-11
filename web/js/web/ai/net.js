(function () {
  'use strict';
  // Page side of the assistant's network access. The page itself may only talk to its own origin (CSP connect-src 'self'); everything the assistant
  // sends goes through the network worker (net-worker.js), whose own policy - written by sw.js from the list kept here - names exactly the https
  // addresses the user has allowed, besides the providers' own addresses and this computer.
  //   VE.web.net.fetch(url, init)  like fetch(), through the worker (init: method, headers, body, signal)
  //   VE.web.net.trust             addresses the user allowed: has(origin) / add(origin) / remove(origin) / list() / clear()
  var VEW = window.VE.web;
  var TRUST_KEY = 've.web.trust.v1';
  var TRUST_CACHE = 've-trust';
  var WORKER_PATH = 'js/web/ai/net-worker.js';
  var MAX_ORIGINS = 50;
  var WELL_KNOWN = ['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com'];
  var LOOPBACK = ['127.0.0.1', 'localhost'];

  function validOrigin(o) { return typeof o === 'string' && o.length <= 300 && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o); }
  function isLoopbackOrigin(o) {
    try { var u = new URL(o); return LOOPBACK.indexOf(u.hostname) >= 0 && (u.protocol === 'http:' || u.protocol === 'https:'); } catch (e) { return false; }
  }

  /* ------------------------------------------------------------- the list of allowed addresses */

  var trusted = [];
  try {
    var saved = JSON.parse(localStorage.getItem(TRUST_KEY) || '{}');
    trusted = (saved && Array.isArray(saved.origins) ? saved.origins : []).filter(validOrigin).slice(0, MAX_ORIGINS);
  } catch (e) { trusted = []; }

  function persist() {
    try { localStorage.setItem(TRUST_KEY, JSON.stringify({ origins: trusted })); } catch (e) { /* storage blocked: the list is for this session only */ }
  }
  // sw.js reads this cache when the worker script is requested and puts the list into the worker's Content-Security-Policy
  function publish() {
    if (!('caches' in window)) return Promise.resolve();
    return caches.open(TRUST_CACHE).then(function (c) {
      return c.put('trust.json', new Response(JSON.stringify({ origins: trusted }), { headers: { 'Content-Type': 'application/json' } }));
    }).catch(function () { /* without it the worker's policy only lists the providers and this computer */ });
  }
  function origins() { return WELL_KNOWN.concat(trusted.filter(function (o) { return WELL_KNOWN.indexOf(o) < 0; })); }

  /* ------------------------------------------------------------- the worker */

  var worker = null;
  var starting = null;
  var jobs = new Map();
  var seq = 0;

  function abortError() { return new DOMException('The request was cancelled', 'AbortError'); }

  function finish(id, err) {
    var job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (!err) return;
    if (job.head) { try { job.ctrl.error(err); } catch (e) { /* closed */ } } else job.reject(err);
  }

  function failAll(err) { Array.from(jobs.keys()).forEach(function (id) { finish(id, err); }); }

  function errorOf(m) {
    if (m.name === 'AbortError') return abortError();
    var e = new TypeError(m.message || 'Network error');
    e.name = m.name === 'NotAllowed' ? 'NotAllowed' : 'TypeError';
    return e;
  }

  function onMessage(event) {
    var m = event.data;
    var job = m && jobs.get(m.id);
    if (!job) return;
    if (m.t === 'head') {
      job.head = true;
      var noBody = m.status === 101 || m.status === 204 || m.status === 205 || m.status === 304;
      job.resolve(new Response(noBody ? null : job.stream, { status: m.status, statusText: m.statusText, headers: m.headers }));
      if (noBody) { try { job.ctrl.close(); } catch (e) { /* closed */ } finish(m.id); }
    } else if (m.t === 'chunk') {
      try { job.ctrl.enqueue(new Uint8Array(m.chunk)); } catch (e) { /* the reader went away */ }
    } else if (m.t === 'end') {
      try { job.ctrl.close(); } catch (e) { /* closed */ }
      finish(m.id);
    } else if (m.t === 'error') {
      finish(m.id, errorOf(m));
    }
  }

  function ensureWorker() {
    if (worker) return Promise.resolve(worker);
    if (!starting) {
      starting = publish().then(function () {
        var w = new Worker(new URL(WORKER_PATH, document.baseURI).href, { name: 've-net' });
        w.onmessage = onMessage;
        w.onerror = function () { failAll(new TypeError('The network worker could not run')); stop(); };
        w.postMessage({ t: 'init', origins: origins() });
        worker = w;
        starting = null;
        return w;
      }, function (e) { starting = null; throw e; });
    }
    return starting;
  }

  // a new worker is needed whenever the list of allowed addresses changes: the policy of a worker is fixed when it is created
  function stop() {
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
    worker = null;
    failAll(abortError());
  }

  function headerList(h) {
    if (!h) return [];
    if (typeof Headers !== 'undefined' && h instanceof Headers) return Array.from(h.entries());
    if (Array.isArray(h)) return h;
    return Object.keys(h).map(function (k) { return [k, h[k]]; });
  }

  function request(url, init) {
    var o = init || {};
    if (VEW.test && window.__veTest && typeof window.__veTest.netFetch === 'function') return Promise.resolve(window.__veTest.netFetch(String(url), o));
    var signal = o.signal || null;
    if (signal && signal.aborted) return Promise.reject(abortError());
    return ensureWorker().then(function (w) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        var job = { resolve: resolve, reject: reject, ctrl: null, head: false, signal: signal, onAbort: null, stream: null };
        job.stream = new ReadableStream({
          start: function (c) { job.ctrl = c; },
          cancel: function () { if (jobs.has(id)) { w.postMessage({ t: 'abort', id: id }); finish(id); } },
        });
        jobs.set(id, job);
        if (signal) {
          job.onAbort = function () { w.postMessage({ t: 'abort', id: id }); finish(id, abortError()); };
          signal.addEventListener('abort', job.onAbort, { once: true });
        }
        w.postMessage({ t: 'fetch', id: id, url: String(url), method: o.method || 'GET', headers: headerList(o.headers), body: o.body });
      });
    });
  }

  /* ------------------------------------------------------------- public */

  VEW.net = {
    fetch: request,
    isLoopbackOrigin: isLoopbackOrigin,
    wellKnown: WELL_KNOWN.slice(),
    trust: {
      has: function (origin) { return validOrigin(origin) && (WELL_KNOWN.indexOf(origin) >= 0 || trusted.indexOf(origin) >= 0); },
      list: function () { return trusted.slice(); },
      // the caller asked the USER first; resolves true when the address is allowed from now on
      add: function (origin) {
        if (!validOrigin(origin)) return Promise.resolve(false);
        if (WELL_KNOWN.indexOf(origin) >= 0 || trusted.indexOf(origin) >= 0) return Promise.resolve(true);
        trusted = trusted.concat(origin).slice(-MAX_ORIGINS);
        persist();
        stop();
        return publish().then(function () { return true; });
      },
      remove: function (origin) {
        var i = trusted.indexOf(origin);
        if (i < 0) return Promise.resolve(false);
        trusted.splice(i, 1);
        persist();
        stop();
        return publish().then(function () { return true; });
      },
      clear: function () { trusted = []; persist(); stop(); return publish(); },
    },
    reset: stop,
  };
})();
