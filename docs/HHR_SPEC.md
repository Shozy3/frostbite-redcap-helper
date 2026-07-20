# Hennepin Frostbite Score — Atomic Specification

Authoritative dissection of the original REDCap survey (`s=NRLMJK7YWH9TFYXN`, saved at
`tools/survey_hhr.html`), used to recreate it faithfully in this app. Geometry parsed verbatim
from the survey's `<area coords>`; scoring uses REDCap's own equations (`site/hhr_calc.js`).

## 1. Images, maps, fields, scores

| Region | Image (orig imgur → local) | `<map>` | areas | checkbox field | score fields |
|---|---|---|---|---|---|
| Left Hand | 5Ndlgpw.jpeg → /hhr/img/lh.jpg | ule_map | 70 | `ule_p` (69 opt) | `lh_digit1..5_score`, `lmetacarpal_score`, `lh_score` |
| Right Hand | OylvY7k.jpg → /hhr/img/rh.jpg | ure_map | 69 | `ure_p` (69) | `rh_digit1..5_score`, `rmetacarpal_score`, `rh_score` |
| Left Foot | 2ggo5wU.jpg → /hhr/img/lf.jpg | lle_map | 51 | `lle_p` (51) | `lf_digit1..5_score`, `lmetatarsal_score`, `lf_score` |
| Right Foot | PKqxmf5.jpg → /hhr/img/rf.jpg | lre_map | 51 | `lre_p` (51) | `rf_digit1..5_score`, `rmetatarsal_score`, `rf_score` |
| Proximal | VruDqhG.jpg → /hhr/img/proximal.jpg | proximal_map | 32 | `proximal_p` (32) | `proximal_ule/ure/lle/lre_score`, `proximal_score` |

All images are 720×540. The polygon `data-key` = the checkbox option code; the `alt`/`title` =
the anatomical label (shown on hover). `ule_map` has one benign duplicate key (69) drawn as two polygons.

## 2. Scoring model (max values, all-in-scope selected)

Each checked segment adds a fixed weight; the sum is **rounded independently per field**, so individual
scores are intentionally **non-additive** (a digit score need not sum to its limb score at partial selections).

| Scope | Max | Notes |
|---|---|---|
| **Total Body Perfusion Score** | **200** | whole body frostbitten |
| Each hand (`lh_score`/`rh_score`) | 15 | digit max 2, metacarpals max 5 |
| Each foot (`lf_score`/`rf_score`) | 15 | digit max 1, metatarsals max 10 |
| Proximal total (`proximal_score`) | 140 | each limb (arm/leg) max 35 |

## 3. Segment inventory (every clickable section, grouped by the score it feeds)

### Left Hand — `ule_p` (70 polygons)
- **Left hand digit 1** `lh_digit1_score` (max 2): LIP11(1), LIP12(2), LIP13(3), LIP14(4), MCP11(5), MCP12(6), MCP13(7), MCP14(8)
- **Left hand digit 2** `lh_digit2_score` (max 2): LDIP21(13), LDIP22(14), LDIP23(15), LPIP21(16), LPIP22(17), LPIP23(18), LMCP21(19), LMCP22(20), LMCP23(21), LMCP24(22)
- **Left hand digit 3** `lh_digit3_score` (max 2): LDIP31(27), LDIP32(28), LDIP33(29), LPIP31(30), LPIP32(31), LPIP33(32), LMCP31(33), LMCP32(34), LMCP33(35), LMCP34(36)
- **Left hand digit 4** `lh_digit4_score` (max 2): LDIP41(41), LDIP42(42), LDIP43(43), LPIP41(44), LPIP42(45), LPIP43(46), LMCP41(47), LMCP42(48), LMCP43(49), LMCP44(50)
- **Left hand digit 5** `lh_digit5_score` (max 2): LDIP51(55), LDIP52(56), LDIP53(57), LIPIP51(58), LIPIP52(59), LIPIP53(60), LMCP51(61), LMCP52(62), LMCP53(63), LMCP54(64)
- **Left hand metacarpals/carpals** `lmetacarpal_score` (max 5): LC11(9), LC12(10), LC13(11), LC14(12), LC21(23), LC22(24), LC23(25), LC24(26), LC31(37), LC32(38), LC33(39), LC34(40), LC41(51), LC42(52), LC43(53), LC44(54), LC51(65), LC52(66), LC53(67), LC54(68)
- _(not in a per-digit subscore; counts only toward limb/total)_: LW(69)

### Right Hand — `ure_p` (69 polygons)
- **Right hand digit 1** `rh_digit1_score` (max 2): RIP11(1), RIP12(2), RIP13(3), RIP14(4), RMCP11(5), RMCP12(6), RMCP13(7), RMCP14(8)
- **Right hand digit 2** `rh_digit2_score` (max 2): RDIP21(13), RDIP22(14), RDIP23(15), RPIP21(16), RPIP22(17), RPIP23(18), RMCP21(19), RMCP22(20), RMCP23(21), RMCP24(22)
- **Right hand digit 3** `rh_digit3_score` (max 2): RDIP31(27), RDIP32(28), RDIP33(29), RPIP31(30), RPIP32(31), RPIP33(32), RMCP31(33), RMCP32(34), RMCP33(35), RMCP34(36)
- **Right hand digit 4** `rh_digit4_score` (max 2): RDIP41(41), RDIP42(42), RDIP43(43), RPIP41(44), RPIP42(45), RPIP43(46), RMCP41(47), RMCP42(48), RMCP43(49), RMCP44(50)
- **Right hand digit 5** `rh_digit5_score` (max 2): RDIP51(55), RDIP52(56), RDIP53(57), RPIP51(58), RPIP52(59), RPIP53(60), RMCP51(61), RMCP52(62), RMCP53(63), RMCP54(64)
- **Right hand metacarpals** `rmetacarpal_score` (max 5): RC11(9), RC12(10), RC13(11), RC14(12), RC21(23), RC22(24), RC23(25), RC24(26), RC31(37), RC32(38), RC33(39), RC34(40), RC41(51), RC42(52), RC43(53), RC44(54), RC51(65), RC52(66), RC53(67), RC54(68)
- _(not in a per-digit subscore; counts only toward limb/total)_: RW(69)

### Left Foot — `lle_p` (51 polygons)
- **Left foot digit 1** `lf_digit1_score` (max 1): LIP11(1), LIP12(2), LIP13(3), LMCP11(4), LMCP12(5), LMCP13(6)
- **Left foot digit 2** `lf_digit2_score` (max 1): LDIP21(11), LDIP22(12), LPIP21(13), LPIP22(14), LMCP21(15), LMCP22(16)
- **Left foot digit 3** `lf_digit3_score` (max 1): LDIP31(21), LDIP32(22), LIPIP31(23), LPIP32(24), LMCP31(25), LMCP32(26)
- **Left foot digit 4** `lf_digit4_score` (max 1): LDIP41(31), LDIP42(32), LPIP41(33), LPIP42(34), LMCP41(35), LMCP42(36)
- **Left foot digit 5** `lf_digit5_score` (max 1): LDIP51(41), LDIP52(42), LPIP51(43), LPIP52(44), LMCP51(45), LMCP52(46)
- **Left Metatarsal Foot Score** `lmetatarsal_score` (max 10): LT11(7), LT12(8), LT13(9), LT14(10), LT21(17), LT22(18), LT23(19), LT24(20), LT31(27), LT32(28), LT33(29), LT34(30), LT41(37), LT42(38), LT43(39), LT44(40), LT51(47), LT52(48), LT53(49), LT54(50), LH(51)

### Right Foot — `lre_p` (51 polygons)
- **Right foot digit 1** `rf_digit1_score` (max 1): RIP11(1), RIP12(2), RIP13(3), RMCP11(4), RMCP12(5), RMCP13(6)
- **Right foot digit 2** `rf_digit2_score` (max 1): RDIP21(11), RDIP22(12), RPIP21(13), RPIP22(14), RMCP21(15), RMCP22(16)
- **Right foot digit 3** `rf_digit3_score` (max 1): RDIP31(21), RDIP32(22), RPIP31(23), RPIP32(24), RMCP31(25), RMCP32(26)
- **Right foot digit 4** `rf_digit4_score` (max 1): RDIP41(31), RDIP42(32), RPIP41(33), RPIP42(34), RMCP41(35), RMCP42(36)
- **Right foot digit 5** `rf_digit5_score` (max 1): RDIP51(41), RDIP52(42), RPIP51(43), RPIP52(44), RMCP51(45), RMCP52(46)
- **Right Metatarsal Foot Score** `rmetatarsal_score` (max 10): RT11(7), RT12(8), RT13(9), RT14(10), RT21(17), RT22(18), RT23(19), RT24(20), RT31(27), RT32(28), RT33(29), RT34(30), RT41(37), RT42(38), RT43(39), RT44(40), RT51(47), RT52(48), RT53(49), RT54(50), RH(51)

### Proximal Extremity — `proximal_p` (32 polygons)
- **Left Arm Proximal Score** `proximal_ule_score` (max 35): LS1(1), LS2(2), LE1(3), LE2(4), LW1(5), LW2(6), LW3(7), LW4(8)
- **Right Arm Proximal Score** `proximal_ure_score` (max 35): RS1(17), RS2(18), RE1(19), RE2(20), RW1(21), RW2(22), RW3(23), RW4(24)
- **Left Leg Proximal Score** `proximal_lle_score` (max 35): LH1(9), LH2(10), LT1(11), LT2(12), LK1(13), LK2(14), LA1(15), LA2(16)
- **Right Leg Proximal Score** `proximal_lre_score` (max 35): RH1(25), RH12(26), RT1(27), RT2(28), RK1(29), RK2(30), RA1(31), RA2(32)

## 4. Verification
- `tools/test_hhr_calc.js`: baked equations == REDCap literal jsCode, **0 mismatches** over thousands of states.
- `tools/test_hhr_ui.js`: 26/26 — polygon counts match maps; region gating (incl. proximal→all five); click→state→equation→per-digit display; polygon↔list sync; payload `ule_p___<code>=1`; Clear; no regression to the other form.
- `tools/test_ui.js`: both forms render; gate; branching; payload; HHR diagrams + live total == REDCap calc.
- Visual overlay (polygons drawn on the real images) confirms each polygon traces the correct anatomical division.

## 5. Notes / faithful quirks (verified against the original)
- **Region gating:** each limb figure reveals when its own injury code OR "Proximal extremity" (code 5) is selected; the proximal figure reveals on 5 only — mirrors the survey branch logic exactly (`ule_figurep`=1∨5, `ure`=2∨5, `lle`=3∨5, `lre`=4∨5, `proximal`=5).
- **Body parts** in the injury selector (ears, nose, face, kneecaps, buttock) are **recorded but not scored** — the original defines no score fields/sub-segments for them.
- **Wrist/heel segments** (e.g. `LW`, `RW`, `LH`) are clickable and recorded but contribute **0** to every score — faithful to REDCap, whose equations exclude them. Documented, not a bug.
- **Wrist/heel still reach the Chart Audit grading auto-fill:** although they score 0 (previous bullet), the Frostbite-grading auto-fill detects `LW`/`RW`/`LH`/`RH` by label (not by score) and still ticks option 6 ("Wrist or more proximal") in that limb's Grade 4 row whenever one is painted alongside a scoreable section.
- **Non-additive scores:** each field is rounded independently, so a digit score need not sum to its limb/total. The UI states this and never implies they add up.
- **"A A A" font-size control:** reproduced in the calculator's app bar (3 steps, scales root text size); live score updates announce via `aria-live`.
- **Provenance:** the five figures are the original imgur images downloaded locally (720×540, 4:3); coords are in that native space. A re-download must preserve 720×540 (or 4:3) or the SVG overlay misaligns.
