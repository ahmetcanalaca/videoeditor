'use strict';
// Main-process side of the Foundry Local panel (settings dialog of the AI assistant): is it installed and running, the models, download / load / unload, start the server,
// and the official addresses where a person gets Foundry Local. See local.js for how Foundry Local is reached and why.
// The page only ever sends a model id (checked against MODEL_ID_RE in local.js) or the name of one of three fixed links; it never provides a command or an address.
const os = require('os');
const { createFoundryLocal, LINKS, INSTALL_COMMAND } = require('./local');

// ctx: { handle(channel, fn), send(channel, payload), log?, openExternal(url) -> Promise, client? (a createFoundryLocal result: tests) }
function registerFoundryIpc(ctx) {
  const fl = ctx.client || createFoundryLocal({ log: ctx.log });
  let job = null; // { kind: 'start'|'download'|'load'|'list', id, controller } - one at a time: Foundry Local itself does one thing at a time
  const fail = (code, detail) => ({ ok: false, error: { code, detail: detail || '' } });
  const failFrom = (r) => fail(r.code, r.detail);

  async function statusInfo() {
    const s = await fl.status();
    return Object.assign({}, s, { totalMemMb: Math.round(os.totalmem() / (1024 * 1024)), links: LINKS, installCommand: INSTALL_COMMAND, busy: job ? job.kind : '', busyId: job ? job.id : '' });
  }

  // runs fn(signal) as THE job; { ok:false, error: BUSY } while another one is running
  async function exclusive(kind, id, fn) {
    if (job) return fail('FL_BUSY');
    const controller = new AbortController();
    job = { kind, id: id || '', controller };
    ctx.send('fl:progress', { job: kind, id: id || '', phase: 'start' });
    try {
      return await fn(controller.signal);
    } finally {
      job = null;
      ctx.send('fl:progress', { job: kind, id: id || '', phase: 'end' });
    }
  }

  ctx.handle('fl:status', async () => ({ ok: true, status: await statusInfo() }));

  ctx.handle('fl:start', () => exclusive('start', '', async (signal) => {
    const r = await fl.ensureServer({ signal });
    return r.ok ? { ok: true, status: await statusInfo() } : failFrom(r);
  }));

  // req: { catalog?: boolean } - cached models only (fast), or the whole catalogue of Foundry Local
  ctx.handle('fl:models', (e, req) => exclusive('list', '', async (signal) => {
    const s = await fl.status();
    if (!s.cliFound && !s.running) return fail('FL_NOT_INSTALLED');
    const r = await fl.listModels({ catalog: !!(req && req.catalog), signal });
    return r.ok ? { ok: true, models: r.models, status: await statusInfo() } : failFrom(r);
  }));

  // req: { id } - Foundry Local downloads the model from Microsoft's catalogue (progress as 'fl:progress' events)
  ctx.handle('fl:download', (e, req) => {
    const id = req && typeof req.id === 'string' ? req.id : '';
    if (!fl.validId(id)) return fail('FL_BAD_MODEL');
    return exclusive('download', id, async (signal) => {
      const r = await fl.download(id, { signal, onProgress: (p) => ctx.send('fl:progress', { job: 'download', id, phase: 'progress', percent: p.percent }) });
      return r.ok ? { ok: true } : failFrom(r);
    });
  });

  ctx.handle('fl:load', (e, req) => {
    const id = req && typeof req.id === 'string' ? req.id : '';
    if (!fl.validId(id)) return fail('FL_BAD_MODEL');
    return exclusive('load', id, async (signal) => {
      const up = await fl.ensureServer({ signal });
      if (!up.ok) return failFrom(up);
      const r = await fl.load(id, { signal });
      return r.ok ? { ok: true } : failFrom(r);
    });
  });

  ctx.handle('fl:unload', async (e, req) => {
    const id = req && typeof req.id === 'string' ? req.id : '';
    if (!fl.validId(id)) return fail('FL_BAD_MODEL');
    const r = await fl.unload(id);
    return r.ok ? { ok: true } : failFrom(r);
  });

  ctx.handle('fl:cancel', () => { if (job) job.controller.abort(); return true; });

  // req: { key } - one of the fixed official addresses (the installer, the documentation, the project): opened in the browser of the person
  ctx.handle('fl:open-link', async (e, req) => {
    const key = req && typeof req.key === 'string' ? req.key : '';
    if (!Object.prototype.hasOwnProperty.call(LINKS, key)) return false;
    try { await ctx.openExternal(LINKS[key]); return true; } catch (err) { return false; }
  });

  return { client: fl, abortAll() { if (job) job.controller.abort(); } };
}

module.exports = { registerFoundryIpc };
