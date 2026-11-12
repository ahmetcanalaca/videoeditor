'use strict';
// A stand-in for a model server on this computer (Ollama, LM Studio, llama.cpp) for the tests of the web assistant: the OpenAI
// protocol with an API key, the endpoints llama-server has (/health without a key, /props), CORS (the page is another origin) and scripted answers.
//   const mock = await start({ key, chat: async (body, entry) => ({ content?, tool_calls?: [{ name, args }] }) })
const http = require('http');

const KEY = 'TEST_KEY_not_a_real_secret_ai_ui';

const safeJson = (text) => { try { return JSON.parse(text); } catch (e) { return null; } };

function completion(msg, n) {
  const calls = (msg.tool_calls || []).map((c, i) => ({ id: 'call_' + n + '_' + i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
  return {
    id: 'chatcmpl-' + n, object: 'chat.completion', model: 'mock-model',
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: msg.content === undefined ? null : msg.content, tool_calls: calls.length ? calls : undefined } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

// opts: { key, models, vision, chat(body, entry) -> message | Promise<message>, delayMs }
function start(opts) {
  const o = Object.assign({ key: KEY, models: ['mock-model'], vision: true, chat: null, delayMs: 0 }, opts || {});
  const log = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = { 'access-control-allow-origin': origin || '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '60', vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: u.pathname, auth: req.headers.authorization || '', origin, headers: req.headers, body: chunks.length ? safeJson(Buffer.concat(chunks).toString('utf8')) : null };
      log.push(entry);
      const send = (status, json) => { const text = JSON.stringify(json); res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, cors)); res.end(text); };
      let closed = false;
      res.on('close', () => { closed = true; entry.closed = true; });
      if (u.pathname === '/health') { send(200, { status: 'ok' }); return; }
      if (entry.auth !== 'Bearer ' + o.key) { send(401, { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } }); return; }
      if (u.pathname === '/v1/models') { send(200, { object: 'list', data: o.models.map((id) => ({ id, object: 'model' })) }); return; }
      if (u.pathname === '/props') { send(200, { modalities: { vision: !!o.vision, audio: false } }); return; }
      if (u.pathname === '/v1/chat/completions' && req.method === 'POST' && o.chat) {
        try {
          if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
          if (closed) return;
          const msg = await o.chat(entry.body, entry);
          // { httpStatus, error }: an error answer instead of a completion (e.g. 400 "does not support tools")
          if (msg && msg.httpStatus) { if (!closed) send(msg.httpStatus, { error: { message: msg.error || 'error' } }); return; }
          if (!closed) send(200, completion(msg || { content: 'OK' }, ++seq));
        } catch (e) { if (!closed) send(500, { error: { message: String((e && e.message) || e) } }); }
        return;
      }
      send(404, { error: { message: 'not found: ' + u.pathname } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, key: o.key, url: 'http://127.0.0.1:' + port, log, setChat(fn) { o.chat = fn; }, setDelay(ms) { o.delayMs = ms; }, stop() { return new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }); } });
    });
  });
}

// Adds CORS (and answers the preflight) in front of another local server, e.g. tests/cu-mock.js, which does not know that a page may be the caller.
function corsProxy(targetPort) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-expose-headers': '*', vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const up = http.request({ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + targetPort }) }, (r) => {
      const headers = Object.assign({}, r.headers, cors);
      // the service names its own address in Operation-Location: it has to name the proxy, or the poll would go around it
      if (headers['operation-location']) headers['operation-location'] = String(headers['operation-location']).replace('127.0.0.1:' + targetPort, '127.0.0.1:' + server.address().port);
      res.writeHead(r.statusCode, headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502, cors); res.end(); });
    req.pipe(up);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: 'http://127.0.0.1:' + server.address().port, stop: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) }));
  });
}

module.exports = { start, corsProxy, KEY };
