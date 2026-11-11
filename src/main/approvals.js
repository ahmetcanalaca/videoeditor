'use strict';
// Paths the USER handed to the app (the command line / "open with", files really dropped on the window), as opposed to paths that a script in the
// page asks for. The page is the least trusted part of the app (it decodes untrusted media and renders model output), so a network path (which makes
// Windows contact a server) is only honoured when it is one of these.
const path = require('path');

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_PER_CALL = 500;

const normPath = (p) => path.resolve(String(p)).toLowerCase();
const samePath = (a, b) => { try { return !!a && !!b && normPath(a) === normPath(b); } catch (e) { return false; } };

// opts.now: clock (tests)
function createApprovals(opts) {
  const now = (opts && opts.now) || Date.now;
  const map = new Map(); // normalised path -> expiry time
  return {
    approve(list) {
      const t = now();
      for (const [k, expiry] of map) if (expiry < t) map.delete(k);
      for (const p of (Array.isArray(list) ? list : []).slice(0, MAX_PER_CALL)) {
        if (typeof p === 'string' && p && p.length < 1024 && !p.includes('\0')) map.set(normPath(p), t + TTL_MS);
      }
      while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
    },
    has(p) {
      try {
        const expiry = map.get(normPath(p));
        return !!expiry && expiry >= now();
      } catch (e) {
        return false;
      }
    },
    size: () => map.size,
  };
}

module.exports = { createApprovals, samePath, TTL_MS };
