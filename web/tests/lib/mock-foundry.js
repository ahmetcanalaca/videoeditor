'use strict';
// A stand-in for the local web service of Foundry Local 0.14 for the tests of the bridge. It answers like the real one (checked against a running Foundry Local):
// no CORS headers at all (not even for a preflight: OPTIONS is "No mapping" like everything else), the routes /status, /v1/models, /v1/models/{id},
// /models/loaded, /models/load/{id or alias}, /models/unload/{id}, /v1/chat/completions, /shutdown, and the error bodies of the real server.
//   const mf = await start({ catalog?, port?, chat?(body, entry) -> { content?, tool_calls? } | { httpStatus, error }, chatDelayMs?, loadDelayMs? })
//   mf.log (requests), mf.loaded (Set), mf.maxConcurrent (most chat requests that were open at the same time), mf.port, mf.url, mf.stop()
const http = require('http');

const DEFAULT_CATALOG = [
  { id: 'qwen3.5-4b-generic-gpu:4', alias: 'qwen3.5-4b', cached: false, vision: true },
  { id: 'qwen3.5-4b-generic-cpu:3', alias: 'qwen3.5-4b', cached: true, vision: true },
  { id: 'qwen2.5-1.5b-instruct-generic-gpu:4', alias: 'qwen2.5-1.5b', cached: true, vision: false },
  { id: 'phi-4-mini-instruct-generic-cpu:5', alias: 'phi-4-mini', cached: false, vision: false },
];

const safeJson = (text) => { try { return JSON.parse(text); } catch (e) { return null; } };
const err = (message) => ({ error: { code: null, message, param: null, type: 'invalid_request_error' } });

function hasImage(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  return msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === 'image_url'));
}

function start(opts) {
  const o = Object.assign({ catalog: DEFAULT_CATALOG, port: 0, chat: null, chatDelayMs: 0, loadDelayMs: 0, pid: 4242 }, opts || {});
  const log = [];
  const loaded = new Set();
  const state = { open: 0, maxConcurrent: 0, seq: 0 };
  const byId = (id) => o.catalog.find((m) => m.id === id);
  // an alias picks a variant that is on the disk first (the real service picks the best variant that the computer can run)
  const resolve = (name) => byId(name) || o.catalog.find((m) => m.alias === name && m.cached) || o.catalog.find((m) => m.alias === name);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { method: req.method, path: u.pathname, headers: req.headers, body: raw ? safeJson(raw) : null, rawLength: raw.length, closed: false };
      log.push(entry);
      let gone = false;
      res.on('close', () => { gone = true; entry.closed = !res.writableEnded; });
      const send = (status, json, extraHeaders) => {
        if (gone) return;
        const text = typeof json === 'string' ? json : JSON.stringify(json);
        res.writeHead(status, Object.assign({ 'content-type': typeof json === 'string' ? 'text/plain' : 'application/json', 'content-length': Buffer.byteLength(text), server: 'oatpp/1.3.0' }, extraHeaders || {}));
        res.end(text);
      };
      const noMapping = () => send(404, 'server=oatpp/1.3.0\ncode=404\ndescription=Not Found\nmessage=No mapping for HTTP-method: \'' + req.method + '\', URL: \'' + u.pathname + '\'');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const p = u.pathname;
      try {
        if (req.method === 'GET' && p === '/status') {
          return send(200, { artifact_qualified_model_management: true, endpoints: ['http://127.0.0.1:' + server.address().port], modelCachePath: 'C:\\Users\\test/.foundry/cache/models', pid: o.pid });
        }
        if (req.method === 'GET' && p === '/v1/models') {
          return send(200, { data: o.catalog.map((m) => ({ created: 1763106101, id: m.id, object: 'model', owned_by: 'Microsoft' })), object: 'list' });
        }
        if (req.method === 'GET' && p.startsWith('/v1/models/')) {
          const m = byId(decodeURIComponent(p.slice('/v1/models/'.length)));
          return m ? send(200, { created: 1763106101, id: m.id, object: 'model', owned_by: 'Microsoft' }) : send(404, err("Model not found: No model matching '" + decodeURIComponent(p.slice(11)) + "'"));
        }
        if (req.method === 'GET' && p === '/models/loaded') return send(200, Array.from(loaded));
        if (req.method === 'GET' && p.startsWith('/models/load/')) {
          const name = decodeURIComponent(p.slice('/models/load/'.length));
          const m = resolve(name);
          if (!m) return send(404, err("Model not found: No model matching '" + name + "'"));
          if (!m.cached) return send(400, err('Model not cached: Model must be downloaded before loading'));
          if (o.loadDelayMs) await sleep(o.loadDelayMs);
          loaded.add(m.id);
          return send(200, { context_length: 32768, model_id: m.id, model_path: 'C:\\Users\\test\\.foundry\\cache\\models\\Microsoft\\' + m.id.replace(':', '-') + '\\v1', status: 'loaded' });
        }
        if (req.method === 'GET' && p.startsWith('/models/unload/')) {
          const name = decodeURIComponent(p.slice('/models/unload/'.length));
          const m = byId(name);
          if (!m) return send(404, err("Model not found: No model matching '" + name + "'"));
          loaded.delete(m.id);
          return send(200, { status: 'unloaded' });
        }
        if (req.method === 'GET' && p === '/shutdown') return send(200, { status: 'shutting_down' });
        if (req.method === 'POST' && p === '/v1/chat/completions') {
          state.open++;
          state.maxConcurrent = Math.max(state.maxConcurrent, state.open);
          // (a request counts as open until its connection is over - an aborted one included, even if this handler is still waiting)
          let counted = true;
          res.on('close', () => { if (counted) { counted = false; state.open--; } });
          {
            const body = entry.body;
            const m = body && typeof body.model === 'string' ? byId(body.model) : null;
            if (!m) return send(404, err("Model not found: No model matching '" + (body && body.model) + "'"));
            if (!loaded.has(m.id)) return send(400, err("Model not loaded: Model '" + m.id + "' must be loaded before inference"));
            if (hasImage(body) && !m.vision) return send(400, err('Invalid request: prepared_chat_prompt.cc:111 fl::PrepareMediaChatPrompt image or audio input requires a multimodal model'));
            if (o.chatDelayMs) await sleep(o.chatDelayMs);
            if (gone) return;
            const msg = o.chat ? await o.chat(body, entry) : { content: 'OK' };
            if (msg && msg.httpStatus) return send(msg.httpStatus, err(msg.error || 'error'));
            const calls = ((msg && msg.tool_calls) || []).map((c, i) => ({ id: 'call_' + state.seq + '_' + i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
            return send(200, {
              choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', index: 0, logprobs: null, message: { content: msg && msg.content !== undefined ? msg.content : null, refusal: null, role: 'assistant', tool_calls: calls.length ? calls : undefined } }],
              created: 1794504634, id: 'chatcmpl-' + (++state.seq), model: m.id, object: 'chat.completion', system_fingerprint: null, usage: { completion_tokens: 3, prompt_tokens: 31 },
            });
          }
        }
        return noMapping();
      } catch (e) {
        return send(500, err(String((e && e.message) || e)));
      }
    });
  });
  return new Promise((resolve2, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => {
      const port = server.address().port;
      resolve2({
        server, port, url: 'http://127.0.0.1:' + port, log, loaded, catalog: o.catalog,
        get maxConcurrent() { return state.maxConcurrent; },
        setChat(fn) { o.chat = fn; },
        setChatDelay(ms) { o.chatDelayMs = ms; },
        setLoadDelay(ms) { o.loadDelayMs = ms; },
        paths() { return log.map((e) => e.method + ' ' + e.path); },
        stop() { return new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }); },
      });
    });
  });
}

module.exports = { start, DEFAULT_CATALOG };
