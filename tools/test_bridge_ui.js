/*
 * UI test for the REDCap-bridge wiring in site/app.js (the browser-automation path
 * itself needs a real headless browser and is validated by tools/probe_redcap_live.js;
 * here we mock /api/code to prove app.js drives it correctly):
 *   - Save posts the CHART payload to /api/code, adopts REDCap's returned code, and
 *     shows the "works in REDCap too" + verified wording.
 *   - The full three-form blob is then stored under that same code (anchored /api/save).
 *   - Resume with a code that has NO blob falls back to the bridge GET and repopulates
 *     the chart from scraped values.
 *   - A save whose round-trip did NOT verify surfaces the warning.
 * Run: node tools/test_bridge_ui.js
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');

let fails = 0;
function ok(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { fails++; console.log('  ✗ ' + msg); } }
const settle = () => new Promise(r => setTimeout(r, 40));
const click = (w, node) => node && node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const btnByText = (root, t) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === t);

// Mocked bridge + blob store. /api/code returns a fixed REDCap-style code and echoes
// back the payload as "scraped" values on GET; /api/save is the anchored blob KV.
function installFetch(w, opts) {
  opts = opts || {};
  const srv = { KV: new Map(), lastIntended: null, lastPayload: null, code: opts.code || 'RC7XK2MP',
    verified: opts.verified !== false, codeFail: false, calls: [], codePosts: [] };
  bindFetch(w, srv);
  return srv;
}
// Shared mock: /api/code (bridge) reconstructs scraped values from the last posted
// `intended`; /api/save is the anchored blob KV. srv.codeFail forces a network reject
// on /api/code (to exercise the no-orphan fallback path).
function bindFetch(w, srv) {
  w.__srv = srv;
  srv.calls = srv.calls || []; srv.codePosts = srv.codePosts || [];
  w.fetch = function (url, o) {
    o = o || {};
    const method = (o.method || 'GET').toUpperCase();
    const u = String(url), q = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '';
    const m = q.match(/(?:^|&)(?:id|code)=([^&]+)/), key = m ? decodeURIComponent(m[1]) : null;
    const resp = (status, obj) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(obj) });
    srv.calls.push(method + ' ' + u);
    if (u.indexOf('/api/code') >= 0) {
      if (srv.codeFail) return Promise.reject(new Error('network'));
      // Simulates the Worker after the account's free daily Browser Run budget is
      // spent: every bridge call 503s with the distinct daily_limit reason.
      if (srv.dailyLimit) return resp(503, { error: 'busy', reason: 'daily_limit' });
      if (method === 'POST') {
        const body = JSON.parse(o.body);
        srv.codePosts.push(body);
        srv.lastIntended = body.intended || null;
        srv.lastPayload = body.payload || null;
        return resp(200, { code: srv.code, verified: srv.verified, mismatches: srv.verified ? [] : [{ var: 'sex', expected: '2', got: '', kind: 'scalar' }] });
      }
      if (method === 'GET') {
        const src = srv.lastIntended;
        if (key !== srv.code || !src) return resp(404, { error: 'not_found' });
        // Reconstruct { var: value|[codes] } from the last posted intended.
        const values = {};
        Object.keys(src.scalars || {}).forEach(v => { if (src.scalars[v] !== '') values[v] = src.scalars[v]; });
        Object.keys(src.checks || {}).forEach(v => { if ((src.checks[v] || []).length) values[v] = src.checks[v].slice(); });
        return resp(200, { values });
      }
    }
    // /api/save blob store (anchored ids accepted because the bridge "minted" them)
    if (method === 'POST') {
      const body = JSON.parse(o.body);
      if (typeof body.ct !== 'string') return resp(400, { error: 'bad' });
      const id = body.id || ('RND' + (srv.KV.size + 1));
      srv.KV.set(id, { ct: body.ct, iv: body.iv, dtok: body.dtok });  // v3 blob: { ct, iv, dtok }
      return resp(200, { id });
    }
    if (method === 'GET') return (key && srv.KV.has(key)) ? resp(200, srv.KV.get(key)) : resp(404, { error: 'not_found' });
    if (method === 'DELETE') { if (key) srv.KV.delete(key); return resp(204, null); }
    return resp(405, {});
  };
}

function makePage(shareSrv) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = function () {}; w.confirm = () => true;
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  if (!w.TextEncoder) { w.TextEncoder = global.TextEncoder; w.TextDecoder = global.TextDecoder; }
  if (!w.btoa) { w.btoa = s => Buffer.from(s, 'binary').toString('base64'); w.atob = b => Buffer.from(b, 'base64').toString('binary'); }
  w.eval(read('config.js')); w.CONFIG.requirePassphrase = false;
  w.eval(read('datemask.js')); w.eval(read('dictionary.js')); w.eval(read('dict_hhr.js')); w.eval(read('branch.js'));
  w.eval(read('payload.js')); w.eval(read('hhr_calc.js')); w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js')); w.eval(read('ilop.js')); w.eval(read('cryptosave.js')); w.eval(read('app.js'));
  if (shareSrv) w.__srv = shareSrv;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, doc: w.document };
}

function setField(doc, w, name, value) {
  const inp = doc.querySelector('#panels [name="' + name + '"]');
  if (!inp) return;
  inp.value = value; inp.dispatchEvent(new w.Event('input', { bubbles: true })); inp.dispatchEvent(new w.Event('change', { bubbles: true }));
}
function pickRadio(doc, w, name, val) {
  const r = doc.querySelector('#panels input[type=radio][name="' + name + '___radio"][value="' + val + '"]')
        || [...doc.querySelectorAll('#panels input[type=radio]')].find(x => x.value === val && x.closest('[data-var]'));
  if (r) { r.checked = true; r.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); r.dispatchEvent(new w.Event('change', { bubbles: true })); }
}

(async function () {
  // ---- A) verified save via the bridge ----
  console.log('save via bridge (verified):');
  const p = makePage(); installFetch(p.w, { verified: true });
  setField(p.doc, p.w, 'study_number', 'EDM-7');
  click(p.w, p.doc.getElementById('btn-save'));
  await settle(); await settle();
  const modal = p.doc.querySelector('.fb-modal');
  const codeShown = (p.doc.querySelector('.fb-code-val') || {}).textContent || '';
  ok(/^RC7XK2MP\.[A-Za-z0-9_-]{43}$/.test(codeShown), 'save shows <REDCap code>.<record key> (got "' + codeShown + '")');
  const bodyTxt = modal ? modal.textContent : '';
  ok(/REDCap form/.test(bodyTxt), 'wording says the code works on the REDCap form');
  ok(/Verified/i.test(bodyTxt), 'shows the verified confirmation');
  const posted = p.w.__srv.calls.filter(c => c.startsWith('POST /api/code')).length;
  ok(posted === 1, 'posted the chart payload to the bridge exactly once');
  ok(p.w.__srv.KV.has('RC7XK2MP'), 'the encrypted three-form blob is stored under the REDCap code');
  const firstPost = p.w.__srv.codePosts[0] || {};
  ok((firstPost.payload || []).some(x => x.name === 'study_number' && x.value === 'EDM-7'), 'the chart field value reached the bridge payload');
  ok(firstPost.intended && firstPost.intended.scalars && firstPost.intended.scalars.study_number === 'EDM-7', 'a full `intended` spec (with scalars) is sent alongside payload');
  ok(!('code' in firstPost), 'a first (fresh) save sends no code');

  // ---- B) resume a code that has a blob (fast path) ----
  console.log('resume with blob present (fast path, all three forms):');
  const p2 = makePage();                    // fresh page, shares part A's server (blob present)
  installFetchShared(p2.w, p.w.__srv);
  click(p2.w, p2.doc.getElementById('btn-resume'));
  p2.doc.querySelector('.fb-modal .fb-code-in').value = codeShown;   // full <id>.<key> from part A
  click(p2.w, btnByText(p2.doc.querySelector('.fb-modal'), 'Resume'));
  await settle(); await settle();
  ok((p2.doc.querySelector('[name="study_number"]') || {}).value === 'EDM-7', 'blob resume repopulated the chart (study_number)');

  // ---- C) resume a REDCap-born code with NO blob (bridge fallback) ----
  console.log('resume with no blob (bridge fallback, chart only):');
  const shared = { KV: new Map(), lastIntended: { scalars: { study_number: 'ONLY-REDCAP' }, checks: {} }, code: 'RCONLY99', verified: true, calls: [], codePosts: [] };
  const p3 = makePage(); installFetchShared(p3.w, shared);
  click(p3.w, p3.doc.getElementById('btn-resume'));
  p3.doc.querySelector('.fb-modal .fb-code-in').value = 'RCONLY99';
  click(p3.w, btnByText(p3.doc.querySelector('.fb-modal'), 'Resume'));
  await settle(); await settle();
  ok((p3.doc.querySelector('[name="study_number"]') || {}).value === 'ONLY-REDCAP', 'bridge fallback repopulated the chart from scraped values');

  // ---- D) unverified save surfaces the warning ----
  console.log('save via bridge (NOT verified) warns:');
  const p4 = makePage(); installFetch(p4.w, { verified: false, code: 'RCBAD777' });
  setField(p4.doc, p4.w, 'study_number', 'EDM-9');
  click(p4.w, p4.doc.getElementById('btn-save'));
  await settle(); await settle();
  const t4 = (p4.doc.querySelector('.fb-modal') || {}).textContent || '';
  ok(/could not confirm/i.test(t4), 'unverified save shows the review-in-REDCap warning');

  // ---- E) re-save updates the SAME REDCap record (sends the bridge code) ----
  console.log('re-save sends the bridge code (one record, provenance tracked):');
  const p5 = makePage(); const srv5 = installFetch(p5.w, { verified: true, code: 'RCSAME55' });
  setField(p5.doc, p5.w, 'study_number', 'EDM-1');
  click(p5.w, p5.doc.getElementById('btn-save')); await settle(); await settle();
  const code5a = (p5.doc.querySelector('.fb-code-val') || {}).textContent || '';
  const close5 = btnByText(p5.doc.querySelector('.fb-modal'), 'Close'); if (close5) click(p5.w, close5);
  setField(p5.doc, p5.w, 'study_number', 'EDM-2');   // edit + save again
  click(p5.w, p5.doc.getElementById('btn-save')); await settle(); await settle();
  const code5b = (p5.doc.querySelector('.fb-code-val') || {}).textContent || '';
  ok(srv5.codePosts.length === 2, 'two bridge saves happened');
  ok(!('code' in srv5.codePosts[0]) && srv5.codePosts[1].code === 'RCSAME55', 'the SECOND save resumes the same code (updates one record)');
  ok(code5a && code5a === code5b && code5a.indexOf('RCSAME55.') === 0, 're-save reuses the SAME record key (identical code shown both times)');

  // ---- F) after a bridge save, a network drop does NOT orphan the record into a new legacy code ----
  console.log('network drop after a bridge save surfaces an error, no legacy orphan:');
  const p6 = makePage(); const srv6 = installFetch(p6.w, { verified: true, code: 'RCNET66' });
  setField(p6.doc, p6.w, 'study_number', 'EDM-X');
  click(p6.w, p6.doc.getElementById('btn-save')); await settle(); await settle();
  const kvBefore = srv6.KV.size;
  const close6 = btnByText(p6.doc.querySelector('.fb-modal'), 'Close'); if (close6) click(p6.w, close6);
  srv6.codeFail = true;                                // simulate /api/code unreachable
  setField(p6.doc, p6.w, 'study_number', 'EDM-Y');
  click(p6.w, p6.doc.getElementById('btn-save')); await settle(); await settle();
  const t6 = (p6.doc.querySelector('.fb-modal') || {}).textContent || '';
  ok(/Could not save into REDCap|did not accept/i.test(t6), 'bridge network failure on a tracked record shows a clear error');
  ok(srv6.KV.size === kvBefore, 'no new legacy blob/code was minted (record not orphaned)');

  // ---- G) daily browser budget spent: a FRESH save falls back to a legacy app-only code ----
  console.log('daily_limit on a fresh save falls back to a legacy code with honest wording:');
  const p7 = makePage(); const srv7 = installFetch(p7.w, {}); srv7.dailyLimit = true;
  setField(p7.doc, p7.w, 'study_number', 'EDM-D');
  click(p7.w, p7.doc.getElementById('btn-save')); await settle(); await settle();
  const t7 = (p7.doc.querySelector('.fb-modal') || {}).textContent || '';
  const code7 = (p7.doc.querySelector('.fb-code-val') || {}).textContent || '';
  ok(/^RND\d+\.[A-Za-z0-9_-]{43}$/.test(code7), 'a legacy app-only <id>.<key> code was minted (work saved today)');
  ok(srv7.KV.has(code7.split('.')[0]), 'the encrypted blob is stored under the legacy id');
  ok(/used up for today/i.test(t7) && /not work on the REDCap form/i.test(t7), 'wording says the daily allowance is spent and the code is app-only');

  // ---- H) daily budget spent on a RE-SAVE of a REDCap-tied session: error, no orphan ----
  console.log('daily_limit on a re-save of a bridge record errors instead of orphaning:');
  const p8 = makePage(); const srv8 = installFetch(p8.w, { verified: true, code: 'RCDAY88' });
  setField(p8.doc, p8.w, 'study_number', 'EDM-8');
  click(p8.w, p8.doc.getElementById('btn-save')); await settle(); await settle();
  const close8 = btnByText(p8.doc.querySelector('.fb-modal'), 'Close'); if (close8) click(p8.w, close8);
  srv8.dailyLimit = true;
  const kv8 = srv8.KV.size;
  setField(p8.doc, p8.w, 'study_number', 'EDM-9');
  click(p8.w, p8.doc.getElementById('btn-save')); await settle(); await settle();
  const t8 = (p8.doc.querySelector('.fb-modal') || {}).textContent || '';
  ok(/used up for today/i.test(t8) && /tied to an existing REDCap record/i.test(t8), 'clear daily-limit message for a REDCap-tied session');
  ok(srv8.KV.size === kv8, 'no legacy blob/code was minted (record not orphaned)');

  // ---- I) daily budget spent on a bridge RESUME: distinct message, not "wait a few seconds" ----
  console.log('daily_limit on a bridge resume shows the reset-time message:');
  const p9 = makePage(); const srv9 = installFetch(p9.w, {}); srv9.dailyLimit = true;
  click(p9.w, p9.doc.getElementById('btn-resume'));
  p9.doc.querySelector('.fb-modal .fb-code-in').value = 'RCGONE12';
  click(p9.w, btnByText(p9.doc.querySelector('.fb-modal'), 'Resume'));
  await settle(); await settle();
  const t9 = (p9.doc.querySelector('.fb-resume-status') || {}).textContent || '';
  ok(/used up for today/i.test(t9) && /midnight UTC/i.test(t9), 'resume explains the daily allowance and when it resets');

  console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: bridge UI wiring correct.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(2); });

// Bind a page's fetch to an explicit shared server-state object (delegates to bindFetch).
function installFetchShared(w, srv) {
  srv.calls = srv.calls || []; srv.codePosts = srv.codePosts || [];
  bindFetch(w, srv);
}
