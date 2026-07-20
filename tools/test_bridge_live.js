/*
 * LIVE end-to-end test of the deployed bridge against the REAL REDCap survey, using
 * the app's OWN serialization (FB.buildPayload / buildIntended / recordToState). Proves
 * "the REDCap code works with the app" BOTH ways, thoroughly:
 *
 *   1. app -> REDCap : POST fake chart data, get REDCap's return code, and the Worker's
 *      own round-trip verify confirms REDCap stored exactly what we sent (verified:true).
 *   2. REDCap -> app : GET that code, feed the scraped values through recordToState, and
 *      assert every field reconstructs to what we entered (text/number/date/radio/checkbox/textarea).
 *   3. re-save : edit a field, CLEAR a textarea, UNCHECK a checkbox option, save under the
 *      SAME code, and confirm REDCap now reflects the edits/clears (verified:true, same code) —
 *      the exact silent-corruption path the review flagged, validated live.
 *
 * The bridge is passphrase-gated, so this reads the passphrase from FB_PASS or /tmp/fbpass
 * (kept off the chat). It never prints the passphrase. Creates ONE REDCap record (its
 * study_number ends up 7777777) — delete it after.
 *
 *   printf %s 'YOUR_PASSPHRASE' > /tmp/fbpass
 *   node tools/test_bridge_live.js
 */
const fs = require('fs'), path = require('path');
const ROOT = path.dirname(__dirname);
eval(fs.readFileSync(path.join(ROOT, 'site', 'datemask.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'site', 'branch.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'site', 'payload.js'), 'utf8'));
const FB = globalThis.FB;
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'dictionary.json'), 'utf8'));
const byVar = {}; dict.fields.forEach(f => byVar[f.var] = f);

const BASE = process.env.BRIDGE_BASE || 'https://redcaphelper.haddeya.com';
// The bridge has no passphrase gate, so no secret is needed. (If one is ever set via
// GATE_SHA256, drop it in /tmp/fbpass or FB_PASS and it'll be sent as x-fb-pass.)
let PASS = process.env.FB_PASS || (fs.existsSync('/tmp/fbpass') ? fs.readFileSync('/tmp/fbpass', 'utf8') : '');
PASS = PASS.replace(/\r?\n$/, '');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const asSet = x => new Set((x == null ? [] : (Array.isArray(x) ? x : Array.from(x))).map(String));
const setEq = (a, b) => { a = asSet(a); b = asSet(b); return a.size === b.size && [...a].every(v => b.has(v)); };

// Build payload + intended exactly as the app would, from a {values, checked} state.
function serialize(st) {
  const visible = FB.computeVisibility(dict, st);
  const s = { values: st.values, checked: st.checked, visible };
  return { payload: FB.buildPayload(dict, s), intended: FB.buildIntended(dict, s), visible };
}

async function call(method, body, code) {
  const url = BASE + '/api/code' + (method === 'GET' ? ('?code=' + encodeURIComponent(code) + '&cb=' + Date.now()) : '');
  for (let attempt = 0; attempt < 5; attempt++) {
    let res, txt;
    try {
      res = await fetch(url, {
        method,
        headers: Object.assign({ 'x-fb-pass': PASS }, method === 'POST' ? { 'content-type': 'application/json' } : {}),
        body: method === 'POST' ? JSON.stringify(body) : undefined
      });
      txt = await res.text();
    } catch (e) { console.log('   (network error, retry in 15s)'); await wait(15000); continue; }
    let j; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 160) }; }
    if (j && j.reason === 'daily_limit') {
      console.log('\nABORT: the free daily Browser Run budget is spent — every attempt will 503 until the next UTC day (6 PM in Edmonton). Re-run after the reset.');
      process.exit(3);
    }
    if (res.status === 503 || res.status === 429 || res.status === 502 || res.status === 504) {
      console.log('   (transient ' + res.status + ' ' + (j && j.error || '') + ' — wait 25s, attempt ' + (attempt + 1) + '/5)');
      await wait(25000); continue;
    }
    return { status: res.status, j };
  }
  return { status: 0, j: { error: 'exhausted_retries' } };
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
  console.log('Bridge:', BASE, '\n');

  // ---------- Direction 1: app -> REDCap (fresh save) ----------
  console.log('1) app -> REDCap: fresh save of fake data');
  const st1 = baseState();
  const s1 = serialize(st1);
  let r = await call('POST', { payload: s1.payload, intended: s1.intended });
  ok(r.status === 200 && r.j && r.j.code, 'save returned a REDCap return code  (' + (r.j && (r.j.code || r.j.error)) + ')');
  ok(r.j && r.j.verified === true, 'REDCap stored exactly what we sent (Worker verified:true)' + (r.j && r.j.mismatches ? '  mismatches=' + JSON.stringify(r.j.mismatches) : ''));
  const code = r.j && r.j.code;
  if (!code) { console.log('\nNo code — cannot continue.'); process.exit(1); }
  console.log('   code =', code);
  await wait(8000);

  // ---------- Direction 2: REDCap -> app (resume + reconstruct) ----------
  console.log('2) REDCap -> app: resume the code and rebuild app state via recordToState');
  r = await call('GET', null, code);
  ok(r.status === 200 && r.j && r.j.values, 'resume returned the saved field values');
  const back = FB.recordToState(dict, (r.j && r.j.values) || {});
  ok(back.values.study_number === '8888888', 'text/number round-trips (study_number)');
  ok(back.values.weight === '70', 'optional number round-trips (weight)');
  ok(back.values.date_of_birth === '01-01-1990', 'date round-trips as DD-MM-YYYY (date_of_birth)');
  ok(back.values.sex === byVar.sex.options[0].code, 'radio round-trips (sex)');
  ok(back.values.smoking_history === byVar.smoking_history.options[0].code, 'radio round-trips (smoking_history)');
  ok(back.values.cold_exposure_comments === 'TEST-DATA-DELETE-8888888', 'free text round-trips (cold_exposure_comments)');
  ok(setEq(back.checked.activities_leading_to_frostbite, st1.checked.activities_leading_to_frostbite), 'checkbox set round-trips (activities_leading_to_frostbite)');
  ok(setEq(back.checked.limb_frostbite, st1.checked.limb_frostbite), 'checkbox set round-trips (limb_frostbite)');
  await wait(8000);

  // ---------- Direction 3: re-save with an edit, a CLEAR, and an UNCHECK ----------
  console.log('3) re-save under the SAME code: change a value, CLEAR a textarea, UNCHECK an option');
  const st2 = baseState();
  st2.values.study_number = '7777777';                 // change
  st2.values.cold_exposure_comments = '';              // clear a textarea
  st2.checked.activities_leading_to_frostbite = new Set([byVar.activities_leading_to_frostbite.options[1].code]); // drop option[0]
  const s2 = serialize(st2);
  r = await call('POST', { payload: s2.payload, intended: s2.intended, code });
  ok(r.status === 200 && r.j && r.j.code === code, 're-save kept the SAME code (one record, not a duplicate)');
  ok(r.j && r.j.verified === true, 'REDCap verified the edited/cleared state' + (r.j && r.j.mismatches ? '  mismatches=' + JSON.stringify(r.j.mismatches) : ''));
  await wait(8000);

  console.log('4) REDCap -> app again: confirm the edit + clear + uncheck actually took');
  r = await call('GET', null, code);
  ok(r.status === 200 && r.j && r.j.values, 'second resume returned values');
  const back2 = FB.recordToState(dict, (r.j && r.j.values) || {});
  ok(back2.values.study_number === '7777777', 'changed value took (study_number 8888888 -> 7777777)');
  ok(!back2.values.cold_exposure_comments, 'CLEARED textarea is actually empty in REDCap (no stale value)');
  ok(setEq(back2.checked.activities_leading_to_frostbite, new Set([byVar.activities_leading_to_frostbite.options[1].code])), 'UNCHECKED option removed; kept option remains');
  ok(setEq(back2.checked.limb_frostbite, st2.checked.limb_frostbite), 'untouched checkbox unchanged');

  console.log('\n' + (fails ? ('FAIL: ' + fails + ' assertion(s) failed.') : 'PASS: both directions verified end-to-end against live REDCap.'));
  console.log('Now DELETE the test record (study_number 7777777) in REDCap.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(2); });
