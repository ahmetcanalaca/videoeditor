(function () {
  'use strict';
  window.VE = window.VE || {};

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v); // CSSOM only: the CSP forbids style attributes
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    (children || []).forEach((c) => { if (c) node.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return node;
  }

  // Language-aware number formatting (Turkish uses a decimal comma).
  function fmtNum(n, maxDigits) {
    const lang = VE.i18n ? VE.i18n.getLanguage() : 'tr';
    return Number(n).toLocaleString(lang === 'en' ? 'en-US' : 'tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: maxDigits === undefined ? 2 : maxDigits, useGrouping: false });
  }

  // Paints the filled part of a range input's track (--fill drives the gradient in app.css).
  function fillRange(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', clamp(pct, 0, 100).toFixed(2) + '%');
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Calls fn at most once per animation frame (with the latest arguments).
  function rafThrottle(fn) {
    let queued = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn.apply(this, lastArgs); });
    };
  }

  function stripExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
  }

  VE.util = { clamp, $, $$, el, debounce, rafThrottle, stripExt, formatBytes, formatDuration, fmtNum, fillRange };
})();
