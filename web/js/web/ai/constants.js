// Settings vocabulary of the assistant in the web edition. The first values are the desktop app's (src/main/settings.js; tests/ai-core.test.js fails when they
// drift apart); the rest is specific to running in a browser. The desktop app's "builtin" (the model it downloads and starts itself) is not here: a page cannot
// start a model. "foundrylocal" (Foundry Local) is: its server sends no CORS headers, so a page reaches it through a small browser extension that the user installs
// and approves (extension/, js/web/ai/fl-bridge.js); the settings dialog walks through the steps. "inbrowser" needs nothing installed at all: a model runs in a worker of
// this page, on the graphics card (WebGPU), and only its data files are downloaded (js/web/ai/inbrowser/).
export const constants = {
  AI_PROVIDERS: ['openai', 'azure', 'foundry', 'anthropic', 'gemini', 'local', 'foundrylocal', 'inbrowser'],
  // what a setup that was never made (or is no longer valid) falls back to: the model in this tab, the one way that needs no account, no key and nothing installed
  DEFAULT_PROVIDER: 'inbrowser',
  CU_LOCATIONS: ['geography', 'dataZone', 'global'],
  CU_ANALYZER_RE: /^[A-Za-z0-9._-]{1,64}$/,
  CU_DEFAULT_ANALYZER: 'prebuilt-videoSearch',

  // addresses of the providers themselves: requests there need no confirmation by the user (everything else does, once)
  WELL_KNOWN_ORIGINS: ['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com'],
  // where a local server (Ollama, LM Studio, llama.cpp, ...) is looked for when the user asks "find local servers" (only one that allows browsers answers)
  DISCOVER_PORTS: [11434, 1234, 8080],
};
