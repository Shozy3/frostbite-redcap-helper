/*
 * Deterministic UI test (jsdom) for the Hennepin calculator's clickable diagrams.
 * Loads the real page + scripts, builds the HHR tab, and exercises:
 *   - polygon counts per region match the parsed geometry
 *   - region figures are gated by the "Frostbite Injury" selector
 *   - clicking a polygon flows code -> state -> REDCap equation -> per-digit display
 *   - polygon <-> list-view sync, Clear, and the open-in-REDCap payload encoding
 *   - the other form (frostbite chart audit) still builds (no regression)
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');
const EQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'hhr_calc.json'), 'utf8')).jsCode;

let fails = [], passes = 0;
const ok = (c, m) => { if (c) passes++; else fails.push(m); };

function makePage() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window; w.scrollTo = () => {}; w.confirm = () => true;
  w.Element.prototype.scrollIntoView = function () {}; // jsdom has no layout; setField scrolls the flashed field
  let captured = null;
  w.open = () => ({ focus() {} });
  w.HTMLFormElement.prototype.submit = function () { captured = this; };
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  w.eval(read('config.js')); w.CONFIG.requirePassphrase = false;
  w.eval(read('datemask.js'));
  w.eval(read('dictionary.js')); w.eval(read('dict_hhr.js')); w.eval(read('branch.js'));
  w.eval(read('payload.js')); w.eval(read('hhr_calc.js')); w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js')); w.eval(read('ilop.js')); w.eval(read('cryptosave.js')); w.eval(read('app.js'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  w.HHR.build();
  return { w, doc: w.document, getCaptured: () => captured };
}

const { w, doc, getCaptured } = makePage();
const MAPS = w.HHR_MAPS, CALC = w.HHR_CALC, DICT = w.DICT_HHR;
const fig = key => doc.querySelector('.hhr-dx[data-region="' + key + '"]');
const polys = key => [...fig(key).querySelectorAll('polygon.hhr-seg')];
const click = node => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
function injCheck(code) {
  const i = [...doc.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(code));
  i.checked = true; i.dispatchEvent(new w.Event('change', { bubbles: true }));
}
// independent score from a {field:Set(optionCode)} selection, via the same shim
function expect(checkedByField) {
  const el = {};
  DICT.fields.forEach(f => { if (f.type !== 'checkbox' || !f.options) return; const s = checkedByField[f.var];
    f.options.forEach(o => { el['__chk__' + f.var + '_RC_' + o.code] = { value: (s && s.has(o.code)) ? o.code : '' }; }); });
  const p = new Proxy({}, { get: (t, k) => el[k] || { value: '' } });
  const d = { forms: { form: { elements: p } }, form: p };
  return v => CALC[v](d);
}
const regionNums = key => [...fig(key) ? doc.querySelectorAll('.hhr-region[data-region="' + key + '"] .hhr-digit-num') : []].map(n => n.textContent);
const regionScore = key => doc.querySelector('.hhr-region[data-region="' + key + '"] .hhr-region-score').textContent;
const totalText = () => doc.querySelector('.hhr-total-val').textContent;

// 1) geometry: polygon count per region matches parsed areas; total == 273
let totPoly = 0;
['lh', 'rh', 'lf', 'rf', 'proximal'].forEach(k => { const n = polys(k).length; totPoly += n;
  ok(n === MAPS[k].areas.length, `${k}: ${n} polygons == ${MAPS[k].areas.length} areas`); });
ok(totPoly === 273, `total polygons == 273 (got ${totPoly})`);

// 2) region gating: all figures hidden until selected; empty hint visible
ok(['lh', 'rh', 'lf', 'rf', 'proximal'].every(k => fig(k).hidden), 'all diagrams hidden before any region selected');
ok(!doc.getElementById('hhr-dx-empty').hidden, 'empty hint visible before selection');
injCheck(1); // Left hand
ok(!fig('lh').hidden, 'left-hand diagram shown after selecting "Left hand"');
ok(['rh', 'lf', 'rf', 'proximal'].every(k => fig(k).hidden), 'other diagrams still hidden');
ok(doc.getElementById('hhr-dx-empty').hidden, 'empty hint hidden after selection');

// 3) CLICK PIPELINE + ISOLATION: click only digit-2 polygons -> only digit2 scores
const d2codes = [...new Set((EQ.lh_digit2_score.match(/ule_p_RC_(\d+)/g) || []).map(s => s.match(/_RC_(\d+)/)[1]))];
polys('lh').filter(p => d2codes.includes(p.dataset.code)).forEach(click);
const expA = expect({ ule_p: new Set(d2codes) });
const numsA = regionNums('lh'); // [d1,d2,d3,d4,d5,metacarpal]
ok(Number(numsA[1]) === expA('lh_digit2_score') && expA('lh_digit2_score') > 0, `digit-2 display ${numsA[1]} == CALC ${expA('lh_digit2_score')} (>0)`);
ok(Number(numsA[0]) === 0 && Number(numsA[2]) === 0 && Number(numsA[5]) === 0, 'other left-hand digits/metacarpal == 0 (isolation)');
ok(totalText() === String(expA('hennepin_score_total')), `total ${totalText()} == CALC ${expA('hennepin_score_total')}`);

// 4) SYNC: a clicked polygon reflects in aria + the list-view checkbox
const oneCode = d2codes[0];
const onePoly = polys('lh').find(p => p.dataset.code === oneCode);
ok(onePoly.classList.contains('on') && onePoly.getAttribute('aria-checked') === 'true', 'clicked polygon shows selected (class + aria)');
const listInput = [...fig('lh').querySelectorAll('.hhr-dx-list input')].find(i => i.value === oneCode);
ok(listInput && listInput.checked, 'list-view checkbox synced to polygon selection');

// 4c) DIGIT LABELS: rows are labelled plainly "Digit 1".."Digit 5" (no bracketed
//     anatomical names), and the metacarpal row keeps its label.
const lhNames = [...doc.querySelectorAll('.hhr-region[data-region="lh"] .hhr-digit-name')].map(n => n.textContent);
ok(lhNames.slice(0, 5).join('|') === 'Digit 1|Digit 2|Digit 3|Digit 4|Digit 5', 'left-hand rows labelled Digit 1..5 (got ' + lhNames.slice(0, 5).join(',') + ')');
ok(!lhNames.some(n => /\(/.test(n)), 'no bracketed anatomical names remain on the digit rows');

// 5) USE-IN-CHART-AUDIT: the calculator feeds the main form via the FBMAIN bridge
//    (no standalone submit). "Use score" writes the FULL per-section breakdown into
//    the Chart Audit's free-text Hennepin score field.
const totalForUse = totalText();
const useBtn = doc.getElementById('hhr-use');
ok(useBtn, '"Use score in Chart Audit" button present');
if (useBtn) useBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const hs = doc.querySelector('#app [data-var="hennepin_score"] textarea');
ok(hs, 'Chart Audit hennepin_score textarea exists');
if (hs) {
  ok(/Hennepin Total Body Perfusion Score:/.test(hs.value), 'breakdown includes the total header line');
  ok(hs.value.indexOf(totalForUse) >= 0, 'breakdown includes the grand total value ' + totalForUse);
  ok(/Left Hand \(total /.test(hs.value), 'breakdown includes the Left Hand limb total');
  ok(/Digit 2: /.test(hs.value), 'breakdown lists each digit as "Digit N: value" (with a colon)');
  ok(/Digit 1:[^,]*,\s*Digit 2:/.test(hs.value), 'digits are separated by commas (e.g. "Digit 1: 0, Digit 2: 0.5")');
}
// 5b) "Use score" ALSO ticks the affected limbs in the Chart Audit (structured write-back,
//     so the limbs aren't re-entered by hand). Left hand is selected here -> Left upper limb (2).
{
  const lf2 = doc.querySelector('#app [data-var="limb_frostbite"] input[value="2"]');
  ok(lf2 && lf2.checked, '"Use score" ticked "Left upper limb" under "Limbs affected by frostbite"');
}

// 6) SELECT-ALL left hand (one click per unique code) -> every digit matches CALC
Object.values(w).length; // noop
const allCodes = MAPS.lh.areas.map(a => a.key);
const uniq = [...new Set(allCodes)];
// reset first
doc.querySelector('.actionbar .btn-ghost').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok(totalText() === '0', `Clear all -> total 0 (got ${totalText()})`);
injCheck(1);
uniq.forEach(c => { const p = polys('lh').find(x => x.dataset.code === c); if (p && !p.classList.contains('on')) click(p); });
const expB = expect({ ule_p: new Set(uniq) });
const numsB = regionNums('lh');
const digitsOK = [0, 1, 2, 3, 4].every(i => Number(numsB[i]) === expB('lh_digit' + (i + 1) + '_score'));
ok(digitsOK, `all 5 left-hand digit scores match CALC (display ${numsB.slice(0,5).join(',')})`);
ok(Number(numsB[5]) === expB('lmetacarpal_score'), `metacarpal display ${numsB[5]} == CALC ${expB('lmetacarpal_score')}`);
ok(regionScore('lh') === String(expB('lh_score')), `left-hand score ${regionScore('lh')} == CALC ${expB('lh_score')}`);

// 7) NO REGRESSION: the frostbite chart-audit form still built its fields
ok(doc.querySelectorAll('#app .field').length > 0, 'frostbite chart-audit form still renders fields');
ok(!doc.getElementById('app').hidden || !doc.getElementById('app-hhr').hidden, 'an app view is visible');

// 8) GATING per the original branch logic (fresh page): each limb reveals on its own
//    injury code OR on "Proximal extremity" (5); selecting proximal reveals all five.
(function () {
  const { w: w2, doc: doc2 } = makePage();
  const fig2 = k => doc2.querySelector(`.hhr-dx[data-region="${k}"]`);
  const setInj = (c, on) => { const i = [...doc2.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(c)); if (i) { i.checked = on; i.dispatchEvent(new w2.Event('change', { bubbles: true })); } };
  setInj('1', true);
  ok(!fig2('lh').hidden && ['rh', 'lf', 'rf', 'proximal'].every(k => fig2(k).hidden), 'selecting only Left hand reveals only the left-hand diagram');
  setInj('1', false); setInj('5', true);
  ok(['lh', 'rh', 'lf', 'rf', 'proximal'].every(k => !fig2(k).hidden), 'selecting Proximal extremity reveals all five diagrams (own-or-5 branch, matches original)');
})();

// 9) DRAG-PAINT: press one section and drag across others to select them in one
//    stroke; dragging again over selected sections erases them. (jsdom has no
//    layout, so elementFromPoint is mocked to walk the polygon sequence.)
(function () {
  const { w: w3, doc: doc3 } = makePage();
  const setI = c => { const i = [...doc3.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(c)); i.checked = true; i.dispatchEvent(new w3.Event('change', { bubbles: true })); };
  setI('1'); // reveal left hand
  const ov = doc3.querySelector('.hhr-dx[data-region="lh"] svg.hhr-dx-svg');
  const seq = [...ov.querySelectorAll('polygon.hhr-seg')].slice(0, 6);
  let idx = 0;
  doc3.elementFromPoint = () => seq[Math.min(idx, seq.length - 1)];
  const ev = (t, props) => Object.assign(new w3.Event(t, { bubbles: true }), { button: 0, clientX: 1, clientY: 1 }, props || {});
  function stroke() {
    seq[0].dispatchEvent(ev('pointerdown'));
    for (idx = 0; idx < seq.length; idx++) ov.dispatchEvent(ev('pointermove'));
    w3.dispatchEvent(ev('pointerup'));
  }
  stroke();
  ok(seq.every(p => p.classList.contains('on')), `drag selected all ${seq.length} sections in one stroke`);
  ok([...doc3.querySelectorAll('.hhr-dx[data-region="lh"] .hhr-dx-list input:checked')].length >= seq.length, 'drag selection mirrored in the list-view checkboxes');
  ok(Number(doc3.querySelector('.hhr-total-val').textContent) > 0, 'drag selection produces a live score');
  stroke(); // same stroke again -> erase
  ok(seq.every(p => !p.classList.contains('on')), 'dragging again over selected sections erased them');
})();

// helper: the option codes that belong to a given per-digit score equation
const codesFor = sv => [...new Set((EQ[sv].match(/ule_p_RC_(\d+)/g) || []).map(s => s.match(/_RC_(\d+)/)[1]))];

// 10) SUB-TABS + AMPUTATION LAYER: the amputation tab mirrors the frostbite map
//     (same diagrams/sections) in a parallel layer with its OWN Hennepin score;
//     selecting amputation NEVER changes the frostbite score (hard invariant); Send
//     writes the digit summary + salvage into the Chart Audit amputation box.
(function () {
  const { w: wa, doc: da } = makePage();
  const figA = (k, layer) => da.querySelector(`.hhr-dx[data-region="${k}"][data-layer="${layer}"]`);
  const polysA = (k, layer) => [...figA(k, layer).querySelectorAll('polygon.hhr-seg')];
  const clickA = n => n.dispatchEvent(new wa.MouseEvent('click', { bubbles: true }));
  const setInjA = c => { const i = [...da.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(c)); i.checked = true; i.dispatchEvent(new wa.Event('change', { bubbles: true })); };

  ok(da.getElementById('hhr-v-score') && da.getElementById('hhr-v-amp') && da.getElementById('hhr-v-compare'), 'three Hennepin sub-tabs present (Frostbite Score | Amputation | Compare)');
  ok(!da.getElementById('hhr-view-score').hidden && da.getElementById('hhr-view-amp').hidden && da.getElementById('hhr-view-compare').hidden, 'Frostbite Score view shown by default; Amputation + Compare hidden');

  setInjA(1); // Left hand -> reveals the lh diagram on BOTH layers (mirror)
  ok(!figA('lh', 'perf').hidden, 'perfusion left-hand diagram revealed by the injury selector');
  ok(!figA('lh', 'amp').hidden, 'amputation left-hand diagram revealed by the SAME selector (mirror)');

  // select frostbite digits 2-5; capture the frostbite total
  const perfCodes = [].concat(codesFor('lh_digit2_score'), codesFor('lh_digit3_score'), codesFor('lh_digit4_score'), codesFor('lh_digit5_score'));
  polysA('lh', 'perf').filter(p => perfCodes.includes(p.dataset.code)).forEach(clickA);
  const frostTotal = da.querySelector('#hhr-view-score .hhr-total-val').textContent;
  ok(Number(frostTotal) > 0, `frostbite score > 0 after selecting perfusion sections (${frostTotal})`);

  // switch to the Amputation tab and mark digits 2,3 as amputated
  da.getElementById('hhr-v-amp').dispatchEvent(new wa.MouseEvent('click', { bubbles: true }));
  ok(!da.getElementById('hhr-view-amp').hidden && da.getElementById('hhr-view-score').hidden, 'clicking the Amputation tab shows the amp view and hides the score view');
  const ampCodes = [].concat(codesFor('lh_digit2_score'), codesFor('lh_digit3_score'));
  polysA('lh', 'amp').filter(p => ampCodes.includes(p.dataset.code)).forEach(clickA);
  ok(polysA('lh', 'amp').filter(p => ampCodes.includes(p.dataset.code)).every(p => p.classList.contains('amp-on')), 'amputation sections painted with the amp-on class (vermillion layer, not the blue .on)');
  ok(polysA('lh', 'perf').filter(p => ampCodes.includes(p.dataset.code)).every(p => p.classList.contains('on') && !p.classList.contains('amp-on')), 'the perfusion layer for the same sections is unaffected (independent layers)');

  // HARD INVARIANT: the frostbite score is unchanged by amputation selection
  ok(da.querySelector('#hhr-view-score .hhr-total-val').textContent === frostTotal, 'frostbite score UNCHANGED by amputation selection (invariant)');
  // amputation has its OWN Hennepin score == CALC over the amp selection
  const ampTotal = da.querySelector('.hhr-amp-total-val').textContent;
  const expAmp = expect({ ule_p: new Set(ampCodes) })('hennepin_score_total');
  ok(Number(ampTotal) > 0 && ampTotal === String(expAmp), `amputation has its own Hennepin score == CALC (${ampTotal} == ${expAmp})`);

  // SEND -> structured digit summary + salvage + type into additional_frostbite; gate Yes
  const surg = [...da.querySelectorAll('input[name="hhr_amp_type"]')].find(i => i.value === 'surgical');
  surg.checked = true; surg.dispatchEvent(new wa.Event('change', { bubbles: true }));
  da.getElementById('hhr-amp-send').dispatchEvent(new wa.MouseEvent('click', { bubbles: true }));
  const box = da.querySelector('#app [data-var="additional_frostbite"] textarea');
  ok(box, 'Chart Audit additional_frostbite textarea exists');
  if (box) {
    ok(/Type of amputation: Surgical amputation/.test(box.value), 'amputation box got the type line');
    ok(/Left Hand: D2, D3/.test(box.value), 'amputation box got the structured digit summary (Left Hand: D2, D3)');
    ok(/digit salvage rate \d+%/.test(box.value), 'amputation box got the literature digit salvage rate');
  }
  const limbYes = da.querySelector('#app [data-var="limb_amputation"] input[value="1"]');
  ok(limbYes && limbYes.checked, '"Were limbs/digits amputated?" set to Yes by Send');
  // structured write-back: the amputated whole-digit boxes are ticked in the Chart Audit
  const lhAmp2 = da.querySelector('#app [data-var="left_hand_amp"] input[value="2"]');
  const lhAmp3 = da.querySelector('#app [data-var="left_hand_amp"] input[value="3"]');
  ok(lhAmp2 && lhAmp2.checked && lhAmp3 && lhAmp3.checked, 'Send ticked Left hand D2 + D3 in the Chart Audit digit_amputation matrix (no double entry)');
  const rhAmp = da.querySelector('#app [data-var="right_hand_amp"] input:checked');
  ok(!rhAmp, 'untouched limbs (right hand) have no amputation boxes ticked');
})();

// 11) PERSISTENCE: the amputation layer (ampChecked) + type/other survive get/setState,
//     and a legacy blob without ampChecked loads cleanly (backward compatible).
(function () {
  const { w: wp, doc: dp } = makePage();
  const figP = (k, l) => dp.querySelector(`.hhr-dx[data-region="${k}"][data-layer="${l}"]`);
  const setInjP = c => { const i = [...dp.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(c)); i.checked = true; i.dispatchEvent(new wp.Event('change', { bubbles: true })); };
  setInjP(1);
  const ampCodes = codesFor('lh_digit2_score');
  dp.getElementById('hhr-v-amp').dispatchEvent(new wp.MouseEvent('click', { bubbles: true }));
  // mark amputation via the list-view checkboxes (no layout needed in jsdom)
  ampCodes.forEach(c => { const inp = [...figP('lh', 'amp').querySelectorAll('.hhr-dx-list input')].find(i => i.value === c); inp.checked = true; inp.dispatchEvent(new wp.Event('change', { bubbles: true })); });
  const other = [...dp.querySelectorAll('input[name="hhr_amp_type"]')].find(i => i.value === 'other');
  other.checked = true; other.dispatchEvent(new wp.Event('change', { bubbles: true }));
  const oin = dp.getElementById('hhr-amp-other-in'); oin.value = 'autoamputation'; oin.dispatchEvent(new wp.Event('input', { bubbles: true }));

  const saved = wp.HHR.getState();
  ok(saved.ampChecked && saved.ampChecked.ule_p && saved.ampChecked.ule_p.length === ampCodes.length, 'getState captures the amputation layer (ampChecked)');
  ok(saved.amp && saved.amp.type === 'other' && saved.amp.other === 'autoamputation', 'getState captures the amputation type/other text');

  const { w: w4, doc: doc4 } = makePage();
  w4.HHR.setState(saved);
  ok(doc4.getElementById('hhr-amp-other-in').value === 'autoamputation', 'setState restores the "Other" specify text');
  const restored = [...doc4.querySelectorAll('input[name="hhr_amp_type"]')].find(i => i.value === 'other');
  ok(restored && restored.checked, 'setState restores the selected amputation type');
  const onCount = [...doc4.querySelectorAll('.hhr-dx[data-region="lh"][data-layer="amp"] polygon.hhr-seg.amp-on')].length;
  ok(onCount === ampCodes.length, `setState restores the amputation polygons (amp-on round-trip ${onCount}/${ampCodes.length})`);
  ok(w4.HHR.setState({ checked: {} }) === true, 'setState tolerates a legacy blob with no ampChecked (backward compatible)');
})();

// 12) SALVAGE + COMPARE: literature count-based salvage rates and the read-only
//     side-by-side / overlay snapshots in the Compare tab.
(function () {
  const { w: wc, doc: dc } = makePage();
  const figC = (k, l) => dc.querySelector(`.hhr-dx[data-region="${k}"][data-layer="${l}"]`);
  const clickC = n => n.dispatchEvent(new wc.MouseEvent('click', { bubbles: true }));
  const setInjC = c => { const i = [...dc.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(c)); i.checked = true; i.dispatchEvent(new wc.Event('change', { bubbles: true })); };
  setInjC(1);
  // at risk = digits 2,3,4,5 ; amputated = digits 2,3  -> digit salvage (1-2/4)=50%
  const risk = [].concat(codesFor('lh_digit2_score'), codesFor('lh_digit3_score'), codesFor('lh_digit4_score'), codesFor('lh_digit5_score'));
  const lost = [].concat(codesFor('lh_digit2_score'), codesFor('lh_digit3_score'));
  [...figC('lh', 'perf').querySelectorAll('polygon.hhr-seg')].filter(p => risk.includes(p.dataset.code)).forEach(clickC);
  dc.getElementById('hhr-v-amp').dispatchEvent(new wc.MouseEvent('click', { bubbles: true }));
  [...figC('lh', 'amp').querySelectorAll('polygon.hhr-seg')].filter(p => lost.includes(p.dataset.code)).forEach(clickC);

  ok(dc.getElementById('hhr-sv-digit').textContent === '50%', `digit salvage rate (1-2/4) == 50% (got ${dc.getElementById('hhr-sv-digit').textContent})`);
  ok(dc.getElementById('hhr-sv-phx').textContent === '50%', `phalanx salvage rate (1-6/12) == 50% (got ${dc.getElementById('hhr-sv-phx').textContent})`);

  dc.getElementById('hhr-v-compare').dispatchEvent(new wc.MouseEvent('click', { bubbles: true }));
  ok(!dc.getElementById('hhr-view-compare').hidden, 'Compare view shown after clicking the Compare tab');
  ok(dc.querySelectorAll('#hhr-cmp-perf polygon.on').length > 0, 'compare: at-risk (blue) snapshot rendered');
  ok(dc.querySelectorAll('#hhr-cmp-amp polygon.amp-on').length > 0, 'compare: lost (vermillion) snapshot rendered');
  ok(dc.querySelectorAll('#hhr-cmp-overgrid polygon.both').length > 0, 'compare overlay: sections that are BOTH frostbitten and amputated are flagged');
  // compare snapshots are read-only (no selection state change on click)
  const before = dc.getElementById('hhr-sv-digit').textContent;
  const roPoly = dc.querySelector('#hhr-cmp-perf polygon');
  if (roPoly) roPoly.dispatchEvent(new wc.MouseEvent('click', { bubbles: true }));
  ok(dc.getElementById('hhr-sv-digit').textContent === before, 'compare snapshots are read-only (clicking them does not change state)');
})();

// 13) FROSTBITE GRADE PICKER WIDGET: the per-limb Cauchy-grade override button itself —
//     toggle/aria, getState/setState persistence, and "Clear all" resetting it. (Narrowed
//     per the grade-autofill plan: the picker is now an OVERRIDE on top of an automatic,
//     anatomy-derived grade, so the old "Use score only fills a graded limb" assertions
//     below are superseded — full "Use score" -> grade-matrix coverage, auto AND override,
//     now lives in tools/test_grade_autofill_ui.js.)
(function () {
  const { w: wg, doc: dg } = makePage();
  const figG = k => dg.querySelector(`.hhr-dx[data-region="${k}"][data-layer="perf"]`);
  const clickG = n => n.dispatchEvent(new wg.MouseEvent('click', { bubbles: true }));
  const setInjG = c => { const i = [...dg.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(c)); i.checked = true; i.dispatchEvent(new wg.Event('change', { bubbles: true })); };
  setInjG(1); // reveal left hand
  const d2 = codesFor('lh_digit2_score');
  [...figG('lh').querySelectorAll('polygon.hhr-seg')].filter(p => d2.includes(p.dataset.code)).forEach(clickG);

  const g3 = dg.querySelector('.hhr-grade-btn[data-region="lh"][data-grade="3"]');
  ok(g3, 'per-limb Cauchy grade picker present for the left hand');
  g3.dispatchEvent(new wg.MouseEvent('click', { bubbles: true }));
  ok(g3.classList.contains('active') && g3.getAttribute('aria-pressed') === 'true', 'selecting Grade 3 marks the picker active');

  const saved = wg.HHR.getState();
  ok(saved.grades && saved.grades.ule_p === '3', 'getState captures the per-limb Cauchy grade');
  const { w: w5, doc: doc5 } = makePage();
  w5.HHR.setState(saved);
  const rg3 = doc5.querySelector('.hhr-grade-btn[data-region="lh"][data-grade="3"]');
  ok(rg3 && rg3.classList.contains('active'), 'setState restores the selected per-limb grade');
  // resetAll ("Clear all") must clear the per-limb grade too — no stale grade for the next patient
  dg.querySelector('.actionbar .btn-ghost').dispatchEvent(new wg.MouseEvent('click', { bubbles: true }));
  ok(Object.keys(wg.HHR.getState().grades || {}).length === 0, '"Clear all" clears the per-limb Cauchy grades (no stale grade leaks to the next patient)');
  ok(!dg.querySelector('.hhr-grade-btn[data-region="lh"][data-grade="3"]').classList.contains('active'), '"Clear all" deactivates the grade picker buttons');
})();

// 14) REGRESSION (critical): an injected yesno field (limb_amputation) survives refresh()'s
//     re-apply without its option .value being corrupted — toggling No then Yes still works
//     and the digit_amputation matrices reopen (guard for the radio/yesno re-apply bug).
(function () {
  const { w: wr, doc: dr } = makePage();
  wr.FBMAIN.setChoice('limb_amputation', '1');               // as onSendAmp does (marks it injected)
  const radios = () => [...dr.querySelectorAll('#app [data-var="limb_amputation"] input[type=radio]')];
  ok(radios().some(i => i.value === '1') && radios().some(i => i.value === '0'), 'limb_amputation keeps option values [1,0] after setChoice Yes');
  const no = radios().find(i => i.value === '0'); no.checked = true; no.dispatchEvent(new wr.Event('change', { bubbles: true }));
  ok(radios().some(i => i.value === '1'), 'after switching to No, the Yes radio still carries value "1" (not corrupted to "0")');
  const yes = radios().find(i => i.value === '1'); yes.checked = true; yes.dispatchEvent(new wr.Event('change', { bubbles: true }));
  const rha = dr.querySelector('#app [data-var="right_hand_amp"]');
  ok(rha && !rha.hidden, 're-selecting Yes reopens the digit_amputation matrices (right_hand_amp visible)');
})();

// 15) CSS: amputation hover/focus rules are scoped to the class actually applied
//     (.hhr-amp-layer), so amp segments get vermillion (not blue) interactive feedback.
{
  const css = read('styles.css');
  ok(/\.hhr-amp-layer \.hhr-seg:hover/.test(css), 'amp hover rule scoped to .hhr-amp-layer (vermillion feedback reaches the amp diagrams)');
  ok(!/\.amp-layer \.hhr-seg/.test(css), 'no dead bare ".amp-layer .hhr-seg" selector remains');
}

console.log(`\nHHR UI test — ${passes} passed, ${fails.length} failed`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log(fails.length ? '\nFAIL' : '\nPASS: clickable diagrams drive the exact REDCap per-digit scores end-to-end.');
process.exit(fails.length ? 1 : 0);
