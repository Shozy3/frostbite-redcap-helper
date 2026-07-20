/*
 * Deterministic UI test (jsdom) for the Iloprost dose calculator.
 * Loads the real page + scripts (incl. ilop.js), switches to the Iloprost tab,
 * and exercises the full human flow end-to-end:
 *   - the N-way top switcher (Frostbite | Hennepin | Iloprost) and lazy build
 *   - dose entry: rows, live per-row math, dose totals, grand total in the appbar
 *   - the standalone minutes-between helper (incl. past-midnight)
 *   - add/remove rows & doses and the 5-dose cap
 *   - Save to log -> localStorage, Logs view rendering + detailed steps
 *   - Delete with two-step confirm (cancel + confirm), empty state, count badge
 *   - Copy results to the clipboard
 *   - Clear calculator
 *   - no regression: the Frostbite form and Hennepin calculator still build
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');

let fails = [], passes = 0;
const ok = (c, m) => { if (c) passes++; else fails.push(m); };
const flush = () => new Promise(r => setImmediate(r));

function makePage() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window; w.scrollTo = () => {}; w.confirm = () => true;
  w.Element.prototype.scrollIntoView = function () {}; // jsdom has no layout; setField scrolls the flashed field
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  w.eval(read('config.js')); w.CONFIG.requirePassphrase = false;
  w.eval(read('datemask.js'));
  w.eval(read('dictionary.js')); w.eval(read('dict_hhr.js')); w.eval(read('branch.js'));
  w.eval(read('payload.js')); w.eval(read('hhr_calc.js')); w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js')); w.eval(read('ilop.js')); w.eval(read('cryptosave.js')); w.eval(read('app.js'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, doc: w.document };
}

(async function () {
  const { w, doc } = makePage();
  const $ = id => doc.getElementById(id);
  const click = node => node && node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const setVal = (input, v) => { input.value = v; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const text = el => el ? el.textContent.trim() : null;
  const findBtn = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === label);
  const cards = () => [...doc.querySelectorAll('#ilop-doses .ilop-dose')];
  const rowsOf = card => [...card.querySelectorAll('.ilop-rows .ilop-row')].filter(r => !r.classList.contains('ilop-row-head'));
  const grand = () => text($('ilop-livetotal').querySelector('.ilop-livetotal-val'));

  // sanity: jsdom keeps a valid 24h time value (the whole calc relies on it)
  (function () { ok(w.ILOP_CALC.maskTime('2200') === '22:00' && w.ILOP_CALC.maskTime('1458') === '14:58', 'time mask: 2200->22:00 and 1458->14:58 (no destructive zero-pad)'); })();

  // 1) Switcher: clicking the Iloprost tab reveals + lazily builds it
  click($('sw-ilop'));
  ok(!$('app-ilop').hidden && $('app').hidden && $('app-hhr').hidden, 'Iloprost tab shown, others hidden');
  ok(!!$('ilop-doses'), 'Iloprost UI built (doses container present)');
  ok($('sw-ilop').classList.contains('active') && $('sw-ilop').getAttribute('aria-selected') === 'true', 'Iloprost switcher button marked active');

  // 2) Default structure
  ok(cards().length === 1, 'starts with 1 dose');
  ok(rowsOf(cards()[0]).length === 3, 'dose starts with 3 rate rows');
  ok(grand() === '0.00', 'grand total starts at 0.00');
  ok(!!doc.querySelector('.ilop-minrow'), 'minutes-between helper present');
  ok(!!$('ilop-v-howto'), 'How-to view button present');
  ok(!$('ilop-add-dose').disabled, 'add-dose enabled (no cap)');

  // Fill a dose by typing. Rows auto-append as the last row gets content, so we
  // just re-query and only click "+ Add a row" as a fallback.
  function fillDose(cardIdx, rows, stop) {
    rows.forEach((r, i) => {
      let guard = 0;
      while (rowsOf(cards()[cardIdx]).length <= i && guard++ < 30) click(findBtn(cards()[cardIdx], '+ Add a row'));
      const rws = rowsOf(cards()[cardIdx]);
      setVal(rws[i].querySelector('.ilop-c-time input'), r.t);
      setVal(rws[i].querySelector('.ilop-c-rate input'), String(r.rate));
    });
    setVal(cards()[cardIdx].querySelector('.ilop-stoprow input'), stop);
  }

  // 3) Dose 1 (spreadsheet sample) — live per-row math + dose/grand totals
  fillDose(0, [{ t: '14:58', rate: 2 }, { t: '15:31', rate: 4 }, { t: '16:15', rate: 6 }, { t: '16:48', rate: 8 }], '20:57');
  let c0 = cards()[0];
  ok(text(c0.querySelector('.ilop-dose-total-val')) === '40.53', 'dose 1 total shows 40.53');
  ok(grand() === '40.53', 'grand total shows 40.53 (1 dose)');
  const r0 = rowsOf(c0);
  const r4calc = text(r0[3].querySelector('.ilop-c-calc'));
  ok(/249 min/.test(r4calc) && /33\.20 mcg/.test(r4calc), 'row 4 inline calc shows "249 min ... 33.20 mcg"');
  const r1calc = text(r0[0].querySelector('.ilop-c-calc'));
  ok(/33 min/.test(r1calc) && /1\.10 mcg/.test(r1calc), 'row 1 inline calc shows "33 min ... 1.10 mcg"');
  ok(rowsOf(cards()[0]).length >= 5, 'a blank row auto-appeared while typing (no manual "+ Add" needed)');

  // 4) Dose 2 (sample) — add a dose, grand total combines
  click($('ilop-add-dose'));
  ok(cards().length === 2, 'second dose added');
  fillDose(1, [{ t: '09:28', rate: 2 }, { t: '10:05', rate: 4 }, { t: '10:40', rate: 6 }, { t: '11:17', rate: 8 }, { t: '11:59', rate: 10 }], '15:27');
  ok(text(cards()[1].querySelector('.ilop-dose-total-val')) === '47.53', 'dose 2 total shows 47.53');
  ok(grand() === '88.07', 'grand total shows 88.07 (2 doses)');

  // 5) Remove-row keeps things consistent, then restore
  const before = rowsOf(cards()[1]).length;
  click(findBtn(rowsOf(cards()[1])[0].querySelector('.ilop-c-rm') || cards()[1], '×') || rowsOf(cards()[1])[0].querySelector('.ilop-rowrm'));
  ok(rowsOf(cards()[1]).length === before - 1, 'remove-row drops one row');

  // 6) Minutes-between helper
  const minRow = doc.querySelector('.ilop-minrow');
  const mins = [...minRow.querySelectorAll('input')];
  setVal(mins[0], '14:58'); setVal(mins[1], '20:57');
  ok(/= 359 min/.test(text(doc.querySelector('.ilop-minresult'))), 'minutes helper: 14:58 -> 20:57 = 359 min');
  setVal(mins[0], '23:30'); setVal(mins[1], '00:15');
  const midTxt = text(doc.querySelector('.ilop-minresult'));
  ok(/= 45 min/.test(midTxt) && /next day/.test(midTxt), 'minutes helper midnight: 45 min + "next day"');

  // reset dose 2 back to the full sample so the saved log is the known 88.07
  fillDose(1, [{ t: '09:28', rate: 2 }, { t: '10:05', rate: 4 }, { t: '10:40', rate: 6 }, { t: '11:17', rate: 8 }, { t: '11:59', rate: 10 }], '15:27');
  ok(grand() === '88.07', 'grand total restored to 88.07 before saving');

  // 7) Save to log -> localStorage + badge
  click(findBtn($('ilop-actionbar'), 'Save to log'));
  const logs1 = JSON.parse(w.localStorage.getItem('ilop_logs') || '[]');
  ok(logs1.length === 1, 'one log persisted to localStorage');
  ok(logs1[0].grandTotal.toFixed(2) === '88.07', 'saved log grandTotal = 88.07');
  ok(text($('ilop-logs-count')) === '1', 'logs count badge shows 1');

  // 8) Logs view rendering + detailed steps
  click($('ilop-v-logs'));
  ok(!$('ilop-logs-view').hidden && $('ilop-calc-view').hidden, 'logs view shown, calculator hidden');
  ok($('ilop-actionbar').hidden, 'calculator action bar hidden in logs view');
  ok($('ilop-livetotal').hidden, 'grand-total pill hidden in logs view');
  let logCards = [...doc.querySelectorAll('#ilop-logs-list .ilop-log')];
  ok(logCards.length === 1, 'one log entry rendered');
  ok(text(logCards[0].querySelector('.ilop-log-total-val')) === '88.07', 'log entry shows 88.07');
  const pre = logCards[0].querySelector('.ilop-steps').textContent;
  ok(/GRAND TOTAL: 88\.07 mcg/.test(pre), 'log detail shows grand total');
  ok(/Dose 2 — total 47\.53 mcg/.test(pre), 'log detail shows dose 2 breakdown');
  ok(/16:48 → 20:57/.test(pre), 'log detail shows an interval');

  // 9) Delete with two-step confirm — cancel path then confirm path
  click(findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Delete'));
  ok(JSON.parse(w.localStorage.getItem('ilop_logs')).length === 1, 'delete NOT applied before confirmation');
  ok(/Delete this log\?/.test(text(doc.querySelector('#ilop-logs-list .ilop-log'))) && !!findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Yes, delete'), 'confirm prompt + "Yes, delete" shown');
  click(findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Cancel'));
  ok(!!findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Delete'), 'Cancel restores the Delete button (entry kept)');
  click(findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Delete'));
  click(findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Yes, delete'));
  ok((JSON.parse(w.localStorage.getItem('ilop_logs') || '[]')).length === 0, 'log removed from storage after confirm');
  ok(!!doc.querySelector('.ilop-logs-empty'), 'empty state shown after deletion');
  ok(text($('ilop-logs-count')) === '', 'logs count badge cleared');

  // 10) Copy a saved log to the clipboard (per-entry Copy button). Re-save the
  //     current 88.07 calc, open Logs, and copy it.
  click($('ilop-v-calc'));
  click(findBtn($('ilop-actionbar'), 'Save to log'));
  click($('ilop-v-logs'));
  let clip = null;
  try { Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: t => { clip = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {}
  click(findBtn(doc.querySelector('#ilop-logs-list .ilop-log'), 'Copy'));
  await flush();
  ok(clip && /GRAND TOTAL: 88\.07 mcg/.test(clip) && /Dose 1 — total 40\.53 mcg/.test(clip), 'per-log Copy placed the full breakdown on the clipboard');

  // 10b) USE IN CHART AUDIT: writes the per-dose BREAKDOWN string into the Chart
  //      Audit's free-text iloprost field (the calculator feeds the main form via
  //      the FBMAIN bridge). Make the field visible first (admin = Yes) so the
  //      injected value is reflected in the DOM.
  const setRadioMain = (varname, code) => { const i = [...doc.querySelectorAll(`#app [data-var="${varname}"] input`)].find(x => x.value === String(code)); if (i) { i.checked = true; i.dispatchEvent(new w.Event('change', { bubbles: true })); } };
  setRadioMain('illoprost_administration', '1');
  click($('ilop-v-calc'));
  const useDoseBtn = [...$('ilop-actionbar').querySelectorAll('button')].find(b => /Use dose in Chart Audit/.test(b.textContent));
  ok(useDoseBtn, '"Use dose in Chart Audit" button present');
  click(useDoseBtn);
  const idField = doc.querySelector('#app [data-var="iloprost_dose"] textarea');
  ok(idField, 'Chart Audit iloprost_dose textarea exists');
  if (idField) {
    ok(/Dose 1: 40\.53 mcg/.test(idField.value), 'breakdown lists "Dose 1: 40.53 mcg" (got: ' + JSON.stringify(idField.value) + ')');
    ok(/Dose 2: 47\.53 mcg/.test(idField.value), 'breakdown lists "Dose 2: 47.53 mcg"');
    ok(/Total: 88\.07 mcg/.test(idField.value), 'breakdown ends with "Total: 88.07 mcg"');
  }

  // 10c) SINGLE-DOSE CAP: a dose computing over 50 mcg shows 50.00 + a cap note.
  click(findBtn($('ilop-actionbar'), 'Clear calculator'));
  fillDose(0, [{ t: '08:00', rate: 10 }], '14:00');   // 10 mcg/hr × 6h = 60 mcg raw -> capped 50
  const capCard = cards()[0];
  ok(text(capCard.querySelector('.ilop-dose-total-val')) === '50.00', 'dose total capped at 50.00 (raw 60)');
  ok(/capped at 50/.test(text(capCard.querySelector('.ilop-dose-cap')) || ''), 'shows the "capped at 50 mcg" note');
  ok(grand() === '50.00', 'grand total reflects the per-dose cap (50.00)');

  // 11) Clear calculator (confirm stubbed true)
  click(findBtn($('ilop-actionbar'), 'Clear calculator'));
  ok(cards().length === 1 && rowsOf(cards()[0]).length === 3, 'Clear calculator resets to 1 dose / 3 rows');
  ok(grand() === '0.00', 'grand total back to 0.00 after clear');

  // 12) No dose cap — the user can have 7+ doses
  for (let i = 0; i < 7; i++) click($('ilop-add-dose'));
  ok(cards().length === 8, 'can add many doses (8) — no cap');
  ok(!$('ilop-add-dose').disabled, 'add-dose button never disabled');

  // 13) How to use tab: animated demo + written guide + worked example; returns to calc
  click($('ilop-v-howto'));
  ok(!$('ilop-howto-view').hidden && $('ilop-calc-view').hidden && $('ilop-actionbar').hidden, 'How-to view shown; calc + actions hidden');
  ok(!!doc.querySelector('.ilop-demo') && doc.querySelectorAll('.ilop-demo-dot').length >= 5, 'animated demo present with step dots');
  ok(doc.querySelectorAll('.ilop-guide li').length >= 6, 'written step-by-step guide present');
  ok(!!$('ilop-demo-cap') && text($('ilop-demo-cap')).length > 0, 'demo caption is populated');
  const ex = [...doc.querySelectorAll('#ilop-howto-view .ilop-steps')].map(p => p.textContent).join('\n');
  ok(/GRAND TOTAL: 9\.00 mcg/.test(ex), 'worked example shows the 9.00 mcg total');
  click(findBtn($('ilop-howto-view'), 'Open the calculator →'));
  ok(!$('ilop-calc-view').hidden && $('ilop-howto-view').hidden, '"Open the calculator" returns to the calculator');

  // 14) No regression: Hennepin + Frostbite still build via the N-way switcher
  click($('sw-hhr'));
  ok(!$('app-hhr').hidden && $('app').hidden && $('app-ilop').hidden, 'switching to Hennepin shows only Hennepin');
  ok(!!$('app-hhr').querySelector('.hhr-total-val'), 'Hennepin calculator still builds (no regression)');
  click($('sw-frostbite'));
  ok(!$('app').hidden && $('app-hhr').hidden && $('app-ilop').hidden, 'switching back to Frostbite works');
  ok(doc.querySelectorAll('#app .field').length > 0, 'Frostbite chart-audit form still renders fields');

  console.log(`\nIloprost UI test — ${passes} passed, ${fails.length} failed`);
  fails.forEach(f => console.log('  ✗ ' + f));
  console.log(fails.length ? '\nFAIL' : '\nPASS: the iloprost calculator + logs work end-to-end through the real page.');
  process.exit(fails.length ? 1 : 0);
})();
