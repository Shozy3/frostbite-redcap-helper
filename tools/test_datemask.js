/*
 * Date-mask unit tests — the EXACT code that ships in site/datemask.js (UMD export),
 * plus the payload.js DD-MM-YYYY <-> ISO conversion that depends on it.
 *
 * This is the regression guard for the "typing 2127 shows 0212" bug: with the typed
 * mask, no incremental input ever produces a right-aligned zero-padded year.
 */
const path = require('path');
const ROOT = path.dirname(__dirname);
require(path.join(ROOT, 'site', 'datemask.js'));   // sets globalThis.FBDATE
require(path.join(ROOT, 'site', 'payload.js'));     // sets globalThis.FB (uses FBDATE)
const D = globalThis.FBDATE, FB = globalThis.FB;
if (!D) { console.error('FAIL: FBDATE not exported'); process.exit(1); }
if (!FB || !FB.fmtDate) { console.error('FAIL: FB.fmtDate not exported'); process.exit(1); }

let fails = 0;
function eq(actual, expected, msg) {
  if (actual === expected) console.log('  ✓ ' + msg);
  else { fails++; console.log('  ✗ ' + msg + '  — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

console.log('format() — date, incremental typing:');
eq(D.format('', 'date'), '', 'empty stays empty');
eq(D.format('2', 'date'), '2', '"2"');
eq(D.format('21', 'date'), '21', '"21"');
eq(D.format('210', 'date'), '21-0', '"210" -> 21-0');
eq(D.format('2102', 'date'), '21-02', '"2102" -> 21-02');
eq(D.format('21021', 'date'), '21-02-1', '"21021" -> 21-02-1');
eq(D.format('21021999', 'date'), '21-02-1999', 'full DOB 21-02-1999');
eq(D.format('210219991', 'date'), '21-02-1999', 'extra digits beyond 8 are dropped');
eq(D.format('ab21cd02', 'date'), '21-02', 'non-digits stripped');
eq(D.format('21-02-1999', 'date'), '21-02-1999', 'pasting an already-formatted date is idempotent');

console.log('THE BUG: typing 2-1-2-7 must never render "0212":');
['2', '21', '212', '2127'].forEach(function (s) {
  ok(D.format(s, 'date') !== '0212', '"' + s + '" -> "' + D.format(s, 'date') + '" (not 0212)');
});
eq(D.format('2127', 'date'), '21-27', '"2127" -> 21-27 (left-to-right, no zero-pad)');
// And entering a real year reads left-to-right, never right-aligned.
eq(D.format('15032127', 'date'), '15-03-2127', 'year 2127 entered as the last 4 digits');

console.log('format() — datetime, separator boundaries:');
eq(D.format('21021999', 'datetime'), '21-02-1999', 'datetime with no time yet');
eq(D.format('210219991', 'datetime'), '21-02-1999 1', 'space before hour at 9th digit');
eq(D.format('2102199914', 'datetime'), '21-02-1999 14', 'two hour digits');
eq(D.format('21021999143', 'datetime'), '21-02-1999 14:3', 'colon before minute at 11th digit');
eq(D.format('210219991430', 'datetime'), '21-02-1999 14:30', 'full datetime');
eq(D.format('2102199914309', 'datetime'), '21-02-1999 14:30', 'digits beyond 12 dropped');

console.log('error() — soft, warn-only (incomplete is silent):');
eq(D.error('', 'date'), '', 'empty: no warn');
eq(D.error('21', 'date'), '', 'incomplete: no warn while typing');
eq(D.error('21-02-19', 'date'), '', 'still incomplete (6 digits): no warn');
eq(D.error('21-02-1999', 'date'), '', 'valid full date: no warn');
ok(D.error('99-99-9999', 'date'), 'impossible date warns');
ok(D.error('31-02-2000', 'date'), 'Feb 31 warns');
eq(D.error('29-02-2000', 'date'), '', 'Feb 29 2000 (leap) is valid');
ok(D.error('29-02-2001', 'date'), 'Feb 29 2001 (non-leap) warns');
ok(D.error('00-01-2000', 'date'), 'day 00 warns');
ok(D.error('01-13-2000', 'date'), 'month 13 warns');
eq(D.error('01-01-2000 23:59', 'datetime'), '', 'valid datetime: no warn');
ok(/time/i.test(D.error('01-01-2000 24:00', 'datetime')), 'hour 24 warns (time message)');
ok(/time/i.test(D.error('01-01-2000 12:60', 'datetime')), 'minute 60 warns (time message)');

console.log('isComplete() / toIso():');
ok(D.isComplete('21-02-1999', 'date'), '21-02-1999 is complete');
ok(!D.isComplete('21-02-199', 'date'), '21-02-199 is not complete');
ok(!D.isComplete('31-02-2000', 'date'), 'invalid date is not "complete"');
eq(D.toIso('21-02-1999', 'date'), '1999-02-21', 'dmy date -> ISO');
eq(D.toIso('05-09-2099', 'date'), '2099-09-05', 'single-digit-ish parts keep zero padding');
eq(D.toIso('21-02-1999 14:30', 'datetime'), '1999-02-21 14:30', 'dmy datetime -> ISO');
eq(D.toIso('21-02-199', 'date'), null, 'incomplete -> null');
eq(D.toIso('31-02-2000', 'date'), null, 'invalid -> null');

console.log('caret helpers:');
eq(D.digitsBefore('21-02', 5), 4, 'digitsBefore("21-02",5) = 4');
eq(D.digitsBefore('21-02-1999', 0), 0, 'caret at start = 0 digits before');
eq(D.caretForDigits('21-02-1999', 0), 0, 'caretForDigits(...,0) = 0');
eq(D.caretForDigits('21-02-1999', 2), 2, 'after 2 digits = index 2 (before "-")');
eq(D.caretForDigits('21-02-1999', 4), 5, 'after 4 digits = index 5 (before 2nd "-")');
eq(D.caretForDigits('21-02-1999', 8), 10, 'after all 8 digits = end');

console.log('payload.js fmtDate (DD-MM-YYYY -> REDCap ISO; ISO passes through):');
eq(FB.fmtDate('21-02-1999', 'date_dmy'), '1999-02-21', 'date_dmy -> ISO');
eq(FB.fmtDate('21-02-1999 14:30', 'datetime_dmy'), '1999-02-21 14:30', 'datetime_dmy -> ISO');
eq(FB.fmtDate('1999-02-21', 'date_dmy'), '1999-02-21', 'already-ISO date passes through');
eq(FB.fmtDate('2000-01-15T13:45', 'datetime_dmy'), '2000-01-15 13:45', 'ISO datetime-local (T) normalised (back-compat)');
eq(FB.fmtDate('2020-02-29', 'date_dmy'), '2020-02-29', 'valid ISO leap day still passes through (F-16)');
eq(FB.fmtDate('2020-13-45', 'date_dmy'), '', 'impossible ISO month/day omitted (F-16)');
eq(FB.fmtDate('2020-02-30', 'date_dmy'), '', 'impossible ISO Feb 30 omitted (F-16)');
eq(FB.fmtDate('9999-99-99', 'date_dmy'), '', 'all-9s ISO omitted (F-16)');
eq(FB.fmtDate('2020-01-15 30:99', 'datetime_dmy'), '', 'impossible ISO time omitted (F-16)');
eq(FB.fmtDate('21-02', 'date_dmy'), '', 'incomplete date is omitted (never POSTed day-first)');
eq(FB.fmtDate('31-04-2099', 'date_dmy'), '', 'impossible date (Apr 31) is omitted');
eq(FB.fmtDate('21-02-1999 14', 'datetime_dmy'), '', 'datetime missing minutes is omitted');
eq(FB.fmtDate('', 'date_dmy'), '', 'empty stays empty');

console.log('FUZZ: every valid date round-trips format(digits) -> toIso -> ISO, deterministically:');
(function () {
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  let checked = 0, bug = 0;
  for (let y = 1900; y <= 2130; y += 7) {
    for (let m = 1; m <= 12; m++) {
      const dim = D.daysInMonth(m, y);
      for (let day = 1; day <= dim; day += 5) {
        const digits = p2(day) + p2(m) + String(y);
        const masked = D.format(digits, 'date');
        if (masked === '0212' || /^0\d12$/.test(masked)) bug++;
        const iso = D.toIso(masked, 'date');
        const want = String(y) + '-' + p2(m) + '-' + p2(day);
        if (iso !== want) { fails++; if (fails < 6) console.log('  ✗ fuzz ' + masked + ' -> ' + iso + ' want ' + want); }
        checked++;
      }
    }
  }
  eq(bug, 0, 'no fuzzed date ever rendered the 0212-style year bug');
  ok(checked > 1500, 'fuzzed ' + checked + ' valid dates');
})();

console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: all date-mask assertions passed.');
process.exit(fails ? 1 : 0);
