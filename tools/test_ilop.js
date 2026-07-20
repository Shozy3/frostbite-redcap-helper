// Iloprost dose calculator — unit tests for the pure calc (the EXACT code that
// ships in site/ilop.js, loaded via its UMD export). Full-precision math.
const path = require('path');
require(path.join(path.dirname(__dirname), 'site', 'ilop.js'));
const C = globalThis.ILOP_CALC;
if (!C) { console.error('FAIL: ILOP_CALC was not exported by site/ilop.js'); process.exit(1); }

let fails = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg + '  — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function arrEq(actual, expected, msg) { eq(JSON.stringify(actual), JSON.stringify(expected), msg); }

const DOSE1 = { rows: [{ time: '14:58', rateHr: 2 }, { time: '15:31', rateHr: 4 }, { time: '16:15', rateHr: 6 }, { time: '16:48', rateHr: 8 }], stopTime: '20:57' };
const DOSE2 = { rows: [{ time: '09:28', rateHr: 2 }, { time: '10:05', rateHr: 4 }, { time: '10:40', rateHr: 6 }, { time: '11:17', rateHr: 8 }, { time: '11:59', rateHr: 10 }], stopTime: '15:27' };

console.log('parseHHMM / minutesBetween:');
eq(C.parseHHMM('09:28'), 568, "parseHHMM('09:28')");
eq(C.parseHHMM('9:28'), 568, "parseHHMM('9:28') (1-digit hour)");
eq(C.parseHHMM('00:00'), 0, "parseHHMM('00:00')");
eq(C.parseHHMM('23:59'), 1439, "parseHHMM('23:59')");
eq(C.parseHHMM('24:00'), null, "parseHHMM('24:00') is invalid");
eq(C.parseHHMM('12:60'), null, "parseHHMM('12:60') is invalid");
eq(C.parseHHMM(''), null, "parseHHMM('') is invalid");
eq(C.minutesBetween('14:58', '20:57'), 359, '14:58 -> 20:57 = 359 min');
eq(C.minutesBetween('23:30', '00:15'), 45, '23:30 -> 00:15 = 45 min (crosses midnight)');
eq(C.minutesBetween('10:00', '10:00'), 0, 'same time = 0 min');
eq(C.minutesBetween('10:00', ''), null, 'missing end time = null');

console.log('mcgPerMin (full precision, no early rounding):');
eq(C.mcgPerMin('8'), 8 / 60, '8 mcg/hr -> 0.1333... mcg/min');
eq(C.mcgPerMin('abc'), null, 'non-numeric -> null');
eq(C.mcgPerMin(''), null, 'empty -> null');

console.log('Dose 1 (spreadsheet sample):');
const d1 = C.computeDose(DOSE1);
arrEq(d1.rows.map(function (r) { return r.durationMin; }), [33, 44, 33, 249], 'durations 33/44/33/249');
eq(d1.total.toFixed(2), '40.53', 'dose 1 total = 40.53 mcg');

console.log('Dose 2 (spreadsheet sample):');
const d2 = C.computeDose(DOSE2);
arrEq(d2.rows.map(function (r) { return r.durationMin; }), [37, 35, 37, 42, 208], 'durations 37/35/37/42/208');
eq(d2.total.toFixed(2), '47.53', 'dose 2 total = 47.53 mcg');

console.log('computeAll + grand total:');
const all = C.computeAll([DOSE1, DOSE2]);
eq(all.grandTotal.toFixed(2), '88.07', 'grand total of 2 doses = 88.07 mcg');
eq(C.computeAll([]).grandTotal, 0, 'no doses -> grand total 0');

console.log('edge cases (must not throw):');
const e1 = C.computeDose({ rows: [{ time: '', rateHr: '' }], stopTime: '' });
eq(e1.total, 0, 'empty dose total is 0');
eq(e1.rows[0].mcg, null, 'empty row mcg is null (shows as dash)');
const e2 = C.computeDose({ rows: [{ time: '08:00', rateHr: 6 }], stopTime: '09:00' });
eq(e2.rows[0].durationMin, 60, 'single row runs to stop time = 60 min');
eq(e2.total.toFixed(2), (6 / 60 * 60).toFixed(2), 'single row total = 6.00 mcg');
const e3 = C.computeDose({ rows: [{ time: '23:40', rateHr: 4 }], stopTime: '00:20' });
eq(e3.rows[0].durationMin, 40, 'past-midnight single row = 40 min');
eq(e3.rows[0].crossedMidnight, true, 'crossedMidnight flag set');

console.log('blank rows (from auto-append) must not break the chain:');
const eBlankTail = C.computeDose({ rows: [{ time: '14:58', rateHr: 2 }, { time: '15:31', rateHr: 4 }, { time: '16:15', rateHr: 6 }, { time: '16:48', rateHr: 8 }, { time: '', rateHr: '' }, { time: '', rateHr: '' }], stopTime: '20:57' });
eq(eBlankTail.rows[3].durationMin, 249, 'last real rate runs to the stop across trailing blank rows (249 min)');
eq(eBlankTail.total.toFixed(2), '40.53', 'dose total unaffected by trailing blank rows');
const eGap = C.computeDose({ rows: [{ time: '08:00', rateHr: 2 }, { time: '', rateHr: '' }, { time: '09:00', rateHr: 6 }], stopTime: '10:00' });
eq(eGap.rows[0].durationMin, 60, 'a blank middle row is skipped as a boundary (08:00 -> 09:00 = 60 min)');

console.log('displayed per-row math is self-consistent (shown mcg/min × min = shown mcg):');
[d1, d2].forEach(function (d, di) {
  d.rows.forEach(function (r, ri) {
    var shownConc = parseFloat(C.fmtConc(r.mcgPerMin));
    eq((shownConc * r.durationMin).toFixed(2), C.fmt2(r.mcg), 'dose ' + (di + 1) + ' row ' + (ri + 1) + ': displayed conc × min = displayed mcg');
  });
});

console.log('buildStepsText (clipboard / log record):');
const txt = C.buildStepsText('Test', '2026-06-23 14:30', [DOSE1, DOSE2]);
eq(/Dose 1 — total 40\.53 mcg/.test(txt), true, 'includes Dose 1 total line');
eq(/GRAND TOTAL: 88\.07 mcg {2}\(2 doses\)/.test(txt), true, 'includes grand total line');
eq(txt.indexOf('16:48 → 20:57') >= 0, true, 'includes an interval (16:48 -> 20:57)');
eq(/full precision and rounded to 2 decimals/.test(txt), true, 'includes the rounding-transparency note');

console.log('single-dose cap (a single dose total never exceeds 50 mcg):');
eq(C.DOSE_CAP, 50, 'DOSE_CAP is 50');
// Rates are clamped to 10 mcg/hr, so to exceed the 50 mcg dose cap we run 10 mcg/hr long enough.
const capHi = C.computeDose({ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '14:00' }); // 10 mcg/hr × 6h = 60 raw
eq(capHi.rawTotal.toFixed(2), '60.00', 'rawTotal keeps the true uncapped sum (60.00)');
eq(capHi.total, 50, 'total is capped to exactly 50');
eq(capHi.capped, true, 'capped flag set when raw > 50');
const capEq = C.computeDose({ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '13:00' }); // 10 mcg/hr × 5h = 50 raw
eq(capEq.total, 50, 'raw exactly 50 stays 50');
eq(capEq.capped, false, 'exactly 50 is NOT flagged as capped');
const capLo = C.computeDose({ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '11:00' }); // 10 mcg/hr × 3h = 30 raw
eq(capLo.total.toFixed(2), '30.00', 'below the cap is unchanged');
eq(capLo.capped, false, 'below the cap is not flagged');
const capAll = C.computeAll([
  { rows: [{ time: '08:00', rateHr: 10 }], stopTime: '14:00' },   // 60 -> 50
  { rows: [{ time: '08:00', rateHr: 10 }], stopTime: '14:00' }    // 60 -> 50
]);
eq(capAll.grandTotal, 100, 'grand total sums the CAPPED per-dose totals (50 + 50 = 100)');
eq(C.buildStepsText('Capped', null, [{ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '14:00' }]).indexOf('total 50.00 mcg') >= 0, true, 'steps text shows the capped dose total');
eq(/capped at 50 mcg; computed 60\.00 mcg/.test(C.buildStepsText('Capped', null, [{ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '14:00' }])), true, 'steps text annotates the cap so the rows under a 50 total are explained');
eq(C.computeDose(DOSE1).capped, false, 'sample dose 1 (40.53) is not capped');
eq(C.computeDose(DOSE2).capped, false, 'sample dose 2 (47.53) is not capped');

console.log('rate cap (a single rate never exceeds 10 mcg/hr in the math):');
eq(C.RATE_CAP, 10, 'RATE_CAP is 10');
const rc = C.computeDose({ rows: [{ time: '08:00', rateHr: 15 }], stopTime: '09:00' });
eq(rc.rows[0].rateCapped, true, 'a rate > 10 is flagged rateCapped');
eq(rc.total.toFixed(2), '10.00', '15 mcg/hr computes as 10 mcg/hr (60 min × 10/60 = 10.00), never 15');
const rcOk = C.computeDose({ rows: [{ time: '08:00', rateHr: 10 }], stopTime: '09:00' });
eq(rcOk.rows[0].rateCapped, false, 'a rate of exactly 10 is NOT flagged');
eq(rcOk.total.toFixed(2), '10.00', 'rate 10 for 60 min = 10.00 mcg');
eq(C.computeDose({ rows: [{ time: '08:00', rateHr: 200 }], stopTime: '09:00' }).total.toFixed(2), '10.00', 'a huge rate (200) is still clamped to 10 → 10.00 mcg');

console.log('24-hour time mask (maskTime) + validation (parseHHMM):');
eq(C.maskTime('2200'), '22:00', '2200 -> 22:00 (not 02:20)');
eq(C.maskTime('1700'), '17:00', '1700 -> 17:00');
eq(C.maskTime('1200'), '12:00', '1200 -> 12:00');
eq(C.maskTime('2'), '2', 'partial "2" stays "2"');
eq(C.maskTime('22'), '22', 'partial "22" stays "22" (no colon yet)');
eq(C.maskTime('220'), '22:0', 'partial "220" -> "22:0"');
eq(C.maskTime('08:00'), '08:00', 'an existing "08:00" is idempotent');
eq(C.maskTime('14:58:00'), '14:58', 'digits beyond HHMM are dropped');
eq(C.parseHHMM(C.maskTime('2200')), 1320, 'masked 2200 parses to 22:00 (1320 min)');
eq(C.parseHHMM('24:60'), null, '24:60 is invalid');
eq(C.parseHHMM('24:00'), null, '24:00 is invalid');
eq(C.parseHHMM('23:60'), null, '23:60 is invalid');
eq(C.parseHHMM('23:59'), 1439, '23:59 is the last valid minute');

console.log('rate floor (a negative rate never subtracts from the dose):');
eq(C.computeDose({ rows: [{ time: '08:00', rateHr: -5 }], stopTime: '09:00' }).total, 0, 'a negative rate contributes 0 (not a negative dose)');
eq(C.computeAll([{ rows: [{ time: '08:00', rateHr: 6 }], stopTime: '09:00' }, { rows: [{ time: '08:00', rateHr: -6 }], stopTime: '09:00' }]).grandTotal.toFixed(2), '6.00', 'a negative dose cannot cancel a real one (6 + 0 = 6.00)');
eq(/rate capped at 10/.test(C.buildStepsText('rc', null, [{ rows: [{ time: '08:00', rateHr: 20 }], stopTime: '09:00' }])), true, 'steps text annotates a rate cap (so the printed raw rate vs capped mcg is explained)');

console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: all iloprost calc assertions passed.');
process.exit(fails ? 1 : 0);
