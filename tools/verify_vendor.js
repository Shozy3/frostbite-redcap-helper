// Verify vendored third-party asset(s) match their recorded SHA-256 (supply-chain integrity).
// Run in CI / before deploy so a swapped site/xlsx.mini.min.js (which loads same-origin under
// CSP script-src 'self', in the origin that holds the access passphrase + PHI) is caught.
//   node tools/verify_vendor.js
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const ROOT = path.dirname(__dirname);
const listFile = path.join(ROOT, 'tools', 'vendor_checksums.txt');
let fails = 0, checked = 0;
for (const line of fs.readFileSync(listFile, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const sp = s.split(/\s+/), want = sp[0], rel = sp.slice(1).join(' ');
  if (!want || !rel) continue;
  let got = null;
  try { got = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); } catch (e) {}
  checked++;
  if (got === want) console.log('  ✓ ' + rel + '  ' + want.slice(0, 12) + '…');
  else { fails++; console.log('  ✗ ' + rel + '  expected ' + want.slice(0, 12) + '… got ' + (got ? got.slice(0, 12) + '…' : '(missing/unreadable)')); }
}
console.log(fails ? ('\nFAIL: ' + fails + '/' + checked + ' vendored file(s) failed checksum.')
                  : ('\nPASS: ' + checked + ' vendored file(s) match recorded checksums.'));
process.exit(fails ? 1 : 0);
