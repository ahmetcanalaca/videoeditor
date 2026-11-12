'use strict';
// A tiny assertion collector: prints PASS/FAIL lines and sets a failing exit code (no dependencies, no browser: usable by the pure unit tests, too).
function checker(title) {
  const results = [];
  const fn = function (name, ok, detail) {
    results.push({ name, ok: !!ok });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && (!ok || process.env.VE_VERBOSE) ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
    if (!ok) process.exitCode = 1;
  };
  fn.summary = function () {
    const bad = results.filter((r) => !r.ok).length;
    console.log('\n' + title + ': ' + (results.length - bad) + '/' + results.length + ' passed' + (bad ? ' - ' + bad + ' FAILED' : ''));
    return bad === 0;
  };
  return fn;
}

module.exports = { checker };
