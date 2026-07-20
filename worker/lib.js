/*
 * Pure, dependency-free helpers for the REDCap bridge Worker (worker/index.js).
 *
 * Kept separate from index.js (which imports @cloudflare/puppeteer and can't load
 * in plain Node) so this logic — payload validation, value reconstruction, date/
 * number normalization, and the integrity DIFF that guarantees a save round-trips
 * correctly — is unit-tested in Node (tools/test_bridge_lib.mjs). ESM so the Worker
 * imports it directly.
 */

export const NAME_RE = /^(__prefill$|[a-z][a-z0-9_]*(___[a-z0-9_]+)?$)/;
export const VAR_RE = /^[a-z][a-z0-9_]*$/;     // a bare REDCap field name (no ___code suffix)
export const CODE_RE = /^[A-Za-z0-9_.-]+$/;    // a checkbox option code
export const MAX_PAYLOAD = 400;
export const MAX_FIELDS = 400;
export const MAX_VALUE_LEN = 8000;

// Match the client (cryptosave.js normalizeCode): REDCap's exact return-code
// format is undocumented, so codes are compared/stored case-insensitively, alnum
// only, capped generously (the survey's __code input is maxlength 15).
export function normCode(c) {
  return String(c == null ? '' : c).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

// Validate the prefill payload at the trust boundary (same rigor as /api/save F-15).
// Returns the cleaned array (with __prefill ensured present) or null if malformed.
export function cleanPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0 || payload.length > MAX_PAYLOAD) return null;
  const out = [];
  let hasPrefill = false;
  const seen = new Set();
  for (const p of payload) {
    if (!p || typeof p.name !== 'string') return null;
    if (!NAME_RE.test(p.name)) return null;
    if (seen.has(p.name)) return null;      // no duplicate names
    seen.add(p.name);
    const v = p.value == null ? '' : String(p.value);
    if (v.length > MAX_VALUE_LEN) return null;
    if (p.name === '__prefill') { hasPrefill = true; continue; }
    out.push({ name: p.name, value: v });
  }
  if (out.length === 0) return null;         // nothing but __prefill -> nothing to save
  const full = [{ name: '__prefill', value: '1' }].concat(out);
  return full;
}

// Validate the client-sent COMPLETE intended state ({scalars, checks}) at the trust
// boundary. This is the authority for both clearing and verifying, so it is checked
// as strictly as the payload. Returns a cleaned {scalars, checks} or null.
export function validateIntended(intended) {
  if (!intended || typeof intended !== 'object') return null;
  const rawS = intended.scalars, rawC = intended.checks;
  if (rawS != null && (typeof rawS !== 'object' || Array.isArray(rawS))) return null;
  if (rawC != null && (typeof rawC !== 'object' || Array.isArray(rawC))) return null;
  const scalars = {}, checks = {};
  let n = 0;
  for (const [k, v] of Object.entries(rawS || {})) {
    if (++n > MAX_FIELDS) return null;
    if (!VAR_RE.test(k)) return null;
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v);
    if (s.length > MAX_VALUE_LEN) return null;
    scalars[k] = s;
  }
  for (const [k, arr] of Object.entries(rawC || {})) {
    if (++n > MAX_FIELDS) return null;
    if (!VAR_RE.test(k) || !Array.isArray(arr)) return null;
    const codes = [];
    for (const c of arr) {
      if ((typeof c !== 'string' && typeof c !== 'number')) return null;
      const cs = String(c);
      if (!CODE_RE.test(cs) || cs.length > 64) return null;
      codes.push(cs);
    }
    checks[k] = codes.slice().sort();
  }
  if (n === 0) return null;
  return { scalars, checks };
}

// Reconstruct the intended per-field state from the flat payload, so we can diff it
// against what we later scrape back from REDCap.
//   scalars: { var: value }         (text / number / date / radio / yesno)
//   checks:  { var: [code,...] }    (checkbox — one payload entry per checked code)
export function payloadToIntended(payload) {
  const scalars = {};
  const checks = {};
  for (const p of payload) {
    if (p.name === '__prefill') continue;
    const m = /^(.+?)___(.+)$/.exec(p.name);
    if (m) {
      (checks[m[1]] || (checks[m[1]] = [])).push(m[2]);
    } else {
      scalars[p.name] = p.value;
    }
  }
  for (const k of Object.keys(checks)) checks[k].sort();
  return { scalars, checks };
}

// Normalize a date-ish string to comparable digits, tolerating REDCap's two forms:
//   ISO      YYYY-MM-DD[ HH:MM]   (what buildPayload posts)
//   display  DD-MM-YYYY[ HH:MM]   (what the survey shows when scraped back)
// Returns YYYYMMDD[HHMM], or null if it isn't one of those shapes.
export function normDate(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);   // ISO
  if (m) return m[1] + m[2] + m[3] + (m[4] ? m[4] + m[5] : '');
  m = /^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);       // DMY
  if (m) return m[3] + m[2] + m[1] + (m[4] ? m[4] + m[5] : '');
  return null;
}

// Are two scalar values equivalent for integrity purposes? Handles date-format
// skew (ISO vs DMY), numeric equivalence (5 == 5.0 == "5 "), and plain strings.
export function scalarEq(a, b) {
  const as = String(a == null ? '' : a).trim();
  const bs = String(b == null ? '' : b).trim();
  if (as === bs) return true;
  const ad = normDate(as), bd = normDate(bs);
  if (ad !== null && bd !== null) return ad === bd;
  const an = Number(as), bn = Number(bs);
  if (as !== '' && bs !== '' && Number.isFinite(an) && Number.isFinite(bn)) return an === bn;
  return false;
}

function arrEqSet(a, b) {
  const A = Array.from(new Set((a || []).map(String))).sort();
  const B = Array.from(new Set((b || []).map(String))).sort();
  return A.length === B.length && A.every((x, i) => x === B[i]);
}

// Compare the intended state to what was scraped back from the resumed survey.
// scraped: { var: string | [codes] }. Returns { ok, mismatches:[{var,expected,got,kind}] }.
// This is the integrity gate: a save is only "verified" when every intended value
// is present and equal in REDCap's own saved copy.
export function diff(intended, scraped) {
  const mismatches = [];
  scraped = scraped || {};
  for (const [v, expected] of Object.entries(intended.scalars)) {
    const got = scraped[v];
    if (Array.isArray(got) || !scalarEq(expected, got == null ? '' : got)) {
      mismatches.push({ var: v, expected, got: got == null ? '' : got, kind: 'scalar' });
    }
  }
  for (const [v, expected] of Object.entries(intended.checks)) {
    // A field absent from the scrape means no boxes are checked — treat as []. So an
    // intended-empty group ([]) correctly matches a missing/empty scrape, and a
    // group the user cleared is verified rather than silently skipped.
    const gotArr = Array.isArray(scraped[v]) ? scraped[v] : [];
    if (!arrEqSet(expected, gotArr)) {
      mismatches.push({ var: v, expected, got: gotArr, kind: 'checkbox' });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
