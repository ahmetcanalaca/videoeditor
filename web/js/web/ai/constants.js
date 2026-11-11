// Settings vocabulary of the assistant in the web edition. The first four values are the desktop app's (src/main/settings.js; tests/ai-core.test.js
// fails when they drift apart); the rest is specific to running in a browser.
export const constants = {
  AI_PROVIDERS: ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local', 'builtin'],
  CU_LOCATIONS: ['geography', 'dataZone', 'global'],
  CU_ANALYZER_RE: /^[A-Za-z0-9._-]{1,64}$/,
  CU_DEFAULT_ANALYZER: 'prebuilt-videoSearch',

  // "builtin" in the web edition = the Local AI helper that the user runs on their own computer (see web/local-ai/): a llama.cpp server on this
  // computer, with the same model as the desktop app. The page finds it through the pairing link the helper opens (#local-ai=<port>.<key>).
  LOCAL_AI_DEFAULT_PORT: 8473,
  // addresses of the providers themselves: requests there need no confirmation by the user (everything else does, once)
  WELL_KNOWN_ORIGINS: ['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com'],
  // where a local server (Ollama, LM Studio, llama.cpp, the helper, ...) is looked for when the user asks "find local servers"
  DISCOVER_PORTS: [8473, 11434, 1234, 8080, 5272],
};
