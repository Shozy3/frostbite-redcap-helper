# Testing

The project ships a **hand-rolled test suite** — plain Node scripts with a tiny
`ok(cond, msg)` assertion helper (no Jest/Mocha/Vitest to install). The UI tests
load the real `site/index.html` + all `site/*.js` into [jsdom](https://github.com/jsdom/jsdom)
and drive them like a browser would, so the exact shipped code is exercised — only
the network is mocked. Real AES-GCM runs via Node's `webcrypto`, so the encryption
paths are tested for real.

## Running the tests

The only dependency is `jsdom`:

```bash
npm install
```

Run the full **offline** suite (no network) — the canonical chain also documented
in [DEPLOY.md](DEPLOY.md):

```bash
node tools/test_datemask.js && node tools/test_ilop.js && node tools/test_branching.js \
 && node tools/test_hhr_calc.js && node tools/test_ui.js && node tools/test_hhr_ui.js \
 && node tools/test_grade_autofill_ui.js && node tools/test_ilop_ui.js \
 && node tools/test_features_ui.js && node tools/test_cryptosave.js && node tools/test_save.js \
 && node tools/test_recordstate.js && node tools/test_bridge_ui.js \
 && node tools/test_bridge_lib.mjs && node tools/verify_vendor.js
```

Each script prints `✓`/`✗` lines and exits non-zero on any failure.

## What the suites cover

### Offline logic (pure functions, no DOM, no network)

| Test | Covers |
|---|---|
| `test_datemask.js` | The typed `DD-MM-YYYY[ HH:MM]` input mask + ISO conversion (`datemask.js`). |
| `test_ilop.js` | Iloprost dose math (`ilop.js`) — minutes × rate, totals, unit handling. |
| `test_branching.js` | The `eval`-free branching evaluator (`branch.js`) vs. REDCap's own show/hide rules. |
| `test_hhr_calc.js` | Proves the baked Hennepin calculator equals REDCap's literal `Calculations.jsCode` over thousands of random states. |
| `test_export.js` | The readable CSV/XLSX row builder (`export.js`), including option-label decoding. |
| `test_cryptosave.js` | `cryptosave.js`: the per-record random-key round-trip, `splitCode`, `dtok`, wrong-key/tamper rejection, and the regression proving a v3 blob is **not** decryptable via the gate passphrase. |
| `test_save.js` | The `functions/api/save.js` handlers against a mocked KV: input validation, and the `dtok`-gated POST/GET/DELETE/overwrite lifecycle. |
| `test_recordstate.js` | Round-tripping scraped REDCap values back into app state (`payload.js` `recordToState`). |
| `test_bridge_lib.mjs` | The bridge's pure validation + diff logic (`worker/lib.js`). |
| `test_httpbridge.mjs` | The pure-HTTP bridge driver's HTML parsing (`worker/httpbridge.js`), pinned against a saved survey snapshot (`tools/survey.html`). |

### jsdom UI / integration (the real page, mocked network)

| Test | Covers |
|---|---|
| `test_ui.js` | The access gate, form rendering, branching toggles, required-field progress, and the open-in-REDCap prefill form. |
| `test_features_ui.js` | Keystroke-level date masking, the "Auto" date button, and the **end-to-end zero-knowledge save/resume** of all three tools across two fresh pages (= two computers). |
| `test_hhr_ui.js` / `test_grade_autofill_ui.js` | The Hennepin clickable-diagram UI, live scoring, and pushing the grade into the Chart Audit. |
| `test_ilop_ui.js` | The Iloprost calculator UI, saved logs, and pushing the dose into the Chart Audit. |
| `test_defaults_ui.js` | The "no data on file" field defaults and Start-over behavior. |
| `test_export_ui.js` | The export dialog + live preview. |
| `test_bridge_ui.js` | The REDCap save-code bridge wiring (mocked `/api/code`): save code shape `<id>.<key>`, verified/unverified wording, re-save reuses the record key, and the no-orphan / daily-limit fallbacks. |
| `test_haddeya_ui.js` | Cross-cutting invariants (e.g. saves never expire, Iloprost units, 24-hour time mask). |
| `verify_vendor.js` | Confirms the vendored SheetJS build (`site/xlsx.mini.min.js`) matches its recorded SHA-256. |

### Live tests (hit the real deployed survey / Worker — run sparingly)

These require network and **create real test records in REDCap that must be deleted
afterward** — use a test study number and clean up. They also consume the bridge's
free browser-rendering budget, so they aren't part of the routine offline run.

- `test_roundtrip.js` — a full prefill round-trip against the live REDCap survey.
- `test_bridge_live.js` / `test_httpbridge_live.mjs` — the bridge drivers against live REDCap (both directions).
- `probe_redcap_live.js` — a one-off diagnostic that locks the "where does REDCap print the return code" selector.

## Notes

- The web app's required-field tracker is a convenience, not a validator — REDCap
  remains the source of truth for required fields and validity.
- If REDCap changes the survey, regenerate the dictionaries with the `tools/parse_*.py`
  parsers (they fail loudly on an unrecognized field/branching shape) and re-run the suite.
