// Settings vocabulary of the assistant in the web edition. The first values are the desktop app's (src/main/settings.js; tests/ai-core.test.js fails when they
// drift apart); the rest is specific to running in a browser. The desktop app's "builtin" (the model it downloads itself) and "foundrylocal" (Foundry Local) are not
// here: a page cannot start a model, and Foundry Local's server sends no CORS headers, so a page cannot talk to it (the settings dialog says so).
export const constants = {
  AI_PROVIDERS: ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local'],
  // what a setup that was never made (or is no longer valid) falls back to
  DEFAULT_PROVIDER: 'foundry',
  CU_LOCATIONS: ['geography', 'dataZone', 'global'],
  CU_ANALYZER_RE: /^[A-Za-z0-9._-]{1,64}$/,
  CU_DEFAULT_ANALYZER: 'prebuilt-videoSearch',

  // addresses of the providers themselves: requests there need no confirmation by the user (everything else does, once)
  WELL_KNOWN_ORIGINS: ['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com'],
  // where a local server (Ollama, LM Studio, llama.cpp, ...) is looked for when the user asks "find local servers" (only one that allows browsers answers)
  DISCOVER_PORTS: [11434, 1234, 8080],
};
