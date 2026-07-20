/**
 * Frostbite REDCap Helper — tabbed view (CSS show/hide)
 *
 * GOAL
 * ----
 * Turn one long, awkwardly-sectioned REDCap survey into a small set of clean
 * tabs you switch between at the top. The survey's own section headers are
 * misplaced (almost every treatment/med/imaging/follow-up field falls under a
 * single "NSAIDS" header), which is why related questions felt scattered. We
 * regroup by REAL field name into 7 logical tabs.
 *
 * SAFETY MODEL (branching-safe by construction)
 * ---------------------------------------------
 * We do NOT move, reparent, clone, or reorder any REDCap node. Every field
 * stays exactly where REDCap rendered it, inside #questiontable, in original
 * order. Tabs are implemented purely by SHOWING/HIDING rows with a CSS class
 * (display:none on rows not in the active tab). REDCap resolves fields by ID and
 * does not care whether a row is display:none, so branching keeps working and
 * REDCap's own branch-driven hiding still applies on top of ours.
 *
 * DATE WIDGET
 * -----------
 * No MutationObserver on the form, no 'input' listener. We recompute the
 * required-field tracker only on 'change'. (An earlier build observed the form
 * subtree and re-entered REDCap's date picker, causing a dead "Today" button and
 * a jump to 2099. Not here.)
 *
 * PRIVACY/SECURITY
 *   - No network (fetch/XHR/sendBeacon/WebSocket), no storage (localStorage/
 *     sessionStorage/IndexedDB/cookies), never reads/logs field VALUES, never
 *     innerHTML on REDCap content, never cloneNode, never auto-submits.
 */

(function () {
  'use strict';

  var DEBUG = false;

  var TARGET_HOST = 'redcap.ualberta.ca';
  var TARGET_PATH = '/surveys/';
  var SURVEY_KEY = 'RLREFHHMMWXAEPJJ';

  var HTML_MOUNT_ATTR = 'data-fbh-mounted';
  var ROW_TAB_ATTR = 'data-fbh-tab';   // tab id assigned to each structural row

  var TITLE_PHRASES = [
    'high-grade frostbite', 'high grade frostbite',
    'amputation rates in high', 'frostbite injuries in two canadian',
    'management strategies and amputation'
  ];

  var MIN_QUESTIONS = 20;
  var WAIT_MAX_MS = 15000;
  var WAIT_INTERVAL_MS = 250;

  // -------------------------------------------------------------------------
  // TAB DEFINITIONS — by REAL field name (sq_id), from the live survey.
  // Order within each tab follows the survey's natural order unless a field is
  // explicitly pulled into a different tab (e.g. all meds into "Medications").
  // Matrix groups are referenced by their mtxgrp via the matrix rows' names.
  // Any field NOT listed here is auto-assigned to a tab by its position
  // (it inherits the tab of the previous classified row) so nothing is lost.
  // -------------------------------------------------------------------------
  var TABS = [
    {
      id: 'patient', label: 'Patient & Demographics',
      fields: ['study_number', 'date_of_birth', 'sex', 'weight', 'smoking_history',
               'alcohol_use', 'substance_use_disorder', 'diabetes', 'pvd']
    },
    {
      id: 'presentation', label: 'Presentation & Assessment',
      fields: ['time_of_ed_arrival', 'initial_ed_name', 'md_assessment_time', 'cedis_complaint',
               'duration_of_cold_exposure', 'cold_exposure_comments', 'minimal_temperature',
               'maximum_temperature', 'freeze_thaw_cycles', 'freeze_thaw_cycle_comments',
               'activities_leading_to_frostbite', 'other_activity_frost_bite',
               'comments_activity_frostbite', 'ems_arrival', 'ems_temperature',
               'interfacility_transfer', 'receiving_hospital_name', 'patient_temperature',
               'rewarming_time', 'rewarmingcomments', 'admission', 'admitting_diagnosis',
               'limb_frostbite', 'other_frostbite_areas']
    },
    {
      id: 'grading', label: 'Frostbite Grading',
      // 4 matrices (right_hand/left_hand/right_foot/left_foot) + their comments,
      // plus the change-in-grading questions.
      fields: ['right_hand_comment', 'left_hand_comment', 'right_foot_comments', 'left_foot_comments',
               'frostbite_grade_change', 'limb_frostbite_ra', 'grading_change'],
      matrixGroups: ['right_hand', 'left_hand', 'right_foot', 'left_foot']
    },
    {
      id: 'amputation', label: 'Amputation',
      fields: ['limb_amputation', 'additional_frostbite'],
      matrixGroups: ['digit_amputation']
    },
    {
      id: 'medications', label: 'Medications',
      // Pain control -> frostbite drugs -> prophylaxis. Pulled together from
      // across the survey's mislabeled headers.
      fields: [
        // pain control
        'warming_techniques', 'other_warming_techniques',
        'other_nsaid_dose', 'non_nsaid_pain',
        // frostbite drugs: iloprost (note inconsistent illoprost/iloprost spelling)
        'illoprost_administration', 'iloprost_dose', 'illoprost_not_given',
        'other_reason_illoprost_not_given', 'illoprost_contraindication',
        'other_illoprost_contained', 'illoprost_administration_time',
        'total_doses_of_illoprost', 'ae_iloprost', 'other_ae_iloprost',
        // alteplase
        'alteplase', 'alteplase_time', 'alteplase_bolus', 'alteplase_infusion',
        'alteplase_duration', 'ae_alteplase', 'other_reaction_alteplase',
        'alteplase_not_given', 'alteplase_contraindication', 'alteplase_other_contraind',
        'alteplase_not_given_other',
        // heparin
        'heparin', 'heparin_time', 'heparin_dose',
        // prophylaxis / adjuncts
        'tetanus', 'systemic_antibiotics', 'antibiotic', 'aloe_vera', 'nsaid'
      ],
      matrixGroups: ['nsaid']
    },
    {
      id: 'imaging', label: 'Imaging & Consults',
      // wound_care_mgmt + bandage_non_wound_care are the two branches of
      // wound_care_consult (used-by vs not-by wound care); keep both on this page.
      fields: ['imaging', 'xray_findings', 'ct_findings', 'mri_findings', 'bone_scan_findings',
               'other_image_and_findings', 'surgical_consult', 'other_surgical_consult',
               'wound_care_consult', 'wound_care_mgmt', 'bandage_non_wound_care']
    },
    {
      id: 'followup', label: 'Disposition & Follow-up',
      fields: ['rehab', 'rehab_details', 'hennepin_score',
               'insecure_housing', 'insecure_housing_details', 'ed_repeat_visits',
               'repeat_visit_reason', 'admission_repeat_visits', 'repeat_admission_reason',
               'return_to_function', 'return_to_function_comments', 'followup',
               'no_followup', 'followup_comments']
    }
  ];

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  var state = {
    form: null, table: null, tbody: null,
    rows: [],                 // all structural rows (live nodes), original order
    units: [],                // [{ rows:[tr...], tabId, required }]
    submitRow: null,
    fieldToTab: {},           // field name -> tab id
    mtxToTab: {},             // mtxgrp -> tab id
    activeTab: null,
    root: null,
    tabBar: null,
    progressFill: null, progressCount: null, progressMissing: null,
    missingPanel: null, missingList: null,
    tabButtons: {},           // tabId -> { btn, badge }
    updateTimer: 0,
    _missing: []
  };

  function log() { if (DEBUG) { var a = Array.prototype.slice.call(arguments); a.unshift('[FBH]'); console.log.apply(console, a); } }

  // -------------------------------------------------------------------------
  // Detection / readiness
  // -------------------------------------------------------------------------
  function isTargetSurvey() {
    if (location.hostname !== TARGET_HOST) return false;
    if (location.pathname.indexOf(TARGET_PATH) !== 0) return false;
    if ((location.href || '').indexOf(SURVEY_KEY) !== -1) return true;
    var hay = ((document.title || '') + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();
    for (var i = 0; i < TITLE_PHRASES.length; i++) if (hay.indexOf(TITLE_PHRASES[i]) !== -1) return true;
    return false;
  }
  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(fn, 0);
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  function waitForSurvey() {
    return new Promise(function (resolve) {
      var start = Date.now(), settled = false, observer = null;
      function cleanup() { clearInterval(timer); if (observer) { try { observer.disconnect(); } catch (e) {} } }
      function check() {
        if (settled) return;
        var form = findForm(); var table = form ? findQuestionTable(form) : null;
        if (form && table) {
          var rows = findStructuralRows(table);
          if (rows.length >= MIN_QUESTIONS) { settled = true; cleanup(); resolve({ form: form, table: table, rows: rows }); return; }
        }
        if (Date.now() - start > WAIT_MAX_MS) { settled = true; cleanup(); var t = table || (form ? findQuestionTable(form) : null); resolve({ form: form, table: t, rows: t ? findStructuralRows(t) : [] }); }
      }
      var timer = setInterval(check, WAIT_INTERVAL_MS);
      try { observer = new MutationObserver(check); observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
      check();
    });
  }

  // -------------------------------------------------------------------------
  // Locate (READ ONLY)
  // -------------------------------------------------------------------------
  function findForm() {
    var form = document.querySelector('form#form, form[name="form"]');
    if (form && form.querySelector('#questiontable')) return form;
    var qt = document.getElementById('questiontable');
    if (qt && qt.closest) { var f = qt.closest('form'); if (f) return f; }
    return form || null;
  }
  function findQuestionTable(form) {
    if (!form) return document.getElementById('questiontable');
    return form.querySelector('#questiontable') || form.querySelector('table.form_border') || form.querySelector('table');
  }
  function getTbody(table) { return table.querySelector('tbody.formtbody') || table.querySelector('tbody') || table; }
  function findStructuralRows(table) {
    if (!table) return [];
    var tbody = getTbody(table), out = [], kids = tbody.children;
    for (var i = 0; i < kids.length; i++) if (kids[i].tagName === 'TR') out.push(kids[i]);
    return out;
  }
  function isSectionHeaderRow(tr) { return /-sh-tr$/.test(tr.id || '') || !!tr.querySelector(':scope > td.header'); }
  function getMatrixGroup(tr) { return tr.getAttribute('mtxgrp') || null; }
  function isSurveySubmitRow(tr) { return tr.classList && tr.classList.contains('surveysubmit'); }

  function rowFieldName(tr) {
    var sq = tr.getAttribute('sq_id');
    if (sq && sq !== '{}') return sq.toLowerCase();
    var id = tr.id || ''; var m = id.match(/^(.+)-tr$/);
    if (m) return m[1].toLowerCase();
    var grp = getMatrixGroup(tr); if (grp) return grp.toLowerCase();
    var input = tr.querySelector('input[name], select[name], textarea[name]');
    if (input) return String(input.getAttribute('name') || '').replace(/\[.*$/, '').replace(/___.*$/, '').toLowerCase();
    return '';
  }
  function isRequiredRow(tr) {
    if (!tr || tr.nodeType !== 1) return false;
    if (tr.getAttribute && tr.getAttribute('req') === '1') return true;
    if (tr.querySelector && tr.querySelector('.requiredlabel')) return true;
    return (tr.textContent || '').toLowerCase().indexOf('must provide value') !== -1;
  }

  // -------------------------------------------------------------------------
  // Text (READ ONLY)
  // -------------------------------------------------------------------------
  function textOf(el) {
    if (!el) return '';
    var parts = [], walker;
    try {
      walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var p = node.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT;
          if (p.closest('.fbh-root')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
    } catch (e) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
    for (var n = walker.nextNode(); n; n = walker.nextNode()) { var s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim(); if (s) parts.push(s); }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  function questionLabel(tr) {
    var labelCell = tr.querySelector('.labelrc, .labelmatrix, label');
    var raw = labelCell ? textOf(labelCell) : textOf(tr);
    return raw.replace(/must provide value/ig, ' ').replace(/\*+/g, ' ')
      .replace(/\b(reset|today|now|expand)\b/ig, ' ').replace(/D-M-Y(\s*H:M)?/ig, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // -------------------------------------------------------------------------
  // Assign every row to a tab
  // -------------------------------------------------------------------------
  function buildTabMaps() {
    for (var t = 0; t < TABS.length; t++) {
      var tab = TABS[t];
      for (var f = 0; f < tab.fields.length; f++) state.fieldToTab[tab.fields[f].toLowerCase()] = tab.id;
      if (tab.matrixGroups) for (var g = 0; g < tab.matrixGroups.length; g++) state.mtxToTab[tab.matrixGroups[g].toLowerCase()] = tab.id;
    }
  }

  // Returns tab id for a row, or null if unclassified.
  function tabForRow(tr) {
    var grp = getMatrixGroup(tr);
    if (grp && state.mtxToTab[grp.toLowerCase()]) return state.mtxToTab[grp.toLowerCase()];
    var name = rowFieldName(tr);
    if (name && state.fieldToTab[name]) return state.fieldToTab[name];
    return null;
  }

  // Build units (single rows + matrix groups), each tagged with a tab. Unknown
  // rows inherit the previous classified row's tab so nothing disappears.
  function buildUnits(rows) {
    var units = [];
    var lastTab = TABS[0].id;
    var i = 0;
    while (i < rows.length) {
      var tr = rows[i];
      if (isSurveySubmitRow(tr)) { state.submitRow = tr; i++; continue; }
      if (isSectionHeaderRow(tr)) { i++; continue; } // we drop REDCap's own headers from tabs (we use our tabs instead); they'll be hidden
      var grp = getMatrixGroup(tr);
      if (grp) {
        var groupRows = [];
        while (i < rows.length && getMatrixGroup(rows[i]) === grp) { groupRows.push(rows[i]); i++; }
        var tabId = state.mtxToTab[grp.toLowerCase()] || lastTab;
        lastTab = tabId;
        units.push({ rows: groupRows, tabId: tabId, required: anyRequired(groupRows), kind: 'matrix', group: grp });
        continue;
      }
      var explicit = tabForRow(tr);
      var tid = explicit || lastTab;
      lastTab = tid;
      units.push({ rows: [tr], tabId: tid, required: isRequiredRow(tr), kind: 'single' });
      i++;
    }
    return units;
  }
  function anyRequired(rows) { for (var i = 0; i < rows.length; i++) if (isRequiredRow(rows[i])) return true; return false; }

  // -------------------------------------------------------------------------
  // Apply tab visibility (CSS class only; rows never move)
  // -------------------------------------------------------------------------
  function applyTab(tabId) {
    state.activeTab = tabId;
    for (var u = 0; u < state.units.length; u++) {
      var unit = state.units[u];
      var show = unit.tabId === tabId;
      for (var r = 0; r < unit.rows.length; r++) {
        unit.rows[r].classList.toggle('fbh-tab-hidden', !show);
      }
    }
    // Hide REDCap's own section header rows entirely (we replace them with tabs).
    for (var s = 0; s < state.rows.length; s++) {
      if (isSectionHeaderRow(state.rows[s])) state.rows[s].classList.add('fbh-tab-hidden');
    }
    // The submit row belongs to no tab; keep it visible on every tab so the
    // user can always submit/save without hunting for it.
    if (state.submitRow) state.submitRow.classList.remove('fbh-tab-hidden');
    // Update tab button states
    for (var id in state.tabButtons) {
      if (!state.tabButtons.hasOwnProperty(id)) continue;
      var on = id === tabId;
      state.tabButtons[id].btn.classList.toggle('fbh-tab-active', on);
      state.tabButtons[id].btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    // Scroll form into view top
    if (state.form) { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {} }
    recompute();
  }

  // -------------------------------------------------------------------------
  // Shell: tab bar + progress + review (our own DOM, sibling to form)
  // -------------------------------------------------------------------------
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(label, cls, id) { var b = document.createElement('button'); b.type = 'button'; b.className = cls || 'fbh-btn'; if (id) b.id = id; b.textContent = label; return b; }

  function createShell() {
    var root = el('div', 'fbh-root'); root.id = 'fbh-root';

    // Top bar: title + actions
    var bar = el('div', 'fbh-topbar');
    var title = el('div', 'fbh-topbar-title');
    title.appendChild(el('strong', null, 'Frostbite Helper'));
    title.appendChild(el('span', 'fbh-topbar-sub', 'Tabbed view \u2014 REDCap still validates & submits'));
    var actions = el('div', 'fbh-topbar-actions');
    var reviewBtn = btn('Review missing', 'fbh-btn fbh-btn-primary', 'fbh-btn-review');
    var submitBtn = btn('Go to Submit', 'fbh-btn', 'fbh-btn-gosubmit');
    actions.appendChild(reviewBtn); actions.appendChild(submitBtn);
    bar.appendChild(title); bar.appendChild(actions);

    // Tabs
    var tabBar = el('div', 'fbh-tabs'); tabBar.setAttribute('role', 'tablist');
    state.tabBar = tabBar;

    // Progress strip
    var prog = el('div', 'fbh-progress');
    prog.setAttribute('aria-live', 'polite');
    var ptrack = el('div', 'fbh-progress-track');
    var pfill = el('div', 'fbh-progress-fill'); pfill.style.width = '0%';
    ptrack.appendChild(pfill);
    var pmeta = el('div', 'fbh-progress-meta');
    var pcount = el('span', 'fbh-progress-count', '0 / 0');
    var pmiss = el('span', 'fbh-progress-missing', '');
    pmeta.appendChild(el('span', 'fbh-progress-label', 'Required fields')); pmeta.appendChild(pcount); pmeta.appendChild(pmiss);
    prog.appendChild(pmeta); prog.appendChild(ptrack);

    // Missing panel (collapsible, below bar)
    var missing = el('div', 'fbh-missing-panel'); missing.hidden = true;
    var mhead = el('div', 'fbh-missing-head');
    mhead.appendChild(el('strong', null, 'Missing required fields'));
    var mclose = btn('Close', 'fbh-btn fbh-btn-ghost', null);
    mhead.appendChild(mclose);
    var mlist = el('ul', 'fbh-missing-list');
    missing.appendChild(mhead); missing.appendChild(mlist);

    root.appendChild(bar);
    root.appendChild(tabBar);
    root.appendChild(prog);
    root.appendChild(missing);

    reviewBtn.addEventListener('click', openMissingReview);
    submitBtn.addEventListener('click', goToSubmit);
    mclose.addEventListener('click', function () { missing.hidden = true; });

    state.root = root;
    state.progressFill = pfill; state.progressCount = pcount; state.progressMissing = pmiss;
    state.missingPanel = missing; state.missingList = mlist;
    return root;
  }

  function buildTabButtons() {
    var bar = state.tabBar;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    // Only render tabs that actually have at least one unit.
    var counts = tabUnitCounts();
    for (var t = 0; t < TABS.length; t++) {
      (function (tab) {
        if (!counts[tab.id]) return;
        var b = btn('', 'fbh-tab', null);
        b.setAttribute('role', 'tab');
        b.appendChild(el('span', 'fbh-tab-label', tab.label));
        var badge = el('span', 'fbh-tab-badge', '');
        b.appendChild(badge);
        b.addEventListener('click', function () { applyTab(tab.id); });
        bar.appendChild(b);
        state.tabButtons[tab.id] = { btn: b, badge: badge };
      })(TABS[t]);
    }
    // Submit pseudo-tab
    var sb = btn('Submit', 'fbh-tab fbh-tab-submit', null);
    sb.addEventListener('click', goToSubmit);
    bar.appendChild(sb);
  }

  function tabUnitCounts() {
    var c = {};
    for (var u = 0; u < state.units.length; u++) c[state.units[u].tabId] = (c[state.units[u].tabId] || 0) + 1;
    return c;
  }

  // -------------------------------------------------------------------------
  // Visibility + completion (READ ONLY)
  // -------------------------------------------------------------------------
  function isRedcapHidden(node) {
    // True if hidden by REDCap (branching) — i.e. display:none from REDCap, not
    // our tab class. We strip our class effect by checking the inline/computed
    // style ignoring fbh-tab-hidden: simplest is to check if it's hidden for a
    // reason other than our class.
    if (!node || !node.isConnected) return true;
    // Temporarily, our tab hiding also sets display:none. To judge REDCap's own
    // hiding we look for REDCap's signals: inline style display none on the row
    // or an ancestor, or @hidden. We DO NOT count our own fbh-tab-hidden.
    for (var n = node; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.classList && n.classList.contains('fbh-tab-hidden')) continue; // ignore our tab hiding
      if (n.hidden) return true;
      var inline = n.style && n.style.display;
      if (inline === 'none') return true;
    }
    return false;
  }
  function pushAll(arr, list) { for (var i = 0; i < list.length; i++) arr.push(list[i]); }
  function unitVisibleForCount(unit) {
    // Count a required unit only if REDCap itself is showing it (branching),
    // regardless of which tab it's on.
    for (var i = 0; i < unit.rows.length; i++) if (!isRedcapHidden(unit.rows[i])) return true;
    return false;
  }
  function unitComplete(unit) {
    var radios = [], checks = [], texts = [], areas = [], selects = [];
    for (var r = 0; r < unit.rows.length; r++) {
      var tr = unit.rows[r];
      pushAll(radios, tr.querySelectorAll('input[type="radio"]'));
      pushAll(checks, tr.querySelectorAll('input[type="checkbox"]'));
      pushAll(texts, tr.querySelectorAll('input[type="text"],input[type="number"],input[type="email"],input[type="tel"],input[type="date"],input[type="time"],input[type="datetime-local"],input:not([type])'));
      pushAll(areas, tr.querySelectorAll('textarea'));
      pushAll(selects, tr.querySelectorAll('select'));
    }
    var saw = false;
    if (radios.length) { saw = true; for (var i = 0; i < radios.length; i++) if (radios[i].checked && !radios[i].disabled) return true; }
    if (checks.length) { saw = true; for (var j = 0; j < checks.length; j++) if (checks[j].checked && !checks[j].disabled) return true; }
    if (selects.length) { saw = true; for (var k = 0; k < selects.length; k++) if ((selects[k].value || '').trim() !== '') return true; }
    for (var x = 0; x < texts.length; x++) { saw = true; if ((texts[x].value || '').trim() !== '') return true; }
    for (var a = 0; a < areas.length; a++) { saw = true; if ((areas[a].value || '').trim() !== '') return true; }
    return !saw;
  }

  // -------------------------------------------------------------------------
  // Optional date prefill
  // Fills specific date/time fields (NOT date_of_birth) with today's day/month
  // and year 2099, ONLY when the field is empty. Sets value + fires events so
  // REDCap validates it. We do NOT touch REDCap's date-picker widget internals.
  // -------------------------------------------------------------------------
  var PREFILL_DATE_FIELDS = ['date_of_birth', 'time_of_ed_arrival', 'md_assessment_time', 'rewarming_time'];
  // Known format per field: date-only ('dmy') vs date+time ('dmy_hm'). DOB is
  // date-only; the three assessment fields are date+time. Anything not listed
  // falls back to format detection.
  var PREFILL_FORMATS = {
    date_of_birth: 'dmy',
    time_of_ed_arrival: 'dmy_hm',
    md_assessment_time: 'dmy_hm',
    rewarming_time: 'dmy_hm'
  };
  var PREFILL_YEAR = 2099;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Build the value string for a field, matching its expected format. REDCap
  // marks datetime fields; we detect date-only vs date-time from the input's
  // format hints, defaulting to date-time "D-M-Y H:M" for the target fields
  // (all three targets are datetime in this survey).
  function prefillValueFor(input, fieldName) {
    var now = new Date();
    var d = pad2(now.getDate()), m = pad2(now.getMonth() + 1), y = PREFILL_YEAR;
    var fmt = (fieldName && PREFILL_FORMATS[fieldName]) || detectDateFormat(input); // 'dmy' | 'dmy_hm'
    if (fmt === 'dmy') return d + '-' + m + '-' + y;
    return d + '-' + m + '-' + y + ' ' + '00:00';
  }

  function detectDateFormat(input) {
    // REDCap encodes the format in attributes/classes like
    // fv=datetime_dmy / class contains 'date_dmy' or 'datetime_dmy'. We look for
    // a time component; if none of the datetime markers are present we treat it
    // as date-only.
    var hay = ((input.className || '') + ' ' +
               (input.getAttribute('fv') || '') + ' ' +
               (input.getAttribute('onblur') || '') + ' ' +
               (input.id || '') + ' ' +
               (input.getAttribute('data-kind') || '')).toLowerCase();
    if (hay.indexOf('datetime') !== -1 || /\bh:m\b/.test(hay) || hay.indexOf('_hm') !== -1) return 'dmy_hm';
    // Also peek at a sibling format hint cell (REDCap prints "D-M-Y H:M").
    var row = input.closest ? input.closest('tr') : null;
    if (row && /d-m-y\s*h:m/i.test(row.textContent || '')) return 'dmy_hm';
    if (row && /d-m-y/i.test(row.textContent || '')) {
      return /h:m/i.test(row.textContent || '') ? 'dmy_hm' : 'dmy';
    }
    return 'dmy_hm';
  }

  function findFieldInput(fieldName) {
    // The text input REDCap uses for a date field is typically id == fieldName
    // or name == fieldName. Avoid hidden mirror inputs.
    var byId = document.getElementById(fieldName);
    if (byId && isVisibleDateInput(byId)) return byId;
    var byName = document.querySelector('input[name="' + cssEscape(fieldName) + '"]');
    if (byName && isVisibleDateInput(byName)) return byName;
    // Fall back: within the field's row, the first text input.
    var row = document.getElementById(fieldName + '-tr');
    if (row) {
      var t = row.querySelector('input[type="text"], input:not([type])');
      if (t) return t;
    }
    return null;
  }
  function isVisibleDateInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' || type === '';
  }
  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function fireValueEvents(input) {
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event('blur', { bubbles: true })); } catch (e) {}
  }

  function prefillDates() {
    var filled = 0;
    for (var i = 0; i < PREFILL_DATE_FIELDS.length; i++) {
      var name = PREFILL_DATE_FIELDS[i];
      var input = findFieldInput(name);
      if (!input) { log('prefill: field not found', name); continue; }
      // Blanks only — never overwrite typed or saved values.
      if ((input.value || '').trim() !== '') { log('prefill: skip non-empty', name); continue; }
      var val = prefillValueFor(input, name);
      try {
        input.value = val;
        fireValueEvents(input);
        filled++;
      } catch (e) { log('prefill: set failed', name, e && e.message); }
    }
    log('prefill: filled', filled, 'of', PREFILL_DATE_FIELDS.length);
  }

  // -------------------------------------------------------------------------
  // Progress + per-tab badges
  // -------------------------------------------------------------------------
  function recompute() {
    if (!state.root) return;
    var totalReq = 0, doneReq = 0, missing = [], per = {};
    for (var t = 0; t < TABS.length; t++) per[TABS[t].id] = { total: 0, done: 0 };

    for (var u = 0; u < state.units.length; u++) {
      var unit = state.units[u];
      if (!unit.required) continue;
      if (!unitVisibleForCount(unit)) continue; // skip branch-hidden
      var complete = unitComplete(unit);
      if (per[unit.tabId]) per[unit.tabId].total++;
      totalReq++;
      if (complete) { doneReq++; if (per[unit.tabId]) per[unit.tabId].done++; }
      else missing.push(unit);

      // Row tint (only meaningful on the visible tab, harmless elsewhere)
      for (var r = 0; r < unit.rows.length; r++) {
        unit.rows[r].classList.remove('fbh-row-complete', 'fbh-row-missing');
        unit.rows[r].classList.add(complete ? 'fbh-row-complete' : 'fbh-row-missing');
      }
    }

    for (var id in state.tabButtons) {
      if (!state.tabButtons.hasOwnProperty(id)) continue;
      var st = per[id] || { total: 0, done: 0 };
      var badge = state.tabButtons[id].badge;
      if (st.total === 0) { badge.textContent = ''; badge.className = 'fbh-tab-badge'; }
      else if (st.done >= st.total) { badge.textContent = '\u2713'; badge.className = 'fbh-tab-badge fbh-tab-badge-done'; }
      else { badge.textContent = String(st.total - st.done); badge.className = 'fbh-tab-badge fbh-tab-badge-warn'; }
    }

    var pct = totalReq > 0 ? Math.round(doneReq / totalReq * 100) : 0;
    state.progressFill.style.width = pct + '%';
    state.progressCount.textContent = doneReq + ' / ' + totalReq;
    var miss = totalReq - doneReq;
    state.progressMissing.textContent = miss > 0 ? ('\u00b7 ' + miss + ' missing') : '\u00b7 all complete';
    state.progressMissing.className = 'fbh-progress-missing' + (miss > 0 ? ' fbh-missing-warn' : '');
    state._missing = missing;
  }

  // -------------------------------------------------------------------------
  // Missing review (jumps to the right tab, then scrolls + highlights)
  // -------------------------------------------------------------------------
  function unitLabel(unit) {
    if (unit.kind === 'matrix') return questionLabel(unit.rows[unit.rows.length - 1]) || ('Matrix: ' + unit.group);
    return questionLabel(unit.rows[0]);
  }
  function tabLabel(id) { for (var t = 0; t < TABS.length; t++) if (TABS[t].id === id) return TABS[t].label; return ''; }
  function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

  function buildMissingList() {
    recompute();
    var list = state.missingList;
    while (list.firstChild) list.removeChild(list.firstChild);
    var missing = state._missing || [];
    if (!missing.length) { list.appendChild(el('li', 'fbh-missing-empty', 'No missing required fields detected. (REDCap still does the final check.)')); return; }
    for (var i = 0; i < missing.length; i++) {
      (function (unit, idx) {
        var li = el('li', 'fbh-missing-item');
        var b = btn('', 'fbh-missing-link', null);
        b.appendChild(el('span', 'fbh-missing-sec', tabLabel(unit.tabId)));
        b.appendChild(el('span', 'fbh-missing-q', truncate(unitLabel(unit) || ('Required field #' + (idx + 1)), 90)));
        b.addEventListener('click', function () {
          if (unit.tabId !== state.activeTab) applyTab(unit.tabId);
          setTimeout(function () { scrollToRow(unit.rows[0]); highlightUnit(unit); }, 60);
        });
        li.appendChild(b); list.appendChild(li);
      })(missing[i], i);
    }
  }
  function openMissingReview() { buildMissingList(); state.missingPanel.hidden = false; state.missingPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  function scrollToRow(row) {
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var f = row.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) { try { f.focus(); } catch (e2) {} } }
  }
  function highlightUnit(unit) {
    for (var i = 0; i < unit.rows.length; i++) (function (row) { row.classList.add('fbh-highlight'); setTimeout(function () { row.classList.remove('fbh-highlight'); }, 3400); })(unit.rows[i]);
  }
  function goToSubmit() {
    // Submit row may be on no tab; reveal it by showing all rows of its group's tab?
    // Simpler: temporarily ensure the submit row is visible and scroll to it.
    if (state.submitRow) {
      state.submitRow.classList.remove('fbh-tab-hidden');
      scrollToRow(state.submitRow);
      return;
    }
    var b = (state.form || document).querySelector('[name="submit-btn-saverecord"], #submit-btn-saverecord');
    if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // -------------------------------------------------------------------------
  // Live updates — change only (date-safe)
  // -------------------------------------------------------------------------
  function scheduleUpdate() {
    clearTimeout(state.updateTimer);
    state.updateTimer = setTimeout(function () {
      recompute();
      if (state.missingPanel && !state.missingPanel.hidden) buildMissingList();
    }, 150);
  }
  function attachListeners() { document.addEventListener('change', scheduleUpdate, true); }

  // -------------------------------------------------------------------------
  // Notices
  // -------------------------------------------------------------------------
  function showWarning(msg) {
    if (document.querySelector('.fbh-warning-banner')) return;
    var w = el('div', 'fbh-warning-banner', msg); w.setAttribute('role', 'status');
    if (document.body) document.body.insertBefore(w, document.body.firstChild);
  }

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------
  function mount() {
    if (document.documentElement.getAttribute(HTML_MOUNT_ATTR) === 'true') return;
    if (!isTargetSurvey()) return;

    waitForSurvey().then(function (res) {
      var form = res.form, table = res.table, rows = res.rows || [];
      if (!form || !table || rows.length < MIN_QUESTIONS) {
        showWarning('Frostbite REDCap Helper could not safely read this page, so it did nothing. The REDCap form is unchanged.');
        return;
      }
      state.form = form; state.table = table; state.tbody = getTbody(table); state.rows = rows;

      try {
        buildTabMaps();
        state.units = buildUnits(rows);

        var root = createShell();
        if (document.body) document.body.insertBefore(root, document.body.firstChild);
        else document.documentElement.appendChild(root);
        document.body.classList.add('fbh-body-has-helper');
        if (state.form) state.form.classList.add('fbh-tabbed');

        buildTabButtons();
        attachListeners();

        // Activate the first tab that has content.
        var counts = tabUnitCounts();
        var first = null;
        for (var t = 0; t < TABS.length; t++) if (counts[TABS[t].id]) { first = TABS[t].id; break; }
        applyTab(first || TABS[0].id);

        // Pre-fill the configured date fields (blanks only). Done after mount so
        // REDCap's widgets are ready; recompute picks up the filled values.
        prefillDates();
        recompute();

        document.documentElement.setAttribute(HTML_MOUNT_ATTR, 'true');
        log('tabbed view mounted; units', state.units.length);
      } catch (err) {
        log('mount error; cleaning up', err && err.message, err && err.stack);
        softCleanup();
        showWarning('Frostbite REDCap Helper hit an error and removed itself. The REDCap form is unchanged.');
      }
    });
  }

  function softCleanup() {
    // Remove all our classes from rows so the form returns to normal.
    try {
      for (var i = 0; i < state.rows.length; i++) {
        state.rows[i].classList.remove('fbh-tab-hidden', 'fbh-row-complete', 'fbh-row-missing', 'fbh-highlight');
      }
    } catch (e) {}
    if (state.root && state.root.parentNode) { try { state.root.parentNode.removeChild(state.root); } catch (e) {} }
    if (document.body) document.body.classList.remove('fbh-body-has-helper');
    if (state.form) state.form.classList.remove('fbh-tabbed');
    document.documentElement.removeAttribute(HTML_MOUNT_ATTR);
  }

  onReady(function () { setTimeout(mount, 50); });

})();
