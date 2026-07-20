/*
 * Iloprost dose calculator tab (static, client-side only).
 *
 * Clinicians titrate an iloprost infusion: the rate (mcg/hr) is changed over
 * time, and the total dose is the sum, over every rate interval, of
 *   (rate in mcg/min) x (minutes that rate ran).
 * A patient may receive several separate doses; the grand total sums them.
 *
 * Model (per dose): an ordered list of rate rows entered EARLIEST FIRST, each a
 * {start time, rate mcg/hr}, plus one "infusion stopped at" time. A row's rate
 * runs from its own start time until the NEXT row's start time; the LAST row's
 * rate runs until the stop time. So each interval = minutesBetween(thisTime,
 * nextTime|stop), and the row's dose = (rate/60) x interval. (Matches the
 * clinician's chart: read started -> stopped, each rate held between two
 * timestamps, summed.)
 *
 * The clinician types every time and rate themselves (times change constantly,
 * and they want to control the inputs); the computer does the rest — minutes
 * between times, the mcg/hr -> mcg/min conversion (full precision, no early
 * rounding), the multiplication, the per-dose total, and the grand total across
 * however many doses. Rows auto-add as you type, so there is nothing to set up.
 *
 * "Use dose in Chart Audit" writes the grand-total dose into the main Chart
 * Audit's iloprost dose field (via the window.FBMAIN bridge); a Logs view
 * persists saved calculations in localStorage ('ilop_logs') for review; a
 * "How to use" view explains the flow with an animated walkthrough + guide.
 *
 * The pure calculation helpers are exported on g.ILOP_CALC (UMD-style, like
 * payload.js) so the exact code that ships is unit-tested in Node. Nothing here
 * touches the DOM at load time — the UI is built lazily by window.ILOP.build()
 * the first time the tab is shown (see initSwitch in app.js).
 */
(function (g) {
  'use strict';

  /* ============================ pure calculation ============================ */

  // "HH:MM" (24-hour) -> minutes since 00:00, or null if not a valid time.
  function parseHHMM(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    var h = +m[1], min = +m[2];
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  // Minutes from start to end on a 24-hour clock; if end is earlier than start
  // the interval is assumed to cross midnight (+1 day). null if either invalid.
  function minutesBetween(start, end) {
    var s = parseHHMM(start), e = parseHHMM(end);
    if (s == null || e == null) return null;
    var d = e - s;
    if (d < 0) d += 1440;
    return d;
  }

  // mcg/hr -> mcg/min at full precision (no rounding). null if not a number.
  function mcgPerMin(rateHr) {
    var r = parseFloat(rateHr);
    if (!isFinite(r)) return null;
    return r / 60;
  }

  // A single dose total is clinically capped: it can never exceed this many mcg.
  var DOSE_CAP = 50;
  // An iloprost infusion rate is clinically capped at this many mcg/hr; a higher
  // typed/imported value is treated as this cap for the dose math (never exceeds 10).
  var RATE_CAP = 10;

  // "HHMM" typed digits -> "HH:MM" (24-hour). Inserts the colon after 2 digits and never
  // zero-prefixes while typing, so 2200 -> "22:00" (not "02:20"). Validate via parseHHMM.
  function maskTime(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D+/g, '').slice(0, 4);
    return d.length <= 2 ? d : (d.slice(0, 2) + ':' + d.slice(2));
  }

  // Compute one dose. dose = { rows:[{time, rateHr}], stopTime }.
  // Returns { rows:[{time,nextTime,rateHr,durationMin,mcgPerMin,mcg,crossedMidnight}],
  //           total (capped at DOSE_CAP), rawTotal (uncapped sum), capped (bool) }.
  function computeDose(dose) {
    var rows = (dose && dose.rows) || [];
    var stop = dose && dose.stopTime;
    var out = [], total = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      // The rate runs until the next row that HAS a time (skipping blank rows that
      // auto-appear as you type), or the stop time if there is none after it.
      var nextTime = stop;
      for (var j = i + 1; j < rows.length; j++) {
        if (parseHHMM((rows[j] || {}).time) != null) { nextTime = (rows[j] || {}).time; break; }
      }
      var dur = minutesBetween(row.time, nextTime);
      // Clamp the rate to [0, RATE_CAP] mcg/hr for the math — the calc never uses a rate
      // above 10 or below 0 (a stray negative would otherwise subtract from the dose).
      var rawRate = parseFloat(row.rateHr);
      var rateCapped = isFinite(rawRate) && rawRate > RATE_CAP;
      var mpm = mcgPerMin(isFinite(rawRate) ? Math.min(Math.max(rawRate, 0), RATE_CAP) : row.rateHr);
      var mcg = (dur != null && mpm != null) ? mpm * dur : null;
      var s = parseHHMM(row.time), e = parseHHMM(nextTime);
      var crossed = (s != null && e != null && (e - s) < 0);
      if (mcg != null) total += mcg;
      out.push({
        time: row.time, nextTime: nextTime, rateHr: row.rateHr,
        durationMin: dur, mcgPerMin: mpm, mcg: mcg, crossedMidnight: crossed, rateCapped: rateCapped
      });
    }
    var capped = total > DOSE_CAP;
    return { rows: out, total: capped ? DOSE_CAP : total, rawTotal: total, capped: capped };
  }

  // Compute every dose + the grand total.
  function computeAll(doses) {
    var per = (doses || []).map(computeDose);
    var grand = per.reduce(function (a, d) { return a + d.total; }, 0);
    return { doses: per, grandTotal: grand };
  }

  /* ============================== formatting =============================== */

  function fmt2(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(2); }
  function fmt4(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(4); }
  // mcg/min for display: enough precision that (shown value) × (minutes) reproduces
  // the full-precision dose to the penny; trailing zeros trimmed (0.1, 0.133333…).
  function fmtConc(n) { return (n == null || isNaN(n)) ? '—' : String(parseFloat(Number(n).toFixed(6))); }
  function fmtDur(n) { return (n == null) ? '—' : n + ' min'; }
  function fmtHrMin(mins) {
    if (mins == null) return '';
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h === 0) return m + ' min';
    return h + ' h ' + (m < 10 ? '0' : '') + m + ' min';
  }
  function timeOr(t) { return (t && parseHHMM(t) != null) ? t : '--:--'; }
  function padr(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  // The canonical step-by-step record — used for BOTH the clipboard text and the
  // on-screen log detail, so what you review is exactly what you copy.
  function buildStepsText(label, createdAt, doses) {
    var all = computeAll(doses);
    var lines = [];
    lines.push('Iloprost dose calculation');
    if (createdAt) lines.push('Saved: ' + createdAt);
    lines.push('Label: ' + (label && String(label).trim() ? String(label).trim() : '(none)'));
    lines.push('');
    all.doses.forEach(function (d, i) {
      lines.push('Dose ' + (i + 1) + ' — total ' + fmt2(d.total) + ' mcg'
        + (d.capped ? ' (capped at ' + DOSE_CAP + ' mcg; computed ' + fmt2(d.rawTotal) + ' mcg)' : ''));
      if (!d.rows.length) lines.push('  (no rate rows)');
      d.rows.forEach(function (r) {
        var seg = timeOr(r.time) + ' → ' + timeOr(r.nextTime) + (r.crossedMidnight ? ' (+1 day)' : '');
        var rate = (r.rateHr === '' || r.rateHr == null) ? '?' : r.rateHr;
        lines.push('  ' + padr(seg, 24) + padr(rate + ' mcg/hr', 12) + '× ' + padr(fmtDur(r.durationMin), 8)
          + ' (' + fmtConc(r.mcgPerMin) + ' mcg/min) = ' + fmt2(r.mcg) + ' mcg'
          + (r.rateCapped ? ' (rate capped at ' + RATE_CAP + ')' : ''));
      });
      lines.push('');
    });
    var n = all.doses.length;
    lines.push('GRAND TOTAL: ' + fmt2(all.grandTotal) + ' mcg  (' + n + (n === 1 ? ' dose)' : ' doses)'));
    lines.push('');
    lines.push('Note: amounts are computed at full precision and rounded to 2 decimals for display;');
    lines.push('re-adding the rounded lines by hand may differ by about a cent.');
    return lines.join('\n');
  }

  // Export the pure helpers for the Node test (and anything else). UMD-style.
  g.ILOP_CALC = {
    parseHHMM: parseHHMM, minutesBetween: minutesBetween, mcgPerMin: mcgPerMin,
    computeDose: computeDose, computeAll: computeAll, buildStepsText: buildStepsText,
    fmt2: fmt2, fmt4: fmt4, fmtConc: fmtConc, fmtHrMin: fmtHrMin,
    DOSE_CAP: DOSE_CAP, RATE_CAP: RATE_CAP, maskTime: maskTime
  };

  // No DOM in Node — stop here when there's no document to build into.
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  /* ================================== UI =================================== */

  var LOGS_KEY = 'ilop_logs';
  var START_ROWS = 3;          // empty rows shown on a fresh dose (more auto-appear as you type)

  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; }
  function $(id) { return document.getElementById(id); }
  function reduceMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  // Source of truth for the live calculator.
  function newRow() { return { time: '', rateHr: '' }; }
  function newDose() { var rows = []; for (var i = 0; i < START_ROWS; i++) rows.push(newRow()); return { rows: rows, stopTime: '' }; }
  function rowHasContent(r) { return (r.time && r.time !== '') || (r.rateHr !== '' && r.rateHr != null); }
  var model = { label: '', doses: [newDose()] };

  // Live-updated node references, rebuilt by renderCalc() (kept off `model` so it
  // serializes cleanly to localStorage).
  var refs = { doses: [], grandNodes: [] };
  var built = false;
  var view = 'calc';                 // 'calc' | 'howto' | 'logs'
  var confirmDeleteId = null;        // log id awaiting delete confirmation
  var confirmClearAll = false;       // logs "clear all" awaiting confirmation
  var statusTimer = 0;

  /* ------------------------------ localStorage ----------------------------- */
  function loadLogs() {
    try { var raw = localStorage.getItem(LOGS_KEY); return raw ? (JSON.parse(raw) || []) : []; }
    catch (e) { return []; }
  }
  function saveLogs(arr) {
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(arr)); return true; }
    catch (e) { return false; }
  }

  /* -------------------------------- clipboard ------------------------------ */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta); return !!ok;
    } catch (e) { return false; }
  }
  function flashStatus(msg, kind) {
    var s = $('ilop-status'); if (!s) return;
    s.className = 'submit-status' + (kind ? ' ' + kind : '');
    s.textContent = msg;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { s.textContent = ''; s.className = 'submit-status'; }, 4000);
  }

  /* ---------------------------------- build -------------------------------- */
  function build() {
    if (built) return; built = true;
    var root = $('app-ilop');

    // App bar with a live grand-total pill (mirrors the Hennepin tab).
    var bar = el('header', 'appbar');
    var main = el('div', 'appbar-main');
    main.appendChild(el('div', 'appbar-title', 'Iloprost Dose Calculator'));
    main.appendChild(el('div', 'appbar-sub', 'Total infusion dose across rate changes and doses'));
    bar.appendChild(main);
    var live = el('div', 'ilop-livetotal'); live.id = 'ilop-livetotal';
    live.title = 'Grand total dose (live)'; live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
    live.appendChild(el('span', 'ilop-livetotal-label', 'Grand total'));
    var liveVal = el('span', 'ilop-livetotal-val', '0.00'); live.appendChild(liveVal);
    live.appendChild(el('span', 'ilop-livetotal-unit', 'mcg'));
    refs.grandNodes.push(liveVal);
    bar.appendChild(live);
    root.appendChild(bar);

    // Calculator | How to use | Logs sub-nav (sticky under the app bar).
    var nav = el('nav', 'ilop-viewswitch'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', 'Iloprost view');
    nav.appendChild(viewBtn('calc', 'Calculator', true));
    nav.appendChild(viewBtn('howto', 'How to use', false));
    var bLogs = viewBtn('logs', 'Logs', false);
    var logsBadge = el('span', 'ilop-vbadge'); logsBadge.id = 'ilop-logs-count'; bLogs.appendChild(logsBadge);
    nav.appendChild(bLogs);
    root.appendChild(nav);

    var panels = el('main', 'panels'); root.appendChild(panels);
    var panel = el('section', 'panel'); panels.appendChild(panel);

    // ---- Calculator view ----
    var calcView = el('div'); calcView.id = 'ilop-calc-view'; panel.appendChild(calcView);

    // Discoverability: nudge first-timers to the guide.
    var nudge = el('div', 'ilop-nudge');
    nudge.appendChild(el('span', null, 'First time? '));
    var nudgeLink = el('button', 'ilop-link', 'See How to use →'); nudgeLink.type = 'button';
    nudgeLink.addEventListener('click', function () { setView('howto'); });
    nudge.appendChild(nudgeLink);
    calcView.appendChild(nudge);

    // Minutes-between-two-times helper (the requested 24-hour clock calculator).
    calcView.appendChild(buildMinutesHelper());

    // Orientation hint.
    var introG = el('div', 'section-group');
    introG.appendChild(el('h2', 'section', 'Doses'));
    introG.appendChild(el('p', 'hint',
      'For each dose, type the rate changes in time order — earliest first. In each row enter the time the rate started and the rate (mcg/hr); a new row appears as you type. The last rate runs until the “Infusion stopped at” time. The computer works out the minutes, the mcg/min, the multiplication, and the totals.'));
    calcView.appendChild(introG);

    var dosesWrap = el('div'); dosesWrap.id = 'ilop-doses'; calcView.appendChild(dosesWrap);

    var addWrap = el('div', 'ilop-adddose-wrap');
    var addDose = el('button', 'btn'); addDose.type = 'button'; addDose.id = 'ilop-add-dose'; addDose.textContent = '+ Add another dose';
    addDose.addEventListener('click', function () { model.doses.push(newDose()); renderCalc(); });
    addWrap.appendChild(addDose);
    addWrap.appendChild(el('span', 'hint', ' Add a dose for each separate infusion the patient received.'));
    calcView.appendChild(addWrap);

    calcView.appendChild(el('p', 'hint ilop-footnote',
      'Amounts are computed at full precision and rounded to 2 decimals for display, so re-adding the rounded lines by hand may differ by about a cent.'));

    // ---- How-to view ----
    panel.appendChild(buildHowto());

    // ---- Logs view ----
    var logsView = el('div'); logsView.id = 'ilop-logs-view'; logsView.hidden = true; panel.appendChild(logsView);
    var logsHead = el('div', 'section-group ilop-logs-head');
    var lh = el('div', 'ilop-logs-headrow');
    lh.appendChild(el('h2', 'section', 'Saved calculations'));
    var clearBox = el('div', 'ilop-clearall-box'); clearBox.id = 'ilop-clearall-box';
    lh.appendChild(clearBox);
    logsHead.appendChild(lh);
    logsHead.appendChild(el('p', 'hint',
      'Saved only in this browser on this device (never uploaded). Clearing your browser data deletes them. Avoid entering patient identifiers in the label.'));
    logsView.appendChild(logsHead);
    var logsList = el('div'); logsList.id = 'ilop-logs-list'; logsView.appendChild(logsList);

    // ---- Action bar (calculator actions; hidden in other views) ----
    var ab = el('div', 'actionbar'); ab.id = 'ilop-actionbar';
    var useBtn = el('button', 'btn btn-primary'); useBtn.type = 'button'; useBtn.textContent = 'Use dose in Chart Audit →';
    useBtn.addEventListener('click', onUseInChartAudit);
    var saveBtn = el('button', 'btn'); saveBtn.type = 'button'; saveBtn.textContent = 'Save to log';
    saveBtn.addEventListener('click', onSaveToLog);
    ab.appendChild(useBtn); ab.appendChild(saveBtn);
    ab.appendChild(el('span', 'actionbar-spacer'));
    var status = el('span', 'submit-status'); status.id = 'ilop-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    ab.appendChild(status);
    var clearBtn = el('button', 'btn btn-ghost btn-sm'); clearBtn.type = 'button'; clearBtn.textContent = 'Clear calculator';
    clearBtn.addEventListener('click', onClearCalc);
    ab.appendChild(clearBtn);
    root.appendChild(ab);

    renderCalc();
    updateLogsCount();
  }

  function viewBtn(key, label, active) {
    var b = el('button', 'ilop-vbtn' + (active ? ' active' : ''), label); b.type = 'button'; b.id = 'ilop-v-' + key;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', active ? 'true' : 'false');
    b.addEventListener('click', function () { setView(key); });
    return b;
  }

  /* --------------------------- minutes-between helper ---------------------- */
  function buildMinutesHelper() {
    var g0 = el('div', 'section-group');
    g0.appendChild(el('h2', 'section', 'Minutes between two times'));
    var row = el('div', 'ilop-minrow');
    var from = timeField('From (earlier)'); var to = timeField('To (later)');
    row.appendChild(from.wrap); row.appendChild(to.wrap);
    var eq = el('span', 'ilop-minresult', '—'); row.appendChild(eq);
    g0.appendChild(row);
    g0.appendChild(el('p', 'hint', 'A quick 24-hour clock helper. If the second time is earlier, it is treated as the next day.'));
    function upd() {
      var mins = minutesBetween(from.input.value, to.input.value);
      if (mins == null) { eq.textContent = '—'; eq.classList.remove('ok'); return; }
      var s = parseHHMM(from.input.value), e = parseHHMM(to.input.value);
      var crossed = (e - s) < 0;
      eq.textContent = '= ' + mins + ' min  (' + fmtHrMin(mins) + ')' + (crossed ? '  · next day' : '');
      eq.classList.add('ok');
    }
    from.input.addEventListener('input', upd); to.input.addEventListener('input', upd);
    return g0;
  }
  // Turn an <input> into a masked 24-hour HH:MM text box (replaces the native time
  // picker so HHMM entry is deterministic: 2200 -> 22:00, never 02:20). Validates
  // (00:00–23:59) only on blur, so partial typing is never destructively reformatted.
  function attachTimeMask(input) {
    input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 5;
    input.placeholder = 'HH:MM'; input.autocomplete = 'off';
    input.addEventListener('beforeinput', function () {
      input._fbPrevDigits = window.FBDATE ? window.FBDATE.onlyDigits(input.value).length : null;
    });
    input.addEventListener('input', function (e) {
      var raw = input.value;
      var pos = (input.selectionStart == null) ? raw.length : input.selectionStart;
      // Backspacing the ':' would otherwise be a dead keystroke — delete the digit instead.
      if (e && e.inputType === 'deleteContentBackward' && input._fbPrevDigits != null && window.FBDATE
          && window.FBDATE.onlyDigits(raw).length === input._fbPrevDigits && pos > 0) {
        raw = raw.slice(0, pos - 1) + raw.slice(pos); pos = pos - 1;
      }
      var before = window.FBDATE ? window.FBDATE.digitsBefore(raw, pos) : null;
      var masked = maskTime(raw);
      input.value = masked;
      if (before != null && window.FBDATE) { var c = window.FBDATE.caretForDigits(masked, before); try { input.setSelectionRange(c, c); } catch (e2) {} }
    });
    input.addEventListener('blur', function () {
      // A natural 3-digit time (e.g. 930) pads to HHMM (0930 -> 09:30) so it isn't dropped.
      var d = String(input.value).replace(/\D+/g, '');
      if (d.length === 3 && parseHHMM(input.value) == null) {
        var padded = maskTime('0' + d);
        if (parseHHMM(padded) != null) { input.value = padded; input.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      input.classList.toggle('invalid', input.value !== '' && parseHHMM(input.value) == null);
    });
    return input;
  }
  function timeField(label) {
    var wrap = el('label', 'ilop-tf');
    wrap.appendChild(el('span', 'ilop-tf-lab', label));
    var input = document.createElement('input'); input.className = 'input ilop-time';
    attachTimeMask(input);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  /* ------------------------------- render calc ----------------------------- */
  function renderCalc() {
    var wrap = $('ilop-doses'); if (!wrap) return;
    wrap.textContent = '';
    refs.doses = [];
    model.doses.forEach(function (dose, di) { wrap.appendChild(renderDose(dose, di)); });
    refreshCalc();
  }

  function renderDose(dose, di) {
    var card = el('div', 'section-group ilop-dose');

    var head = el('div', 'ilop-dose-head');
    head.appendChild(el('span', 'ilop-dose-title', 'Dose ' + (di + 1)));
    head.appendChild(el('span', 'actionbar-spacer'));
    var totalLab = el('span', 'ilop-dose-total');
    totalLab.appendChild(el('span', 'ilop-dose-total-lab', 'Dose total'));
    var totalVal = el('span', 'ilop-dose-total-val', '0.00'); totalLab.appendChild(totalVal);
    totalLab.appendChild(el('span', 'ilop-dose-total-unit', 'mcg'));
    var capNote = el('span', 'ilop-dose-cap', ''); totalLab.appendChild(capNote);
    head.appendChild(totalLab);
    if (model.doses.length > 1) {
      var rmDose = el('button', 'btn btn-ghost btn-sm', 'Remove'); rmDose.type = 'button';
      rmDose.setAttribute('aria-label', 'Remove dose ' + (di + 1));
      rmDose.addEventListener('click', function () { model.doses.splice(di, 1); renderCalc(); });
      head.appendChild(rmDose);
    }
    card.appendChild(head);

    var rowsWrap = el('div', 'ilop-rows');
    var colhead = el('div', 'ilop-row ilop-row-head');
    colhead.appendChild(el('span', 'ilop-c-time', 'Time rate started'));
    colhead.appendChild(el('span', 'ilop-c-rate', 'Rate (mcg/hr)'));
    colhead.appendChild(el('span', 'ilop-c-calc', 'Minutes × rate = mcg'));
    colhead.appendChild(el('span', 'ilop-c-rm', ''));
    rowsWrap.appendChild(colhead);

    var rowCalc = [];
    // Build one row's DOM and wire it; auto-appends a fresh row when the last
    // row first gets content, so the clinician can just keep typing.
    function addRowEl(r) {
      var rowEl = el('div', 'ilop-row');

      var t = document.createElement('input'); t.className = 'input ilop-time'; attachTimeMask(t);
      t.value = r.time || ''; t.setAttribute('aria-label', 'Dose ' + (di + 1) + ' start time');
      t.addEventListener('input', function () { r.time = t.value; maybeGrow(r); refreshCalc(); });
      var tc = el('span', 'ilop-c-time'); tc.appendChild(t); rowEl.appendChild(tc);

      var rt = document.createElement('input'); rt.type = 'number'; rt.className = 'input ilop-rate';
      rt.min = '0'; rt.max = String(RATE_CAP); rt.step = 'any'; rt.inputMode = 'decimal'; rt.placeholder = 'mcg/hr';
      rt.value = (r.rateHr === '' || r.rateHr == null) ? '' : r.rateHr;
      rt.setAttribute('aria-label', 'Dose ' + (di + 1) + ' rate in mcg per hour (max ' + RATE_CAP + ')');
      // Trackpad/mouse-wheel must not change the value while focused (a common number-input footgun).
      rt.addEventListener('wheel', function (e) { if (rt === document.activeElement) e.preventDefault(); }, { passive: false });
      rt.addEventListener('input', function () { r.rateHr = rt.value; maybeGrow(r); refreshCalc(); });
      var rc = el('span', 'ilop-c-rate'); rc.appendChild(rt); rowEl.appendChild(rc);

      var calc = el('span', 'ilop-c-calc ilop-rowcalc'); rowEl.appendChild(calc);
      rowCalc.push(calc);

      var rmc = el('span', 'ilop-c-rm');
      var rmRow = el('button', 'ilop-rowrm', '×'); rmRow.type = 'button';
      rmRow.title = 'Remove this row'; rmRow.setAttribute('aria-label', 'Remove this row');
      rmRow.addEventListener('click', function () {
        var idx = dose.rows.indexOf(r);
        if (idx >= 0) dose.rows.splice(idx, 1);
        if (!dose.rows.length) dose.rows.push(newRow());
        renderCalc();
      });
      rmc.appendChild(rmRow); rowEl.appendChild(rmc);

      rowsWrap.appendChild(rowEl);
      return calc;
    }
    // When the *last* row gets its first content, append a new empty row.
    function maybeGrow(r) {
      if (dose.rows[dose.rows.length - 1] === r && rowHasContent(r)) {
        var nr = newRow(); dose.rows.push(nr); addRowEl(nr);
      }
    }

    dose.rows.forEach(function (r) { addRowEl(r); });
    card.appendChild(rowsWrap);

    var addRow = el('button', 'btn btn-ghost btn-sm', '+ Add a row'); addRow.type = 'button';
    addRow.addEventListener('click', function () { var nr = newRow(); dose.rows.push(nr); addRowEl(nr); });
    card.appendChild(addRow);

    // Stop time — closes the final rate's interval.
    var stopRow = el('div', 'ilop-stoprow');
    var stopLab = el('label', 'ilop-stop');
    stopLab.appendChild(el('span', 'ilop-stop-icon', '■'));
    stopLab.appendChild(el('span', 'ilop-stop-lab', 'Infusion stopped at'));
    var stopInput = document.createElement('input'); stopInput.className = 'input ilop-time'; attachTimeMask(stopInput);
    stopInput.value = dose.stopTime || ''; stopInput.setAttribute('aria-label', 'Dose ' + (di + 1) + ' infusion stopped at');
    stopInput.addEventListener('input', function () { dose.stopTime = stopInput.value; refreshCalc(); });
    stopLab.appendChild(stopInput);
    stopRow.appendChild(stopLab);
    stopRow.appendChild(el('span', 'hint', 'Closes the final rate’s duration.'));
    card.appendChild(stopRow);

    refs.doses.push({ totalVal: totalVal, rowCalc: rowCalc, capNote: capNote });
    return card;
  }

  // Recompute and write the live numbers (no DOM rebuild — preserves focus/caret).
  function refreshCalc() {
    var all = computeAll(model.doses);
    all.doses.forEach(function (d, di) {
      var dr = refs.doses[di]; if (!dr) return;
      dr.totalVal.textContent = fmt2(d.total);
      if (dr.capNote) dr.capNote.textContent = d.capped ? ' (capped at 50 mcg)' : '';
      d.rows.forEach(function (r, ri) {
        var node = dr.rowCalc[ri]; if (!node) return;
        if (r.durationMin == null || r.mcgPerMin == null) {
          var msg = '—';
          if (rowHasContentComputed(r)) {
            if (parseHHMM(r.time) == null) msg = 'enter the time';
            else if (r.mcgPerMin == null) msg = 'enter the rate';
            else msg = 'needs a later time';
          }
          node.textContent = msg;
          node.classList.add('muted');
        } else {
          node.classList.remove('muted');
          node.textContent = '→ ' + r.durationMin + ' min' + (r.crossedMidnight ? ' (+1 day)' : '')
            + ' × ' + fmtConc(r.mcgPerMin) + ' mcg/min = ' + fmt2(r.mcg) + ' mcg'
            + (r.rateCapped ? ' (rate capped at ' + RATE_CAP + ')' : '');
        }
      });
    });
    var gt = fmt2(all.grandTotal);
    refs.grandNodes.forEach(function (n) { n.textContent = gt; });
  }
  // A row has a rate/time but can't compute yet (missing the next/stop time).
  function rowHasContentComputed(r) { return (r.rateHr !== '' && r.rateHr != null) || (r.time && r.time !== ''); }

  /* --------------------------------- views --------------------------------- */
  function setView(v) {
    view = v;
    var isCalc = v === 'calc';
    $('ilop-calc-view').hidden = !isCalc;
    $('ilop-howto-view').hidden = (v !== 'howto');
    $('ilop-logs-view').hidden = (v !== 'logs');
    $('ilop-actionbar').hidden = !isCalc;             // calc actions only on the calculator
    $('ilop-livetotal').hidden = !isCalc;             // the pill reflects the working calc
    ['calc', 'howto', 'logs'].forEach(function (k) {
      var b = $('ilop-v-' + k); if (!b) return;
      var on = k === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (v === 'logs') { confirmDeleteId = null; confirmClearAll = false; renderLogs(); }
    if (v === 'howto') demoStart(); else demoStop();
    window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function updateLogsCount() {
    var b = $('ilop-logs-count'); if (!b) return;
    var n = loadLogs().length;
    b.textContent = n ? String(n) : '';
    b.hidden = !n;
  }

  /* --------------------------- use in Chart Audit -------------------------- */
  function doseHasInput(d) { return !!((d && d.stopTime && d.stopTime !== '') || ((d && d.rows) || []).some(rowHasContent)); }
  // "Dose 1: X mcg, Dose 2: X mcg; Total: XX mcg" — per-dose totals (each capped at
  // 50 mcg) plus the grand total. Doses with no input are skipped; numbering follows
  // the on-screen dose position.
  function buildDoseSummary() {
    var parts = [], grand = 0;
    model.doses.forEach(function (md, i) {
      var d = computeDose(md);
      grand += d.total;
      if (doseHasInput(md)) parts.push('Dose ' + (i + 1) + ': ' + fmt2(d.total) + ' mcg'
        + (d.capped ? ' (capped at ' + DOSE_CAP + ' mcg)' : '')
        + (d.rows.some(function (r) { return r.rateCapped; }) ? ' (rate capped at ' + RATE_CAP + ')' : ''));
    });
    if (!parts.length) parts.push('Dose 1: ' + fmt2(0) + ' mcg');
    return parts.join(', ') + '; Total: ' + fmt2(grand) + ' mcg';
  }
  // Write the full per-dose breakdown straight into the Chart Audit's iloprost field.
  function onUseInChartAudit() {
    if (!hasAnyInput()) { flashStatus('Enter a dose first — nothing to send yet.', 'err'); return; }
    var grand = computeAll(model.doses).grandTotal;
    if (!grand) { flashStatus('Enter a dose first — the total is still 0.', 'err'); return; }
    if (!window.FBMAIN || !window.FBMAIN.setField) { flashStatus('Could not reach the Chart Audit form.', 'err'); return; }
    var text = buildDoseSummary();
    var r = window.FBMAIN.setField('iloprost_dose', text);
    if (!r || !r.ok) { flashStatus('Could not write to the Chart Audit form.', 'err'); return; }
    if (r.visible) flashStatus('✓ Dose breakdown (total ' + fmt2(grand) + ' mcg) written to the Chart Audit.', 'ok');
    else flashStatus('✓ Saved (total ' + fmt2(grand) + ' mcg) — it will appear once iloprost administration is marked “Yes” in the Chart Audit.', 'ok');
  }
  function hasAnyInput() {
    return model.doses.some(function (d) {
      return (d.stopTime && d.stopTime !== '') || d.rows.some(rowHasContent);
    });
  }

  /* ------------------------------- save to log ----------------------------- */
  function onSaveToLog() {
    if (!hasAnyInput()) { flashStatus('Nothing to save yet — enter a dose first.', 'err'); return; }
    var all = computeAll(model.doses);
    var now = new Date();
    var entry = {
      id: 'ilog_' + now.getTime() + '_' + Math.floor(Math.random() * 1e6),
      createdAt: fmtStamp(now),
      label: model.label || '',
      doses: cloneDoses(model.doses),
      grandTotal: all.grandTotal
    };
    var logs = loadLogs();
    logs.unshift(entry);                 // newest first
    if (saveLogs(logs)) {
      updateLogsCount();
      flashStatus('✓ Saved to log. See the Logs tab.', 'ok');
      if (view === 'logs') renderLogs();
    } else {
      flashStatus('✗ Could not save — browser storage is unavailable or full.', 'err');
    }
  }
  // Drop trailing empty rows so saved/copied records are clean.
  function cloneDoses(doses) {
    return doses.map(function (d) {
      var rows = (d.rows || []).filter(rowHasContent).map(function (r) {
        return { time: r.time || '', rateHr: (r.rateHr === '' || r.rateHr == null) ? '' : r.rateHr };
      });
      return { stopTime: d.stopTime || '', rows: rows };
    });
  }
  function fmtStamp(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* -------------------------------- clear calc ----------------------------- */
  function onClearCalc() {
    if (!hasAnyInput()) { model = { label: '', doses: [newDose()] }; renderCalc(); return; }
    if (window.confirm('Clear the calculator? This does not affect your saved logs.')) {
      model = { label: '', doses: [newDose()] };
      renderCalc();
      flashStatus('Calculator cleared.', '');
    }
  }

  /* -------------------------------- render logs ---------------------------- */
  function renderLogs() {
    var list = $('ilop-logs-list'); if (!list) return;
    var logs = loadLogs();
    list.textContent = '';

    var box = $('ilop-clearall-box'); box.textContent = '';
    if (logs.length) {
      if (confirmClearAll) {
        box.appendChild(el('span', 'ilop-confirm-q', 'Delete all ' + logs.length + ' logs?'));
        var yesAll = el('button', 'btn btn-sm ilop-danger', 'Yes, clear all'); yesAll.type = 'button';
        yesAll.addEventListener('click', function () { saveLogs([]); confirmClearAll = false; updateLogsCount(); renderLogs(); });
        var noAll = el('button', 'btn btn-ghost btn-sm', 'Cancel'); noAll.type = 'button';
        noAll.addEventListener('click', function () { confirmClearAll = false; renderLogs(); });
        box.appendChild(yesAll); box.appendChild(noAll);
      } else {
        var clearAll = el('button', 'btn btn-ghost btn-sm', 'Clear all'); clearAll.type = 'button';
        clearAll.addEventListener('click', function () { confirmClearAll = true; renderLogs(); });
        box.appendChild(clearAll);
      }
    }

    if (!logs.length) {
      var empty = el('div', 'section-group ilop-logs-empty');
      empty.appendChild(el('p', 'hint', 'No saved calculations yet. In the Calculator tab, enter a dose and press “Save to log.”'));
      list.appendChild(empty);
      return;
    }
    logs.forEach(function (entry) { list.appendChild(renderLogEntry(entry)); });
  }

  function renderLogEntry(entry) {
    var card = el('div', 'section-group ilop-log');
    var head = el('div', 'ilop-log-head');
    var meta = el('div', 'ilop-log-meta');
    meta.appendChild(el('span', 'ilop-log-date', entry.createdAt || ''));
    if (entry.label && String(entry.label).trim()) meta.appendChild(el('span', 'ilop-log-label', String(entry.label).trim()));
    head.appendChild(meta);
    var tot = el('span', 'ilop-log-total');
    tot.appendChild(el('span', 'ilop-log-total-val', fmt2(entry.grandTotal)));
    tot.appendChild(el('span', 'ilop-log-total-unit', ' mcg'));
    head.appendChild(tot);
    card.appendChild(head);

    var det = el('details', 'ilop-log-detail');
    det.appendChild(el('summary', null, 'Show detailed steps'));
    det.appendChild(el('pre', 'ilop-steps', buildStepsText(entry.label, entry.createdAt, entry.doses || [])));
    card.appendChild(det);

    var actions = el('div', 'ilop-log-actions');
    var copy = el('button', 'btn btn-sm', 'Copy'); copy.type = 'button';
    copy.addEventListener('click', function () {
      copyText(buildStepsText(entry.label, entry.createdAt, entry.doses || [])).then(function (ok) {
        copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1800);
      });
    });
    actions.appendChild(copy);
    actions.appendChild(el('span', 'actionbar-spacer'));

    if (confirmDeleteId === entry.id) {
      actions.appendChild(el('span', 'ilop-confirm-q', 'Delete this log?'));
      var yes = el('button', 'btn btn-sm ilop-danger', 'Yes, delete'); yes.type = 'button';
      yes.addEventListener('click', function () {
        saveLogs(loadLogs().filter(function (l) { return l.id !== entry.id; }));
        confirmDeleteId = null; updateLogsCount(); renderLogs();
      });
      var no = el('button', 'btn btn-ghost btn-sm', 'Cancel'); no.type = 'button';
      no.addEventListener('click', function () { confirmDeleteId = null; renderLogs(); });
      actions.appendChild(yes); actions.appendChild(no);
    } else {
      var del = el('button', 'btn btn-ghost btn-sm ilop-del', 'Delete'); del.type = 'button';
      del.addEventListener('click', function () { confirmDeleteId = entry.id; confirmClearAll = false; renderLogs(); });
      actions.appendChild(del);
    }
    card.appendChild(actions);
    return card;
  }

  /* ------------------------------- How to use ------------------------------ */
  // A fixed example dose, computed by the REAL engine so the walkthrough numbers
  // are always truthful: 08:00→08:30 @2, 08:30→09:00 @4, 09:00→10:00 @6, stop 10:00.
  var DEMO_DOSE = { rows: [{ time: '08:00', rateHr: 2 }, { time: '08:30', rateHr: 4 }, { time: '09:00', rateHr: 6 }], stopTime: '10:00' };
  var demo = { step: 0, timer: 0, nodes: null, steps: 0, reduced: false };

  function buildHowto() {
    var v = el('div'); v.id = 'ilop-howto-view'; v.hidden = true;

    var intro = el('div', 'section-group');
    intro.appendChild(el('h2', 'section', 'How to use the iloprost calculator'));
    intro.appendChild(el('p', 'hint',
      'You type the times and rates straight from the chart; the calculator works out the minutes, converts mcg/hr to mcg/min, multiplies, and adds everything up. Watch the example, or follow the written steps below.'));
    intro.appendChild(el('p', 'hint',
      'Charts often list the most recent rate at the top. In this calculator, enter the EARLIEST first (when the infusion started — usually the lowest rate) and work down to the stop time.'));
    v.appendChild(intro);

    // Animated walkthrough.
    var demoG = el('div', 'section-group');
    demoG.appendChild(el('h2', 'section', 'Watch how it works'));
    v.appendChild(demoG);
    demoG.appendChild(buildDemo());

    // Written steps.
    var stepsG = el('div', 'section-group');
    stepsG.appendChild(el('h2', 'section', 'Step by step'));
    var ol = el('ol', 'ilop-guide');
    [
      'Stay on the Calculator tab. The first dose card is ready to fill in.',
      'In the first row, enter the time the infusion started and the rate then (mcg/hr). Enter rate changes in time order, earliest first.',
      'Each time the rate changed, fill the next row with the new time and rate. A fresh row appears automatically as you type — no need to add rows by hand.',
      'When the infusion stopped, enter the “Infusion stopped at” time. This closes the last rate’s interval.',
      'Read each row: it shows the minutes that rate ran and the mcg given (minutes × rate ÷ 60). The “Dose total” adds up the rows.',
      'If the patient had more than one dose, press “+ Add another dose” (there is no limit) and fill it in. The “Grand total” at the top right adds up every dose.',
      'Press “Use dose in Chart Audit →” to write the per-dose breakdown and grand total straight into the Chart Audit’s iloprost dose field, or “Save to log” to keep a record you can review later.',
      'Tip: use “Minutes between two times” at the top for a quick duration check between any two 24-hour times.'
    ].forEach(function (s) { ol.appendChild(el('li', null, s)); });
    stepsG.appendChild(ol);
    v.appendChild(stepsG);

    // Worked example (the exact text Copy would produce).
    var exG = el('div', 'section-group');
    exG.appendChild(el('h2', 'section', 'Worked example'));
    exG.appendChild(el('p', 'hint', 'A dose given at 2 mcg/hr from 08:00, raised to 4 at 08:30 and 6 at 09:00, stopped at 10:00:'));
    exG.appendChild(el('pre', 'ilop-steps', buildStepsText('Example', null, [DEMO_DOSE])));
    v.appendChild(exG);

    var actions = el('div', 'ilop-howto-actions');
    var open = el('button', 'btn btn-primary', 'Open the calculator →'); open.type = 'button';
    open.addEventListener('click', function () { setView('calc'); });
    actions.appendChild(open);
    v.appendChild(actions);

    return v;
  }

  // Each step shows an accumulating "typed" example + the breakdown the engine
  // derives from exactly that text, so the demo can never drift from the math.
  function demoSteps() {
    var L = ['08:00 2', '08:30 4', '09:00 6', '10:00 (stop)'];
    return [
      { rows: 0, stop: false, cap: 'A dose is a list of rate changes. You type each one — earliest first.' },
      { rows: 1, stop: false, cap: 'Row 1: the time the infusion started (08:00) and the rate then (2 mcg/hr).' },
      { rows: 2, stop: false, cap: 'Add the next change. Now the first rate’s 30 minutes are known → 1.00 mcg.' },
      { rows: 3, stop: false, cap: 'Keep going, earliest first. A new row appears automatically as you type.' },
      { rows: 3, stop: true, cap: 'Enter the stop time (10:00). It closes the last rate — 60 minutes → 6.00 mcg.' },
      { rows: 3, stop: true, total: true, cap: 'Each row = minutes × (rate ÷ 60). They add up to the dose total: 9.00 mcg.' },
      { rows: 3, stop: true, total: true, cap: 'Add a dose for each infusion (no limit); the grand total combines them. Then send it to the Chart Audit or Save.' }
    ].map(function (s) { s.lines = L; return s; });
  }

  function buildDemo() {
    var wrap = el('div', 'ilop-demo');
    demo.reduced = reduceMotion();

    // A mock dose card that fills in step by step.
    var card = el('div', 'ilop-demo-card');
    var head = el('div', 'ilop-demo-head');
    head.appendChild(el('span', 'ilop-demo-title', 'Dose 1 (example)'));
    var total = el('span', 'ilop-demo-total'); total.appendChild(el('span', 'ilop-demo-total-lab', 'Dose total '));
    var totalVal = el('span', 'ilop-demo-total-val', '—'); total.appendChild(totalVal); total.appendChild(el('span', null, ' mcg'));
    head.appendChild(total); card.appendChild(head);

    var comp = computeDose(DEMO_DOSE);
    var rowNodes = [];
    DEMO_DOSE.rows.forEach(function (r, i) {
      var row = el('div', 'ilop-demo-row');
      var t = el('span', 'ilop-demo-chip', '');
      var rate = el('span', 'ilop-demo-chip', '');
      var calc = el('span', 'ilop-demo-rowcalc', '');
      row.appendChild(t); row.appendChild(rate); row.appendChild(calc);
      card.appendChild(row);
      rowNodes.push({ t: t, rate: rate, calc: calc, r: r, c: comp.rows[i] });
    });
    var stopRow = el('div', 'ilop-demo-row ilop-demo-stoprow');
    stopRow.appendChild(el('span', 'ilop-demo-stoplab', 'Infusion stopped at'));
    var stopChip = el('span', 'ilop-demo-chip', '');
    stopRow.appendChild(stopChip); card.appendChild(stopRow);
    wrap.appendChild(card);

    var cap = el('p', 'ilop-demo-cap'); cap.id = 'ilop-demo-cap'; wrap.appendChild(cap);

    var controls = el('div', 'ilop-demo-controls');
    var dots = el('div', 'ilop-demo-dots'); controls.appendChild(dots);
    var steps = demoSteps();
    var dotNodes = [];
    steps.forEach(function (_s, i) {
      var d = el('button', 'ilop-demo-dot'); d.type = 'button'; d.setAttribute('aria-label', 'Step ' + (i + 1));
      d.addEventListener('click', function () { demoStop(); demo.step = i; demoRender(); });
      dots.appendChild(d); dotNodes.push(d);
    });
    var spacer = el('span', 'actionbar-spacer'); controls.appendChild(spacer);
    var playBtn = el('button', 'btn btn-sm', 'Pause'); playBtn.type = 'button'; playBtn.id = 'ilop-demo-play';
    playBtn.addEventListener('click', function () { if (demo.timer) demoStop(); else demoPlay(); });
    var replay = el('button', 'btn btn-ghost btn-sm', 'Replay'); replay.type = 'button';
    replay.addEventListener('click', function () { demo.step = 0; demoRender(); demoPlay(); });
    controls.appendChild(playBtn); controls.appendChild(replay);
    wrap.appendChild(controls);

    if (demo.reduced) {
      controls.hidden = true;
      wrap.appendChild(el('p', 'hint', 'Animation is off because your system prefers reduced motion. The example above is shown fully filled in; the written steps are below.'));
    }

    demo.nodes = { rowNodes: rowNodes, stopChip: stopChip, totalVal: totalVal, cap: cap, dots: dotNodes, playBtn: playBtn, comp: comp };
    demo.steps = steps.length;
    demo.step = demo.reduced ? steps.length - 1 : 0;
    demoRender();
    return wrap;
  }

  function demoRender() {
    var n = demo.nodes; if (!n) return;
    var steps = demoSteps();
    var s = steps[demo.step] || steps[0];
    var vals = [
      { t: '08:00', rate: '2' }, { t: '08:30', rate: '4' }, { t: '09:00', rate: '6' }
    ];
    n.rowNodes.forEach(function (rn, i) {
      var shown = i < s.rows;
      rn.t.textContent = shown ? vals[i].t : '';
      rn.rate.textContent = shown ? vals[i].rate + ' mcg/hr' : '';
      rn.t.classList.toggle('shown', shown);
      rn.rate.classList.toggle('shown', shown);
      // A row's mcg shows once the NEXT time is known (next row, or the stop).
      var canCalc = shown && ((i + 1) < s.rows || (i === s.rows - 1 && s.stop));
      var c = rn.c;
      rn.calc.textContent = canCalc ? ('· ' + c.durationMin + ' min × ' + fmtConc(c.mcgPerMin) + ' = ' + fmt2(c.mcg) + ' mcg') : '';
      rn.calc.classList.toggle('shown', !!canCalc);
    });
    n.stopChip.textContent = s.stop ? '10:00' : '';
    n.stopChip.classList.toggle('shown', !!s.stop);
    n.totalVal.textContent = s.total ? fmt2(n.comp.total) : '—';
    n.totalVal.classList.toggle('pulse', !!s.total);
    n.cap.textContent = s.cap;
    n.dots.forEach(function (d, i) { d.classList.toggle('active', i === demo.step); });
    if (n.playBtn) n.playBtn.textContent = demo.timer ? 'Pause' : 'Play';
  }

  function demoPlay() {
    if (demo.reduced || demo.timer) return;
    demo.timer = setInterval(function () { demo.step = (demo.step + 1) % demo.steps; demoRender(); }, 2800);
    demoRender();
  }
  function demoStop() {
    if (demo.timer) { clearInterval(demo.timer); demo.timer = 0; }
    if (demo.nodes) demoRender();
  }
  function demoStart() {
    if (!demo.nodes || demo.reduced) return;
    demo.step = 0; demoRender(); demoPlay();
  }

  /* --------------------------- save / restore state ------------------------ */
  // Serialize the working calculator (not the logs) for the cross-form save code.
  function getState() { return { label: model.label || '', doses: cloneDoses(model.doses) }; }
  function setState(s) {
    if (!s || typeof s !== 'object') return false;
    var srcDoses = (s.doses && s.doses.length) ? s.doses : [{ rows: [], stopTime: '' }];
    var doses = srcDoses.map(function (d) {
      var rows = (((d && d.rows) || [])).map(function (r) {
        return { time: (r && r.time) || '', rateHr: (r && r.rateHr != null) ? r.rateHr : '' };
      });
      // Keep a trailing empty row so the familiar auto-grow behaviour still works.
      if (!rows.length || rowHasContent(rows[rows.length - 1])) rows.push(newRow());
      return { stopTime: (d && d.stopTime) || '', rows: rows };
    });
    model = { label: (s.label != null ? String(s.label) : ''), doses: doses };
    build();             // ensure the UI exists (no-op if already built)
    renderCalc();
    setView('calc');
    return true;
  }

  window.ILOP = { build: build, getState: getState, setState: setState, isDirty: function () { return hasAnyInput(); } };
})(typeof window !== 'undefined' ? window : globalThis);
