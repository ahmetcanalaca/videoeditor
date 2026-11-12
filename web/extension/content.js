'use strict';
// Runs only on the pages that manifest.json names (the Video Editor web app), in the extension's own isolated world. It does one thing: it carries messages
// between the page (window.postMessage) and the service worker (a Port). It has no say in what is allowed: the page is untrusted, so only the known
// operations are passed on, with fields of the expected type, and the service worker decides (approval, routes, sizes - see policy.js and background.js).
(function () {
  if (window.__veFlBridge) return; // one copy per page (the service worker may inject it again into a page that already has it)
  // A window that another page opened (window.open) is in that page's hands: the opener can reach into it when it has the same origin - as every page of
  // github.io has - and would speak for it. The editor is opened by the person (an address, a bookmark, a link), which leaves no opener.
  if (window.opener) return;
  window.__veFlBridge = true;

  const VERSION = chrome.runtime.getManifest().version;
  const PAGE = 've-fl-page'; // marks the messages of the page
  const EXT = 've-fl-ext'; // marks the messages of this script
  const KEEPALIVE_MS = 20000;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  // What is passed on for each operation: the fields of the page's message that are known, checked for their type. (The page never chooses an address or a port.)
  const ops = {
    hello: (m) => ({ lang: str(m.lang, 5) }),
    connect: (m) => ({ lang: str(m.lang, 5) }),
    discover: (m) => ({ scan: m.scan === true }),
    call: (m) => ({ route: str(m.route, 20), modelId: str(m.modelId, 200), body: typeof m.body === 'string' ? m.body : undefined, timeoutMs: Number.isFinite(m.timeoutMs) ? m.timeoutMs : 0 }),
    abort: (m) => ({ target: Number.isSafeInteger(m.target) ? m.target : -1 }),
  };

  let port = null;
  let keepalive = 0;
  const open = new Set(); // ids of the requests that wait for an answer

  const toPage = (msg) => window.postMessage(Object.assign({ source: EXT }, msg), location.origin);
  const answer = (id, reply) => toPage({ type: 'reply', id, reply });

  // The worker of an extension is stopped after 30 seconds without an event; a model that is loading or thinking takes longer than that, so while a request is
  // open this script sends a small message every 20 seconds.
  function stopKeepalive() { if (!open.size && keepalive) { clearInterval(keepalive); keepalive = 0; } }
  function startKeepalive() {
    if (keepalive) return;
    keepalive = setInterval(() => { try { if (port) port.postMessage({ t: 'ping' }); } catch (e) { /* the port is gone: onDisconnect reports it */ } }, KEEPALIVE_MS);
  }

  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 've-fl-bridge' });
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.id)) return;
      if (open.delete(m.id)) { answer(m.id, m.reply); stopKeepalive(); }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      const ids = Array.from(open);
      open.clear();
      stopKeepalive();
      ids.forEach((id) => answer(id, { ok: false, code: 'INTERRUPTED' }));
    });
    return port;
  }

  function onPageMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.source !== PAGE || !Number.isSafeInteger(m.id) || typeof m.op !== 'string') return;
    if (!Object.prototype.hasOwnProperty.call(ops, m.op)) { answer(m.id, { ok: false, code: 'BAD_REQUEST' }); return; }
    const req = Object.assign({ id: m.id, op: m.op }, ops[m.op](m));
    // whether a click or a key press is behind this message is known here, not to the page (it is only needed for opening a window and for the port scan)
    req.gesture = !!(navigator.userActivation && navigator.userActivation.isActive);
    try {
      connect().postMessage(req);
      if (m.op !== 'abort') { open.add(m.id); startKeepalive(); } else answer(m.id, { ok: true });
    } catch (err) {
      // the extension was updated or removed while this page was open: this copy is dead, a new one takes over (the service worker puts it into the page)
      port = null;
      window.removeEventListener('message', onPageMessage, false);
      window.__veFlBridge = false;
      answer(m.id, { ok: false, code: 'EXTENSION_RELOADED' });
    }
  }
  window.addEventListener('message', onPageMessage, false);

  // a page that is shown without a signal: the attribute is there before any script of the page runs
  document.documentElement.setAttribute('data-ve-fl-bridge', VERSION);
  toPage({ type: 'ready', version: VERSION });
})();
