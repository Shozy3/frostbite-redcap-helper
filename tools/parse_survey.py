#!/usr/bin/env python3
"""
Parse the REDCap survey HTML (tools/survey.html) into a faithful data dictionary
(site/dictionary.json) used to render the haddeya.com helper form and to build a
REDCap prefill payload.

Extracts, per field (in document order):
  var, section, label, type (text|textarea|radio|checkbox|yesno),
  validation (date_dmy|datetime_dmy|number|integer|...), min, max, required,
  matrix group, options [{code,label,rc}], and the branching condition
  (transpiled tree + REDCap's raw jsCode for later equivalence verification).

No assumptions: every coded value and option comes straight from the HTML.
"""
import json, re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = open(os.path.join(ROOT, "tools", "survey.html"), encoding="utf-8", errors="replace").read()
BL = json.load(open(os.path.join(ROOT, "tools", "branching.json")))
JSCODE = BL.get("jsCode", {})

SURVEY_KEY = "RLREFHHMMWXAEPJJ"
POST_ACTION = f"https://redcap.ualberta.ca/surveys/?s={SURVEY_KEY}"

# 7-tab grouping for the web app's Chart Audit (maps each REDCap field to a tab).
TABS = [
  {"id":"patient","label":"Patient & Demographics",
   "fields":["study_number","date_of_birth","sex","weight","smoking_history","alcohol_use","substance_use_disorder","diabetes","pvd"]},
  {"id":"presentation","label":"Presentation & Assessment",
   "fields":["time_of_ed_arrival","initial_ed_name","md_assessment_time","cedis_complaint","duration_of_cold_exposure","cold_exposure_comments","minimal_temperature","maximum_temperature","freeze_thaw_cycles","freeze_thaw_cycle_comments","activities_leading_to_frostbite","other_activity_frost_bite","comments_activity_frostbite","ems_arrival","ems_temperature","interfacility_transfer","receiving_hospital_name","patient_temperature","rewarming_time","rewarmingcomments","warming_techniques","other_warming_techniques","admission","admitting_diagnosis"]},
  {"id":"grading","label":"Frostbite Grading",
   "fields":["limb_frostbite","other_frostbite_areas","right_hand_comment","left_hand_comment","right_foot_comments","left_foot_comments","frostbite_grade_change","limb_frostbite_ra","grading_change","hennepin_score"],
   "matrixGroups":["right_hand","left_hand","right_foot","left_foot"]},
  {"id":"amputation","label":"Amputation",
   "fields":["limb_amputation","additional_frostbite"],
   "matrixGroups":["digit_amputation"]},
  {"id":"medications","label":"Medications",
   "fields":["other_nsaid_dose","non_nsaid_pain","illoprost_administration","iloprost_dose","illoprost_not_given","other_reason_illoprost_not_given","illoprost_contraindication","other_illoprost_contained","illoprost_administration_time","total_doses_of_illoprost","ae_iloprost","other_ae_iloprost","alteplase","alteplase_time","alteplase_bolus","alteplase_infusion","alteplase_duration","ae_alteplase","other_reaction_alteplase","alteplase_not_given","alteplase_contraindication","alteplase_other_contraind","alteplase_not_given_other","heparin","heparin_time","heparin_dose","tetanus","systemic_antibiotics","antibiotic","aloe_vera","nsaid"],
   "matrixGroups":["nsaid"]},
  {"id":"imaging","label":"Imaging & Consults",
   # bandage_non_wound_care lives here next to wound_care_mgmt: both are the two
   # branches of wound_care_consult (mgmt when consulted, bandage when not), so the
   # whole wound-care question stays on one page. (move_after below puts it in order.)
   "fields":["imaging","xray_findings","ct_findings","mri_findings","bone_scan_findings","other_image_and_findings","surgical_consult","other_surgical_consult","wound_care_consult","wound_care_mgmt","bandage_non_wound_care"]},
  {"id":"followup","label":"Disposition & Follow-up",
   "fields":["rehab","rehab_details","insecure_housing","insecure_housing_details","ed_repeat_visits","repeat_visit_reason","admission_repeat_visits","repeat_admission_reason","return_to_function","return_to_function_comments","followup","no_followup","followup_comments"]},
]

def strip_tags(s):
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&amp;","&").replace("&lt;","<").replace("&gt;",">").replace("&nbsp;"," ").replace("&#39;","'").replace("&quot;",'"')
    return re.sub(r"\s+"," ",s).strip()

def get_label(var):
    """Human label lives in <... id='label-<var>'>...data-mlm-type="label">LABEL</div>.
    Look it up by the field's unique id so nested matrix-row tables don't hide it."""
    m = re.search(r"id=['\"]label-"+re.escape(var)+r"['\"]", HTML)
    if not m: return var
    win = HTML[m.start():m.start()+600]
    lm = re.search(r'data-mlm-type="label">(.*?)</div>', win, re.S)
    return strip_tags(lm.group(1)) if lm else var

# ---------------------------------------------------------------------------
# 1. Locate the form body and split into <tr ...> chunks (one per row start).
# ---------------------------------------------------------------------------
body_start = HTML.find("id='questiontable'")
if body_start < 0: body_start = 0
body = HTML[body_start:]
# stop at the submit row region's end to avoid trailing scripts (keep generous)
chunks = re.split(r"(?=<tr\b)", body)

# ---------------------------------------------------------------------------
# 2. Matrix header options: hdrmtxgrp tables hold the shared column options.
# ---------------------------------------------------------------------------
matrix_options = {}   # grp -> [{code,label}]
for m in re.finditer(r"hdrmtxgrp='([a-z0-9_]+)'(.*?)</table>", body, re.S):
    grp, inner = m.group(1), m.group(2)
    opts = []
    # Capture to the closing </td> (labels may contain a literal '<', e.g. "(< 90/60)").
    for om in re.finditer(r"data-mlm-type='enum'\s+data-mlm-value='([^']*)'[^>]*>(.*?)</td>", inner, re.S):
        opts.append({"code": om.group(1).strip(), "label": strip_tags(om.group(2))})
    if grp not in matrix_options:
        matrix_options[grp] = opts

def dedupe_options(opts):
    """REDCap renders each option twice (functional input + enhanced-choice layer).
    Keep the first occurrence of each code (true data-dictionary order) and number
    rc 1..n — this matches REDCap's __chk__<field>_RC_<n> indexing exactly."""
    seen=set(); out=[]
    for o in opts:
        if o["code"] in seen: continue
        seen.add(o["code"]); out.append({"code":o["code"],"label":o["label"]})
    for i,o in enumerate(out, start=1): o["rc"]=i
    return out

for g in matrix_options:
    matrix_options[g] = dedupe_options(matrix_options[g])

# ---------------------------------------------------------------------------
# 3. Walk chunks: track section header, emit a field per sq_id row.
# ---------------------------------------------------------------------------
# Capture the full option label up to </label>. REDCap renders each option twice
# (functional <label> + enhanced layer); dedupe_options keeps the first (functional)
# copy. Capturing to </label> (not [^<]+) preserves labels with a literal '<'.
ENUM = re.compile(r"data-mlm-type=['\"]enum['\"]\s+data-mlm-value=['\"]([^'\"]*)['\"][^>]*>(.*?)</label>", re.S)
fields = []
section = ""
seen = set()

for ch in chunks:
    head = ch[:400]
    # Section header row?
    if "class='header'" in head or 'class="header"' in head:
        hm = re.search(r'data-mlm-type="header">(.*?)</div>', ch, re.S)
        if hm:
            section = strip_tags(hm.group(1))
        continue
    # Field row?
    sq = re.search(r"sq_id='([a-z0-9_]+)'", head)
    ft = re.search(r"fieldtype='([a-z_]+)'", head)
    if not sq or not ft:
        continue
    var = sq.group(1)
    if var in seen:
        continue
    seen.add(var)
    ftype = ft.group(1)
    required = bool(re.search(r"\breq='1'", head))
    mtx = re.search(r"mtxgrp='([a-z0-9_]+)'", head)
    matrix = mtx.group(1) if mtx else None

    # Label (looked up by unique id so matrix-row nested tables don't hide it)
    label = get_label(var)

    # Validation + min/max (text fields)
    validation = None; vmin=None; vmax=None
    fv = re.search(r"fv='([a-z0-9_]+)'", ch)
    if fv: validation = fv.group(1)
    rv = re.search(r"redcap_validate\(this,'([^']*)','([^']*)','[^']*','([a-z0-9_]*)'", ch)
    if rv:
        vmin = rv.group(1) or None; vmax = rv.group(2) or None
        if not validation and rv.group(3): validation = rv.group(3)

    # Options
    options = []
    if matrix and matrix in matrix_options and ftype in ("radio","checkbox"):
        options = [dict(o) for o in matrix_options[matrix]]
    elif ftype in ("radio","checkbox","yesno"):
        raw=[{"code":om.group(1).strip(),"label":strip_tags(om.group(2))} for om in ENUM.finditer(ch)]
        options = dedupe_options(raw)
        if ftype=="yesno" and not options:
            options=[{"code":"1","label":"Yes","rc":1},{"code":"0","label":"No","rc":2}]

    fields.append({
        "var":var,"section":section,"label":label,"type":ftype,
        "validation":validation,"min":vmin,"max":vmax,"required":required,
        "matrix":matrix,"options":options,
    })

# ---------------------------------------------------------------------------
# 4. Transpile REDCap jsCode branching expressions into safe rule trees.
#    Leaves:
#      checked : checkbox option (field,rc) checked == want(0/1)
#      eq/ne   : document.form.<field>.value (==|!=) '<value>'
#      nonempty: <field>.value != ''
# ---------------------------------------------------------------------------
LEAF_CHK = re.compile(r"document\.forms\['form'\]\.elements\['__chk__([a-z0-9_]+)_RC_(\d+)'\]\.value\s*==\s*''\s*\?\s*0\s*:\s*1\s*\)\s*\)\s*==\s*'([01])'")
LEAF_CMP = re.compile(r"document\.(?:form\.([a-z0-9_]+)|forms\['form'\]\.elements\['([a-z0-9_]+)'\])\.value\s*(==|!=)\s*'([^']*)'")

def transpile(js):
    """Return (tree, leftover) where tree is a nested dict, leftover '' if fully parsed."""
    s = js.strip()
    s = re.sub(r"^return\s*", "", s)
    s = s.rstrip(";").strip()
    leaves = []
    def grab_chk(m):
        leaves.append({"type":"checked","field":m.group(1),"code":m.group(2),"want":int(m.group(3))})
        return f" \x00{len(leaves)-1}\x00 "
    def grab_cmp(m):
        field = m.group(1) or m.group(2)
        val = m.group(4)
        op = "eq" if m.group(3)=="==" else "ne"
        if val=="" and op=="ne":
            leaves.append({"type":"nonempty","field":field})
        else:
            leaves.append({"type":op,"field":field,"value":val})
        return f" \x00{len(leaves)-1}\x00 "
    s = LEAF_CHK.sub(grab_chk, s)
    s = LEAF_CMP.sub(grab_cmp, s)
    # Now s should contain only placeholders, parens, &&, ||, whitespace.
    leftover = re.sub(r"[\x00\d\s()|&]", "", s)
    # Tokenize
    toks = re.findall(r"\x00\d+\x00|&&|\|\||\(|\)", s)
    toks = [t for t in toks]
    pos = [0]
    def peek(): return toks[pos[0]] if pos[0] < len(toks) else None
    def nxt(): pos[0]+=1; return toks[pos[0]-1]
    def parse_or():
        node = parse_and()
        while peek()=="||":
            nxt(); rhs=parse_and(); node={"op":"or","a":node,"b":rhs}
        return node
    def parse_and():
        node = parse_atom()
        while peek()=="&&":
            nxt(); rhs=parse_atom(); node={"op":"and","a":node,"b":rhs}
        return node
    def parse_atom():
        t=peek()
        if t=="(":
            nxt(); node=parse_or()
            if peek()==")": nxt()
            return node
        if t and t.startswith("\x00"):
            nxt(); return {"leaf":leaves[int(t.strip("\x00"))]}
        return None
    tree = parse_or() if toks else None
    return tree, leftover, leaves

branch = {}
transpile_problems = []
for var, js in JSCODE.items():
    tree, leftover, leaves = transpile(js)
    if leftover or tree is None or not leaves:
        transpile_problems.append({"var":var,"js":js,"leftover":leftover})
    branch[var] = {"tree":tree, "raw":js}

# attach branch to fields
for f in fields:
    if f["var"] in branch:
        f["branch"] = branch[f["var"]]["tree"]
        f["branch_raw"] = branch[f["var"]]["raw"]
    else:
        f["branch"] = None

# ---------------------------------------------------------------------------
# 5. Assign tab per field (explicit map, else inherit the previous field's tab)
# ---------------------------------------------------------------------------
field2tab = {}; mtx2tab = {}
for t in TABS:
    for fn in t["fields"]: field2tab[fn]=t["id"]
    for g in t.get("matrixGroups",[]): mtx2tab[g]=t["id"]
last = TABS[0]["id"]
for f in fields:
    tid = (mtx2tab.get(f["matrix"]) if f["matrix"] else None) or field2tab.get(f["var"]) or last
    last = tid
    f["tab"] = tid

# Section overrides (helper-only regrouping; REDCap field mapping is unchanged).
#   - Group the rewarming techniques with the rewarming questions on Presentation.
#   - Collapse the four per-limb grading cards into one "Frostbite grading" chart
#     (limbs picker + each limb's table + its comment), leaving the separate
#     "Change in initial frostbite assessment" card untouched.
# Applied before section-owner blanking so ownership reflects the final sections.
PRESENTATION_SECTION = "Frost bite presentation and assessment"
GRADING_SECTION = "Frostbite grading"
LIMB_MATRICES = {"right_hand", "left_hand", "right_foot", "left_foot"}
GRADING_EXTRA = {"limb_frostbite", "other_frostbite_areas",
                 "right_hand_comment", "left_hand_comment",
                 "right_foot_comments", "left_foot_comments"}
SECTION_OVERRIDE = {"warming_techniques": PRESENTATION_SECTION,
                    "other_warming_techniques": PRESENTATION_SECTION}
for f in fields:
    if f["var"] in SECTION_OVERRIDE:
        f["section"] = SECTION_OVERRIDE[f["var"]]
    elif f["tab"] == "grading" and (f["matrix"] in LIMB_MATRICES or f["var"] in GRADING_EXTRA):
        f["section"] = GRADING_SECTION

# A REDCap section header is "owned" by the tab where it first appears (document
# order). Blank it elsewhere so a misplaced header (e.g. "NSAID Dosing") doesn't
# bleed into unrelated tabs whose fields merely inherited it in the original survey.
section_owner = {}
for f in fields:
    if f["section"] and f["section"] not in section_owner:
        section_owner[f["section"]] = f["tab"]
for f in fields:
    if f["section"] and section_owner.get(f["section"]) != f["tab"]:
        f["section"] = ""

# Display order: the form renders fields in array (survey document) order. Keep that,
# but relocate the rewarming techniques next to the rewarming questions (they sit far
# apart in the survey). Presentation-only — changes no values, codes, or branching.
def move_after(anchor, movers):
    """Relocate `movers` (preserving their order) to immediately after `anchor`."""
    names = set(movers)
    if anchor in names: return
    have = {f["var"] for f in fields}
    if anchor not in have or not names <= have: return
    moved = [f for f in fields if f["var"] in names]
    moved.sort(key=lambda f: movers.index(f["var"]))
    rest = [f for f in fields if f["var"] not in names]
    idx = next(i for i, f in enumerate(rest) if f["var"] == anchor) + 1
    rest[idx:idx] = moved
    fields[:] = rest

move_after("rewarmingcomments", ["warming_techniques", "other_warming_techniques"])
# Keep both wound-care branches together on Imaging & Consults: bandage_non_wound_care
# (shown when wound care was NOT consulted) sits in the survey after rehab, far from
# wound_care_mgmt (shown when it WAS). Relocate it next to wound_care_mgmt so the page
# reads as one question. Presentation-only — no values, codes, or branching change.
move_after("wound_care_mgmt", ["bandage_non_wound_care"])

# Fail loudly if the survey ever changes shape in a way we don't handle, rather
# than silently shipping a broken/partial dictionary.
KNOWN_TYPES = {"text", "textarea", "radio", "checkbox", "yesno"}
_bad_types = sorted({f["type"] for f in fields} - KNOWN_TYPES)
_unmatched = sorted(set(branch) - set(f["var"] for f in fields))
if _bad_types or transpile_problems or _unmatched:
    print("FATAL: unhandled survey structure — refusing to emit dictionary.")
    print("  unknown fieldtypes :", _bad_types)
    print("  transpile problems :", len(transpile_problems), [p["var"] for p in transpile_problems[:5]])
    print("  branch vars w/o row:", _unmatched)
    sys.exit(1)

# The [instrument]_complete field — set to 2 on API import to mark the record complete.
_cm = re.search(r"name=['\"]([a-z0-9_]+_complete)['\"]", HTML)
COMPLETE_FIELD = _cm.group(1) if _cm else None

out = {
  "survey_key":SURVEY_KEY, "post_action":POST_ACTION,
  "complete_field":COMPLETE_FIELD,
  "tabs":[{"id":t["id"],"label":t["label"]} for t in TABS],
  "fields":fields,
  "matrices":matrix_options,
}
os.makedirs(os.path.join(ROOT,"site"), exist_ok=True)
json.dump(out, open(os.path.join(ROOT,"site","dictionary.json"),"w"), indent=1)
with open(os.path.join(ROOT,"site","dictionary.js"),"w") as fh:
    fh.write("/* generated by tools/parse_survey.py — do not edit */\nwindow.DICT="+json.dumps(out)+";\n")

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
from collections import Counter
tc = Counter(f["type"] for f in fields)
print("fields:", len(fields), "| required:", sum(1 for f in fields if f["required"]))
print("types:", dict(tc))
print("matrices:", {g:len(o) for g,o in matrix_options.items()})
print("branch rules attached:", sum(1 for f in fields if f["branch"]), "/ jsCode:", len(JSCODE))
print("transpile problems:", len(transpile_problems))
for p in transpile_problems[:8]:
    print("  !", p["var"], "leftover=",repr(p["leftover"]), "::", p["js"][:90])
# branch vars not matched to a field (e.g. checkbox sub-vars / matrix rows)
bf = set(branch); ff=set(f["var"] for f in fields)
print("branch vars with no field row:", sorted(bf-ff)[:20])
print("fields per tab:", dict(Counter(f["tab"] for f in fields)))
print("sample radio (sex):", json.dumps(next(f for f in fields if f["var"]=="sex"))[:300])
print("sample checkbox (limb_frostbite):", json.dumps(next((f for f in fields if f["var"]=="limb_frostbite"),{}))[:400])
