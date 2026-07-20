/*
 * Typed date-entry mask for the Chart Audit's date_dmy / datetime_dmy fields.
 *
 * REDCap presents these as plain text DD-MM-YYYY (and DD-MM-YYYY HH:MM) boxes.
 * Native <input type=date>/<datetime-local> segmented boxes caused a year-entry
 * bug: the 4-digit year segment fills RIGHT-to-left, so typing 2-1-2-7 showed
 * 0002 → 0021 → 0212 → 2127 (the confusing "0212"). We instead render a normal
 * text input and format it deterministically here — predictable, cross-browser,
 * and unit-tested in Node.
 *
 * The value stored/displayed is the human DD-MM-YYYY string; payload.js converts
 * it to REDCap's YYYY-MM-DD on submit (the proven prefill format).
 *
 * kind: 'date' -> DD-MM-YYYY (8 digits) ; 'datetime' -> DD-MM-YYYY HH:MM (12 digits)
 */
(function (g) {
  'use strict';

  function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }
  function maxDigits(kind) { return kind === 'datetime' ? 12 : 8; }

  // Format an arbitrary input string into the masked value for `kind`. Pure.
  function format(value, kind) {
    var d = onlyDigits(value).slice(0, maxDigits(kind));
    if (!d) return '';
    var out = d.slice(0, 2);
    if (d.length > 2) out += '-' + d.slice(2, 4);
    if (d.length > 4) out += '-' + d.slice(4, 8);
    if (kind === 'datetime') {
      if (d.length > 8) out += ' ' + d.slice(8, 10);
      if (d.length > 10) out += ':' + d.slice(10, 12);
    }
    return out;
  }

  // Caret helpers for the input handler: count digits left of a string index,
  // then map a digit-count back to a string index in the reformatted value.
  function digitsBefore(str, pos) {
    str = String(str == null ? '' : str); var n = 0;
    for (var i = 0; i < pos && i < str.length; i++) { var c = str.charCodeAt(i); if (c >= 48 && c <= 57) n++; }
    return n;
  }
  function caretForDigits(masked, nDigits) {
    masked = String(masked == null ? '' : masked);
    if (nDigits <= 0) return 0;
    var seen = 0;
    for (var i = 0; i < masked.length; i++) {
      var c = masked.charCodeAt(i);
      if (c >= 48 && c <= 57) { seen++; if (seen === nDigits) return i + 1; }
    }
    return masked.length;
  }

  function daysInMonth(m, y) {
    if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 31;
  }

  // Soft (warn-only) validation message. '' = OK. Empty and still-incomplete values
  // return '' (don't nag mid-typing); a complete-length but impossible value warns.
  function error(value, kind) {
    var d = onlyDigits(value);
    if (!d) return '';
    if (d.length < maxDigits(kind)) return '';            // still typing
    var dd = +d.slice(0, 2), mm = +d.slice(2, 4), yyyy = +d.slice(4, 8);
    if (mm < 1 || mm > 12 || yyyy < 1 || dd < 1 || dd > daysInMonth(mm, yyyy)) {
      return 'Enter a real date as DD-MM-YYYY.';
    }
    if (kind === 'datetime') {
      var hh = +d.slice(8, 10), mi = +d.slice(10, 12);
      if (hh > 23 || mi > 59) return 'Enter a real time as HH:MM (24-hour).';
    }
    return '';
  }

  // Is this a COMPLETE, valid value of `kind`?
  function isComplete(value, kind) {
    return onlyDigits(value).length === maxDigits(kind) && error(value, kind) === '';
  }

  // DD-MM-YYYY[ HH:MM]  ->  YYYY-MM-DD[ HH:MM]  (REDCap prefill format).
  // Returns null if not a complete, valid value of `kind`.
  function toIso(value, kind) {
    if (!isComplete(value, kind)) return null;
    var d = onlyDigits(value);
    var iso = d.slice(4, 8) + '-' + d.slice(2, 4) + '-' + d.slice(0, 2);
    if (kind === 'datetime') iso += ' ' + d.slice(8, 10) + ':' + d.slice(10, 12);
    return iso;
  }

  // YYYY-MM-DD[ HH:MM]  ->  DD-MM-YYYY[ HH:MM]  (inverse of toIso; used when
  // repopulating from a bridge resume). Non-ISO input is returned unchanged, so
  // an already-DD-MM-YYYY value passes through safely.
  function fromIso(value, kind) {
    var s = String(value == null ? '' : value).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
    if (!m) return s;
    var out = m[3] + '-' + m[2] + '-' + m[1];
    if (kind === 'datetime' && m[4]) out += ' ' + m[4] + ':' + m[5];
    return out;
  }

  g.FBDATE = {
    format: format, error: error, isComplete: isComplete, toIso: toIso, fromIso: fromIso,
    digitsBefore: digitsBefore, caretForDigits: caretForDigits,
    onlyDigits: onlyDigits, daysInMonth: daysInMonth
  };
})(typeof window !== 'undefined' ? window : globalThis);
