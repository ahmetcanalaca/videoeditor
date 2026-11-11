'use strict';
// Questions to the vision model of the built-in assistant: "is it in this picture?" and "where?". The HTTP call is injected
// (chat(body, signal) -> parsed JSON of /chat/completions), so this file knows nothing about ports, keys or sessions.
const { presencePrompt, groundingPrompt } = require('./query');
const { parseBoxes } = require('./boxes');

class VlmError extends Error {
  constructor(code, message) { super(message); this.name = 'VlmError'; this.code = code; }
}

function createVlm(opts) {
  const o = opts;
  const format = o.boxFormat || 'k1000';

  async function ask(frame, text, maxTokens, signal) {
    const body = {
      model: 'local', temperature: 0, max_tokens: maxTokens,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + frame.jpeg.toString('base64') } }, { type: 'text', text }] }],
    };
    const json = await o.chat(body, signal);
    const msg = json && Array.isArray(json.choices) && json.choices[0] ? json.choices[0].message : null;
    if (!msg) throw new VlmError('BAD_RESPONSE', 'The vision model returned no answer');
    return String(typeof msg.content === 'string' ? msg.content : '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
  }

  return {
    // true only for a clear "yes" (English or Turkish), anything else counts as "not there"
    async probe(frame, phrase, position, signal) {
      return /^\W*(yes|evet)\b/i.test(await ask(frame, presencePrompt(phrase, position), 6, signal));
    },
    async ground(frame, phrase, position, signal) {
      return parseBoxes(await ask(frame, groundingPrompt(phrase, position), 160, signal), format, frame.size);
    },
  };
}

module.exports = { createVlm, VlmError };
