(function () {
  'use strict';
  // Offline support and updates of the web edition (see sw.js). The editor keeps working while an update waits: it is only applied when the
  // user agrees (and there is nothing unsaved), so files of two versions are never mixed.
  var VEW = window.VE.web;
  if (VEW.test || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  var t = function (key, vars) { return window.VE.i18n.t(key, vars); };
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
  var asked = false;

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; } // the first worker took control: nothing to reload
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  function hasUnsavedWork() {
    var S = window.VE && window.VE.state && window.VE.state.S;
    return !!(S && S.dirty && S.segments.length);
  }

  async function offer(reg) {
    if (asked || !reg.waiting) return;
    if (hasUnsavedWork()) return; // applied at the next visit
    asked = true;
    var choice = await window.api.messageBox({ type: 'question', title: t('app.title'), message: t('pwa.updateMsg'), buttons: [t('pwa.updateNow'), t('pwa.updateLater')], defaultId: 0, cancelId: 1 });
    if (choice === 0 && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg);
    reg.addEventListener('updatefound', function () {
      var w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', function () {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(reg);
        else if (w.state === 'activated' && !hadController) {
          // first visit: the editor is now available offline
          try {
            if (!localStorage.getItem('ve.web.offlineNotified')) {
              localStorage.setItem('ve.web.offlineNotified', '1');
              window.VE.actions.toast(t('pwa.offlineReady'), 'success', 4000);
            }
          } catch (e) { /* storage blocked */ }
        }
      });
    });
    // look for a new version when the tab comes back, and now and then while it stays open
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
    setInterval(function () { reg.update().catch(function () {}); }, 6 * 3600 * 1000);
    window.__veSw = reg; // for the tests
  }).catch(function (e) { console.warn('[sw] not registered:', e && e.message); });
})();
