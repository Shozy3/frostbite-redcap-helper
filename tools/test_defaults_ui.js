/*
 * Deterministic UI test (jsdom) for the "no data on file" field defaults
 * (minimal_temperature / maximum_temperature = 99), end-to-end through the real page:
 *   - both temp fields are PRE-FILLED with 99 on a fresh load
 *   - each carries a visible "Clear" button (the "option to clear if someone wants to")
 *   - REGRESSION: clicking "Start over" RE-SEEDS the 99 defaults (they used to be wiped)
 *   - a value the user typed is NOT overwritten by the defaults
 *   - clicking a field's "Clear" blanks it and it STAYS blank within the session
 *     (applyDefaults only re-seeds on load / start-over / restore, never on refresh)
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');

let fails = [], passes = 0;
const ok = (c, m) => { if (c) passes++; else fails.push(m); };

function makePage() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  w.confirm = () => true; // "Start over" confirmation auto-accepts
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  if (!w.TextEncoder) { w.TextEncoder = global.TextEncoder; w.TextDecoder = global.TextDecoder; }
  if (!w.btoa) { w.btoa = s => Buffer.from(s, 'binary').toString('base64'); w.atob = b => Buffer.from(b, 'base64').toString('binary'); }
  w.eval(read('config.js')); w.CONFIG.requirePassphrase = false;
  w.eval(read('datemask.js'));
  w.eval(read('dictionary.js')); w.eval(read('dict_hhr.js')); w.eval(read('branch.js'));
  w.eval(read('payload.js')); w.eval(read('hhr_calc.js')); w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js')); w.eval(read('ilop.js')); w.eval(read('cryptosave.js')); w.eval(read('app.js'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, doc: w.document };
}

const click = (w, node) => node && node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const fieldOf = (doc, v) => doc.querySelector(`[data-var="${v}"]`);
const inputOf = (doc, v) => { const f = fieldOf(doc, v); return f && f.querySelector('input,textarea'); };
const clearBtnOf = (doc, v) => { const f = fieldOf(doc, v); return f && [...f.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear'); };
function setText(w, doc, v, val) { const i = inputOf(doc, v); if (i) { i.value = val; i.dispatchEvent(new w.Event('input', { bubbles: true })); i.dispatchEvent(new w.Event('change', { bubbles: true })); } }

const DEF = ['minimal_temperature', 'maximum_temperature'];

(function main() {
  const { w, doc } = makePage();

  // 1) Fresh load: both temp fields are pre-filled with 99, and each has a Clear button.
  DEF.forEach(v => {
    ok(inputOf(doc, v) && inputOf(doc, v).value === '99', `${v} pre-filled with 99 on load`);
    ok(!!clearBtnOf(doc, v), `${v} shows a "Clear" button`);
  });

  // 2) A value the user typed is preserved (defaults never overwrite it).
  setText(w, doc, 'minimal_temperature', '-12');
  ok(inputOf(doc, 'minimal_temperature').value === '-12', 'user-typed min temp is kept, not overwritten by default');
  ok(inputOf(doc, 'maximum_temperature').value === '99', 'the other temp field still shows its 99 default');

  // 3) REGRESSION: "Start over" re-seeds the 99 defaults (previously they were wiped).
  //    Also set an unrelated field to confirm Start over clears everything else.
  setText(w, doc, 'study_number', 'ABC123');
  ok(inputOf(doc, 'study_number').value === 'ABC123', 'sanity: unrelated field holds its typed value');
  click(w, doc.getElementById('btn-clear')); // "Start over"
  DEF.forEach(v => ok(inputOf(doc, v).value === '99', `${v} re-seeded to 99 after Start over`));
  ok(inputOf(doc, 'study_number').value === '', 'non-default field is cleared by Start over');

  // 4) Field-level "Clear" blanks the default and it STAYS blank within the session
  //    (a later refresh triggered by editing another field must not re-seed it).
  click(w, clearBtnOf(doc, 'minimal_temperature'));
  ok(inputOf(doc, 'minimal_temperature').value === '', 'Clear button blanks the min-temp default');
  setText(w, doc, 'maximum_temperature', '5'); // triggers refresh()
  ok(inputOf(doc, 'minimal_temperature').value === '', 'cleared default stays blank after an unrelated refresh');

  // 5) Start over again re-seeds even a field the user had explicitly cleared.
  click(w, doc.getElementById('btn-clear'));
  ok(inputOf(doc, 'minimal_temperature').value === '99', 'previously-cleared default returns to 99 on Start over');

  console.log(`\nDefaults UI test — ${passes} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach(f => console.log('  -- ' + f)); console.log('\nFAIL.'); process.exit(1); }
  console.log('\nPASS: 99 min/max defaults are fixed across Start over and remain clearable.');
})();
