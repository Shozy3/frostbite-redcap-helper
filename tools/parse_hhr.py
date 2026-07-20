#!/usr/bin/env python3
"""
Parse the Hennepin Frostbite Score CALCULATOR (redcap.hhrinstitute.org survey
s=NRLMJK7YWH9TFYXN) into:
  site/dict_hhr.js  -> window.DICT_HHR (inputs = checkboxes; descriptive text/image; calc outputs; branching)
  site/hhr_calc.js  -> window.HHR_CALC (REDCap's LITERAL calc equations + REDCap's exact round(),
                       so the score is computed EXACTLY as the original form)
The score is NOT re-derived — we bake REDCap's own Calculations.jsCode expressions verbatim.
"""
import json, re, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = open(os.path.join(ROOT, "tools", "survey_hhr.html"), encoding="utf-8", errors="replace").read()
CALC = json.load(open(os.path.join(ROOT, "tools", "hhr_calc.json")))   # the Calculations object
JSCALC = CALC.get("jsCode", {})

SURVEY_KEY = "NRLMJK7YWH9TFYXN"
ORIGIN = "https://redcap.hhrinstitute.org"
POST_ACTION = ORIGIN + "/surveys/?s=" + SURVEY_KEY

# --- Safety guard: refuse to bake a calc equation that is anything other than a
# pure arithmetic/comparison expression. Each REDCap `jsCode` equation is interpolated
# verbatim into JS *expression position* in site/hhr_calc.js, which the page loads as a
# same-origin <script> (CSP script-src 'self' cannot constrain first-party script content).
# Without this guard, a tampered/edited survey export could inject arbitrary JS into the
# shipped bundle. Fail-loud defense-in-depth, mirroring parse_survey.py's branching guard;
# the stronger long-term fix is an allowlist grammar / safe interpreter (no baked JS).
_CALC_BAD_TOKEN = re.compile(
    r";|\{|\}|`|/\*|\*/|//|=>"
    r"|\b(function|fetch|eval|import|export|require|constructor|prototype"
    r"|globalThis|window|location|cookie|XMLHttpRequest|Function"
    r"|setTimeout|setInterval|localStorage|sessionStorage)\b")
_CALC_ASSIGN = re.compile(r"(?<![=<>!])=(?!=)")   # a lone '=' (assignment), but not == <= >= != ===

def _assert_safe_calc(var, eq):
    def _fail(why):
        sys.exit("FATAL (parse_hhr): refusing to bake calc %r — %s.\n"
                 "  The equation is interpolated verbatim into executable JS (site/hhr_calc.js).\n"
                 "  Equation: %s" % (var, why, eq))
    m = _CALC_BAD_TOKEN.search(eq)
    if m:
        _fail("contains forbidden token %r (only arithmetic/comparison expressions may be baked)" % m.group(0))
    if _CALC_ASSIGN.search(eq):
        _fail("contains an assignment ('='); only comparisons (==, <=, >=, !=) are allowed")
    stripped = re.sub(r"'[^']*'|\"[^\"]*\"", "", eq)   # ignore quoted strings when balancing parens
    if stripped.count("(") != stripped.count(")"):
        _fail("has unbalanced parentheses")

def strip_tags(s):
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&amp;","&").replace("&lt;","<").replace("&gt;",">").replace("&nbsp;"," ").replace("&#39;","'").replace("&#0?39;","'").replace("&quot;",'"')
    return re.sub(r"\s+"," ",s).strip()

def get_label(var):
    m = re.search(r"id=['\"]label-"+re.escape(var)+r"['\"]", HTML)
    if not m: return var
    win = HTML[m.start():m.start()+4000]
    lm = re.search(r'data-mlm-type="label">(.*?)</div>', win, re.S)
    return strip_tags(lm.group(1)) if lm else var

def dedupe(opts):
    seen=set(); out=[]
    for o in opts:
        if o["code"] in seen: continue
        seen.add(o["code"]); out.append({"code":o["code"],"label":o["label"]})
    for i,o in enumerate(out, start=1): o["rc"]=i
    return out

# ---- branching transpiler (same shape as parse_survey.py) ----
LEAF_CHK = re.compile(r"document\.forms\['form'\]\.elements\['__chk__([a-z0-9_]+)_RC_(\d+)'\]\.value\s*==\s*''\s*\?\s*0\s*:\s*1\s*\)\s*\)\s*==\s*'([01])'")
LEAF_CMP = re.compile(r"document\.(?:form\.([a-z0-9_]+)|forms\['form'\]\.elements\['([a-z0-9_]+)'\])\.value\s*(==|!=)\s*'([^']*)'")
def transpile(js):
    s = re.sub(r"^return\s*","",js.strip()).rstrip(";").strip()
    leaves=[]
    def gchk(m): leaves.append({"type":"checked","field":m.group(1),"code":m.group(2),"want":int(m.group(3))}); return " \x00%d\x00 "%(len(leaves)-1)
    def gcmp(m):
        field=m.group(1) or m.group(2); op="eq" if m.group(3)=="==" else "ne"; val=m.group(4)
        if val=="" and op=="ne": leaves.append({"type":"nonempty","field":field})
        else: leaves.append({"type":op,"field":field,"value":val})
        return " \x00%d\x00 "%(len(leaves)-1)
    s=LEAF_CHK.sub(gchk,s); s=LEAF_CMP.sub(gcmp,s)
    leftover=re.sub(r"[\x00\d\s()|&]","",s)
    toks=re.findall(r"\x00\d+\x00|&&|\|\||\(|\)", s); pos=[0]
    def peek(): return toks[pos[0]] if pos[0]<len(toks) else None
    def nxt(): pos[0]+=1; return toks[pos[0]-1]
    def p_or():
        n=p_and()
        while peek()=="||": nxt(); n={"op":"or","a":n,"b":p_and()}
        return n
    def p_and():
        n=p_atom()
        while peek()=="&&": nxt(); n={"op":"and","a":n,"b":p_atom()}
        return n
    def p_atom():
        t=peek()
        if t=="(": nxt(); n=p_or();
        else:
            if t and t.startswith("\x00"): nxt(); return {"leaf":leaves[int(t.strip(chr(0)))]}
            return None
        if peek()==")": nxt()
        return n
    return (p_or() if toks else None), leftover

BL = None
i = HTML.find("var BranchingLogic")
if i >= 0:
    b = HTML.find("{", i); depth=0; instr=False; esc=False; q=''
    for k in range(b, len(HTML)):
        c=HTML[k]
        if instr:
            if esc: esc=False
            elif c=="\\": esc=True
            elif c==q: instr=False
        else:
            if c in "\"'": instr=True; q=c
            elif c=="{": depth+=1
            elif c=="}":
                depth-=1
                if depth==0: BL=json.loads(HTML[b:k+1]); break
BJS = (BL or {}).get("jsCode", {})

# ---- walk fields ----
ENUM = re.compile(r"data-mlm-type=['\"]enum['\"]\s+data-mlm-value=['\"]([^'\"]*)['\"][^>]*>(.*?)</label>", re.S)
body = HTML[HTML.find("id='questiontable'"):]
chunks = re.split(r"(?=<tr\b)", body)
fields=[]; section=""; seen=set()
for ch in chunks:
    head=ch[:400]
    if "class='header'" in head or 'class="header"' in head:
        hm=re.search(r'data-mlm-type="header">(.*?)</div>', ch, re.S)
        if hm: section=strip_tags(hm.group(1))
        continue
    sq=re.search(r"sq_id='([a-z0-9_]+)'",head); ft=re.search(r"fieldtype='([a-z_]+)'",head)
    if not sq or not ft: continue
    var=sq.group(1); ftype=ft.group(1)
    if var in seen: continue
    seen.add(var)
    f={"var":var,"type":ftype,"section":section}
    if ftype=="checkbox":
        f["label"]=get_label(var)
        f["options"]=dedupe([{"code":m.group(1).strip(),"label":strip_tags(m.group(2))} for m in ENUM.finditer(ch)])
        if var in BJS:
            tree,left=transpile(BJS[var]); f["branch"]=tree
    elif ftype=="descriptive":
        lm=re.search(r'data-mlm-type="label">(.*?)</div>', ch, re.S)
        f["label"]=strip_tags(lm.group(1)) if lm else ""
        f["text"]=f["label"]
        img=re.search(r"<img[^>]+src=['\"]([^'\"]+)['\"]", ch)
        if img: f["image"]="/hhr/diagram.jpg"   # all descriptive images are the one Hennepin diagram (hosted locally)
        if var in BJS:
            tree,left=transpile(BJS[var]); f["branch"]=tree
    elif ftype=="calc":
        f["label"]=get_label(var)
        if var in BJS:
            tree,left=transpile(BJS[var]); f["branch"]=tree
    elif ftype=="file":
        f["label"]=get_label(var)   # rendered as a note (uploads done in REDCap)
    fields.append(f)

# intro/citation text (the descriptive 'intro')
citation = next((f["text"] for f in fields if f["var"]=="intro"), "")

cm = re.search(r"name=['\"]([a-z0-9_]+_complete)['\"]", HTML)
out = {
  "survey_key": SURVEY_KEY,
  "post_action": POST_ACTION,
  "origin": ORIGIN,
  "complete_field": cm.group(1) if cm else None,
  "title": "Hennepin Frostbite Score Calculator",
  "citation": citation,
  "image": "/hhr/diagram.jpg",
  "fields": fields,
  "calc_fields": [{"var":v,"label":get_label(v)} for v in JSCALC.keys()],
}
with open(os.path.join(ROOT,"site","dict_hhr.js"),"w") as fh:
    fh.write("/* generated by tools/parse_hhr.py */\nwindow.DICT_HHR=" + json.dumps(out) + ";\n")

# ---- bake REDCap's literal calc equations + REDCap's exact round() ----
with open(os.path.join(ROOT,"site","hhr_calc.js"),"w") as fh:
    fh.write("/* generated by tools/parse_hhr.py — REDCap's own calc equations, verbatim. */\n")
    fh.write("(function(g){\n")
    fh.write("  function round(number,decimal_points){\n")
    fh.write("    if(number==null) return 'NaN';\n")
    fh.write("    if(!decimal_points||decimal_points==null) return Math.round(number);\n")
    fh.write("    var exp=Math.pow(10,decimal_points);\n")
    fh.write("    number=Math.round(number*exp)/exp;\n")
    fh.write("    return parseFloat(number.toFixed(decimal_points));\n")
    fh.write("  }\n")
    fh.write("  g.HHR_CALC={\n")
    for var, eq in JSCALC.items():
        eq1 = eq.strip().rstrip(";")
        _assert_safe_calc(var, eq1)   # block code-injection via a tampered survey export (F-12)
        fh.write('    %s: function(document){ return (%s); },\n' % (json.dumps(var), eq1))
    fh.write("  };\n")
    fh.write("})(typeof window!=='undefined'?window:globalThis);\n")

# ---- clickable image-map geometry -> site/hhr_maps.js (window.HHR_MAPS) ----
# Each anatomical figure overlays an HTML <map> of <area> polygons; the calculator
# renders these as a responsive SVG overlay. data-key = checkbox option code,
# alt/title = the anatomical label. Parsed verbatim so the geometry stays exact.
import struct as _struct
MAP_DEFS = [("ule_map","ule_p","lh","Left Hand"),("ure_map","ure_p","rh","Right Hand"),
            ("lle_map","lle_p","lf","Left Foot"),("lre_map","lre_p","rf","Right Foot"),
            ("proximal_map","proximal_p","proximal","Proximal Extremity")]
def _attr(tag,name):
    m=re.search(name+r'="([^"]*)"',tag,re.I); return m.group(1) if m else None
def _img_dims(path):   # JPEG SOF parse; falls back to 720x540 if the file is absent
    try:
        data=open(path,"rb").read(); i=2
        while i<len(data):
            if data[i]!=0xFF: i+=1; continue
            mk=data[i+1]
            if mk in (0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF):
                h,w=_struct.unpack(">HH",data[i+5:i+9]); return w,h
            i+=2+_struct.unpack(">H",data[i+2:i+4])[0]
    except Exception: pass
    return 720,540
maps_out={}
for mapid,field,region,label in MAP_DEFS:
    s=HTML.find('id="'+mapid+'"'); s=s if s>=0 else HTML.find(mapid)
    blk=HTML[s:HTML.find("</map>",s)]; areas=[]
    for tag in re.findall(r"<area\b[^>]*>",blk,re.I):
        c=_attr(tag,"coords")
        if c is None: continue
        nums=[int(round(float(x))) for x in re.split(r"[ ,]+",c.strip()) if x!=""]
        areas.append({"key":_attr(tag,"data-key"),"code":_attr(tag,"alt") or _attr(tag,"title"),
                      "shape":_attr(tag,"shape") or "poly","coords":nums})
    w,h=_img_dims(os.path.join(ROOT,"site","hhr","img",region+".jpg"))
    maps_out[region]={"map":mapid,"field":field,"region":label,"img":"/hhr/img/"+region+".jpg","w":w,"h":h,"areas":areas}
with open(os.path.join(ROOT,"site","hhr_maps.js"),"w") as fh:
    fh.write("/* generated by tools/parse_hhr.py — clickable image-map geometry, verbatim from the survey's <area coords>.\n")
    fh.write("   Coords are in the figures' native 720x540 (4:3) pixel space — the size the original imgur images render at,\n")
    fh.write("   which the <area> coords were measured against. The bundled /hhr/img/*.jpg are those same 720x540 renders;\n")
    fh.write("   a future re-download MUST keep 720x540 (or at least 4:3) or the SVG overlay polygons will misalign. */\n")
    fh.write("window.HHR_MAPS="+json.dumps(maps_out,separators=(',',':'))+";\n")

from collections import Counter
print("HHR fields:", len(fields), dict(Counter(f["type"] for f in fields)))
print("checkbox inputs:", [f["var"] for f in fields if f["type"]=="checkbox"])
print("calc fields baked:", len(JSCALC))
print("descriptive w/ image:", [f["var"] for f in fields if f.get("image")])
print("citation:", citation[:80])
print("branch trees:", sum(1 for f in fields if f.get("branch")))
print("image maps:", {r: len(maps_out[r]["areas"]) for r in maps_out},
      "=", sum(len(v["areas"]) for v in maps_out.values()), "polygons ->", "site/hhr_maps.js")
print("figure images (refresh into site/hhr/img/{lh,rh,lf,rf,proximal}.jpg if these changed):")
for _u in re.findall(r'src="(https://i\.imgur\.com/[^"]+)"', HTML): print("   ", _u)
