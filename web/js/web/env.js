(function () {
  'use strict';
  // Web edition: what this browser can do. The editor itself runs in every browser that has WebCodecs (Chrome, Edge, Opera, recent Safari/Firefox);
  // a few conveniences (saving straight to a chosen file, remembering project files) need the File System Access API (Chrome / Edge).
  window.VE = window.VE || {};
  var caps = {
    secureContext: !!window.isSecureContext,
    webCodecs: typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function' && typeof window.AudioEncoder === 'function' && typeof window.AudioDecoder === 'function',
    fileSystemAccess: typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function',
    webGpu: !!navigator.gpu,
    promptApi: typeof window.LanguageModel !== 'undefined',
  };
  VE.web = {
    edition: 'web',
    version: '4.4.0',
    mediabunnyVersion: '1.65.1',
    caps: caps,
    // set by api.js once files are imported (object URLs of the picked files and of the generated thumbnails)
    mediaUrl: function () { return ''; },
    thumbUrl: function () { return ''; },
    // ?vetest in the address bar: automated tests may hand files / answers to the page (nothing else changes)
    test: new URLSearchParams(location.search).has('vetest'),
  };
})();
