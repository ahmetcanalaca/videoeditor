'use strict';
// Tracks every spawned child process so they can all be terminated when the app quits.
const children = new Set();

function track(child) {
  children.add(child);
  const done = () => children.delete(child);
  child.once('close', done);
  child.once('error', done);
  return child;
}

function killAll() {
  for (const c of children) {
    try { c.kill(); } catch (e) { /* already gone */ }
  }
  children.clear();
}

module.exports = { track, killAll };
