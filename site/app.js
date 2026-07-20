/*
 * Frostbite Chart Audit — entry helper (static, client-side only).
 * Renders the nicer grouped form from window.DICT, mirrors REDCap branching via
 * FB.computeVisibility, and opens the real survey pre-populated for review via
 * FB.buildPayload (POST __prefill). No network; the only persistence is an
 * in-tab sessionStorage draft (cleared when the tab closes) so a reload doesn't
 * lose work. Nothing is ever transmitted except the final POST to REDCap.
 */
(function () {
  'use strict';
  var DICT = window.DICT, CFG = window.CONFIG || {}, FB = window.FB, FBX = window.FBEXPORT;
  var DRAFT_KEY = 'fb_draft';
  var SAVE_API = '/api/save';   // same-origin Pages Function: encrypted blob store (all three forms)
  var CODE_API = '/api/code';   // same-origin bridge Worker: REDCap Save & Return Later code (chart form)
  var currentCode = '';         // the code of the in-progress save, so re-saves update ONE REDCap record
  var currentCodeViaBridge = false; // is currentCode a REDCap-native return code (vs a legacy app-only id)?
  var currentKey = '';          // this record's random 256-bit encryption key (base64url). Never sent to the
                                // server — it travels only inside the save code (the part after the dot).
  // Fields pre-filled with a "no data" default value (still freely editable). The
  // outside min/max exposure temps default to 99 (= data not on file) per request.
  var FIELD_DEFAULTS = { minimal_temperature: '99', maximum_temperature: '99' };

  var state = { values: {}, checked: {}, _visible: {}, _missing: [] }; // checked[var] = Set(codes)
  // Values pushed in from a calculator tab (Hennepin/Iloprost). Tracked so refresh()
  // doesn't erase one written into a field that is currently branch-hidden — the value
  // is retained and re-applied to the DOM once its branching opens.
  var injected = {};
  // Vars a calculator tab writes directly (setField/setChoice, e.g. hennepin_score) or via
  // the checkbox bridge (setChecks/removeChecks, e.g. limb_frostbite and the whole Frostbite
  // grading table) that must be re-marked "injected" after ANY state restore (loadDraft's
  // init sequence, or the cross-computer setState()) — not just while the calculator itself
  // is running — or refresh() will delete the restored value/checks the next time the field
  // is momentarily branch-hidden (e.g. an ordinary uncheck+recheck of limb_frostbite/
  // limb_amputation). See reseedInjected() below.
  var INJECTED_RESEED_VARS = [
    'hennepin_score', 'iloprost_dose', 'additional_frostbite', 'limb_amputation',
    'limb_frostbite',
    'left_hand_grade_2', 'left_hand_grade_3', 'left_hand_grade_4',
    'right_hand_grade_2', 'right_hand_grade_3', 'right_hand_grade_4',
    'left_foot_grade_2', 'left_foot_grade_3', 'left_foot_grade_4',
    'right_foot_grade_2', 'right_foot_grade_3', 'right_foot_grade_4'
  ];
  // Re-applies INJECTED_RESEED_VARS to `injected` from the just-restored state. Value-type
  // fields (textarea/radio/yesno) store their data in state.values, like before; checkbox-
  // type fields (limb_frostbite, the grade rows) must instead check state.checked — their
  // data never lives in state.values — mirroring how setChecks/removeChecks mark a checkbox
  // field injected (injected[varName] = true) versus how setField/setChoice do (the value).
  function reseedInjected() {
    INJECTED_RESEED_VARS.forEach(function (v) {
      var f = byVar[v];
      if (f && f.type === 'checkbox') {
        if (state.checked[v] && state.checked[v].size) injected[v] = true;
      } else if (state.values[v] != null) {
        injected[v] = state.values[v];
      }
    });
  }
  var fieldNodes = {};   // var -> field wrapper element
  var groups = [];       // section-group elements (for empty-section hiding)
  var matrixBlocks = [];  // matrix-block elements (for empty-matrix hiding)
  // Captions for the limb grading tables (the four cards are merged into one
  // "Frostbite grading" chart, so each table is labelled here instead of by a header).
  var MATRIX_LABELS = { right_hand: 'Right hand', left_hand: 'Left hand', right_foot: 'Right foot', left_foot: 'Left foot' };
  var tabPanels = {}, tabButtons = {}, tabOrder = [], activeTab = null, dirty = false, byVar = {}, built = false, saveTimer = 0;
  var switchTo = function () {};   // set by initSwitch — programmatic top-level form switch
  var saveStatusTimer = 0;
  DICT.fields.forEach(function (f) { byVar[f.var] = f; });
  // Required-field set MIRRORS the original REDCap form EXACTLY: each field's `required`
  // flag comes straight from the survey's req='1' marker (via parse_survey.py). A field is
  // required in this helper iff it is required in the original form — INCLUDING required
  // free-text/comment boxes (e.g. admitting_diagnosis) and EXCLUDING anything optional in the
  // original (e.g. patient weight). Only enforced when visible under branching (updateProgress).
  // No required-flag override is applied.

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function $(id) { return document.getElementById(id); }
  function sr(text) { var s = el('span', 'sr-only', text); return s; }
  function reduce() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // "Auto" button: fill a date/datetime field with today's day & month but year 2099,
  // in the typed DD-MM-YYYY[ HH:MM] format. Dispatches 'change' so it flows through
  // onChange → readField → validate → save, exactly like a typed value.
  function setAutoDate(input) {
    var d = new Date();
    var kind = input.getAttribute('data-datekind') || 'date';
    // Clamp the day to the sentinel year's month length so a Feb-29 "today" doesn't
    // emit 29-02-2099 (2099 is not a leap year, which would read as an invalid date).
    var dd = window.FBDATE ? Math.min(d.getDate(), window.FBDATE.daysInMonth(d.getMonth() + 1, 2099)) : d.getDate();
    var ddmm = pad2(dd) + '-' + pad2(d.getMonth() + 1) + '-2099';
    input.value = (kind === 'datetime') ? (ddmm + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())) : ddmm;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Live mask for a typed date/datetime input: reformat on each keystroke and keep
  // the caret sensible (count digits before the caret, map back after reformatting).
  // Runs on the input element itself, so it fires before the delegated #panels
  // 'input' handler (onChange) reads the now-masked value into state.
  function attachDateMask(input, kind) {
    // Track the digit count before each edit so we can tell a separator-delete apart
    // from a digit-delete (beforeinput fires while input.value is still pre-edit).
    input.addEventListener('beforeinput', function () {
      input._fbPrevDigits = window.FBDATE ? window.FBDATE.onlyDigits(input.value).length : null;
    });
    input.addEventListener('input', function (e) {
      var FBDATE = window.FBDATE; if (!FBDATE) return;
      var raw = input.value;
      var pos = (input.selectionStart == null) ? raw.length : input.selectionStart;
      // Backspacing a separator would otherwise be a dead keystroke (the '-' is just
      // re-inserted). If the digit count didn't change, delete the digit the user meant.
      if (e && e.inputType === 'deleteContentBackward' && input._fbPrevDigits != null
          && FBDATE.onlyDigits(raw).length === input._fbPrevDigits && pos > 0) {
        raw = raw.slice(0, pos - 1) + raw.slice(pos);
        pos = pos - 1;
      }
      var before = FBDATE.digitsBefore(raw, pos);
      var masked = FBDATE.format(raw, kind);
      input.value = masked;
      var c = FBDATE.caretForDigits(masked, before);
      try { input.setSelectionRange(c, c); } catch (e2) {}
    });
  }

  async function sha256(s) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // ---------------- access gate ----------------
  // A SOFT UI gate only — it hides the tools until the shared passphrase is entered, but it
  // is not real access control (a determined user can bypass client-side checks). It does
  // NOT protect saved data: every saved record is encrypted under its own random key that
  // travels only in the save code, so the published passphrase hash reveals no PHI. The
  // stored passphrase (fb_pp) is used only as the bridge's authorization header.
  function initGate() {
    var gate = $('gate'), app = $('app');
    function reveal() { gate.hidden = true; $('formswitch').hidden = false; app.hidden = false; buildApp(); initSwitch(); initSaveBar(); wireUpdater(); }
    if (!CFG.requirePassphrase) { reveal(); return; }
    if (sessionStorage.getItem('fb_ok') === '1') { reveal(); return; }
    var form = $('gate-form'), err = $('gate-err'), pass = $('gate-pass');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      sha256(pass.value).then(function (h) {
        if (h === CFG.passphraseSha256) { try { sessionStorage.setItem('fb_pp', pass.value); sessionStorage.setItem('fb_ok', '1'); } catch (e) {} reveal(); }
        else { err.hidden = false; pass.select(); }
      });
    });
  }

  // ---------------- top-level form switcher (Frostbite | Hennepin | Iloprost) ----------------
  // N-way selector: each entry is a {button, panel, onShow} tuple. Tools other
  // than the Frostbite form are built lazily the first time their tab is shown.
  // ---------------- per-tab scroll preservation ----------------
  // Remember each form/tab's vertical scroll so switching restores it instead of
  // jumping to the top. Chart-audit internal tabs are keyed individually.
  var scrollStore = {}, currentFormIdx = 0;
  function curScrollY() { return window.scrollY || window.pageYOffset || (document.documentElement || {}).scrollTop || 0; }
  function scrollKey(idx) { return idx === 0 ? ('chart:' + activeTab) : (idx === 1 ? 'hhr' : 'ilop'); }
  function saveScrollFor(idx) { scrollStore[scrollKey(idx)] = curScrollY(); }
  function restoreScrollFor(idx) { var y = scrollStore[scrollKey(idx)] || 0; try { window.scrollTo(0, y); } catch (e) { try { window.scrollTo({ top: y }); } catch (e2) {} } }

  function initSwitch() {
    var tabs = [
      { btn: $('sw-frostbite'), panel: $('app') },
      { btn: $('sw-hhr'), panel: $('app-hhr'), onShow: function () { if (window.HHR) window.HHR.build(); } },
      { btn: $('sw-ilop'), panel: $('app-ilop'), onShow: function () { if (window.ILOP) window.ILOP.build(); } }
    ];
    var first = tabs[0].btn;
    if (!first || first._wired) return; first._wired = true;
    function select(idx) {
      saveScrollFor(currentFormIdx);          // remember where we were on the outgoing form
      tabs.forEach(function (t, i) {
        if (!t.btn || !t.panel) return;
        var on = i === idx;
        t.panel.hidden = !on;
        t.btn.classList.toggle('active', on);
        t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      var sel = tabs[idx];
      currentFormIdx = idx;
      if (sel && sel.onShow) sel.onShow();
      restoreScrollFor(idx);                   // return to where we last were on the incoming form
    }
    tabs.forEach(function (t, i) { if (t.btn) t.btn.addEventListener('click', function () { select(i); }); });
    switchTo = select;   // expose for the save/resume coordinator (e.g. jump to Chart Audit)
  }

  // ---------------- build form ----------------
  function buildApp() {
    if (built) return; built = true;
    $('app-title').textContent = CFG.title || 'Chart Audit';
    $('app-sub').textContent = CFG.subtitle || '';
    document.title = 'REDCap Helper';

    var tabsEl = $('tabs'), panels = $('panels');
    tabsEl.setAttribute('role', 'tablist');
    DICT.tabs.forEach(function (t) {
      tabOrder.push(t.id);
      var btn = el('button', 'tab'); btn.type = 'button'; btn.dataset.tab = t.id;
      btn.id = 'tab-' + t.id; btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', 'panel-' + t.id); btn.setAttribute('aria-selected', 'false'); btn.tabIndex = -1;
      btn.appendChild(el('span', 'tab-label', t.label));
      var badge = el('span', 'tab-badge'); badge.setAttribute('aria-hidden', 'true'); btn.appendChild(badge);
      btn.addEventListener('click', function () { showTab(t.id); });
      tabsEl.appendChild(btn); tabButtons[t.id] = { btn: btn, badge: badge };
      var panel = el('section', 'panel'); panel.dataset.tab = t.id; panel.id = 'panel-' + t.id;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'tab-' + t.id); panel.tabIndex = 0; panel.hidden = true;
      panels.appendChild(panel); tabPanels[t.id] = panel;
    });
    tabsEl.addEventListener('keydown', onTabKey);

    var lastSec = {}, curGroup = {}, curMatrix = {}, curMatrixEl = {};
    DICT.fields.forEach(function (f) {
      var panel = tabPanels[f.tab]; if (!panel) return;
      if (lastSec[f.tab] !== f.section || !curGroup[f.tab]) {
        lastSec[f.tab] = f.section;
        var g = el('div', 'section-group'); g._vars = [];
        if (f.section) g.appendChild(el('h2', 'section', f.section));
        panel.appendChild(g); curGroup[f.tab] = g; groups.push(g);
        curMatrix[f.tab] = null; curMatrixEl[f.tab] = null;
      }
      if (f.matrix) {
        // Matrix group → one 2-D table (rows = fields, columns = the shared options),
        // mirroring how REDCap renders the matrix. Each row stays a per-field wrapper
        // (the <tr> carries data-var), so all state/branching wiring is unchanged.
        if (curMatrix[f.tab] !== f.matrix) {
          curMatrixEl[f.tab] = startMatrix(f, curGroup[f.tab]);
          curMatrix[f.tab] = f.matrix;
        }
        var mb = curMatrixEl[f.tab];
        var tr = renderMatrixRow(f); fieldNodes[f.var] = tr;
        mb._tbody.appendChild(tr); mb._vars.push(f.var); curGroup[f.tab]._vars.push(f.var);
      } else {
        curMatrix[f.tab] = null; curMatrixEl[f.tab] = null;
        var w = renderField(f); fieldNodes[f.var] = w;
        curGroup[f.tab].appendChild(w); curGroup[f.tab]._vars.push(f.var);
      }
    });

    panels.addEventListener('change', onChange);
    panels.addEventListener('input', onChange);
    $('btn-open').addEventListener('click', openRedcap);
    $('btn-export').addEventListener('click', onExportClick);
    $('btn-review').addEventListener('click', toggleReview);
    $('btn-clear').addEventListener('click', clearAll);
    $('review-close').addEventListener('click', toggleReview);
    $('btn-prev').addEventListener('click', function () { stepTab(-1); });
    $('btn-next').addEventListener('click', function () { stepTab(1); });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

    loadDraft();
    // A calculator value restored from the draft into a branch-hidden field (e.g.
    // iloprost_dose before iloprost administration is marked Yes) must be re-marked
    // "injected" so refresh() keeps it instead of deleting it as branch-hidden.
    reseedInjected();
    applyDefaults();
    showTab(tabOrder[0]);
    refresh();
  }

  function renderField(f) {
    var w = el('div', 'field'); w.dataset.var = f.var; if (f.matrix) { w.dataset.matrix = f.matrix; w.classList.add('is-matrix'); }
    var warnId = 'warn_' + f.var, hintId = 'hint_' + f.var;

    if (f.type === 'radio' || f.type === 'yesno' || f.type === 'checkbox') {
      var single = (f.type !== 'checkbox');
      var fs = el('fieldset', 'options'); fs.setAttribute('role', single ? 'radiogroup' : 'group');
      if (f.required && single) fs.setAttribute('aria-required', 'true'); // valid on radiogroup; checkbox group uses the visible+sr "(required)" cue
      var leg = el('legend'); leg.appendChild(document.createTextNode(f.label || f.var));
      if (f.required) { var rq = el('span', 'req', '*'); rq.setAttribute('aria-hidden', 'true'); leg.appendChild(rq); leg.appendChild(sr(' (required)')); }
      fs.appendChild(leg);
      var opts = el('div', 'opts');
      if (!f.matrix && f.options.some(function (o) { return (o.label || '').length > 24; })) opts.classList.add('opts-vertical');
      f.options.forEach(function (o) {
        var lab = el('label', 'opt');
        var inp = document.createElement('input');
        inp.type = (f.type === 'checkbox') ? 'checkbox' : 'radio';
        inp.name = f.var; inp.value = o.code;
        lab.appendChild(inp); lab.appendChild(el('span', 'opt-text', o.label));
        opts.appendChild(lab);
      });
      fs.appendChild(opts);
      if (f.type !== 'checkbox') {
        var clr = el('button', 'clear', 'Clear'); clr.type = 'button';
        clr.setAttribute('aria-label', 'Clear ' + (f.label || f.var));
        clr.addEventListener('click', function () { clearField(f.var); });
        fs.appendChild(clr);
      }
      w.appendChild(fs);
      return w;
    }

    var id = 'in_' + f.var;
    var lab2 = el('label', 'field-label'); lab2.htmlFor = id; lab2.appendChild(document.createTextNode(f.label || f.var));
    if (f.required) { var rq2 = el('span', 'req', '*'); rq2.setAttribute('aria-hidden', 'true'); lab2.appendChild(rq2); lab2.appendChild(sr(' (required)')); }
    w.appendChild(lab2);
    var input, dateKind = null;
    if (f.type === 'textarea') { input = document.createElement('textarea'); input.rows = 2; }
    else {
      input = document.createElement('input');
      var v = f.validation || '';
      dateKind = (v.indexOf('datetime') === 0) ? 'datetime' : (v.indexOf('date') === 0 ? 'date' : null);
      if (dateKind) {
        // Typed DD-MM-YYYY[ HH:MM] text box (matches REDCap and avoids the native
        // segmented date input's right-to-left year-entry bug). Masked by FBDATE.
        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'off';
        input.setAttribute('data-datekind', dateKind);
        input.placeholder = (dateKind === 'datetime') ? 'DD-MM-YYYY HH:MM' : 'DD-MM-YYYY';
        attachDateMask(input, dateKind);
      } else {
        // All other REDCap validations here are "soft" (warn, never block) — keep
        // numeric fields as text with a numeric keyboard so an alphanumeric value
        // (e.g. a patient ID) is accepted, exactly as REDCap accepts it.
        input.type = 'text';
        if (v === 'integer') input.inputMode = 'numeric';
        else if (v === 'number' || v === 'number_1dp') input.inputMode = 'decimal';
        else if (v === 'uofa_duration_hh_mm') input.placeholder = 'HH:MM';
      }
    }
    input.id = id; input.name = f.var; input.className = 'input';
    if (f.required) input.setAttribute('aria-required', 'true');
    if (dateKind) {
      var drow = el('div', 'date-row'); drow.appendChild(input);
      var ab = el('button', 'auto-btn', 'Auto'); ab.type = 'button';
      ab.title = 'Set to today’s date' + (dateKind === 'datetime' ? ' & time' : '') + ', with year 2099';
      ab.addEventListener('click', function () { setAutoDate(input); });
      drow.appendChild(ab); w.appendChild(drow);
    } else if (FIELD_DEFAULTS[f.var]) {
      // Field carries a "no data on file" default (e.g. 99°C min/max): it stays
      // pre-filled and survives Start over. A Clear button blanks it if a real
      // value is known; applyDefaults never overwrites a value the user set/cleared.
      var frow = el('div', 'date-row'); frow.appendChild(input);
      var cb = el('button', 'auto-btn', 'Clear'); cb.type = 'button';
      cb.setAttribute('aria-label', 'Clear ' + (f.label || f.var));
      cb.addEventListener('click', function () { clearField(f.var); });
      frow.appendChild(cb); w.appendChild(frow);
    } else {
      w.appendChild(input);
    }
    var hint = hintFor(f), describedBy = '';
    if (FIELD_DEFAULTS[f.var]) hint = (hint ? hint + ' · ' : '') + 'Defaults to ' + FIELD_DEFAULTS[f.var] + ' (no data on file) — edit if known';
    if (hint) { var h = el('div', 'hint', hint); h.id = hintId; w.appendChild(h); describedBy = hintId; }
    var warn = el('div', 'field-warn'); warn.id = warnId; warn.setAttribute('role', 'status'); warn.setAttribute('aria-live', 'polite'); warn.hidden = true;
    w.appendChild(warn);
    input.setAttribute('aria-describedby', (describedBy ? describedBy + ' ' : '') + warnId);
    return w;
  }

  // Begin a matrix group: a labelled, horizontally-scrollable table whose header is
  // the shared option set. Returns the .matrix-block (with ._tbody for the rows).
  function startMatrix(f, group) {
    var mb = el('div', 'matrix-block'); mb._vars = []; matrixBlocks.push(mb);
    var cap = MATRIX_LABELS[f.matrix];
    if (cap) mb.appendChild(el('div', 'matrix-caption', cap));
    var scroll = el('div', 'matrix-scroll');
    var table = el('table', 'matrix-table');
    if (cap) table.setAttribute('aria-label', cap);
    var thead = el('thead'), htr = el('tr');
    var corner = el('th', 'mt-corner'); corner.setAttribute('aria-hidden', 'true'); htr.appendChild(corner);
    f.options.forEach(function (o) {
      var th = el('th', 'mt-col'); th.scope = 'col'; th.title = o.label;
      th.appendChild(el('span', 'mt-col-text', o.label));
      htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = el('tbody'); table.appendChild(tbody);
    scroll.appendChild(table); mb.appendChild(scroll);
    group.appendChild(mb); mb._tbody = tbody;
    return mb;
  }

  // One matrix field → one table row: a row-header (the field label) + a checkbox per
  // shared option. name=var / value=code is identical to the old chip rendering, so
  // readField/applyStateToDom/refresh keep working against fieldNodes[var] (the <tr>).
  function renderMatrixRow(f) {
    var tr = el('tr', 'matrix-row'); tr.dataset.var = f.var;
    var th = el('th', 'mt-row'); th.scope = 'row';
    th.appendChild(document.createTextNode(f.label || f.var));
    if (f.required) { var rq = el('span', 'req', '*'); rq.setAttribute('aria-hidden', 'true'); th.appendChild(rq); th.appendChild(sr(' (required)')); }
    tr.appendChild(th);
    f.options.forEach(function (o) {
      var td = el('td', 'mt-cell');
      var lab = el('label', 'mt-box');
      var inp = document.createElement('input'); inp.type = 'checkbox'; inp.name = f.var; inp.value = o.code;
      lab.appendChild(inp); lab.appendChild(sr((f.label || f.var) + ' — ' + o.label));
      td.appendChild(lab); tr.appendChild(td);
    });
    return tr;
  }

  function hintFor(f) {
    var v = f.validation || '';
    if (v.indexOf('datetime') === 0) return 'Date & time';
    if (v.indexOf('date') === 0) return 'Date';
    if (v === 'integer') return 'Whole number';
    if (v === 'number') return 'Number';
    if (v === 'number_1dp') return 'Number (up to 1 decimal place)';
    if (v === 'uofa_duration_hh_mm') return 'Duration as HH:MM';
    return '';
  }

  // Format check matching REDCap's validation, so one-click submit isn't rejected.
  function fieldError(f, val) {
    if (val == null || String(val).trim() === '') return '';
    val = String(val); var v = f.validation || '';
    if (v.indexOf('datetime') === 0) return window.FBDATE ? window.FBDATE.error(val, 'datetime') : '';
    if (v.indexOf('date') === 0) return window.FBDATE ? window.FBDATE.error(val, 'date') : '';
    if (v === 'integer' && !/^-?\d+$/.test(val)) return 'Expected a whole number.';
    if (v === 'number' && !/^-?\d*\.?\d+$/.test(val)) return 'Expected a number.';
    if (v === 'number_1dp' && !/^-?\d+\.\d$/.test(val)) return 'Use a number with one decimal place (e.g. 5.0).';
    if (v === 'uofa_duration_hh_mm' && !/^\d{1,3}:[0-5]\d$/.test(val)) return 'Use HH:MM (e.g. 01:30).';
    return '';
  }
  function validateField(f, w) {
    var warn = w.querySelector('.field-warn'); if (!warn) return;
    var msg = fieldError(f, state.values[f.var]);
    warn.textContent = msg; warn.hidden = !msg;
  }

  // ---------------- state + change ----------------
  function onChange(e) {
    var w = e.target.closest('[data-var]'); if (!w) return;
    var f = byVar[w.dataset.var];
    readField(f, w); validateField(f, w); dirty = true; refresh(); scheduleSave();
  }
  function readField(f, w) {
    if (f.type === 'checkbox') {
      var set = state.checked[f.var] || (state.checked[f.var] = new Set()); set.clear();
      w.querySelectorAll('input[type=checkbox]:checked').forEach(function (i) { set.add(i.value); });
    } else if (f.type === 'radio' || f.type === 'yesno') {
      var c = w.querySelector('input:checked');
      if (c) state.values[f.var] = c.value; else delete state.values[f.var];
    } else {
      var i = w.querySelector('input,textarea'); var val = i ? i.value : '';
      if (val !== '') state.values[f.var] = val; else delete state.values[f.var];
    }
  }
  function clearField(v) {
    var w = fieldNodes[v]; if (!w) return;
    w.querySelectorAll('input,textarea').forEach(function (i) {
      if (i.type === 'radio' || i.type === 'checkbox') i.checked = false; else i.value = '';
    });
    delete state.values[v]; if (state.checked[v]) state.checked[v].clear();
    dirty = true; refresh(); scheduleSave();
  }
  function clearAll() {
    if (!confirm('Clear all entered data and start over? This cannot be undone.')) return;
    state.values = {}; state.checked = {};
    document.querySelectorAll('#panels input, #panels textarea').forEach(function (i) {
      if (i.type === 'radio' || i.type === 'checkbox') i.checked = false; else i.value = '';
    });
    document.querySelectorAll('.field-warn').forEach(function (n) { n.hidden = true; n.textContent = ''; });
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
    currentCode = ''; currentCodeViaBridge = false; currentKey = '';   // a new blank form is not tied to any existing record/code/key
    // Re-seed the "no data on file" defaults (e.g. 99°C min/max) so a fresh form
    // starts pre-filled just like first load — not blank. Each stays clearable.
    applyDefaults();
    dirty = false; refresh();
  }

  // ---------------- draft persistence (in-tab only) ----------------
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 400); }
  function saveDraft() {
    try {
      var c = {}; Object.keys(state.checked).forEach(function (k) { var a = [].concat(Array.from(state.checked[k])); if (a.length) c[k] = a; });
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ values: state.values, checked: c }));
    } catch (e) {}
  }
  function loadDraft() {
    var raw; try { raw = sessionStorage.getItem(DRAFT_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      state.values = d.values || {};
      state.checked = {};
      Object.keys(d.checked || {}).forEach(function (k) { state.checked[k] = new Set(d.checked[k]); });
      applyStateToDom();
    } catch (e) {}
  }
  function applyStateToDom() {
    DICT.fields.forEach(function (f) {
      var w = fieldNodes[f.var]; if (!w) return;
      if (f.type === 'checkbox') {
        var set = state.checked[f.var];
        w.querySelectorAll('input[type=checkbox]').forEach(function (i) { i.checked = !!(set && set.has(i.value)); });
      } else if (f.type === 'radio' || f.type === 'yesno') {
        var val = state.values[f.var];
        w.querySelectorAll('input').forEach(function (i) { i.checked = (i.value === val); });
      } else {
        var i = w.querySelector('input,textarea'); if (i) i.value = state.values[f.var] || '';
        validateField(f, w);
      }
    });
  }

  // Seed "no data" defaults for any FIELD_DEFAULTS var still empty after a draft load
  // (a value the user typed/edited is never overwritten). The field stays fully editable.
  function applyDefaults() {
    var changed = false;
    Object.keys(FIELD_DEFAULTS).forEach(function (v) {
      var cur = state.values[v];
      if (cur == null || String(cur).trim() === '') { state.values[v] = FIELD_DEFAULTS[v]; changed = true; }
    });
    if (changed) applyStateToDom();
  }

  // ---------------- visibility + progress ----------------
  function refresh() {
    var visible = FB.computeVisibility(DICT, state);
    DICT.fields.forEach(function (f) {
      var w = fieldNodes[f.var]; if (!w) return;
      var vis = visible[f.var] !== false;
      w.hidden = !vis;
      if (!vis && (state.values[f.var] != null || (state.checked[f.var] && state.checked[f.var].size))) {
        w.querySelectorAll('input,textarea').forEach(function (i) {
          if (i.type === 'radio' || i.type === 'checkbox') i.checked = false; else i.value = '';
        });
        // A calculator-injected value is kept in state (and re-applied below when the
        // field becomes visible); everything else is cleared as REDCap branching dictates.
        if (!(f.var in injected)) { delete state.values[f.var]; if (state.checked[f.var]) state.checked[f.var].clear(); }
        var fw = w.querySelector('.field-warn'); if (fw) { fw.hidden = true; fw.textContent = ''; }
      } else if (vis && (f.var in injected)) {
        // Re-apply a calculator-injected value when its field becomes visible again.
        if (f.type === 'checkbox') {
          var iset = state.checked[f.var];
          w.querySelectorAll('input[type=checkbox]').forEach(function (i) { i.checked = !!(iset && iset.has(i.value)); });
        } else if (f.type === 'radio' || f.type === 'yesno') {
          // Set the checked option by value (mirrors setChoice) — never mutate input.value,
          // which for a radio/yesno field would corrupt the option codes (e.g. limb_amputation).
          var rv = state.values[f.var];
          w.querySelectorAll('input[type=radio]').forEach(function (i) { i.checked = (i.value === rv); });
          validateField(f, w);
        } else {
          var ii = w.querySelector('input,textarea');
          if (ii && ii.value !== state.values[f.var]) { ii.value = state.values[f.var] || ''; validateField(f, w); }
        }
      }
    });
    matrixBlocks.forEach(function (mb) { mb.hidden = mb._vars.every(function (v) { return fieldNodes[v].hidden; }); });
    groups.forEach(function (g) { g.hidden = g._vars.every(function (v) { return fieldNodes[v].hidden; }); });
    state._visible = visible;
    updateProgress(visible);
  }

  function isFilled(f) {
    if (f.type === 'checkbox') return !!(state.checked[f.var] && state.checked[f.var].size);
    if (f.type === 'radio' || f.type === 'yesno') return state.values[f.var] != null;
    // A typed date counts as filled only when it is a COMPLETE, valid value — matching
    // the inline date warning and the old native-date behaviour (incomplete/invalid
    // dates must not silently satisfy a required field).
    var v = f.validation || '';
    if (window.FBDATE && (v.indexOf('datetime') === 0 || v.indexOf('date') === 0)) {
      return window.FBDATE.isComplete(state.values[f.var], v.indexOf('datetime') === 0 ? 'datetime' : 'date');
    }
    return state.values[f.var] != null && String(state.values[f.var]).trim() !== '';
  }

  function updateProgress(visible) {
    var total = 0, done = 0, per = {}, missing = [];
    DICT.tabs.forEach(function (t) { per[t.id] = { t: 0, d: 0 }; });
    DICT.fields.forEach(function (f) {
      if (!f.required || visible[f.var] === false) return;
      total++; per[f.tab].t++;
      if (isFilled(f)) { done++; per[f.tab].d++; } else missing.push(f);
    });
    $('progress-count').textContent = done + ' / ' + total;
    $('progress-fill').style.width = (total ? Math.round(done / total * 100) : 100) + '%';
    Object.keys(tabButtons).forEach(function (id) {
      var b = tabButtons[id].badge, s = per[id], left = s ? s.t - s.d : 0, tab = tabButtons[id].btn;
      var label = DICT.tabs.filter(function (x) { return x.id === id; })[0].label;
      if (!s || s.t === 0) { b.textContent = ''; b.className = 'tab-badge'; tab.setAttribute('aria-label', label); }
      else if (left === 0) { b.textContent = '✓'; b.className = 'tab-badge done'; tab.setAttribute('aria-label', label + ', section complete'); }
      else { b.textContent = String(left); b.className = 'tab-badge warn'; tab.setAttribute('aria-label', label + ', ' + left + ' required field' + (left === 1 ? '' : 's') + ' remaining'); }
    });
    state._missing = missing;
    if (!$('review').hidden) buildReview();
  }

  // ---------------- tabs ----------------
  function showTab(id, focusBtn) {
    if (id !== activeTab) saveScrollFor(0);    // remember the outgoing chart-audit tab's scroll
    activeTab = id;
    Object.keys(tabPanels).forEach(function (k) { tabPanels[k].hidden = (k !== id); });
    Object.keys(tabButtons).forEach(function (k) {
      var on = (k === id), btn = tabButtons[k].btn;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    if (focusBtn && tabButtons[id]) tabButtons[id].btn.focus();
    restoreScrollFor(0);                        // restore this tab's scroll (field-jumps scrollIntoView after)
    var i = tabOrder.indexOf(id);
    $('btn-prev').disabled = i <= 0; $('btn-next').disabled = i >= tabOrder.length - 1;
  }
  function stepTab(d) { var i = tabOrder.indexOf(activeTab) + d; if (i >= 0 && i < tabOrder.length) showTab(tabOrder[i]); }
  function onTabKey(e) {
    var i = tabOrder.indexOf(activeTab), n = tabOrder.length, j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else return;
    e.preventDefault(); showTab(tabOrder[j], true);
  }

  // ---------------- review missing ----------------
  function toggleReview() { var r = $('review'); r.hidden = !r.hidden; if (!r.hidden) buildReview(); }
  function buildReview() {
    var list = $('review-list'); list.textContent = '';
    var miss = state._missing || [];
    if (!miss.length) { list.appendChild(el('li', 'review-empty', '✓ All required fields are complete.')); return; }
    miss.forEach(function (f) {
      var li = el('li', 'review-item'), b = el('button', 'review-link'); b.type = 'button';
      b.appendChild(el('span', 'review-tab', tabLabel(f.tab)));
      b.appendChild(el('span', 'review-q', f.label || f.var));
      b.addEventListener('click', function () {
        showTab(f.tab);
        setTimeout(function () {
          var w = fieldNodes[f.var]; if (!w) return;
          w.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'center' });
          w.classList.add('flash'); setTimeout(function () { w.classList.remove('flash'); }, 2000);
          var fi = w.querySelector('input,textarea'); if (fi) try { fi.focus({ preventScroll: true }); } catch (e) {}
        }, 90);
      });
      li.appendChild(b); list.appendChild(li);
    });
  }
  function tabLabel(id) { var t = DICT.tabs.filter(function (x) { return x.id === id; })[0]; return t ? t.label : ''; }

  // ---------------- submit: always open the populated REDCap form for review ----------------
  // The one-click headless-submit relay was removed. Every submit now opens the real
  // REDCap survey, pre-populated, in a new tab for the user to review and submit there.
  function openRedcap() {
    var visible = state._visible || FB.computeVisibility(DICT, state);
    var miss = state._missing || [];
    if (miss.length) {
      // Required fields must be complete before opening REDCap to finalize: surface the
      // missing list and do NOT open/submit. (Comment/free-text boxes are not required.)
      var rp = $('review'); rp.hidden = false; buildReview();
      try { rp.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'center' }); } catch (e) {}
      return;
    }
    var payload = FB.buildPayload(DICT, { values: state.values, checked: state.checked, visible: visible });
    var form = document.createElement('form');
    form.method = 'POST'; form.action = DICT.post_action; form.target = 'redcapReview';
    form.acceptCharset = 'UTF-8'; form.style.display = 'none';
    payload.forEach(function (p) {
      var i = document.createElement('input'); i.type = 'hidden'; i.name = p.name; i.value = p.value; form.appendChild(i);
    });
    document.body.appendChild(form);
    // Open the target window first (named) so the submit reliably lands in a new tab.
    var win = window.open('', 'redcapReview');
    form.submit();
    document.body.removeChild(form);
    if (!win) alert('Your browser may have blocked the new tab. If REDCap did not open, allow pop-ups for this page and try again. Your entries are still here.');
    // Keep `dirty` armed: data still lives only in this tab until you submit in REDCap.
  }

  // ---------------- public API for the calculator tabs ----------------
  // setField(var, value): write a value computed in the Hennepin/Iloprost tab into the
  // matching main-form text field, mark it injected (survives branch-hiding), update the
  // DOM/draft, and flash the field. Returns { ok, visible } so the caller can word its
  // confirmation (visible:false ⇒ stored but behind unanswered branching).
  function setField(varName, value) {
    var f = byVar[varName];
    if (!f || (f.type !== 'textarea' && f.type !== 'text')) return { ok: false, visible: false };
    value = String(value);
    injected[varName] = value;
    state.values[varName] = value;
    dirty = true;
    var w = fieldNodes[varName];
    if (w) { var i = w.querySelector('input,textarea'); if (i) i.value = value; validateField(f, w); }
    refresh();
    scheduleSave();
    var vis = state._visible[varName] !== false;
    if (w && vis) {
      showTab(f.tab);
      setTimeout(function () {
        w.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'center' });
        w.classList.add('flash'); setTimeout(function () { w.classList.remove('flash'); }, 2000);
      }, 90);
    }
    return { ok: true, visible: vis };
  }
  // setChoice(var, code): the radio/yesno counterpart of setField — lets a calculator
  // set a single-select answer (e.g. flip "Were limbs/digits amputated?" to Yes so the
  // amputation comment is branch-visible and gets submitted). Marks it injected so
  // branching can't erase it. No scroll/flash — the paired setField lands the focus.
  function setChoice(varName, code) {
    var f = byVar[varName];
    if (!f || (f.type !== 'radio' && f.type !== 'yesno')) return { ok: false, visible: false };
    code = String(code);
    injected[varName] = code;
    state.values[varName] = code;
    dirty = true;
    var w = fieldNodes[varName];
    if (w) { w.querySelectorAll('input[type=radio]').forEach(function (i) { i.checked = (i.value === code); }); validateField(f, w); }
    refresh();
    scheduleSave();
    return { ok: true, visible: state._visible[varName] !== false };
  }
  // setChecks(var, codes): the checkbox counterpart of setField/setChoice — lets a
  // calculator tick a set of checkbox options (e.g. the affected limbs / amputated
  // digits it already captured) so they aren't re-entered by hand. ADDITIVE: it only
  // adds codes, never removes existing checks (so manual entries like Ears/Nose on
  // "Limbs affected" are preserved). Marks the field injected so branching can't erase it.
  // See removeChecks below for the subtractive sibling.
  function setChecks(varName, codes) {
    var f = byVar[varName];
    if (!f || f.type !== 'checkbox') return { ok: false, visible: false };
    var set = state.checked[varName] || (state.checked[varName] = new Set());
    (codes || []).forEach(function (c) { set.add(String(c)); });
    injected[varName] = true;
    dirty = true;
    var w = fieldNodes[varName];
    if (w) { w.querySelectorAll('input[type=checkbox]').forEach(function (i) { i.checked = set.has(i.value); }); validateField(f, w); }
    refresh();
    scheduleSave();
    return { ok: true, visible: state._visible[varName] !== false };
  }
  // removeChecks(var, codes): the subtractive sibling of setChecks — lets a calculator
  // retract specific codes it previously ticked (e.g. the Hennepin tab moving a digit
  // from one frostbite grade row to another on re-send) without touching codes it never
  // sent (so hand-ticked entries in that same row are preserved). Same shape as setChecks
  // otherwise, including when the field has no checked Set yet (nothing to remove, but the
  // field is still marked injected/dirty and the DOM/draft are still synced).
  function removeChecks(varName, codes) {
    var f = byVar[varName];
    if (!f || f.type !== 'checkbox') return { ok: false, visible: false };
    var set = state.checked[varName] || (state.checked[varName] = new Set());
    (codes || []).forEach(function (c) { set.delete(String(c)); });
    injected[varName] = true;
    dirty = true;
    var w = fieldNodes[varName];
    if (w) { w.querySelectorAll('input[type=checkbox]').forEach(function (i) { i.checked = set.has(i.value); }); validateField(f, w); }
    refresh();
    scheduleSave();
    return { ok: true, visible: state._visible[varName] !== false };
  }
  window.FBMAIN = { setField: setField, setChoice: setChoice, setChecks: setChecks, removeChecks: removeChecks };

  // ============== cross-computer save code (zero-knowledge, Cloudflare) ==============
  // One code captures all three forms (Chart Audit + Hennepin + Iloprost). The browser
  // ENCRYPTS the state (AES-GCM, cryptosave.js) under a FRESH RANDOM 256-bit key unique to
  // this record; only the ciphertext is uploaded to our same-origin Pages Function
  // (/api/save -> KV). The key never leaves the browser — it travels only inside the save
  // code the user copies, as the part after the dot: <id>.<key>. So the server/Cloudflare
  // can never read a saved blob, and one leaked code exposes exactly one record. Codes work
  // on ANY computer and persist until the user deletes them. The in-tab draft is unchanged.

  // Chart Audit state <-> plain object (same shape the in-tab draft uses).
  function getState() {
    var vals = {}; Object.keys(state.values).forEach(function (k) { vals[k] = state.values[k]; });
    var c = {}; Object.keys(state.checked).forEach(function (k) { var a = Array.from(state.checked[k]); if (a.length) c[k] = a; });
    return { values: vals, checked: c };
  }
  function setState(s) {
    if (!s || typeof s !== 'object') return false;
    state.values = {};
    Object.keys(s.values || {}).forEach(function (k) { state.values[k] = s.values[k]; });
    state.checked = {};
    Object.keys(s.checked || {}).forEach(function (k) { state.checked[k] = new Set(s.checked[k]); });
    // Restored calculator-target values must survive branch-hiding, like a fresh inject.
    injected = {};
    reseedInjected();
    applyStateToDom();
    applyDefaults();
    refresh();
    scheduleSave();
    return true;
  }

  function gatherAll() {
    var data = { v: 1, chart: getState(), bridge: currentCodeViaBridge };
    try { if (window.HHR && window.HHR.getState) data.hhr = window.HHR.getState(); } catch (e) {}
    try { if (window.ILOP && window.ILOP.getState) data.ilop = window.ILOP.getState(); } catch (e) {}
    return data;
  }
  // The gate passphrase (kept per-tab in sessionStorage on unlock). It is NO LONGER the
  // encryption key — saved blobs use a per-record random key. It is used only as the
  // bridge's authorization header (x-fb-pass) when talking to /api/code. Prompt once if
  // it's missing on a passphrase build. Returns the passphrase string, or null if one is
  // required but the user cancelled/left the prompt empty.
  function getPassphrase() {
    var p = '';
    try { p = sessionStorage.getItem('fb_pp') || ''; } catch (e) {}
    if (p) return p;
    if (CFG.requirePassphrase) {
      var entered = window.prompt('Re-enter the access passphrase to lock/unlock saved forms:');
      if (entered == null || entered === '') return null;
      try { sessionStorage.setItem('fb_pp', entered); } catch (e) {}
      return entered;
    }
    return ''; // dev/test build with no passphrase
  }
  // Store the app-only state (all three forms) as an encrypted blob under a given code,
  // using this record's random key, so ONE code brings back the Hennepin/Iloprost
  // calculators too — not just the REDCap chart data. Only { ct, iv, dtok } are uploaded
  // (dtok = SHA-256(key), the delete/overwrite capability); the key itself never leaves the
  // browser. Anchored server-side to codes the bridge actually minted.
  function storeBlob(code, keyB64) {
    var keyBytes = window.FBCRYPTO.keyFromCode(keyB64);
    return window.FBCRYPTO.encryptWithKey(gatherAll(), keyBytes).then(function (e) {
      return window.FBCRYPTO.dtokFromKeyBytes(keyBytes).then(function (dtok) {
        return fetch(SAVE_API, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ct: e.ct, iv: e.iv, id: code, dtok: dtok })
        }).then(function (res) { return res.ok; }, function () { return false; });
      });
    });
  }
  // Save. Primary path: the bridge pushes the CHART form into REDCap via Save &
  // Return Later and returns REDCap's OWN return code (works in both places), then
  // we cache the full three-form blob under that same code. If the bridge isn't
  // deployed (501) or is unreachable, fall back to the legacy random save code
  // (app-only). Resolves { code, verified, mismatches, viaBridge }.
  function cloudSave() {
    if (!window.FBCRYPTO || !window.FBCRYPTO.available) return Promise.reject(new Error('crypto_unavailable'));
    var pp = getPassphrase();
    if (CFG.requirePassphrase && pp == null) return Promise.reject(new Error('no_passphrase'));
    // Mint this record's random key once per session; a re-save reuses it so a code the
    // user already copied keeps unlocking the latest blob.
    if (!currentKey) currentKey = window.FBCRYPTO.keyToCode(window.FBCRYPTO.generateKeyBytes());

    var visible = state._visible || FB.computeVisibility(DICT, state);
    var stateForBuild = { values: state.values, checked: state.checked, visible: visible };
    var reqBody = {
      payload: FB.buildPayload(DICT, stateForBuild),      // fresh-prefill (omits empties)
      intended: FB.buildIntended(DICT, stateForBuild)     // full spec incl. blanks (clear + verify)
    };
    // Only ask the bridge to RESUME/update an existing record when the current code is
    // one REDCap actually issued (a bridge code). Sending a legacy app-only id here
    // would make the Worker try to resume a code REDCap never heard of and fail.
    if (currentCode && currentCodeViaBridge) reqBody.code = currentCode;

    return fetch(CODE_API, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fb-pass': pp || '' }, body: JSON.stringify(reqBody)
    }).then(function (res) {
      if (res.status === 501) return legacySave();                 // bridge not deployed
      if (res.status === 503 || res.status === 429) {
        // "busy" comes in two flavors the Worker distinguishes: a brief burst throttle
        // (retry-worthy) vs the free DAILY browser budget being spent (nothing works
        // until the next UTC day). For the daily case, still save the work TODAY under
        // an app-only legacy code — unless this session is already tied to a REDCap
        // record, where a legacy code would silently orphan it.
        return res.json().then(function (j) { return j; }, function () { return null; }).then(function (j) {
          if (j && j.reason === 'daily_limit') {
            if (currentCode && currentCodeViaBridge) throw new Error('bridge_daily_limit');
            return legacySave().then(function (r) { r.dailyLimited = true; return r; });
          }
          throw new Error('bridge_busy');
        });
      }
      if (!res.ok) throw new Error('bridge_failed');
      return res.json().then(function (j) {
        if (!j || !j.code) throw new Error('bridge_failed');
        currentCode = j.code; currentCodeViaBridge = true;
        // Cache the full three-form state under the REDCap code (best-effort — the REDCap
        // chart save already succeeded even if this side blob fails). currentCode stays the
        // BARE REDCap code (what REDCap knows + what a re-save sends back); the user-facing
        // code appends this record's key.
        return storeBlob(j.code, currentKey).then(function (stored) {
          return { code: j.code + '.' + currentKey, verified: !!j.verified, mismatches: j.mismatches || [], viaBridge: true, blobStored: stored };
        });
      });
    }, function () {
      // Network-unreachable. If this session is already tied to a REDCap record,
      // DON'T silently mint a new app-only legacy code (that would orphan the REDCap
      // record and hand back a code that won't work there). Surface a clear error;
      // the data is still safe in the tab. Only fall back to legacy for a genuinely
      // app-only session (no bridge code yet).
      if (currentCode && currentCodeViaBridge) return Promise.reject(new Error('bridge_failed'));
      return legacySave();
    });
  }
  // Legacy app-only save: encrypt all three forms, upload ciphertext, get a random id.
  // (This code is NOT a REDCap code — mark provenance so a later save doesn't try to
  // resume it as one.) Matches the original pre-bridge behavior: a new id per save.
  function legacySave() {
    currentCodeViaBridge = false;
    if (!currentKey) currentKey = window.FBCRYPTO.keyToCode(window.FBCRYPTO.generateKeyBytes());
    var keyBytes = window.FBCRYPTO.keyFromCode(currentKey);
    return window.FBCRYPTO.encryptWithKey(gatherAll(), keyBytes).then(function (e) {
      return window.FBCRYPTO.dtokFromKeyBytes(keyBytes).then(function (dtok) {
        return fetch(SAVE_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ct: e.ct, iv: e.iv, dtok: dtok }) })
          .then(function (res) { if (!res.ok) throw new Error('save_failed'); return res.json(); })
          .then(function (j) { if (!j || !j.id) throw new Error('save_failed'); currentCode = j.id; currentCodeViaBridge = false; return { code: j.id + '.' + currentKey, viaBridge: false }; });
      });
    });
  }
  // Resume by code. Fast path: the encrypted blob (full three forms). If there is no
  // blob for this code (e.g. it was minted on the REDCap side), fall back to the
  // bridge, which resumes the response in REDCap and scrapes the chart values back.
  function cloudRestore(code) {
    var parsed = window.FBCRYPTO ? window.FBCRYPTO.splitCode(code) : { id: '', key: '' };
    if (!parsed.id) return Promise.resolve({ ok: false, reason: 'badcode' });
    return fetch(SAVE_API + '?id=' + encodeURIComponent(parsed.id)).then(function (res) {
      if (res.ok) {
        // A blob exists: decrypt it with the record key carried in the code (after the dot).
        return res.json().then(function (j) {
          if (!parsed.key) return { ok: false, reason: 'nokey' };
          return window.FBCRYPTO.decryptWithKey(j.ct, j.iv, window.FBCRYPTO.keyFromCode(parsed.key)).then(function (data) {
            return applyRestored(data, parsed.id, parsed.key);
          }, function () { return { ok: false, reason: 'decrypt' }; });
        });
      }
      if (res.status !== 404) return { ok: false, reason: 'server' };
      // No blob for this code: it may be a REDCap-native code (never saved through the app).
      // Ask the bridge to resume it in REDCap and scrape the chart back. That path is
      // authorized by the gate passphrase (x-fb-pass), not a record key.
      var pp = getPassphrase();
      if (CFG.requirePassphrase && pp == null) return { ok: false, reason: 'nopass' };
      return restoreViaBridge(parsed.id, pp);
    }, function () { return { ok: false, reason: 'network' }; });
  }
  // Apply a decrypted blob to all three forms and record this session's code/key/provenance.
  function applyRestored(data, id, key) {
    if (data && data.chart) setState(data.chart);
    try { if (data && data.hhr && window.HHR && window.HHR.setState) window.HHR.setState(data.hhr); } catch (e) {}
    try { if (data && data.ilop && window.ILOP && window.ILOP.setState) window.ILOP.setState(data.ilop); } catch (e) {}
    currentCode = id; currentKey = key; currentCodeViaBridge = !!(data && data.bridge); dirty = true;
    return { ok: true, viaBridge: false };
  }
  // No blob for this code: ask the bridge to resume it in REDCap and return the
  // chart field values, then repopulate the chart form (the calculators have no
  // saved data for a REDCap-born code, so they are reset to honor "replace all").
  function restoreViaBridge(id, pp) {
    return fetch(CODE_API + '?code=' + encodeURIComponent(id), { headers: { 'x-fb-pass': pp || '' } }).then(function (res) {
      if (res.status === 404 || res.status === 501) return { ok: false, reason: 'notfound' };
      if (res.status === 503 || res.status === 429) {
        return res.json().then(function (j) { return j; }, function () { return null; })
          .then(function (j) { return { ok: false, reason: (j && j.reason === 'daily_limit') ? 'daily' : 'busy' }; });
      }
      if (!res.ok) return { ok: false, reason: 'server' };
      return res.json().then(function (j) {
        setState(FB.recordToState(DICT, (j && j.values) || {}));
        try { if (window.HHR && window.HHR.setState) window.HHR.setState({}); } catch (e) {}
        try { if (window.ILOP && window.ILOP.setState) window.ILOP.setState({}); } catch (e) {}
        currentCode = id; currentKey = ''; currentCodeViaBridge = true; dirty = true;
        return { ok: true, viaBridge: true };
      });
    }, function () { return { ok: false, reason: 'network' }; });
  }
  // Delete removes only the encrypted side blob. The REDCap record (and its return code)
  // persist — a bridge resume of the code will still work. Deleting a per-record (v3) blob
  // requires proving key possession via dtok = SHA-256(key); a dot-less/legacy code sends none.
  function cloudDelete(code) {
    var parsed = window.FBCRYPTO ? window.FBCRYPTO.splitCode(code) : { id: '', key: '' };
    if (!parsed.id) return Promise.resolve(false);
    var dtokP = parsed.key
      ? window.FBCRYPTO.dtokFromKeyBytes(window.FBCRYPTO.keyFromCode(parsed.key))
      : Promise.resolve('');
    return dtokP.then(function (dtok) {
      var qs = '?id=' + encodeURIComponent(parsed.id) + (dtok ? '&dtok=' + encodeURIComponent(dtok) : '');
      return fetch(SAVE_API + qs, { method: 'DELETE' }).then(function (res) { return res.ok; }, function () { return false; });
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    try {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select(); var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta); return Promise.resolve(!!ok);
    } catch (e) { return Promise.resolve(false); }
  }
  function flashGlobal(msg, kind) {
    var s = $('save-status'); if (!s) return;
    s.className = 'submit-status' + (kind ? ' ' + kind : ''); s.textContent = msg;
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(function () { s.textContent = ''; s.className = 'submit-status'; }, 4000);
  }

  function openModal(title) {
    var overlay = el('div', 'fb-modal');
    var card = el('div', 'fb-modal-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', title);
    var head = el('div', 'fb-modal-head'); head.appendChild(el('strong', null, title));
    head.appendChild(el('span', 'actionbar-spacer'));
    var x = el('button', 'btn btn-ghost btn-sm', 'Close'); x.type = 'button'; x.addEventListener('click', close); head.appendChild(x);
    card.appendChild(head);
    var body = el('div', 'fb-modal-body'); card.appendChild(body);
    overlay.appendChild(card);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    function close() { document.removeEventListener('keydown', onKey); if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.body.appendChild(overlay);
    return { body: body, close: close };
  }
  function onSaveClick() {
    var m = openModal('Save & get code');
    if (!window.FBCRYPTO || !window.FBCRYPTO.available) {
      m.body.appendChild(el('p', 'hint', 'Saving needs a secure browser feature (Web Crypto) that is unavailable here. Your entries are still in this tab.'));
      return;
    }
    m.body.appendChild(el('p', 'hint', currentCode ? 'Saving to REDCap…' : 'Saving to REDCap and encrypting…'));
    cloudSave().then(function (r) {
      var code = r.code;
      m.body.textContent = '';
      m.body.appendChild(el('p', null, r.viaBridge
        ? 'Your code (works in this app AND on the REDCap form):'
        : 'Your save code (works on any computer):'));
      var row = el('div', 'fb-code');
      var codeEl = el('span', 'fb-code-val', code); codeEl.setAttribute('aria-label', 'Save code');
      row.appendChild(codeEl);
      var copy = el('button', 'btn btn-sm', 'Copy'); copy.type = 'button';
      copy.addEventListener('click', function () { copyText(code).then(function (ok) { copy.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); }); });
      row.appendChild(copy);
      m.body.appendChild(row);
      if (r.viaBridge) {
        m.body.appendChild(el('p', 'hint', 'Write this code down. The part BEFORE the dot is REDCap’s own “Save & Return Later” return code — enter just that part on the real REDCap survey (Returning? → enter code) to continue there. Paste the WHOLE code (including the dot and everything after it) here to bring all three forms back.'));
        if (r.verified) {
          m.body.appendChild(el('p', 'ok', '✓ Verified: every field was saved into REDCap exactly as entered.'));
        } else {
          var warn = el('p', 'field-warn'); warn.hidden = false;
          warn.textContent = '⚠ Saved, but we could not confirm ' + ((r.mismatches && r.mismatches.length) ? (r.mismatches.length + ' field(s)') : 'every field') + ' matched in REDCap. Open the REDCap form with this code and review before relying on it.';
          m.body.appendChild(warn);
        }
        if (r.blobStored === false) m.body.appendChild(el('p', 'hint', 'Note: the Hennepin/Iloprost calculator data could not be attached to this code (network). The REDCap chart data is saved.'));
      } else if (r.dailyLimited) {
        m.body.appendChild(el('p', 'hint', 'Write this code down — it brings all three forms back on any computer, in this app only. The free REDCap-save allowance is used up for today (it resets at midnight UTC, 6 PM in Edmonton), so this code will not work on the REDCap form. Resume with it here after the reset and save again to get a REDCap code.'));
      } else {
        m.body.appendChild(el('p', 'hint', 'Write this code down — it brings all three forms back on any computer. (The REDCap bridge is not active, so this code works in this app only, not on the REDCap form.) Encrypted in your browser; stays saved until you delete it.'));
      }
      flashGlobal(r.viaBridge && !r.verified ? '⚠ Saved — verify in REDCap.' : '✓ Saved — code ready to copy.', r.viaBridge && !r.verified ? 'warn' : 'ok');
    }, function (err) {
      m.body.textContent = '';
      var msg = (err && err.message === 'no_passphrase')
        ? 'Saving needs the access passphrase. Unlock the page with the passphrase, then try again.'
        : (err && err.message === 'bridge_busy')
        ? 'The REDCap save service is busy right now (too many at once). Wait a few seconds and try again.'
        : (err && err.message === 'bridge_daily_limit')
        ? 'The free REDCap-save allowance is used up for today, and this session is tied to an existing REDCap record, so saving it elsewhere would split it. Your entries are safe in this tab — leave it open and save after midnight UTC (6 PM in Edmonton), or export/print now.'
        : (err && err.message === 'bridge_failed')
        ? 'Could not save into REDCap — the survey did not accept the data. Nothing was saved there; try again, or review the form.'
        : 'Could not save — no connection to the save service. Check your network and try again. (Saving runs on redcaphelper.haddeya.com.)';
      m.body.appendChild(el('p', 'hint', msg));
    });
  }
  function onResumeClick() {
    var m = openModal('Resume from code');
    var body = m.body;
    body.appendChild(el('p', null, 'Paste a save code — from this app or a REDCap “Save & Return Later” return code:'));
    var row = el('div', 'fb-code');
    var inp = el('input', 'input fb-code-in'); inp.type = 'text'; inp.placeholder = 'paste your save code'; inp.maxLength = 80; inp.autocomplete = 'off';
    inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('spellcheck', 'false');
    inp.setAttribute('aria-label', 'Save code');
    row.appendChild(inp); body.appendChild(row);
    body.appendChild(el('p', 'hint', 'Paste the whole code, including anything after the dot — that part is what unlocks your saved data.'));
    var actions = el('div', 'fb-code-actions');
    var go = el('button', 'btn btn-primary btn-sm', 'Resume'); go.type = 'button';
    var del = el('button', 'btn btn-ghost btn-sm', 'Delete this saved copy'); del.type = 'button';
    actions.appendChild(go); actions.appendChild(del); body.appendChild(actions);
    var status = el('p', 'hint fb-resume-status'); body.appendChild(status);
    var busy = false;
    function doRestore() {
      if (busy) return;
      if (dirty && !confirm('Resuming will replace what is currently entered in all three forms. Continue?')) return;
      busy = true; status.textContent = 'Fetching and decrypting…';
      cloudRestore(inp.value).then(function (res) {
        busy = false;
        if (res.ok) {
          m.close(); switchTo(0);
          flashGlobal(res.viaBridge ? '✓ Restored from REDCap (chart form).' : '✓ Restored saved form.', 'ok');
          return;
        }
        status.textContent = res.reason === 'notfound' ? 'No saved form for that code (it may have been deleted, or the code is mistyped).'
          : res.reason === 'nopass' ? 'Unlock the page with the access passphrase first, then resume.'
          : res.reason === 'badcode' ? 'Enter the code you were given.'
          : res.reason === 'nokey' ? 'This code is missing the part after the dot that unlocks it — paste the whole code you were given.'
          : res.reason === 'decrypt' ? 'Could not unlock this save — check that you pasted the whole code exactly, including the part after the dot.'
          : res.reason === 'busy' ? 'The REDCap bridge is busy right now (it opens a browser to fetch your data). Wait a few seconds and try again.'
          : res.reason === 'daily' ? 'The free REDCap-fetch allowance is used up for today. REDCap codes can be resumed again after midnight UTC (6 PM in Edmonton). Codes saved from this app still work now.'
          : res.reason === 'server' ? 'The save service had a problem fetching this code. Wait a moment and try again.'
          : 'Could not reach the save service. Check your network and try again.';
      });
    }
    function doDelete() {
      if (busy) return;
      if (!window.FBCRYPTO || !window.FBCRYPTO.splitCode(inp.value).id) { status.textContent = 'Enter the code you want to delete first.'; return; }
      if (!confirm('Delete this saved copy from the server now? This cannot be undone.')) return;
      busy = true; status.textContent = 'Deleting…';
      cloudDelete(inp.value).then(function (ok) { busy = false; status.textContent = ok ? 'Deleted from the server.' : 'Could not delete (check your network).'; });
    }
    go.addEventListener('click', doRestore);
    del.addEventListener('click', doDelete);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doRestore(); } });
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 30);
  }
  // Export the current Chart Audit as a readable CSV/XLSX. Opens a small dialog with the
  // format + a few options and a LIVE preview of the exact rows that will be written, then
  // downloads the file. Nothing leaves the browser — it reuses the readable-export logic in
  // export.js (FBX) and the same visible state the submit path (openRedcap) builds from.
  function buildExportRows(opts) {
    var visible = state._visible || FB.computeVisibility(DICT, state);
    return FBX.toReadableRows(DICT, { values: state.values, checked: state.checked, visible: visible }, opts);
  }
  function cleanExportName(s) {
    var base = String(s || '').replace(/\.(csv|xlsx)$/i, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
    return base || 'chart-audit';
  }
  function onExportClick() {
    if (!FBX) return;
    // Flush a value being typed into state first (mirrors the submit path's reliance on change).
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}

    var m = openModal('Export Chart Audit');
    var body = m.body;
    try { body.parentNode.classList.add('fb-modal-wide'); } catch (e) {}
    body.appendChild(el('p', 'hint', 'Download a readable copy of this Chart Audit — one row per question, answers in plain words. Nothing leaves your browser.'));

    // Format (CSV / XLSX)
    var fmtLine = el('div', 'fb-export-line');
    fmtLine.appendChild(el('span', 'fb-export-lab', 'Format'));
    var fmtOpts = el('div', 'opts');
    function fmtOpt(val, text, on) {
      var lab = el('label', 'opt');
      var i = document.createElement('input'); i.type = 'radio'; i.name = 'fb-exp-fmt'; i.value = val; if (on) i.checked = true;
      lab.appendChild(i); lab.appendChild(document.createTextNode(text));
      return lab;
    }
    fmtOpts.appendChild(fmtOpt('csv', 'CSV (.csv)', true));
    fmtOpts.appendChild(fmtOpt('xlsx', 'Excel (.xlsx)', false));
    fmtLine.appendChild(fmtOpts);
    body.appendChild(fmtLine);

    // Options
    function checkOpt(text) {
      var lab = el('label', 'opt');
      var i = document.createElement('input'); i.type = 'checkbox';
      lab.appendChild(i); lab.appendChild(document.createTextNode(text));
      return { label: lab, input: i };
    }
    var oEmpty = checkOpt('Include unanswered fields');
    var oHidden = checkOpt('Include fields skipped by branching');
    var oVar = checkOpt('Include REDCap variable names');
    var optWrap = el('div', 'opts opts-vertical fb-export-opts');
    optWrap.appendChild(oEmpty.label); optWrap.appendChild(oHidden.label); optWrap.appendChild(oVar.label);
    body.appendChild(optWrap);

    // File name
    var fnLab = el('label', 'fb-export-lab', 'File name'); fnLab.setAttribute('for', 'fb-exp-name');
    body.appendChild(fnLab);
    var fname = el('input', 'input'); fname.type = 'text'; fname.id = 'fb-exp-name'; fname.autocomplete = 'off';
    var sn = String(state.values.study_number || '').trim();
    fname.value = 'chart-audit_' + (sn ? sn + '_' : '') + new Date().toISOString().slice(0, 10);
    body.appendChild(fname);

    // Live preview
    var pvCap = el('div', 'fb-export-lab fb-export-pvcap', 'Preview');
    body.appendChild(pvCap);
    var pv = el('div', 'fb-export-preview');
    body.appendChild(pv);

    function curOpts() { return { includeEmpty: oEmpty.input.checked, includeHidden: oHidden.input.checked, includeVar: oVar.input.checked }; }
    function curFmt() { var r = body.querySelector('input[name=fb-exp-fmt]:checked'); return r ? r.value : 'csv'; }
    function renderPreview() {
      var rows = buildExportRows(curOpts());
      var n = rows.length - 1;
      var ext = curFmt() === 'xlsx' ? '.xlsx' : '.csv';
      pvCap.textContent = 'Preview — ' + n + (n === 1 ? ' field · ' : ' fields · ') + cleanExportName(fname.value) + ext;
      pv.textContent = '';
      if (n === 0) { pv.appendChild(el('p', 'hint', 'No fields to export yet. Fill in some answers, or tick “Include unanswered fields”.')); return; }
      var table = el('table', 'fb-export-table');
      var thead = el('thead'), htr = el('tr');
      rows[0].forEach(function (h) { htr.appendChild(el('th', null, h)); });
      thead.appendChild(htr); table.appendChild(thead);
      var tbody = el('tbody'), LIMIT = 300;
      rows.slice(1, 1 + LIMIT).forEach(function (r) {
        var tr = el('tr');
        r.forEach(function (c) { tr.appendChild(el('td', null, c)); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody); pv.appendChild(table);
      if (n > LIMIT) pv.appendChild(el('p', 'hint', 'Showing the first ' + LIMIT + ' of ' + n + ' rows; the file includes all of them.'));
    }

    // Actions
    var status = el('p', 'hint');
    var actions = el('div', 'fb-code-actions');
    var go = el('button', 'btn btn-primary btn-sm', 'Download'); go.type = 'button';
    actions.appendChild(go); body.appendChild(actions); body.appendChild(status);

    function onDownload() {
      var rows = buildExportRows(curOpts());
      if (rows.length <= 1) { status.className = 'hint'; status.textContent = 'Nothing to export yet — fill in some fields first (or tick “Include unanswered fields”).'; return; }
      var base = cleanExportName(fname.value);
      if (curFmt() === 'xlsx') {
        go.disabled = true; var prev = go.textContent; go.textContent = 'Preparing…'; status.className = 'hint'; status.textContent = '';
        FBX.downloadXlsx(base + '.xlsx', rows).then(function () {
          m.close(); flashGlobal('✓ Exported ' + base + '.xlsx', 'ok');
        }, function () {
          go.disabled = false; go.textContent = prev;
          status.className = 'hint'; status.textContent = 'Could not build the Excel file. Please try CSV instead.';
        });
      } else {
        FBX.downloadCsv(base + '.csv', rows);
        m.close(); flashGlobal('✓ Exported ' + base + '.csv', 'ok');
      }
    }

    body.querySelectorAll('input[name=fb-exp-fmt]').forEach(function (r) { r.addEventListener('change', renderPreview); });
    [oEmpty.input, oHidden.input, oVar.input].forEach(function (i) { i.addEventListener('change', renderPreview); });
    fname.addEventListener('input', renderPreview);
    go.addEventListener('click', onDownload);
    renderPreview();
  }

  function initSaveBar() {
    var bar = $('savebar'); if (!bar || bar._wired) return; bar._wired = true;
    bar.hidden = false;
    var bs = $('btn-save'); if (bs) bs.addEventListener('click', onSaveClick);
    var br = $('btn-resume'); if (br) br.addEventListener('click', onResumeClick);
  }

  // ---------------- live-version auto-updater ----------------
  // The zone forces a browser cache on the JS, and a tab left open never re-fetches it,
  // so it can run stale code indefinitely. We read the build token this page loaded with,
  // then poll the always-fresh index.html for the current token (on load, on focus/visibility,
  // and every 2 min). On a new deploy we refresh — silently when nothing is entered, or via a
  // clear banner when there is unsaved work, so entered data is never lost.
  var BUILD = (function () {
    var s = document.querySelector('script[src*="app.js"]');
    var m = s && /[?&]v=([^&"']+)/.exec(s.getAttribute('src') || '');
    return m ? m[1] : null;
  })();
  var updateHandled = false;
  function anyDirty() {
    try {
      if (dirty) return true;
      if (window.HHR && window.HHR.isDirty && window.HHR.isDirty()) return true;
      if (window.ILOP && window.ILOP.isDirty && window.ILOP.isDirty()) return true;
    } catch (e) {}
    return false;
  }
  function showUpdateBar() {
    if ($('fb-update')) return;
    var bar = el('div', 'fb-update'); bar.id = 'fb-update'; bar.setAttribute('role', 'alert');
    bar.appendChild(el('span', 'fb-update-msg', 'A newer version of this tool is available — refresh to use it.'));
    var b = el('button', 'btn btn-sm', 'Refresh now'); b.type = 'button';
    b.addEventListener('click', function () { try { location.reload(); } catch (e) {} });
    bar.appendChild(b);
    document.body.appendChild(bar);
  }
  function onNewVersion() {
    if (updateHandled) return; updateHandled = true;
    if (!anyDirty()) { try { location.reload(); } catch (e) {} return; }
    showUpdateBar();
  }
  function checkForUpdate() {
    if (!BUILD || updateHandled) return;
    fetch('/?_=' + (new Date()).getTime(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) { if (html) { var m = /app\.js\?v=([^&"']+)/.exec(html); if (m && m[1] !== BUILD) onNewVersion(); } })
      .catch(function () {});
  }
  function wireUpdater() {
    if (wireUpdater._on || !BUILD) return; wireUpdater._on = true;
    window.addEventListener('focus', checkForUpdate);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkForUpdate(); });
    // Skip the polling timers under jsdom (test env) so the test process can exit; a real
    // browser (no "jsdom" in its user-agent) polls on load and every 2 min as intended.
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return;
    setTimeout(checkForUpdate, 8000);
    setInterval(checkForUpdate, 120000);
  }
  window.__fbCheckUpdate = checkForUpdate; // exposed for tests

  if (document.readyState !== 'loading') initGate();
  else document.addEventListener('DOMContentLoaded', initGate);
})();
