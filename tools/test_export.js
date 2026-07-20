/*
 * Unit test for the readable CSV/XLSX export logic in site/export.js.
 * Loads the shipped module (same eval-into-global trick as test_roundtrip.js) and
 * asserts decoding, the include-empty/include-hidden toggles, the Section fallback,
 * the optional Variable column, and CSV escaping/BOM — so what ships is what we test.
 * Run: node tools/test_export.js
 */
const fs = require('fs'), path = require('path');
const ROOT = path.dirname(__dirname);
eval(fs.readFileSync(path.join(ROOT, 'site', 'export.js'), 'utf8'));
const X = globalThis.FBEXPORT;

let pass = 0; const fail = [];
function ok(cond, msg) { if (cond) pass++; else fail.push(msg); }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const dict = {
  tabs: [{ id: 't1', label: 'Tab One' }, { id: 't2', label: 'Tab Two' }],
  fields: [
    { var: 'name', section: 'Demographics', label: 'Name', type: 'text', tab: 't1' },
    { var: 'sex', section: '', label: 'Sex', type: 'radio', tab: 't1', options: [{ code: '1', label: 'Male' }, { code: '2', label: 'Female' }] },
    { var: 'smoker', section: 'History', label: 'Smoker?', type: 'yesno', tab: 't1', options: [] },
    { var: 'acts', section: 'History', label: 'Activities', type: 'checkbox', tab: 't2', options: [{ code: '1', label: 'Climbing' }, { code: '2', label: 'Skiing' }, { code: '3', label: 'Hiking' }] },
    { var: 'note', section: '', label: 'Note', type: 'textarea', tab: 't2' },
    { var: 'hidden_field', section: 'X', label: 'Hidden', type: 'text', tab: 't2' },
    { var: 'empty_field', section: 'X', label: 'Empty', type: 'text', tab: 't2' }
  ]
};
const values = { name: 'O\'Brien, "Sam"\nJr', sex: '1', smoker: '0', note: 'line1, line2', hidden_field: 'should not show' };
const checked = { acts: new Set(['1', '3']) };   // Climbing + Hiking, Skiing unchecked (order must be preserved)
const visible = { hidden_field: false };         // everything else defaults visible

// --- decodeAnswer ---
eq(X.decodeAnswer(dict.fields[1], values, checked), 'Male', 'radio decodes to label');
eq(X.decodeAnswer(dict.fields[2], values, checked), 'No', 'yesno 0 -> No');
eq(X.decodeAnswer(dict.fields[3], values, checked), 'Climbing; Hiking', 'checkbox joins labels in option order');
eq(X.decodeAnswer(dict.fields[0], values, checked), 'O\'Brien, "Sam"\nJr', 'text passes through raw');
eq(X.decodeAnswer(dict.fields[6], values, checked), '', 'unanswered text -> empty string');
// array-form checked (serialized state) must behave like a Set
eq(X.decodeAnswer(dict.fields[3], values, { acts: ['2'] }), 'Skiing', 'checkbox accepts array membership');

// --- toReadableRows: defaults (skip empty + hidden) ---
const rows = X.toReadableRows(dict, { values, checked, visible }, {});
eq(rows[0], ['Section', 'Question', 'Answer'], 'header row');
eq(rows.length, 6, 'header + 5 visible-answered rows (hidden & empty skipped)');
eq(rows[2], ['Tab One', 'Sex', 'Male'], 'section falls back to tab label when blank');
eq(rows[4], ['History', 'Activities', 'Climbing; Hiking'], 'checkbox row content + real section kept');
eq(rows[5], ['Tab Two', 'Note', 'line1, line2'], 'textarea row + tab fallback when section blank');
ok(!rows.some(r => r[1] === 'Hidden'), 'hidden field excluded by default');
ok(!rows.some(r => r[1] === 'Empty'), 'empty field excluded by default');

// --- toggles ---
const withEmpty = X.toReadableRows(dict, { values, checked, visible }, { includeEmpty: true });
ok(withEmpty.some(r => r[1] === 'Empty' && r[2] === ''), 'includeEmpty surfaces blank fields');
const withHidden = X.toReadableRows(dict, { values, checked, visible }, { includeHidden: true });
ok(withHidden.some(r => r[1] === 'Hidden'), 'includeHidden surfaces branch-skipped fields');
const withVar = X.toReadableRows(dict, { values, checked, visible }, { includeVar: true });
eq(withVar[0], ['Section', 'Question', 'Answer', 'Variable'], 'includeVar adds Variable header');
eq(withVar[1][3], 'name', 'includeVar appends the REDCap var');

// --- CSV ---
const csv = X.toCsv(rows);
ok(csv.charCodeAt(0) === 0xFEFF, 'CSV starts with UTF-8 BOM');
ok(csv.indexOf('\r\n') > 0, 'CSV uses CRLF line endings');
ok(csv.indexOf('"O\'Brien, ""Sam""\nJr"') >= 0, 'CSV quotes cell + doubles inner quotes, keeps comma/newline');
ok(csv.indexOf('"Section","Question","Answer"') >= 0, 'CSV header quoted');

console.log('checks:', pass + fail.length, '| passed:', pass, '| failed:', fail.length);
fail.forEach(f => console.log('  -- ' + f));
console.log(fail.length === 0 ? '\nPASS: export logic is correct.' : '\nFAIL.');
process.exit(fail.length ? 1 : 0);
