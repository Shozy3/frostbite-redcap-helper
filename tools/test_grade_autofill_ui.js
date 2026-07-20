/*
 * Deterministic UI test (jsdom) for the Hennepin "Use score" -> Chart Audit "Frostbite
 * grading" matrix auto-fill (see /Users/sahmed/.claude/plans/replicated-sparking-puffin.md).
 *
 * Cauchy grade is derived PER DIGIT from painted anatomy (topographic classification):
 *   - distal phalanx only (DIP/IP)           -> Grade 2
 *   - any middle/proximal phalanx (PIP/IPIP/MCP) -> Grade 3
 *   - digit's carpal/tarsal ray painted       -> Grade 4 (+ code 6 "wrist or more proximal")
 *   - any bare wrist (LW/RW) / heel (LH/RH) painted -> also code 6 in Grade 4
 * A per-limb manual grade button (2/3/4) OVERRIDES this: ALL of that limb's currently
 * painted digits are routed into the single chosen row instead (ray-aware: a ray-only
 * digit under override still contributes its real digit number + code 6, not just '6').
 * Re-sending is idempotent and self-correcting: each send removes the codes it currently
 * owns from the limb's OTHER two grade rows before (re)adding them to the target row(s),
 * so a digit's classification can move between rows on repaint without leaving a stale
 * duplicate behind. Codes the calculator isn't currently sending (hand-ticked entries, or
 * a limb that went back to nothing painted) are left completely alone.
 *
 * Fixture codes below are read directly off site/hhr_maps.js's parsed <area> labels
 * (lh/rf/lf option-code -> anatomical-label pairs), independently cross-checked against
 * the plan's own fixture tables before being used here — this file is written against
 * the SPEC, not the implementation being edited concurrently in site/hhr.js + site/app.js.
 *
 * Per-file self-containment (repo convention): makePage() below is copied verbatim from
 * tools/test_hhr_ui.js, including its stubs.
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');

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

/* ------------------------------------------------------------- shared helpers */
// field -> { HHR_MAPS region key, Frostbite-Injury option code }. Mirrors hhr.js's own
// REGIONS table; GRADE_PREFIX ("left_hand" etc.) and limb_frostbite codes are written as
// literals at each call site below so every assertion is directly diffable against the
// plan's fixture tables (rather than indirected through a second lookup).
const REGION = {
  ule_p: { key: 'lh', inj: '1' },
  ure_p: { key: 'rh', inj: '2' },
  lle_p: { key: 'lf', inj: '3' },
  lre_p: { key: 'rf', inj: '4' },
  proximal_p: { key: 'proximal', inj: '5' },
};

// Reveal a limb's diagram by ticking its Frostbite-Injury checkbox (mirrors
// tools/test_hhr_ui.js's injCheck pattern exactly: .checked + bubbling change).
function reveal(doc, w, field) {
  const code = REGION[field].inj;
  const i = [...doc.querySelectorAll('[data-var="extremity_perfusion_hfs"] input')].find((x) => x.value === code);
  if (!i) throw new Error('reveal(): no injury-selector checkbox for code ' + code);
  i.checked = true; i.dispatchEvent(new w.Event('change', { bubbles: true }));
}

// Paint a set of section codes on a limb's PERFUSION diagram — one click per UNIQUE code.
// lh's map has a duplicated LW (69) <area>; clicking both would toggle it right back off,
// so codes are deduped and only the FIRST matching polygon per code is ever clicked.
function paint(doc, w, field, codes) {
  const meta = REGION[field];
  const fig = doc.querySelector(`.hhr-dx[data-region="${meta.key}"][data-layer="perf"]`);
  if (!fig) throw new Error('paint(): no perfusion diagram for ' + field + ' (region ' + meta.key + ') -- call reveal() first?');
  const uniq = [...new Set(codes.map(String))];
  uniq.forEach((code) => {
    const p = [...fig.querySelectorAll('polygon.hhr-seg')].find((x) => x.dataset.code === code);
    if (!p) throw new Error('paint(): no polygon for ' + field + ' code ' + code);
    p.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  });
}

function gradeBtn(doc, field, gv) { return doc.querySelector(`.hhr-grade-btn[data-region="${REGION[field].key}"][data-grade="${gv}"]`); }
function pressGrade(doc, w, field, gv) {
  const b = gradeBtn(doc, field, gv);
  if (!b) throw new Error('pressGrade(): no grade button for ' + field + '/' + gv);
  b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
function clickUseScore(doc, w) {
  const b = doc.getElementById('hhr-use');
  if (!b) throw new Error('clickUseScore(): #hhr-use not found');
  b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
function clickClearAll(doc, w) {
  // Same selector tools/test_hhr_ui.js's own "Clear all" test uses.
  const b = doc.querySelector('.actionbar .btn-ghost');
  if (!b) throw new Error('clickClearAll(): "Clear all" button not found');
  b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
// Manually tick one option of a Chart Audit checkbox matrix row (simulates a clinician
// hand-entry alongside whatever the calculator has written).
function handTick(doc, w, varName, code) {
  const i = [...doc.querySelectorAll(`#app [data-var="${varName}"] input`)].find((x) => x.value === String(code));
  if (!i) throw new Error('handTick(): no input for ' + varName + '=' + code);
  i.checked = true; i.dispatchEvent(new w.Event('change', { bubbles: true }));
}

// Read a Chart Audit checkbox-matrix row as a SORTED array of its checked option values.
function rowVals(doc, varName) {
  return [...doc.querySelectorAll(`#app [data-var="${varName}"] input:checked`)].map((i) => i.value).sort();
}
function arrEq(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

// All 12 Frostbite-grading matrix rows (4 limbs x grades 2/3/4). Every assertion below
// checks ALL twelve as an exact set every time (defaulting the unlisted ones to empty) --
// this is both the "assert all three rows of the limb" requirement AND the negative
// cross-row/cross-limb leakage check, in one place.
const GRADE_VARS = [];
['left_hand', 'right_hand', 'left_foot', 'right_foot'].forEach((p) => ['2', '3', '4'].forEach((g) => GRADE_VARS.push(p + '_grade_' + g)));
function assertGrades(doc, want, label) {
  GRADE_VARS.forEach((v) => {
    const exp = (want[v] || []).map(String).sort();
    const got = rowVals(doc, v);
    ok(arrEq(got, exp), `${label}: ${v} == {${exp.join(',')}} (got {${got.join(',')}})`);
  });
}
function assertLimbFrostbite(doc, want, label) {
  const exp = want.map(String).sort();
  const got = rowVals(doc, 'limb_frostbite');
  ok(arrEq(got, exp), `${label}: limb_frostbite == {${exp.join(',')}} (got {${got.join(',')}})`);
}
function totalText(doc) { return doc.querySelector('.hhr-total-val').textContent; }
function scoreTextarea(doc) { return doc.querySelector('#app [data-var="hennepin_score"] textarea'); }

/* =====================================================================================
 * TC-1 -- lh grade tiers (each tier tested in ISOLATION -- a fresh limb per bullet).
 * Codes verified against site/hhr_maps.js's "lh" area labels:
 *   13-15 LDIP21-23 (D2 distal), 27-32 LDIP31-33+LPIP31-33 (D3 distal+middle),
 *   47-50 LMCP41-44 (D4 MCP-only), 65-68 LC51-54 (D5 carpal ray).
 * ================================================================================== */
(function () { // TC-1a: D2 distal only -> Grade 2
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [13, 14, 15]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2'] }, 'TC-1a D2 distal only');
})();
(function () { // TC-1b: D3 distal+middle -> Grade 3
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [27, 28, 29, 30, 31, 32]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_3: ['3'] }, 'TC-1b D3 distal+middle');
})();
(function () { // TC-1c: D4 MCP-only -> Grade 3 (MCP is the middle/proximal-phalanx tier)
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [47, 48, 49, 50]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_3: ['4'] }, 'TC-1c D4 MCP-only');
})();
(function () { // TC-1d: D5 ray-only -> Grade 4, plus code 6 ("wrist or more proximal")
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [65, 66, 67, 68]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_4: ['5', '6'] }, 'TC-1d D5 ray-only');
})();

/* =====================================================================================
 * TC-2 -- rf (right foot). Codes verified against the "rf" area labels:
 *   1-3 RIP11-13 (great-toe distal), 4-6 RMCP11-13 (great-toe MCP, no middle tier exists),
 *   13-14 RPIP21-22 (D2 middle), 47-50 RT51-54 (D5 tarsal ray), 51 RH (heel).
 * ================================================================================== */
(function () { // TC-2a: great-toe distal only -> Grade 2
  const { w, doc } = makePage();
  reveal(doc, w, 'lre_p'); paint(doc, w, 'lre_p', [1, 2, 3]); clickUseScore(doc, w);
  assertGrades(doc, { right_foot_grade_2: ['1'] }, 'TC-2a great-toe distal only');
})();
(function () { // TC-2b: great-toe MCP only -> Grade 3 (great toe has no PIP joint)
  const { w, doc } = makePage();
  reveal(doc, w, 'lre_p'); paint(doc, w, 'lre_p', [4, 5, 6]); clickUseScore(doc, w);
  assertGrades(doc, { right_foot_grade_3: ['1'] }, 'TC-2b great-toe MCP only (no middle tier exists for the great toe)');
})();
(function () { // TC-2c: D2 middle + D5 ray, painted together, ONE send
  const { w, doc } = makePage();
  reveal(doc, w, 'lre_p'); paint(doc, w, 'lre_p', [13, 14, 47, 48, 49, 50]); clickUseScore(doc, w);
  assertGrades(doc, { right_foot_grade_3: ['2'], right_foot_grade_4: ['5', '6'] }, 'TC-2c D2 middle + D5 ray, one send (independent rows, not lumped)');
})();
(function () { // TC-2d: heel-only -> Grade 4 == {'6'} EXACTLY (scores 2.5, so no total==0 early-return)
  const { w, doc } = makePage();
  reveal(doc, w, 'lre_p'); paint(doc, w, 'lre_p', [51]); clickUseScore(doc, w);
  assertGrades(doc, { right_foot_grade_4: ['6'] }, 'TC-2d heel-only, exactly {6} (no digit number attached)');
})();

/* =====================================================================================
 * TC-3 -- IPIP anatomical-label variants (same middle-phalanx tier, different labels).
 * lh D5 middle = 58-60 LIPIP51-53; lf D3's middle tier is split across TWO differently-
 * labelled area entries: 23 LIPIP31 and 24 LPIP32 -- both must resolve to "middle".
 * ================================================================================== */
(function () { // TC-3a
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [58, 59, 60]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_3: ['5'] }, 'TC-3a lh D5 middle (LIPIP5x label)');
})();
(function () { // TC-3b
  const { w, doc } = makePage();
  reveal(doc, w, 'lle_p'); paint(doc, w, 'lle_p', [23]); clickUseScore(doc, w);
  assertGrades(doc, { left_foot_grade_3: ['3'] }, 'TC-3b lf D3 "IPIP" middle-phalanx label alone');
})();
(function () { // TC-3c
  const { w, doc } = makePage();
  reveal(doc, w, 'lle_p'); paint(doc, w, 'lle_p', [24]); clickUseScore(doc, w);
  assertGrades(doc, { left_foot_grade_3: ['3'] }, 'TC-3c lf D3 plain "PIP" middle-phalanx label alone');
})();

/* =====================================================================================
 * TC-4 -- thumb (lh digit 1). Codes: 1-4 LIP1x (IP=distal), 5-8 MCP1x (labels lack the
 * leading "L" -- still classify as proximal/middle tier), 9-12 LC1x (carpal ray).
 * ================================================================================== */
(function () { // TC-4a
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [1, 2, 3, 4]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['1'] }, 'TC-4a thumb IP (distal)');
})();
(function () { // TC-4b
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [5, 6, 7, 8]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_3: ['1'] }, 'TC-4b thumb MCP (labels lack the leading "L")');
})();
(function () { // TC-4c
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [9, 10, 11, 12]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_4: ['1', '6'] }, 'TC-4c thumb carpal ray');
})();

/* =====================================================================================
 * TC-5 -- wrist / carpal ray interplay.
 * ================================================================================== */
(function () { // TC-5a: D2 ray-only (23-26 LC21-24) -> Grade 4 with digit number + code 6
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [23, 24, 25, 26]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_4: ['2', '6'] }, 'TC-5a D2 ray-only');
})();
(function () { // TC-5b: wrist (69, LW) paired with D2 distal (13,14,15) -- wrist alone
  // would score 0 and never reach the grader (existing total==0 guard); pairing it with a
  // scoreable digit proves the wrist's "proximal-most" flag lands in Grade 4 alone, and
  // does NOT pull digit 2 into Grade 4 too (no cross-row merge of an unrelated digit).
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); paint(doc, w, 'ule_p', [69, 13, 14, 15]); clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2'], left_hand_grade_4: ['6'] }, 'TC-5b wrist + D2 distal, no merge');
})();

/* =====================================================================================
 * TC-6 -- mixed multi-digit, ONE send (the user's approved example). Catches "worst-tier
 * lumping" bugs: each digit must keep its OWN row, not collapse onto the limb's worst tier.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [13, 14, 15, 27, 28, 29, 30, 31, 32, 47, 48, 49, 50, 65, 66, 67, 68]);
  clickUseScore(doc, w);
  assertGrades(doc, {
    left_hand_grade_2: ['2'], left_hand_grade_3: ['3', '4'], left_hand_grade_4: ['5', '6'],
  }, 'TC-6 mixed multi-digit one send (each digit its own row; thumb absent everywhere)');
  assertLimbFrostbite(doc, ['2'], 'TC-6 limb_frostbite (left upper limb only)');
})();

/* =====================================================================================
 * TC-7 -- per-limb manual override.
 * ================================================================================== */
(function () { // Part 1: lh overridden to G4 (all its active codes land in one row);
  // rf has no override on this limb, so it stays auto.
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); reveal(doc, w, 'lre_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // lh D2 distal
  paint(doc, w, 'ule_p', [58, 59, 60]); // lh D5 middle
  paint(doc, w, 'lre_p', [11, 12]);     // rf D2 distal (no foot override)
  pressGrade(doc, w, 'ule_p', '4');
  clickUseScore(doc, w);
  assertGrades(doc, {
    left_hand_grade_4: ['2', '5'], right_foot_grade_2: ['2'],
  }, 'TC-7 part1 lh overridden to G4 (D2+D5 -> one row), rf still auto');
})();
(function () { // Part 2 (fresh limb): ray-only digit under override -- design resolution --
  // contributes its REAL digit number + code 6, not the legacy lossy {'6'}-only.
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [37, 38, 39, 40]); // lh D3 ray-only
  pressGrade(doc, w, 'ule_p', '3');
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_3: ['3', '6'] }, 'TC-7 part2 ray-aware override (D3 ray-only, override G3)');
})();

/* =====================================================================================
 * TC-8 -- override toggle-off: pressing the SAME active grade button again returns the
 * limb to auto routing (not lumped into the last-picked row).
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  pressGrade(doc, w, 'ule_p', '3');
  let b = gradeBtn(doc, 'ule_p', '3');
  ok(b && b.classList.contains('active') && b.getAttribute('aria-pressed') === 'true', 'TC-8a pressing Grade 3 activates the picker');
  pressGrade(doc, w, 'ule_p', '3'); // press it again -> toggles back to auto
  b = gradeBtn(doc, 'ule_p', '3');
  ok(b && !b.classList.contains('active') && b.getAttribute('aria-pressed') === 'false', 'TC-8b pressing Grade 3 again deactivates it (back to auto)');
  paint(doc, w, 'ule_p', [13, 14, 15]); // D2 distal
  paint(doc, w, 'ule_p', [30, 31, 32]); // D3 middle
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2'], left_hand_grade_3: ['3'] }, 'TC-8c auto routing after toggling the override off (each digit its own row)');
})();

/* =====================================================================================
 * TC-9 -- correction-on-resend: repainting a digit into a higher tier MOVES it between
 * rows on the next send, and a third, no-change resend doesn't resurrect the old entry.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // D2 distal
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2'] }, 'TC-9a initial send: D2 distal -> G2');

  paint(doc, w, 'ule_p', [16, 17, 18]); // + D2 middle -> digit 2 now routes to the mid tier
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_3: ['2'] }, 'TC-9b resend after painting D2 middle: moved G2 -> G3');

  clickUseScore(doc, w); // third, no-change resend (nothing repainted)
  assertGrades(doc, { left_hand_grade_3: ['2'] }, 'TC-9c third no-change resend: G2 stays empty (no DOM-only resurrection of the old entry)');
})();

/* =====================================================================================
 * TC-10 -- hand-tick preservation: a clinician's manual tick in a row the calculator also
 * writes to must survive a later resend that doesn't touch that particular digit.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // D2 distal
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2'] }, 'TC-10a baseline send: D2 distal -> G2');

  handTick(doc, w, 'left_hand_grade_2', '5'); // clinician hand-ticks D5 into the SAME row
  ok(arrEq(rowVals(doc, 'left_hand_grade_2'), ['2', '5']), 'TC-10b hand-tick recorded alongside the calculator\'s own "2" (got {' + rowVals(doc, 'left_hand_grade_2').join(',') + '})');

  paint(doc, w, 'ule_p', [30, 31, 32]); // + D3 middle -- a digit the calculator does not already own in G2
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2', '5'], left_hand_grade_3: ['3'] }, 'TC-10c resend preserves the hand-ticked "5" while routing D3 into G3');
})();

/* =====================================================================================
 * TC-11 -- multi-limb send + narrative text.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p'); reveal(doc, w, 'lre_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // lh D2 distal
  paint(doc, w, 'lre_p', [11, 12]);     // rf D2 distal
  const total = totalText(doc);
  clickUseScore(doc, w);
  assertLimbFrostbite(doc, ['2', '3'], 'TC-11 limb_frostbite (left upper + right lower)');
  assertGrades(doc, { left_hand_grade_2: ['2'], right_foot_grade_2: ['2'] }, 'TC-11 both G2 rows filled, all other grade rows empty');
  const hs = scoreTextarea(doc);
  ok(hs, 'TC-11 hennepin_score textarea exists');
  if (hs) {
    ok(/Hennepin Total Body Perfusion Score:/.test(hs.value), 'TC-11 breakdown includes the total header line');
    ok(hs.value.indexOf(total) >= 0, 'TC-11 breakdown includes the grand total ' + total);
    ok(/Left Hand \(total /.test(hs.value), 'TC-11 breakdown includes the Left Hand limb total');
    ok(/Right Foot \(total /.test(hs.value), 'TC-11 breakdown includes the Right Foot limb total');
  }
})();

/* =====================================================================================
 * TC-12 -- proximal extremity: not a GRADE_PREFIX / limb_frostbite limb at all. Painting
 * it must score (no crash, no early-return) but touch NONE of the grading machinery.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'proximal_p');
  paint(doc, w, 'proximal_p', [1, 2]); // LS1+LS2 (Left arm proximal): 5 pts each = 10
  const total = totalText(doc);
  ok(total === '10', 'TC-12 proximal codes 1,2 score 10 (got ' + total + ')');
  clickUseScore(doc, w);
  const hs = scoreTextarea(doc);
  ok(hs && /Hennepin Total Body Perfusion Score:/.test(hs.value) && hs.value.indexOf(total) >= 0, 'TC-12 send still writes the breakdown text (total nonzero, no early bail)');
  assertLimbFrostbite(doc, [], 'TC-12 proximal has no limb_frostbite mapping -- nothing ticked');
  assertGrades(doc, {}, 'TC-12 proximal is not a GRADE_PREFIX limb -- all 12 grade fields stay empty, no crash');
})();

/* =====================================================================================
 * TC-13 -- state round-trip: an override survives getState/setState onto a FRESH page,
 * and resending there reproduces the identical grading result.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // D2 distal
  pressGrade(doc, w, 'ule_p', '4');     // override G4
  clickUseScore(doc, w);
  const saved = w.HHR.getState();
  ok(saved.grades && saved.grades.ule_p === '4', 'TC-13a getState captures the override grade (got ' + JSON.stringify(saved.grades) + ')');

  const { w: w2, doc: doc2 } = makePage();
  w2.HHR.setState(saved);
  const b2 = gradeBtn(doc2, 'ule_p', '4');
  ok(b2 && b2.classList.contains('active') && b2.getAttribute('aria-pressed') === 'true', 'TC-13b setState restores the active override button on a fresh page');
  const fig2 = doc2.querySelector('.hhr-dx[data-region="lh"][data-layer="perf"]');
  const onCodes = fig2 ? [...fig2.querySelectorAll('polygon.hhr-seg.on')].map((p) => p.dataset.code).sort() : [];
  ok(onCodes.join(',') === '13,14,15', 'TC-13b setState restores the painted polygons (.on), got {' + onCodes.join(',') + '}');

  clickUseScore(doc2, w2);
  assertGrades(doc2, { left_hand_grade_4: ['2'] }, 'TC-13c resend on the restored page reproduces the same override result');
})();

/* =====================================================================================
 * TC-14 -- "Clear all" resets the calculator (grades + painted anatomy); a fresh paint
 * afterwards is AUTO (no stale override), and the resend retracts the earlier entry too.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // D2 distal
  pressGrade(doc, w, 'ule_p', '4');     // override G4 (so there is something stale to clear)
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_4: ['2'] }, 'TC-14a before Clear all: override G4 sent');

  clickClearAll(doc, w);
  ok(Object.keys(w.HHR.getState().grades || {}).length === 0, 'TC-14b "Clear all" clears the per-limb Cauchy grades (no stale grade leaks to the next patient)');
  const b = gradeBtn(doc, 'ule_p', '4');
  ok(b && !b.classList.contains('active'), 'TC-14c "Clear all" deactivates the grade picker buttons');

  reveal(doc, w, 'ule_p');              // "Clear all" also unchecks the injury selector -- re-tick before repainting
  paint(doc, w, 'ule_p', [13, 14, 15]); // fresh paint of the SAME digit, now with no override
  clickUseScore(doc, w);
  assertGrades(doc, { left_hand_grade_2: ['2'] }, 'TC-14d fresh paint after Clear all is AUTO -- resend also retracts the earlier stale G4 entry');
})();

/* =====================================================================================
 * TC-15 -- payload encoding: reproduce TC-9's end state plus a hand-tick, then confirm
 * FB.buildPayload(MAINDICT, ...) -- the exact function app.js's "Open REDCap" button
 * uses -- encodes the moved/preserved checkboxes correctly.
 *
 * app.js's internal `state` closure isn't exposed on window (only FBMAIN's setField/
 * setChoice/setChecks/removeChecks are), so "current state" is read back off the live DOM
 * that those bridge calls keep in sync -- exercising the real payload.js encoder against
 * the real post-resend checkbox state, without coupling this test to the unrelated
 * required-fields gate on the "Open REDCap" button.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  reveal(doc, w, 'ule_p');
  paint(doc, w, 'ule_p', [13, 14, 15]); // D2 distal
  clickUseScore(doc, w);
  paint(doc, w, 'ule_p', [16, 17, 18]); // + D2 middle -> moves to G3
  clickUseScore(doc, w);
  clickUseScore(doc, w);                // TC-9's third, no-change resend
  handTick(doc, w, 'left_hand_grade_2', '5'); // clinician hand-tick, must survive the payload encoding too

  const MAINDICT = w.DICT; // Chart Audit dictionary (grade matrices + limb_frostbite live here);
                            // NOT to be confused with DICT_HHR (sibling tests bind that as plain DICT).
  const checked = {
    left_hand_grade_2: new Set(rowVals(doc, 'left_hand_grade_2')),
    left_hand_grade_3: new Set(rowVals(doc, 'left_hand_grade_3')),
    left_hand_grade_4: new Set(rowVals(doc, 'left_hand_grade_4')),
    limb_frostbite: new Set(rowVals(doc, 'limb_frostbite')),
  };
  const payload = w.FB.buildPayload(MAINDICT, { values: {}, checked: checked, visible: {} });
  const names = payload.map((p) => p.name + '=' + p.value);
  ok(names.indexOf('left_hand_grade_3___2=1') >= 0, 'TC-15 payload emits left_hand_grade_3___2=1 (got ' + names.join(', ') + ')');
  ok(names.indexOf('left_hand_grade_2___2=1') < 0, 'TC-15 payload does NOT emit left_hand_grade_2___2=1 (digit moved out of G2)');
  ok(names.indexOf('left_hand_grade_2___5=1') >= 0, 'TC-15 payload keeps the hand-ticked left_hand_grade_2___5=1');
  ok(names.indexOf('limb_frostbite___2=1') >= 0, 'TC-15 payload keeps limb_frostbite___2=1');
})();

/* =====================================================================================
 * TC-16 (this file's own bonus/optional case, per the plan's "Edits to existing tests"
 * section -- not to be confused with the plan document's own "TC-16 regressions" note,
 * which is a whole-suite concern, not a test that belongs in this file): a direct unit
 * test of the removeChecks() bridge extension, independent of the Hennepin calculator.
 * ================================================================================== */
(function () {
  const { w, doc } = makePage();
  ok(typeof w.FBMAIN.setChecks === 'function', 'TC-16 sanity: window.FBMAIN.setChecks exists');
  // left_hand_grade_2/3 are branch-gated behind limb_frostbite code 2 (Left upper limb);
  // tick it first so the rows are visible and the DOM sync below actually sticks (this is
  // exactly the order useScore() itself uses -- limb_frostbite before any grade row).
  w.FBMAIN.setChecks('limb_frostbite', ['2']);
  w.FBMAIN.setChecks('left_hand_grade_2', ['2', '5']); // target '2' + a decoy '5' in the SAME row
  w.FBMAIN.setChecks('left_hand_grade_3', ['1']);       // a second, unrelated row
  ok(arrEq(rowVals(doc, 'left_hand_grade_2'), ['2', '5']), 'TC-16 setup: left_hand_grade_2 seeded with {2,5}');
  ok(arrEq(rowVals(doc, 'left_hand_grade_3'), ['1']), 'TC-16 setup: left_hand_grade_3 seeded with {1}');

  if (typeof w.FBMAIN.removeChecks !== 'function') {
    ok(false, 'TC-16 window.FBMAIN.removeChecks is exported (bridge extension from the plan)');
  } else {
    w.FBMAIN.removeChecks('left_hand_grade_2', ['2']);
    ok(arrEq(rowVals(doc, 'left_hand_grade_2'), ['5']), 'TC-16 removeChecks deletes only the named code; the decoy "5" survives (got {' + rowVals(doc, 'left_hand_grade_2').join(',') + '})');
    ok(arrEq(rowVals(doc, 'left_hand_grade_3'), ['1']), 'TC-16 removeChecks on one row leaves an unrelated row untouched');
  }
})();

console.log(`\nGrade auto-fill UI test — ${passes} passed, ${fails.length} failed`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log(fails.length ? '\nFAIL' : '\nPASS: "Use score" auto-fills the Frostbite grading matrix from painted anatomy, per-limb overrides and removeChecks-based re-sends work correctly.');
process.exit(fails.length ? 1 : 0);
