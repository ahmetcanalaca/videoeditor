'use strict';
// Tests of the Azure Content Understanding client (src/main/ai/content-understanding.js) against a mock of the documented REST protocol.
const CU = require('../src/main/ai/content-understanding');
const { startMockCu, makeResult } = require('./cu-mock');
const settings = require('../src/main/settings');

let failed = 0;
let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
async function rejects(fn, code, msg) {
  try { await fn(); } catch (e) { if (code && e.code !== code) throw new Error((msg || 'error') + ': expected code ' + code + ', got ' + e.code + ' (' + e.message + ')'); return e; }
  throw new Error((msg || 'call') + ' should have failed' + (code ? ' with ' + code : ''));
}

const KEY = 'CU_TEST_KEY_not_a_real_secret_0123456789';
const BODY = Buffer.from('not really a video but bytes');
const quick = { sleep: () => Promise.resolve() };
const keyAuth = (log) => async (refresh) => { if (log) log.push(refresh); return { name: 'Ocp-Apim-Subscription-Key', value: KEY }; };
const client = (mock, extra) => CU.createCuClient(Object.assign({ endpoint: mock.origin, fetch: (u, i) => fetch(u, i), auth: keyAuth(), ...quick }, extra || {}));

test('settings and client agree on the processing locations and the default analyzer', () => {
  eq(settings.CU_LOCATIONS, CU.LOCATIONS);
  eq(settings.CU_DEFAULT_ANALYZER, CU.DEFAULT_ANALYZER);
  ok(settings.CU_ANALYZER_RE.source === CU.ANALYZER_RE.source, 'analyzer pattern');
  eq(CU.DEFAULT_LOCATION, 'geography', 'the data stays in the geography of the resource unless the user chooses otherwise');
});

test('deriveEndpoint: Foundry project and resource addresses, classic Azure OpenAI address, unknown gateways', () => {
  eq(CU.deriveEndpoint('https://res.services.ai.azure.com/api/projects/p1'), 'https://res.services.ai.azure.com');
  eq(CU.deriveEndpoint('https://res.services.ai.azure.com/openai/v1'), 'https://res.services.ai.azure.com');
  eq(CU.deriveEndpoint('https://res.cognitiveservices.azure.com'), 'https://res.cognitiveservices.azure.com');
  eq(CU.deriveEndpoint('https://res.openai.azure.com'), 'https://res.services.ai.azure.com');
  eq(CU.deriveEndpoint('https://gateway.contoso.com/ai'), '');
  eq(CU.deriveEndpoint('http://127.0.0.1:5000/openai/v1'), 'http://127.0.0.1:5000');
  eq(CU.deriveEndpoint('http://evil.example.com'), '', 'plain http to another host');
  eq(CU.deriveEndpoint(''), '');
});

test('validateEndpoint: only the origin counts, credentials / query / http to other hosts are refused', () => {
  eq(CU.validateEndpoint('https://res.services.ai.azure.com/api/projects/p').origin, 'https://res.services.ai.azure.com');
  ok(!CU.validateEndpoint('https://user:pw@res.services.ai.azure.com').ok);
  ok(!CU.validateEndpoint('https://res.services.ai.azure.com?x=1').ok);
  ok(!CU.validateEndpoint('http://res.services.ai.azure.com').ok);
  ok(CU.validateEndpoint('http://127.0.0.1:1234').ok);
  ok(!CU.validateEndpoint('').ok);
});

test('createCuClient refuses bad endpoints and falls back to safe defaults for analyzer / api version / location', () => {
  let threw = false;
  try { CU.createCuClient({ endpoint: 'ftp://x', fetch() {}, auth() {} }); } catch (e) { threw = true; }
  ok(threw, 'bad endpoint');
  const c = CU.createCuClient({ endpoint: 'https://r.services.ai.azure.com', fetch() {}, auth() {}, analyzerId: '../evil', apiVersion: 'x', processingLocation: 'moon' });
  eq([c.analyzerId, c.apiVersion, c.processingLocation], ['prebuilt-videoSearch', '2025-11-01', 'geography']);
});

test('analyze: upload, wait, result; the key goes in the header only; the service copy is deleted afterwards', async () => {
  const mock = await startMockCu({ key: KEY, polls: 2 });
  try {
    const seen = [];
    const r = await client(mock).analyze({ bytes: BODY, contentType: 'video/mp4', onStatus: (s) => seen.push(s.phase + ':' + (s.status || '')) });
    ok(r.result && Array.isArray(r.result.contents) && r.result.contents.length >= 1, 'result');
    eq(mock.uploads.length, 1);
    const up = mock.uploads[0];
    eq(up.analyzer, 'prebuilt-videoSearch');
    eq(up.query['api-version'], '2025-11-01');
    eq(up.query.processingLocation, 'geography');
    ok(up.bytes.equals(BODY), 'body is exactly the bytes');
    eq(up.headers['content-type'], 'video/mp4');
    ok(/^[0-9a-f-]{36}$/.test(up.headers['x-ms-client-request-id']), 'client request id');
    ok(seen[0] === 'uploading:' && seen.some((s) => s === 'waiting:running'), 'status events ' + seen.join(','));
    for (const e of mock.requests) ok(!e.path.includes(KEY) && !JSON.stringify(e.query).includes(KEY), 'the key is never part of a URL');
    // deleting is best effort and happens in the background: give it a moment
    await r.operationId && await new Promise((res) => setTimeout(res, 20));
    await client(mock).deleteResult(r.operationId);
    ok(mock.deleted.includes(r.operationId), 'the result at the service was deleted');
  } finally { await mock.stop(); }
});

test('analyze with Microsoft Entra: Authorization bearer instead of the key header', async () => {
  const mock = await startMockCu({ bearer: 'ENTRA_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789', polls: 0 });
  try {
    const c = client(mock, { auth: async () => ({ name: 'Authorization', value: 'Bearer ENTRA_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789' }) });
    const r = await c.analyze({ bytes: BODY });
    ok(r.result.contents.length >= 1);
    ok(!mock.uploads[0].headers['ocp-apim-subscription-key'], 'no key header with Entra');
  } finally { await mock.stop(); }
});

test('a wrong key: AUTH after ONE retry with a fresh credential; the key never appears in the error', async () => {
  const mock = await startMockCu({ key: 'another-key-than-the-one-we-send' });
  try {
    const log = [];
    const e = await rejects(() => client(mock, { auth: keyAuth(log) }).analyze({ bytes: BODY }), 'AUTH');
    eq(log, [false, true], 'the credential is refreshed once after a 401');
    ok(!JSON.stringify({ m: e.message, d: e.detail, s: e.status }).includes(KEY), 'no key in the error');
    eq(e.status, 401);
  } finally { await mock.stop(); }
});

test('HTTP errors of the upload are classified: 403, 404, 429 (retry-after), 413, 500, location and model-default problems', async () => {
  const cases = [
    [{ status: 403, code: 'AuthorizationFailed', message: 'denied' }, 'FORBIDDEN'],
    [{ status: 404, code: 'NotFound', message: 'Resource not found' }, 'NOT_FOUND'],
    [{ status: 429, code: 'TooManyRequests', message: 'slow down', headers: { 'retry-after': '7' } }, 'RATE_LIMIT'],
    [{ status: 413, code: 'RequestEntityTooLarge', message: 'too big' }, 'CU_UNSUPPORTED'],
    [{ status: 500, code: 'InternalServerError', message: 'oops' }, 'SERVER'],
    [{ status: 400, code: 'InvalidRequest', message: 'The processing location "geography" is not supported in this region' }, 'CU_LOCATION'],
    [{ status: 400, code: 'ModelDeploymentNotFound', message: 'No default model deployment is configured for gpt-4.1' }, 'CU_NO_DEFAULTS'],
  ];
  for (const [failPost, code] of cases) {
    const mock = await startMockCu({ key: KEY, failPost });
    try {
      const e = await rejects(() => client(mock).analyze({ bytes: BODY }), code, 'status ' + failPost.status);
      if (failPost.status === 429) eq(e.retryAfterMs, 7000);
      eq(mock.uploads.length, 0);
    } finally { await mock.stop(); }
  }
});

test('an analysis that ends in Failed: the service message is classified', async () => {
  for (const [failOperation, code] of [
    [{ code: 'InvalidContent', message: 'The video format is unsupported or the file is corrupt' }, 'CU_UNSUPPORTED'],
    [{ code: 'ModelDeploymentNotFound', message: 'Default model deployment for gpt-4.1 is not configured' }, 'CU_NO_DEFAULTS'],
    [{ code: 'Internal', message: 'something broke' }, 'CU_FAILED'],
  ]) {
    const mock = await startMockCu({ key: KEY, polls: 1, failOperation });
    try { await rejects(() => client(mock).analyze({ bytes: BODY }), code, failOperation.code); } finally { await mock.stop(); }
  }
});

test('an Operation-Location on another host is not followed (the key must not go there)', async () => {
  const mock = await startMockCu({ key: KEY, foreignLocation: true });
  try {
    await rejects(() => client(mock).analyze({ bytes: BODY }), 'BAD_RESPONSE');
  } finally { await mock.stop(); }
});

test('polling survives short outages (503) but gives up after too many', async () => {
  let mock = await startMockCu({ key: KEY, polls: 0, pollFailures: 3 });
  try { const r = await client(mock).analyze({ bytes: BODY }); ok(r.result.contents.length >= 1); } finally { await mock.stop(); }
  mock = await startMockCu({ key: KEY, polls: 0, pollFailures: 50 });
  try { await rejects(() => client(mock).analyze({ bytes: BODY }), 'SERVER'); } finally { await mock.stop(); }
});

test('the wait has a limit (TIMEOUT)', async () => {
  const mock = await startMockCu({ key: KEY, polls: 1000 });
  try {
    let t = 0;
    await rejects(() => client(mock, { maxWaitMs: 5000, now: () => (t += 1500) }).analyze({ bytes: BODY }), 'TIMEOUT');
  } finally { await mock.stop(); }
});

test('cancelling while waiting: ABORTED, and the service is asked to delete its copy', async () => {
  const mock = await startMockCu({ key: KEY, polls: 1000 });
  try {
    const ac = new AbortController();
    let n = 0;
    const c = client(mock, { sleep: async () => { if (++n === 3) ac.abort(); } });
    await rejects(() => c.analyze({ bytes: BODY, signal: ac.signal }), 'ABORTED');
    await new Promise((res) => setTimeout(res, 60));
    ok(mock.deleted.length === 1, 'delete after cancel: ' + mock.deleted.length);
  } finally { await mock.stop(); }
});

test('testConnection: model defaults + analyzer; every problem has its own code', async () => {
  let mock = await startMockCu({ key: KEY });
  try {
    const r = await client(mock).testConnection();
    eq(r.defaultsSet, true);
    eq(r.defaults['gpt-4.1'], 'gpt41');
    eq(r.analyzerOk, true);
    ok(mock.requests.every((e) => e.method === 'GET'), 'nothing is uploaded by the test');
  } finally { await mock.stop(); }
  mock = await startMockCu({ key: KEY, defaults: {} });
  try { eq((await client(mock).testConnection()).defaultsSet, false, 'empty defaults are reported, not thrown'); } finally { await mock.stop(); }
  mock = await startMockCu({ key: KEY, analyzerStatus: 404 });
  try { await rejects(() => client(mock, { analyzerId: 'my.analyzer' }).testConnection(), 'CU_NO_ANALYZER'); } finally { await mock.stop(); }
  mock = await startMockCu({ key: 'other' });
  try { await rejects(() => client(mock).testConnection(), 'AUTH'); } finally { await mock.stop(); }
});

test('a response that is not Content Understanding at all is BAD_RESPONSE, not a crash', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = CU.createCuClient({ endpoint: 'http://127.0.0.1:' + srv.address().port, fetch: (u, i) => fetch(u, i), auth: keyAuth(), ...quick });
    await rejects(() => c.testConnection(), 'BAD_RESPONSE');
  } finally { await new Promise((r) => srv.close(r)); }
});

/* ------------------------------------------------------------------ parsing */

// the video example of the quickstart (shortened)
const DOC_SAMPLE = {
  analyzerId: 'prebuilt-videoSearch', apiVersion: '2025-11-01',
  contents: [
    {
      markdown: '# Video: 00:00.733 => 00:15.467\nWidth: 1080\nHeight: 608\n\nTranscript\n```\nWEBVTT\n\n00:01.360 --> 00:06.640\n<Speaker 1>When it comes to the neural TTS, it\'s better to have good data.\n```',
      fields: { Summary: { type: 'string', valueString: 'The video opens with a Flight Simulator logo, followed by an interview with a man.' }, Tags: { type: 'array', valueArray: [{ type: 'string', valueString: 'interview' }, { type: 'string', valueString: 'logo' }] } },
      kind: 'audioVisual', startTimeMs: 733, endTimeMs: 15467, width: 1080, height: 608, keyFrameTimesMs: [733, 2067],
      transcriptPhrases: [{ speaker: 'Speaker 1', startTimeMs: 1360, endTimeMs: 6640, text: 'When it comes to the neural TTS, it is better to have good data.', confidence: 0.937, words: [{ startTimeMs: 1360, endTimeMs: 1600, text: 'When' }], locale: 'en-US' },
        { speaker: 'Speaker 2', startTimeMs: 13440, endTimeMs: 23680, text: 'We accumulated tons of data.', confidence: 0.9, words: [], locale: 'en-US' }],
      cameraShotTimesMs: [1467, 3233], mimeType: 'video/x-m4v',
    },
    {
      markdown: '# Video: 00:15.467 => 00:23.100\n\nKey Frames', fields: { Summary: { type: 'string', valueString: 'Scenic aerial views from the Flight Simulator.' } },
      kind: 'audioVisual', startTimeMs: 15467, endTimeMs: 23100, transcriptPhrases: [], cameraShotTimesMs: [1467, 3233, 16000],
    },
    { kind: 'document', markdown: 'ignored' },
  ],
};

test('parseAnalysis: scenes, descriptions, extra fields, speech assigned to the scene it starts in, global shot list', () => {
  const p = CU.parseAnalysis(DOC_SAMPLE);
  eq(p.scenes.length, 2);
  eq([p.scenes[0].start, p.scenes[0].end], [0.733, 15.467]);
  ok(/Flight Simulator logo/.test(p.scenes[0].description));
  eq(p.scenes[0].fields, { Tags: ['interview', 'logo'] });
  eq(p.scenes[0].speech.length, 2, 'both phrases start in scene 1 (the second one ends after it)');
  eq(p.scenes[0].speech[1].speaker, 'Speaker 2');
  eq(p.scenes[1].speech.length, 0);
  eq(p.shots, [1.467, 3.233, 16]);
  eq([p.width, p.height], [1080, 608]);
});

test('parseAnalysis: without transcriptPhrases the WEBVTT block of the markdown is used; garbage input gives no scenes', () => {
  const noDetails = JSON.parse(JSON.stringify(DOC_SAMPLE));
  delete noDetails.contents[0].transcriptPhrases;
  const p = CU.parseAnalysis(noDetails);
  eq(p.scenes[0].speech.length, 1);
  eq(p.scenes[0].speech[0].speaker, 'Speaker 1');
  eq([p.scenes[0].speech[0].start, p.scenes[0].speech[0].end], [1.36, 6.64]);
  for (const bad of [null, undefined, {}, { contents: 'x' }, { contents: [null, 5, { kind: 'audioVisual', startTimeMs: 5, endTimeMs: 2 }] }]) eq(CU.parseAnalysis(bad).scenes.length, 0, JSON.stringify(bad));
});

test('parseAnalysis: a custom analyzer without Summary: the first long text field is the description; fields of all types are flattened', () => {
  const r = { contents: [{ kind: 'audioVisual', startTimeMs: 0, endTimeMs: 5000, fields: { Scene: { type: 'string', valueString: 'A long description of the scene that is shown here.' }, Count: { type: 'integer', valueInteger: 3 }, Dogs: { type: 'boolean', valueBoolean: true }, Obj: { type: 'object', valueObject: { a: { type: 'string', valueString: 'x' } } } } }] };
  const s = CU.parseAnalysis(r).scenes[0];
  eq(s.description, 'A long description of the scene that is shown here.');
  eq(s.fields, { Count: 3, Dogs: true, Obj: { a: 'x' } });
});

test('parseAnalysis copes with the result of the mock (makeResult)', () => {
  const p = CU.parseAnalysis(makeResult(95));
  eq(p.scenes.length, 10);
  ok(p.scenes.every((s, i) => i === 0 || s.start >= p.scenes[i - 1].end - 0.002));
  ok(Math.abs(p.scenes[p.scenes.length - 1].end - 95) < 0.01);
});

test('hostile service text cannot stall the classifier (it only looks at the start of the message), real messages are still understood', () => {
  const t0 = Date.now();
  eq(CU.classifyService(0, 'X', 'model ' + 'no '.repeat(40000)), 'CU_FAILED');
  ok(Date.now() - t0 < 500, 'the classifier took ' + (Date.now() - t0) + ' ms');
  eq(CU.classifyService(400, 'ModelError', 'No default model deployment is configured. ' + 'x'.repeat(100000)), 'CU_NO_DEFAULTS');
});

test('parseAnalysis caps the camera-shot list (a hostile result cannot make the later mapping slow)', () => {
  const shots = Array.from({ length: 300000 }, (_, i) => i * 10);
  const p = CU.parseAnalysis({ contents: [{ kind: 'audioVisual', startTimeMs: 0, endTimeMs: 1000, cameraShotTimesMs: shots }, { kind: 'audioVisual', startTimeMs: 1000, endTimeMs: 2000, cameraShotTimesMs: shots }] });
  ok(p.shots.length > 0 && p.shots.length <= 20000, 'shots kept: ' + p.shots.length);
  eq(p.scenes.length, 2);
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); passed++; console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
  }
  console.log('\ncu-client: ' + passed + '/' + queue.length + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
