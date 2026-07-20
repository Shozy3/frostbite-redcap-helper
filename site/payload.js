/*
 * Shared, dependency-free REDCap prefill payload builder.
 * Turns the form's current state into the exact name/value pairs to POST to the
 * survey (the "__prefill" HTML-form method). Used by app.js AND the Node
 * round-trip test, so what we test is exactly what ships.
 *
 * Proven against live REDCap:
 *   text / number      -> name=var            value=<raw>
 *   radio / yesno      -> name=var            value=<code>
 *   date  (date_*)     -> name=var            value=YYYY-MM-DD
 *   datetime (datetime_*) -> name=var         value="YYYY-MM-DD HH:MM"
 *   checkbox           -> name=var___<code>   value=1   (one per checked option)
 *   trigger            -> name=__prefill      value=1
 *
 * Only fields currently VISIBLE under branching are sent (REDCap erases hidden
 * fields); empty values are omitted.
 */
(function (g) {
  // Leap-year-aware day count; used to validate the ISO passthrough branch below.
  function daysInMonthLocal(m, y) {
    if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 0;
  }

  function fmtDate(v, validation) {
    if (!v) return v;
    v = String(v);
    var kind = (validation && validation.indexOf('datetime') === 0) ? 'datetime' : 'date';
    // Already in REDCap's ISO format (year-first), e.g. a pre-existing/native value:
    // normalise the separator and pass through unchanged.
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      // Normalise the separator, then VALIDATE before passing through, so an impossible
      // value (e.g. 9999-99-99, 2020-13-45, 2020-02-30) arriving via a restored/injected
      // save blob is omitted rather than POSTed to REDCap.
      var norm = kind === 'datetime' ? v.replace('T', ' ').slice(0, 16) : v.slice(0, 10);
      var p = /^(\d{4})-(\d{2})-(\d{2})/.exec(norm);
      var yy = +p[1], mo = +p[2], dd = +p[3];
      if (mo < 1 || mo > 12 || yy < 1 || dd < 1 || dd > daysInMonthLocal(mo, yy)) return '';
      var t = /(\d{2}):(\d{2})$/.exec(norm);
      if (t && (+t[1] > 23 || +t[2] > 59)) return '';
      return norm;
    }
    // Typed DD-MM-YYYY[ HH:MM] (what the masked text inputs produce) -> YYYY-MM-DD[ HH:MM].
    if (g.FBDATE && typeof g.FBDATE.toIso === 'function') {
      var iso = g.FBDATE.toIso(v, kind);
      if (iso) return iso;
    }
    return ''; // incomplete/invalid dmy — omit rather than POST a misparseable day-first date
  }

  function has(set, code) {
    if (!set) return false;
    if (typeof set.has === 'function') return set.has(code);
    return set.indexOf && set.indexOf(code) >= 0;
  }

  function buildPayload(dict, state) {
    var out = [{ name: '__prefill', value: '1' }];
    var values = state.values || {};
    var checked = state.checked || {};
    var visible = state.visible || {};
    dict.fields.forEach(function (f) {
      if (visible[f.var] === false) return;                 // branch-hidden
      if (f.type === 'checkbox') {
        var set = checked[f.var];
        f.options.forEach(function (o) {
          if (has(set, o.code)) out.push({ name: f.var + '___' + o.code, value: '1' });
        });
      } else {
        var v = values[f.var];
        if (v == null) return;
        v = String(v).trim();
        if (v === '') return;
        if (f.validation && f.validation.indexOf('date') === 0) { v = fmtDate(v, f.validation); if (v === '') return; }
        out.push({ name: f.var, value: v });
      }
    });
    return out;
  }

  // Inverse of buildPayload: turn the values the bridge Worker scraped back out of
  // REDCap ({ var: value | [codes] }) into the app's state shape ({ values, checked }),
  // so a form whose code was minted on the REDCap side can be repopulated here.
  // Only known dictionary fields are accepted (ignore anything unexpected). Dates
  // come back as DD-MM-YYYY (the survey's display format = the app's own format);
  // fromIso is a defensive pass-through in case a value arrives ISO-formatted.
  function recordToState(dict, map) {
    var byVar = {}; dict.fields.forEach(function (f) { byVar[f.var] = f; });
    var values = {}, checked = {};
    Object.keys(map || {}).forEach(function (v) {
      var f = byVar[v]; if (!f) return;
      var raw = map[v];
      if (f.type === 'checkbox') {
        var arr = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
        if (arr.length) checked[v] = arr.map(String);
      } else {
        var s = Array.isArray(raw) ? String(raw[0] == null ? '' : raw[0]) : String(raw == null ? '' : raw);
        if (s === '') return;
        if (f.validation && f.validation.indexOf('date') === 0 && g.FBDATE && g.FBDATE.fromIso) {
          var kind = f.validation.indexOf('datetime') === 0 ? 'datetime' : 'date';
          s = g.FBDATE.fromIso(s, kind);
        }
        values[v] = s;
      }
    });
    return { values: values, checked: checked };
  }

  // The COMPLETE intended state of every VISIBLE field, empties included — the
  // authority the bridge Worker uses both to clear fields the user blanked (not just
  // set new values) and to verify the save round-trip. Shape mirrors the Worker's
  // diff():  { scalars: { var: value }, checks: { var: [code,...] } }.
  //   - Every visible non-checkbox field gets a scalars[var] (possibly '') so a
  //     cleared field is explicitly carried, not silently omitted like buildPayload.
  //   - Every visible checkbox field gets a checks[var] array (possibly []) so a
  //     fully-unchecked group is explicit too.
  //   - Dates are emitted ISO (YYYY-MM-DD[ HH:MM]) to match buildPayload/prefill;
  //     invalid/incomplete dates become '' (same rule as fmtDate).
  function buildIntended(dict, state) {
    var values = state.values || {};
    var checked = state.checked || {};
    var visible = state.visible || {};
    var scalars = {}, checks = {};
    dict.fields.forEach(function (f) {
      if (visible[f.var] === false) return;
      if (f.type === 'checkbox') {
        var set = checked[f.var];
        var codes = [];
        f.options.forEach(function (o) { if (has(set, o.code)) codes.push(o.code); });
        checks[f.var] = codes;
      } else {
        var v = values[f.var];
        v = (v == null) ? '' : String(v).trim();
        if (v !== '' && f.validation && f.validation.indexOf('date') === 0) v = fmtDate(v, f.validation);
        scalars[f.var] = v;
      }
    });
    return { scalars: scalars, checks: checks };
  }

  g.FB = g.FB || {};
  g.FB.buildPayload = buildPayload;
  g.FB.buildIntended = buildIntended;
  g.FB.recordToState = recordToState;
  g.FB.fmtDate = fmtDate;
})(typeof window !== 'undefined' ? window : globalThis);
