/*
 * Deterministic UI test (jsdom): loads the real page + scripts, exercises the
 * gate, rendering, branching toggles, required-progress, and the open-in-REDCap
 * payload form — without a live browser.
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');
const DICT = JSON.parse(fs.readFileSync(path.join(SITE, 'dictionary.json'), 'utf8'));
const byVar = {}; DICT.fields.forEach(f => byVar[f.var] = f);

let fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

// CSS regression: the [hidden] attribute must override component display rules
// (e.g. .gate sets display:grid; without this the unlocked overlay never hides).
ok(/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(fs.readFileSync(path.join(SITE, 'styles.css'), 'utf8')),
   '[hidden] is display:none !important (overrides .gate display:grid)');

function makePage(configOverride) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = function () {}; // jsdom has no layout; setField scrolls the flashed field
  w.confirm = () => true;
  w.open = () => ({ focus() {} }); // jsdom has no real window.open; return a truthy handle
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  let captured = null;
  w.HTMLFormElement.prototype.submit = function () { captured = this; };
  // load scripts in document order
  w.eval(read('config.js'));
  if (configOverride) Object.assign(w.CONFIG, configOverride);
  w.eval(read('datemask.js'));
  w.eval(read('dictionary.js'));
  w.eval(read('dict_hhr.js'));
  w.eval(read('branch.js'));
  w.eval(read('payload.js'));
  w.eval(read('hhr_calc.js'));
  w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js'));
  w.eval(read('ilop.js'));
  w.eval(read('cryptosave.js'));
  w.eval(read('app.js'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded')); // force synchronous init
  return { w, doc: w.document, getCaptured: () => captured };
}

function fireChange(w, input) { input.dispatchEvent(new w.Event('change', { bubbles: true })); }
function optInput(doc, varname, code) {
  return [...doc.querySelectorAll(`[data-var="${varname}"] input`)].find(i => i.value === String(code));
}
function setRadio(w, doc, varname, code) {
  const i = optInput(doc, varname, code);
  ok(i, `radio option ${varname}=${code} exists`);
  if (i) { i.checked = true; fireChange(w, i); }
}
function setText(w, doc, varname, val) {
  const i = doc.querySelector(`[data-var="${varname}"] input, [data-var="${varname}"] textarea`);
  ok(i, `input ${varname} exists`);
  if (i) { i.value = val; fireChange(w, i); }
}
const visible = (doc, v) => { const w = doc.querySelector(`[data-var="${v}"]`); return w && !w.hidden; };
function fillRequired(w, doc) {
  for (var pass = 0; pass < 8; pass++) {
    var any = false;
    DICT.fields.forEach(function (f) {
      // The app now mirrors the original form's required flags exactly, so fill exactly the
      // originally-required fields (these are the ones that block "Open REDCap").
      if (!f.required) return;
      var wr = doc.querySelector('[data-var="' + f.var + '"]');
      if (!wr || wr.hidden) return;
      if (f.type === 'checkbox' || f.type === 'radio' || f.type === 'yesno') {
        if (wr.querySelector('input:checked')) return;
        var first = wr.querySelector('input'); if (first) { first.checked = true; first.dispatchEvent(new w.Event('change', { bubbles: true })); any = true; }
      } else {
        var i = wr.querySelector('input,textarea');
        if (i && !i.value) {
          var v = f.validation || '';
          i.value = v.indexOf('datetime') === 0 ? '01-01-2099 00:00' : v.indexOf('date') === 0 ? '01-01-2099'
                  : v === 'number_1dp' ? '5.0' : v === 'uofa_duration_hh_mm' ? '01:30' : '5';
          i.dispatchEvent(new w.Event('change', { bubbles: true })); any = true;
        }
      }
    });
    if (!any) break;
  }
}

// ---- Test B: build + branching + payload (gate bypassed) ----
(function () {
  const { w, doc, getCaptured } = makePage({ requirePassphrase: false });
  ok(doc.getElementById('app') && !doc.getElementById('app').hidden, 'app revealed when gate disabled');
  ok(doc.querySelectorAll('.tab').length === DICT.tabs.length, `tab count == ${DICT.tabs.length} (got ${doc.querySelectorAll('.tab').length})`);
  ok(doc.querySelectorAll('.field, .matrix-row').length === DICT.fields.length, `field count == ${DICT.fields.length} (got ${doc.querySelectorAll('.field, .matrix-row').length})`);

  // control-type coverage
  let typeMismatch = [];
  DICT.fields.forEach(f => {
    const wrap = doc.querySelector(`[data-var="${f.var}"]`);
    if (!wrap) { typeMismatch.push(f.var + ' missing'); return; }
    if (f.type === 'checkbox' && !wrap.querySelector('input[type=checkbox]')) typeMismatch.push(f.var + ' no checkbox');
    if ((f.type === 'radio' || f.type === 'yesno') && !wrap.querySelector('input[type=radio]')) typeMismatch.push(f.var + ' no radio');
    if (f.type === 'textarea' && !wrap.querySelector('textarea')) typeMismatch.push(f.var + ' no textarea');
  });
  ok(typeMismatch.length === 0, 'control types: ' + (typeMismatch.slice(0, 5).join(', ') || 'all correct'));

  // option counts match dictionary (no dup, no missing)
  let optMismatch = [];
  DICT.fields.filter(f => f.options && f.options.length).forEach(f => {
    const n = doc.querySelectorAll(`[data-var="${f.var}"] .opt input, [data-var="${f.var}"] .mt-box input`).length;
    if (n !== f.options.length) optMismatch.push(`${f.var} ${n}!=${f.options.length}`);
  });
  ok(optMismatch.length === 0, 'option counts: ' + (optMismatch.slice(0, 5).join(', ') || 'all match'));

  // "Auto" date button -> today's date with year 2099
  var dob = doc.querySelector('[data-var="date_of_birth"]');
  var autoB = dob && dob.querySelector('.auto-btn');
  ok(autoB, 'date field has an "Auto" button');
  if (autoB) { autoB.click(); ok(/^\d{2}-\d{2}-2099$/.test(dob.querySelector('input').value || ''), 'Auto button sets the date to DD-MM-2099 (got ' + dob.querySelector('input').value + ')'); }
  // Date fields are typed DD-MM-YYYY text boxes (NOT native <input type=date>), which
  // is what fixes the "2127 -> 0212" native year-segment bug.
  ok(dob && dob.querySelector('input').type === 'text', 'date field is a typed text box, not a native date picker');
  ok(dob && dob.querySelector('input').getAttribute('data-datekind') === 'date', 'date field tagged data-datekind=date');

  // --- audit-fix regression locks ---
  ok(doc.querySelector('[data-var="sex"] fieldset').getAttribute('role') === 'radiogroup', 'single-select uses role=radiogroup');
  ok(doc.querySelector('[data-var="sex"] fieldset').getAttribute('aria-required') === 'true', 'required radiogroup has aria-required');
  ok(doc.querySelector('[data-var="limb_frostbite"] fieldset').getAttribute('role') === 'group', 'checkbox group uses role=group');
  ok(doc.querySelector('[data-var="study_number"] input').getAttribute('aria-required') === 'true', 'required text input has aria-required');
  ok(doc.querySelector('[data-var="right_hand_grade_2"]').tagName === 'TR' && !!doc.querySelector('[data-var="right_hand_grade_2"]').closest('table.matrix-table'), 'matrix field renders as a row in a 2-D matrix table');
  ok(doc.querySelectorAll('[data-var="right_hand_grade_2"] .mt-box input').length === byVar['right_hand_grade_2'].options.length, 'matrix row has one checkbox per shared column');
  ok(doc.querySelector('[data-var="alteplase_contraindication"] .opts').classList.contains('opts-vertical'), 'long non-matrix options render vertical');
  ok([].map.call(doc.querySelectorAll('[data-var="ae_iloprost"] .opt-text'), function (n) { return n.textContent; }).indexOf('Hypotension (< 90/60)') >= 0, 'option label with literal "<" is complete');
  ok([].map.call(doc.querySelectorAll('#panel-imaging .section'), function (n) { return n.textContent; }).indexOf('NSAID Dosing') < 0, 'no "NSAID Dosing" heading bleeds into Imaging tab');
  ok(doc.getElementById('tabs').getAttribute('role') === 'tablist', '#tabs is role=tablist');
  ok(doc.querySelector('[data-var="study_number"] input').getAttribute('aria-describedby').indexOf('warn_study_number') >= 0, 'input aria-describedby links its warning');
  // Placement lock: the "Hennepin score:" field lives on Frostbite Grading, not Disposition & Follow-up.
  ok(byVar['hennepin_score'] && byVar['hennepin_score'].tab === 'grading', 'hennepin_score assigned to the grading tab');
  ok(doc.getElementById('panel-grading').querySelector('[data-var="hennepin_score"]'), 'hennepin_score renders on the Frostbite Grading panel');
  ok(!doc.getElementById('panel-followup').querySelector('[data-var="hennepin_score"]'), 'hennepin_score no longer on the Disposition & Follow-up panel');

  // Branching: radio-driven (ems_temperature <- ems_arrival==1)
  ok(!visible(doc, 'ems_temperature'), 'ems_temperature hidden initially');
  setRadio(w, doc, 'ems_arrival', '1');
  ok(visible(doc, 'ems_temperature'), 'ems_temperature shown when ems_arrival=1');
  setRadio(w, doc, 'ems_arrival', '2');
  ok(!visible(doc, 'ems_temperature'), 'ems_temperature hidden when ems_arrival=2');

  // Branching: checkbox-driven (right_hand_grade_2 <- limb_frostbite code 1 checked)
  ok(!visible(doc, 'right_hand_grade_2'), 'right_hand_grade_2 hidden initially');
  const cb = optInput(doc, 'limb_frostbite', '1');
  ok(cb, 'limb_frostbite option code 1 exists');
  cb.checked = true; fireChange(w, cb);
  ok(visible(doc, 'right_hand_grade_2'), 'right_hand_grade_2 shown when limb_frostbite code1 checked');

  // Payload via open button: fill a few, capture the POST form
  setText(w, doc, 'study_number', 'EDM-001'); // soft number validation -> alphanumeric ID accepted
  setRadio(w, doc, 'sex', '2');
  setText(w, doc, 'date_of_birth', '04-07-1990'); // typed DD-MM-YYYY -> ISO on submit
  fillRequired(w, doc); // every visible non-comment field is now required; complete them so Open proceeds (no longer just a warn)
  doc.getElementById('btn-open').click();
  const form = getCaptured();
  ok(form, 'open-in-REDCap submitted a form once required fields are complete');
  if (form) {
    const pairs = {}; form.querySelectorAll('input').forEach(i => { pairs[i.name] = i.value; });
    ok(form.method.toLowerCase() === 'post', 'form method POST');
    ok(form.action === DICT.post_action, 'form action == survey url (got ' + form.action + ')');
    ok(pairs.__prefill === '1', '__prefill present');
    ok(pairs.study_number === 'EDM-001', 'alphanumeric study_number accepted (soft validation)');
    ok(pairs.sex === '2', 'sex coded value');
    ok(pairs.date_of_birth === '1990-07-04', 'date_of_birth stored format YYYY-MM-DD (got ' + pairs.date_of_birth + ')');
    ok(pairs['limb_frostbite___1'] === '1', 'checkbox limb_frostbite___1=1 present');
    ok(!('ems_temperature' in pairs), 'hidden ems_temperature excluded from payload');
  }

  // Review-only: the one-click auto-submit path was removed. There is no review
  // toggle, the button always opens REDCap, and the app never calls fetch().
  ok(!doc.getElementById('cb-review'), 'no review checkbox (review is always on)');
  ok(!doc.getElementById('submit-status'), 'no one-click submit-status element');
  ok(doc.getElementById('btn-open').textContent.toLowerCase().indexOf('review') >= 0, 'submit button always says "review"');
  let fetchCalled = false;
  w.fetch = function () { fetchCalled = true; return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } }); };
  w.confirm = function () { return true; };
  fillRequired(w, doc);
  doc.getElementById('btn-open').click();
  ok(fetchCalled === false, 'submit never calls fetch (no network / no auto-submit)');
  const rev = getCaptured();
  ok(rev && rev.action === DICT.post_action && rev.method.toLowerCase() === 'post', 'clicking submit POSTs the prefill straight to the REDCap survey');
})();

// ---- Test C: Hennepin Score Calculator tab ----
(function () {
  const { w, doc, getCaptured } = makePage({ requirePassphrase: false });
  const HD = w.DICT_HHR, HC = w.HHR_CALC;
  ok(HD && HC, 'HHR dict + calc loaded');
  ok(doc.getElementById('formswitch') && !doc.getElementById('formswitch').hidden, 'form switcher revealed after unlock');
  const swH = doc.getElementById('sw-hhr');
  ok(swH, 'Hennepin switcher button exists');
  ok(!doc.querySelector('#app-hhr .appbar'), 'calculator not built until its tab is selected');

  swH.click();
  ok(!doc.getElementById('app-hhr').hidden && doc.getElementById('app').hidden, 'switching shows calculator, hides frostbite');
  ok(/Hennepin Frostbite Score/.test((doc.querySelector('#app-hhr .hhr-intro') || {}).textContent || ''), 'intro/citation text present');

  // Five pixel-faithful clickable diagrams: polygon counts match the parsed image maps.
  const HM = w.HHR_MAPS;
  let dxMiss = [];
  ['lh', 'rh', 'lf', 'rf', 'proximal'].forEach(k => {
    const n = doc.querySelectorAll(`#app-hhr .hhr-dx[data-region="${k}"][data-layer="perf"] polygon.hhr-seg`).length;
    if (n !== HM[k].areas.length) dxMiss.push(`${k} ${n}!=${HM[k].areas.length}`);
  });
  ok(dxMiss.length === 0, 'HHR diagram polygon counts match parsed maps: ' + (dxMiss.join(', ') || 'all 5 OK'));
  ok(doc.querySelectorAll('#app-hhr .hhr-dx[data-layer="perf"] img.hhr-dx-img').length === 5, 'five anatomical images rendered (perfusion layer)');
  // the parallel amputation layer mirrors the same five diagrams in its own sub-tab
  ok(doc.querySelectorAll('#app-hhr .hhr-dx[data-layer="amp"] img.hhr-dx-img').length === 5, 'five amputation-layer diagrams rendered (mirror)');
  ok(doc.querySelector('#app-hhr .hhr-scorebox .hhr-total-val'), 'score total element present');
  ok(doc.querySelector('#app-hhr [data-var="assessment_hfs"]') && doc.querySelector('#app-hhr [data-var="extremity_perfusion_hfs"]'), 'assessment + injury checklists present');
  ok(!doc.querySelector('#app .hhr-dx'), 'diagrams are scoped to the calculator (frostbite form untouched)');

  // helpers for the clickable-diagram UI
  const REGION_FIELD = { lh: 'ule_p', rh: 'ure_p', lf: 'lle_p', rf: 'lre_p', proximal: 'proximal_p' };
  const seg = (k, code) => [...doc.querySelectorAll(`#app-hhr .hhr-dx[data-region="${k}"] polygon.hhr-seg`)].find(p => p.dataset.code === String(code));
  const injCheck = (code) => { const i = [...doc.querySelectorAll('#app-hhr [data-var="extremity_perfusion_hfs"] input')].find(x => x.value === String(code)); if (i) { i.checked = true; i.dispatchEvent(new w.Event('change', { bubbles: true })); } };
  const regionGroup = (k) => doc.querySelector(`#app-hhr .hhr-region[data-region="${k}"]`);
  function checkedCodes(field) {
    const rk = Object.keys(REGION_FIELD).find(k => REGION_FIELD[k] === field);
    const sel = rk ? `#app-hhr .hhr-dx[data-region="${rk}"] .hhr-dx-list input:checked` : `#app-hhr [data-var="${field}"] input:checked`;
    return new Set([...doc.querySelectorAll(sel)].map(i => i.value));
  }
  function shimTotal() {
    const elements = {};
    HD.fields.forEach(f => { if (f.type !== 'checkbox') return; const set = checkedCodes(f.var); f.options.forEach(o => { elements['__chk__' + f.var + '_RC_' + o.code] = { value: set.has(String(o.code)) ? String(o.code) : '' }; }); });
    const proxy = new Proxy({}, { get: (_t, k) => elements[k] || { value: '' } });
    return HC.hennepin_score_total({ forms: { form: { elements: proxy } }, form: proxy });
  }

  // Display-gating: a region's diagram + breakdown appear only once that region is selected.
  ok(doc.querySelector('#app-hhr .hhr-dx[data-region="lh"]').hidden, 'left-hand diagram hidden before the region is selected');
  ok(regionGroup('lh') && regionGroup('lh').hidden, 'left-hand score breakdown hidden before the region is selected');
  injCheck('1');                                               // Left hand
  ok(!doc.querySelector('#app-hhr .hhr-dx[data-region="lh"]').hidden, 'left-hand diagram shown after selecting Left hand');
  ok(regionGroup('lh') && !regionGroup('lh').hidden, 'left-hand score breakdown shown after selecting Left hand');

  // Live score equals REDCap's own calc on the same polygon selection.
  ['1', '5', '69'].forEach(c => { const p = seg('lh', c); ok(p, `lh polygon for option ${c} exists`); if (p) p.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
  const shown = doc.querySelector('#app-hhr .hhr-total-val').textContent;
  ok(shown === String(shimTotal()), `live total matches REDCap calc (shown ${shown}, calc ${shimTotal()})`);
  ok(Number(shown) > 0, 'live total is non-zero after checks');
  ok(doc.querySelector('#app-hhr .hhr-livetotal-val').textContent === shown, 'header live-total mirrors the score box');

  // The Hennepin calculator has no standalone submit — it feeds the Chart Audit via
  // the FBMAIN bridge. "Use score in Chart Audit" writes the FULL per-section
  // breakdown into the Chart Audit's free-text Hennepin field, and nothing calls fetch().
  ok(!doc.getElementById('hhr-open'), 'no standalone HHR submit (the calculator feeds the Chart Audit)');
  let hhrFetch = false;
  w.fetch = () => { hhrFetch = true; return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
  const liveTotal = doc.querySelector('#app-hhr .hhr-total-val').textContent;
  // Fixture note: lh codes 1,5,69 now also auto-fill left_hand_grade_3/4 as a side effect of "Use score" (see tools/test_grade_autofill_ui.js); nothing here observes it, so no change needed.
  doc.getElementById('hhr-use').click();
  const hsField = doc.querySelector('#app [data-var="hennepin_score"] textarea');
  ok(hsField && /Hennepin Total Body Perfusion Score:/.test(hsField.value), 'Use score writes the breakdown into the Chart Audit hennepin_score field');
  ok(hsField && hsField.value.indexOf(liveTotal) >= 0, 'breakdown contains the grand total ' + liveTotal);
  ok(/Left Hand \(total /.test((hsField || {}).value || ''), 'breakdown lists the Left Hand limb total');
  ok(hhrFetch === false, 'Hennepin "Use score" never calls fetch (no network / no auto-submit)');
})();

// ---- Test D: wound-care section lives on Imaging & Consults (regression lock) ----
// Both branches of "Wound care consultation" must sit together on the imaging page:
// wound_care_mgmt (dressings used BY wound care, consult==1) and bandage_non_wound_care
// (bandages applied NOT by wound care, consult==2), the latter right after the former.
(function () {
  const { w, doc } = makePage({ requirePassphrase: false });
  ok(byVar['bandage_non_wound_care'] && byVar['bandage_non_wound_care'].tab === 'imaging', 'bandage_non_wound_care assigned to the imaging tab');
  const panelImg = doc.getElementById('panel-imaging');
  ok(panelImg && !!panelImg.querySelector('[data-var="bandage_non_wound_care"]'), 'bandage_non_wound_care renders on the Imaging & Consults panel');
  ok(panelImg && !!panelImg.querySelector('[data-var="wound_care_mgmt"]'), 'wound_care_mgmt renders on the Imaging & Consults panel');
  ok(!doc.getElementById('panel-followup').querySelector('[data-var="bandage_non_wound_care"]'), 'bandage_non_wound_care no longer on the Disposition & Follow-up panel');
  const imgVars = [].map.call(panelImg.querySelectorAll('.field'), function (n) { return n.dataset.var; }).filter(Boolean);
  const im = imgVars.indexOf('wound_care_mgmt'), ib = imgVars.indexOf('bandage_non_wound_care');
  ok(im >= 0 && ib === im + 1, 'bandage_non_wound_care renders immediately after wound_care_mgmt (mgmt@' + im + ', bandage@' + ib + ')');
  // Mutually-exclusive branching off wound_care_consult is unchanged (1=consulted, 2=not).
  ok(!visible(doc, 'wound_care_mgmt') && !visible(doc, 'bandage_non_wound_care'), 'both wound-care follow-ups hidden until consult answered');
  setRadio(w, doc, 'wound_care_consult', '1');
  ok(visible(doc, 'wound_care_mgmt') && !visible(doc, 'bandage_non_wound_care'), 'consult=1 shows "used by wound care", hides "not by wound care"');
  setRadio(w, doc, 'wound_care_consult', '2');
  ok(!visible(doc, 'wound_care_mgmt') && visible(doc, 'bandage_non_wound_care'), 'consult=2 shows "not by wound care", hides "used by wound care"');
})();

// ---- Test A: the access gate ----
// Uses a TEST-ONLY passphrase whose hash is injected via configOverride, so the real
// production passphrase never appears in this repo and the test survives a rotation.
(function () {
  const TEST_PASS = 'test-gate-pass';
  const TEST_HASH = require('crypto').createHash('sha256').update(TEST_PASS).digest('hex');
  const { w, doc } = makePage({ requirePassphrase: true, passphraseSha256: TEST_HASH });
  ok(!doc.getElementById('gate').hidden, 'gate shown when passphrase required');
  ok(doc.getElementById('app').hidden, 'app hidden before unlock');
  const pass = doc.getElementById('gate-pass');
  // wrong passphrase
  pass.value = 'nope';
  doc.getElementById('gate-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return new Promise(res => setTimeout(res, 30)).then(() => {
    ok(doc.getElementById('app').hidden, 'wrong passphrase keeps app hidden');
    ok(!doc.getElementById('gate-err').hidden, 'wrong passphrase shows error');
    // correct passphrase (test-only value; matches the injected test hash)
    pass.value = TEST_PASS;
    doc.getElementById('gate-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    return new Promise(res => setTimeout(res, 30));
  }).then(() => {
    ok(!doc.getElementById('app').hidden, 'correct passphrase reveals app');
    finish();
  });
})();

function finish() {
  console.log('UI checks run.');
  if (fails.length) { console.log('FAILURES (' + fails.length + '):'); fails.forEach(f => console.log('  -- ' + f)); console.log('\nFAIL.'); process.exit(1); }
  console.log('\nPASS: UI renders, gate works, branching toggles, payload form correct.');
}
