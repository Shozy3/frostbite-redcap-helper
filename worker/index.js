/*
 * Frostbite REDCap bridge Worker — makes the app's save code THE REDCap
 * "Save & Return Later" return code, both directions, WITHOUT a REDCap API token.
 * It drives the real public survey with a headless browser (Cloudflare Browser
 * Rendering), so it works purely through the survey UI a human would use.
 *
 *   POST /api/code  { payload:[{name,value}...], code? }
 *       -> { code, verified, mismatches? }
 *     `payload` is exactly what FB.buildPayload() produces for the visible Chart
 *     Audit fields. Fresh save (no code): prefill the survey, click Save & Return
 *     Later, scrape REDCap's return code. Re-save (code given): resume that
 *     response with the code, re-apply values, save again -> SAME code, one record.
 *     Every save is then VERIFIED by resuming the code and diffing REDCap's own
 *     saved copy against what we sent; one retry on mismatch; the honest result
 *     (verified true/false + mismatches) is returned so the app never silently
 *     trusts a corrupted save.
 *
 *   GET  /api/code?code=XXXX  ->  { values }
 *     "Works backwards": resume the response with the code and scrape the saved
 *     field values back out as { var: value | [codes] }.
 *
 * SPEED / COST — Workers FREE plan: Browser Rendering gives 10 min/day of browser
 * time, 3 concurrent browsers, no charge. Idle keep-alive still spends that budget,
 * so we keep sessions warm only briefly (KEEPALIVE_MS, default 60s): a burst of
 * requests reuses one warm browser (no cold start ~ big speedup), then it self-
 * closes fast when idle. Each request runs in its own incognito context (isolation),
 * blocks images/fonts/media (keeps JS+CSS+XHR), and is bounded by a hard timeout.
 *
 * TRUST MODEL — deliberately NOT zero-knowledge (owner-approved). Plaintext field
 * values pass through this Worker. The survey is a PUBLIC link (anyone can already
 * submit to it) and the return code is the only capability. Put the site + this route
 * behind Cloudflare Access for real access control. See docs/REDCAP_BRIDGE.md.
 */

import puppeteer from '@cloudflare/puppeteer';
import { cleanPayload, validateIntended, diff, normCode } from './lib.js';
import { httpSave, httpResumeValues } from './httpbridge.js';

const OP_TIMEOUT_MS = 115_000;  // whole-request guard: 90s of metered browser work + the 21s launch-retry wait (burns no browser time)
const NAV_TIMEOUT_MS = 30_000;
const SEL_TIMEOUT_MS = 28_000;  // resumed survey pages can be slow under load
const SAVE_WAIT_MS = 28_000;    // max wait for the post-save confirmation to render
const CODE_KEY = c => 'rc:' + c;
const BLOCK_TYPES = new Set(['image', 'media', 'font']); // never scripts/css/xhr — REDCap needs them
const DEFAULT_RL_PER_MIN = 20;  // per-IP requests/minute (best-effort, KV-backed)
const DEFAULT_RL_PER_DAY = 400; // account-wide requests/day — protects the 10-min/day browser budget

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
function clamp(n, lo, hi) { n = +n; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/code') return json({ error: 'not_found' }, 404);
    if (!env.BROWSER || !env.SURVEY_URL || !/^https:\/\//.test(env.SURVEY_URL)) {
      return json({ error: 'bridge_unconfigured' }, 501); // client falls back to legacy save code
    }
    if (!env.SAVES) return json({ error: 'storage_unavailable' }, 503);

    // Passphrase gate: the SAME access passphrase that unlocks the app also authorizes
    // the bridge. The client sends the plaintext passphrase in x-fb-pass; we allow the
    // request only if its SHA-256 matches GATE_SHA256 (the hash already published in
    // site/config.js). An attacker with that public hash still can't forge the header
    // (SHA-256 preimage resistance), so only holders of the passphrase can call the
    // bridge — no Cloudflare login required. If GATE_SHA256 is unset, the gate is off.
    if (env.GATE_SHA256) {
      const provided = request.headers.get('x-fb-pass') || '';
      if (!provided || (await sha256Hex(provided)) !== String(env.GATE_SHA256).toLowerCase()) {
        return json({ error: 'unauthorized' }, 401);
      }
    }
    // Optional ADDITIONAL hard auth via Cloudflare Access (stronger, adds a login):
    // when Access fronts this route it injects Cf-Access-Jwt-Assertion. Set
    // REQUIRE_CF_ACCESS=1 to also require it. Off by default. See REDCAP_BRIDGE.md.
    if (env.REQUIRE_CF_ACCESS === '1' && !request.headers.get('cf-access-jwt-assertion')) {
      return json({ error: 'unauthorized' }, 401);
    }
    // Best-effort rate limiting (defense-in-depth; not a substitute for Access). Bounds
    // scripted abuse of the unauthenticated shared-code endpoint and protects the metered
    // browser budget. KV is eventually-consistent, so limits are approximate.
    const rl = await rateLimit(request, env);
    if (!rl.ok) return json({ error: 'rate_limited', scope: rl.scope }, 429);

    try {
      if (request.method === 'POST') return await withTimeout(handleSave(request, env));
      if (request.method === 'GET') return await withTimeout(handleResume(request, env));
      return json({ error: 'method_not_allowed' }, 405);
    } catch (e) {
      if (e && e.message === 'op_timeout') return json({ error: 'timeout' }, 504);
      if (e && e.message === 'browser_busy') return json({ error: 'busy' }, 503);
      // Free daily Browser Run budget spent: EVERY save/resume will fail until the
      // next UTC day, so the client should fall back / message honestly, not retry.
      if (e && e.message === 'daily_limit') return json({ error: 'busy', reason: 'daily_limit' }, 503);
      return json({ error: 'bridge_error' }, 502);
    }
  }
};

// Approximate per-IP-per-minute + account-wide-per-day counters in KV. Best-effort
// (KV is eventually consistent) but enough to stop trivial single-source flooding and
// to cap daily browser-op volume against the free 10-min/day budget.
async function rateLimit(request, env) {
  try {
    const nowMin = Math.floor(Date.now() / 60000);
    const nowDay = Math.floor(Date.now() / 86400000);
    const perMin = clamp(env.RL_PER_MIN || DEFAULT_RL_PER_MIN, 1, 100000);
    const perDay = clamp(env.RL_PER_DAY || DEFAULT_RL_PER_DAY, 1, 100000);
    const ip = request.headers.get('cf-connecting-ip') || 'noip';
    const ipKey = 'rl:m:' + ip + ':' + nowMin;
    const dayKey = 'rl:d:' + nowDay;
    const [ipN, dayN] = await Promise.all([env.SAVES.get(ipKey), env.SAVES.get(dayKey)]);
    if (parseInt(ipN || '0', 10) >= perMin) return { ok: false, scope: 'ip' };
    if (parseInt(dayN || '0', 10) >= perDay) return { ok: false, scope: 'day' };
    // Increment (best-effort; a small race can let a few extra through, acceptable).
    await Promise.all([
      env.SAVES.put(ipKey, String(parseInt(ipN || '0', 10) + 1), { expirationTtl: 120 }),
      env.SAVES.put(dayKey, String(parseInt(dayN || '0', 10) + 1), { expirationTtl: 172800 })
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: true }; // never let the limiter itself break the endpoint
  }
}

function withTimeout(p) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('op_timeout')), OP_TIMEOUT_MS))]);
}

// ---------------- browser acquisition (reuse free sessions; isolate per request) ----------------
async function getBrowser(env) {
  try {
    const sessions = await puppeteer.sessions(env.BROWSER);
    const free = (sessions || []).filter(s => s && !s.connectionId).map(s => s.sessionId);
    for (const id of free) {
      try { return await puppeteer.connect(env.BROWSER, id); } catch (e) { /* raced; try next */ }
    }
  } catch (e) { /* fall through to launch */ }
  const launch = () => puppeteer.launch(env.BROWSER, { keep_alive: clamp(env.KEEPALIVE_MS || 60000, 60000, 600000) });
  let msg;
  try { return await launch(); }
  catch (e) { msg = (e && e.message) || String(e); console.error('browser launch failed:', msg); }
  if (/time limit exceeded/i.test(msg)) throw new Error('daily_limit');
  if (!/429|rate limit/i.test(msg)) throw new Error('browser_busy');
  // A 429 here is EITHER the free tier's 1-new-browser-per-20s burst throttle OR the
  // daily cap — the daily cap ALSO says just "Rate limit exceeded" (observed live
  // 2026-07-09: Retry-After on the create call = next UTC midnight). Wait out one
  // 20s window and retry once: success -> it was the burst throttle; a second 429
  // -> the account is capped until the next UTC day, tell the client honestly.
  await new Promise(r => setTimeout(r, 21000));
  try { return await launch(); }
  catch (e2) {
    const m2 = (e2 && e2.message) || String(e2);
    console.error('browser launch retry failed:', m2);
    throw new Error(/429|rate limit|time limit/i.test(m2) ? 'daily_limit' : 'browser_busy');
  }
}

// Acquire ONE browser for the whole request, run fn(browser), then CLOSE it. Doing
// every step of a request on a SINGLE browser keeps a Save to ONE browser creation
// (prefill+save AND the verify resume share it) — creations are throttled to 1/20s
// on the free tier. Closing (not disconnect-and-keep-warm) matters just as much:
// an idle keep-alive browser bills its idle seconds against the free 10-min/DAY
// budget, so warm-keeping burned ~60s per save and capped the whole day at ~6
// saves — which is exactly how the daily limit got exhausted in normal use.
async function withBrowser(env, fn) {
  const browser = await getBrowser(env);
  try { return await fn(browser); }
  finally { try { await browser.close(); } catch (e) {} } // free the metered budget NOW
}

// Run fn(page) in a fresh isolated (incognito) context on an already-acquired browser,
// so concurrent/ sequential steps don't share cookies or survey session state.
async function inContext(browser, fn) {
  let context;
  try {
    context = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(SEL_TIMEOUT_MS);
    // A native alert()/confirm() from REDCap's JS would block the renderer and hang
    // our evaluate/wait calls until timeout — auto-dismiss so automation proceeds.
    page.on('dialog', d => { d.dismiss().catch(() => {}); });
    await blockHeavyResources(page);
    return await fn(page);
  } finally {
    try { if (context) await context.close(); } catch (e) {}
  }
}

async function blockHeavyResources(page) {
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (BLOCK_TYPES.has(req.resourceType())) { req.abort().catch(() => {}); }
      else { req.continue().catch(() => {}); }
    });
  } catch (e) { /* interception unavailable -> proceed unblocked */ }
}

// ---------------- primary path: pure HTTP (no Browser Run, no daily budget) ----------------
// A REDCap survey is a server-rendered form; httpbridge.js replicates the exact
// requests a browser makes (GET form / resume code -> POST fields + Save & Return).
// ~1s per save vs ~40s of metered browser time, and immune to the free tier's
// 10-browser-minutes/DAY cap that used to 503 every save once spent (2026-07-09).
// The puppeteer path below stays as the fallback for REDCap markup/JS drift.
function httpDriverOn(env) {
  return String(env.HTTP_DRIVER == null ? 'on' : env.HTTP_DRIVER) !== 'off';
}

// Same contract and integrity rules as the browser save: fresh saves are never
// blindly retried, the code is anchored before verify, verify degrades to
// verified:false rather than discarding a minted code, one resume-and-retry on
// mismatch. Throws only when NO code was obtained.
async function saveViaHttp(env, intended, knownCode) {
  const surveyUrl = env.SURVEY_URL;
  const verifyOn = String(env.VERIFY_ROUNDTRIP == null ? 'on' : env.VERIFY_ROUNDTRIP) !== 'off';
  let workingCode = knownCode;
  let code = '', verified = false, mismatches = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      code = (await httpSave({ surveyUrl, intended, code: workingCode })).code;
    } catch (e) {
      if (code) break;                                  // keep a code from a prior attempt
      if (workingCode && attempt + 1 < 2) continue;     // re-save = idempotent update, retry once
      throw e;
    }
    const nc = normCode(code);
    if (nc.length >= 4) { try { await env.SAVES.put(CODE_KEY(nc), JSON.stringify({ v: 1 })); } catch (e) {} }
    if (!verifyOn) break;
    let scraped = null;
    try { const r = await httpResumeValues({ surveyUrl, code }); scraped = r && r.values; } catch (e) { scraped = null; }
    if (scraped == null) { verified = false; mismatches = [{ var: '*', kind: 'verify_unavailable' }]; }
    else { const d = diff(intended, scraped); verified = d.ok; mismatches = d.mismatches; }
    if (verified) break;
    workingCode = normCode(code);
  }
  return { code, verified, mismatches };
}

// ---------------- POST: save into REDCap, return + verify the code ----------------
async function handleSave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
  // One-time diagnostic (off unless PROBE=1): do a fresh save and return the raw
  // confirmation markup + heuristically-found code + a resume read-back, so the
  // deployer can LOCK RETURN_CODE_SELECTOR against the real survey. Creates one
  // test record — delete it in REDCap after. See REDCAP_BRIDGE.md ("Validate live").
  if (env.PROBE === '1' && body && body.probe === true) return await runProbe(env, cleanPayload(body.payload));

  const payload = cleanPayload(body && body.payload);
  const intended = validateIntended(body && body.intended);
  if (!payload || !intended) return json({ error: 'bad_payload' }, 400);
  const knownCode = body && body.code != null ? normCode(body.code) : '';
  if (body && body.code != null && knownCode.length < 4) return json({ error: 'bad_code' }, 400);

  const surveyUrl = env.SURVEY_URL;
  const verifyOn = String(env.VERIFY_ROUNDTRIP == null ? 'on' : env.VERIFY_ROUNDTRIP) !== 'off';

  // Primary: pure HTTP. Fall back to the browser only when the driver failed
  // BEFORE its save POST could have created a record — after the POST, a fresh
  // save must NOT be re-driven by another engine (duplicate-record risk), so it
  // errors instead. (A re-save is an idempotent update; fallback is always safe.)
  if (httpDriverOn(env)) {
    try {
      const r = await saveViaHttp(env, intended, knownCode);
      const nc0 = normCode(r.code);
      if (nc0.length >= 4) { try { await env.SAVES.put(CODE_KEY(nc0), JSON.stringify({ v: 1 })); } catch (e) {} }
      const out0 = { code: nc0, verified: r.verified };
      if (verifyOn && !r.verified) out0.mismatches = (r.mismatches || []).slice(0, 25);
      return json(out0);
    } catch (e) {
      console.error('http driver save failed:', (e && e.message) || String(e), (e && e.detail) || '');
      const postMayHaveSaved = e && e.message === 'http_driver_failed:no_return_code';
      if (postMayHaveSaved && !knownCode) return json({ error: 'save_failed', reason: 'http_no_return_code' }, 502);
      // else: fall through to the browser path
    }
  }

  // One browser for the WHOLE save (all attempts + the verify), so a save is a single
  // browser launch, not several. getBrowser throwing browser_busy propagates to the
  // top-level 503 handler.
  const result = await withBrowser(env, async (browser) => {
    let workingCode = knownCode; // '' = fresh save; retry/re-save resumes an obtained code
    let code = '';
    let verified = false;
    let mismatches = [];

    // Up to 2 attempts, but a FRESH save (no code yet) is NEVER blindly re-run — if its
    // save step fails before yielding a code we error rather than risk a duplicate
    // record. Once we HAVE a code, a retry only resumes+updates THAT record (idempotent).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        code = await inContext(browser, async (page) => {
          if (workingCode) {
            if (!(await enterReturnCode(page, surveyUrl, workingCode, env))) throw new Error('resume_failed');
            await applyValues(page, intended);
          } else {
            await prefillSurvey(page, surveyUrl, payload);
          }
          const c = await clickSaveAndReturn(page, env);
          if (!c) throw new Error('no_return_code');
          return c;
        });
      } catch (e) {
        if (code) break;                          // keep a code obtained on a prior attempt
        const reason = (e && e.message) || 'bridge_error';
        if (reason === 'op_timeout' || reason === 'browser_busy') throw e;  // -> top-level 504/503
        // A RE-SAVE is an idempotent update — safe to retry once on a transient hiccup.
        // A FRESH save is NOT retried (could create a second record).
        if (workingCode && attempt + 1 < 2) continue;
        return { _err: 'save_failed', reason };
      }

      // Anchor the code IMMEDIATELY (before verify) so a verify failure can't strand a
      // real REDCap record with no way to reach it.
      const nc = normCode(code);
      if (nc.length >= 4) { try { await env.SAVES.put(CODE_KEY(nc), JSON.stringify({ v: 1 })); } catch (e) {} }

      if (!verifyOn) break;

      // Verify on the SAME browser (fresh context): resume the code and diff the saved
      // copy. A thrown verify must NOT discard the code — degrade to verified:false.
      let scraped = null;
      try {
        scraped = await inContext(browser, async (page) =>
          (await enterReturnCode(page, surveyUrl, code, env)) ? await scrapeValues(page) : null);
      } catch (e) {
        if (e && e.message === 'op_timeout') throw e;
        scraped = null;
      }
      if (scraped == null) { verified = false; mismatches = [{ var: '*', kind: 'verify_unavailable' }]; }
      else { const d = diff(intended, scraped); verified = d.ok; mismatches = d.mismatches; }
      if (verified) break;
      workingCode = normCode(code);   // retry resumes+updates THIS record — no duplicate
    }
    return { code, verified, mismatches };
  });

  if (result && result._err) return json({ error: result._err, reason: result.reason }, 502);
  const norm = normCode(result.code);
  if (norm.length >= 4) { try { await env.SAVES.put(CODE_KEY(norm), JSON.stringify({ v: 1 })); } catch (e) {} }
  const out = { code: norm, verified: result.verified };
  if (verifyOn && !result.verified) out.mismatches = (result.mismatches || []).slice(0, 25);
  return json(out);
}

// ---------------- GET: work backwards from a code to the saved values ----------------
async function handleResume(request, env) {
  const code = normCode(new URL(request.url).searchParams.get('code'));
  if (code.length < 4) return json({ error: 'bad_code' }, 400);
  const surveyUrl = env.SURVEY_URL;

  // Primary: pure HTTP (read-only, so falling back is always safe).
  if (httpDriverOn(env)) {
    try {
      const r = await httpResumeValues({ surveyUrl, code });
      if (r == null) return json({ error: 'not_found' }, 404);
      return json({ values: r.values });
    } catch (e) {
      console.error('http driver resume failed:', (e && e.message) || String(e), (e && e.detail) || '');
      // fall through to the browser path
    }
  }

  const values = await withBrowser(env, (browser) => inContext(browser, async (page) => {
    if (!(await enterReturnCode(page, surveyUrl, code, env))) return null;
    return await scrapeValues(page);
  }));
  if (values == null) return json({ error: 'not_found' }, 404);

  // Do NOT anchor rc:<code> on this read-only resume: anchoring is what lets
  // /api/save accept a blob under a code, and a mere lookup must not grant that (it
  // would let anyone who resumes a leaked code then overwrite its blob). The anchor
  // is written only when a save actually mints/updates the code (handleSave).
  return json({ values });
}

// ---------------- browser steps ----------------

// Submit a form from inside the page and wait for the resulting navigation. The
// submit triggers navigation as a side effect, which can tear down the execution
// context and reject the evaluate call with "Execution context was destroyed" — that
// specific rejection is expected here, so we swallow it and rely on the navigation
// (and the caller's subsequent waitForSelector) to confirm the page actually changed.
async function submitAndNavigate(page, submitFn) {
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  try { await page.evaluate(submitFn); } catch (e) { /* context destroyed by navigation — expected */ }
  await nav;
}

// Prefill a fresh survey via REDCap's proven __prefill POST (same mechanism the app
// uses for "Open populated REDCap form"), then wait for the survey to render.
async function prefillSurvey(page, surveyUrl, payload) {
  await page.goto('about:blank');
  await submitAndNavigate(page, `(function(){
    var action=${JSON.stringify(surveyUrl)}, fields=${JSON.stringify(payload)};
    var f=document.createElement('form'); f.method='POST'; f.action=action; f.acceptCharset='UTF-8';
    fields.forEach(function(p){ var i=document.createElement('input'); i.type='hidden'; i.name=p.name; i.value=p.value; f.appendChild(i); });
    document.body.appendChild(f); f.submit();
  })()`);
  await page.waitForSelector('button[name="submit-btn-savereturnlater"]', { timeout: SEL_TIMEOUT_MS });
}

// Enter a return code on the ?&__return=1 page. Returns false if REDCap rejects the
// code (the code-entry form stays up) instead of loading the response. Selectors are
// overridable (RETURN_* env) for REDCap version/customization drift.
async function enterReturnCode(page, surveyUrl, code, env) {
  const codeInput = (env && env.RETURN_CODE_INPUT_SELECTOR) || 'input[name="__code"]';
  const formSel = (env && env.RETURN_FORM_SELECTOR) || '#return_code_form';
  const sep = surveyUrl.indexOf('?') >= 0 ? '&' : '?';
  await page.goto(surveyUrl + sep + '__return=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(codeInput, { timeout: SEL_TIMEOUT_MS });
  await page.$eval(codeInput, (el, v) => { el.value = v; }, code);
  await submitAndNavigate(page, `(function(){
    var f=document.querySelector(${JSON.stringify(formSel)});
    if(f){ f.submit(); } else { var i=document.querySelector(${JSON.stringify(codeInput)}); if(i&&i.form) i.form.submit(); }
  })()`);
  try {
    await page.waitForSelector('button[name="submit-btn-savereturnlater"]', { timeout: SEL_TIMEOUT_MS });
    return true;
  } catch (e) { return false; }
}

// Bring an already-loaded (resumed) survey to EXACTLY the intended state — set new
// values AND clear ones the user blanked/unchecked. `intended` is the complete
// visible-field spec { scalars:{var:value}, checks:{var:[codes]} }. Without the clear
// half, a re-save that removes an answer would silently keep REDCap's old value (and
// the verify diff would miss it) — the bug this rewrite fixes.
async function applyValues(page, intended) {
  await page.evaluate((intended) => {
    const scalars = intended.scalars || {}, checks = intended.checks || {};
    const fire = (el) => ['input', 'keyup', 'change', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));

    Object.keys(scalars).forEach(v => {
      const val = String(scalars[v] == null ? '' : scalars[v]);
      const radios = document.querySelectorAll('input[type="radio"][name="' + v + '___radio"]');
      if (radios.length) {
        // REDCap submits the hidden field named `v` (radios are `v___radio`). Select
        // the matching radio for branching; set hidden ONLY to a value that matched a
        // real option (else clear it) so drift can't inject an unsubmittable value.
        let matched = false;
        radios.forEach(r => {
          if (val !== '' && r.value === val) { matched = true; if (!r.checked) r.click(); }
          else if (r.checked) { r.checked = false; }   // deselect a stale choice
        });
        const hidden = document.querySelector('input[name="' + v + '"]');
        if (hidden) hidden.value = matched ? val : '';
        return;
      }
      const el = document.querySelector('input[name="' + v + '"], textarea[name="' + v + '"]');
      if (el && el.value !== val) { el.value = val; fire(el); }   // covers set AND clear-to-''
    });

    Object.keys(checks).forEach(v => {
      const want = new Set((checks[v] || []).map(String));
      document.querySelectorAll('input[type="checkbox"][name="__chkn__' + v + '"]').forEach(cb => {
        const should = want.has(String(cb.getAttribute('code')));
        if (should !== cb.checked) cb.click();   // toggle to desired state (runs REDCap's checkboxClick)
      });
    });
  }, intended);
}

// Click Save & Return Later and extract the return code REDCap displays.
//
// FRAGILE — the post-save confirmation markup is the one thing not verifiable
// without submitting to the live survey (which creates a real record). Layered
// extraction + an env override (RETURN_CODE_SELECTOR); lock it with
// tools/probe_redcap_live.js against the real survey. See REDCAP_BRIDGE.md.
async function clickSaveAndReturn(page, env) {
  await page.$eval('button[name="submit-btn-savereturnlater"]', el => el.click());
  const override = env.RETURN_CODE_SELECTOR || '';
  try {
    await page.waitForFunction((sel) => {
      if (sel && document.querySelector(sel)) return true;
      const t = document.body ? document.body.innerText : '';
      return /return code/i.test(t) || /has been saved/i.test(t);
    }, { timeout: SAVE_WAIT_MS }, override);
  } catch (e) { return ''; }

  return await page.evaluate((sel) => {
    const norm = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    if (sel) { const n = document.querySelector(sel); if (n) { const c = norm(n.textContent || n.value); if (c.length >= 4) return c; } }
    for (const s of ['#survey_return_code', '.survey_return_code', '#return_code', 'span.return-code']) {
      const n = document.querySelector(s); if (n) { const c = norm(n.textContent); if (c.length >= 4) return c; }
    }
    const body = document.body ? document.body.innerText : '';
    const m = /return code[^A-Za-z0-9]{0,40}([A-Za-z0-9]{4,15})/i.exec(body);
    return m ? norm(m[1]) : '';
  }, override);
}

// One-time live diagnostic to lock the return-code selector. Prefills a dummy record,
// clicks Save & Return Later, and returns the confirmation markup around any code-shaped
// token plus a resume read-back. Gated by env.PROBE==='1'.
async function runProbe(env, payload) {
  const surveyUrl = env.SURVEY_URL;
  // study_number is number-validated, so use a recognizable numeric marker that will
  // actually save. Delete the record with study_number 999999999 in REDCap afterwards.
  const probePayload = payload || [{ name: '__prefill', value: '1' }, { name: 'study_number', value: '999999999' }];
  return await withBrowser(env, async (browser) => {
    const out = await inContext(browser, async (page) => {
      await prefillSurvey(page, surveyUrl, probePayload);
      await page.$eval('button[name="submit-btn-savereturnlater"]', el => el.click());
      try {
        await page.waitForFunction(() => {
          const t = document.body ? document.body.innerText : '';
          return /return code/i.test(t) || /has been saved/i.test(t);
        }, { timeout: SAVE_WAIT_MS });
      } catch (e) {}
      return await page.evaluate(() => {
        const norm = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
        const bodyText = document.body ? document.body.innerText : '';
        const m = /return code[^A-Za-z0-9]{0,40}([A-Za-z0-9]{4,15})/i.exec(bodyText);
        const found = m ? norm(m[1]) : '';
        const html = document.body ? document.body.innerHTML : '';
        const i = html.toLowerCase().indexOf('return code');
        const snippet = i >= 0 ? html.slice(Math.max(0, i - 400), i + 800) : html.slice(0, 1200);
        return { found, snippet, bodyTextSample: bodyText.slice(0, 600) };
      });
    });
    let scraped = null;
    if (out && out.found) {
      scraped = await inContext(browser, async (page) => {
        if (!(await enterReturnCode(page, surveyUrl, out.found, env))) return null;
        return await scrapeValues(page);
      });
    }
    return json({ probe: true, foundCode: out && out.found, confirmationHtmlSnippet: out && out.snippet, bodyTextSample: out && out.bodyTextSample, resumeScrape: scraped, note: 'Delete the 999999999 test record in REDCap. Set RETURN_CODE_SELECTOR from the snippet, then unset PROBE.' });
  });
}

// Read the saved values out of a resumed survey form.
// Returns { var: string | [codes] } for every field carrying a value.
async function scrapeValues(page) {
  return await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('tr[sq_id]').forEach(tr => {
      const v = tr.getAttribute('sq_id');
      if (!v || v === '{}') return;
      const boxes = document.querySelectorAll('input[type="checkbox"][name="__chkn__' + v + '"]');
      if (boxes.length) {
        const codes = [];
        boxes.forEach(b => { if (b.checked) codes.push(b.getAttribute('code')); });
        if (codes.length) out[v] = codes;
        return;
      }
      const radios = document.querySelectorAll('input[type="radio"][name="' + v + '___radio"]');
      if (radios.length) {
        const hidden = document.querySelector('input[name="' + v + '"]');
        if (hidden && hidden.value) out[v] = hidden.value;
        return;
      }
      const el = document.querySelector('input[name="' + v + '"], textarea[name="' + v + '"]');
      if (el && el.value) out[v] = el.value;
    });
    return out;
  });
}
