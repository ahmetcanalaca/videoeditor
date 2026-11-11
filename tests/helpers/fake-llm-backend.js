'use strict';
// In-process stand-in for llama-server, used by the UI tests (VE_TEST_LLM_BACKEND=<this file>, VE_TEST_LLM_FAKE_CFG=<json>).
// It runs inside the app's main process, speaks the part of the llama-server protocol the app uses and "sees" test videos in a very simple way:
// a picture contains the thing when it contains RED pixels; the box is the bounding box of those pixels. The "assistant" is scripted from the
// words of the request (köpek / unicorn, kes / yakınlaştır / hızlandır / sadece, soldaki / sağdaki). Every request is logged for the test.
//
// cfg: { ffmpeg, log, visionDelayMs, failVk, failAll, loadMs }
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const cfg = () => { try { return JSON.parse(fs.readFileSync(process.env.VE_TEST_LLM_FAKE_CFG, 'utf8')); } catch (e) { return {}; } };
const logLine = (c, obj) => { if (c.log) { try { fs.appendFileSync(c.log, JSON.stringify(obj) + '\n'); } catch (e) { /* ignore */ } } };

// 32 x 18 RGB pixels of a JPEG (decoded with the app's own FFmpeg)
function pixels(c, jpeg) {
  const r = spawnSync(c.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vf', 'scale=32:18:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: jpeg, maxBuffer: 1 << 20 });
  return r.status === 0 && r.stdout.length >= 32 * 18 * 3 ? r.stdout : null;
}

function redBox(c, jpeg) {
  const px = pixels(c, jpeg);
  if (!px) return null;
  let x1 = 99; let y1 = 99; let x2 = -1; let y2 = -1;
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 3;
      if (px[i] > 170 && px[i + 1] < 90 && px[i + 2] < 90) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    }
  }
  return x2 < 0 ? null : [Math.round((x1 / 32) * 1000), Math.round((y1 / 18) * 1000), Math.round(((x2 + 1) / 32) * 1000), Math.round(((y2 + 1) / 18) * 1000)];
}

const reply = (text) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 40, completion_tokens: 4 } });
const toolCalls = (list) => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: list.map((c, i) => ({ id: 'call_' + i + '_' + c[0], type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } }], usage: { prompt_tokens: 120, completion_tokens: 20 } });

// a vision question (the message has a picture)
function vision(c, body) {
  const content = body.messages[0].content;
  const img = content.find((p) => p.type === 'image_url');
  const text = content.find((p) => p.type === 'text').text;
  const jpeg = Buffer.from(img.image_url.url.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  const ground = /Locate the/.test(text);
  const phrase = (ground ? /Locate the (.+?)(?: in this image| on the | in the )/ : /Is there an? (.+?)(?: on the | in the | in this image)/).exec(text);
  const what = phrase ? phrase[1] : '';
  const box = /dog|red/.test(what) ? redBox(c, jpeg) : null;
  logLine(c, { kind: ground ? 'ground' : 'probe', phrase: what, found: !!box, bytes: jpeg.length, maxTokens: body.max_tokens });
  if (ground) return reply(box ? JSON.stringify([{ bbox_2d: box, label: what }]) : '[]');
  return reply(box ? 'YES' : 'NO');
}

// the assistant: find_in_video first, then the edit the words ask for, then a short answer
function agent(c, body) {
  const lastUser = body.messages.map((m) => m.role).lastIndexOf('user');
  const user = body.messages[lastUser];
  const after = body.messages.slice(lastUser + 1);
  const prompt = ((/User request:\n([\s\S]*)$/.exec(String(user.content)) || [])[1] || '').toLowerCase();
  const rounds = after.filter((m) => m.role === 'assistant').length;
  const results = after.filter((m) => m.role === 'tool').map((m) => { try { return JSON.parse(m.content); } catch (e) { return {}; } });
  const found = results.find((r) => r && r.found_id !== undefined) || null;
  const object = /unicorn|tek boynuzlu/.test(prompt) ? 'unicorn' : 'dog';
  const position = /soldaki|left/.test(prompt) ? 'left' : (/sağdaki|right/.test(prompt) ? 'right' : undefined);
  logLine(c, { kind: 'agent', rounds, tools: (body.tools || []).map((t) => t.function.name).includes('find_in_video'), prompt: prompt.slice(0, 80) });
  if (/^merhaba|^hello|sadece soru/.test(prompt)) return reply('Merhaba! Ne yapmamı istersiniz?');
  if (rounds === 0 && /köpe|dog|unicorn|tek boynuzlu/.test(prompt)) return toolCalls([['find_in_video', Object.assign({ object }, position ? { position } : {})]]);
  if (rounds === 1 && found && found.found_id) {
    if (!found.count) return reply('Videoda ' + object + ' bulamadım; bir değişiklik yapmadım.');
    if (/kes|sil|çıkar|cut|remove/.test(prompt)) return toolCalls([['remove_range', { found: found.found_id }]]);
    if (/sadece|only|kalsın/.test(prompt)) return toolCalls([['keep_range', { found: found.found_id }]]);
    if (/hızlandır|speed/.test(prompt)) return toolCalls([['set_speed', { found: found.found_id, speed: 2 }]]);
    return toolCalls([['set_zoom', { found: found.found_id, mode: 'in' }]]);
  }
  if (rounds >= 1) return reply('Tamam: ' + (found && found.count ? found.count + ' bölümde değişiklik yaptım.' : 'işlem tamamlandı.') + ' Ctrl+Z ile geri alabilirsiniz.');
  return reply('Anlayamadım.');
}

function start(o) {
  const c = cfg();
  if (c.failAll || (c.failVk && o.backend === 'vk')) return Promise.reject(Object.assign(new Error('fake backend refuses to start'), { code: 'FAKE_FAIL' }));
  logLine(c, { kind: 'start', backend: o.backend });
  const loadedAt = Date.now() + (c.loadMs || 0);
  const server = http.createServer((req, res) => {
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/health') return send(Date.now() >= loadedAt ? 200 : 503, { status: 'ok' });
    if (req.headers.authorization !== 'Bearer ' + o.key) { logLine(c, { kind: 'denied', url: req.url }); return send(401, { error: { message: 'Invalid API Key' } }); }
    if (req.url === '/v1/models') return send(200, { data: [{ id: 'fake-llama' }] });
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { error: { message: 'bad json' } }); }
        const cur = cfg();
        const isVision = Array.isArray(body.messages[0] && body.messages[0].content);
        const out = () => {
          try {
            if (isVision) return send(200, vision(cur, body));
            if (Array.isArray(body.tools) && body.tools.length) return send(200, agent(cur, body));
            logLine(cur, { kind: 'ping' });
            return send(200, reply('OK'));
          } catch (e) { return send(500, { error: { message: String(e && e.message) } }); }
        };
        if (isVision && cur.visionDelayMs) setTimeout(out, cur.visionDelayMs); else out();
      });
      return undefined;
    }
    return send(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => resolve({ close: () => new Promise((done) => { server.close(() => done()); if (server.closeAllConnections) server.closeAllConnections(); }) }));
  });
}

module.exports = { start };
