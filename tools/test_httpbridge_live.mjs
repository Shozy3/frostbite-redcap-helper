/*
 * LIVE end-to-end test of the pure-HTTP driver (worker/httpbridge.js) against the
 * REAL REDCap survey — no Cloudflare, no headless browser, run straight from Node:
 *
 *   1. fresh save of app-serialized fake data -> REDCap return code
 *   2. resume that code -> recordToState reconstructs every field type
 *   3. re-save under the same code with an edit + a CLEAR + an UNCHECK -> same code
 *   4. resume again -> the edit/clear/uncheck actually took (no stale values)
 *
 * Creates ONE REDCap record (study_number ends up 7777777) — delete it after.
 *   node tools/test_httpbridge_live.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpSave, httpResumeValues } from '../worker/httpbridge.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(ROOT, 'site', f), 'utf8');
(0, eval)(read('datemask.js'));
(0, eval)(read('branch.js'));
(0, eval)(read('payload.js'));
const FB = globalThis.FB;
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'dictionary.json'), 'utf8'));
const byVar = {}; dict.fields.forEach(f => byVar[f.var] = f);
const SURVEY_URL = process.env.SURVEY_URL || dict.post_action || 'https://redcap.ualberta.ca/surveys/?s=RLREFHHMMWXAEPJJ';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } };
const asSet = x => new Set((x == null ? [] : (Array.isArray(x) ? x : Array.from(x))).map(String));
const setEq = (a, b) => { a = asSet(a); b = asSet(b); return a.size === b.size && [...a].every(v => b.has(v)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function serialize(st) {
  const visible = FB.computeVisibility(dict, st);
  return FB.buildIntended(dict, { values: st.values, checked: st.checked, visible });
}
function baseState() {
  const values = {
    study_number: '8888888', weight: '70', date_of_birth: '01-01-1990',
    sex: byVar.sex.options[0].code,
    smoking_history: byVar.smoking_history.options[0].code,
    cold_exposure_comments: 'TEST-DATA-DELETE-8888888'
  };
  const checked = {
    activities_leading_to_frostbite: new Set([byVar.activities_leading_to_frostbite.options[0].code, byVar.activities_leading_to_frostbite.options[1].code]),
    limb_frostbite: new Set([byVar.limb_frostbite.options[0].code])
  };
  return { values, checked };
}

(async function () {
  console.log('Survey:', SURVEY_URL, '(pure HTTP — no browser, no Cloudflare)\n');

  console.log('1) fresh save via plain HTTP');
  const st1 = baseState();
  const t0 = Date.now();
  const { code } = await httpSave({ surveyUrl: SURVEY_URL, intended: serialize(st1) });
  ok(/^[A-Z0-9]{4,16}$/.test(code || ''), 'got a REDCap-shaped return code (' + code + ') in ' + (Date.now() - t0) + 'ms');
  await wait(1500);

  console.log('2) resume the code, rebuild app state');
  const r1 = await httpResumeValues({ surveyUrl: SURVEY_URL, code });
  ok(!!(r1 && r1.values), 'resume returned values');
  const back = FB.recordToState(dict, (r1 && r1.values) || {});
  ok(back.values.study_number === '8888888', 'text/number round-trips (study_number)');
  ok(back.values.weight === '70', 'optional number round-trips (weight)');
  ok(back.values.date_of_birth === '01-01-1990', 'date round-trips as DD-MM-YYYY (date_of_birth)');
  ok(back.values.sex === byVar.sex.options[0].code, 'radio round-trips (sex)');
  ok(back.values.smoking_history === byVar.smoking_history.options[0].code, 'radio round-trips (smoking_history)');
  ok(back.values.cold_exposure_comments === 'TEST-DATA-DELETE-8888888', 'free text round-trips (cold_exposure_comments)');
  ok(setEq(back.checked.activities_leading_to_frostbite, st1.checked.activities_leading_to_frostbite), 'checkbox set round-trips (activities_leading_to_frostbite)');
  ok(setEq(back.checked.limb_frostbite, st1.checked.limb_frostbite), 'checkbox set round-trips (limb_frostbite)');
  await wait(1500);

  console.log('3) re-save SAME code: change a value, CLEAR a textarea, UNCHECK an option');
  const st2 = baseState();
  st2.values.study_number = '7777777';
  st2.values.cold_exposure_comments = '';
  st2.checked.activities_leading_to_frostbite = new Set([byVar.activities_leading_to_frostbite.options[1].code]);
  const r2 = await httpSave({ surveyUrl: SURVEY_URL, intended: serialize(st2), code });
  ok(r2.code === code, 're-save kept the SAME code (one record, not a duplicate)');
  await wait(1500);

  console.log('4) resume again: edit + clear + uncheck actually took');
  const r3 = await httpResumeValues({ surveyUrl: SURVEY_URL, code });
  const back2 = FB.recordToState(dict, (r3 && r3.values) || {});
  ok(back2.values.study_number === '7777777', 'changed value took (8888888 -> 7777777)');
  ok(!back2.values.cold_exposure_comments, 'CLEARED textarea is empty in REDCap (no stale value)');
  ok(setEq(back2.checked.activities_leading_to_frostbite, new Set([byVar.activities_leading_to_frostbite.options[1].code])), 'UNCHECKED option removed; kept option remains');
  ok(setEq(back2.checked.limb_frostbite, st2.checked.limb_frostbite), 'untouched checkbox unchanged');

  console.log('\n' + (fails ? ('FAIL: ' + fails + ' assertion(s) failed.') : 'PASS: pure-HTTP driver verified end-to-end against live REDCap.'));
  console.log('Now DELETE the test record (study_number 7777777) in REDCap.');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('ERROR', e && e.stage ? (e.message + ' :: ' + e.detail) : (e && e.stack || e));
  process.exit(2);
});
