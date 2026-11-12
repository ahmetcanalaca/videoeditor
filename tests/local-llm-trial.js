'use strict';
// MANUAL trial of the AI assistant against a REAL local model (not part of `npm test`: it needs a model server running).
// It drives the same code the app uses - the "local" provider adapter, the agent loop and the edit engine - with natural-language
// commands in Turkish and English and checks the resulting timeline.
//
//   Start a server that speaks the OpenAI protocol and supports tool calling, for example
//     llama-server -m qwen2.5-3b-instruct-q4_k_m.gguf --jinja -c 8192 --port 18080     (llama.cpp; portable, no installation)
//     ollama run qwen2.5:3b   (then use http://127.0.0.1:11434/v1)
//     LM Studio / Foundry Local: start the local server and note its address
//   Foundry Local (the address is in %USERPROFILE%\.foundry\daemon.json, the model must be loaded: foundry model load qwen3.5-4b):
//     set VE_LOCAL_URL=http://127.0.0.1:<port>/v1
//     set VE_LOCAL_MODEL=qwen3.5-4b-generic-gpu:4      (the full id with the version, as foundry cache list -o json shows it)
//     set VE_LOCAL_FLAVOR=foundry                       (thinking off; the tools go in the prompt when the server refuses them)
//   Then:
//     set VE_LOCAL_URL=http://127.0.0.1:18080/v1
//     set VE_LOCAL_MODEL=qwen2.5-3b            (llama.cpp ignores the name; Ollama / LM Studio need the real one)
//     node tests\local-llm-trial.js            (optional: set VE_LOCAL_ONLY=1,3,5 to run a subset)
const M = require('../src/shared/model');
const { createProvider } = require('../src/main/ai/providers');
const { runAgent } = require('../src/main/ai/agent');

const URL_BASE = process.env.VE_LOCAL_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.VE_LOCAL_MODEL || 'qwen2.5:3b';
const ONLY = (process.env.VE_LOCAL_ONLY || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

const media = { mA: { id: 'mA', name: 'interview.mp4', duration: 100, fps: 30, hasAudio: true, displayWidth: 1920, displayHeight: 1080 } };
const snapshot = () => ({
  segments: [M.createSegment(media.mA, { id: 'a', in: 0, out: 100 })],
  media,
  exportSettings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' },
  playhead: 0,
  selectedId: null,
});

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const total = (segs) => segs.reduce((t, s) => t + (s.out - s.in) / s.speed, 0);
const find = (segs, a, b, tol) => segs.find((s) => near(s.in, a, tol || 0.6) && near(s.out, b, tol || 0.6));
const fmt = (segs) => segs.map((s) => `[${s.in.toFixed(1)}–${s.out.toFixed(1)}${s.speed !== 1 ? ' ×' + s.speed : ''}${s.zoomFrom !== 1 || s.zoomTo !== 1 ? ' zoom ' + s.zoomFrom + '→' + s.zoomTo : ''}]`).join(' ');

const CASES = [
  { id: 1, lang: 'tr', prompt: 'İlk 10 saniyeyi kes', check: (r) => r.changed && near(total(r.segments), 90, 0.6) && near(r.segments[0].in, 10, 0.6) },
  { id: 2, lang: 'tr', prompt: '0:20 ile 0:30 arasını 2 kat hızlandır', check: (r) => { const s = find(r.segments, 20, 30); return !!s && near(s.speed, 2, 0.01); } },
  { id: 3, lang: 'tr', prompt: '30. saniyeden 40. saniyeye kadar yakınlaştır', check: (r) => { const s = find(r.segments, 30, 40); return !!s && s.zoomTo > s.zoomFrom; } },
  { id: 4, lang: 'tr', prompt: 'Son 5 saniyeyi yavaşlat', check: (r) => { const s = find(r.segments, 95, 100); return !!s && s.speed < 1; } },
  { id: 5, lang: 'tr', prompt: 'İlk 5 saniyeyi kes, 20-30 arasını 2x hızlandır ve 40-45 arasında yakınlaştır', check: (r) => { const a = find(r.segments, 20, 30); const b = find(r.segments, 40, 45); return near(r.segments[0].in, 5, 0.6) && !!a && near(a.speed, 2, 0.01) && !!b && b.zoomTo > b.zoomFrom; } },
  { id: 6, lang: 'en', prompt: 'Remove the section from 1:00 to 1:10', check: (r) => near(total(r.segments), 90, 0.6) && !!find(r.segments, 0, 60) && !!find(r.segments, 70, 100) },
  { id: 7, lang: 'en', prompt: 'Zoom in from 0:10 to 0:15, then zoom out from 0:15 to 0:20', check: (r) => { const a = find(r.segments, 10, 15); const b = find(r.segments, 15, 20); return !!a && a.zoomTo > a.zoomFrom && !!b && b.zoomTo < b.zoomFrom; } },
  { id: 8, lang: 'tr', prompt: 'Bu video kaç saniye?', check: (r) => !r.changed && /100|1:40|1 dakika 40/.test(r.message) },
  { id: 9, lang: 'tr', prompt: 'Arabayı yakınlaştır', info: true, check: (r) => !r.changed },
];

(async () => {
  console.log(`Local model trial  url=${URL_BASE}  model=${MODEL}  prompt=${process.env.VE_LOCAL_COMPACT === '0' ? 'full (cloud prompt)' : 'compact (local prompt)'}\n`);
  const real = createProvider({ kind: 'local', baseUrl: URL_BASE, model: MODEL, apiKey: '', fetch: globalThis.fetch, timeoutMs: 300000, flavor: process.env.VE_LOCAL_FLAVOR || undefined, promptedTools: process.env.VE_LOCAL_PROMPTED || undefined });
  // VE_LOCAL_DEBUG=1 prints what the model asked for
  const provider = process.env.VE_LOCAL_DEBUG === '1'
    ? { kind: real.kind, async chat(req) { const r = await real.chat(req); console.log('   model ->', JSON.stringify(r.toolCalls.map((c) => ({ name: c.name, args: c.args }))), r.text ? 'text: ' + JSON.stringify(r.text.slice(0, 160)) : ''); return r; } }
    : real;
  const rows = [];
  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    const t0 = Date.now();
    let r;
    try { r = await runAgent({ provider, prompt: c.prompt, snapshot: snapshot(), lang: c.lang, compact: process.env.VE_LOCAL_COMPACT === '0' ? false : undefined }); } catch (e) { r = { ok: false, error: { code: 'THROWN', message: String(e && e.message) } }; }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let pass = false;
    try { pass = !!(r.ok && c.check(r)); } catch (e) { pass = false; }
    rows.push({ id: c.id, pass, info: !!c.info, secs });
    console.log(`#${c.id} [${c.lang}] "${c.prompt}"`);
    if (!r.ok) console.log(`   ERROR ${r.error.code}: ${r.error.message || ''} ${r.error.detail || ''}`);
    else {
      console.log(`   ${secs}s  steps=${r.iterations} toolCalls=${r.toolCalls} tokens=${r.usage.input}+${r.usage.output}  total=${total(r.segments).toFixed(1)}s`);
      console.log(`   timeline: ${fmt(r.segments)}`);
      console.log(`   actions : ${(r.actions || []).map((a) => a.op).join(', ') || '-'}`);
      console.log(`   reply   : ${String(r.message).replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    console.log(`   => ${c.info ? 'INFO ' : ''}${pass ? 'PASS' : 'FAIL'}\n`);
  }
  const scored = rows.filter((x) => !x.info);
  const ok = scored.filter((x) => x.pass).length;
  console.log(`==== local-llm-trial: ${ok}/${scored.length} commands produced the expected timeline (${rows.length - scored.length} informational) ====`);
  process.exit(0);
})().catch((e) => { console.error('TRIAL FAILED', e); process.exit(1); });
