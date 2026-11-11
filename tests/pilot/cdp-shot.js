'use strict';
// Takes a screenshot of a RUNNING test app over the DevTools port (to see what a long manual test is waiting for).
//   node tests/pilot/cdp-shot.js <port> <out.png>
const fs = require('fs');
const http = require('http');
const port = Number(process.argv[2] || 9441);
const out = process.argv[3] || 'shot.png';
http.get({ host: '127.0.0.1', port, path: '/json' }, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    const page = JSON.parse(data).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
    ws.onmessage = (e) => { fs.writeFileSync(out, Buffer.from(JSON.parse(e.data).result.data, 'base64')); console.log('saved ' + out); process.exit(0); };
    setTimeout(() => process.exit(1), 15000);
  });
});
