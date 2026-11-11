'use strict';
// Where the assistant's credentials and requests may be sent, besides the provider's own address.
//
// Two lists, each in its own small file next to the other private data (never in settings.json, which the page can influence):
//   'entra'  ai-entra-origins.json    where the Microsoft Entra ID token of the user's Azure CLI sign-in may go. That token is valid against EVERY Azure
//                                     OpenAI / Foundry resource the user can reach, so a script in the page that could simply name any HTTPS address
//                                     as the "endpoint" could have it sent to a server of its own.
//   'key'    ai-endpoint-origins.json where an API key and the text of the prompts may go when the address is not the provider's own well-known one
//                                     (an Azure / Foundry resource, a company gateway, ...). Otherwise a script in the page could redirect the
//                                     assistant to a server of its own and have the prompts it composes sent there.
//   'cu'     ai-cu-origins.json       where reduced copies of the user's VIDEOS may be uploaded for the analysis with Azure Content Understanding (Foundry
//                                     provider). Confirmed separately: uploading a video is a bigger decision than sending a prompt.
// An origin gets into a list only after the USER confirmed it in a native dialog of the main process (a script in the page cannot click it).
const fs = require('fs');
const path = require('path');

const MAX_ORIGINS = 50;
const validOrigin = (s) => typeof s === 'string' && s.length <= 300 && /^https?:\/\/[^/\s]+$/i.test(s);

class OriginTrust {
  constructor(file) {
    this.file = file;
    this.list = null;
  }

  load() {
    if (this.list) return this.list;
    this.list = [];
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && Array.isArray(j.origins)) this.list = j.origins.filter(validOrigin).slice(0, MAX_ORIGINS);
    } catch (e) { /* no file yet, or damaged: nothing is confirmed */ }
    return this.list;
  }

  has(origin) {
    return validOrigin(origin) && this.load().includes(origin);
  }

  // Remembers a confirmed origin. Returns false when it could not be saved (then it is not trusted either).
  add(origin) {
    if (!validOrigin(origin)) return false;
    const list = this.load();
    if (list.includes(origin)) return true;
    const next = list.concat(origin).slice(-MAX_ORIGINS);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ origins: next }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      return false;
    }
    this.list = next;
    return true;
  }

  clear() {
    this.list = [];
    try { fs.rmSync(this.file, { force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = { OriginTrust, validOrigin, FILES: { entra: 'ai-entra-origins.json', key: 'ai-endpoint-origins.json', cu: 'ai-cu-origins.json' } };
