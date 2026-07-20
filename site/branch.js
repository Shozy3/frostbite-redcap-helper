/*
 * Shared, dependency-free branching evaluator.
 * Mirrors REDCap's own show/hide logic, transpiled into safe rule trees by
 * tools/parse_survey.py (no eval, so the page can ship a strict CSP).
 *
 * Tree nodes:
 *   {leaf:{type:'eq'|'ne'|'nonempty'|'checked', field, value?, rc?, want?}}
 *   {op:'and'|'or', a:<node>, b:<node>}
 *
 * helpers (h):
 *   h.val(field)          -> selected code / text value as a string ('' if unset)
 *   h.isChecked(field,code) -> boolean: is the option with that code checked
 *
 * A field with a null tree is always shown.
 */
(function (g) {
  function evalBranch(node, h) {
    if (!node) return true;
    if (node.leaf) {
      var L = node.leaf;
      switch (L.type) {
        case 'eq':       return String(h.val(L.field)) === String(L.value);
        case 'ne':       return String(h.val(L.field)) !== String(L.value);
        case 'nonempty': return String(h.val(L.field)) !== '';
        case 'checked':  return (h.isChecked(L.field, L.code) ? 1 : 0) === L.want;
        default:         return true;
      }
    }
    if (node.op === 'or')  return evalBranch(node.a, h) || evalBranch(node.b, h);
    if (node.op === 'and') return evalBranch(node.a, h) && evalBranch(node.b, h);
    return true;
  }
  // Build evaluator helpers from a raw state, honoring REDCap's rule that a
  // hidden field contributes an empty value to downstream branching.
  function makeHelpers(state, visible) {
    var values = state.values || {}, checked = state.checked || {};
    return {
      val: function (f) {
        if (visible && visible[f] === false) return '';
        return values[f] != null ? String(values[f]) : '';
      },
      isChecked: function (f, code) {
        if (visible && visible[f] === false) return false;
        var s = checked[f];
        return s ? (s.has ? s.has(code) : (s.indexOf && s.indexOf(code) >= 0)) : false;
      }
    };
  }

  // Resolve which fields are visible, to a fixpoint (cascading branching +
  // hidden-value erase). Fields with no branch rule are always visible.
  function computeVisibility(dict, state) {
    var visible = {};
    dict.fields.forEach(function (f) { visible[f.var] = true; });
    var branched = dict.fields.filter(function (f) { return f.branch; });
    for (var pass = 0; pass < dict.fields.length + 2; pass++) {
      var changed = false;
      var h = makeHelpers(state, visible);
      for (var i = 0; i < branched.length; i++) {
        var f = branched[i], nv = !!evalBranch(f.branch, h);
        if (nv !== visible[f.var]) { visible[f.var] = nv; changed = true; }
      }
      if (!changed) break;
    }
    return visible;
  }

  g.FB = g.FB || {};
  g.FB.evalBranch = evalBranch;
  g.FB.makeHelpers = makeHelpers;
  g.FB.computeVisibility = computeVisibility;
})(typeof window !== 'undefined' ? window : globalThis);
