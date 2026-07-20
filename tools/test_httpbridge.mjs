/*
 * Offline unit tests for worker/httpbridge.js — the pure-HTTP REDCap driver —
 * pinned against a saved copy of the REAL survey page (tools/survey.html) plus
 * synthetic fixtures for the confirmation/return-code page.
 * Run: node tools/test_httpbridge.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  decodeEntities, parseAttrs, mainFormHtml, formAction, csrfToken, formFields,
  surveyVars, valuesFromForm, applyIntendedToFields, fieldFormats, toDisplayDate,
  extractReturnCode, looksLikeSurveyForm, looksLikeReturnCodeForm
} from '../worker/httpbridge.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'tools', 'survey.html'), 'utf8');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '  (' + JSON.stringify(a) + ')');

console.log('parsing the real survey page:');
const fields = formFields(html);
ok(Object.keys(fields).length > 400, 'parses 400+ form controls (' + Object.keys(fields).length + ')');
for (const k of ['__page__', '__page_hash__', '__response_hash__', '__start_time__', '__start_time_hash__', 'redcap_csrf_token']) {
  ok(k in fields, 'metadata field present: ' + k);
}
ok(!('form_file_upload' in fields) && Object.keys(fields).every(k => k.indexOf('__passthru') < 0), 'file-upload forms (after the main form) are excluded');
eq(formAction(html), '/surveys/index.php?s=RLREFHHMMWXAEPJJ', 'form action extracted');
ok(csrfToken(html).length >= 32, 'csrfToken JS global extracted (' + csrfToken(html).length + ' chars)');
const vars = surveyVars(html);
ok(vars.length > 100 && vars.includes('study_number') && vars.includes('date_of_birth'), 'survey vars from tr[sq_id] (' + vars.length + ')');
ok(looksLikeSurveyForm(html), 'recognizes the survey form page');
ok(!looksLikeReturnCodeForm(html), 'survey page is not mistaken for the code-entry page');
eq(valuesFromForm(fields, vars), {}, 'blank survey page yields no values');
const fm = fieldFormats(html);
eq(fm.date_of_birth, 'date_dmy', 'field format read from fv attribute');

console.log('value extraction from a filled form:');
const filled = Object.assign({}, fields, {
  study_number: '123', cold_exposure_comments: 'a &quot;b&quot;', sex: '2',
  __chk__limb_frostbite_RC_1: '1', __chk__limb_frostbite_RC_3: '3',
  date_of_birth: '01-01-1990', redcap_csrf_token: 'x', field_name: 'junk'
});
const vals = valuesFromForm(filled, vars);
eq(vals.study_number, '123', 'scalar extracted');
eq(vals.sex, '2', 'radio hidden extracted');
eq(vals.limb_frostbite, ['1', '3'], 'checkbox codes collected from __chk__ hiddens');
ok(!('redcap_csrf_token' in vals) && !('field_name' in vals) && !('__page__' in vals), 'metadata never leaks into values');

console.log('applyIntendedToFields (set AND clear, browser parity):');
const f2 = Object.assign({}, filled);
applyIntendedToFields(f2, {
  scalars: { study_number: '456', cold_exposure_comments: '', __page__: 'evil', not_a_field: 'x' },
  checks: { limb_frostbite: ['3'] }
});
eq(f2.study_number, '456', 'scalar set');
eq(f2.cold_exposure_comments, '', 'scalar cleared to empty');
eq(f2.__chk__limb_frostbite_RC_1, '', 'unchecked option cleared');
eq(f2.__chk__limb_frostbite_RC_3, '3', 'kept option still set');
ok(f2.__chk__activities_leading_to_frostbite_RC_1 === fields.__chk__activities_leading_to_frostbite_RC_1, 'untouched checkbox group keeps served state');
ok(f2.__page__ === fields.__page__, 'metadata cannot be overridden via intended');
ok(!('not_a_field' in f2), 'unknown fields are not injected');

console.log('date conversion (ISO app values -> field display format):');
eq(toDisplayDate('1990-01-01', 'date_dmy'), '01-01-1990', 'date_dmy');
eq(toDisplayDate('1990-01-31', 'date_mdy'), '01-31-1990', 'date_mdy');
eq(toDisplayDate('1990-01-01', 'date_ymd'), '1990-01-01', 'date_ymd passes through');
eq(toDisplayDate('2026-07-09 14:30', 'datetime_dmy'), '09-07-2026 14:30', 'datetime_dmy with time');
eq(toDisplayDate('01-01-1990', 'date_dmy'), '01-01-1990', 'already-display value passes through');
eq(toDisplayDate('', 'date_dmy'), '', 'empty passes through');

console.log('entities and attribute quoting:');
eq(decodeEntities('a &quot;b&quot; &amp; &#039;c&#039; &lt;d&gt;'), 'a "b" & \'c\' <d>', 'entity decode');
eq(parseAttrs("name='x' value=\"y z\" code=1").name, 'x', 'single-quoted attr');
eq(parseAttrs("name='x' value=\"y z\"").value, 'y z', 'double-quoted attr');
eq(parseAttrs('checked name=plain').name, 'plain', 'bare attr value');

console.log('return-code extraction (confirmation page shapes):');
const conf1 = '<html><body><p>Your <b>return code</b> is below</p>' +
  '<input type="text" readonly aria-labelledby="return-step1 x" value="AB12CD34"></body></html>';
eq(extractReturnCode(conf1), 'AB12CD34', 'locked selector: input aria-labelledby return-step1');
const conf2 = '<html><body>Somewhere: your return code: <b>ZZ99YY88</b> — write it down</body></html>';
eq(extractReturnCode(conf2), 'ZZ99YY88', 'text-proximity fallback');
eq(extractReturnCode('<html><body>nothing here</body></html>'), '', 'no code -> empty');
const retPage = "<div><form id='return_code_form'><input name='__code' maxlength='15'></form></div>";
ok(looksLikeReturnCodeForm(retPage), 'recognizes the code-entry page');

console.log('\n' + (fails ? ('FAIL: ' + fails + ' assertion(s) failed.') : 'PASS: httpbridge parsing pinned.'));
process.exit(fails ? 1 : 0);
