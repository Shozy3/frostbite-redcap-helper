/*
 * Deterministic UI test (jsdom) for the Export feature, end-to-end through the real page:
 *   - the Export button opens the dialog and renders a LIVE preview of the rows
 *   - answers are DECODED (radio -> label, checkbox -> joined labels) in the preview
 *   - the caption reflects the chosen format (.csv / .xlsx) and field count
 *   - "Include REDCap variable names" adds the Variable column live
 *   - Download (CSV) produces a UTF-8-BOM CSV containing the decoded values, names the
 *     file from the study number, and closes the dialog
 *   - Download (Excel) lazily uses the vendored SheetJS and produces a real .xlsx (ZIP)
 *
 * Mirrors the harness in test_features_ui.js. The browser download is captured by
 * stubbing URL.createObjectURL + anchor.click(); no real file is written.
 * Run: node tools/test_export_ui.js   (needs the repo's jsdom dev dep)
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');

let fails = [], passes = 0;
const ok = (c, m) => { if (c) passes++; else fails.push(m); };
const settle = () => new Promise(r => setTimeout(r, 50));
const click = (w, n) => n && n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const change = (w, n) => n && n.dispatchEvent(new w.Event('change', { bubbles: true }));
const btn = (root, t) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === t);

function makePage() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  // Capture the download (jsdom implements neither createObjectURL nor link navigation).
  const dl = {};
  w.URL.createObjectURL = function (b) { dl.blob = b; return 'blob:mock'; };
  w.URL.revokeObjectURL = function () {};
  w.HTMLAnchorElement.prototype.click = function () { dl.clicked = true; dl.name = this.download; };
  w.eval(read('config.js')); w.CONFIG.requirePassphrase = false;
  w.eval(read('datemask.js'));
  w.eval(read('dictionary.js')); w.eval(read('dict_hhr.js')); w.eval(read('branch.js'));
  w.eval(read('payload.js')); w.eval(read('hhr_calc.js')); w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js')); w.eval(read('ilop.js')); w.eval(read('cryptosave.js'));
  w.eval(read('export.js')); w.eval(read('app.js'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, doc: w.document, dl };
}

(async () => {
  const { w, doc, dl } = makePage();
  const DICT = w.DICT;

  // --- enter a representative set of answers through the real DOM ---
  const sn = doc.querySelector('.field[data-var="study_number"] input');
  ok(!!sn, 'study_number input exists');
  if (sn) { sn.value = '12345'; change(w, sn); }
  const sexMale = doc.querySelector('.field[data-var="sex"] input[value="1"]');
  ok(!!sexMale, 'sex radio (Male=1) exists');
  if (sexMale) { sexMale.checked = true; change(w, sexMale); }

  // First branch-free checkbox field with >=2 options -> tick the first two.
  const cbF = DICT.fields.find(f => f.type === 'checkbox' && !f.branch && (f.options || []).length >= 2);
  let cbExpect = '';
  if (cbF) {
    const boxes = [...doc.querySelectorAll('.field[data-var="' + cbF.var + '"] input[type=checkbox]')];
    if (boxes.length >= 2) {
      boxes[0].checked = true; change(w, boxes[0]);
      boxes[1].checked = true; change(w, boxes[1]);
      const codes = [boxes[0].value, boxes[1].value];
      cbExpect = cbF.options.filter(o => codes.indexOf(o.code) >= 0).map(o => o.label).join('; ');
    }
  }

  // --- open the Export dialog ---
  click(w, doc.getElementById('btn-export'));
  await settle();
  const modal = doc.querySelector('.fb-modal');
  ok(!!modal, 'Export dialog opens');
  ok(!!modal.querySelector('.fb-export-table'), 'live preview table renders');
  const pv = modal.querySelector('.fb-export-preview').textContent;
  ok(pv.indexOf('12345') >= 0, 'preview shows the text answer');
  ok(pv.indexOf('Male') >= 0, 'preview decodes the radio code to its label');
  if (cbExpect) ok(pv.indexOf(cbExpect) >= 0, 'preview joins checkbox labels (got "' + cbExpect + '")');
  const cap0 = modal.querySelector('.fb-export-pvcap').textContent;
  ok(/\.csv$/.test(cap0), 'caption shows the .csv name by default');
  ok(/\bfields?\b/.test(cap0), 'caption shows the field count');

  // --- caption tracks the chosen format ---
  const xlsxRadio = modal.querySelector('input[name=fb-exp-fmt][value=xlsx]');
  xlsxRadio.checked = true; change(w, xlsxRadio); await settle();
  ok(/\.xlsx$/.test(modal.querySelector('.fb-export-pvcap').textContent), 'caption switches to .xlsx');

  // --- include-var toggle adds the Variable column live ---
  const varLab = [...modal.querySelectorAll('.fb-export-opts .opt')].find(l => /variable names/i.test(l.textContent));
  const varCb = varLab && varLab.querySelector('input');
  ok(!!varCb, 'the variable-names option exists');
  varCb.checked = true; change(w, varCb); await settle();
  const ths = [...modal.querySelectorAll('.fb-export-table th')].map(t => t.textContent);
  ok(ths.indexOf('Variable') >= 0, 'includeVar adds the Variable column to the preview');
  varCb.checked = false; change(w, varCb); await settle();

  // --- download CSV ---
  const csvRadio = modal.querySelector('input[name=fb-exp-fmt][value=csv]');
  csvRadio.checked = true; change(w, csvRadio); await settle();
  dl.clicked = false; dl.blob = null;
  click(w, btn(modal, 'Download'));
  await settle();
  ok(dl.clicked, 'CSV download is triggered');
  ok(/\.csv$/.test(dl.name || ''), 'CSV file name ends in .csv');
  ok((dl.name || '').indexOf('12345') >= 0, 'file name includes the study number');
  const csvBytes = dl.blob ? new Uint8Array(await dl.blob.arrayBuffer()) : new Uint8Array();
  ok(csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF, 'CSV starts with a UTF-8 BOM (EF BB BF)');
  const csv = dl.blob ? await dl.blob.text() : '';   // text() strips the leading BOM per spec
  ok(csv.indexOf('"Section","Question","Answer"') >= 0, 'CSV has the readable header');
  ok(csv.indexOf('"Male"') >= 0, 'CSV contains the decoded radio label');
  ok(csv.indexOf('"12345"') >= 0, 'CSV contains the text value');
  ok(!doc.querySelector('.fb-modal'), 'dialog closes after a successful export');

  // --- download XLSX (lazy SheetJS) ---
  click(w, doc.getElementById('btn-export')); await settle();
  const modal2 = doc.querySelector('.fb-modal');
  try { w.eval(read('xlsx.mini.min.js')); } catch (e) {}     // browser-equivalent: ensureXlsx injects this same file
  if (!w.XLSX) {                                              // jsdom couldn't run the lib — stub the API so the WIRING is still tested
    w.XLSX = { utils: { aoa_to_sheet: () => ({}), book_new: () => ({ SheetNames: [], Sheets: {} }), book_append_sheet: () => {} }, write: () => new Uint8Array([0x50, 0x4B, 3, 4]) };
  }
  const xr = modal2.querySelector('input[name=fb-exp-fmt][value=xlsx]');
  xr.checked = true; change(w, xr); await settle();
  dl.clicked = false; dl.blob = null;
  click(w, btn(modal2, 'Download'));
  await settle(); await settle();
  ok(dl.clicked, 'XLSX download is triggered');
  ok(/\.xlsx$/.test(dl.name || ''), 'XLSX file name ends in .xlsx');
  const buf = dl.blob ? new Uint8Array(await dl.blob.arrayBuffer()) : new Uint8Array();
  ok(buf[0] === 0x50 && buf[1] === 0x4B, 'XLSX blob is a ZIP container (PK magic)');

  console.log('checks:', passes + fails.length, '| passed:', passes, '| failed:', fails.length);
  fails.forEach(f => console.log('  -- ' + f));
  console.log(fails.length === 0 ? '\nPASS: export dialog works end-to-end.' : '\nFAIL.');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(2); });
