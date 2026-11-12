'use strict';
// The toolbar window: is Foundry Local found, find it (by port / automatically), and which sites are allowed.
(async function () {
  const $ = (id) => document.getElementById(id);
  const t = (k, v) => VEUI.t(k, v);
  let st = null;
  let busy = false;

  const ask = async (msg) => { try { return await chrome.runtime.sendMessage(msg); } catch (e) { return null; } };
  const say = (kind, text) => { $('msg').className = 'msg ' + kind; $('msg').textContent = text || ''; };

  function render() {
    if (!st) return;
    VEUI.set(st.lang);
    VEUI.apply();
    $('ver').textContent = st.version;
    const found = !!st.base;
    $('state').className = 'state ' + (busy ? '' : (found ? 'ok' : 'warn'));
    $('stateText').textContent = busy ? t(st.scanning ? 'pop.scanning' : 'pop.checking') : (found ? t('pop.found', { addr: st.base.replace(/^http:\/\//, '') }) : t('pop.notFound'));
    $('help').hidden = found || busy;
    $('help').textContent = t('pop.notFoundHelp');
    $('recheck').disabled = $('scan').disabled = $('usePort').disabled = busy;
    $('scan').textContent = t(st.scanning ? 'pop.scanning' : 'pop.scan');
    if (st.port && document.activeElement !== $('port') && !$('port').value) $('port').value = String(st.port);
    const list = $('sites');
    list.replaceChildren();
    st.approved.forEach((origin) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = origin;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('pop.remove');
      b.addEventListener('click', async () => { st = (await ask({ t: 'popup:revoke', origin })) || st; render(); });
      li.append(name, b);
      list.append(li);
    });
    $('noSites').hidden = st.approved.length > 0;
  }

  async function run(msg, after) {
    busy = true;
    say('', '');
    render();
    const r = await ask(msg);
    busy = false;
    if (r && r.state) { st = r.state; } else if (r && r.version) { st = r; }
    if (after) after(r);
    render();
  }

  st = await ask({ t: 'popup:state' });
  if (!st) { document.body.textContent = 'Extension is not ready.'; return; }
  render();
  $('recheck').addEventListener('click', () => run({ t: 'popup:check' }));
  $('scan').addEventListener('click', () => run({ t: 'popup:scan' }));
  $('usePort').addEventListener('click', () => {
    const port = Number($('port').value.trim());
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { say('err', t('pop.portBad')); return; }
    run({ t: 'popup:setPort', port }, (r) => {
      if (r && r.ok) say('ok', t('pop.portOk'));
      else say('err', t(r && r.code === 'NOT_FOUNDRY' ? 'pop.portOther' : (r && r.code === 'BAD_REQUEST' ? 'pop.portBad' : 'pop.portNone')));
    });
  });
  // the first look: is it there? (answers from the worker's memory or from the last port; no scan)
  if (!st.base) run({ t: 'popup:check' });
})();
