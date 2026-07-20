/*
 * End-to-end round-trip test: build a maximal valid record with the SHARED
 * payload builder, POST it to the live REDCap survey (the __prefill method),
 * and assert every sent value comes back populated/checked. This simultaneously
 * proves (a) the payload encoding and (b) that our branching-visibility matches
 * REDCap's (a field we marked visible but REDCap hides would fail to round-trip).
 */
const fs = require('fs'), path = require('path');
const ROOT = path.dirname(__dirname);
eval(fs.readFileSync(path.join(ROOT, 'site', 'branch.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'site', 'payload.js'), 'utf8'));
const FB = globalThis.FB;
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'dictionary.json'), 'utf8'));
const byVar = {}; dict.fields.forEach(f => byVar[f.var] = f);

// --- maximal valid state: every checkbox option checked, radios = first code ---
const values = {}, checked = {};
for (const f of dict.fields) {
  if (f.type === 'checkbox') checked[f.var] = new Set(f.options.map(o => o.code));
  else if (f.type === 'radio' || f.type === 'yesno') { if (f.options.length) values[f.var] = f.options[0].code; }
  else if (f.type === 'textarea') values[f.var] = 'Note_' + f.var;
  else {
    const v = f.validation || '';
    if (v.indexOf('datetime') === 0) values[f.var] = '2000-01-15T13:45';
    else if (v.indexOf('date') === 0) values[f.var] = '2000-01-15';
    else if (v === 'integer') values[f.var] = '3';
    else if (v === 'number') values[f.var] = '5';
    else values[f.var] = 'TX' + f.var.replace(/_/g, '').slice(0, 8);
  }
}
const state = { values, checked };
const visible = FB.computeVisibility(dict, state);
const payload = FB.buildPayload(dict, { values, checked, visible });

function dispDate(v, val) {
  if (val.indexOf('datetime') === 0) { const [d, t] = v.split(' '); const [Y, M, D] = d.split('-'); return `${D}-${M}-${Y} ${t}`; }
  const [Y, M, D] = v.split('-');
  return val.indexOf('date_mdy') === 0 ? `${M}-${D}-${Y}` : `${D}-${M}-${Y}`;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

(async () => {
  const body = payload.map(p => encodeURIComponent(p.name) + '=' + encodeURIComponent(p.value)).join('&');
  const res = await fetch(dict.post_action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body
  });
  const html = await res.text();
  fs.writeFileSync('/tmp/roundtrip.html', html);

  let pass = 0, fail = [];
  for (const p of payload) {
    if (p.name === '__prefill') continue;
    if (p.name.includes('___')) {
      const [v, code] = p.name.split('___');
      const m = html.match(new RegExp("<input[^>]*id='id-__chk__" + esc(v) + "_RC_" + esc(code) + "'[^>]*>"));
      if (m && /checked/.test(m[0])) pass++;
      else fail.push(`checkbox ${v}___${code} not checked`);
    } else {
      const f = byVar[p.name];
      if (f.type === 'textarea') {
        if (html.includes(values[p.name])) pass++; else fail.push(`textarea ${p.name} missing`);
        continue;
      }
      let expected = p.value;
      if (f.validation && f.validation.indexOf('date') === 0) expected = dispDate(p.value, f.validation);
      const re = new RegExp("name='" + esc(p.name) + "'\\s+value='" + esc(expected) + "'");
      if (re.test(html)) pass++; else fail.push(`${p.name} expected value='${expected}' not found`);
    }
  }

  console.log('payload pairs:', payload.length, '| visible fields:', Object.values(visible).filter(Boolean).length, '/', dict.fields.length);
  console.log('verified:', pass, '| failures:', fail.length);
  fail.slice(0, 30).forEach(x => console.log('  --', x));
  console.log(fail.length === 0 ? '\nPASS: full record round-trips into REDCap exactly.' : '\nFAIL.');
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
