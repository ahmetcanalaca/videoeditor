'use strict';
// The approval window: which site asks is told by the service worker (never by the page), and the answer goes back to it.
(async function () {
  const ALLOW_DELAY_MS = 1500;
  const $ = (id) => document.getElementById(id);
  let info = null;
  try { info = await chrome.runtime.sendMessage({ t: 'consent:get' }); } catch (e) { info = null; }
  if (info && info.lang) VEUI.set(info.lang);
  VEUI.apply();
  if (!info || typeof info.origin !== 'string') { $('expired').hidden = false; return; }
  $('origin').textContent = info.origin;
  $('ask').hidden = false;
  let decided = false;
  const decide = async (allow) => {
    if (decided) return;
    decided = true;
    $('allow').disabled = true;
    $('deny').disabled = true;
    try { await chrome.runtime.sendMessage({ t: 'consent:decide', allow }); } catch (e) { /* the window is closed by the worker */ }
    window.close();
  };
  $('allow').addEventListener('click', () => decide(true));
  $('deny').addEventListener('click', () => decide(false));
  // "Allow" cannot be pressed in the first moment: a click that was meant for the page (a double click on the button that opened this window) must not approve
  $('allow').disabled = true;
  setTimeout(() => { if (!decided) $('allow').disabled = false; }, ALLOW_DELAY_MS);
  $('deny').focus();
})();
