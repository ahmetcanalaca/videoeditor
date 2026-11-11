'use strict';
// Tests of the LLM provider adapters (src/main/ai/providers.js) against local mock servers: wire formats of OpenAI, Azure OpenAI,
// Anthropic and Gemini, tool calling round trips with verbatim replay, error mapping, retries, abort/timeout, key hygiene.
const http = require('http');
const { createProvider, AiError, toGeminiSchema, PROVIDER_KINDS } = require('../src/main/ai/providers');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
async function rejects(fn, code, msg) {
  try { await fn(); } catch (e) {
    if (!(e instanceof AiError)) throw new Error((msg || 'error') + ': not an AiError: ' + (e && e.stack));
    if (code && e.code !== code) throw new Error((msg || 'error') + ': expected code ' + code + ', got ' + e.code + ' (' + e.message + ')');
    return e;
  }
  throw new Error((msg || 'call') + ': expected a rejection with ' + code);
}

const KEY = 'TEST_KEY_not_a_real_secret_0123456789';

function mock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { /* not JSON */ }
      const entry = { method: req.method, url: req.url, headers: req.headers, raw, body };
      requests.push(entry);
      const out = handler(entry, requests.length) || {};
      if (out.hang) return;
      res.writeHead(out.status || 200, Object.assign({ 'content-type': 'application/json' }, out.headers || {}));
      res.end(out.text !== undefined ? out.text : JSON.stringify(out.json === undefined ? {} : out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
  })));
}
const withServer = async (handler, fn) => { const s = await mock(handler); try { return await fn(s); } finally { await s.close(); } };
const mk = (kind, baseUrl, extra) => createProvider(Object.assign({ kind, baseUrl, model: 'test-model', apiKey: KEY, fetch: globalThis.fetch, sleep: () => Promise.resolve() }, extra || {}));

const TOOLS = [
  { name: 'remove_range', description: 'Remove a range', parameters: { type: 'object', properties: { start: { type: 'number', description: 's' }, end: { type: 'number' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['start'] } },
  { name: 'open_export_dialog', description: 'Open export', parameters: { type: 'object', properties: {} } },
];
const noKey = (e) => { const s = JSON.stringify(e.url) + JSON.stringify(e.body); ok(!s.includes(KEY), 'the key leaked into the URL or body'); };

/* ------------------------------------------------------------------ OpenAI */

const oaText = { choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } };
const oaCalls = {
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'call_a', type: 'function', function: { name: 'remove_range', arguments: '{"start":1,"end":2}' }, extra_content: { sig: 'keep-me' } },
    { id: 'call_b', type: 'function', function: { name: 'open_export_dialog', arguments: '' } },
  ] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 20, completion_tokens: 9 },
};

test('openai: request shape (URL, Bearer header, system, tools, no sampling params, key only in the header)', () => withServer(() => ({ json: oaText }), async (s) => {
  const p = mk('openai', s.url + '/v1/');
  const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
  const req = s.requests[0];
  eq(req.url, '/v1/chat/completions');
  eq(req.headers.authorization, 'Bearer ' + KEY);
  noKey({ url: req.url, body: req.body });
  eq(req.body.model, 'test-model');
  same(req.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
  eq(req.body.tools.length, 2);
  eq(req.body.tools[0].type, 'function');
  eq(req.body.tools[0].function.name, 'remove_range');
  same(req.body.tools[0].function.parameters.required, ['start']);
  eq(req.body.tool_choice, 'auto');
  ok(!('temperature' in req.body) && !('max_tokens' in req.body) && !('max_completion_tokens' in req.body), 'sampling/limit params must not be sent');
  eq(r.text, 'Hello'); eq(r.stopReason, 'end'); same(r.usage, { input: 11, output: 5 }); same(r.toolCalls, []);
  eq(r.raw.content, 'Hello');
}));

test('openai: no tools means no tools/tool_choice in the body', () => withServer(() => ({ json: oaText }), async (s) => {
  await mk('openai', s.url).chat({ messages: [{ role: 'user', content: 'x' }], tools: [] });
  ok(!('tools' in s.requests[0].body) && !('tool_choice' in s.requests[0].body));
  ok(s.requests[0].body.messages.every((m) => m.role !== 'system'), 'no empty system message');
}));

test('openai: tool calls are parsed (two calls, empty arguments) and the round trip replays them verbatim', () => withServer((req, n) => ({ json: n === 1 ? oaCalls : oaText }), async (s) => {
  const p = mk('openai', s.url + '/v1');
  const msgs = [{ role: 'user', content: 'go' }];
  const r1 = await p.chat({ messages: msgs, tools: TOOLS });
  eq(r1.stopReason, 'tool_calls'); eq(r1.text, '');
  eq(r1.toolCalls.length, 2);
  same(r1.toolCalls[0], { id: 'call_a', name: 'remove_range', args: { start: 1, end: 2 } });
  same(r1.toolCalls[1], { id: 'call_b', name: 'open_export_dialog', args: {} });
  msgs.push({ role: 'assistant', content: r1.text, toolCalls: r1.toolCalls, raw: r1.raw });
  msgs.push({ role: 'tool', results: [{ id: 'call_a', name: 'remove_range', content: '{"ok":true}' }, { id: 'call_b', name: 'open_export_dialog', content: 'boom', isError: true }] });
  const r2 = await p.chat({ messages: msgs, tools: TOOLS });
  eq(r2.text, 'Hello');
  const sent = s.requests[1].body.messages;
  eq(sent.length, 4);
  eq(sent[1].role, 'assistant'); eq(sent[1].content, null);
  same(sent[1].tool_calls, oaCalls.choices[0].message.tool_calls, 'tool_calls must be replayed byte for byte (incl. unknown fields)');
  same(sent[2], { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true}' });
  same(sent[3], { role: 'tool', tool_call_id: 'call_b', content: 'boom' });
}));

test('openai: without raw the assistant message is rebuilt from toolCalls', () => withServer(() => ({ json: oaText }), async (s) => {
  await mk('openai', s.url).chat({ messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'c1', name: 'remove_range', args: { start: 5 } }] },
    { role: 'tool', results: [{ id: 'c1', name: 'remove_range', content: 'done' }] },
  ] });
  const a = s.requests[0].body.messages[1];
  eq(a.content, 'thinking');
  same(a.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'remove_range', arguments: '{"start":5}' } }]);
}));

test('openai: invalid or non-object arguments give args:null + argsError (no throw)', () => withServer(() => ({ json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: 'x1', type: 'function', function: { name: 'remove_range', arguments: '{"start":' } },
  { id: 'x2', type: 'function', function: { name: 'remove_range', arguments: '[1,2]' } },
  { id: 'x3', type: 'function', function: { name: 'remove_range', arguments: { start: 3 } } },
] }, finish_reason: 'tool_calls' }] } }), async (s) => {
  const r = await mk('openai', s.url).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  eq(r.toolCalls[0].args, null); ok(/Invalid JSON/.test(r.toolCalls[0].argsError));
  eq(r.toolCalls[1].args, null); ok(/JSON object/.test(r.toolCalls[1].argsError));
  same(r.toolCalls[2].args, { start: 3 });
}));

test('openai: finish reasons, refusals and array content', () => withServer((req, n) => ({ json: [
  { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] },
  { choices: [{ message: { content: '', refusal: 'no' }, finish_reason: 'stop' }] },
  { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, finish_reason: 'stop' }] },
  { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
][n - 1] }), async (s) => {
  const p = mk('openai', s.url);
  const q = { messages: [{ role: 'user', content: 'x' }] };
  eq((await p.chat(q)).stopReason, 'length');
  eq((await p.chat(q)).stopReason, 'filtered');
  eq((await p.chat(q)).text, 'ab');
  eq((await p.chat(q)).stopReason, 'filtered');
}));

test('openai: listModels returns sorted unique ids; api.openai.com without a path gets /v1', async () => {
  await withServer(() => ({ json: { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, {}] } }), async (s) => {
    same(await mk('openai', s.url + '/v1').listModels(), ['a', 'b']);
    eq(s.requests[0].url, '/v1/models'); eq(s.requests[0].method, 'GET'); eq(s.requests[0].headers.authorization, 'Bearer ' + KEY);
  });
  const urls = [];
  const fakeFetch = async (url) => { urls.push(url); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(oaText) }; };
  await createProvider({ kind: 'openai', baseUrl: 'https://api.openai.com', model: 'm', apiKey: KEY, fetch: fakeFetch }).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(urls[0], 'https://api.openai.com/v1/chat/completions');
});

/* ------------------------------------------------------------------ Azure OpenAI */

test('azure classic: deployment route, api-version, api-key header (no Bearer), model not in the body', () => withServer(() => ({ json: oaText }), async (s) => {
  await mk('azure', s.url, { model: 'my-dep', apiVersion: '2025-01-01' }).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  const req = s.requests[0];
  eq(req.url, '/openai/deployments/my-dep/chat/completions?api-version=2025-01-01');
  eq(req.headers['api-key'], KEY);
  ok(!req.headers.authorization, 'classic route must not send Authorization');
  ok(!('model' in req.body), 'deployment is in the path');
  noKey({ url: req.url, body: req.body });
  eq(req.body.tools.length, 2);
}));

test('azure classic: default api-version', () => withServer(() => ({ json: oaText }), async (s) => {
  await mk('azure', s.url).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(s.requests[0].url, '/openai/deployments/test-model/chat/completions?api-version=2024-10-21');
}));

test('azure v1: /openai/v1 route with Bearer and the model in the body; listModels is empty without a request', () => withServer(() => ({ json: oaText }), async (s) => {
  const p = mk('azure', s.url + '/openai/v1/');
  await p.chat({ messages: [{ role: 'user', content: 'x' }] });
  const req = s.requests[0];
  eq(req.url, '/openai/v1/chat/completions');
  eq(req.headers.authorization, 'Bearer ' + KEY);
  eq(req.body.model, 'test-model');
  same(await p.listModels(), []);
  eq(s.requests.length, 1);
}));

/* ------------------------------------------------------------------ Anthropic */

const anText = { content: [{ type: 'text', text: 'Hi there' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 } };
const anCalls = {
  content: [
    { type: 'text', text: 'Working on it.' },
    { type: 'tool_use', id: 'toolu_1', name: 'remove_range', input: { start: 1, end: 2 } },
    { type: 'tool_use', id: 'toolu_2', name: 'open_export_dialog', input: {} },
  ],
  stop_reason: 'tool_use', usage: { input_tokens: 30, output_tokens: 20 },
};

test('anthropic: request shape (headers, max_tokens, system, input_schema, tool_choice) and text parsing', () => withServer(() => ({ json: anText }), async (s) => {
  const r = await mk('anthropic', s.url).chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
  const req = s.requests[0];
  eq(req.url, '/v1/messages');
  eq(req.headers['x-api-key'], KEY);
  eq(req.headers['anthropic-version'], '2023-06-01');
  ok(!req.headers.authorization, 'no Authorization header');
  noKey({ url: req.url, body: req.body });
  eq(req.body.model, 'test-model'); eq(req.body.max_tokens, 4096); eq(req.body.system, 'SYS');
  same(req.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  eq(req.body.tools[0].name, 'remove_range');
  same(req.body.tools[0].input_schema.required, ['start']);
  same(req.body.tool_choice, { type: 'auto' });
  eq(r.text, 'Hi there'); eq(r.stopReason, 'end'); same(r.usage, { input: 12, output: 4 });
}));

test('anthropic: tool_use blocks are parsed and the round trip replays the blocks verbatim; results go into one user message', () => withServer((req, n) => ({ json: n === 1 ? anCalls : anText }), async (s) => {
  const p = mk('anthropic', s.url);
  const msgs = [{ role: 'user', content: 'go' }];
  const r1 = await p.chat({ messages: msgs, tools: TOOLS });
  eq(r1.stopReason, 'tool_calls'); eq(r1.text, 'Working on it.');
  same(r1.toolCalls, [{ id: 'toolu_1', name: 'remove_range', args: { start: 1, end: 2 } }, { id: 'toolu_2', name: 'open_export_dialog', args: {} }]);
  msgs.push({ role: 'assistant', content: r1.text, toolCalls: r1.toolCalls, raw: r1.raw });
  msgs.push({ role: 'tool', results: [{ id: 'toolu_1', name: 'remove_range', content: 'ok' }, { id: 'toolu_2', name: 'open_export_dialog', content: 'bad', isError: true }] });
  msgs.push({ role: 'user', content: 'and then?' });
  await p.chat({ messages: msgs, tools: TOOLS });
  const sent = s.requests[1].body.messages;
  eq(sent.length, 3, 'consecutive user messages are merged so roles alternate');
  same(sent[1].content, anCalls.content, 'assistant blocks replayed verbatim');
  eq(sent[2].role, 'user');
  same(sent[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' });
  same(sent[2].content[1], { type: 'tool_result', tool_use_id: 'toolu_2', content: 'bad', is_error: true });
  same(sent[2].content[2], { type: 'text', text: 'and then?' });
}));

test('anthropic: stop reasons, invalid tool input, listModels', () => withServer((req, n) => ({ json: [
  { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' },
  { content: [], stop_reason: 'refusal' },
  { content: [{ type: 'tool_use', id: 't', name: 'remove_range', input: 'nope' }], stop_reason: 'tool_use' },
  { data: [{ id: 'claude-b' }, { id: 'claude-a' }] },
][n - 1] }), async (s) => {
  const p = mk('anthropic', s.url);
  const q = { messages: [{ role: 'user', content: 'x' }] };
  eq((await p.chat(q)).stopReason, 'length');
  eq((await p.chat(q)).stopReason, 'filtered');
  const r = await p.chat(q);
  eq(r.toolCalls[0].args, null); ok(r.toolCalls[0].argsError);
  same(await p.listModels(), ['claude-a', 'claude-b']);
  eq(s.requests[3].url, '/v1/models?limit=100');
  eq(s.requests[3].headers['x-api-key'], KEY);
}));

/* ------------------------------------------------------------------ Gemini */

const gmCalls = {
  candidates: [{ content: { role: 'model', parts: [
    { text: 'private thoughts', thought: true },
    { text: 'On it.' },
    { functionCall: { name: 'remove_range', args: { start: 1, end: 2 } }, thoughtSignature: 'SIG_A' },
    { functionCall: { name: 'open_export_dialog', args: {} } },
  ] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
};
const gmText = { candidates: [{ content: { role: 'model', parts: [{ text: 'Done', thoughtSignature: 'SIG_T' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } };

test('gemini: request shape (path, x-goog-api-key, systemInstruction, functionDeclarations, empty OBJECT omitted) and parsing', () => withServer(() => ({ json: gmText }), async (s) => {
  const r = await mk('gemini', s.url, { model: 'models/gemini-test' }).chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
  const req = s.requests[0];
  eq(req.url, '/v1beta/models/gemini-test:generateContent');
  eq(req.headers['x-goog-api-key'], KEY);
  ok(!req.url.includes('key='), 'no key in the query string');
  noKey({ url: req.url, body: req.body });
  same(req.body.systemInstruction, { parts: [{ text: 'SYS' }] });
  same(req.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  const decls = req.body.tools[0].functionDeclarations;
  eq(decls.length, 2);
  same(decls[0].parameters.required, ['start']);
  eq(decls[0].parameters.properties.mode.enum.length, 2);
  ok(!('parameters' in decls[1]), 'an OBJECT without properties is rejected by Gemini, so it must be omitted');
  eq(r.text, 'Done'); eq(r.stopReason, 'end'); same(r.usage, { input: 5, output: 1 });
}));

test('gemini: functionCall parts, thought parts are not text, synthesized ids, usage incl. thoughts', () => withServer(() => ({ json: gmCalls }), async (s) => {
  const r = await mk('gemini', s.url).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  eq(r.text, 'On it.');
  eq(r.stopReason, 'tool_calls');
  same(r.toolCalls, [{ id: 'call_1', name: 'remove_range', args: { start: 1, end: 2 } }, { id: 'call_2', name: 'open_export_dialog', args: {} }]);
  same(r.usage, { input: 40, output: 10 });
  eq(r.raw.length, 4);
}));

test('gemini: the round trip replays the model parts verbatim (thoughtSignature!) and answers with functionResponse parts', () => withServer((req, n) => ({ json: n === 1 ? gmCalls : gmText }), async (s) => {
  const p = mk('gemini', s.url);
  const msgs = [{ role: 'user', content: 'go' }];
  const r1 = await p.chat({ messages: msgs, tools: TOOLS });
  msgs.push({ role: 'assistant', content: r1.text, toolCalls: r1.toolCalls, raw: r1.raw });
  msgs.push({ role: 'tool', results: [{ id: 'call_1', name: 'remove_range', content: '{"ok":true,"message":"done"}' }, { id: 'call_2', name: 'open_export_dialog', content: 'plain text' }] });
  await p.chat({ messages: msgs, tools: TOOLS });
  const sent = s.requests[1].body.contents;
  eq(sent.length, 3);
  eq(sent[1].role, 'model');
  same(sent[1].parts, gmCalls.candidates[0].content.parts, 'parts must be replayed unchanged, including thoughtSignature and thought parts');
  eq(sent[2].role, 'user');
  same(sent[2].parts[0], { functionResponse: { name: 'remove_range', response: { ok: true, message: 'done' } } });
  same(sent[2].parts[1], { functionResponse: { name: 'open_export_dialog', response: { result: 'plain text' } } });
}));

test('gemini: function call ids are echoed in the functionResponse only when the model sent them', () => withServer((req, n) => ({ json: n === 1
  ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'fc-77', name: 'remove_range', args: {} } }] }, finishReason: 'STOP' }] } : gmText }), async (s) => {
  const p = mk('gemini', s.url);
  const r1 = await p.chat({ messages: [{ role: 'user', content: 'go' }], tools: TOOLS });
  eq(r1.toolCalls[0].id, 'fc-77');
  await p.chat({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: r1.toolCalls, raw: r1.raw }, { role: 'tool', results: [{ id: 'fc-77', name: 'remove_range', content: '{}' }] }], tools: TOOLS });
  eq(s.requests[1].body.contents[2].parts[0].functionResponse.id, 'fc-77');
}));

test('gemini: blocked prompts and safety stops', () => withServer((req, n) => ({ json: n === 1
  ? { promptFeedback: { blockReason: 'SAFETY' } } : { candidates: [{ finishReason: 'SAFETY' }] } }), async (s) => {
  const p = mk('gemini', s.url);
  const q = { messages: [{ role: 'user', content: 'x' }] };
  await rejects(() => p.chat(q), 'FILTERED', 'blocked prompt');
  const r = await p.chat(q);
  eq(r.stopReason, 'filtered'); eq(r.text, ''); same(r.toolCalls, []);
}));

test('gemini: listModels keeps generateContent models and strips the models/ prefix; toGeminiSchema drops unsupported keywords', () => withServer(() => ({ json: { models: [
  { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/embed-1', supportedGenerationMethods: ['embedContent'] },
  { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
] } }), async (s) => {
  same(await mk('gemini', s.url).listModels(), ['gemini-a', 'gemini-b']);
  eq(s.requests[0].url, '/v1beta/models?pageSize=200');
  const out = toGeminiSchema({ $schema: 'x', type: 'object', additionalProperties: false, properties: { a: { type: 'number', default: 1, minimum: 0, maximum: 5, description: 'd' }, b: { type: 'array', items: { type: 'integer' } }, c: { type: 'string', enum: ['x', 'y'] } }, required: ['a', 'zzz'] });
  same(out, { type: 'object', properties: { a: { type: 'number', description: 'd', minimum: 0, maximum: 5 }, b: { type: 'array', items: { type: 'integer' } }, c: { type: 'string', enum: ['x', 'y'] } }, required: ['a'] });
  same(toGeminiSchema(null), { type: 'string' });
}));

/* ------------------------------------------------------------------ errors */

const errCase = (status, body, code, extra) => withServer(() => Object.assign({ status }, body), async (s) => {
  const e = await rejects(() => mk('openai', s.url, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] }), code, 'HTTP ' + status);
  eq(e.status, status);
  if (extra) extra(e);
  ok(!JSON.stringify([e.message, e.detail]).includes(KEY));
});

test('errors: HTTP status mapping', async () => {
  await errCase(400, { json: { error: { message: 'bad things' } } }, 'BAD_REQUEST', (e) => eq(e.detail, 'bad things'));
  await errCase(413, { text: 'too big' }, 'BAD_REQUEST');
  await errCase(422, { json: {} }, 'BAD_REQUEST');
  await errCase(401, { json: { error: { message: 'Incorrect API key provided' } } }, 'AUTH');
  await errCase(403, { json: {} }, 'FORBIDDEN');
  await errCase(404, { json: { error: { message: 'model not found' } } }, 'NOT_FOUND');
  await errCase(429, { json: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } }, 'RATE_LIMIT', (e) => eq(e.retryAfterMs, 2000));
  await errCase(429, { json: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } }, 'QUOTA');
  await errCase(402, { json: {} }, 'QUOTA');
  await errCase(500, { json: { error: { message: 'oops' } } }, 'SERVER');
  await errCase(529, { text: 'overloaded' }, 'SERVER');
  await errCase(429, { json: { error: { code: 429, message: 'quota per minute', details: [{ '@type': 'x', retryDelay: '3s' }] } } }, 'RATE_LIMIT', (e) => eq(e.retryAfterMs, 3000));
});

test('errors: anthropic "credit balance is too low" is a QUOTA problem', () => withServer(() => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }), async (s) => {
  await rejects(() => mk('anthropic', s.url, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'QUOTA');
}));

test('errors: 200 with a non-JSON or unexpected body is BAD_RESPONSE for every provider', async () => {
  for (const [kind, body] of [['openai', { text: 'not json at all' }], ['openai', { json: { nothing: 1 } }], ['azure', { json: { choices: [] } }], ['anthropic', { json: { oops: true } }], ['gemini', { json: { candidates: [] } }]]) {
    await withServer(() => body, async (s) => { await rejects(() => mk(kind, s.url).chat({ messages: [{ role: 'user', content: 'x' }] }), 'BAD_RESPONSE', kind); });
  }
});

test('errors: connection refused is NETWORK and is retried maxRetries times', async () => {
  const s = await mock(() => ({}));
  const url = s.url;
  await s.close();
  let calls = 0;
  const sleeps = [];
  const p = mk('openai', url, { fetch: (u, i) => { calls++; return fetch(u, i); }, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  await rejects(() => p.chat({ messages: [{ role: 'user', content: 'x' }] }), 'NETWORK');
  eq(calls, 3);
  same(sleeps, [500, 1000]);
});

test('retries: 500,500,200 succeeds on the third request; 401 is never retried; exhausted retries throw the last error', async () => {
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
  await withServer((req, n) => (n < 3 ? { status: 500, json: { error: { message: 'x' } } } : { json: oaText }), async (s) => {
    const r = await mk('openai', s.url, { sleep }).chat({ messages: [{ role: 'user', content: 'x' }] });
    eq(r.text, 'Hello'); eq(s.requests.length, 3);
    same(sleeps, [500, 1000]);
  });
  await withServer(() => ({ status: 401, json: {} }), async (s) => {
    await rejects(() => mk('openai', s.url).chat({ messages: [{ role: 'user', content: 'x' }] }), 'AUTH');
    eq(s.requests.length, 1);
  });
  await withServer(() => ({ status: 503, json: {} }), async (s) => {
    await rejects(() => mk('openai', s.url, { maxRetries: 3 }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'SERVER');
    eq(s.requests.length, 4);
  });
  sleeps.length = 0;
  await withServer((req, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '2' }, json: {} } : n === 2 ? { status: 429, headers: { 'retry-after': '60' }, json: {} } : { json: oaText }), async (s) => {
    await mk('openai', s.url, { sleep }).chat({ messages: [{ role: 'user', content: 'x' }] });
    same(sleeps, [2000, 8000], 'Retry-After is honoured and capped at 8 s');
  });
});

test('retries: QUOTA, BAD_REQUEST and NOT_FOUND are not retried', async () => {
  for (const [status, body] of [[429, { error: { type: 'insufficient_quota', message: 'q' } }], [400, {}], [404, {}]]) {
    await withServer(() => ({ status, json: body.error ? body : { error: body } }), async (s) => {
      await rejects(() => mk('openai', s.url).chat({ messages: [{ role: 'user', content: 'x' }] }));
      eq(s.requests.length, 1, 'status ' + status);
    });
  }
});

test('abort: a pre-aborted signal sends nothing; aborting mid-request and while sleeping both give ABORTED', async () => {
  const ac0 = new AbortController();
  ac0.abort();
  await withServer(() => ({ json: oaText }), async (s) => {
    await rejects(() => mk('openai', s.url).chat({ messages: [{ role: 'user', content: 'x' }], signal: ac0.signal }), 'ABORTED', 'pre-aborted');
    eq(s.requests.length, 0);
  });
  await withServer(() => ({ hang: true }), async (s) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await rejects(() => mk('openai', s.url).chat({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal }), 'ABORTED', 'mid-request');
    eq(s.requests.length, 1);
  });
  await withServer(() => ({ status: 500, json: {} }), async (s) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await rejects(() => mk('openai', s.url, { sleep: () => new Promise(() => {}) }).chat({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal }), 'ABORTED', 'while sleeping');
    eq(s.requests.length, 1);
  });
});

test('timeout: a hanging server gives TIMEOUT after one retry', () => withServer(() => ({ hang: true }), async (s) => {
  await rejects(() => mk('openai', s.url, { timeoutMs: 80, maxRetries: 2 }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'TIMEOUT');
  eq(s.requests.length, 2);
}));

test('key hygiene: a provider that echoes the key in its error never leaks it through message/detail/JSON', async () => {
  for (const kind of PROVIDER_KINDS) {
    await withServer(() => ({ status: 401, json: { error: { message: 'Invalid key ' + KEY + ' for user' } }, headers: { 'x-echo': KEY } }), async (s) => {
      const base = kind === 'azure' ? s.url : s.url;
      const e = await rejects(() => mk(kind, base, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'AUTH', kind);
      ok(!JSON.stringify({ m: e.message, d: e.detail, s: e.stack && e.stack.split('\n')[0], c: e.code }).includes(KEY), kind + ': key leaked');
      ok(e.detail.includes('***'), kind + ': key must be masked in detail');
      noKey(s.requests[0]);
    });
  }
  const e = await rejects(() => mk('openai', 'http://127.0.0.1:1', { maxRetries: 0, fetch: async () => { throw new Error('connect failed for ' + KEY); } }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'NETWORK');
  ok(!e.detail.includes(KEY) && !e.message.includes(KEY), 'network error text must be scrubbed');
});

/* ------------------------------------------------------------------ Microsoft Foundry */

test('foundry: v1 route of a resource, bearer key, model in the body, no api-version, no api-key header', () => withServer(() => ({ json: oaText }), async (s) => {
  const r = await mk('foundry', s.url).chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
  const req = s.requests[0];
  eq(req.url, '/openai/v1/chat/completions');
  eq(req.headers.authorization, 'Bearer ' + KEY);
  ok(!('api-key' in req.headers), 'the v1 route uses the bearer header only');
  noKey({ url: req.url, body: req.body });
  eq(req.body.model, 'test-model');
  eq(req.body.tools.length, 2);
  ok(!('temperature' in req.body) && !('max_tokens' in req.body), 'cloud models keep their sampling defaults');
  eq(r.text, 'Hello');
}));

test('foundry: the address is completed - bare resource, /openai, /models, project endpoint, full v1 URL, custom gateway', async () => {
  const cases = [
    ['', '/openai/v1/chat/completions'],
    ['/', '/openai/v1/chat/completions'],
    ['/openai', '/openai/v1/chat/completions'],
    ['/openai/', '/openai/v1/chat/completions'],
    ['/openai/v1', '/openai/v1/chat/completions'],
    ['/openai/v1/', '/openai/v1/chat/completions'],
    ['/models', '/openai/v1/chat/completions'],
    ['/api/projects/my-proj', '/api/projects/my-proj/openai/v1/chat/completions'],
    ['/api/projects/my-proj/', '/api/projects/my-proj/openai/v1/chat/completions'],
    ['/api/projects/my-proj/openai/v1', '/api/projects/my-proj/openai/v1/chat/completions'],
    ['/gateway/llm', '/gateway/llm/chat/completions'],
  ];
  for (const [suffix, want] of cases) {
    await withServer(() => ({ json: oaText }), async (s) => {
      await mk('foundry', s.url + suffix).chat({ messages: [{ role: 'user', content: 'x' }] });
      eq(s.requests[0].url, want, 'endpoint "' + suffix + '"');
    });
  }
});

test('foundry: tool-call round trip uses the OpenAI wire format; there is no model listing (deployments are not listable)', () => withServer((req, n) => ({ json: n === 1 ? oaCalls : oaText }), async (s) => {
  const p = mk('foundry', s.url);
  const r1 = await p.chat({ messages: [{ role: 'user', content: 'go' }], tools: TOOLS });
  eq(r1.stopReason, 'tool_calls'); eq(r1.toolCalls.length, 2);
  const r2 = await p.chat({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: r1.toolCalls, raw: r1.raw }, { role: 'tool', results: [{ id: 'call_a', name: 'remove_range', content: '{}' }, { id: 'call_b', name: 'open_export_dialog', content: '{}' }] }], tools: TOOLS });
  eq(r2.text, 'Hello');
  eq(s.requests[1].body.messages.length, 4);
  same(await p.listModels(), []);
  eq(s.requests.length, 2, 'listModels must not call the service');
}));

test('foundry/azure: an Entra ID access token travels as a bearer token (classic Azure route: Authorization instead of api-key); long tokens are accepted', () => withServer(() => ({ json: oaText }), async (s) => {
  const token = 'eyJ' + 'a'.repeat(5000) + '.' + 'b'.repeat(900) + '.' + 'c'.repeat(300);
  await mk('azure', s.url, { apiKey: token, bearer: true, model: 'dep1' }).chat({ messages: [{ role: 'user', content: 'x' }] });
  const req = s.requests[0];
  ok(req.url.startsWith('/openai/deployments/dep1/chat/completions?api-version='), req.url);
  eq(req.headers.authorization, 'Bearer ' + token);
  ok(!('api-key' in req.headers), 'no api-key header with a bearer token');
  await mk('azure', s.url, { apiKey: KEY, model: 'dep1' }).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(s.requests[1].headers['api-key'], KEY);
  ok(!('authorization' in s.requests[1].headers), 'the classic route with a key keeps using api-key');
  await mk('foundry', s.url, { apiKey: token, bearer: true }).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(s.requests[2].headers.authorization, 'Bearer ' + token);
}));

/* ------------------------------------------------------------------ local models (Foundry Local, Ollama, LM Studio, llama.cpp) */

test('local: no key means no Authorization header; temperature/max_tokens bound a small model; /v1 is added', () => withServer(() => ({ json: oaText }), async (s) => {
  const p = mk('local', s.url, { apiKey: '' });
  const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
  const req = s.requests[0];
  eq(req.url, '/v1/chat/completions');
  ok(!('authorization' in req.headers) && !('api-key' in req.headers), 'no credentials without a key');
  eq(req.body.model, 'test-model');
  eq(req.body.temperature, 0.2);
  eq(req.body.max_tokens, 1024);
  eq(req.body.tool_choice, 'auto');
  eq(r.text, 'Hello');
  await mk('local', s.url + '/v1', { apiKey: '' }).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(s.requests[1].url, '/v1/chat/completions', 'an address that already ends with /v1 is not extended');
  await mk('local', s.url, { apiKey: KEY }).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(s.requests[2].headers.authorization, 'Bearer ' + KEY, 'an optional key is sent when there is one');
}));

test('local: models are listed with GET /v1/models; the request never goes to a non-local host', () => withServer(() => ({ json: { data: [{ id: 'qwen2.5:3b' }, { id: 'phi4-mini' }, { object: 'model' }] } }), async (s) => {
  same(await mk('local', s.url, { apiKey: '' }).listModels(), ['phi4-mini', 'qwen2.5:3b']);
  eq(s.requests[0].method, 'GET'); eq(s.requests[0].url, '/v1/models');
  ok(!('authorization' in s.requests[0].headers));
  for (const bad of ['https://example.com/v1', 'http://192.168.1.20:11434/v1', 'http://10.0.0.5:1234/v1', 'https://api.openai.com/v1']) {
    try { mk('local', bad, { apiKey: '' }); } catch (e) { eq(e.code, 'URL', bad); continue; }
    throw new Error('a local model must not accept ' + bad);
  }
  mk('local', 'https://localhost:1234/v1', { apiKey: '' });
  mk('local', 'http://[::1]:1234', { apiKey: '' });
}));

test('local: a long first answer is allowed (timeout default 3 min), cloud default stays at 90 s', async () => {
  let seen = 0;
  const realSet = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => { if (ms === 180000 || ms === 90000) seen = ms; return realSet(fn, ms, ...a); };
  try {
    await mk('local', 'http://127.0.0.1:9', { apiKey: '', fetch: async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(oaText) }) }).chat({ messages: [{ role: 'user', content: 'x' }] });
    eq(seen, 180000);
    await mk('openai', 'https://api.openai.com/v1', { fetch: async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(oaText) }) }).chat({ messages: [{ role: 'user', content: 'x' }] });
    eq(seen, 90000);
  } finally { global.setTimeout = realSet; }
});

test('reasoning models: <think> blocks are removed from the answer and from the message that is replayed', async () => {
  const mkRes = (content, extra) => ({ choices: [{ message: Object.assign({ role: 'assistant', content }, extra || {}), finish_reason: 'stop' }] });
  for (const kind of ['local', 'foundry', 'openai']) {
    await withServer(() => ({ json: mkRes('<think>The user wants a cut...\nline two</think>\n\nDone: trimmed.') }), async (s) => {
      const r = await mk(kind, s.url, { apiKey: kind === 'local' ? '' : KEY }).chat({ messages: [{ role: 'user', content: 'x' }] });
      eq(r.text, 'Done: trimmed.', kind);
      eq(r.raw.content, 'Done: trimmed.', kind + ' raw');
    });
  }
  await withServer(() => ({ json: mkRes('<think>never closed, the model ran out of tokens') }), async (s) => {
    const r = await mk('local', s.url, { apiKey: '' }).chat({ messages: [{ role: 'user', content: 'x' }] });
    eq(r.text, '');
  });
  await withServer(() => ({ json: { choices: [{ message: { role: 'assistant', content: '<think>plan</think>', tool_calls: oaCalls.choices[0].message.tool_calls }, finish_reason: 'tool_calls' }] } }), async (s) => {
    const r = await mk('local', s.url, { apiKey: '' }).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
    eq(r.toolCalls.length, 2); eq(r.text, ''); eq(r.raw.content, null);
    eq(r.raw.tool_calls.length, 2, 'the tool calls survive for the replay');
  });
});

test('models without tool calling are recognised (Ollama, LM Studio, Azure/Foundry wording) and reported as NO_TOOLS', async () => {
  const messages = [
    'registry.ollama.ai/library/gemma:2b does not support tools',
    'This model does not support function calling.',
    'Unsupported parameter: tools is not supported with this model.',
    'tools is not supported with this model.',
    "Model doesn't support tool use",
  ];
  for (const message of messages) {
    await withServer(() => ({ status: 400, json: { error: { message } } }), async (s) => {
      await rejects(() => mk('local', s.url, { apiKey: '', maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'NO_TOOLS', message);
    });
  }
  for (const message of ['Invalid request body', "Unsupported parameter: 'foo'", 'The model `x` does not exist', 'max_tokens is too large']) {
    await withServer(() => ({ status: 400, json: { error: { message } } }), async (s) => {
      await rejects(() => mk('foundry', s.url, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'BAD_REQUEST', message);
    });
  }
  await withServer(() => ({ status: 500, text: 'does not support tools' }), async (s) => {
    await rejects(() => mk('local', s.url, { apiKey: '', maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'SERVER', 'a 500 stays a server error');
  });
});

/* ------------------------------------------------------------------ configuration */

test('limits: an oversized answer is refused (BAD_RESPONSE) instead of being buffered', () => withServer(() => ({ text: JSON.stringify({ choices: [{ message: { content: 'x'.repeat(9 * 1024 * 1024) } }] }) }), async (s) => {
  const e = await rejects(() => mk('openai', s.url, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'BAD_RESPONSE');
  ok(/too large/.test(e.message), e.message);
}));

test('configuration validation: https only (http for localhost), no credentials/query, key/model/kind/fetch checks, slash stripping', async () => {
  const base = { kind: 'openai', model: 'm', apiKey: KEY, fetch: async () => ({}) };
  const bad = (over, msg) => { try { createProvider(Object.assign({}, base, over)); } catch (e) { eq(e.code, 'URL', msg); return; } throw new Error('expected URL error: ' + msg); };
  bad({ baseUrl: 'http://api.example.com/v1' }, 'http on a public host');
  bad({ baseUrl: 'ftp://example.com' }, 'ftp');
  bad({ baseUrl: 'https://u:p@example.com/v1' }, 'credentials');
  bad({ baseUrl: 'https://example.com/v1?key=1' }, 'query');
  bad({ baseUrl: 'https://example.com/v1#x' }, 'fragment');
  bad({ baseUrl: 'not a url' }, 'garbage');
  bad({ kind: 'azure', baseUrl: '' }, 'azure needs an endpoint');
  bad({ kind: 'nope' }, 'unknown kind');
  bad({ apiKey: 'has space' }, 'key with a space');
  bad({ apiKey: '' }, 'empty key');
  bad({ apiKey: 'k'.repeat(16385) }, 'huge key');
  bad({ model: '' }, 'empty model');
  bad({ model: 'bad\nmodel' }, 'control chars in the model');
  bad({ fetch: null }, 'missing fetch');
  createProvider(Object.assign({}, base, { baseUrl: 'http://127.0.0.1:11434/v1' }));
  createProvider(Object.assign({}, base, { baseUrl: 'http://localhost:11434/v1' }));
  createProvider(Object.assign({}, base, { baseUrl: 'http://[::1]:8080/v1' }));
  const urls = [];
  await createProvider(Object.assign({}, base, { baseUrl: 'https://gw.example.com/x/v1///', fetch: async (u) => { urls.push(u); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(oaText) }; } })).chat({ messages: [{ role: 'user', content: 'x' }] });
  eq(urls[0], 'https://gw.example.com/x/v1/chat/completions');
  same(PROVIDER_KINDS, ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local']);
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('PASS  ' + t.name); passed++; } catch (e) { console.log('FAIL  ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n==== ai-providers: ' + passed + '/' + (passed + failed) + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
