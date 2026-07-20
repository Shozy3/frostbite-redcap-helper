// Prove the baked calculator == REDCap's own literal equations (no transcription drift).
const fs=require('fs'),path=require('path');const ROOT=path.dirname(__dirname);
const C=JSON.parse(fs.readFileSync(ROOT+'/tools/hhr_calc.json'));const js=C.jsCode;
function round(number,decimal_points){if(number==null)return 'NaN';if(!decimal_points||decimal_points==null)return Math.round(number);var exp=Math.pow(10,decimal_points);number=Math.round(number*exp)/exp;return parseFloat(number.toFixed(decimal_points));}
eval(fs.readFileSync(ROOT+'/site/hhr_calc.js','utf8'));const BAKED=globalThis.HHR_CALC;
const refs=new Set();Object.values(js).forEach(e=>(e.match(/__chk__[a-z0-9_]+_RC_\d+/g)||[]).forEach(r=>refs.add(r)));
const refArr=[...refs];
function makeDoc(state){const el={};refArr.forEach(r=>el[r]={value:state[r]?r.match(/_RC_(\d+)$/)[1]:''});const p=new Proxy({},{get:(t,k)=>el[k]||{value:''}});return{forms:{form:{elements:p}},form:p};}
const rawFns={};for(const k in js)rawFns[k]=new Function('document','round','return ('+js[k]+');');
let mism=0,samples=[];
for(let i=0;i<3000;i++){const st={};refArr.forEach(r=>st[r]=Math.random()<0.3);const doc=makeDoc(st);
  for(const k in js){const raw=rawFns[k](doc,round);const baked=BAKED[k](doc);if(raw!==baked){mism++;if(samples.length<6)samples.push({k,raw,baked});}}}
console.log('calc fields:',Object.keys(js).length,'| checkbox refs:',refArr.length,'| iters: 3000 ('+(3000*Object.keys(js).length)+' evals)');
console.log('MISMATCHES (baked vs REDCap literal jsCode):',mism);samples.forEach(s=>console.log('  --',s));
const s2={};refArr.filter(r=>r.startsWith('__chk__ule_p_RC_')).slice(0,4).forEach(r=>s2[r]=true);
console.log('sanity hennepin_score_total (4 left-hand boxes checked):',BAKED.hennepin_score_total(makeDoc(s2)));
console.log(mism===0?'\nPASS: the calculator computes EXACTLY like REDCap (its own equations, verbatim).':'\nFAIL.');
process.exit(mism?1:0);
