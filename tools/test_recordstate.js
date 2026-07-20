/*
 * Round-trip test for FB.recordToState (site/payload.js) + FBDATE.fromIso
 * (site/datemask.js): the app's state -> buildPayload -> (simulate REDCap scrape) ->
 * recordToState should reproduce the original state, for text / radio / checkbox /
 * date fields. This proves a form whose code was minted on the REDCap side
 * repopulates correctly in the app. Run: node tools/test_recordstate.js
 */
const fs = require('fs'), path = require('path');
const ROOT = path.dirname(__dirname);
eval(fs.readFileSync(path.join(ROOT, 'site', 'datemask.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'site', 'branch.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'site', 'payload.js'), 'utf8'));
const FB = globalThis.FB, FBDATE = globalThis.FBDATE;
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'dictionary.json'), 'utf8'));
const byVar = {}; dict.fields.forEach(f => byVar[f.var] = f);

let fails = 0;
function ok(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { fails++; console.log('  ✗ ' + msg); } }

console.log('FBDATE.fromIso:');
ok(FBDATE.fromIso('1999-02-21', 'date') === '21-02-1999', 'ISO date -> DD-MM-YYYY');
ok(FBDATE.fromIso('2000-01-15 13:45', 'datetime') === '15-01-2000 13:45', 'ISO datetime -> DD-MM-YYYY HH:MM');
ok(FBDATE.fromIso('21-02-1999', 'date') === '21-02-1999', 'already DMY passes through unchanged');
ok(FBDATE.fromIso('', 'date') === '', 'empty stays empty');

// Simulate REDCap scraping the resumed form: text/radio come back as strings,
// checkboxes as arrays of codes, dates in the survey's DD-MM-YYYY display format.
function simulateScrape(dict, state) {
  const out = {};
  const vis = FB.computeVisibility(dict, state);
  dict.fields.forEach(f => {
    if (vis[f.var] === false) return;
    if (f.type === 'checkbox') {
      const s = state.checked[f.var]; const arr = s ? Array.from(s) : [];
      if (arr.length) out[f.var] = arr;
    } else {
      let v = state.values[f.var]; if (v == null || v === '') return;
      if (f.validation && f.validation.indexOf('date') === 0) {
        const kind = f.validation.indexOf('datetime') === 0 ? 'datetime' : 'date';
        v = FBDATE.fromIso(FB.fmtDate(v, f.validation), kind); // ISO in state -> DMY on screen
      }
      out[f.var] = String(v);
    }
  });
  return out;
}

console.log('state -> payload/scrape -> recordToState round-trip:');
// A representative filled state (values stored the way the app stores them).
const state = {
  values: {
    study_number: 'EDM-7',
    date_of_birth: '21-02-1999',       // app stores dates as DD-MM-YYYY
    sex: '2',
    admitting_diagnosis: 'Bilateral hand frostbite'
  },
  checked: { limb_frostbite: new Set(['2', '5']) }
};
// buildPayload converts DMY dates to ISO (as posted to REDCap).
const scraped = simulateScrape(dict, state);
const back = FB.recordToState(dict, scraped);

ok(back.values.study_number === 'EDM-7', 'text field survives');
ok(back.values.sex === '2', 'radio code survives');
ok(back.values.admitting_diagnosis === 'Bilateral hand frostbite', 'free-text survives');
ok(back.values.date_of_birth === '21-02-1999', 'date restored to DD-MM-YYYY');
ok(back.checked.limb_frostbite && JSON.stringify(back.checked.limb_frostbite.sort()) === JSON.stringify(['2', '5']), 'checkbox codes survive');
ok(!('__prefill' in back.values), '__prefill is not a field');

console.log('recordToState ignores unknown fields + empties:');
const b2 = FB.recordToState(dict, { study_number: 'X', not_a_field: 'zzz', sex: '' });
ok(b2.values.study_number === 'X', 'known field kept');
ok(!('not_a_field' in b2.values), 'unknown field dropped');
ok(!('sex' in b2.values), 'empty scalar dropped');

console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: recordToState round-trip correct.');
process.exit(fails ? 1 : 0);
