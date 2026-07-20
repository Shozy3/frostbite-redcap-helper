/*
 * Pure-HTTP driver for REDCap "Save & Return Later" — the bridge's PRIMARY path.
 *
 * A REDCap survey is a server-rendered HTML form: saving is one POST of that
 * form's fields (plus the submit button's name), and resuming is one POST of the
 * return code. Nothing in the flow actually needs a browser — the page's JS only
 * mirrors user gestures into hidden inputs (checkboxClick -> __chk__<var>_RC_<code>,
 * radio -> hidden <var>) and copies the csrfToken JS global into redcap_csrf_token
 * on submit. This driver replicates exactly that with fetch() + HTML parsing, so
 * the Worker no longer depends on Cloudflare Browser Run and its free-tier
 * 10-browser-minutes/DAY budget (which, once spent, 503'd every save until the
 * next UTC day — the failure mode that motivated this driver, 2026-07-09).
 * The puppeteer path in index.js remains as a fallback if this driver ever trips
 * on a REDCap upgrade.
 *
 * Works in both Cloudflare Workers and Node >= 18 (fetch, FormData,
 * Headers.getSetCookie). No imports.
 *
 * Exported flow functions (all take a `fetch`-compatible function, for tests):
 *   httpSave({ surveyUrl, intended, code?, fetchFn })   -> { code }
 *   httpResumeValues({ surveyUrl, code, fetchFn })      -> { values } | null (bad code)
 * plus the pure HTML helpers they're built from (unit-tested against a saved
 * copy of the real survey page, tools/survey.html).
 */

const NAV_HEADERS = {
  // A plausible browser UA; some REDCap installs vary markup for odd agents.
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en',
};
const MAX_REDIRECTS = 4;

export class HttpDriverError extends Error {
  constructor(stage, detail) {
    super('http_driver_failed:' + stage);
    this.stage = stage;
    this.detail = String(detail || '').slice(0, 300);
  }
}

// ---------------- HTML parsing (REDCap escapes < > & " ' in attribute values
// with htmlspecialchars, so a quoted attribute never contains its own quote or
// a raw angle bracket — plain regex parsing is sound here) ----------------

export function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Parse one tag's attribute string into a lowercase-keyed map.
export function parseAttrs(attrStr) {
  const out = {};
  const re = /([a-zA-Z_][-a-zA-Z0-9_:]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/g;
  let m;
  while ((m = re.exec(attrStr))) out[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]);
  return out;
}

// The main survey form is id='form'; the page also carries file-upload forms
// AFTER it. HTML forbids nested forms, so slice open-tag -> first </form>.
export function mainFormHtml(html) {
  const open = html.search(/<form\b[^>]*id=['"]form['"][^>]*>/i);
  if (open < 0) return null;
  const close = html.indexOf('</form>', open);
  return html.slice(open, close < 0 ? html.length : close);
}

export function formAction(html) {
  const open = html.match(/<form\b([^>]*id=['"]form['"][^>]*)>/i);
  if (!open) return null;
  return parseAttrs(open[1]).action || null;
}

// The CSRF token lives in a JS global; page JS copies it into the hidden
// redcap_csrf_token input on submit. We do the same.
export function csrfToken(html) {
  const m = html.match(/csrfToken\s*=\s*["']([0-9a-zA-Z]+)["']/);
  return m ? m[1] : '';
}

// All submittable controls of the main form with their CURRENT (served) state,
// exactly as a browser would post them: hidden + text-ish inputs and textareas
// by name; checked state is already materialized server-side in the
// __chk__<var>_RC_<code> hiddens; unchecked visible checkboxes (__chkn__) and
// unpicked radios (<var>___radio) don't submit and are skipped.
export function formFields(html) {
  const form = mainFormHtml(html);
  if (form == null) return null;
  const fields = {}; // name -> value (last wins, like the DOM)
  let m;
  const inputRe = /<input\b([^>]*?)\/?>/gi;
  while ((m = inputRe.exec(form))) {
    const a = parseAttrs(m[1]);
    if (!a.name) continue;
    const type = (a.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') continue;    // visible gesture controls
    if (type === 'button' || type === 'submit' || type === 'image' || type === 'file') continue;
    fields[a.name] = a.value != null ? a.value : '';
  }
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(form))) {
    const a = parseAttrs(m[1]);
    if (a.name) fields[a.name] = decodeEntities(m[2]);
  }
  return fields;
}

// The survey's field variables, from the per-question rows (<tr sq_id='var'>).
export function surveyVars(html) {
  const vars = [];
  const re = /<tr\b[^>]*\bsq_id=['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(html))) { if (m[1] && m[1] !== '{}') vars.push(m[1]); }
  return vars;
}

// Each validated input declares its format in an fv='...' attribute
// (e.g. fv='date_dmy'). Map field name -> fv for the main form.
export function fieldFormats(html) {
  const form = mainFormHtml(html);
  const out = {};
  if (form == null) return out;
  const inputRe = /<input\b([^>]*?)\/?>/gi;
  let m;
  while ((m = inputRe.exec(form))) {
    const a = parseAttrs(m[1]);
    if (a.name && a.fv) out[a.name] = a.fv;
  }
  return out;
}

// The app serializes dates as ISO ('YYYY-MM-DD' / 'YYYY-MM-DD HH:MM'), which the
// __prefill mechanism accepts — but a form POST must carry the field's DISPLAY
// format (in the browser, REDCap's own onblur validator did this conversion; the
// server silently DROPS a wrong-format date on save). Non-ISO values pass through.
export function toDisplayDate(v, fv) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?$/.exec(String(v == null ? '' : v).trim());
  if (!m) return v;
  const t = m[4] ? ' ' + m[4] : '';
  if (/_dmy/.test(fv)) return m[3] + '-' + m[2] + '-' + m[1] + t;
  if (/_mdy/.test(fv)) return m[2] + '-' + m[3] + '-' + m[1] + t;
  return v;                                             // _ymd and non-date formats: as-is
}

const CHK_RE = /^__chk__(.+)_RC_(.+)$/;
const META_FIELDS = new Set(['redcap_csrf_token', 'field_name', 'signature_input_mode']);
function isMetaName(name) { return META_FIELDS.has(name) || /^__.*__$/.test(name); }

// { var: value | [codes] } for every field carrying a value — the same contract
// as the browser path's scrapeValues(), so verify/diff and the client are
// driver-agnostic.
export function valuesFromForm(fields, vars) {
  const known = new Set(vars || []);
  const out = {};
  for (const [name, value] of Object.entries(fields || {})) {
    const chk = CHK_RE.exec(name);
    if (chk) {
      if (!value) continue;
      (out[chk[1]] = out[chk[1]] || []).push(value);
      continue;
    }
    if (isMetaName(name) || /___radio$/.test(name)) continue;
    if (known.size && !known.has(name)) continue;
    if (value !== '') out[name] = value;
  }
  return out;
}

// Overlay the app's `intended` state ({scalars, checks}) onto the served form
// state — set AND clear, only for controls that actually exist in the form
// (branching-hidden fields keep their served values, same as a real browser).
export function applyIntendedToFields(fields, intended) {
  const scalars = (intended && intended.scalars) || {};
  const checks = (intended && intended.checks) || {};
  for (const [v, val] of Object.entries(scalars)) {
    if (v in fields && !isMetaName(v)) fields[v] = String(val == null ? '' : val);
  }
  for (const name of Object.keys(fields)) {
    const chk = CHK_RE.exec(name);
    if (!chk) continue;
    const v = chk[1], code = chk[2];
    if (!(v in checks)) continue;                       // untouched group: keep served state
    const want = new Set((checks[v] || []).map(String));
    fields[name] = want.has(String(code)) ? String(code) : '';
  }
  return fields;
}

// REDCap prints the return code on the post-save confirmation in a readonly
// input labelled by #return-step1 (locked from the live probe 2026-07-08);
// text-proximity fallback for markup drift.
export function extractReturnCode(html) {
  const norm = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const a = parseAttrs(m[1]);
    if ((a['aria-labelledby'] || '').indexOf('return-step1') >= 0) {
      const c = norm(a.value);
      if (c.length >= 4) return c;
    }
  }
  const text = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const t = /return code[^A-Za-z0-9]{0,40}([A-Za-z0-9]{4,15})/i.exec(text);
  return t ? norm(t[1]) : '';
}

export function looksLikeSurveyForm(html) {
  return /name=['"]submit-btn-savereturnlater['"]/.test(html) && mainFormHtml(html) != null;
}
export function looksLikeReturnCodeForm(html) {
  return /name=['"]__code['"]/.test(html);
}

// ---------------- HTTP plumbing (cookie jar + manual redirects) ----------------

function absolutize(url, base) {
  try { return new URL(url, base).toString(); } catch (e) { return url; }
}

function jarHeader(jar) {
  return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
}

function absorbCookies(jar, res) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else { const one = res.headers.get('set-cookie'); if (one) list = [one]; }
  for (const c of list) {
    const kv = /^([^=;]+)=([^;]*)/.exec(c);
    if (kv) jar[kv[1].trim()] = kv[2];
  }
}

// fetch with cookie jar + manual redirect following (a POST 302/303 becomes a
// GET, cookies set mid-chain are kept — fetch's automatic mode drops both
// guarantees in Workers).
async function nav(fetchFn, jar, url, opts) {
  let method = (opts && opts.method) || 'GET';
  let body = opts && opts.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = Object.assign({}, NAV_HEADERS, (opts && opts.headers) || {});
    const cookie = jarHeader(jar);
    if (cookie) headers.cookie = cookie;
    const res = await fetchFn(url, { method, body, headers, redirect: 'manual' });
    absorbCookies(jar, res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      url = absolutize(loc, url);
      method = 'GET'; body = undefined;                 // PRG: re-request as GET
      continue;
    }
    return res;
  }
  throw new HttpDriverError('redirect_loop', url);
}

function toFormData(fields, extra) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, v] of Object.entries(extra || {})) fd.append(k, v);
  return fd;
}

async function loadPage(fetchFn, jar, url) {
  const res = await nav(fetchFn, jar, url);
  const html = await res.text();
  if (!res.ok) throw new HttpDriverError('load_' + res.status, html.slice(0, 200));
  return html;
}

// Load the survey ready for editing: fresh page, or an existing response resumed
// via its return code. Returns { html, action } or null when REDCap rejects the
// code (the code-entry form is served again).
async function openSurvey(fetchFn, jar, surveyUrl, code) {
  if (!code) {
    const html = await loadPage(fetchFn, jar, surveyUrl);
    if (!looksLikeSurveyForm(html)) throw new HttpDriverError('no_survey_form', html.slice(0, 200));
    return html;
  }
  const sep = surveyUrl.indexOf('?') >= 0 ? '&' : '?';
  const entry = await loadPage(fetchFn, jar, surveyUrl + sep + '__return=1');
  if (!looksLikeReturnCodeForm(entry)) throw new HttpDriverError('no_return_form', entry.slice(0, 200));
  const post = toFormData({ __code: code, redcap_csrf_token: csrfToken(entry) });
  const res = await nav(fetchFn, jar, surveyUrl + sep + '__return=1', { method: 'POST', body: post });
  const html = await res.text();
  if (looksLikeSurveyForm(html)) return html;
  if (looksLikeReturnCodeForm(html)) return null;       // wrong/unknown code
  throw new HttpDriverError('return_post_' + res.status, html.slice(0, 200));
}

// ---------------- public flows ----------------

// Save `intended` into REDCap (fresh save, or update the response behind `code`)
// and return REDCap's Save-&-Return-Later code. Mirrors a human's exact requests:
// GET the form (or resume it), then POST the form's fields with our edits overlaid
// and the Save & Return Later button's name appended (what dataEntrySubmit does).
export async function httpSave({ surveyUrl, intended, code, fetchFn }) {
  const f = fetchFn || fetch;
  const jar = {};
  const html = await openSurvey(f, jar, surveyUrl, code || '');
  if (html == null) throw new HttpDriverError('resume_rejected', code);
  const fields = formFields(html);
  if (!fields || !('__page__' in fields)) throw new HttpDriverError('form_parse', 'no __page__ in form');
  applyIntendedToFields(fields, intended);
  const formats = fieldFormats(html);
  for (const [name, fv] of Object.entries(formats)) {
    if (/^date(time)?_/.test(fv) && name in fields) fields[name] = toDisplayDate(fields[name], fv);
  }
  fields.redcap_csrf_token = csrfToken(html);
  // Save & Return Later is selected by TWO things the page JS does on click
  // (dataEntrySubmit + formSubmitDataEntry in DataEntrySurveyCommon.js): it
  // copies the button's name into the hidden `submit-action` field AND appends
  // `&__return=1` to the form action. Without the query param REDCap treats the
  // POST as a full Submit (required-field validation, completes the response).
  fields['submit-action'] = 'submit-btn-savereturnlater';
  let action = absolutize(formAction(html) || surveyUrl, surveyUrl);
  action += (action.indexOf('?') >= 0 ? '&' : '?') + '__return=1';
  const res = await nav(f, jar, action, {
    method: 'POST',
    body: toFormData(fields),
    headers: { referer: surveyUrl },
  });
  const conf = await res.text();
  const rc = extractReturnCode(conf);
  if (!rc) {
    throw new HttpDriverError('no_return_code', conf.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  }
  return { code: rc };
}

// Resume `code` and read the saved values back ({ var: value | [codes] }), or
// null when REDCap doesn't recognize the code.
export async function httpResumeValues({ surveyUrl, code, fetchFn }) {
  const f = fetchFn || fetch;
  const jar = {};
  const html = await openSurvey(f, jar, surveyUrl, code);
  if (html == null) return null;
  const fields = formFields(html);
  if (!fields) throw new HttpDriverError('form_parse', 'resume page had no main form');
  return { values: valuesFromForm(fields, surveyVars(html)) };
}
