'use strict';
// End-to-end of the non-UI AI pipeline: runAgent + the real provider adapters + the edit engine, against local mock servers that speak each
// provider's wire format. Checks that the tool-call round trip (incl. verbatim replay) works for all six kinds and that the project edits are right.
const http = require('http');
const M = require('../src/shared/model');
const { createProvider } = require('../src/main/ai/providers');
const { runAgent } = require('../src/main/ai/agent');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ±' + tol + ', got ' + a); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const KEY = 'TEST_KEY_not_a_real_secret_0123456789';
const media = { mA: { id: 'mA', name: 'clip.mp4', duration: 120, fps: 30, hasAudio: true, displayWidth: 1920, displayHeight: 1080 } };
const snapshot = () => ({ segments: [M.createSegment(media.mA, { id: 'a', in: 0, out: 120 })], media, exportSettings: {}, playhead: 0, selectedId: null });

// What the "model" decides in step 1: cut 0:10-0:20 and zoom 0:30-0:40 (both on ORIGINAL times).
const CALLS = [
  { name: 'remove_range', args: { start: 10, end: 20 } },
  { name: 'set_zoom', args: { start: 30, end: 40, mode: 'in', factor: 2, focus: 'top-left' } },
];
const FINAL = 'Kesildi ve yakınlaştırıldı.';

const SCRIPTS = {
  openai: {
    path: '/v1/chat/completions',
    first: () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: CALLS.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    last: () => ({ choices: [{ message: { role: 'assistant', content: FINAL }, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 10 } }),
    results: (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
  },
  azure: {
    path: '/openai/deployments/test-model/chat/completions?api-version=2024-10-21',
    first: () => SCRIPTS.openai.first(),
    last: () => SCRIPTS.openai.last(),
    results: (body) => SCRIPTS.openai.results(body),
  },
  foundry: {
    path: '/api/projects/my-project/openai/v1/chat/completions',
    first: () => SCRIPTS.openai.first(),
    last: () => SCRIPTS.openai.last(),
    results: (body) => SCRIPTS.openai.results(body),
  },
  local: {
    path: '/v1/chat/completions',
    first: () => SCRIPTS.openai.first(),
    last: () => SCRIPTS.openai.last(),
    results: (body) => SCRIPTS.openai.results(body),
  },
  anthropic: {
    path: '/v1/messages',
    first: () => ({ content: CALLS.map((c, i) => ({ type: 'tool_use', id: 'toolu_' + i, name: c.name, input: c.args })), stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } }),
    last: () => ({ content: [{ type: 'text', text: FINAL }], stop_reason: 'end_turn', usage: { input_tokens: 150, output_tokens: 10 } }),
    results: (body) => body.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)),
  },
  gemini: {
    path: '/v1beta/models/test-model:generateContent',
    first: () => ({ candidates: [{ content: { role: 'model', parts: CALLS.map((c, i) => Object.assign({ functionCall: { name: c.name, args: c.args } }, i === 0 ? { thoughtSignature: 'SIG_0' } : {})) }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }),
    last: () => ({ candidates: [{ content: { role: 'model', parts: [{ text: FINAL }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 10 } }),
    results: (body) => body.contents.filter((c) => c.role === 'user').flatMap((c) => c.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse.name)),
  },
};

function server(kind) {
  const script = SCRIPTS[kind];
  const requests = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push({ url: req.url, headers: req.headers, body });
      const out = requests.length === 1 ? script.first() : script.last();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, requests, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}

for (const kind of ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local']) {
  test(kind + ': agent + provider + engine - two tool calls on original times, replayed history, final text', async () => {
    const s = await server(kind);
    try {
      const baseUrl = kind === 'openai' ? s.url + '/v1' : (kind === 'foundry' ? s.url + '/api/projects/my-project' : s.url);
      const provider = createProvider({ kind, baseUrl, model: 'test-model', apiKey: kind === 'local' ? '' : KEY, fetch: globalThis.fetch, sleep: () => Promise.resolve() });
      const steps = [];
      const r = await runAgent({ provider, prompt: '10 ile 20 arasını kes, 30-40 arası yakınlaştır', snapshot: snapshot(), lang: 'tr', onStep: (x) => steps.push(x) });
      eq(r.ok, true, JSON.stringify(r));
      eq(r.message, FINAL);
      eq(r.changed, true);
      eq(r.iterations, 2);
      eq(r.toolCalls, 2);
      eq(r.usage.input, 250); eq(r.usage.output, 30);
      eq(s.requests.length, 2);
      eq(s.requests[0].url, SCRIPTS[kind].path);
      ok(!JSON.stringify(s.requests.map((q) => q.body)).includes(KEY), 'key in a request body');
      if (kind === 'local') {
        ok(s.requests.every((q) => !('authorization' in q.headers) && !('api-key' in q.headers)), 'a local model needs no credentials');
        ok(s.requests[0].body.tools.length === require('../src/shared/agent-ops').TOOL_DEFS.length && /Examples of tool calls/.test(s.requests[0].body.messages[0].content), 'a local model gets the lean prompt and every tool');
      }
      // the second request must carry both tool results
      eq(SCRIPTS[kind].results(s.requests[1].body).length, 2, 'tool results in the second request');
      if (kind === 'gemini') eq(s.requests[1].body.contents[1].parts[0].thoughtSignature, 'SIG_0', 'thoughtSignature must be replayed');
      if (kind === 'anthropic') eq(s.requests[1].body.messages[1].content[0].type, 'tool_use');
      // the project edit: 0:10-0:20 removed, 0:30-0:40 zoomed (original times!)
      eq(r.segments.length, 4);
      near(r.totalSeconds, 110, 1e-9);
      const zoomed = r.segments.find((x) => x.zoomTo === 2);
      near(zoomed.in, 30, 1e-9); near(zoomed.out, 40, 1e-9);
      near(zoomed.fx, 0.25, 1e-9); near(zoomed.fy, 0.25, 1e-9);
      eq(steps.map((x) => x.action.op).join(','), 'remove,zoom');
      eq(r.actions.length, 2);
    } finally { await s.close(); }
  });
}

test('a 401 from the provider surfaces as a structured AUTH error and nothing is committed', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key ' + KEY } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const provider = createProvider({ kind: 'openai', baseUrl: 'http://127.0.0.1:' + srv.address().port + '/v1', model: 'm', apiKey: KEY, fetch: globalThis.fetch, sleep: () => Promise.resolve() });
    const r = await runAgent({ provider, prompt: 'x', snapshot: snapshot(), lang: 'en' });
    eq(r.ok, false);
    eq(r.error.code, 'AUTH'); eq(r.error.status, 401);
    ok(!JSON.stringify(r).includes(KEY), 'the key must not appear in the result');
    ok(!r.segments, 'no segments on failure');
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('PASS  ' + t.name); passed++; } catch (e) { console.log('FAIL  ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n==== ai-e2e: ' + passed + '/' + (passed + failed) + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
