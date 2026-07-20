/*
 * Unit tests for the passphrase-encrypted save crypto (the EXACT code that ships in
 * site/cryptosave.js, loaded via its UMD export; Node's global webcrypto satisfies
 * crypto.subtle). Proves: passphrase encrypt->decrypt round-trips; ciphertext leaks
 * no plaintext; a WRONG passphrase or tampered blob fails; the short code normalizes.
 */
const path = require('path');
require(path.join(path.dirname(__dirname), 'site', 'cryptosave.js'));
const C = globalThis.FBCRYPTO;
if (!C) { console.error('FAIL: FBCRYPTO not exported'); process.exit(1); }

let fails = 0;
function eq(actual, expected, msg) {
  if (actual === expected) console.log('  ✓ ' + msg);
  else { fails++; console.log('  ✗ ' + msg + '  — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

(async function () {
  ok(C.available, 'crypto.subtle is available');

  console.log('normalizeCode (legacy 8-char save id OR REDCap return code):');
  eq(C.normalizeCode('k7q9m2p4'), 'K7Q9M2P4', 'lowercase -> uppercase');
  eq(C.normalizeCode('  K7Q9-M2P4 '), 'K7Q9M2P4', 'trims + drops dashes/spaces');
  eq(C.normalizeCode('ABCDEFGH12345678EXTRA'), 'ABCDEFGH12345678', 'caps at 16 characters (REDCap codes up to 15)');
  eq(C.normalizeCode('A1B2C3D4E5F6G7H'), 'A1B2C3D4E5F6G7H', '15-char REDCap-style code kept intact');
  eq(C.normalizeCode(''), '', 'empty stays empty');

  console.log('passphrase encrypt -> decrypt round-trip:');
  const obj = { v: 1, chart: { values: { study_number: 'EDM-7', date_of_birth: '21-02-1999', iloprost_dose: 'Total: 12.00 mcg' }, checked: { limb_frostbite: ['1'] } }, hhr: { checked: { ule_p: ['1', '5'] } }, ilop: { label: '', doses: [{ stopTime: '10:00', rows: [{ time: '08:00', rateHr: 6 }] }] } };
  const e = await C.encryptWithPass(obj, 'test-only-passphrase');
  ok(typeof e.ct === 'string' && typeof e.iv === 'string' && typeof e.salt === 'string', 'encryptWithPass returns ct/iv/salt strings');
  const back = await C.decryptWithPass(e.ct, e.iv, e.salt, 'test-only-passphrase');
  eq(JSON.stringify(back), JSON.stringify(obj), 'decrypt with the correct passphrase reproduces the exact object');

  console.log('zero-knowledge: the ciphertext leaks no plaintext (server only stores ct/iv/salt):');
  ok(e.ct.indexOf('EDM-7') < 0 && e.ct.indexOf('study_number') < 0 && e.ct.indexOf('1999') < 0 && e.ct.indexOf('mcg') < 0,
    'ciphertext contains none of the plaintext tokens');

  console.log('authentication: a WRONG passphrase or tampered blob must FAIL:');
  let wrong = false; try { await C.decryptWithPass(e.ct, e.iv, e.salt, 'WrongPassphrase'); } catch (x) { wrong = true; }
  ok(wrong, 'decrypt with the wrong passphrase throws (cannot read it without the passphrase)');
  let tampered = false;
  const badCt = e.ct.slice(0, -2) + (e.ct.slice(-2) === 'AA' ? 'BB' : 'AA');
  try { await C.decryptWithPass(badCt, e.iv, e.salt, 'test-only-passphrase'); } catch (x) { tampered = true; }
  ok(tampered, 'decrypt of a tampered ciphertext throws (AES-GCM auth)');

  console.log('freshness: same object + passphrase -> different salt/iv/ct each save:');
  const e2 = await C.encryptWithPass(obj, 'test-only-passphrase');
  ok(e2.salt !== e.salt && e2.iv !== e.iv && e2.ct !== e.ct, 'fresh random salt + IV each time');
  eq(JSON.stringify(await C.decryptWithPass(e2.ct, e2.iv, e2.salt, 'test-only-passphrase')), JSON.stringify(obj), 'the second save also round-trips');

  // ================= v3: per-record random key (the shipping scheme) =================
  console.log('\nv3 per-record key — generate/encode/round-trip:');
  const k1 = C.generateKeyBytes(), k2 = C.generateKeyBytes();
  ok(k1 && k1.length === 32, 'generateKeyBytes returns 32 bytes (256-bit key)');
  ok(C.keyToCode(k1) !== C.keyToCode(k2), 'two generated keys differ (random)');
  eq(C.keyToCode(k1).length, 43, 'keyToCode is a 43-char base64url string (no padding)');
  eq(C.keyToCode(C.keyFromCode(C.keyToCode(k1))), C.keyToCode(k1), 'keyToCode/keyFromCode round-trip');

  const ek = await C.encryptWithKey(obj, k1);
  ok(typeof ek.ct === 'string' && typeof ek.iv === 'string', 'encryptWithKey returns ct/iv strings');
  ok(!('salt' in ek), 'v3 blob has NO salt (no PBKDF2)');
  eq(JSON.stringify(await C.decryptWithKey(ek.ct, ek.iv, k1)), JSON.stringify(obj), 'decrypt with the record key reproduces the exact object');

  console.log('v3 zero-knowledge + authentication:');
  ok(ek.ct.indexOf('EDM-7') < 0 && ek.ct.indexOf('study_number') < 0 && ek.ct.indexOf('1999') < 0 && ek.ct.indexOf('mcg') < 0,
    'v3 ciphertext contains none of the plaintext tokens');
  let wrongKey = false; try { await C.decryptWithKey(ek.ct, ek.iv, k2); } catch (x) { wrongKey = true; }
  ok(wrongKey, 'decrypt with a DIFFERENT record key throws');
  let tamperedK = false;
  const badCtK = ek.ct.slice(0, -2) + (ek.ct.slice(-2) === 'AA' ? 'BB' : 'AA');
  try { await C.decryptWithKey(badCtK, ek.iv, k1); } catch (x) { tamperedK = true; }
  ok(tamperedK, 'decrypt of a tampered v3 ciphertext throws (AES-GCM auth)');

  console.log('F-01 regression: a v3 blob is NOT decryptable via the gate passphrase:');
  // The record key is uniformly random and independent of the passphrase. Even the
  // exact production passphrase cannot recover a v3 blob — this is the structural
  // guarantee that fixes F-01 (the published passphrase hash reveals no PHI).
  let passCantRead = false;
  const anySalt = C.b64urlFromBytes(C.generateKeyBytes().slice(0, 16));
  try { await C.decryptWithPass(ek.ct, ek.iv, anySalt, 'test-only-passphrase'); } catch (x) { passCantRead = true; }
  ok(passCantRead, 'decryptWithPass over a v3 blob fails even with the correct passphrase');

  console.log('dtok (delete/overwrite capability token = SHA-256(key)):');
  const d1 = await C.dtokFromKeyBytes(k1), d1b = await C.dtokFromKeyBytes(k1), d2 = await C.dtokFromKeyBytes(k2);
  ok(/^[0-9a-f]{64}$/.test(d1), 'dtok is 64 lowercase hex chars');
  eq(d1, d1b, 'dtok is deterministic for the same key');
  ok(d1 !== d2, 'dtok differs for different keys');

  console.log('splitCode ("<id>.<key>" parsing):');
  const sc = C.splitCode('rc7xk2mp.' + C.keyToCode(k1));
  eq(sc.id, 'RC7XK2MP', 'id half normalized to uppercase alnum');
  eq(sc.key, C.keyToCode(k1), 'key half preserved verbatim (case-sensitive)');
  eq(C.splitCode('  ABC123  ').id, 'ABC123', 'a dot-less code is a bare id (trimmed/uppercased)');
  eq(C.splitCode('ABC123').key, '', 'a dot-less code has an empty key half');
  eq(C.splitCode('').id, '', 'empty stays empty');
  eq(C.splitCode('rc-1.aa.bb').id, 'RC1', 'splits on the FIRST dot only (id half)');
  eq(C.splitCode('rc-1.aa.bb').key, 'aa.bb'.replace(/[^A-Za-z0-9_-]/g, ''), 'key half keeps everything after the first dot (minus stray punctuation)');

  console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: passphrase-encrypted save crypto round-trips and authenticates.');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('ERROR', e); process.exit(2); });
