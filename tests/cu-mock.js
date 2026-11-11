'use strict';
// A stand-in for the Azure Content Understanding service (and, optionally, the Foundry chat endpoint) for the tests: it speaks the documented REST
// protocol (analyzeBinary -> 202 + Operation-Location -> polling -> result, DELETE result, GET defaults / analyzer) on a loopback port.
const http = require('http');

const SCENE_TEXTS = [
  'A man walks a golden retriever dog along a busy city street. People pass by and cars wait at a traffic light.',
  'A red car stops in front of a small cafe. A woman in a yellow coat gets out and waves.',
  'Close-up of a laptop screen showing a spreadsheet with charts. Someone is typing.',
  'A group of children plays football in a park on a sunny day. A cat watches from a bench.',
  'The camera pans over a calm lake at sunset with mountains in the background.',
  'An empty office room with a whiteboard. Nobody is visible.',
];

// seconds of video in an MP4 (movie header box), for results that fit the file that was uploaded; 0 if it cannot be read
function mp4Seconds(buf) {
  const i = buf.indexOf(Buffer.from('mvhd'));
  if (i < 0 || i + 28 > buf.length) return 0;
  const version = buf[i + 4];
  if (version === 1) return Number(buf.readBigUInt64BE(i + 24)) / buf.readUInt32BE(i + 16);
  return buf.readUInt32BE(i + 20) / buf.readUInt32BE(i + 16);
}

// An AnalysisResult like the one of prebuilt-videoSearch: one content per scene of about `sceneSeconds`, transcript phrases, shot changes.
function makeResult(seconds, o) {
  const opts = o || {};
  const sceneSeconds = opts.sceneSeconds || 10;
  const texts = opts.texts || SCENE_TEXTS;
  const speech = opts.speech || ['Welcome everybody, this is our show.', 'Thank you all for coming today.', 'Let us look at the numbers.', 'See you next time.'];
  const contents = [];
  const shots = [];
  const n = Math.max(1, Math.round(seconds / sceneSeconds));
  for (let i = 0; i < n; i++) {
    const a = Math.round(i * (seconds / n) * 1000);
    const b = i === n - 1 ? Math.round(seconds * 1000) : Math.round((i + 1) * (seconds / n) * 1000);
    shots.push(a + 1500);
    const phrases = i % 2 === 0 ? [{ speaker: 'Speaker 1', startTimeMs: a + 800, endTimeMs: a + 3800, text: speech[(i / 2) % speech.length], confidence: 0.9, words: [], locale: 'en-US' }] : [];
    contents.push({
      markdown: '# Video: ' + a + ' => ' + b,
      fields: { Summary: { type: 'string', valueString: texts[i % texts.length] } },
      kind: 'audioVisual',
      startTimeMs: a,
      endTimeMs: b,
      width: 480,
      height: 270,
      keyFrameTimesMs: [a],
      transcriptPhrases: phrases,
      cameraShotTimesMs: shots.slice(),
    });
  }
  return { analyzerId: 'prebuilt-videoSearch', apiVersion: '2025-11-01', createdAt: new Date().toISOString(), warnings: [], contents };
}

// opts: { key, bearer, polls, result(info), failPost: {status, code, message}, failOperation: {code, message}, defaults, analyzerStatus, foreignLocation,
//         chat(req, body) -> {status?, json}, onRequest(entry) }
function startMockCu(opts) {
  const o = Object.assign({ polls: 1, defaults: { 'gpt-4.1': 'gpt41', 'text-embedding-3-large': 'embed' }, analyzerStatus: 200 }, opts || {});
  const state = { requests: [], uploads: [], deleted: [], operations: new Map(), seq: 0, options: o };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, size: body.length };
      state.requests.push(entry);
      if (o.onRequest) o.onRequest(entry, body);
      const send = (status, json, headers) => {
        const text = json === undefined ? '' : JSON.stringify(json);
        res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, headers || {}));
        res.end(text);
      };
      const key = req.headers['ocp-apim-subscription-key'];
      const auth = req.headers.authorization;
      const isChat = u.pathname.startsWith('/openai/');
      if (!isChat && u.pathname.startsWith('/contentunderstanding/')) {
        const authorized = (o.key && key === o.key) || (o.bearer && auth === 'Bearer ' + o.bearer);
        if ((o.key || o.bearer) && !authorized) { send(401, { error: { code: 'Unauthorized', message: 'Access denied due to invalid subscription key ' + (key || '') } }); return; }
      }
      if (isChat) {
        if (!o.chat) { send(404, { error: { message: 'no chat' } }); return; }
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch (e) { /* not JSON */ }
        const r = o.chat(entry, json);
        send(r.status || 200, r.json);
        return;
      }
      if (req.method === 'GET' && u.pathname === '/contentunderstanding/defaults') { send(200, { modelDeployments: o.defaults }); return; }
      let m = /^\/contentunderstanding\/analyzers\/([^/:]+)$/.exec(u.pathname);
      if (req.method === 'GET' && m) {
        if (o.analyzerStatus !== 200) { send(o.analyzerStatus, { error: { code: 'NotFound', message: 'analyzer not found' } }); return; }
        send(200, { analyzerId: decodeURIComponent(m[1]), status: 'ready' });
        return;
      }
      m = /^\/contentunderstanding\/analyzers\/([^/:]+):analyzeBinary$/.exec(u.pathname);
      if (req.method === 'POST' && m) {
        if (o.failPost) { send(o.failPost.status, { error: { code: o.failPost.code || 'Error', message: o.failPost.message || 'failed' } }, o.failPost.headers); return; }
        const id = 'op-' + (++state.seq);
        const seconds = mp4Seconds(body);
        state.uploads.push({ analyzer: decodeURIComponent(m[1]), query: entry.query, headers: req.headers, bytes: body, seconds, id });
        state.operations.set(id, { polls: 0, seconds, analyzer: decodeURIComponent(m[1]) });
        const origin = o.foreignLocation ? 'http://127.0.0.2:9' : 'http://127.0.0.1:' + server.address().port;
        send(202, { id, status: 'NotStarted' }, { 'operation-location': origin + '/contentunderstanding/analyzerResults/' + id + '?api-version=' + (entry.query['api-version'] || '') });
        return;
      }
      m = /^\/contentunderstanding\/analyzerResults\/([^/]+)$/.exec(u.pathname);
      if (m && req.method === 'GET') {
        const op = state.operations.get(m[1]);
        if (!op) { send(404, { error: { code: 'NotFound', message: 'unknown operation' } }); return; }
        if (o.pollFailures && (op.failures || 0) < o.pollFailures) { op.failures = (op.failures || 0) + 1; send(503, { error: { code: 'ServiceUnavailable', message: 'try later' } }, { 'retry-after': '0' }); return; }
        op.polls += 1;
        if (op.polls <= o.polls) { send(200, { id: m[1], status: op.polls === 1 ? 'NotStarted' : 'Running' }); return; }
        if (o.failOperation) { send(200, { id: m[1], status: 'Failed', error: { code: o.failOperation.code || 'InvalidRequest', message: o.failOperation.message || 'failed' } }); return; }
        const result = o.result ? o.result({ seconds: op.seconds, analyzer: op.analyzer }) : makeResult(op.seconds || 30);
        send(200, { id: m[1], status: 'Succeeded', result, usage: { videoHours: (op.seconds || 0) / 3600, tokens: { 'gpt-4.1-input': 1000, 'gpt-4.1-output': 100 } } });
        return;
      }
      if (m && req.method === 'DELETE') { state.deleted.push(m[1]); state.operations.delete(m[1]); res.writeHead(204); res.end(); return; }
      send(404, { error: { code: 'NotFound', message: 'no such route ' + u.pathname } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve(Object.assign(state, { server, port, origin: 'http://127.0.0.1:' + port, stop: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) }));
    });
  });
}

module.exports = { startMockCu, makeResult, mp4Seconds, SCENE_TEXTS };
