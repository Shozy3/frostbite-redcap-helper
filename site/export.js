/*
 * Export the Chart Audit to a readable CSV / XLSX.
 * Dependency-free for everything except .xlsx, which lazy-loads the self-hosted
 * SheetJS build (xlsx.mini.min.js) only when first needed — the strict CSP
 * (script-src 'self') forbids a CDN, so the library lives same-origin.
 *
 * "Readable summary" layout: one row per field, columns Section, Question, Answer,
 * with coded answers DECODED to their option labels (radio -> label, checkbox ->
 * labels joined with "; ", yes/no -> Yes/No). Dates are shown as entered (day-first),
 * matching what the user typed. Hidden (branch-skipped) and unanswered fields are
 * omitted unless opts say otherwise.
 *
 * The pure functions (decodeAnswer/toReadableRows/toCsv) take no DOM and are unit-
 * tested in Node (tools/test_export.js); the download helpers touch document/URL/XLSX
 * only when invoked, so loading this file under Node is safe.
 */
(function (g) {
  'use strict';

  function has(set, code) {
    if (!set) return false;
    if (typeof set.has === 'function') return set.has(code);     // Set (live state)
    return set.indexOf ? set.indexOf(code) >= 0 : false;          // Array (serialized state)
  }
  function optMapOf(field) {
    var m = {};
    (field.options || []).forEach(function (o) { m[o.code] = o.label; });
    return m;
  }

  // One field's current answer as human-readable text ('' when blank/unanswered).
  function decodeAnswer(field, values, checked) {
    if (field.type === 'checkbox') {
      var set = (checked || {})[field.var];
      var picks = [];
      (field.options || []).forEach(function (o) { if (has(set, o.code)) picks.push(o.label); });
      return picks.join('; ');
    }
    var v = (values || {})[field.var];
    if (v == null) return '';
    v = String(v).trim();
    if (v === '') return '';
    if (field.type === 'radio') { var m = optMapOf(field); return m[v] != null ? m[v] : v; }
    if (field.type === 'yesno') {
      if (v === '1') return 'Yes';
      if (v === '0') return 'No';
      var m2 = optMapOf(field); return m2[v] != null ? m2[v] : v;
    }
    return v; // text / textarea / number / date — shown as entered
  }

  function tabLabelOf(dict, tabId) {
    var t = (dict.tabs || []).filter(function (x) { return x.id === tabId; })[0];
    return t ? t.label : '';
  }

  // Build the 2-D rows (incl. header) for the readable export.
  //   state = { values, checked, visible }   opts = { includeEmpty, includeHidden, includeVar }
  function toReadableRows(dict, state, opts) {
    opts = opts || {};
    state = state || {};
    var values = state.values || {}, checked = state.checked || {}, visible = state.visible || {};
    var header = ['Section', 'Question', 'Answer'];
    if (opts.includeVar) header.push('Variable');
    var rows = [header];
    (dict.fields || []).forEach(function (f) {
      if (visible[f.var] === false && !opts.includeHidden) return;       // branch-hidden
      var ans = decodeAnswer(f, values, checked);
      if (ans === '' && !opts.includeEmpty) return;                       // unanswered
      var section = (f.section && String(f.section).trim()) ? f.section : tabLabelOf(dict, f.tab);
      var row = [section, f.label, ans];
      if (opts.includeVar) row.push(f.var);
      rows.push(row);
    });
    return rows;
  }

  // RFC-4180-ish CSV: quote every cell, double embedded quotes, CRLF rows, UTF-8 BOM
  // (so Excel reads accented text and leading-zero codes correctly).
  function csvCell(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
  function toCsv(rows) {
    return '﻿' + (rows || []).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  // ---- browser-only download helpers (no-ops never called under Node) ----
  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 0);
  }
  function downloadCsv(filename, rows) {
    download(filename, new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  }

  // Carry the page's cache-bust token onto the lazily-injected library URL so a new
  // deploy fetches the matching xlsx build (mirrors app.js's BUILD detection).
  function buildToken() {
    try {
      var s = document.querySelector('script[src*="export.js"]');
      var m = s && /[?&]v=([^&"']+)/.exec(s.getAttribute('src') || '');
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var xlsxPromise = null;
  function ensureXlsx() {
    if (g.XLSX) return Promise.resolve(g.XLSX);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise(function (resolve, reject) {
      var tok = buildToken();
      var s = document.createElement('script');
      s.src = 'xlsx.mini.min.js' + (tok ? '?v=' + tok : '');
      s.async = true;
      s.onload = function () { if (g.XLSX) resolve(g.XLSX); else { xlsxPromise = null; reject(new Error('xlsx_unavailable')); } };
      s.onerror = function () { xlsxPromise = null; reject(new Error('xlsx_load_failed')); };
      document.head.appendChild(s);
    });
    return xlsxPromise;
  }
  function downloadXlsx(filename, rows, sheetName) {
    return ensureXlsx().then(function (X) {
      var ws = X.utils.aoa_to_sheet(rows);
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, sheetName || 'Chart Audit');
      var buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
      download(filename, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
  }

  g.FBEXPORT = {
    decodeAnswer: decodeAnswer,
    toReadableRows: toReadableRows,
    toCsv: toCsv,
    download: download,
    downloadCsv: downloadCsv,
    ensureXlsx: ensureXlsx,
    downloadXlsx: downloadXlsx
  };
})(typeof window !== 'undefined' ? window : globalThis);
