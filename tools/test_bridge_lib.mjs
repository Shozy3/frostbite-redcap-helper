/*
 * Unit tests for worker/lib.js — the pure logic behind the REDCap bridge Worker:
 * payload validation, intended-state reconstruction, date/number normalization, and
 * the integrity DIFF that decides whether a save round-tripped correctly. ESM, run
 * with: node tools/test_bridge_lib.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.join(path.dirname(__dirname), 'worker', 'lib.js'));
const { normCode, cleanPayload, payloadToIntended, validateIntended, normDate, scalarEq, diff } = lib;

let fails = 0;
function ok(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { fails++; console.log('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? '' : '  — got ' + JSON.stringify(a))); }

console.log('normCode:');
eq(normCode('  a1b2-c3 '), 'A1B2C3', 'uppercases, strips punctuation/space');
eq(normCode('abcdefgh123456789'), 'ABCDEFGH12345678', 'caps at 16');

console.log('cleanPayload:');
ok(cleanPayload([{ name: 'study_number', value: 'X' }]) !== null, 'accepts a valid field, injects __prefill');
eq(cleanPayload([{ name: 'study_number', value: 'X' }])[0], { name: '__prefill', value: '1' }, '__prefill prepended');
ok(cleanPayload([{ name: 'limb_frostbite___2', value: '1' }]) !== null, 'accepts checkbox var___code');
ok(cleanPayload([{ name: 'Bad Name', value: '1' }]) === null, 'rejects illegal field name');
ok(cleanPayload([{ name: 'a', value: '1' }, { name: 'a', value: '2' }]) === null, 'rejects duplicate names');
ok(cleanPayload([{ name: '__prefill', value: '1' }]) === null, 'rejects payload with no real fields');
ok(cleanPayload([]) === null, 'rejects empty');
ok(cleanPayload([{ name: 'x', value: 'y'.repeat(9000) }]) === null, 'rejects over-long value');

console.log('payloadToIntended:');
const intended = payloadToIntended([
  { name: '__prefill', value: '1' },
  { name: 'study_number', value: 'EDM-7' },
  { name: 'sex', value: '2' },
  { name: 'date_of_birth', value: '1999-02-21' },
  { name: 'limb_frostbite___2', value: '1' },
  { name: 'limb_frostbite___5', value: '1' }
]);
eq(intended.scalars, { study_number: 'EDM-7', sex: '2', date_of_birth: '1999-02-21' }, 'scalars grouped');
eq(intended.checks, { limb_frostbite: ['2', '5'] }, 'checkbox codes grouped + sorted');

console.log('normDate (ISO vs DMY skew):');
eq(normDate('1999-02-21'), '19990221', 'ISO date');
eq(normDate('21-02-1999'), '19990221', 'DMY date -> same key');
eq(normDate('2000-01-15 13:45'), '200001151345', 'ISO datetime');
eq(normDate('15-01-2000 13:45'), '200001151345', 'DMY datetime -> same key');
ok(normDate('hello') === null, 'non-date -> null');

console.log('scalarEq:');
ok(scalarEq('1999-02-21', '21-02-1999'), 'date ISO == DMY');
ok(scalarEq('5', '5.0'), 'number 5 == 5.0');
ok(scalarEq(' 5 ', '5'), 'trims');
ok(!scalarEq('5', '6'), '5 != 6');
ok(!scalarEq('abc', 'abd'), 'different strings not equal');
ok(scalarEq('EDM-7', 'EDM-7'), 'identical strings equal');

console.log('diff (integrity gate):');
let d = diff(intended, {
  study_number: 'EDM-7',
  sex: '2',
  date_of_birth: '21-02-1999',      // scraped back in DMY — must still match ISO intent
  limb_frostbite: ['5', '2']        // order-independent
});
ok(d.ok && d.mismatches.length === 0, 'perfect round-trip (with date skew + checkbox reorder) verifies');

d = diff(intended, { study_number: 'EDM-7', sex: '2', date_of_birth: '21-02-1999', limb_frostbite: ['5'] });
ok(!d.ok && d.mismatches.some(m => m.var === 'limb_frostbite'), 'a dropped checkbox code is caught');

d = diff(intended, { study_number: 'EDM-9', sex: '2', date_of_birth: '21-02-1999', limb_frostbite: ['2', '5'] });
ok(!d.ok && d.mismatches.some(m => m.var === 'study_number'), 'a changed scalar is caught');

d = diff(intended, { sex: '2', date_of_birth: '21-02-1999', limb_frostbite: ['2', '5'] });
ok(!d.ok && d.mismatches.some(m => m.var === 'study_number'), 'a missing field is caught');

d = diff(payloadToIntended([{ name: '__prefill', value: '1' }, { name: 'sex', value: '1' }]),
         { sex: ['1'] });  // scraped a checkbox where we expected a scalar
ok(!d.ok, 'type mismatch (array where scalar expected) is caught');

console.log('validateIntended:');
ok(validateIntended({ scalars: { study_number: 'X', sex: '' }, checks: { limb_frostbite: ['2', '5'] } }) !== null, 'accepts a well-formed full intended (incl. empty scalar)');
ok(validateIntended({ scalars: {}, checks: { g: [] } }) !== null, 'accepts an empty checkbox group []');
ok(validateIntended({ scalars: { 'Bad Name': 'x' } }) === null, 'rejects an illegal var name');
ok(validateIntended({ scalars: { a: {} } }) === null, 'rejects a non-string scalar value');
ok(validateIntended({ checks: { a: 'notarray' } }) === null, 'rejects a non-array checkbox group');
ok(validateIntended({ checks: { a: ['ok', 'b ad'] } }) === null, 'rejects a bad checkbox code');
ok(validateIntended({}) === null, 'rejects a completely empty intended');
ok(validateIntended('nope') === null, 'rejects a non-object');

console.log('diff verifies CLEARED fields (the fix for silent re-save corruption):');
// Full intended carries blanks/empty groups, so clearing is verifiable.
const clearedIntended = { scalars: { study_number: 'EDM-7', notes: '' }, checks: { limb_frostbite: [] } };
d = diff(clearedIntended, { study_number: 'EDM-7' }); // notes empty + no checkbox -> both absent from scrape
ok(d.ok, 'a cleared scalar (\'\') and a cleared checkbox group ([]) verify against an empty scrape');
d = diff(clearedIntended, { study_number: 'EDM-7', notes: 'leftover' }); // REDCap kept a stale text value
ok(!d.ok && d.mismatches.some(m => m.var === 'notes'), 'a stale scalar REDCap failed to clear IS caught');
d = diff(clearedIntended, { study_number: 'EDM-7', limb_frostbite: ['2'] }); // stale checkbox left checked
ok(!d.ok && d.mismatches.some(m => m.var === 'limb_frostbite'), 'a stale checkbox REDCap failed to clear IS caught');

console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: bridge lib logic correct.');
process.exit(fails ? 1 : 0);
