/*
 * Deterministic UI/integration tests (jsdom) for Haddeya's iloprost + form updates:
 *   - iloprost is mcg-only (label says mcg, no mg, no ×1000)
 *   - saved forms have NO server-side expiry (Pages Function sets no expirationTtl)
 *   - 24-hour time mask: typing 2200 -> 22:00 (not 02:20); invalid flagged on blur
 *   - rate input: capped at 10 (UI max + calc note), wheel/trackpad never mutates it
 *   - per-dose vs total stay in sync after removing a dose (no stale total)
 *   - per-tab scroll position is preserved across the top-level form switch
 *   - required fields block "Open REDCap" (weight required); comments stay optional
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
  w.confirm = () => true;
  let captured = null;
  w.open = () => ({ focus() {} });
  w.HTMLFormElement.prototype.submit = function () { captured = this; };
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  ['config.js', 'datemask.js', 'dictionary.js', 'dict_hhr.js', 'branch.js', 'payload.js', 'hhr_calc.js', 'hhr_maps.js', 'hhr.js', 'ilop.js', 'cryptosave.js', 'app.js'].forEach(f => w.eval(read(f)));
  w.CONFIG.requirePassphrase = false;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, doc: w.document, getCaptured: () => captured };
}
const click = (w, n) => n && n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const setVal = (w, input, v) => { input.value = v; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
function typeInto(w, input, str) {
  for (let i = 0; i < str.length; i++) {
    const s = (input.selectionStart == null) ? input.value.length : input.selectionStart;
    input.value = input.value.slice(0, s) + str[i] + input.value.slice(s);
    try { input.setSelectionRange(s + 1, s + 1); } catch (_) {}
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
}

// ---------- 1) iloprost mcg-only ----------
(function () {
  const { w } = makePage();
  const f = w.DICT.fields.filter(x => x.var === 'iloprost_dose')[0];
  ok(f && /\(mcg\)/.test(f.label) && !/\bmg\b/.test(f.label.replace('mcg', '')), 'iloprost_dose label says (mcg), not (mg): ' + (f && f.label));
  const ilopSrc = read('ilop.js');
  ok(!/\*\s*1000|\/\s*1000/.test(ilopSrc), 'ilop.js has no ×1000 or ÷1000 mg<->mcg conversion');
  ok(/mcg\/hr/.test(ilopSrc) && !/\bmg\/hr\b/.test(ilopSrc), 'ilop.js rates are mcg/hr (never mg/hr)');
  // Imported "25"/"50" are treated as mcg as-is (no scaling) by the calc.
  const C = w.ILOP_CALC;
  ok(C.computeDose({ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '13:00' }).total === 50, 'a dose computes 50 (mcg) with no unit scaling');
})();

// ---------- 2) saved forms: no expiry ----------
(function () {
  const fn = fs.readFileSync(path.join(ROOT, 'functions', 'api', 'save.js'), 'utf8');
  ok(!/expirationTtl/.test(fn), 'save Function sets NO expirationTtl (saves never auto-expire)');
  ok(!/TTL_SECONDS/.test(fn), 'no TTL constant remains');
})();

// ---------- 3) 24-hour time mask ----------
(function () {
  const { w, doc } = makePage();
  click(w, doc.getElementById('sw-ilop'));
  const timeInput = () => doc.querySelector('#app-ilop .ilop-dose .ilop-rows .ilop-row:not(.ilop-row-head) .ilop-c-time input');
  const t = timeInput();
  ok(t && t.type === 'text', 'dose time input is a typed text box (not native type=time)');
  t.value = ''; try { t.setSelectionRange(0, 0); } catch (_) {}
  typeInto(w, t, '2200');
  ok(t.value === '22:00', 'typing 2200 -> 22:00 (NOT 02:20). got ' + t.value);
  t.value = ''; typeInto(w, t, '1700'); ok(t.value === '17:00', '1700 -> 17:00');
  const t2 = timeInput(); // re-query (rows may have grown)
  t2.value = ''; typeInto(w, t2, '1200'); ok(t2.value === '12:00', '1200 -> 12:00');
  t2.value = ''; typeInto(w, t2, '22'); ok(t2.value === '22', 'partial "22" is not destructively reformatted');
  // invalid value flagged on blur
  const t3 = timeInput(); t3.value = ''; typeInto(w, t3, '2460'); t3.dispatchEvent(new w.Event('blur', { bubbles: true }));
  ok(t3.classList.contains('invalid'), '2460 (24:60) is flagged invalid on blur');
  const t4 = timeInput(); t4.value = ''; typeInto(w, t4, '2200'); t4.dispatchEvent(new w.Event('blur', { bubbles: true }));
  ok(!t4.classList.contains('invalid'), '22:00 is valid (not flagged)');
  // a natural 3-digit time pads on blur instead of being dropped
  const t5 = timeInput(); t5.value = ''; typeInto(w, t5, '930'); t5.dispatchEvent(new w.Event('blur', { bubbles: true }));
  ok(t5.value === '09:30', 'a 3-digit time (930) pads to 09:30 on blur, not dropped. got ' + t5.value);
  ok(!t5.classList.contains('invalid'), 'the padded 09:30 is valid');
})();

// ---------- 4) rate cap (10) + wheel guard ----------
(function () {
  const { w, doc } = makePage();
  click(w, doc.getElementById('sw-ilop'));
  const row = () => doc.querySelector('#app-ilop .ilop-dose .ilop-rows .ilop-row:not(.ilop-row-head)');
  const rateInput = doc.querySelector('#app-ilop .ilop-c-rate input');
  ok(rateInput && rateInput.getAttribute('max') === '10', 'rate input has max=10 in the UI');
  // enter a full dose at rate 15 -> calc clamps to 10 and flags it
  setVal(w, row().querySelector('.ilop-c-time input'), '08:00');
  setVal(w, row().querySelector('.ilop-c-rate input'), '15');
  setVal(w, doc.querySelector('#app-ilop .ilop-stoprow input'), '09:00');
  const calcText = row().querySelector('.ilop-c-calc').textContent;
  ok(/rate capped at 10/.test(calcText), 'a rate > 10 shows "(rate capped at 10)" in the row math');
  ok(/= 10\.00 mcg/.test(calcText), 'the row computes with rate 10 (60 min × 10/60 = 10.00 mcg), never 15. got ' + calcText);
  ok(doc.querySelector('#app-ilop .ilop-dose .ilop-dose-total-val').textContent === '10.00', 'dose total uses the capped rate (10.00 mcg)');
  // wheel/trackpad on the focused rate must NOT change it
  const rt = row().querySelector('.ilop-c-rate input');
  rt.value = '6'; rt.dispatchEvent(new w.Event('input', { bubbles: true }));
  try { rt.focus(); } catch (e) {}
  const wheel = (typeof w.WheelEvent === 'function') ? new w.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    : Object.assign(new w.Event('wheel', { bubbles: true, cancelable: true }), { deltaY: 120 });
  rt.dispatchEvent(wheel);
  ok(wheel.defaultPrevented, 'wheel on the focused rate input is preventDefault-ed (no increment)');
  ok(rt.value === '6', 'rate value unchanged after a wheel/scroll (still 6)');
  // a negative rate floors to 0 (never a negative dose)
  setVal(w, row().querySelector('.ilop-c-rate input'), '-5');
  ok(doc.querySelector('#app-ilop .ilop-dose .ilop-dose-total-val').textContent === '0.00', 'a negative rate yields a 0.00 dose (floored, not negative)');
})();

// ---------- 5) per-dose vs total sync after removing a dose ----------
(function () {
  const { w, doc } = makePage();
  click(w, doc.getElementById('sw-ilop'));
  const cards = () => [...doc.querySelectorAll('#app-ilop .ilop-dose')];
  const firstRow = card => card.querySelector('.ilop-rows .ilop-row:not(.ilop-row-head)');
  const grand = () => doc.getElementById('ilop-livetotal').querySelector('.ilop-livetotal-val').textContent;
  // Dose 1: 10 mcg/hr 08:00->09:00 = 10 mcg
  setVal(w, firstRow(cards()[0]).querySelector('.ilop-c-time input'), '08:00');
  setVal(w, firstRow(cards()[0]).querySelector('.ilop-c-rate input'), '10');
  setVal(w, cards()[0].querySelector('.ilop-stoprow input'), '09:00');
  // add Dose 2: 10 mcg/hr 08:00->10:00 = 20 mcg
  click(w, doc.getElementById('ilop-add-dose'));
  setVal(w, firstRow(cards()[1]).querySelector('.ilop-c-time input'), '08:00');
  setVal(w, firstRow(cards()[1]).querySelector('.ilop-c-rate input'), '10');
  setVal(w, cards()[1].querySelector('.ilop-stoprow input'), '10:00');
  ok(grand() === '30.00', 'grand total = sum of both doses (10 + 20 = 30.00)');
  // remove Dose 1 -> total must drop to just Dose 2 (no stale 30)
  const removeBtn = [...cards()[0].querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove');
  ok(removeBtn, 'Dose 1 has a Remove button');
  click(w, removeBtn);
  ok(cards().length === 1, 'one dose remains after removing Dose 1');
  ok(doc.querySelector('#app-ilop .ilop-dose .ilop-dose-total-val').textContent === '20.00', 'remaining dose still shows its own 20.00 (per-dose value moved, not just total)');
  ok(grand() === '20.00', 'grand total recalculated from the remaining dose (20.00), no stale 30 carried over');
})();

// ---------- 6) per-tab scroll preservation ----------
(function () {
  const { w, doc } = makePage();
  let y = 0; const calls = [];
  try { Object.defineProperty(w, 'scrollY', { configurable: true, get: () => y }); } catch (e) {}
  w.scrollTo = function (a, b) { y = (a && typeof a === 'object') ? (a.top || 0) : (b || 0); calls.push(y); };
  click(w, doc.getElementById('sw-ilop'));        // go to iloprost
  y = 320;                                         // user scrolls the iloprost tab down
  click(w, doc.getElementById('sw-frostbite'));    // leave to frostbite (saves ilop=320, restores chart)
  ok(y === 0, 'switching to frostbite restored its (top) position');
  y = 140;                                         // user scrolls frostbite down
  click(w, doc.getElementById('sw-ilop'));         // back to iloprost -> should restore 320
  ok(y === 320, 'returning to iloprost restored the previous scroll (320), not the top');
  click(w, doc.getElementById('sw-frostbite'));    // back to frostbite -> should restore 140
  ok(y === 140, 'returning to frostbite restored its previous scroll (140)');
})();

// ---------- 7) required fields mirror the ORIGINAL form exactly (audit) ----------
(function () {
  const { w, doc, getCaptured } = makePage();
  // AUDIT: every field's required flag in the running app must equal the original form's
  // (dictionary.json is generated straight from the survey's req='1' marker). No override.
  const orig = JSON.parse(read('dictionary.json'));
  const origReq = {}; orig.fields.forEach(f => { origReq[f.var] = !!f.required; });
  const mismatches = w.DICT.fields.filter(f => !!f.required !== origReq[f.var]).map(f => f.var);
  ok(mismatches.length === 0, 'EVERY field required flag matches the original form (mismatches: ' + (mismatches.slice(0, 10).join(', ') || 'none') + ')');
  const req = v => (w.DICT.fields.filter(f => f.var === v)[0] || {}).required;
  ok(req('admitting_diagnosis') === true, 'a comment box that is REQUIRED in the original is required in the app (admitting_diagnosis)');
  ok(req('study_number') === true, 'a field required in the original stays required (study_number)');
  ok(req('weight') === false, 'a field NOT required in the original is NOT required in the app (weight)');
  ok(req('iloprost_dose') === false && req('hennepin_score') === false, 'calculated textareas stay optional, matching the original');
  // Required validation still blocks "Open REDCap" when an originally-required field is missing.
  doc.getElementById('btn-open').click();
  ok(getCaptured() == null, 'Open REDCap does NOT submit while an original-required field is missing');
  ok(!doc.getElementById('review').hidden, 'the missing-required review panel is shown instead');
  ok([...doc.querySelectorAll('#review-list .review-q')].some(n => n.textContent === 'Anonymous Patient Identifier'),
    'a required field (study_number) is listed as missing');
})();

console.log(`\nForm-updates UI test — ${passes} passed, ${fails.length} failed`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log(fails.length ? '\nFAIL' : '\nPASS: iloprost mcg/time/rate/cap/sync, scroll preservation, no-expiry, and required-field blocking all work.');
process.exit(fails.length ? 1 : 0);
