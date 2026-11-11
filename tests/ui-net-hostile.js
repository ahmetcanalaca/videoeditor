'use strict';
// A HOSTILE page cannot reach the network: whatever script runs in the editor window (the page decodes untrusted media and shows model output, so
// it is the least trusted part of the app) must not be able to make a connection - not with fetch / WebSocket / beacon / image / navigation and not
// with WebRTC (ICE servers: STUN / TURN over UDP or TCP are not covered by the Content-Security-Policy). Two throw-away servers on this computer
// (TCP and UDP) count what arrives; every attempt is made from inside the page.
//   node tests/ui-net-hostile.js          (VE_EXE=<VideoEditor.exe> tests the packaged application)
const net = require('net');
const dgram = require('dgram');
const { launch, sleep } = require('./ui-lib');
const { step, assert, summary, ud } = require('./ui-helpers');

(async () => {
  const tcpHits = [];
  const udpHits = [];
  const tcp = net.createServer((s) => { tcpHits.push(s.remoteAddress + ':' + s.remotePort); s.on('error', () => {}); s.destroy(); });
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m, r) => udpHits.push(r.address + ':' + r.port + ' ' + m.length + ' bytes'));
  await new Promise((res) => tcp.listen(0, '127.0.0.1', res));
  await new Promise((res) => udp.bind(0, '127.0.0.1', res));
  const TCP = tcp.address().port;
  const UDP = udp.address().port;

  const app = await launch({ userData: ud('net-hostile'), port: 9371 });
  const J = JSON.stringify;
  try {
    await step('N01 fetch, XMLHttpRequest, WebSocket, beacon, image, stylesheet and window.open from the page reach nothing', async () => {
      const r = await app.evaluate(`(async () => {
        const out = {};
        const tryIt = async (name, fn) => { try { await fn(); out[name] = 'no error'; } catch (e) { out[name] = String((e && e.message) || e).slice(0, 80); } };
        await tryIt('fetch', () => fetch('http://127.0.0.1:${TCP}/fetch', { mode: 'no-cors' }));
        await tryIt('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:${TCP}/xhr'); x.onload = res; x.onerror = () => rej(new Error('xhr blocked')); x.send(); }));
        await tryIt('websocket', () => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:${TCP}/ws'); w.onopen = res; w.onerror = () => rej(new Error('ws blocked')); setTimeout(() => rej(new Error('ws timeout')), 1500); }));
        await tryIt('beacon', async () => { if (!navigator.sendBeacon('http://127.0.0.1:${TCP}/beacon', 'x')) throw new Error('beacon refused'); });
        await tryIt('image', () => new Promise((res, rej) => { const i = new Image(); i.onload = res; i.onerror = () => rej(new Error('img blocked')); i.src = 'http://127.0.0.1:${TCP}/img.png'; setTimeout(() => rej(new Error('img timeout')), 1500); }));
        await tryIt('open', async () => { const w = window.open('http://127.0.0.1:${TCP}/open'); if (w) { w.close(); throw new Error('a window was opened'); } });
        return out;
      })()`);
      await sleep(1500);
      assert(tcpHits.length === 0, 'the page reached the TCP server: ' + J(tcpHits) + ' ' + J(r));
      return J(r);
    });

    await step('N02 WebRTC (STUN / TURN over UDP and over TCP, also with a host name) sends nothing to a server of the attacker', async () => {
      const r = await app.evaluate(`(async () => {
        const out = { created: false };
        try {
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: ['stun:127.0.0.1:${UDP}'] },
              { urls: ['turn:127.0.0.1:${UDP}?transport=udp'], username: 'secret-user', credential: 'secret-pass' },
              { urls: ['turn:127.0.0.1:${TCP}?transport=tcp'], username: 'secret-user', credential: 'secret-pass' },
              { urls: ['turns:127.0.0.1:${TCP}?transport=tcp'], username: 'secret-user', credential: 'secret-pass' },
              { urls: ['stun:localhost:${UDP}'] },
            ],
            iceTransportPolicy: 'all',
          });
          out.created = true;
          pc.createDataChannel('x');
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((res) => { const t = setTimeout(res, 5000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }; });
          out.gathering = pc.iceGatheringState;
          out.sdp = (pc.localDescription && pc.localDescription.sdp || '').split('\\n').filter((l) => /^a=candidate/.test(l)).map((l) => l.split(' ').slice(4, 8).join(' ')).slice(0, 8);
          pc.close();
        } catch (e) { out.error = String((e && e.message) || e).slice(0, 160); }
        return out;
      })()`);
      await sleep(2000);
      const leaked = tcpHits.length + udpHits.length;
      assert(leaked === 0, 'WebRTC reached the attacker servers: tcp ' + J(tcpHits) + ' udp ' + J(udpHits) + ' page: ' + J(r));
      return 'page: ' + J(r);
    });

    await step('N03 resource hints and elements (preconnect, prefetch, dns-prefetch, iframe, form, ping, video, audio, object, CSS url) reach nothing either', async () => {
      await app.evaluate(`(() => {
        const U = 'http://127.0.0.1:${TCP}';
        const add = (tag, attrs) => { const e = document.createElement(tag); for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]); document.body.appendChild(e); return e; };
        for (const rel of ['preconnect', 'prefetch', 'dns-prefetch', 'preload', 'prerender', 'stylesheet', 'icon']) add('link', { rel, href: U + '/' + rel, as: rel === 'preload' ? 'fetch' : '' });
        add('iframe', { src: U + '/iframe' });
        add('video', { src: U + '/video.mp4', preload: 'auto' });
        add('audio', { src: U + '/audio.mp3', preload: 'auto' });
        add('object', { data: U + '/object' });
        add('embed', { src: U + '/embed' });
        add('img', { src: U + '/img2.png', srcset: U + '/img3.png 2x' });
        add('div', { style: 'background:url(' + U + '/css.png)' });
        const a = add('a', { href: U + '/a', ping: U + '/ping', target: '_blank' }); a.click();
        const f = add('form', { action: U + '/form', method: 'post' }); try { f.submit(); } catch (e) { /* refused */ }
        return 1;
      })()`);
      await sleep(2500);
      assert(tcpHits.length === 0 && udpHits.length === 0, 'a resource hint or element reached the servers: tcp ' + J(tcpHits) + ' udp ' + J(udpHits));
      assert((await app.evaluate('typeof VE === "object" && !!VE.actions')) === true, 'the app page is gone (a form submit navigated?)');
    });

    await step('N04 the page cannot navigate the window to a web address (the app stays on its own page) and the servers still saw nothing', async () => {
      const before = await app.evaluate('location.href');
      await app.evaluate(`(() => { try { location.href = 'http://127.0.0.1:${TCP}/nav'; } catch (e) {} return 1; })()`);
      await sleep(1500);
      assert((await app.evaluate('location.href')) === before, 'the window navigated away');
      assert((await app.evaluate('typeof VE === "object" && !!VE.actions')) === true, 'the app page is gone');
      assert(tcpHits.length === 0 && udpHits.length === 0, 'a connection arrived: tcp ' + J(tcpHits) + ' udp ' + J(udpHits));
    });

    await step('N05 no console errors that come from the app itself', async () => {
      const own = app.errors.filter((e) => !/Refused to|blocked|ERR_|violates|Failed to load|net::|WebSocket|SecurityError|NotAllowed|CSP|Content Security Policy/i.test(e));
      assert(own.length === 0, own.join('\n'));
    });
  } finally {
    await app.close();
    tcp.close();
    try { udp.close(); } catch (e) { /* ignore */ }
  }
  process.exit(summary('Hostile page: no network (ui-net-hostile)') ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
