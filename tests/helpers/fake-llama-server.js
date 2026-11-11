'use strict';
// A stand-in for llama-server.exe that tests run through node. It speaks just enough of the real server's protocol:
//   GET  /health                public; 503 while "loading", 200 afterwards
//   GET  /v1/models             needs the API key (taken from the environment, like the real server's LLAMA_API_KEY)
//   POST /v1/chat/completions   needs the key; answers with a fixed text (or what FAKE_LLAMA_REPLY says)
//   GET  /_info                 needs the key; reports the command line and the LLAMA_* variables it was started with
// Behaviour switches (environment): FAKE_LLAMA_LOAD_MS, FAKE_LLAMA_FAIL_GPU=1 (exit when -ngl is not 0), FAKE_LLAMA_HANG=1 (never ready),
// FAKE_LLAMA_EXIT_AFTER_MS (crash after being ready), FAKE_LLAMA_REPLY.
const http = require('http');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(arg('--port'));
const host = arg('--host');
const key = process.env.LLAMA_API_KEY || '';
const ngl = arg('-ngl');

if (process.env.FAKE_LLAMA_FAIL_GPU === '1' && ngl && ngl !== '0') {
  console.error('ggml_vulkan: failed to allocate device memory (fake)');
  process.exit(3);
}

let loaded = false;
if (process.env.FAKE_LLAMA_HANG !== '1') {
  setTimeout(() => {
    loaded = true;
    if (process.env.FAKE_LLAMA_EXIT_AFTER_MS) setTimeout(() => process.exit(9), Number(process.env.FAKE_LLAMA_EXIT_AFTER_MS));
  }, Number(process.env.FAKE_LLAMA_LOAD_MS || 50));
}

const authorised = (req) => !key || req.headers.authorization === 'Bearer ' + key;

http.createServer((req, res) => {
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/health') return send(loaded ? 200 : 503, loaded ? { status: 'ok' } : { error: { message: 'Loading model' } });
  if (!authorised(req)) return send(401, { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } });
  if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
  if (req.url === '/_info') {
    const llamaEnv = Object.keys(process.env).filter((k) => /^LLAMA_/i.test(k));
    return send(200, { argv, host, llamaEnv, pid: process.pid });
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => send(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: process.env.FAKE_LLAMA_REPLY || 'pong' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    return undefined;
  }
  return send(404, { error: { message: 'not found' } });
}).listen(port, host || '127.0.0.1');
