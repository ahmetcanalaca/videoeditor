'use strict';
// Tests of the assistant loop when the model can LOOK at the video (find_in_video): the tool and its prompt only exist with perception, results are
// kept as found="f1" and used by the edit tools, the UI gets "found" events, cancelling and errors are handled.
const M = require('../src/shared/model');
const { runAgent, buildSystemPrompt } = require('../src/main/ai/agent');
const ops = require('../src/shared/agent-ops');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ±' + tol + ', got ' + a); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const media = { mA: { id: 'mA', name: 'street.mp4', duration: 120, fps: 30, hasAudio: true, displayWidth: 1920, displayHeight: 1080 } };
const seg = (over) => M.createSegment(media.mA, over);
const snapshot = () => ({ segments: [seg({ id: 'a', in: 0, out: 100 })], media, exportSettings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' }, playhead: 0, selectedId: null });
const outDur = (s) => (s.out - s.in) / s.speed;

function scripted(steps) {
  const calls = [];
  return {
    kind: 'local', model: 'mock', calls,
    async chat(req) {
      calls.push(JSON.parse(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools })));
      const step = steps[calls.length - 1];
      if (!step) throw new Error('script exhausted');
      return typeof step === 'function' ? step(req, calls.length) : step;
    },
  };
}
const say = (text) => ({ text, toolCalls: [], raw: { text }, usage: { input: 10, output: 5 }, stopReason: 'end' });
const call = (name, args, id) => ({ id: id || 'call_' + name, name, args });
const use = (calls, text) => ({ text: text || '', toolCalls: calls, raw: { calls }, usage: { input: 20, output: 8 }, stopReason: 'tool_calls' });
const run = (provider, prompt, extra) => runAgent(Object.assign({ provider, prompt, snapshot: snapshot(), lang: 'tr' }, extra || {}));

const dogs = { ok: true, phrase: 'dog', object: 'dog', position: '', intervals: [{ start: 10, end: 20, box: { x1: 0.1, y1: 0.4, x2: 0.3, y2: 0.6 } }, { start: 60, end: 65, box: { x1: 0.5, y1: 0.3, x2: 0.7, y2: 0.7 } }], frames: 50, step: 2, seconds: 12.3 };
function fakePerception(result) {
  const asked = [];
  return { asked, find: async (args) => { asked.push(args); return typeof result === 'function' ? result(args) : result; } };
}

test('without perception: no find_in_video tool, the old "cannot see" rule stays, a call to it is refused politely', async () => {
  const p = scripted([use([call('find_in_video', { object: 'dog' })]), say('Videoyu göremiyorum.')]);
  const r = await run(p, 'köpeği yakınlaştır');
  eq(r.ok, true);
  ok(!p.calls[0].tools.some((t) => t.name === 'find_in_video'));
  ok(/cannot see/.test(p.calls[0].system) && !/find_in_video/.test(p.calls[0].system));
  const toolMsg = p.calls[1].messages.find((m) => m.role === 'tool');
  ok(/not available/.test(toolMsg.results[0].content) && toolMsg.results[0].isError);
  eq(r.changed, false);
  eq(r.found.length, 0);
});

test('with perception: the tool and the "look first" rules reach the model, in the lean and in the full prompt', async () => {
  const perception = fakePerception(dogs);
  const p = scripted([say('ok')]);
  await run(p, 'köpeği yakınlaştır', { perception });
  const req = p.calls[0];
  ok(req.tools.some((t) => t.name === 'find_in_video'));
  ok(req.tools.find((t) => t.name === 'set_zoom').parameters.properties.found, 'found is offered');
  ok(/find_in_video\(object=/.test(req.system) && /Köpeği yakınlaştır/.test(req.system), 'lean prompt');
  ok(!/cannot see or hear/.test(req.system), 'the old rule is gone');
  ok(/cannot hear the video/.test(req.system));
  const full = buildSystemPrompt('en', { compact: false, perception: true });
  ok(/LOOKING AT THE VIDEO/.test(full) && /cannot hear the video/.test(full) && !/cannot see or hear the video/.test(full));
  const plain = buildSystemPrompt('en', { compact: false });
  ok(!/find_in_video/.test(plain) && /cannot see or hear the video/.test(plain), 'prompt without perception is unchanged');
  const lean = buildSystemPrompt('en', { compact: true });
  ok(!/find_in_video/.test(lean));
  ok(/set_fade/.test(lean), 'fade synonyms are in the lean prompt');
});

test('find then edit in two turns: the result carries an id and the parts, the edit uses found="f1"', async () => {
  const perception = fakePerception(dogs);
  const steps = [];
  const p = scripted([
    use([call('find_in_video', { object: 'dog' })]),
    use([call('set_zoom', { found: 'f1', mode: 'in' })]),
    say('Köpek göründüğü iki bölümü yakınlaştırdım.'),
  ]);
  const r = await run(p, 'Köpeği yakınlaştır', { perception, onStep: (s) => steps.push(s) });
  eq(r.ok, true, JSON.stringify(r));
  eq(perception.asked.length, 1);
  eq(perception.asked[0].object, 'dog');
  const findResult = JSON.parse(p.calls[1].messages.find((m) => m.role === 'tool').results[0].content);
  eq(findResult.ok, true); eq(findResult.found_id, 'f1'); eq(findResult.count, 2);
  near(findResult.parts[0].start, 10, 1e-9); near(findResult.parts[1].end, 65, 1e-9);
  ok(/found="f1"/.test(findResult.note));
  ok(r.segments.filter((s) => s.zoomTo > 1 || s.zoomFrom > 1).length >= 4, 'both parts are zoomed');
  const zooms = r.actions.filter((a) => a.op === 'zoom');
  eq(zooms.length, 2);
  near(zooms[0].focus[0], 0.2, 0.01); near(zooms[1].focus[0], 0.6, 0.01);
  near(r.totalSeconds, 100, 1e-6);
  eq(r.found.length, 1);
  eq(r.found[0].id, 'f1'); eq(r.found[0].label, 'dog'); eq(r.found[0].intervals.length, 2); eq(r.found[0].frames, 50);
  const ev = steps.filter((s) => s.kind === 'found');
  eq(ev.length, 1); eq(ev[0].count, 2); eq(ev[0].id, 'f1');
  ok(steps.some((s) => s.kind === 'action'), 'the edit is announced too');
});

test('find and edit in ONE turn works (the id is predictable: f1, f2, ...)', async () => {
  const perception = fakePerception(dogs);
  const p = scripted([use([call('find_in_video', { object: 'dog' }, 'a'), call('remove_range', { found: 'f1' }, 'b')]), say('Köpekli kısımları kestim.')]);
  const r = await run(p, 'köpekli kısımları kes', { perception });
  eq(r.ok, true);
  near(r.totalSeconds, 85, 1e-6);
  eq(r.iterations, 2);
});

test('keep_range with found keeps only the found parts; two different things get f1 and f2', async () => {
  let n = 0;
  const perception = fakePerception((args) => (++n === 1 ? dogs : Object.assign({}, dogs, { phrase: args.object, intervals: [{ start: 30, end: 40 }] })));
  const p = scripted([use([call('find_in_video', { object: 'dog' }), call('find_in_video', { object: 'cat' })]), use([call('keep_range', { found: 'f2' })]), say('ok')]);
  const r = await run(p, 'sadece kedili kısım kalsın', { perception });
  eq(r.ok, true);
  near(r.totalSeconds, 10, 1e-6);
  eq(r.found.map((f) => f.id).join(','), 'f1,f2');
});

test('nothing found: the model is told, an edit with that id is refused, the timeline stays as it was', async () => {
  const perception = fakePerception({ ok: true, phrase: 'unicorn', position: '', intervals: [], frames: 40, step: 2, seconds: 8 });
  const p = scripted([use([call('find_in_video', { object: 'unicorn' })]), use([call('remove_range', { found: 'f1' })]), say('Videoda tek boynuzlu at bulamadım.')]);
  const r = await run(p, 'tek boynuzlu atı kes', { perception });
  eq(r.ok, true);
  eq(r.changed, false);
  const first = JSON.parse(p.calls[1].messages.find((m) => m.role === 'tool').results[0].content);
  eq(first.count, 0); ok(/Nothing was found/.test(first.note));
  const second = p.calls[2].messages.filter((m) => m.role === 'tool')[1].results[0];
  ok(second.isError && /Nothing was found/.test(second.content));
  eq(r.found[0].intervals.length, 0);
});

test('a failed look becomes an error result for the model, not a crash', async () => {
  const perception = fakePerception({ ok: false, error: 'Looking at the video failed (FRAMES_FAILED). Tell the user that the video could not be examined.' });
  const p = scripted([use([call('find_in_video', { object: 'dog' })]), say('Videoyu inceleyemedim.')]);
  const r = await run(p, 'köpeği kes', { perception });
  eq(r.ok, true);
  eq(r.changed, false);
  const res = p.calls[1].messages.find((m) => m.role === 'tool').results[0];
  ok(res.isError && /FRAMES_FAILED/.test(res.content));
  eq(r.found.length, 0);
});

test('cancelling while the video is being examined ends the request with ABORTED', async () => {
  const perception = { find: async () => { const e = new Error('Cancelled'); e.code = 'ABORTED'; throw e; } };
  const p = scripted([use([call('find_in_video', { object: 'dog' })]), say('x')]);
  const r = await run(p, 'köpeği kes', { perception });
  eq(r.ok, false);
  eq(r.error.code, 'ABORTED');
});

test('invalid arguments of find_in_video never reach the scan', async () => {
  const perception = fakePerception(dogs);
  const p = scripted([use([{ id: 'x', name: 'find_in_video', args: null, argsError: 'Unexpected token' }]), say('ok')]);
  const r = await run(p, 'köpeği kes', { perception });
  eq(r.ok, true);
  eq(perception.asked.length, 0);
  ok(/not valid JSON/.test(p.calls[1].messages.find((m) => m.role === 'tool').results[0].content));
});

test('the edit engine knows the tool name the agent loop dispatches on', () => {
  eq(ops.FIND_TOOL_NAME, 'find_in_video');
  eq(ops.getToolDefs({ perception: true }).filter((d) => d.name === ops.FIND_TOOL_NAME).length, 1);
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('PASS  ' + t.name); passed++; } catch (e) { console.log('FAIL  ' + t.name + '\n      ' + String(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')); failed++; }
  }
  console.log('\n==== ai-find: ' + passed + '/' + (passed + failed) + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
void outDur;
