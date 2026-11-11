'use strict';
// Network policy of the AI assistant. The default session of the app stays completely offline (see hardenSession in main.js);
// assistant requests use their own in-memory session that may talk to ONE origin only: the endpoint the user configured.
// An in-process fetch of Chromium resolves "localhost" itself (RFC 6761: always loopback, no DNS lookup, never via a proxy), so the
// name is as safe as the numeric addresses here.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// https always; plain http only for the local machine (Ollama, LM Studio, ...). No credentials, query string or fragment in the URL.
function validateBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, code: 'URL_EMPTY' };
  if (s.length > 300) return { ok: false, code: 'URL_INVALID' };
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, code: 'URL_INVALID' }; }
  if (u.username || u.password) return { ok: false, code: 'URL_CREDENTIALS' };
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { ok: false, code: 'URL_SCHEME' };
  if (u.search || u.hash) return { ok: false, code: 'URL_INVALID' };
  return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, ''), origin: u.origin, local };
}

// ses: an Electron session (injected, so this file stays testable without Electron). getOrigin(): the currently allowed origin.
function createAiNet(opts) {
  const ses = opts.ses;
  const getOrigin = opts.getOrigin;
  const allowed = (url) => {
    try {
      const origin = getOrigin();
      return !!origin && new URL(url).origin === origin;
    } catch (e) {
      return false;
    }
  };
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !allowed(details.url) }));
  return {
    isAllowed: allowed,
    // redirect:'error' - a redirect could forward the key header to another host; credentials:'omit' - no cookies.
    fetch(url, init) {
      if (!allowed(url)) return Promise.reject(new Error('Blocked: not the configured AI endpoint'));
      return ses.fetch(url, Object.assign({}, init, { redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    },
  };
}

module.exports = { validateBaseUrl, createAiNet, LOCAL_HOSTS };
