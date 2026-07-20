/*
 * Deterministic UI test (jsdom) for the NEW features, end-to-end through the real page:
 *   - typed DD-MM-YYYY date mask driven by real keystroke ('input') events
 *     (the regression guard for "typing 2127 shows 0212") + caret + payload ISO
 *   - the "Auto" button writes DD-MM-2099 and still converts to ISO on submit
 *   - incomplete/invalid required dates are NOT counted complete (Review missing)
 *   - ZERO-KNOWLEDGE cross-computer Save: browser encrypts, only ciphertext reaches
 *     the (mocked, shared) /api/save store; a FRESH page resumes from the code and
 *     restores ALL THREE forms; Delete purges; unknown code is handled
 *   - #5 regression: an injected branch-hidden value survives reload
 *
 * The Cloudflare Pages Function is simulated by an in-memory Map shared across two
 * jsdom windows (= two computers hitting the same KV). Real AES-GCM runs via Node's
 * webcrypto, so the crypto path is exercised for real; only the network is mocked.
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.dirname(__dirname), SITE = path.join(ROOT, 'site');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');

let fails = [], passes = 0;
const ok = (c, m) => { if (c) passes++; else fails.push(m); };
const settle = () => new Promise(r => setTimeout(r, 80));

// Shared "server": the mocked /api/save KV, shared across pages (= cross-computer).
const KV = new Map();
function installFetch(w) {
  w.fetch = function (url, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const u = String(url), q = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '';
    const m = q.match(/(?:^|&)id=([^&]+)/), id = m ? decodeURIComponent(m[1]) : null;
    const resp = (status, obj) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(obj) });
    // Bridge Worker not deployed in this scenario -> 501, so the app falls back to
    // the legacy random-code /api/save path this test covers. (The bridge path has
    // its own test: tools/test_bridge_ui.js.)
    if (u.indexOf('/api/code') >= 0) return resp(501, { error: 'bridge_unconfigured' });
    if (method === 'POST') {
      let body; try { body = JSON.parse(opts.body); } catch (e) { return resp(400, { error: 'bad' }); }
      // v3 blobs carry { ct, iv, dtok } (no salt); the client encrypts under a per-record key.
      if (!body || typeof body.ct !== 'string' || typeof body.iv !== 'string' || typeof body.dtok !== 'string') return resp(400, { error: 'bad' });
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const seed = KV.size + 1; let nid = '';
      for (let i = 0; i < 8; i++) nid += A[(seed * (i + 7)) % 32]; // deterministic 8-char id for the test
      KV.set(nid, { ct: body.ct, iv: body.iv, dtok: body.dtok });
      return resp(200, { id: nid });
    }
    if (method === 'GET') return (id && KV.has(id)) ? resp(200, KV.get(id)) : resp(404, { error: 'not_found' });
    if (method === 'DELETE') { if (id) KV.delete(id); return resp(204, null); }
    return resp(405, {});
  };
}

function makePage(seedLocal, seedSession) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  try { Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) {}
  if (!w.TextEncoder) { w.TextEncoder = global.TextEncoder; w.TextDecoder = global.TextDecoder; }
  if (!w.btoa) { w.btoa = s => Buffer.from(s, 'binary').toString('base64'); w.atob = b => Buffer.from(b, 'base64').toString('binary'); }
  if (seedLocal) Object.keys(seedLocal).forEach(k => { try { w.localStorage.setItem(k, seedLocal[k]); } catch (e) {} });
  if (seedSession) Object.keys(seedSession).forEach(k => { try { w.sessionStorage.setItem(k, seedSession[k]); } catch (e) {} });
  w.eval(read('config.js')); w.CONFIG.requirePassphrase = false;
  w.eval(read('datemask.js'));
  w.eval(read('dictionary.js')); w.eval(read('dict_hhr.js')); w.eval(read('branch.js'));
  w.eval(read('payload.js')); w.eval(read('hhr_calc.js')); w.eval(read('hhr_maps.js'));
  w.eval(read('hhr.js')); w.eval(read('ilop.js')); w.eval(read('cryptosave.js')); w.eval(read('app.js'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, doc: w.document };
}

const click = (w, node) => node && node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const change = (w, node) => node && node.dispatchEvent(new w.Event('change', { bubbles: true }));
const btnByText = (root, t) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === t);
function typeInto(w, input, str) {
  for (let i = 0; i < str.length; i++) {
    const s = (input.selectionStart == null) ? input.value.length : input.selectionStart;
    const e = (input.selectionEnd == null) ? s : input.selectionEnd;
    input.value = input.value.slice(0, s) + str[i] + input.value.slice(e);
    try { input.setSelectionRange(s + 1, s + 1); } catch (_) {}
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
}

(async function main() {
  // ---------------- A) date mask via real keystrokes ----------------
  (function () {
    const { w, doc } = makePage();
    const dobInput = doc.querySelector('#app [data-var="date_of_birth"] input');
    ok(dobInput && dobInput.type === 'text' && dobInput.getAttribute('data-datekind') === 'date', 'date_of_birth is a typed text date box');

    const seen = [];
    dobInput.value = ''; try { dobInput.setSelectionRange(0, 0); } catch (_) {}
    '2127'.split('').forEach(ch => { typeInto(w, dobInput, ch); seen.push(dobInput.value); });
    ok(seen.indexOf('0212') === -1, 'typing 2127 NEVER renders 0212 (saw: ' + seen.join(' , ') + ')');
    ok(dobInput.value === '21-27', 'after typing 2127 the field reads 21-27 (left-to-right)');

    dobInput.value = ''; try { dobInput.setSelectionRange(0, 0); } catch (_) {}
    typeInto(w, dobInput, '21021999');
    ok(dobInput.value === '21-02-1999', 'full DOB types to 21-02-1999 (got ' + dobInput.value + ')');
    ok(dobInput.selectionStart === dobInput.value.length, 'caret sits at the end after sequential typing');

    dobInput.value = ''; try { dobInput.setSelectionRange(0, 0); } catch (_) {}
    typeInto(w, dobInput, '15032127');
    ok(dobInput.value === '15-03-2127', 'year 2127 fully enterable as the date 15-03-2127');

    const autoB = doc.querySelector('#app [data-var="date_of_birth"] .auto-btn');
    click(w, autoB);
    ok(/^\d{2}-\d{2}-2099$/.test(dobInput.value), 'Auto writes DD-MM-2099 (got ' + dobInput.value + ')');

    const dtInput = doc.querySelector('#app [data-var="time_of_ed_arrival"] input');
    ok(dtInput && dtInput.getAttribute('data-datekind') === 'datetime', 'time_of_ed_arrival is a typed datetime box');
    dtInput.value = ''; try { dtInput.setSelectionRange(0, 0); } catch (_) {}
    typeInto(w, dtInput, '210219991430');
    ok(dtInput.value === '21-02-1999 14:30', 'datetime types to 21-02-1999 14:30 (got ' + dtInput.value + ')');

    const FB = w.FB;
    const payload = FB.buildPayload(w.DICT, { values: { date_of_birth: '21-02-1999', time_of_ed_arrival: '21-02-1999 14:30' }, checked: {}, visible: { date_of_birth: true, time_of_ed_arrival: true } });
    const find = n => (payload.find(p => p.name === n) || {}).value;
    ok(find('date_of_birth') === '1999-02-21', 'payload encodes date_of_birth as ISO 1999-02-21');
    ok(find('time_of_ed_arrival') === '1999-02-21 14:30', 'payload encodes datetime as ISO 1999-02-21 14:30');

    // #6: an incomplete/invalid required date must NOT count as complete.
    dobInput.value = ''; try { dobInput.setSelectionRange(0, 0); } catch (_) {}
    typeInto(w, dobInput, '2106'); // "21-06", incomplete
    doc.getElementById('btn-review').click();
    ok([...doc.querySelectorAll('#review-list .review-q')].map(n => n.textContent).indexOf('Date of Birth') >= 0, 'an incomplete required date is listed under Review missing (#6)');
    doc.getElementById('btn-review').click();
    dobInput.value = ''; try { dobInput.setSelectionRange(0, 0); } catch (_) {}
    typeInto(w, dobInput, '21061990'); // "21-06-1990", complete + valid
    doc.getElementById('btn-review').click();
    ok([...doc.querySelectorAll('#review-list .review-q')].map(n => n.textContent).indexOf('Date of Birth') === -1, 'a complete valid date no longer counts as missing (#6)');
  })();

  // ---------------- B+C) zero-knowledge cross-computer Save / Resume ----------------
  let savedCode = null;
  {
    // page 1: fill all three forms, Save & get a code
    const p1 = makePage(); const w1 = p1.w, d1 = p1.doc; installFetch(w1); w1.sessionStorage.setItem('fb_pp', 'TestPass');
    const sn = d1.querySelector('#app [data-var="study_number"] input'); sn.value = 'EDM-77'; change(w1, sn);
    const sexM = [...d1.querySelectorAll('#app [data-var="sex"] input')].find(i => i.value === '2'); sexM.checked = true; change(w1, sexM);
    typeInto(w1, d1.querySelector('#app [data-var="date_of_birth"] input'), '03071985');

    click(w1, d1.getElementById('sw-hhr'));
    const inj1 = [...d1.querySelectorAll('#app-hhr [data-var="extremity_perfusion_hfs"] input')].find(i => i.value === '1');
    inj1.checked = true; change(w1, inj1);
    click(w1, d1.querySelector('#app-hhr .hhr-dx[data-region="lh"] polygon.hhr-seg'));
    const hhrTotal1 = d1.querySelector('#app-hhr .hhr-total-val').textContent;
    ok(Number(hhrTotal1) > 0, 'page1 Hennepin score is non-zero (' + hhrTotal1 + ')');

    click(w1, d1.getElementById('sw-ilop'));
    const rows = () => [...d1.querySelectorAll('#app-ilop .ilop-dose .ilop-rows .ilop-row')].filter(r => !r.classList.contains('ilop-row-head'));
    const setVal = (input, v) => { input.value = v; input.dispatchEvent(new w1.Event('input', { bubbles: true })); };
    setVal(rows()[0].querySelector('.ilop-c-time input'), '08:00');
    setVal(rows()[0].querySelector('.ilop-c-rate input'), '6');
    setVal(d1.querySelector('#app-ilop .ilop-stoprow input'), '10:00');
    const ilopGrand1 = d1.getElementById('ilop-livetotal').querySelector('.ilop-livetotal-val').textContent;
    ok(ilopGrand1 === '12.00', 'page1 iloprost grand total is 12.00');

    click(w1, d1.getElementById('btn-save'));
    await settle();
    const codeEl = d1.querySelector('.fb-modal .fb-code-val');
    ok(codeEl, 'save modal shows the code');
    savedCode = codeEl ? codeEl.textContent.trim() : '';
    ok(/^[A-Z0-9]{1,16}\.[A-Za-z0-9_-]{43}$/.test(savedCode), 'code is <id>.<key> with a 43-char record key (got "' + savedCode + '")');
    ok(KV.size === 1, 'exactly one ciphertext blob reached the (mocked) server');
    // ZERO-KNOWLEDGE: the server holds only ct/iv/dtok — no salt, no plaintext, and NOT the key.
    const stored = [...KV.values()][0];
    const keyHalf = savedCode.split('.')[1];
    ok(stored && stored.ct && stored.iv && stored.dtok && !stored.salt
      && JSON.stringify(stored).indexOf('EDM-77') < 0 && JSON.stringify(stored).indexOf('study_number') < 0
      && JSON.stringify(stored).indexOf(keyHalf) < 0,
      'server stores only opaque { ct, iv, dtok } (no salt, no plaintext, and NOT the record key)');

    // page 2: a FRESH page (other "computer"), same shared KV → resume from the code
    const p2 = makePage(); const w2 = p2.w, d2 = p2.doc; installFetch(w2); w2.sessionStorage.setItem('fb_pp', 'TestPass');
    ok((d2.querySelector('#app [data-var="study_number"] input').value || '') === '', 'fresh page2 starts blank');
    click(w2, d2.getElementById('btn-resume'));
    d2.querySelector('.fb-modal .fb-code-in').value = '  ' + savedCode + '  '; // tolerate stray whitespace
    click(w2, btnByText(d2.querySelector('.fb-modal'), 'Resume'));
    await settle();
    ok(d2.querySelector('#app [data-var="study_number"] input').value === 'EDM-77', 'page2 restored study_number');
    ok(d2.querySelector('#app [data-var="date_of_birth"] input').value === '03-07-1985', 'page2 restored DOB (DD-MM-YYYY)');
    const sex2 = [...d2.querySelectorAll('#app [data-var="sex"] input')].find(i => i.value === '2');
    ok(sex2 && sex2.checked, 'page2 restored the sex radio');
    click(w2, d2.getElementById('sw-hhr'));
    ok(d2.querySelector('#app-hhr .hhr-total-val').textContent === hhrTotal1, 'page2 restored the Hennepin score (' + d2.querySelector('#app-hhr .hhr-total-val').textContent + ')');
    click(w2, d2.getElementById('sw-ilop'));
    ok(d2.getElementById('ilop-livetotal').querySelector('.ilop-livetotal-val').textContent === ilopGrand1, 'page2 restored the iloprost grand total (' + ilopGrand1 + ')');

    // Delete this saved copy from the server
    click(w2, d2.getElementById('btn-resume'));
    d2.querySelector('.fb-modal .fb-code-in').value = savedCode;
    click(w2, btnByText(d2.querySelector('.fb-modal'), 'Delete this saved copy'));
    await settle();
    ok(KV.size === 0, 'Delete purged the ciphertext from the server');

    // Unknown / expired code is handled gracefully
    const p3 = makePage(); installFetch(p3.w); p3.w.sessionStorage.setItem('fb_pp', 'TestPass');
    click(p3.w, p3.doc.getElementById('btn-resume'));
    p3.doc.querySelector('.fb-modal .fb-code-in').value = 'ZZZZZZZZ'; // valid shape, not in the store
    click(p3.w, btnByText(p3.doc.querySelector('.fb-modal'), 'Resume'));
    await settle();
    ok(/No saved form/.test((p3.doc.querySelector('.fb-resume-status') || {}).textContent || ''), 'unknown/deleted code shows a friendly "not found" message');
    // A code with no usable characters is rejected before any network call
    const p4 = makePage(); installFetch(p4.w);
    click(p4.w, p4.doc.getElementById('btn-resume'));
    p4.doc.querySelector('.fb-modal .fb-code-in').value = '------';
    click(p4.w, btnByText(p4.doc.querySelector('.fb-modal'), 'Resume'));
    await settle();
    ok(/Enter the code/.test((p4.doc.querySelector('.fb-resume-status') || {}).textContent || ''), 'an empty/garbage code is rejected as invalid');
  }

  // ---------------- E) #5 regression: injected value in a branch-hidden field survives reload ----------------
  (function () {
    const draft = JSON.stringify({ values: { study_number: 'RLD-9', iloprost_dose: 'Dose 1: 12.00 mcg; Total: 12.00 mcg' }, checked: {} });
    const p = makePage(null, { fb_draft: draft });
    const w = p.w, d = p.doc;
    ok(d.querySelector('#app [data-var="study_number"] input').value === 'RLD-9', 'draft restored a normal field on reload');
    const adminYes = [...d.querySelectorAll('#app [data-var="illoprost_administration"] input')].find(i => i.value === '1');
    ok(adminYes, 'illoprost_administration Yes option exists');
    if (adminYes) { adminYes.checked = true; adminYes.dispatchEvent(new w.Event('change', { bubbles: true })); }
    const idField = d.querySelector('#app [data-var="iloprost_dose"] textarea');
    ok(idField && idField.value === 'Dose 1: 12.00 mcg; Total: 12.00 mcg',
      'branch-hidden injected iloprost_dose survived reload and reappears when revealed (no data loss) (#5)');
  })();

  console.log(`\nFeatures UI test — ${passes} passed, ${fails.length} failed`);
  fails.forEach(f => console.log('  ✗ ' + f));
  console.log(fails.length ? '\nFAIL' : '\nPASS: date mask, Auto, and zero-knowledge cross-computer save/resume of all three forms work end-to-end.');
  process.exit(fails.length ? 1 : 0);
})().catch(function (e) { console.error('ERROR', e); process.exit(2); });
