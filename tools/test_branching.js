/*
 * Equivalence fuzz test: my transpiled branch trees vs REDCap's raw jsCode.
 * For thousands of random patient states, evaluate BOTH and assert identical.
 * REDCap raw jsCode is run via new Function against a mock `document`.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.dirname(__dirname);

// load shared evaluator (defines globalThis.FB)
eval(fs.readFileSync(path.join(ROOT, 'site', 'branch.js'), 'utf8'));
const evalBranch = globalThis.FB.evalBranch;

const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'dictionary.json'), 'utf8'));
const byVar = {};
dict.fields.forEach(f => { byVar[f.var] = f; });

// fields that have branching (with raw jsCode)
const branched = dict.fields.filter(f => f.branch && f.branch_raw);

// collect every field referenced by any leaf
function collectRefs(node, set) {
  if (!node) return;
  if (node.leaf) { set.add(node.leaf.field); return; }
  collectRefs(node.a, set); collectRefs(node.b, set);
}
const refs = new Set();
branched.forEach(f => collectRefs(f.branch, refs));

// sanity: every 'checked' leaf references a checkbox field with that rc
let sanity = [];
branched.forEach(f => {
  (function walk(n){ if(!n) return; if(n.leaf){ const L=n.leaf;
    if(L.type==='checked'){ const t=byVar[L.field];
      if(!t||t.type!=='checkbox') sanity.push(`${f.var}: checked leaf on non-checkbox ${L.field}`);
      else if(!t.options.some(o=>String(o.code)===String(L.code))) sanity.push(`${f.var}: code ${L.code} missing on ${L.field}`);
    } else { const t=byVar[L.field]; if(!t) sanity.push(`${f.var}: unknown field ${L.field}`); }
  } else { walk(n.a); walk(n.b); } })(f.branch);
});

function rint(n){ return Math.floor(Math.random()*n); }

function randomState() {
  // val[field]=code/'' ; checked[field]=Set(codes)
  const val = {}, checked = {};
  refs.forEach(field => {
    const t = byVar[field];
    if (!t) { val[field] = Math.random()<0.5?'':'1'; return; }
    if (t.type === 'checkbox') {
      const set = new Set();
      t.options.forEach(o => { if (Math.random()<0.5) set.add(o.code); });
      checked[field] = set;
      val[field] = '';
    } else if (t.options && t.options.length) {
      const pool = t.options.map(o=>o.code).concat(['']); // include unset
      val[field] = pool[rint(pool.length)];
    } else {
      val[field] = [ '', '1', 'x' ][rint(3)];
    }
  });
  return { val, checked };
}

function helpers(state) {
  return {
    val: f => (state.val[f] != null ? state.val[f] : ''),
    isChecked: (f, code) => state.checked[f] ? state.checked[f].has(String(code)) : false
  };
}

// Build a mock `document` for REDCap's raw jsCode and run it.
function rawEval(js, state) {
  const elements = {};
  refs.forEach(field => {
    const t = byVar[field];
    if (t && t.type === 'checkbox') {
      t.options.forEach(o => {
        const on = state.checked[field] && state.checked[field].has(o.code);
        elements['__chk__' + field + '_RC_' + o.code] = { value: on ? o.code : '' };
      });
      elements[field] = { value: '' };
    } else {
      elements[field] = { value: state.val[field] != null ? state.val[field] : '' };
    }
  });
  const proxy = new Proxy({}, { get(_t, k) { return elements[k] || { value: '' }; } });
  const documentMock = { form: proxy, forms: { form: { elements: proxy } } };
  const fn = new Function('document', js);
  return !!fn(documentMock);
}

const N = 50000;
let mism = [], errors = [];
for (let i = 0; i < N; i++) {
  const state = randomState();
  const h = helpers(state);
  for (const f of branched) {
    let raw, mine;
    try { raw = rawEval(f.branch_raw, state); }
    catch (e) { errors.push(`${f.var}: raw eval error ${e.message}`); continue; }
    mine = !!evalBranch(f.branch, h);
    if (raw !== mine) {
      if (mism.length < 12)
        mism.push({ field: f.var, raw, mine, js: f.branch_raw,
                    state: JSON.stringify({val:state.val,
                      checked:Object.fromEntries(Object.entries(state.checked).map(([k,v])=>[k,[...v]]))}).slice(0,300) });
    }
  }
}

console.log('branched fields:', branched.length, '| referenced fields:', refs.size, '| iterations:', N);
console.log('sanity problems:', sanity.length, sanity.slice(0,10));
console.log('raw-eval errors:', errors.length, [...new Set(errors)].slice(0,10));
console.log('MISMATCHES:', mism.length);
mism.forEach(m => { console.log('  --', m.field, 'raw=', m.raw, 'mine=', m.mine); console.log('     js:', m.js); console.log('     state:', m.state); });
console.log(mism.length === 0 && errors.length === 0 && sanity.length === 0 ? '\nPASS: branching is exactly equivalent to REDCap.' : '\nFAIL.');
process.exit(mism.length || errors.length || sanity.length ? 1 : 0);
