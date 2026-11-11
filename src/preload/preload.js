'use strict';
// Sandboxed preload: exposes a small, explicit API to the renderer (contextIsolation stays on).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['media:thumb', 'media:waveform', 'media:proxy', 'export:progress', 'export:done', 'app:open-files', 'app:close-requested', 'ai:step', 'llm:progress']);

const initialSettings = ipcRenderer.sendSync('settings:get-sync');

// Files the user REALLY dropped on the window are reported to main from here, from a trusted (isTrusted) event that no script in the page can fake:
// only such paths (and those given on the command line) may be network paths when the page later asks main to import them.
window.addEventListener('drop', (e) => {
  try {
    if (!e.isTrusted || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    const paths = [];
    for (const f of Array.from(e.dataTransfer.files).slice(0, 200)) {
      const p = webUtils.getPathForFile(f);
      if (p) paths.push(p);
    }
    if (paths.length) ipcRenderer.send('media:dropped', paths);
  } catch (err) { /* a drop that cannot be read is simply not approved */ }
}, true);

contextBridge.exposeInMainWorld('api', {
  settings: initialSettings,
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    save: (req) => ipcRenderer.invoke('ai:save', req),
    clearKey: () => ipcRenderer.invoke('ai:clear-key'),
    test: () => ipcRenderer.invoke('ai:test'),
    run: (req) => ipcRenderer.invoke('ai:run', req),
    cancel: (runId) => ipcRenderer.invoke('ai:cancel', runId),
    discover: () => ipcRenderer.invoke('ai:discover'),
    warm: () => ipcRenderer.invoke('ai:warm'),
    cuTest: () => ipcRenderer.invoke('ai:cu-test'),
    cuClearCache: () => ipcRenderer.invoke('ai:cu-clear-cache'),
  },
  // the built-in local model: status, one-click install (download + check), remove, folder / graphics-or-CPU settings
  llm: {
    status: () => ipcRenderer.invoke('llm:status'),
    install: () => ipcRenderer.invoke('llm:install'),
    cancel: () => ipcRenderer.invoke('llm:cancel'),
    stop: () => ipcRenderer.invoke('llm:stop'),
    remove: () => ipcRenderer.invoke('llm:remove'),
    set: (req) => ipcRenderer.invoke('llm:set', req),
    pickDir: () => ipcRenderer.invoke('llm:pick-dir'),
  },
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  ready: () => ipcRenderer.invoke('app:ready'),
  info: () => ipcRenderer.invoke('app:info'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  importPaths: (paths) => ipcRenderer.invoke('media:import', paths),
  requestProxy: (id) => ipcRenderer.invoke('media:request-proxy', id),
  resetMedia: () => ipcRenderer.invoke('media:reset'),
  pickExportPath: (defaultName) => ipcRenderer.invoke('export:pick-path', defaultName),
  exportStart: (req) => ipcRenderer.invoke('export:start', req),
  exportCancel: (jobId) => ipcRenderer.invoke('export:cancel', jobId),
  reveal: () => ipcRenderer.invoke('shell:reveal'),
  openOutput: () => ipcRenderer.invoke('shell:open-output'),
  projectSave: (req) => ipcRenderer.invoke('project:save', req),
  projectOpen: (p) => ipcRenderer.invoke('project:open', p),
  messageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),
  setTheme: (theme) => ipcRenderer.invoke('window:set-theme', theme),
  closeAck: () => ipcRenderer.invoke('app:close-ack'),
  closeConfirmed: () => ipcRenderer.invoke('app:close-confirmed'),
  on: (channel, callback) => {
    if (!EVENTS.has(channel) || typeof callback !== 'function') return () => {};
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
