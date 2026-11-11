// Runs before first paint: applies the persisted theme/language so there is no flash of the wrong theme.
(function () {
  'use strict';
  var s = (window.api && window.api.settings) || { theme: 'dark', language: 'tr' };
  document.documentElement.setAttribute('data-theme', s.theme === 'light' ? 'light' : 'dark');
  document.documentElement.setAttribute('lang', s.language === 'en' ? 'en' : 'tr');
})();
