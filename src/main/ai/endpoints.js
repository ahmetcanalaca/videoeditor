'use strict';
// Forgiving clean-up of the endpoint a user pastes into the AI settings. The strict policy (https, no query, ...) lives in net.js and
// runs afterwards; this turns what portals and docs show (Azure "Target URI", Foundry project endpoint, a full API URL) into the
// base address the provider adapters expect, and picks up the deployment name / API version that such an address contains.

const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };

// kind: provider kind. text: what the user typed. hints: { model, apiVersion } already filled in (never overwritten).
// Returns { url, model, apiVersion }. An empty or unparsable input is returned trimmed; the URL policy reports the problem.
function normalizeEndpoint(kind, text, hints) {
  const h = hints || {};
  const out = { url: String(text == null ? '' : text).trim(), model: String(h.model || '').trim(), apiVersion: String(h.apiVersion || '').trim() };
  if (!out.url) return out;
  let u;
  try { u = new URL(out.url); } catch (e) { return out; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return out;
  // credentials are never "cleaned away" silently: the strict URL policy has to see them and refuse the address
  if (u.username || u.password) return out;
  let p = u.pathname.replace(/\/+$/, '');

  if (kind === 'azure' || kind === 'foundry') {
    // Azure portal "Target URI": .../openai/deployments/NAME/chat/completions?api-version=...
    const dep = /^(.*?)\/openai\/deployments\/([^/]+)(?:\/.*)?$/i.exec(p);
    if (dep) {
      p = dep[1];
      if (!out.model) out.model = decode(dep[2]);
      const ver = u.searchParams.get('api-version');
      if (kind === 'azure' && !out.apiVersion && ver) out.apiVersion = ver;
    }
    // a full v1 URL (.../openai/v1/chat/completions or .../responses) is cut back to the v1 base
    const v1 = /^(.*?\/openai\/v1)(?:\/.*)?$/i.exec(p);
    if (v1) p = v1[1];
    // the classic Azure OpenAI route is built from the bare resource address
    if (kind === 'azure' && /\/openai$/i.test(p)) p = p.replace(/\/openai$/i, '');
    u.search = '';
    u.hash = '';
  } else if (kind === 'openai' || kind === 'local') {
    p = p.replace(/\/(?:chat\/completions|models)$/i, '');
    if (kind === 'local' && p === '') p = '/v1';
  } else if (kind === 'anthropic') {
    p = p.replace(/\/v1(?:\/messages)?$/i, '');
  } else if (kind === 'gemini') {
    p = p.replace(/\/v1(?:beta)?(?:\/.*)?$/i, '');
  }
  out.url = u.origin + p + (u.search || '') + (u.hash || '');
  return out;
}

module.exports = { normalizeEndpoint };
