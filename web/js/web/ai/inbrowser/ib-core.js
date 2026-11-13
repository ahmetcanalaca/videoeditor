// The pure parts of the in-browser assistant (no DOM, no network, no storage): shared by the two workers, the page and the Node tests.
//   - IbError: the errors of this feature, with a code the settings dialog and the assistant's error card know how to explain
//   - blockVerifier: a stream that hands on bytes only after the SHA-256 of their 16 MiB block is the one the catalogue lists (ib-models.js)
//   - the virtual OpenAI endpoint: which requests are served, and the conversion of a chat request into what the engine runs
//   - the bookkeeping of the prefix cache of the decoder state (which saved state is a prefix of a prompt, which one to drop)

export class IbError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'IbError';
    this.code = code;
    this.detail = detail || '';
  }
}

export const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export function hex(buffer) {
  const b = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let out = '';
  for (let i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return out;
}

/* ------------------------------------------------------------------ the catalogue */

// the browser storage (Cache Storage) the model files live in, named by the address they were downloaded from
export const CACHE_NAME = 've-ib-models-v1';
export const HEADER_BYTES = 'x-ve-bytes';
export const HEADER_SHA = 'x-ve-sha256';

export const findModel = (models, key) => (Array.isArray(models) ? models.find((m) => m && m.key === key) || null : null);
export const totalBytes = (model) => model.files.reduce((s, f) => s + f.bytes, 0);
// the block hashes of a file (a file of one block has no list: its SHA-256 is the hash of its only block)
export const blockHashes = (file) => (Array.isArray(file.chunks) && file.chunks.length ? file.chunks : [file.sha256]);

// https://huggingface.co/<repo>/resolve/<commit>/<path>: exactly the address transformers.js asks for, and the key of the file in the browser's storage
export const fileUrl = (host, model, file) => host + '/' + model.repo + '/resolve/' + model.revision + '/' + file.path;

// Only Hugging Face and its content network (huggingface.co, *.hf.co) may be talked to; the service worker's policy for the download worker says the same.
export function isAllowedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'huggingface.co' || (h.endsWith('.hf.co') && /^[a-z0-9.-]+$/.test(h) && !h.includes('..'));
}

export function allowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && isAllowedHost(u.hostname);
  } catch (e) { return false; }
}

/* ------------------------------------------------------------------ verified bytes */

// A TransformStream that passes bytes on only when the block they belong to has the SHA-256 the catalogue gives for it. The stream fails (IB_CORRUPT) at the first block
// that does not match, when there is more data than the catalogue says, or less. Nothing that has not been checked leaves it.
//   o: { blockSize, hashes: [hex], size, digest(Uint8Array) -> Promise<ArrayBuffer> }
export function blockVerifier(o) {
  const { blockSize, hashes, size, digest } = o;
  let buf = new Uint8Array(Math.min(blockSize, Math.max(size, 1)));
  let fill = 0;
  let index = 0;
  let total = 0;
  async function release(controller, len) {
    if (index >= hashes.length) throw new IbError('IB_CORRUPT', 'More data than the catalogue lists');
    const block = buf.subarray(0, len);
    const got = hex(await digest(block));
    if (got !== hashes[index]) throw new IbError('IB_CORRUPT', 'A block does not match its SHA-256', 'block ' + index);
    controller.enqueue(block);
    buf = new Uint8Array(Math.min(blockSize, Math.max(size - total, 1))); // (the released block belongs to the reader now)
    fill = 0;
    index++;
  }
  return new TransformStream({
    async transform(chunk, controller) {
      let off = 0;
      while (off < chunk.length) {
        if (total >= size) throw new IbError('IB_CORRUPT', 'More bytes than the catalogue lists');
        const n = Math.min(buf.length - fill, chunk.length - off, size - total);
        buf.set(chunk.subarray(off, off + n), fill);
        fill += n;
        off += n;
        total += n;
        if (fill === buf.length) await release(controller, fill);
      }
    },
    async flush(controller) {
      if (fill > 0) await release(controller, fill);
      if (total !== size) throw new IbError('IB_CORRUPT', 'Fewer bytes than the catalogue lists', total + ' of ' + size);
      if (index !== hashes.length) throw new IbError('IB_CORRUPT', 'Fewer blocks than the catalogue lists');
    },
  });
}

/* ------------------------------------------------------------------ the virtual OpenAI endpoint */

export const LIMITS = { messages: 100, textChars: 400000, images: 4, imageBytes: 4 * 1024 * 1024, maxTokens: 2048, bodyBytes: 24 * 1024 * 1024 };
const JPEG_PREFIX = 'data:image/jpeg;base64,';

// only the two requests the adapters of the assistant make
export function routeOf(url, method) {
  let path;
  try { path = new URL(url).pathname; } catch (e) { return ''; }
  if (method === 'POST' && path === '/v1/chat/completions') return 'chat';
  if (method === 'GET' && path === '/v1/models') return 'models';
  return '';
}

function b64decode(b64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new IbError('BAD_REQUEST', 'A picture is not valid base64');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const textOfParts = (parts) => parts.filter((p) => isObj(p) && p.type === 'text' && typeof p.text === 'string').map((p) => defang(p.text)).join('\n');

// What reaches the chat template is text of the person and of the video (file names): the control tokens of the model ("<|im_start|>" opens a turn) must not be writable
// from there, or a file name could make up a turn of its own. A space after the "<" turns them into plain text.
export const defang = (text) => String(text).replace(/<\|/g, '< |');

// body of POST /v1/chat/completions -> { messages (for the chat template), images: [Uint8Array of JPEG], maxNewTokens }. Throws IbError('BAD_REQUEST').
export function toEngineRequest(body, limits) {
  const L = Object.assign({}, LIMITS, limits || {});
  if (!isObj(body) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > L.messages) throw new IbError('BAD_REQUEST', 'The request has no messages or too many');
  // the tools are described in the prompt (promptedTools); a request that carries tool definitions is one this model cannot take as such
  if (Array.isArray(body.tools) && body.tools.length) throw new IbError('BAD_REQUEST', 'This model does not support tool calling (the tools are described in the prompt instead)');
  const messages = [];
  const images = [];
  let chars = 0;
  for (const m of body.messages) {
    if (!isObj(m) || (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant')) throw new IbError('BAD_REQUEST', 'A message has a role this model does not take');
    if (typeof m.content === 'string' || m.content == null) {
      const text = defang(m.content == null ? '' : m.content);
      chars += text.length;
      messages.push({ role: m.role, content: text });
      continue;
    }
    if (!Array.isArray(m.content)) throw new IbError('BAD_REQUEST', 'A message has no usable content');
    if (m.role !== 'user') {
      const text = textOfParts(m.content);
      chars += text.length;
      messages.push({ role: m.role, content: text });
      continue;
    }
    const parts = [];
    for (const p of m.content) {
      if (!isObj(p)) continue;
      if (p.type === 'text' && typeof p.text === 'string') { chars += p.text.length; parts.push({ type: 'text', text: defang(p.text) }); }
      else if (p.type === 'image_url' && isObj(p.image_url) && typeof p.image_url.url === 'string' && p.image_url.url.startsWith(JPEG_PREFIX)) {
        const b64 = p.image_url.url.slice(JPEG_PREFIX.length);
        if (images.length >= L.images || Math.floor((b64.length * 3) / 4) > L.imageBytes) throw new IbError('BAD_REQUEST', 'Too many or too large pictures');
        images.push(b64decode(b64));
        parts.push({ type: 'image' });
      }
    }
    messages.push({ role: 'user', content: parts.some((p) => p.type === 'image') ? parts : textOfParts(parts) });
  }
  if (chars > L.textChars) throw new IbError('BAD_REQUEST', 'The request is too long');
  const asked = Number(body.max_tokens);
  const maxNewTokens = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), L.maxTokens) : 512;
  return { messages, images, maxNewTokens };
}

export function completionBody(o) {
  const promptTokens = o.promptTokens | 0;
  const completionTokens = o.completionTokens | 0;
  return {
    id: 'chatcmpl-ib-' + (o.id || 0),
    object: 'chat.completion',
    model: o.model,
    choices: [{ index: 0, message: { role: 'assistant', content: String(o.text == null ? '' : o.text) }, finish_reason: o.finish === 'length' ? 'length' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

export const modelsBody = (keys) => ({ object: 'list', data: keys.map((id) => ({ id, object: 'model', owned_by: 'in-browser' })) });

/* ------------------------------------------------------------------ the prefix cache of the decoder state */

// The state of the decoder after the first part of a prompt is kept, so that a request whose prompt begins with the same tokens (the system prompt and the tool list
// are the same in every request; an iteration of the assistant continues the one before) only has to read the rest. A snapshot belongs to the exact token ids it
// was made from, so a prompt that differs anywhere inside them can never use it.

// indices of the tokens that open a turn (<|im_start|>)
export function turnStarts(ids, startId) {
  const out = [];
  for (let i = 0; i < ids.length; i++) if (ids[i] === startId) out.push(i);
  return out;
}

// Where to take snapshots: after the first message (the system prompt: the same in every request) and after the last message (what the next iteration continues from).
// `starts` are the turn starts of the full prompt; the last one is the start of the answer the model is asked for.
export function snapshotBounds(starts) {
  const out = [];
  if (starts.length >= 3) out.push(starts[1]);
  if (starts.length >= 2) out.push(starts[starts.length - 1]);
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

export function isPrefix(prefix, ids) {
  if (prefix.length > ids.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== ids[i]) return false;
  return true;
}

// the snapshot with the most tokens whose ids begin the prompt (and leave something to read)
export function longestPrefix(snaps, ids) {
  let best = null;
  for (const s of snaps) if (s.ids.length < ids.length && (!best || s.ids.length > best.ids.length) && isPrefix(s.ids, ids)) best = s;
  return best;
}

// drops the snapshots that were used longest ago until there are at most maxCount of them and maxBytes together; `keep` is never dropped. Mutates the list.
export function evictSnapshots(snaps, o, keep) {
  const sum = () => snaps.reduce((s, x) => s + x.bytes, 0);
  while (snaps.length > 1 && (snaps.length > o.maxCount || sum() > o.maxBytes)) {
    let oldest = -1;
    for (let i = 0; i < snaps.length; i++) if (snaps[i] !== keep && (oldest < 0 || snaps[i].used < snaps[oldest].used)) oldest = i;
    if (oldest < 0) break;
    snaps.splice(oldest, 1);
  }
  return snaps;
}

/* ------------------------------------------------------------------ a worker that must not reach the network */

// The engine worker's policy (sw.js) lets it talk to this site only. That is tested instead of taken for granted, with two requests that the policy has to refuse. The first needs no
// network at all - a `data:` address, which a policy of `connect-src 'self'` refuses and a worker without a policy simply reads - so a computer that is offline, a company network
// that blocks Hugging Face or an ad blocker can never make a worker without a policy look sealed. The second goes to Hugging Face, the one other site the assistant talks to (the
// download worker). A request that WORKS stops the model from being loaded; the first one is made first, so that nothing is sent anywhere when the policy is missing.
export async function assertSealed(fetchFn) {
  const plain = { method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
  const probes = [
    ['data:text/plain;charset=utf-8,sealed', plain],
    ['https://huggingface.co/robots.txt', Object.assign({ mode: 'no-cors' }, plain)],
  ];
  for (const [address, init] of probes) {
    let reached = false;
    try {
      await fetchFn(address, init);
      reached = true;
    } catch (e) { /* refused: sealed */ }
    if (reached) throw new IbError('IB_POLICY', 'The model worker is not sealed off from the network');
  }
}

/* ------------------------------------------------------------------ a model that falls into a loop */

// A small model sometimes writes the same few tokens again and again until the length limit (a minute or more of the graphics card's time for nothing: measured with a
// 0.8B model, which repeated `"occurrence":"",` a thousand tokens long). The last tokens are a loop when they are one pattern of up to 48 tokens written six times in a row
// (one token twelve times in a row is such a pattern as well); the engine then stops writing, and the half-written answer is dealt with like any other reply that is
// not valid JSON.
export function repeatLoop(tokens, minRepeats, maxPeriod) {
  const n = tokens.length;
  const times = minRepeats > 1 ? minRepeats : 6;
  const longest = maxPeriod > 0 ? maxPeriod : 48;
  for (let p = 2; p <= longest; p++) {
    const need = p * times;
    if (n < need) continue;
    let same = true;
    for (let i = n - need + p; i < n; i++) if (tokens[i] !== tokens[i - p]) { same = false; break; }
    if (same) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ a small model that says it did something and did not */

// A small model is least reliable exactly where the assistant needs it: asked to "zoom in on the dog" it calls find_in_video correctly and then, shown what it found,
// answers in words; asked to "cut the first 5 seconds" it writes "I cut it" and calls no tool. Nothing was edited in either case. The answer is therefore not accepted yet:
// one reminder goes with the question once more (it names the request), and when the model still calls no tool its claim is not passed on as if it were true
// (ai-api.js). followThrough(messages, reply, tools) -> { kind: 'found' | 'claim', text } | null:
//   found: the step before was a successful picture search, nothing was edited after it, and the reply has no tool call;
//   claim: the first answer of a request has no tool call and says that something was done ("kestim", "silindi", "I removed ...") - a question is left alone.
const REQUEST_MARK = 'User request:';
const CLAIM_TR = /(?<!\p{L})\p{L}{2,}(?:[dt][ıiuü]m|[aeıioöuü][ln][dt][ıiuü])(?!\p{L})/iu;
const CLAIM_EN = /\b(?:I(?:'ve| have)?\s+(?:just\s+|now\s+|also\s+)?(?:cut|removed|deleted|trimmed|split|sped|speeded|slowed|zoomed|set|applied|changed|muted|faded|reordered|reset|cropped|kept|did|made|done)|(?:was|were|has been|have been|had been)\s+(?:cut|removed|deleted|trimmed|split|sped|slowed|zoomed|set|applied|changed|muted|faded|reordered|reset|cropped|kept|done))\b/i;
const QUESTION = /\?|(?<!\p{L})(?:m[ıiuü]|ne kadar|kaç|nasıl|nerede|nerde|hangi|neden|niçin|what|how|where|which|why|when|who)(?!\p{L})/iu;

function requestOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || m.role !== 'user' || typeof m.content !== 'string') continue;
    const at = m.content.lastIndexOf(REQUEST_MARK);
    return (at >= 0 ? m.content.slice(at + REQUEST_MARK.length) : m.content).replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return '';
}

export function followThrough(messages, reply, tools) {
  if (!Array.isArray(messages) || !messages.length || !isObj(reply)) return null;
  if (Array.isArray(reply.toolCalls) && reply.toolCalls.length) return null;
  const last = messages[messages.length - 1];
  if (!isObj(last)) return null;
  const request = requestOf(messages);
  if (!request) return null;
  if (last.role === 'user') {
    const said = String(reply.text == null ? '' : reply.text);
    if (QUESTION.test(request) || !(CLAIM_TR.test(said) || CLAIM_EN.test(said))) return null;
    const sees = Array.isArray(tools) && tools.some((x) => isObj(x) && x.name === 'find_in_video');
    return {
      kind: 'claim',
      text: 'NOTHING HAS BEEN CHANGED: you called no tool, so the timeline is exactly as it was. The user asked: ' + JSON.stringify(request) + '. Call the tool that does it NOW, replying with ONLY the JSON object '
        + '{"tool_calls":[{"name":"TOOL","arguments":{…}}]}' + (sees ? ' (if it depends on what is IN THE PICTURE - a dog, a car, a person - call find_in_video first)' : '') + '. If this was only a question, answer it in plain words and claim no edit.',
    };
  }
  if (last.role !== 'tool' || !Array.isArray(last.results)) return null;
  let id = '';
  for (const r of last.results) {
    if (!isObj(r) || r.isError) continue;
    if (r.name !== 'find_in_video') return null; // something was edited in the same step
    let v = null;
    try { v = JSON.parse(String(r.content)); } catch (e) { v = null; }
    if (isObj(v) && v.ok !== false && typeof v.found_id === 'string' && /^f\d{1,3}$/.test(v.found_id) && Number(v.count) > 0) id = v.found_id;
  }
  if (!id) return null;
  return {
    kind: 'found',
    text: 'NOTHING HAS BEEN EDITED YET. The user asked: ' + JSON.stringify(request) + '. The search is done (found_id "' + id + '"). If the request asks for an edit, call the tool for it NOW, with found="' + id + '" instead of start/end: '
      + 'set_zoom (mode "in" or "out") to zoom, remove_range to cut it out, keep_range to keep only it, set_speed to change the speed. Reply with ONLY the JSON object {"tool_calls":[{"name":"TOOL","arguments":{"found":"' + id + '", …}}]}. '
      + 'If the request only asked where or when something is, answer in plain words.',
  };
}
