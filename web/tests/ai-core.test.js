'use strict';
// Unit tests (Node, no browser) of what the web edition takes over from the desktop sources: the generated bundle js/web/ai/desktop-core.js must be
// current, its stand-ins for Node's crypto must agree with Node, and the desktop agent loop / provider adapters / "look at the video" pipeline
// must work through it exactly as they do on the desktop.
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

// importing the generated ES modules (".js" in a package without "type") makes Node print a reparse notice: not interesting here
process.removeAllListeners('warning');

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  passed += ok ? 1 : 0;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok && !process.env.VE_VERBOSE ? '' : '  -> ' + JSON.stringify(detail)));
  if (!ok) failed += 1;
}

const WEB = path.join(__dirname, '..');
const url = (rel) => pathToFileURL(path.join(WEB, rel)).href;

(async () => {
  // 1. the generated files are current
  const sync = spawnSync(process.execPath, [path.join(WEB, 'scripts', 'sync-desktop.js'), '--check'], { encoding: 'utf8' });
  check('desktop sync: the generated bundle and the shared copies are current', sync.status === 0, (sync.stderr || sync.stdout || '').slice(0, 300));

  const core = await import(url('js/web/ai/desktop-core.js'));
  const { shims, sha256Bytes } = await import(url('js/web/ai/node-shims.js'));

  // 2. synchronous SHA-1 / SHA-256 stand-ins agree with Node (padding edge cases included)
  {
    let ok = true;
    let bad = null;
    for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70001]) {
      const data = crypto.randomBytes(len);
      for (const alg of ['sha1', 'sha256']) {
        const mine = shims.crypto.createHash(alg).update(data).digest('hex');
        const real = crypto.createHash(alg).update(data).digest('hex');
        if (mine !== real) { ok = false; bad = { len, alg }; }
      }
    }
    check('crypto stand-in: sha1 and sha256 of 14 message sizes equal Node', ok, bad);
    const parts = shims.crypto.createHash('sha256').update('a|b').update(String(12)).update('ü').digest('hex');
    check('crypto stand-in: several update() calls and non-ASCII text', parts === crypto.createHash('sha256').update('a|b12ü').digest('hex'), parts);
    check('crypto stand-in: randomBytes(8).toString("hex") is 16 hex digits and randomUUID looks like one', /^[0-9a-f]{16}$/.test(shims.crypto.randomBytes(8).toString('hex')) && /^[0-9a-f-]{36}$/.test(shims.crypto.randomUUID()), null);
    check('crypto stand-in: a Uint8Array view is hashed by its own bytes, not its whole buffer', (() => { const big = new Uint8Array([9, 9, 1, 2, 3, 9]); const view = big.subarray(2, 5); return shims.crypto.createHash('sha256').update(view).digest('hex') === crypto.createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'); })(), null);
    check('sha256Bytes returns 32 bytes', sha256Bytes(new Uint8Array(0)).length === 32, null);
  }

  // 3. the desktop's constants and modules are what the bundle exports
  {
    const desk = require(path.join(WEB, '..', 'src', 'main', 'ai', 'agent'));
    check('bundle: agent exports the desktop API', typeof core.agent.runAgent === 'function' && Object.keys(desk).every((k) => k in core.agent), Object.keys(core.agent));
    check('bundle: shared model and agent-ops are loaded once and agent-ops uses that model', typeof core.model.createSegment === 'function' && typeof core.ops.Session === 'function', null);
    const settings = require(path.join(WEB, '..', 'src', 'main', 'settings'));
    const web = (await import(url('js/web/ai/constants.js'))).constants;
    check('constants: providers, Content Understanding locations / analyzer rule equal the desktop settings', JSON.stringify(web.AI_PROVIDERS) === JSON.stringify(settings.AI_PROVIDERS) && JSON.stringify(web.CU_LOCATIONS) === JSON.stringify(settings.CU_LOCATIONS) && web.CU_ANALYZER_RE.source === settings.CU_ANALYZER_RE.source && web.CU_DEFAULT_ANALYZER === settings.CU_DEFAULT_ANALYZER, null);
  }

  // 4. the agent loop of the desktop, through the bundle, with a scripted provider
  const M = core.model;
  const mkSnapshot = (duration) => {
    const media = { mA: { id: 'mA', name: 'recording.mp4', duration, fps: 30, hasAudio: true, displayWidth: 1920, displayHeight: 1080 } };
    return { segments: [M.createSegment(media.mA, { id: 'a', in: 0, out: duration })], media, exportSettings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' }, playhead: 0, selectedId: null };
  };
  {
    let calls = 0;
    const provider = {
      kind: 'local',
      chat: async ({ messages }) => {
        calls += 1;
        return messages.some((m) => m.role === 'tool')
          ? { text: 'Done.', toolCalls: [], usage: { input: 3, output: 2 }, stopReason: 'stop' }
          : { text: '', toolCalls: [{ id: 'c1', name: 'remove_range', args: { first_seconds: 10 } }], usage: { input: 5, output: 5 }, stopReason: 'tool_calls' };
      },
    };
    const steps = [];
    const r = await core.agent.runAgent({ provider, prompt: 'Cut the first 10 seconds', snapshot: mkSnapshot(100), lang: 'en', onStep: (s) => steps.push(s.kind) });
    check('agent loop: a tool call edits the timeline and the reply comes back', r.ok && r.changed && r.message === 'Done.' && r.segments.length === 1 && Math.abs(r.segments[0].in - 10) < 1e-6 && calls === 2, r.ok ? { calls, segs: r.segments.map((s) => [s.in, s.out]) } : r.error);
    check('agent loop: the step events carry the action', steps.includes('action'), steps);
    check('agent loop: usage is summed', r.usage.input === 8 && r.usage.output === 7, r.usage);
  }

  // 5. provider adapters (OpenAI protocol, "local" kind) with a fake fetch
  {
    const sent = [];
    const fakeFetch = async (u, init) => {
      sent.push({ u, init });
      const body = { id: 'x', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'set_speed', arguments: '{"speed":2,"first_seconds":5}' } }] } }], usage: { prompt_tokens: 11, completion_tokens: 4 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const p = core.providers.createProvider({ kind: 'local', baseUrl: 'http://127.0.0.1:8473/v1', model: 'qwen', apiKey: 'TEST_KEY_not_a_real_secret_unit', fetch: fakeFetch });
    const res = await p.chat({ system: 'sys', messages: [{ role: 'user', content: 'faster' }], tools: core.agent.compactTools(core.ops.getToolDefs({})) });
    check('provider (local/OpenAI protocol): the tool call is parsed', res.toolCalls.length === 1 && res.toolCalls[0].name === 'set_speed' && res.toolCalls[0].args.speed === 2 && res.usage.input === 11, res);
    check('provider (local): the key goes in the Authorization header to the configured URL only', sent.length === 1 && sent[0].u === 'http://127.0.0.1:8473/v1/chat/completions' && /Bearer TEST_KEY_not_a_real_secret_unit/.test(JSON.stringify(sent[0].init.headers)), sent[0] && sent[0].u);
    check('endpoint policy: https only, http only for this computer, no credentials', core.net.validateBaseUrl('http://example.com/v1').code === 'URL_SCHEME' && core.net.validateBaseUrl('http://127.0.0.1:8473/v1').ok && core.net.validateBaseUrl('https://u:p@x.com').code === 'URL_CREDENTIALS' && core.net.validateBaseUrl('http://[::1]:1/v1').ok, null);
    const n = core.endpoints.normalizeEndpoint('azure', 'https://res.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21', {});
    check('endpoint clean-up: an Azure "Target URI" gives resource, deployment and API version', n.url === 'https://res.openai.azure.com' && n.model === 'gpt4o' && n.apiVersion === '2024-10-21', n);
  }

  // 6. find_in_video: the desktop pipeline (query clean-up, coarse scan, bisection, boxes) with the web's frame hook and a scripted "model"
  {
    const duration = 60;
    const snap = mkSnapshot(duration);
    const session = new core.ops.Session({ segments: snap.segments, media: snap.media, exportSettings: snap.exportSettings, playhead: 0, selectedId: null, shareNames: true });
    const asked = [];
    // the "picture" is just its time; the dog is there from 10 s to 22 s
    const extract = async ({ file, seconds }) => Buffer.from(file + '@' + seconds.toFixed(2));
    const vlm = {
      probe: async (frame) => { const s = Number(String(frame.jpeg).split('@')[1]); asked.push(s); return s >= 10 && s < 22; },
      ground: async () => [{ x1: 0.1, y1: 0.4, x2: 0.3, y2: 0.6 }],
    };
    const prog = [];
    const perception = core.perception.createPerception({ pieces: session.originalMap(), fileOf: (id) => id, ffmpegPath: 'unused', procs: null, vlm, userText: 'Zoom in on the dog', signal: null, onProgress: (p) => prog.push(p.phase), extract });
    const found = await perception.find({ object: 'dog' });
    const iv = found.ok && found.intervals[0];
    check('find_in_video (desktop pipeline in the page): the interval of the dog is found to within one second', !!iv && found.intervals.length === 1 && Math.abs(iv.start - 10) <= 1 && Math.abs(iv.end - 22) <= 1, found.ok ? found.intervals : found);
    check('find_in_video: the box of the dog is kept as the place to zoom into', !!iv && !!iv.box && Math.abs(iv.box.x1 - 0.1) < 1e-6, iv && iv.box);
    check('find_in_video: progress is reported (scan, refine, ground)', ['scan', 'refine', 'ground'].every((p) => prog.includes(p)), prog.filter((v, i, a) => a.indexOf(v) === i));
    check('find_in_video: the model is asked about a still picture only once', new Set(asked.map((s) => s.toFixed(2))).size === asked.length, asked.length);
  }

  console.log('\nweb ai-core: ' + passed + '/' + (passed + failed) + ' passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
