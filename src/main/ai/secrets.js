'use strict';
// Storage of the user's API key. It is only ever written ENCRYPTED with Electron's safeStorage (Windows DPAPI: bound to the
// current Windows user). If encryption is unavailable the key lives in memory only and is gone after the app closes.
// The key never goes into settings.json, project files, logs or the renderer (the renderer only gets a masked hint).
// The endpoint ORIGIN the key was entered for is part of the SAME encrypted record: a crash or a failed write can therefore never
// pair a key with another endpoint, and get(origin) hands the secret out for that origin only.
const fs = require('fs');
const path = require('path');

const MAX_KEY = 4096;
const FILE_VERSION = 2;
// Antivirus scanners and indexers hold a file for a moment: deleting it is retried after these pauses (ms).
const RETRY_DELAYS_MS = [0, 80, 240];

function sleepSync(ms) {
  if (ms > 0) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no pause */ } }
}

// Printable ASCII without spaces: valid in an HTTP header and the shape of every provider's keys.
function validateKey(raw) {
  const key = String(raw == null ? '' : raw).trim();
  if (!key) return { ok: false, code: 'KEY_EMPTY' };
  if (key.length > MAX_KEY) return { ok: false, code: 'KEY_TOO_LONG' };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, code: 'KEY_INVALID' };
  return { ok: true, key };
}

class KeyStore {
  // opts: { file, safeStorage, fs (tests), retryDelaysMs (tests) }
  constructor(opts) {
    this.file = opts.file;
    this.safe = opts.safeStorage || null;
    this.fs = opts.fs || fs;
    this.delays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : RETRY_DELAYS_MS;
    this.key = '';
    this.keyOrigin = '';
    this.persisted = false;
    this._load();
  }

  encryptionAvailable() {
    try { return !!(this.safe && this.safe.isEncryptionAvailable()); } catch (e) { return false; }
  }

  _load() {
    try {
      const doc = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (doc && doc.v === FILE_VERSION && doc.enc === 'safeStorage' && typeof doc.data === 'string' && this.encryptionAvailable()) {
        const rec = JSON.parse(this.safe.decryptString(Buffer.from(doc.data, 'base64')));
        if (rec && typeof rec.k === 'string' && typeof rec.o === 'string' && validateKey(rec.k).ok) {
          this.key = rec.k;
          this.keyOrigin = rec.o;
          this.persisted = true;
        }
      }
    } catch (e) {
      // missing, corrupt, an older format, or encrypted by another Windows user: behave as "no key"
      this.key = '';
      this.keyOrigin = '';
      this.persisted = false;
    }
  }

  has() { return !!this.key; }

  // The endpoint origin the stored key belongs to ('' = none / unknown). Not a secret.
  origin() { return this.keyOrigin; }

  // Main process only: this is the one place that hands out the secret - and only for the endpoint it was entered for.
  get(origin) { return this.key && origin && origin === this.keyOrigin ? this.key : ''; }

  // Does the file still hold an encrypted key record, i.e. one that a later start would load?
  _recordOnDisk() {
    let text;
    try { text = this.fs.readFileSync(this.file, 'utf8'); } catch (e) { return !!(e && e.code !== 'ENOENT'); }
    try { const doc = JSON.parse(text); return !!(doc && doc.enc === 'safeStorage'); } catch (e) { return false; }
  }

  // Gets the stored record out of the way for good: delete (retried), else overwrite it with an empty marker that is never loaded.
  // false = a record that a later start would load may still be on disk.
  _dropRecord() {
    for (const ms of this.delays) {
      sleepSync(ms);
      try { this.fs.rmSync(this.file, { force: true }); } catch (e) { /* retry */ }
      if (!this._recordOnDisk()) break;
    }
    if (this._recordOnDisk()) {
      try { this.fs.writeFileSync(this.file, JSON.stringify({ v: FILE_VERSION, enc: 'none' }), 'utf8'); } catch (e) { /* verified below */ }
    }
    try { this.fs.rmSync(this.file + '.tmp', { force: true }); } catch (e) { /* the temp file is never loaded */ }
    return !this._recordOnDisk();
  }

  // -> { ok } or { ok:false, code }. KEY_STORE_FAILED: the key could not be stored AND the older record could not be removed;
  // nothing was changed then (the older key is kept as it was).
  set(raw, origin) {
    const v = validateKey(raw);
    if (!v.ok) return v;
    const prev = { key: this.key, origin: this.keyOrigin, persisted: this.persisted };
    this.key = v.key;
    this.keyOrigin = String(origin || '');
    this.persisted = false;
    if (this.encryptionAvailable()) {
      try {
        const data = this.safe.encryptString(JSON.stringify({ k: v.key, o: this.keyOrigin })).toString('base64');
        this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        this.fs.writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, enc: 'safeStorage', data }), 'utf8');
        this.fs.renameSync(tmp, this.file);
        this.persisted = true;
      } catch (e) {
        // The new key then lives in memory only. An OLDER record must not stay on disk: after a restart it would come back,
        // possibly for another endpoint than the one the user has just set up.
        if (!this._dropRecord()) {
          this.key = prev.key;
          this.keyOrigin = prev.origin;
          this.persisted = prev.persisted;
          return { ok: false, code: 'KEY_STORE_FAILED' };
        }
      }
    }
    return { ok: true };
  }

  // The key is forgotten in memory in every case. -> { ok } or { ok:false, code:'KEY_DELETE_FAILED' } when the stored record
  // could not be removed (it would be loaded again at the next start): the caller must not claim the key is gone then.
  clear() {
    this.key = '';
    this.keyOrigin = '';
    this.persisted = false;
    return this._dropRecord() ? { ok: true } : { ok: false, code: 'KEY_DELETE_FAILED' };
  }

  mask() {
    if (!this.key) return '';
    return this.key.length >= 12 ? '••••' + this.key.slice(-4) : '••••';
  }

  info() {
    return { hasKey: this.has(), masked: this.mask(), persisted: this.persisted, encryptionAvailable: this.encryptionAvailable() };
  }
}

module.exports = { KeyStore, validateKey };
