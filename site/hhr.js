/*
 * Hennepin Frostbite Score CALCULATOR tab — pixel-faithful recreation.
 *
 * The original REDCap survey draws five anatomical figures (left/right hand,
 * left/right foot, full-body proximal) and overlays an HTML <map> of clickable
 * polygons on each. Clicking a polygon toggles one option of that limb's
 * checkbox field (ule_p/ure_p/lle_p/lre_p/proximal_p); the Hennepin score is
 * recomputed live from those checkboxes.
 *
 * Three internal sub-tabs (modeled on the Iloprost view-switch):
 *   - Frostbite Score — the perfusion map ("tissue at risk"), unchanged.
 *   - Amputation      — a SECOND, parallel selection layer on the SAME diagrams
 *                       (same click/drag painting) in a colour-blind-safe
 *                       vermillion, recording amputated sections ("tissue lost").
 *                       It has its OWN Hennepin score and NEVER changes the
 *                       frostbite score (computeScore reads only state.checked).
 *   - Compare         — read-only injury map vs amputation map side-by-side, with
 *                       the literature salvage rates (digit & phalanx, count-based
 *                       per Heard et al. 2023 systematic review; plus the
 *                       Hennepin score-based TSR using this app's own equations).
 *
 * No data leaves the browser; the calculator feeds the main Chart Audit via the
 * window.FBMAIN bridge, and both layers persist through get/setState.
 */
(function () {
  'use strict';
  var DICT = window.DICT_HHR, CALC = window.HHR_CALC, FB = window.FB, MAPS = window.HHR_MAPS;
  if (!DICT || !CALC || !FB || !MAPS) return;

  var SVGNS = 'http://www.w3.org/2000/svg';
  var INJURY = 'extremity_perfusion_hfs';   // Q2 region selector
  var ASSESS = 'assessment_hfs';            // Q1 assessment-basis checklist

  var HAND_DIGITS = ['Digit 1 (thumb)', 'Digit 2 (index)', 'Digit 3 (middle)', 'Digit 4 (ring)', 'Digit 5 (little / pinky side)'];
  var FOOT_DIGITS = ['Digit 1 (great toe)', 'Digit 2', 'Digit 3', 'Digit 4', 'Digit 5 (little toe / pinky side)'];

  // The single source of truth tying together: injury-selector code -> diagram
  // region (HHR_MAPS key + backing checkbox field) -> per-digit score rows.
  function digitRows(prefix, names) {
    return names.map(function (nm, i) { return { var: prefix + '_digit' + (i + 1) + '_score', label: 'Digit ' + (i + 1) }; });
  }
  var REGIONS = [
    { key: 'lh', field: 'ule_p', inj: '1', label: 'Left Hand', upload: 'ule_perfusion_image', amp: 'left_hand_amp',
      total: 'lh_score', rows: digitRows('lh', HAND_DIGITS).concat([{ var: 'lmetacarpal_score', label: 'Metacarpals / carpals' }]) },
    { key: 'rh', field: 'ure_p', inj: '2', label: 'Right Hand', upload: 'ure_perfusion_image', amp: 'right_hand_amp',
      total: 'rh_score', rows: digitRows('rh', HAND_DIGITS).concat([{ var: 'rmetacarpal_score', label: 'Metacarpals / carpals' }]) },
    { key: 'lf', field: 'lle_p', inj: '3', label: 'Left Foot', upload: 'lle_perfusion_image', amp: 'left_foot_amp',
      total: 'lf_score', rows: digitRows('lf', FOOT_DIGITS).concat([{ var: 'lmetatarsal_score', label: 'Metatarsals / tarsals' }]) },
    { key: 'rf', field: 'lre_p', inj: '4', label: 'Right Foot', upload: 'lre_perfusion_image', amp: 'right_foot_amp',
      total: 'rf_score', rows: digitRows('rf', FOOT_DIGITS).concat([{ var: 'rmetatarsal_score', label: 'Metatarsals / tarsals' }]) },
    { key: 'proximal', field: 'proximal_p', inj: '5', label: 'Proximal Extremity', upload: null, amp: null,
      total: 'proximal_score', rows: [
        { var: 'proximal_ule_score', label: 'Left arm' }, { var: 'proximal_ure_score', label: 'Right arm' },
        { var: 'proximal_lle_score', label: 'Left leg' }, { var: 'proximal_lre_score', label: 'Right leg' }] }
  ];
  var REGION_BY_FIELD = {}; REGIONS.forEach(function (r) { REGION_BY_FIELD[r.field] = r; });
  // Perfusion field -> Chart Audit "Limbs affected by frostbite" (limb_frostbite) code,
  // so "Use score" also ticks the affected limbs there (1=R upper,2=L upper,3=R lower,4=L lower).
  var FROSTBITE_LIMB = { ule_p: '2', ure_p: '1', lle_p: '4', lre_p: '3' };
  // Perfusion field -> Chart Audit per-limb frostbite GRADE matrix prefix. The Cauchy
  // grade (2/3/4) is auto-derived PER DIGIT from the painted anatomy on "Use score"
  // (autoGradesFor, below — Cauchy's classification is topographic: distal phalanx only
  // -> grade 2, any middle/proximal phalanx -> grade 3, that digit's carpal/tarsal ray
  // (or any bare wrist/heel section, limb-wide) -> grade 4 plus option 6 "Wrist or more
  // proximal"). grades[field], set by the per-limb picker below, is an OPTIONAL override:
  // when set, "Use score" instead routes ALL of that limb's currently-active codes into
  // the one chosen row (re-pressing the active button clears the override back to auto).
  var GRADE_PREFIX = { ule_p: 'left_hand', ure_p: 'right_hand', lle_p: 'left_foot', lre_p: 'right_foot' };
  var grades = {};   // field -> "2" | "3" | "4" | ""  (manual per-limb grade OVERRIDE; "" = auto)

  var byVar = {}; DICT.fields.forEach(function (f) { byVar[f.var] = f; });
  // state.checked = frostbite/perfusion (drives the Hennepin score). state.ampChecked
  // = the parallel amputation layer (same field/code namespace; its own score).
  var state = { checked: {}, ampChecked: {}, values: {}, _visible: {} };
  var built = false, dirty = false, curView = 'score';
  // Optional "Amputation" panel: type of amputation + free comments.
  var amp = { on: false, type: '', other: '', comments: '', includeHhr: true };
  var scoreEls = {};            // scoreVar -> [nodes]  (frostbite/perfusion)
  var ampScoreEls = {};         // scoreVar -> [nodes]  (amputation layer)
  var segNodes = { perf: {}, amp: {} };    // layer -> field -> { code -> {polys, inputs} }
  var diagramWrap = { perf: {}, amp: {} }; // layer -> region.key -> figure element
  var countNode = { perf: {}, amp: {} };   // layer -> region.key -> count badge
  var regionGroup = {};         // region.key -> perfusion score group element

  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; }
  function svg(t, attrs) { var n = document.createElementNS(SVGNS, t); if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function $(id) { return document.getElementById(id); }
  function segsFor(layer) { return segNodes[layer === 'amp' ? 'amp' : 'perf']; }
  function checkedSet(field, layer) { var s = (layer === 'amp') ? state.ampChecked : state.checked; return s[field] || (s[field] = new Set()); }
  function addScore(v, node) { (scoreEls[v] || (scoreEls[v] = [])).push(node); }
  function addAmpScore(v, node) { (ampScoreEls[v] || (ampScoreEls[v] = [])).push(node); }

  // Whole-digit + phalanx grouping per limb field, derived from the score equations
  // (the same source the score uses, like tools/test_hhr_ui.js) — no new data file.
  // Powers the literature salvage rates and the amputation digit summary for REDCap.
  var DIGIT_OF = {};    // field -> { optionCode -> "1".."6" }   (6 = proximal/metacarpal-tarsal)
  var PHALANX_OF = {};  // field -> { optionCode -> "distal"|"middle"|"proximal" }
  // Ray-specific carpal/tarsal + bare wrist/heel maps, read straight off the area LABEL
  // (not off DIGIT_OF/the score equations): the score lumps every ray's carpal/tarsal
  // sections into one shared metacarpal/metatarsal total (DIGIT_OF collapses them all to
  // "6"), but the labels are still ray-specific (e.g. "LC21" = carpal under digit 2), and
  // the wrist ("LW") has no score equation — and so no DIGIT_OF entry — at all. Powers
  // autoGradesFor's Cauchy grade 4 / option-6 detection below.
  var RAY_OF = {};        // field -> { optionCode -> "1".."5" }  (that carpal/tarsal section's digit)
  var WRISTHEEL_OF = {};  // field -> { optionCode -> true }      (bare wrist or heel section)
  function phalanxPos(label) {
    if (!label) return null;
    var j = (String(label).replace(/^[LR]/, '').match(/^([A-Z]+)/) || [])[1] || '';
    if (j === 'DIP') return 'distal'; if (j === 'PIP' || j === 'IPIP') return 'middle';
    if (j === 'IP') return 'distal'; if (j === 'MCP') return 'proximal'; return null;
  }
  function buildDigitMaps() {
    REGIONS.forEach(function (r) {
      // Proximal extremity has no per-digit amputation field, AND its area labels (e.g.
      // "LH1", "RH12" — proximal hip sections) would false-match the bare wrist/heel
      // pattern below ("LH"/"RH" exactly) if ever scanned; skipping this region is what
      // keeps that pattern safe, not just an optimization.
      if (r.key === 'proximal') return;
      var f = r.field, dmap = {}, pmap = {}, rmap = {}, whmap = {}, re, m, src;
      for (var n = 1; n <= 5; n++) {
        var fn = CALC[r.key + '_digit' + n + '_score']; if (!fn) continue;
        re = new RegExp(f + '_RC_(\\d+)', 'g'); src = fn.toString();
        while ((m = re.exec(src))) dmap[m[1]] = String(n);
      }
      var mfn = CALC[r.rows[r.rows.length - 1].var];     // metacarpal/metatarsal -> "6"
      if (mfn) { re = new RegExp(f + '_RC_(\\d+)', 'g'); src = mfn.toString(); while ((m = re.exec(src))) dmap[m[1]] = '6'; }
      (MAPS[r.key].areas || []).forEach(function (a) {
        var code = String(a.key); if (dmap[code] && dmap[code] !== '6') { var p = phalanxPos(a.code); if (p) pmap[code] = p; }
        // Independent of dmap above (the wrist has no dmap entry at all): strip one
        // leading L/R, then a carpal/tarsal ray label is C/T + that digit's number
        // ("C21" -> ray 2), and a bare wrist/heel label is just "W" or "H" with nothing
        // else left ("MCP11" etc keep their full "MCP.." string here, so never match).
        var stripped = String(a.code || '').replace(/^[LR]/, ''), rm = stripped.match(/^[CT](\d)/);
        if (rm) rmap[code] = rm[1]; else if (/^[WH]$/.test(stripped)) whmap[code] = true;
      });
      DIGIT_OF[f] = dmap; PHALANX_OF[f] = pmap; RAY_OF[f] = rmap; WRISTHEEL_OF[f] = whmap;
    });
  }

  // A region's figure is revealed when its own injury code is selected OR when
  // "Proximal extremity" (code 5) is — mirroring the original survey's branching.
  function regionRevealed(r) { var s = checkedSet(INJURY); return s.has(r.inj) || (r.key !== 'proximal' && s.has('5')); }
  var FONT_STEPS = [['Smaller text', '92%'], ['Default text size', '100%'], ['Larger text', '115%']];
  var fontBtns = [];
  function setFont(i) { document.documentElement.style.fontSize = FONT_STEPS[i][1]; fontBtns.forEach(function (b, j) { b.classList.toggle('active', j === i); b.setAttribute('aria-pressed', j === i ? 'true' : 'false'); }); }

  // Click-and-drag "painting": press a section and drag across others to select
  // them in one stroke. Layer-aware (perfusion by default, amputation when bound
  // to the amp overlay) — see paint.layer.
  var paint = { active: false, on: false, overlay: null, field: null, layer: null, moved: false, startCode: null, last: null };
  var pointerSeq = false, pointerTimer = null, rafPending = false;
  function scheduleRefresh() {
    if (rafPending) return; rafPending = true;
    (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { rafPending = false; refresh(); });
  }
  function setPaint(field, code, on, layer) {
    var set = checkedSet(field, layer); if (on === set.has(code)) return;
    if (on) set.add(code); else set.delete(code);
    dirty = true; updateSegVisuals(field, code, layer); scheduleRefresh();
  }
  function paintMove(e) {
    if (!paint.active) return;
    var hit = document.elementFromPoint(e.clientX, e.clientY);
    var poly = hit && hit.closest && hit.closest('polygon.hhr-seg');
    if (!poly || !paint.overlay.contains(poly)) return;
    if (!paint.moved) { paint.moved = true; setPaint(paint.field, paint.startCode, paint.on, paint.layer); }
    var code = poly.dataset.code; if (code === paint.last) return;
    paint.last = code; setPaint(paint.field, code, paint.on, paint.layer);
  }
  function paintEnd() {
    if (!paint.active) return;
    var moved = paint.moved, field = paint.field, layer = paint.layer, startCode = paint.startCode, on = paint.on;
    paint.active = false; paint.overlay = null; paint.field = null; paint.layer = null; paint.startCode = null; paint.last = null; paint.moved = false;
    if (!moved) setPaint(field, startCode, on, layer);
    refresh();
    if (pointerTimer) clearTimeout(pointerTimer);
    pointerTimer = setTimeout(function () { pointerSeq = false; }, 350);
  }
  function bindPaint(overlay, field, layer) {
    overlay.addEventListener('pointerdown', function (e) {
      var poly = e.target.closest && e.target.closest('polygon.hhr-seg');
      if (!poly || (e.button != null && e.button > 0)) return;
      e.preventDefault(); pointerSeq = true;
      paint.active = true; paint.overlay = overlay; paint.field = field; paint.layer = layer; paint.moved = false;
      paint.startCode = poly.dataset.code; paint.last = null;
      paint.on = !checkedSet(field, layer).has(poly.dataset.code);
    });
    overlay.addEventListener('pointermove', paintMove);
    overlay.addEventListener('click', function (e) {
      var poly = e.target.closest && e.target.closest('polygon.hhr-seg');
      if (poly && !pointerSeq) toggleSeg(field, poly.dataset.code, layer);
    });
  }

  /* ---------------------------------------------------------------- build */
  function build() {
    if (built) return; built = true;
    buildDigitMaps();
    var root = $('app-hhr');

    // App bar with always-visible live total (switches between the two layers' scores).
    var bar = el('header', 'appbar');
    var main = el('div', 'appbar-main');
    main.appendChild(el('h1', 'appbar-title', 'Hennepin Frostbite Score'));
    main.appendChild(el('div', 'appbar-sub', 'Calculator — scored exactly as the original form'));
    bar.appendChild(main);
    var fontCtl = el('div', 'hhr-fontsize'); fontCtl.setAttribute('role', 'group'); fontCtl.setAttribute('aria-label', 'Text size');
    FONT_STEPS.forEach(function (spec, i) {
      var b = el('button', 'hhr-fontsize-btn' + (i === 1 ? ' active' : '')); b.type = 'button'; b.textContent = 'A';
      b.style.fontSize = (0.8 + i * 0.2) + 'em'; b.setAttribute('aria-label', spec[0]); b.setAttribute('aria-pressed', i === 1 ? 'true' : 'false');
      b.addEventListener('click', function () { setFont(i); }); fontBtns.push(b); fontCtl.appendChild(b);
    });
    bar.appendChild(fontCtl);
    var live = el('div', 'hhr-livetotal'); live.id = 'hhr-livetotal'; live.title = 'Live score for the active tab';
    live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
    var liveLab = el('span', 'hhr-livetotal-label', 'Score'); liveLab.id = 'hhr-live-label'; live.appendChild(liveLab);
    var liveVal = el('span', 'hhr-livetotal-val', '0'); liveVal.id = 'hhr-live-val'; live.appendChild(liveVal);
    bar.appendChild(live);
    root.appendChild(bar);

    // Sub-tab bar (Frostbite Score | Amputation | Compare), modeled on ilop-viewswitch.
    var nav = el('nav', 'hhr-viewswitch'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', 'Hennepin view');
    nav.appendChild(viewBtn('score', 'Frostbite Score', true));
    nav.appendChild(viewBtn('amp', 'Amputation', false, true));
    nav.appendChild(viewBtn('compare', 'Compare', false));
    nav.addEventListener('keydown', onHhrTabKey);
    root.appendChild(nav);

    var panels = el('main', 'panels'); root.appendChild(panels);

    /* ---- View 1: Frostbite Score (perfusion) ---- */
    var scoreView = el('section', 'panel'); scoreView.id = 'hhr-view-score'; panels.appendChild(scoreView);
    if (DICT.citation) { var introG = el('div', 'section-group'); introG.appendChild(el('p', 'hhr-intro', DICT.citation)); scoreView.appendChild(introG); }
    var qa = el('div', 'section-group');
    qa.appendChild(renderChecklist(ASSESS, byVar[ASSESS] && byVar[ASSESS].label || 'What was this assessment based on?'));
    scoreView.appendChild(qa);
    var qi = el('div', 'section-group');
    qi.appendChild(renderChecklist(INJURY, byVar[INJURY] && byVar[INJURY].label || 'Frostbite Injury'));
    qi.appendChild(el('p', 'hint', 'Select each affected region to reveal its diagram below, then mark every distal section involved — click a section, or press and drag across several at once (drag back over selected sections to clear them). Select each distal section affected, not just the most proximal area, for the score to be correct.'));
    scoreView.appendChild(qi);
    var dxG = el('div', 'section-group hhr-dx-group');
    dxG.appendChild(el('h2', 'section', 'Affected sections'));
    var dxHint = el('p', 'hint hhr-dx-empty'); dxHint.id = 'hhr-dx-empty';
    dxHint.textContent = 'No region selected yet — choose one or more regions under “Frostbite Injury” to show its clickable diagram.';
    dxG.appendChild(dxHint);
    REGIONS.forEach(function (r) { dxG.appendChild(renderDiagram(r, 'perf')); });
    scoreView.appendChild(dxG);
    scoreView.appendChild(renderScorebox());

    /* ---- View 2: Amputation (parallel layer, vermillion) ---- */
    var ampView = el('section', 'panel hhr-amp-layer'); ampView.id = 'hhr-view-amp'; ampView.hidden = true; panels.appendChild(ampView);
    var banner = el('div', 'hhr-amp-banner');
    banner.appendChild(el('span', 'hhr-amp-banner-bar', '▌'));
    var bt = el('div'); bt.innerHTML = '<b>Amputation</b> — mark the amputated sections the same way as the frostbite map (click a section, or drag across several), in <b>vermillion</b>. It has its own Hennepin score below and <b>never changes the frostbite score</b>.';
    banner.appendChild(bt); ampView.appendChild(banner);
    ampView.appendChild(renderAmpScorebox());
    var adxG = el('div', 'section-group hhr-dx-group');
    adxG.appendChild(el('h2', 'section amp', 'Amputated sections'));
    var adxHint = el('p', 'hint hhr-dx-empty'); adxHint.id = 'hhr-amp-empty';
    adxHint.textContent = 'Choose the affected regions under “Frostbite Injury” (Frostbite Score tab) first — the same diagrams appear here for marking amputations.';
    adxG.appendChild(adxHint);
    REGIONS.forEach(function (r) { adxG.appendChild(renderDiagram(r, 'amp')); });
    var sumWrap = el('div', 'hhr-amp-summary-wrap');
    sumWrap.appendChild(el('span', 'hhr-amp-summary-lab', 'Amputated digits (sent to REDCap): '));
    var sum = el('span', 'hhr-amp-summary'); sum.id = 'hhr-amp-summary'; sumWrap.appendChild(sum);
    adxG.appendChild(sumWrap);
    ampView.appendChild(adxG);
    ampView.appendChild(renderAmpPanel());

    /* ---- View 3: Compare (salvage) ---- */
    var cmpView = el('section', 'panel'); cmpView.id = 'hhr-view-compare'; cmpView.hidden = true; panels.appendChild(cmpView);
    cmpView.appendChild(el('h2', 'section amp', 'Compare — tissue at risk vs tissue lost (salvage)'));
    cmpView.appendChild(buildSalvageBlock());
    var cmpTools = el('div', 'hhr-cmp-tools');
    var bSide = el('button', 'btn btn-sm active', 'Side-by-side'); bSide.id = 'hhr-cmp-side-btn'; bSide.type = 'button'; bSide.addEventListener('click', function () { setCmpMode('side'); });
    var bOver = el('button', 'btn btn-sm', 'Overlay'); bOver.id = 'hhr-cmp-over-btn'; bOver.type = 'button'; bOver.addEventListener('click', function () { setCmpMode('over'); });
    cmpTools.appendChild(bSide); cmpTools.appendChild(bOver);
    cmpTools.appendChild(buildCmpLegend());
    cmpView.appendChild(cmpTools);
    var cmpEmpty = el('p', 'hint'); cmpEmpty.id = 'hhr-cmp-empty'; cmpEmpty.textContent = 'Nothing to compare yet — mark frostbite and/or amputation sections first.';
    cmpView.appendChild(cmpEmpty);
    var sideWrap = el('div'); sideWrap.id = 'hhr-cmp-side';
    var cols = el('div', 'hhr-cmp-cols');
    var colP = el('div'); colP.appendChild(elLbl('TISSUE AT RISK — frostbite', 'var(--primary-d)')); var gp = el('div', 'hhr-dx-grid'); gp.id = 'hhr-cmp-perf'; colP.appendChild(gp);
    var colA = el('div'); colA.appendChild(elLbl('TISSUE LOST — amputation', 'var(--amp-d)')); var ga = el('div', 'hhr-dx-grid'); ga.id = 'hhr-cmp-amp'; colA.appendChild(ga);
    cols.appendChild(colP); cols.appendChild(colA); sideWrap.appendChild(cols); cmpView.appendChild(sideWrap);
    var overWrap = el('div'); overWrap.id = 'hhr-cmp-over'; overWrap.hidden = true;
    var go = el('div', 'hhr-dx-grid'); go.id = 'hhr-cmp-overgrid'; overWrap.appendChild(go);
    overWrap.appendChild(el('p', 'hint', 'Overlay registers both layers on one figure; a section that is both frostbitten and amputated gets the hatch fill and a blue dashed outline.'));
    cmpView.appendChild(overWrap);

    // Action bar — Clear all + write the computed total into the main Chart Audit form.
    var ab = el('div', 'actionbar');
    var clearAll = el('button', 'btn btn-ghost btn-sm'); clearAll.type = 'button'; clearAll.textContent = 'Clear all';
    clearAll.addEventListener('click', resetAll); ab.appendChild(clearAll);
    ab.appendChild(el('span', 'actionbar-spacer'));
    var status = el('span', 'submit-status'); status.id = 'hhr-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    ab.appendChild(status);
    var btn = el('button', 'btn btn-primary'); btn.id = 'hhr-use'; btn.type = 'button';
    btn.textContent = 'Use score in Chart Audit →'; ab.appendChild(btn);
    root.appendChild(ab);

    btn.addEventListener('click', useScore);
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('pointerup', paintEnd);
    window.addEventListener('pointercancel', paintEnd);

    setHhrView('score');
    refresh();
  }

  function elLbl(text, color) { var s = el('h3', 'hhr-cmp-collbl'); s.textContent = text; s.style.color = color; return s; }

  /* ----------------------------------------------------- sub-tab switching */
  function viewBtn(key, label, active, withBadge) {
    var b = el('button', 'hhr-vbtn' + (key === 'amp' ? ' amp' : '') + (active ? ' active' : ''), label);
    b.type = 'button'; b.id = 'hhr-v-' + key; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', active ? 'true' : 'false'); b.tabIndex = active ? 0 : -1;
    if (withBadge) { var bd = el('span', 'hhr-vbadge'); bd.id = 'hhr-amp-badge'; bd.hidden = true; b.appendChild(bd); }
    b.addEventListener('click', function () { setHhrView(key); });
    return b;
  }
  function setHhrView(v) {
    curView = v;
    ['score', 'amp', 'compare'].forEach(function (k) {
      var view = $('hhr-view-' + k); if (view) view.hidden = (k !== v);
      var b = $('hhr-v-' + k); if (b) { var on = k === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
    });
    if (v === 'compare') renderCompare();
    updatePill();
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) {}
  }
  function onHhrTabKey(e) {
    var order = ['score', 'amp', 'compare'], i = order.indexOf(curView), n = order.length, j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % n; else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = n - 1; else return;
    e.preventDefault(); setHhrView(order[j]); var b = $('hhr-v-' + order[j]); if (b) b.focus();
  }

  /* ------------------------------------------------- simple checkbox field */
  function renderChecklist(fieldVar, legendText) {
    var f = byVar[fieldVar];
    var fs = el('fieldset', 'options'); fs.setAttribute('role', 'group'); fs.dataset.var = fieldVar;
    fs.appendChild(el('legend', null, legendText));
    var opts = el('div', 'opts');
    (f && f.options || []).forEach(function (o) {
      var l = el('label', 'opt'); var i = document.createElement('input');
      i.type = 'checkbox'; i.name = fieldVar; i.value = o.code;
      i.addEventListener('change', function () {
        var set = checkedSet(fieldVar);
        if (i.checked) set.add(o.code); else set.delete(o.code);
        dirty = true; refresh();
      });
      l.appendChild(i); l.appendChild(el('span', 'opt-text', o.label)); opts.appendChild(l);
    });
    fs.appendChild(opts); return fs;
  }

  /* ----------------------------------------------- clickable image diagram */
  function renderDiagram(r, layer) {
    layer = layer || 'perf';
    var m = MAPS[r.key];
    var fig = el('figure', 'hhr-dx'); fig.dataset.region = r.key; fig.dataset.layer = layer; fig.hidden = true;
    diagramWrap[layer][r.key] = fig;

    var head = el('figcaption', 'hhr-dx-head');
    head.appendChild(el('span', 'hhr-dx-title', r.label));
    var count = el('span', 'hhr-dx-count' + (layer === 'amp' ? ' amp' : '')); countNode[layer][r.key] = count; head.appendChild(count);
    var clear = el('button', 'btn btn-ghost btn-sm'); clear.type = 'button'; clear.textContent = 'Clear';
    clear.setAttribute('aria-label', 'Clear ' + r.label + (layer === 'amp' ? ' amputation' : '') + ' selections');
    clear.addEventListener('click', function () { clearField(r.field, layer); });
    head.appendChild(clear);
    fig.appendChild(head);

    var wrap = el('div', 'hhr-dx-wrap');
    var img = document.createElement('img'); img.className = 'hhr-dx-img';
    img.src = m.img; img.alt = r.label + ' diagram — click or drag across each affected section'; img.width = m.w; img.height = m.h; img.loading = 'lazy';
    wrap.appendChild(img);
    var overlay = svg('svg', { viewBox: '0 0 ' + m.w + ' ' + m.h, preserveAspectRatio: 'xMidYMid meet', class: 'hhr-dx-svg' });
    overlay.setAttribute('role', 'group'); overlay.setAttribute('aria-label', r.label + (layer === 'amp' ? ' amputation' : '') + ' sections');
    var nodemap = segsFor(layer)[r.field] || (segsFor(layer)[r.field] = {});
    m.areas.forEach(function (a) {
      var code = a.key, label = a.code;
      var pts = []; for (var i = 0; i + 1 < a.coords.length; i += 2) pts.push(a.coords[i] + ',' + a.coords[i + 1]);
      var poly = svg('polygon', { points: pts.join(' '), class: 'hhr-seg', tabindex: '0' });
      poly.setAttribute('role', 'checkbox'); poly.setAttribute('aria-checked', 'false');
      poly.setAttribute('aria-label', label); poly.dataset.code = code;
      var ttl = svg('title'); ttl.textContent = label; poly.appendChild(ttl);
      poly.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggleSeg(r.field, code, layer); }
      });
      overlay.appendChild(poly);
      (nodemap[code] || (nodemap[code] = { polys: [], inputs: [] })).polys.push(poly);
    });
    wrap.appendChild(overlay);
    bindPaint(overlay, r.field, layer);
    fig.appendChild(wrap);

    // Frostbite (Cauchy) grade picker, right on the limb the clinician just painted, so
    // "Use score" can fill that grade's digit row in the Chart Audit (perfusion layer only).
    if (layer === 'perf' && GRADE_PREFIX[r.field]) fig.appendChild(renderGradePicker(r));

    var det = el('details', 'hhr-dx-list');
    det.appendChild(el('summary', null, 'List view (keyboard / screen-reader)'));
    var opts = el('div', 'opts opts-bullets opts-bullets-multi');
    m.areas.forEach(function (a) {
      var code = a.key, label = a.code;
      var rec = segsFor(layer)[r.field][code] || (segsFor(layer)[r.field][code] = { polys: [], inputs: [] });
      var l = el('label', 'opt'); var i = document.createElement('input');
      i.type = 'checkbox'; i.value = code; i.setAttribute('aria-label', label);
      i.addEventListener('change', function () { setSeg(r.field, code, i.checked, layer); });
      l.appendChild(i); l.appendChild(el('span', 'opt-text', label)); opts.appendChild(l);
      rec.inputs.push(i);
    });
    det.appendChild(opts); fig.appendChild(det);

    if (layer === 'perf') fig.appendChild(el('p', 'hint', 'Optional: a de-identified photo can be uploaded in REDCap after opening — it is not used in the score.'));
    return fig;
  }

  /* ------------------------------------------------------- state mutations */
  function toggleSeg(field, code, layer) { setSeg(field, code, !checkedSet(field, layer).has(code), layer); }
  function setSeg(field, code, on, layer) {
    var set = checkedSet(field, layer);
    if (on) set.add(code); else set.delete(code);
    dirty = true; updateSegVisuals(field, code, layer); refresh();
  }
  function clearField(field, layer) { checkedSet(field, layer).clear(); dirty = true; updateSegVisuals(field, null, layer); refresh(); }
  function resetAll() {
    Object.keys(state.checked).forEach(function (f) { state.checked[f].clear(); });
    Object.keys(state.ampChecked).forEach(function (f) { state.ampChecked[f].clear(); });
    document.querySelectorAll('#app-hhr fieldset.options input[type=checkbox]').forEach(function (i) { i.checked = false; });
    Object.keys(segsFor('perf')).forEach(function (f) { updateSegVisuals(f, null, 'perf'); });
    Object.keys(segsFor('amp')).forEach(function (f) { updateSegVisuals(f, null, 'amp'); });
    grades = {}; Object.keys(GRADE_PREFIX).forEach(function (f) { updateGradeButtons(f); });   // a true clean slate (no stale Cauchy grade)
    dirty = false; refresh();
  }

  // Sync polygon + list visuals for one field on one layer (optionally just one code).
  function updateSegVisuals(field, code, layer) {
    var nm = segsFor(layer)[field]; if (!nm) return;
    var set = checkedSet(field, layer), onClass = (layer === 'amp') ? 'amp-on' : 'on';
    var codes = code ? [code] : Object.keys(nm);
    codes.forEach(function (c) {
      var rec = nm[c]; if (!rec) return; var on = set.has(c);
      rec.polys.forEach(function (p) { p.classList.toggle(onClass, on); p.setAttribute('aria-checked', on ? 'true' : 'false'); });
      rec.inputs.forEach(function (i) { if (i.checked !== on) i.checked = on; });
    });
  }

  /* ------------------------------------------------------------ score box */
  function renderScorebox() {
    var sb = el('div', 'section-group hhr-scorebox');
    sb.appendChild(el('h2', 'section', 'Hennepin Frostbite Score'));
    var total = el('div', 'hhr-total');
    total.appendChild(el('span', 'hhr-total-label', 'Total Body Perfusion Score'));
    var tv = el('span', 'hhr-total-val', '0'); total.appendChild(tv); addScore('hennepin_score_total', tv);
    sb.appendChild(total);
    var box = el('div', 'hhr-regions');
    REGIONS.forEach(function (r) {
      var g = el('div', 'hhr-region'); g.dataset.region = r.key; g.hidden = true; regionGroup[r.key] = g;
      var h = el('div', 'hhr-region-head');
      h.appendChild(el('span', 'hhr-region-name', r.label));
      var rt = el('span', 'hhr-region-score', '0'); h.appendChild(rt); addScore(r.total, rt);
      g.appendChild(h);
      var grid = el('div', 'hhr-digit-grid');
      r.rows.forEach(function (row) {
        grid.appendChild(el('span', 'hhr-digit-name', row.label));
        var v = el('span', 'hhr-digit-num', '0'); grid.appendChild(v); addScore(row.var, v);
      });
      g.appendChild(grid); box.appendChild(g);
    });
    sb.appendChild(box);
    return sb;
  }
  // Per-limb Cauchy-grade OVERRIDE picker (2/3/4). "Use score" auto-derives each digit's
  // grade from the painted anatomy (autoGradesFor, below); pressing one of these buttons
  // instead routes ALL of this limb's currently-active codes into that single row
  // (re-pressing the active button clears the override and returns the limb to auto).
  // The hint span below shows what will actually be sent (updateGradePreview).
  function renderGradePicker(r) {
    var row = el('div', 'hhr-grade-row');
    row.appendChild(el('span', 'hhr-grade-lab', 'Frostbite (Cauchy) grade:'));
    ['2', '3', '4'].forEach(function (gv) {
      var b = el('button', 'hhr-grade-btn'); b.type = 'button'; b.textContent = 'Grade ' + gv;
      b.dataset.grade = gv; b.dataset.region = r.key; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { setGrade(r.field, gv); });
      row.appendChild(b);
    });
    row.appendChild(el('span', 'hint hhr-grade-hint', 'grade is derived automatically from the anatomy on “Use score” — press a grade button only to override it for this limb'));
    var preview = el('span', 'hint hhr-grade-preview'); preview.id = 'hhr-grade-preview-' + r.key;
    row.appendChild(preview);
    return row;
  }
  function setGrade(field, gv) { grades[field] = (grades[field] === gv) ? '' : gv; dirty = true; updateGradeButtons(field); updateGradePreview(field); }
  function updateGradeButtons(field) {
    var r = REGION_BY_FIELD[field]; if (!r) return;
    document.querySelectorAll('.hhr-grade-btn[data-region="' + r.key + '"]').forEach(function (b) {
      var on = b.dataset.grade === grades[field];
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  // What "Use score" would send right now for this limb's grade preview, in words — kept
  // in sync by refresh() (anatomy/score changes) and setGrade() (override toggles).
  function updateGradePreview(field) {
    var r = REGION_BY_FIELD[field]; if (!r) return;
    var sp = $('hhr-grade-preview-' + r.key); if (!sp) return;
    var g = grades[field];
    if (g) { sp.textContent = 'overridden to Grade ' + g; return; }
    var auto = autoGradesFor(field), parts = [];
    ['2', '3', '4'].forEach(function (gv) {
      auto[gv].forEach(function (d) { parts.push((d === '6' ? 'Wrist/prox' : 'D' + d) + '→G' + gv); });
    });
    sp.textContent = parts.length ? 'auto: ' + parts.join(', ') : '';
  }
  // Cauchy grade auto-derived from painted anatomy (topographic), per digit on this limb:
  // distal phalanx only -> '2'; any middle/proximal phalanx -> '3'; that digit's
  // carpal/tarsal ray painted -> '4' (and, limb-wide, any bare wrist/heel section also
  // pushes '6' — "Wrist or more proximal" — into the '4' bucket). Read straight from the
  // RAY_OF/WRISTHEEL_OF labels rather than DIGIT_OF, so a wrist-only paint (no DIGIT_OF
  // entry — no score equation references the wrist at all) is still recognized here; it
  // just can't raise the limb's own score above 0, so useScore()'s total===0 guard will
  // bail before grading if wrist-only is literally the only thing painted anywhere.
  function autoGradesFor(field) {
    var set = checkedSet(field, 'perf'), dmap = DIGIT_OF[field] || {}, pmap = PHALANX_OF[field] || {};
    var rmap = RAY_OF[field] || {}, whmap = WRISTHEEL_OF[field] || {};
    var digits = {}, proxMost = false;
    set.forEach(function (code) {
      if (whmap[code]) { proxMost = true; return; }
      var ray = rmap[code];
      if (ray) { (digits[ray] || (digits[ray] = {})).carpal = true; proxMost = true; return; }
      var dg = dmap[code]; if (!dg || dg === '6') return;
      var d = digits[dg] || (digits[dg] = {}), p = pmap[code];
      if (p === 'distal') d.distal = true; else if (p) d.mid = true;   // middle OR proximal phalanx
    });
    var buckets = { '2': [], '3': [], '4': [] };
    Object.keys(digits).sort().forEach(function (dg) {
      var d = digits[dg];
      buckets[d.carpal ? '4' : (d.mid ? '3' : '2')].push(dg);
    });
    if (proxMost) buckets['4'].push('6');
    return buckets;
  }
  // Amputation score box — total only (its own number). Non-colliding classes so the
  // perfusion test selectors (.hhr-total-val, .hhr-region[data-region]) are unaffected.
  function renderAmpScorebox() {
    var sb = el('div', 'section-group hhr-scorebox hhr-amp-scorebox');
    var total = el('div', 'hhr-total');
    total.appendChild(el('span', 'hhr-total-label', 'Amputation score — tissue lost (Hennepin)'));
    var tv = el('span', 'hhr-amp-total-val', '0'); total.appendChild(tv); addAmpScore('hennepin_score_total', tv);
    sb.appendChild(total);
    sb.appendChild(el('p', 'hint', 'The same Hennepin equations, run over the amputated sections — a parallel, independent score (this is “A” in the salvage rate).'));
    return sb;
  }

  /* --------------------------------------------------------------- refresh */
  function refresh() {
    var anyP = false;
    REGIONS.forEach(function (r) {
      var show = regionRevealed(r);
      diagramWrap.perf[r.key].hidden = !show; anyP = anyP || show;
      var c = countNode.perf[r.key]; if (c) { var n = checkedSet(r.field, 'perf').size; c.textContent = n ? '· ' + n + ' selected' : ''; }
    });
    var pe = $('hhr-dx-empty'); if (pe) pe.hidden = anyP;

    var anyA = false;
    REGIONS.forEach(function (r) {
      var show = regionRevealed(r) || checkedSet(r.field, 'amp').size > 0;
      if (diagramWrap.amp[r.key]) { diagramWrap.amp[r.key].hidden = !show; anyA = anyA || show; }
      var c = countNode.amp[r.key]; if (c) { var n = checkedSet(r.field, 'amp').size; c.textContent = n ? '· ' + n + ' selected' : ''; }
    });
    var ae = $('hhr-amp-empty'); if (ae) ae.hidden = anyA;

    computeScore();        // frostbite score (reads ONLY state.checked)
    refreshAmpScore();     // amputation score (reads ONLY state.ampChecked)

    REGIONS.forEach(function (r) {
      var hasScore = scoreVal(r.total) !== 0 || r.rows.some(function (row) { return scoreVal(row.var) !== 0; });
      regionGroup[r.key].hidden = !(regionRevealed(r) || hasScore);
    });

    state._visible = FB.computeVisibility(DICT, state);

    updateAmpSummary();
    refreshSalvage();
    updatePill();
    updateAmpPreview();
    Object.keys(GRADE_PREFIX).forEach(function (f) { updateGradePreview(f); });
  }

  function scoreVal(v) {
    var nodes = scoreEls[v]; if (!nodes || !nodes.length) return 0;
    var n = parseFloat(nodes[0].textContent); return isNaN(n) ? 0 : n;
  }
  function scoreText(v) {
    var nodes = scoreEls[v]; if (!nodes || !nodes.length) return '0';
    return nodes[0].textContent || '0';
  }
  function ampTotalStr() { var n = ampScoreEls['hennepin_score_total']; return (n && n[0]) ? (n[0].textContent || '0') : '0'; }

  // Run REDCap's own equations over a given selection store; returns name -> formatted value.
  function scoreVals(store) {
    var elements = {};
    DICT.fields.forEach(function (f) {
      if (f.type !== 'checkbox' || !f.options) return;
      var set = store[f.var];
      f.options.forEach(function (o) { elements['__chk__' + f.var + '_RC_' + o.code] = { value: (set && set.has(o.code)) ? o.code : '' }; });
    });
    var proxy = new Proxy({}, { get: function (_t, k) { return elements[k] || { value: '' }; } });
    var doc = { forms: { form: { elements: proxy } }, form: proxy };
    return function (v) { var n; try { n = CALC[v] ? CALC[v](doc) : ''; } catch (e) { n = '–'; } return (n == null || n === 'NaN' || n === '') ? '0' : String(n); };
  }
  function computeScore() {
    var get = scoreVals(state.checked);
    Object.keys(scoreEls).forEach(function (v) { var txt = get(v); scoreEls[v].forEach(function (node) { node.textContent = txt; }); });
  }
  function refreshAmpScore() {
    var get = scoreVals(state.ampChecked);
    Object.keys(ampScoreEls).forEach(function (v) { var txt = get(v); ampScoreEls[v].forEach(function (node) { node.textContent = txt; }); });
  }

  /* -------------------------------------------------- literature salvage --- */
  // Count-based salvage rates per Heard et al., Scand J Trauma Resusc Emerg Med 2023
  // (PMC10712146): digit salvage = (1 − DA/DR)×100, phalanx salvage = (1 − PA/PR)×100.
  // A digit/phalanx counts as amputated if ANY of its sections is amputated.
  function salvage() {
    var DR = {}, DA = {}, PR = {}, PA = {};
    function tally(store, Ds, Ps) {
      Object.keys(DIGIT_OF).forEach(function (f) {
        var set = store[f]; if (!set || !set.size) return;
        var dmap = DIGIT_OF[f], pmap = PHALANX_OF[f];
        set.forEach(function (code) {
          var dg = dmap[code]; if (!dg || dg === '6') return;   // digits 1-5 only (6 = carpal/tarsal)
          Ds[f + ':' + dg] = 1;
          var p = pmap[code]; if (p) Ps[f + ':' + dg + ':' + p] = 1;
        });
      });
    }
    tally(state.checked, DR, PR); tally(state.ampChecked, DA, PA);
    return { dr: Object.keys(DR).length, da: Object.keys(DA).length, pr: Object.keys(PR).length, pa: Object.keys(PA).length };
  }
  function rate(numer, denom) { return denom > 0 ? Math.max(0, Math.round((1 - numer / denom) * 100)) : null; }
  function buildSalvageBlock() {
    var box = el('div', 'hhr-salvage');
    box.appendChild(salvageCard('hhr-sv-digit', 'Digit salvage rate', true));
    box.appendChild(salvageCard('hhr-sv-phx', 'Phalanx salvage rate', false));
    box.appendChild(salvageCard('hhr-sv-tsr', 'Hennepin TSR · score-based', false));
    var note = el('p', 'hhr-salvage-note');
    note.innerHTML = 'Salvage rate = (1 − amputated ÷ at-risk) × 100. The <b>digit</b> and <b>phalanx</b> rates use the count-based formulas published verbatim in the 2023 systematic review (Heard et al., <i>Scand J Trauma Resusc Emerg Med</i> 31:90, PMC10712146): <code>(1−DA/DR)×100</code> and <code>(1−PA/PR)×100</code>; a digit/phalanx counts as amputated if any of its sections is. <b>TSR</b> is the Hennepin score-based rate <code>(R−A)/R×100</code> using this calculator’s own equations (R = frostbite score, A = amputation score). Pooled counts across the map (not a per-patient mean).';
    var wrap = el('div'); wrap.appendChild(box); wrap.appendChild(note); return wrap;
  }
  function salvageCard(id, label, headline) {
    var c = el('div', 'hhr-sv-card' + (headline ? ' headline' : ''));
    c.appendChild(el('div', 'hhr-sv-lab', label));
    var v = el('div', 'hhr-sv-val', '—'); v.id = id; c.appendChild(v);
    var s = el('div', 'hhr-sv-sub'); s.id = id + '-sub'; s.innerHTML = '&nbsp;'; c.appendChild(s);
    return c;
  }
  function refreshSalvage() {
    if (!$('hhr-sv-digit')) return;
    var s = salvage();
    setSv('hhr-sv-digit', rate(s.da, s.dr), 'amputated ' + s.da + ' / at-risk ' + s.dr + ' digits');
    setSv('hhr-sv-phx', rate(s.pa, s.pr), 'amputated ' + s.pa + ' / at-risk ' + s.pr + ' phalanges');
    var R = parseFloat(scoreText('hennepin_score_total')) || 0, A = parseFloat(ampTotalStr()) || 0;
    var tsr = R > 0 ? Math.max(0, Math.round((1 - A / R) * 100)) : null;
    setSv('hhr-sv-tsr', tsr, 'frostbite ' + R + ' − amputated ' + A);
  }
  function setSv(id, val, sub) { var e = $(id); if (e) e.textContent = (val == null ? '—' : val + '%'); var su = $(id + '-sub'); if (su) su.textContent = sub; }

  /* -------------------------------------------------------- amputation UI -- */
  function updateAmpSummary() {
    var elx = $('hhr-amp-summary'); var units = 0, parts = [];
    REGIONS.forEach(function (r) {
      var set = checkedSet(r.field, 'amp'); if (!set.size) return;
      if (r.key === 'proximal') { units += 1; parts.push('Proximal extremity'); return; }
      var dmap = DIGIT_OF[r.field] || {}, digs = {};
      set.forEach(function (c) { var d = dmap[c]; if (d) digs[d] = 1; });
      units += Object.keys(digs).length;
      var list = Object.keys(digs).sort().map(function (d) { return d === '6' ? 'Prox' : 'D' + d; }).join(', ');
      parts.push(r.label + ': ' + (list || '(sections)'));
    });
    if (elx) elx.innerHTML = parts.length ? parts.map(function (p) { return '<span class="hhr-amp-chip">' + p + '</span>'; }).join(' ')
      : '<span class="hint" style="margin:0">none yet — mark amputated sections on the diagrams above.</span>';
    var badge = $('hhr-amp-badge'); if (badge) { badge.textContent = units; badge.hidden = !units; }
  }
  function updatePill() {
    var lv = $('hhr-live-val'), ll = $('hhr-live-label'), pill = $('hhr-livetotal'); if (!lv) return;
    if (curView === 'amp') { lv.textContent = ampTotalStr(); if (ll) ll.textContent = 'Amputation'; if (pill) pill.classList.add('amp'); }
    else { lv.textContent = scoreText('hennepin_score_total'); if (ll) ll.textContent = 'Score'; if (pill) pill.classList.remove('amp'); }
  }

  /* -------------------------------------------------------- compare view --- */
  function buildCmpLegend() {
    var lg = el('span', 'hhr-cmp-legend');
    lg.innerHTML = '<span><span class="hhr-sw hhr-sw-blue"></span>at risk</span>'
      + '<span><span class="hhr-sw hhr-sw-amp"></span>lost</span>'
      + '<span><span class="hhr-sw hhr-sw-both"></span>both</span>';
    return lg;
  }
  function renderStaticFig(r, mode) {   // mode: 'perf' | 'amp' | 'over'
    var m = MAPS[r.key];
    var fig = el('figure', 'hhr-dx hhr-dx-ro'); fig.dataset.region = r.key; fig.dataset.cmp = mode;
    var head = el('figcaption', 'hhr-dx-head'); head.appendChild(el('span', 'hhr-dx-title', r.label)); fig.appendChild(head);
    var wrap = el('div', 'hhr-dx-wrap');
    var img = document.createElement('img'); img.className = 'hhr-dx-img'; img.src = m.img; img.alt = r.label; img.width = m.w; img.height = m.h; img.loading = 'lazy'; wrap.appendChild(img);
    var overlay = svg('svg', { viewBox: '0 0 ' + m.w + ' ' + m.h, preserveAspectRatio: 'xMidYMid meet', class: 'hhr-dx-svg' });
    overlay.setAttribute('aria-hidden', 'true');
    var perfSet = checkedSet(r.field, 'perf'), ampSet = checkedSet(r.field, 'amp');
    m.areas.forEach(function (a) {
      var code = a.key, pts = []; for (var i = 0; i + 1 < a.coords.length; i += 2) pts.push(a.coords[i] + ',' + a.coords[i + 1]);
      var risk = perfSet.has(code), lost = ampSet.has(code), cls = 'hhr-seg';
      if (mode === 'perf') { if (risk) cls += ' on'; }
      else if (mode === 'amp') { if (lost) cls += ' amp-on'; }
      else { if (risk && lost) cls += ' both'; else if (lost) cls += ' amp-on'; else if (risk) cls += ' on'; }
      overlay.appendChild(svg('polygon', { points: pts.join(' '), class: cls }));
    });
    wrap.appendChild(overlay); fig.appendChild(wrap); return fig;
  }
  function renderCompare() {
    var gp = $('hhr-cmp-perf'), ga = $('hhr-cmp-amp'), go = $('hhr-cmp-overgrid'); if (!gp) return;
    gp.innerHTML = ''; ga.innerHTML = ''; go.innerHTML = '';
    var any = false;
    REGIONS.forEach(function (r) {
      if (!(checkedSet(r.field, 'perf').size || checkedSet(r.field, 'amp').size)) return;
      any = true;
      gp.appendChild(renderStaticFig(r, 'perf'));
      ga.appendChild(renderStaticFig(r, 'amp'));
      go.appendChild(renderStaticFig(r, 'over'));
    });
    var emp = $('hhr-cmp-empty'); if (emp) emp.hidden = any;
    refreshSalvage();
  }
  function setCmpMode(mode) {
    var s = $('hhr-cmp-side'), o = $('hhr-cmp-over'); if (!s) return;
    s.hidden = (mode === 'over'); o.hidden = (mode !== 'over');
    var bs = $('hhr-cmp-side-btn'), bo = $('hhr-cmp-over-btn');
    if (bs) bs.classList.toggle('active', mode !== 'over'); if (bo) bo.classList.toggle('active', mode === 'over');
  }

  /* ------------------------------------------- write score into main form */
  var hhrStatusTimer = 0;
  function flashStatus(msg, kind) {
    var s = $('hhr-status'); if (!s) return;
    s.className = 'submit-status' + (kind ? ' ' + kind : '');
    s.textContent = msg;
    if (hhrStatusTimer) clearTimeout(hhrStatusTimer);
    hhrStatusTimer = setTimeout(function () { s.textContent = ''; s.className = 'submit-status'; }, 5000);
  }
  function buildScoreText() {
    var lines = ['Hennepin Total Body Perfusion Score: ' + scoreText('hennepin_score_total')];
    REGIONS.forEach(function (r) {
      var hasScore = scoreVal(r.total) !== 0 || r.rows.some(function (row) { return scoreVal(row.var) !== 0; });
      if (!hasScore) return;
      var parts = r.rows.map(function (row) { return row.label + ': ' + scoreText(row.var); });
      lines.push(r.label + ' (total ' + scoreText(r.total) + '): ' + parts.join(', '));
    });
    return lines.join('\n');
  }
  // Which limbs are frostbitten (-> Chart Audit limb_frostbite), and which whole digits
  // are amputated per Chart Audit amp field (-> right_hand_amp / left_hand_amp / …).
  function frostbiteLimbCodes() {
    var codes = [];
    Object.keys(FROSTBITE_LIMB).forEach(function (f) { if (checkedSet(f, 'perf').size) codes.push(FROSTBITE_LIMB[f]); });
    return codes;
  }
  function ampDigitsByField() {
    var out = {};
    REGIONS.forEach(function (r) {
      if (!r.amp) return;     // proximal extremity has no per-digit amputation field
      var set = checkedSet(r.field, 'amp'), dmap = DIGIT_OF[r.field] || {}, digs = {};
      set.forEach(function (c) { var d = dmap[c]; if (d) digs[d] = 1; });
      out[r.amp] = Object.keys(digs).sort();
    });
    return out;
  }

  function useScore() {
    var total = scoreVal('hennepin_score_total');
    if (!total) { flashStatus('Select the affected sections first — the score is still 0.', 'err'); return; }
    if (!window.FBMAIN || !window.FBMAIN.setField) { flashStatus('Could not reach the Chart Audit form.', 'err'); return; }
    var r = window.FBMAIN.setField('hennepin_score', buildScoreText());
    // Also tick the affected limbs + the per-limb frostbite GRADE digit boxes so they
    // aren't re-entered by hand. Each limb's grade is auto-derived per digit from the
    // painted anatomy (autoGradesFor); a manual override (grades[field]) instead routes
    // ALL of that limb's active codes into the one chosen row. The calculator owns
    // exactly the codes it sends — each digit is removed from the OTHER grade rows it
    // isn't in this time (so re-painting a digit to a higher tier MOVES it instead of
    // duplicating it) — but codes it isn't currently sending are left alone in every row,
    // so hand-ticked entries (e.g. a clinician's own note in another row) survive.
    var limbs = frostbiteLimbCodes();
    if (window.FBMAIN.setChecks && limbs.length) window.FBMAIN.setChecks('limb_frostbite', limbs);
    var filled = 0, overridden = [];
    if (window.FBMAIN.setChecks && window.FBMAIN.removeChecks) {
      REGIONS.forEach(function (rg) {
        var field = rg.field; if (!GRADE_PREFIX[field]) return;
        var auto = autoGradesFor(field);
        var active = auto['2'].concat(auto['3'], auto['4']);
        if (!active.length) return;      // nothing scoreable painted on this limb — leave its rows untouched
        var g = grades[field], rows;
        if (g) { rows = { '2': [], '3': [], '4': [] }; rows[g] = active; overridden.push(rg.label + ' → Grade ' + g); }
        else rows = auto;
        ['2', '3', '4'].forEach(function (gv) {
          var rowVar = GRADE_PREFIX[field] + '_grade_' + gv, wanted = rows[gv];
          var toRemove = active.filter(function (c) { return wanted.indexOf(c) < 0; });
          if (toRemove.length) window.FBMAIN.removeChecks(rowVar, toRemove);
          if (wanted.length) window.FBMAIN.setChecks(rowVar, wanted);
        });
        filled += active.length;
      });
    }
    if (r && r.ok) {
      // The grading clause is gated on `filled`, NOT on limbs.length — a proximal-only
      // injury (e.g. TC-12) ticks limb_frostbite for nothing and grades nothing, so the
      // message must not claim the Frostbite grading table was auto-graded when it's empty.
      var gradedMsg = filled ? ' and the Chart Audit “Frostbite grading” table auto-graded from the anatomy (' + filled + ' digit box' + (filled === 1 ? '' : 'es') + ')' : '';
      var msg = '✓ Hennepin score ' + total + ' written' + (limbs.length ? ', affected limbs ticked' : '') + (gradedMsg ? ',' + gradedMsg : '') + '.';
      if (overridden.length) msg += ' Manual override applied — ' + overridden.join('; ') + '.';
      flashStatus(msg, 'ok');
    } else flashStatus('Could not write to the Chart Audit form.', 'err');
  }

  /* ------------------------------------------------- amputation panel ------ */
  var AMP_TYPES = [['surgical', 'Surgical amputation'], ['other', 'Other']];
  function renderAmpPanel() {
    var g = el('div', 'section-group hhr-amp'); g.id = 'hhr-amp-panel';
    g.appendChild(el('h2', 'section amp', 'Amputation type & comments'));
    g.appendChild(el('p', 'hint', 'Optional narrative. On “Send”, the amputated digits, the amputation score, the salvage rates, your comments (and optionally the full Hennepin breakdown) go straight to the Chart Audit’s amputation box.'));

    var typeFs = el('fieldset', 'options hhr-amp-type'); typeFs.setAttribute('role', 'radiogroup'); typeFs.setAttribute('aria-label', 'Type of amputation');
    typeFs.appendChild(el('legend', null, 'Type of amputation'));
    var typeOpts = el('div', 'opts');
    AMP_TYPES.forEach(function (pair) {
      var lab = el('label', 'opt'); var i = document.createElement('input');
      i.type = 'radio'; i.name = 'hhr_amp_type'; i.value = pair[0]; i.checked = (amp.type === pair[0]);
      i.addEventListener('change', function () { if (i.checked) { amp.type = pair[0]; dirty = true; syncAmpOther(); updateAmpPreview(); } });
      lab.appendChild(i); lab.appendChild(el('span', 'opt-text', pair[1])); typeOpts.appendChild(lab);
    });
    typeFs.appendChild(typeOpts); g.appendChild(typeFs);

    var otherWrap = el('div', 'field hhr-amp-other'); otherWrap.id = 'hhr-amp-other'; otherWrap.hidden = (amp.type !== 'other');
    var otherLab = el('label', 'field-label'); otherLab.htmlFor = 'hhr-amp-other-in'; otherLab.textContent = 'Specify type';
    var otherIn = document.createElement('input'); otherIn.id = 'hhr-amp-other-in'; otherIn.className = 'input'; otherIn.type = 'text';
    otherIn.value = amp.other || ''; otherIn.placeholder = 'e.g. autoamputation';
    otherIn.addEventListener('input', function () { amp.other = otherIn.value; dirty = true; updateAmpPreview(); });
    otherWrap.appendChild(otherLab); otherWrap.appendChild(otherIn); g.appendChild(otherWrap);

    var cWrap = el('div', 'field');
    var cLab = el('label', 'field-label'); cLab.htmlFor = 'hhr-amp-comments'; cLab.textContent = 'Amputation comments';
    var ta = document.createElement('textarea'); ta.id = 'hhr-amp-comments'; ta.className = 'input'; ta.rows = 3;
    ta.value = amp.comments || ''; ta.placeholder = 'Free text — e.g. level/demarcation, who performed it, dates…';
    ta.addEventListener('input', function () { amp.comments = ta.value; dirty = true; updateAmpPreview(); });
    cWrap.appendChild(cLab); cWrap.appendChild(ta); g.appendChild(cWrap);

    var incWrap = el('div', 'hhr-amp-inc');
    var incLab = el('label', 'opt'); var inc = document.createElement('input'); inc.type = 'checkbox'; inc.id = 'hhr-amp-inc'; inc.checked = !!amp.includeHhr;
    inc.addEventListener('change', function () { amp.includeHhr = inc.checked; dirty = true; updateAmpPreview(); });
    incLab.appendChild(inc); incLab.appendChild(el('span', 'opt-text', 'Include full Hennepin score breakdown')); incWrap.appendChild(incLab); g.appendChild(incWrap);

    g.appendChild(el('div', 'field-label', 'Preview — sent to “Additional areas of frostbite related amputation”'));
    var pre = el('pre', 'hhr-amp-preview'); pre.id = 'hhr-amp-preview'; g.appendChild(pre);

    var row = el('div', 'hhr-amp-actions');
    var st = el('span', 'submit-status'); st.id = 'hhr-amp-status'; st.setAttribute('role', 'status'); st.setAttribute('aria-live', 'polite'); row.appendChild(st);
    row.appendChild(el('span', 'actionbar-spacer'));
    var send = el('button', 'btn btn-amp'); send.id = 'hhr-amp-send'; send.type = 'button'; send.textContent = 'Send to amputation box →';
    send.addEventListener('click', onSendAmp); row.appendChild(send);
    g.appendChild(row);
    return g;
  }

  function syncAmpOther() { var o = $('hhr-amp-other'); if (o) o.hidden = (amp.type !== 'other'); }

  // Structured "Amputated: Left hand: D2, D3; …" line from the amputation layer.
  function ampDigitSummary() {
    var parts = [];
    REGIONS.forEach(function (r) {
      var set = checkedSet(r.field, 'amp'); if (!set.size) return;
      if (r.key === 'proximal') { parts.push('Proximal extremity'); return; }
      var dmap = DIGIT_OF[r.field] || {}, digs = {};
      set.forEach(function (c) { var d = dmap[c]; if (d) digs[d] = 1; });
      var list = Object.keys(digs).sort().map(function (d) { return d === '6' ? 'proximal (carpal/tarsal)' : 'D' + d; }).join(', ');
      if (list) parts.push(r.label + ': ' + list);
    });
    return parts.length ? 'Amputated — ' + parts.join('; ') + '.' : '';
  }

  function buildAmpText() {
    var lines = [];
    if (amp.type === 'surgical') lines.push('Type of amputation: Surgical amputation');
    else if (amp.type === 'other') lines.push('Type of amputation: Other' + (amp.other && amp.other.trim() ? ': ' + amp.other.trim() : ''));
    var c = (amp.comments || '').trim();
    if (c) lines.push(c);
    var ds = ampDigitSummary(); if (ds) lines.push(ds);
    var ampN = parseFloat(ampTotalStr()) || 0;
    if (ampN > 0) lines.push('Amputation Hennepin score (tissue lost): ' + ampTotalStr());
    var s = salvage();
    if (s.dr > 0) {
      var R = parseFloat(scoreText('hennepin_score_total')) || 0, A = ampN, tsr = R > 0 ? Math.max(0, Math.round((1 - A / R) * 100)) : null;
      var sv = 'Salvage — digit salvage rate ' + rate(s.da, s.dr) + '% (' + (s.dr - s.da) + '/' + s.dr + ' digits)';
      if (s.pr > 0) sv += '; phalanx salvage rate ' + rate(s.pa, s.pr) + '% (' + (s.pr - s.pa) + '/' + s.pr + ' phalanges)';
      if (tsr != null) sv += '; Hennepin TSR ' + tsr + '%';
      lines.push(sv);
    }
    if (amp.includeHhr && scoreVal('hennepin_score_total') > 0) {
      if (lines.length) lines.push('');
      lines.push(buildScoreText());
    }
    return lines.join('\n');
  }

  function updateAmpPreview() {
    var pre = $('hhr-amp-preview'); if (!pre) return;
    var t = buildAmpText();
    pre.textContent = t || 'Nothing yet — mark amputated sections above, or add a type / comment.';
    pre.classList.toggle('is-empty', !t);
  }

  var ampStatusTimer = 0;
  function flashAmp(msg, kind) {
    var s = $('hhr-amp-status'); if (!s) return;
    s.className = 'submit-status' + (kind ? ' ' + kind : ''); s.textContent = msg;
    if (ampStatusTimer) clearTimeout(ampStatusTimer);
    ampStatusTimer = setTimeout(function () { s.textContent = ''; s.className = 'submit-status'; }, 6000);
  }

  function onSendAmp() {
    var text = buildAmpText();
    if (!text) { flashAmp('Mark the amputated sections, or add a type / comment first.', 'err'); return; }
    if (!window.FBMAIN || !window.FBMAIN.setField) { flashAmp('Could not reach the Chart Audit form.', 'err'); return; }
    if (window.FBMAIN.setChoice) window.FBMAIN.setChoice('limb_amputation', '1');
    var r = window.FBMAIN.setField('additional_frostbite', text);
    // Also tick the amputated whole-digit boxes (right_hand_amp / left_hand_amp / …).
    var ticked = 0;
    if (window.FBMAIN.setChecks) {
      var byField = ampDigitsByField();
      Object.keys(byField).forEach(function (fld) { if (byField[fld].length) { window.FBMAIN.setChecks(fld, byField[fld]); ticked += byField[fld].length; } });
    }
    if (r && r.ok) flashAmp('✓ Sent to the amputation box, set “limbs/digits amputated” to Yes' + (ticked ? ', and ticked the ' + ticked + ' amputated digit box' + (ticked === 1 ? '' : 'es') + ' in the Chart Audit.' : '.'), 'ok');
    else flashAmp('Could not write to the amputation box.', 'err');
  }

  /* --------------------------- save / restore state ------------------------ */
  function getState() {
    var c = {}; Object.keys(state.checked).forEach(function (f) { var a = Array.from(state.checked[f]); if (a.length) c[f] = a; });
    var ac = {}; Object.keys(state.ampChecked).forEach(function (f) { var a = Array.from(state.ampChecked[f]); if (a.length) ac[f] = a; });
    var gr = {}; Object.keys(grades).forEach(function (f) { if (grades[f]) gr[f] = grades[f]; });
    return { checked: c, ampChecked: ac, grades: gr, amp: { on: amp.on, type: amp.type, other: amp.other, comments: amp.comments, includeHhr: amp.includeHhr } };
  }
  function setState(s) {
    if (!s || typeof s !== 'object') return false;
    build();   // ensure the UI exists (no-op if already built)
    state.checked = {};
    Object.keys(s.checked || {}).forEach(function (f) { state.checked[f] = new Set(s.checked[f]); });
    state.ampChecked = {};
    Object.keys(s.ampChecked || {}).forEach(function (f) { state.ampChecked[f] = new Set(s.ampChecked[f]); });   // backward compatible: missing -> empty
    grades = {};
    Object.keys(s.grades || {}).forEach(function (f) { grades[f] = s.grades[f]; });
    document.querySelectorAll('#app-hhr fieldset.options input[type=checkbox]').forEach(function (i) {
      var set = state.checked[i.name]; i.checked = !!(set && set.has(i.value));
    });
    Object.keys(segsFor('perf')).forEach(function (f) { updateSegVisuals(f, null, 'perf'); });
    Object.keys(segsFor('amp')).forEach(function (f) { updateSegVisuals(f, null, 'amp'); });
    var a = s.amp || {};
    amp.on = !!a.on; amp.type = a.type || ''; amp.other = a.other || ''; amp.comments = a.comments || ''; amp.includeHhr = (a.includeHhr !== false);
    document.querySelectorAll('#app-hhr input[name="hhr_amp_type"]').forEach(function (i) { i.checked = (i.value === amp.type); });
    var oin = $('hhr-amp-other-in'); if (oin) oin.value = amp.other;
    var cin = $('hhr-amp-comments'); if (cin) cin.value = amp.comments;
    var inc = $('hhr-amp-inc'); if (inc) inc.checked = amp.includeHhr;
    syncAmpOther();
    Object.keys(GRADE_PREFIX).forEach(function (f) { updateGradeButtons(f); });
    dirty = false;
    refresh();
    return true;
  }

  window.HHR = { build: build, getState: getState, setState: setState, isDirty: function () { return dirty; } };
})();
