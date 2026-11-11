'use strict';
// Peeks at a RUNNING test app over the DevTools port and prints the state of the AI pane (to see what a long manual test is waiting for).
//   node tests/pilot/cdp-peek.js [port]
const http = require('http');
const port = Number(process.argv[2] || 9441);
http.get({ host: '127.0.0.1', port, path: '/json' }, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    const page = JSON.parse(data).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const expression = "(() => { const d = VE.ai.debug(); const w = document.querySelector('[data-ai=\"working\"]'); return JSON.stringify({ running: d.running, messages: d.messages.length, live: w ? w.textContent : '', input: document.querySelector('#ai-input').value, history: d.history.map((m) => m.role + ': ' + String(m.content).slice(0, 60)), all: d.messages.map((m) => m.type + ': ' + String(m.text).slice(0, 100)) }, null, 1); })()";
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = (e) => { console.log(JSON.parse(e.data).result.result.value); process.exit(0); };
    setTimeout(() => process.exit(1), 8000);
  });
});
