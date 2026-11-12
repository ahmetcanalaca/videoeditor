'use strict';
/*
 * Tool calling by prompt, for a model whose SERVER cannot do it itself.
 *
 * Foundry Local 0.14 answers HTTP 500 ("structured tool calling requires model-published opening and closing tool markers") to every request with `tools` for its
 * Qwen3.5 models, although the models are listed as tool-capable, and Ollama answers HTTP 400 for models without a tool template. Instead of giving up, the provider
 * adapter (providers.js, kind "local") then describes the tools in the system prompt, asks the model to reply with ONE JSON object, and reads the reply back into the
 * ordinary ChatResult shape. The agent loop does not notice: it still sees toolCalls and sends tool results.
 *
 * Everything the model writes is untrusted text: the reply is cut to a fixed size, only JSON that parses is used, the number of calls is limited, and every call
 * still goes through the same validation as a native call (agent-ops.js decides what a tool may do).
 */

const MAX_REPLY_CHARS = 60000;
const MAX_CANDIDATES = 24;
const MAX_CALLS = 16;
const MAX_RESULT_CHARS = 4000;
const MAX_NAME = 64;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/* ------------------------------------------------------------------ the prompt */

function typeText(schema, depth) {
  if (!isObj(schema)) return 'any';
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.slice(0, 12).map((v) => JSON.stringify(v)).join('|');
  switch (schema.type) {
    case 'number':
    case 'integer': {
      const lo = schema.minimum;
      const hi = schema.maximum;
      return 'number' + (typeof lo === 'number' || typeof hi === 'number' ? ' (' + (typeof lo === 'number' ? lo : '') + '..' + (typeof hi === 'number' ? hi : '') + ')' : '');
    }
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'array': return '[' + typeText(schema.items, depth + 1) + ', …]';
    case 'object': return objectText(schema, depth + 1);
    default: return 'any';
  }
}

function objectText(schema, depth) {
  if (depth > 3 || !isObj(schema.properties)) return '{…}';
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return '{' + Object.keys(schema.properties).slice(0, 24).map((k) => k + (required.has(k) ? '' : '?') + ': ' + typeText(schema.properties[k], depth)).join(', ') + '}';
}

const oneLine = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

// "- set_zoom {start?: number, mode: "in"|"out"|"hold", …} - what it does (key: what the argument means; …)". An argument that means the same in several tools (start, end,
// found, …) is explained once under COMMON ARGUMENTS: the prompt is processed again for every step, and on a laptop's GPU every 100 tokens count.
function describeTools(tools) {
  const list = (Array.isArray(tools) ? tools : []).filter((t) => t && typeof t.name === 'string' && NAME_RE.test(t.name));
  const docsOf = (t) => {
    const props = t.parameters && isObj(t.parameters.properties) ? t.parameters.properties : {};
    const out = [];
    for (const k of Object.keys(props).slice(0, 24)) { const d = props[k] && props[k].description; if (d) out.push([k, oneLine(d, 90)]); }
    return out;
  };
  const seen = new Map();
  for (const t of list) for (const [k, d] of docsOf(t)) { const key = k + '\u0000' + d; seen.set(key, (seen.get(key) || 0) + 1); }
  const common = new Map();
  for (const [key, n] of seen) if (n >= 3) { const [k, d] = key.split('\u0000'); if (!common.has(k)) common.set(k, d); }
  const lines = [];
  for (const t of list) {
    const params = isObj(t.parameters) ? t.parameters : { type: 'object', properties: {} };
    const docs = docsOf(t).filter(([k, d]) => common.get(k) !== d).map(([k, d]) => k + ': ' + d);
    lines.push('- ' + t.name + ' ' + objectText(params, 0) + ' - ' + oneLine(t.description, 260) + (docs.length ? ' (' + docs.join('; ') + ')' : ''));
  }
  if (common.size) lines.push('COMMON ARGUMENTS (the same in every tool that has them): ' + Array.from(common, ([k, d]) => k + ': ' + d).join('; '));
  return lines.join('\n');
}

const PROTOCOL = [
  'HOW TO CALL TOOLS: to call tools, reply with ONLY one JSON object, no other text and no markdown, in exactly this form:',
  '{"tool_calls":[{"name":"TOOL_NAME","arguments":{"argument":"value"}}]}',
  'Use only the tool names and argument names listed below, with the listed types, and write only the arguments the request needs (leave the others out). Put several calls in the list to run them one after the other.',
  'The results come back in the next message ("TOOL RESULTS"); then call more tools, or answer. When you need no tool, or when everything is done, reply in plain words (no JSON).',
].join('\n');

function systemWithTools(system, tools) {
  const list = describeTools(tools);
  if (!list) return String(system || '');
  return String(system || '') + '\n\n' + PROTOCOL + '\n\nTOOLS:\n' + list;
}

/* ------------------------------------------------------------------ the conversation */

function resultValue(content) {
  const s = String(content == null ? '' : content);
  try { return JSON.parse(s); } catch (e) { return s.slice(0, MAX_RESULT_CHARS); }
}

function callText(calls) {
  return JSON.stringify({ tool_calls: calls.map((c) => ({ name: c.name, arguments: isObj(c.args) ? c.args : {} })) });
}

// ChatMsg[] (providers.js) without the tool role: what the model "said" with tools becomes the JSON it was asked to write, the results become a user message.
function toPromptedMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls.filter((c) => c && typeof c.name === 'string') : [];
      out.push({ role: 'assistant', content: calls.length ? callText(calls) : String(m.content == null ? '' : m.content) });
    } else if (m.role === 'tool') {
      const results = (Array.isArray(m.results) ? m.results : []).map((r) => {
        const entry = { tool: String(r && r.name || ''), result: resultValue(r && r.content) };
        if (r && r.isError) entry.error = true;
        return entry;
      });
      let body = JSON.stringify(results);
      if (body.length > MAX_RESULT_CHARS * 2) body = body.slice(0, MAX_RESULT_CHARS * 2) + '…';
      out.push({ role: 'user', content: 'TOOL RESULTS (in the order of your calls):\n' + body + '\n\nNow call more tools if the request needs them, or answer the user in plain words.' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the reply */

// A model that thinks aloud first ("Thinking Process: …", or <think>…</think>) is read from its answer on.
function stripThinking(text) {
  let s = String(text == null ? '' : text).replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ');
  if (/^\s*Thinking Process:/i.test(s)) {
    const at = s.lastIndexOf('\n\n\n');
    if (at >= 0) s = s.slice(at);
  }
  return s.trim();
}

// The balanced {...} and [...] spans of the text that are valid JSON (the ones that are not are skipped, scanning goes on after them).
function jsonCandidates(s) {
  const out = [];
  let i = 0;
  let tries = 0;
  while (i < s.length && tries < MAX_CANDIDATES) {
    const c = s[i];
    if (c !== '{' && c !== '[') { i++; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { end = j; break; } }
    }
    tries++;
    if (end < 0) { i++; continue; }
    let value;
    try { value = JSON.parse(s.slice(i, end + 1)); } catch (e) { i++; continue; }
    out.push({ value, from: i, to: end + 1 });
    i = end + 1;
  }
  return out;
}

const ARG_KEYS = ['arguments', 'args', 'parameters', 'input'];

function argsOf(holder) {
  const key = ARG_KEYS.find((k) => holder[k] !== undefined);
  const raw = key ? holder[key] : undefined;
  if (raw === undefined || raw === null || raw === '') return { args: {} };
  if (isObj(raw)) return { args: raw };
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (isObj(v)) return { args: v };
    } catch (e) { /* below */ }
  }
  return { args: null, argsError: 'Arguments must be a JSON object' };
}

// One entry of a "tool_calls" list, or a call written on its own, in the shapes small models use: {name, arguments}, {tool, args}, {function: {name, arguments}}.
function callOf(item, names) {
  if (!isObj(item)) return null;
  const holder = isObj(item.function) ? item.function : item;
  const nameOf = (o) => (typeof o.name === 'string' ? o.name : (typeof o.tool === 'string' ? o.tool : (typeof o.tool_name === 'string' ? o.tool_name : '')));
  const name = nameOf(holder) || nameOf(item);
  if (!name || name.length > MAX_NAME || !NAME_RE.test(name)) return null;
  const argHolder = ARG_KEYS.some((k) => holder[k] !== undefined) ? holder : item;
  const hasArgs = ARG_KEYS.some((k) => argHolder[k] !== undefined);
  // {"name": "John"} in a piece of prose is not a call: it needs arguments, or to be a tool that exists
  if (!hasArgs && !names.has(name)) return null;
  const a = argsOf(argHolder);
  return a.argsError ? { name, args: null, argsError: a.argsError } : { name, args: a.args };
}

function callsOf(value, names) {
  const list = [];
  const push = (v) => { const c = callOf(v, names); if (c) list.push(c); };
  if (Array.isArray(value)) value.slice(0, MAX_CALLS).forEach(push);
  else if (isObj(value) && Array.isArray(value.tool_calls)) value.tool_calls.slice(0, MAX_CALLS).forEach(push);
  else if (isObj(value) && Array.isArray(value.calls)) value.calls.slice(0, MAX_CALLS).forEach(push);
  else if (isObj(value)) push(value);
  return list;
}

// Qwen's own format, which the model sometimes writes although it was asked for JSON: <tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>
function xmlCalls(s) {
  const out = [];
  const re = /<function=([A-Za-z0-9_.-]{1,64})>([\s\S]*?)<\/function>/g;
  let m;
  while ((m = re.exec(s)) !== null && out.length < MAX_CALLS) {
    const args = {};
    const pr = /<parameter=([A-Za-z0-9_.-]{1,64})>([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = pr.exec(m[2])) !== null) {
      const raw = p[2].trim();
      let v = raw;
      try { v = JSON.parse(raw); } catch (e) { /* a plain string */ }
      args[p[1]] = v;
    }
    out.push({ call: { name: m[1], args }, from: m.index, to: m.index + m[0].length });
  }
  return out;
}

// parseToolReply(text, tools) -> { text, toolCalls: [{ id, name, args|null, argsError? }] }
function parseToolReply(text, tools) {
  const names = new Set((Array.isArray(tools) ? tools : []).map((t) => t && t.name).filter(Boolean));
  const s = stripThinking(String(text == null ? '' : text).slice(0, MAX_REPLY_CHARS));
  const spans = [];
  const calls = [];
  for (const c of jsonCandidates(s)) {
    const found = callsOf(c.value, names);
    if (found.length) { calls.push(...found); spans.push([c.from, c.to]); }
  }
  for (const x of xmlCalls(s)) { calls.push(x.call); spans.push([x.from, x.to]); }
  let rest = s;
  if (spans.length) {
    spans.sort((a, b) => b[0] - a[0]);
    for (const [from, to] of spans) rest = rest.slice(0, from) + ' ' + rest.slice(to);
  }
  // (the trailing blanks of a line are cut by a linear pass: a regex such as /[ \t]+\n/ is quadratic on a long run of blanks that no newline follows)
  rest = rest.replace(/<\/?tool_call>/gi, ' ').replace(/```[a-z]*\s*```/gi, ' ').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!calls.length) {
    // it was an attempt that did not parse (cut short, a missing bracket): the model is told so by the agent and can write it again
    const attempt = /"tool_calls"\s*:|"name"\s*:\s*"([A-Za-z0-9_.-]{1,64})"\s*,\s*"arguments"/.exec(s);
    if (attempt && /[{[]/.test(s.slice(0, attempt.index + 1))) {
      const named = /"name"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/.exec(s);
      return { text: '', toolCalls: [{ id: 'call_1', name: named ? named[1] : 'unknown', args: null, argsError: 'The reply was not valid JSON' }] };
    }
    return { text: s, toolCalls: [] };
  }
  const toolCalls = calls.slice(0, MAX_CALLS).map((c, i) => Object.assign({ id: 'call_' + (i + 1) }, c));
  return { text: rest, toolCalls };
}

module.exports = { describeTools, systemWithTools, toPromptedMessages, parseToolReply, stripThinking, PROTOCOL, MAX_CALLS };
