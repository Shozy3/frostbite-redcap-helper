# Deploying the Frostbite Chart Audit helper

Static site in `site/` → **Cloudflare Pages** at **redcaphelper.haddeya.com**. No backend.
The page is 100% client-side: nothing is stored or transmitted except the final
POST to REDCap when the user clicks "Open populated REDCap form for review", which
opens the real survey, pre-populated, in a new tab to review and submit there.

The page hosts **three tools** behind a top switcher:
1. **Frostbite Chart Audit** — the grouped data-entry helper for the U of A survey.
2. **Hennepin Score Calculator** — a live score calculator for the HHR survey
   (`redcap.hhrinstitute.org`). The score uses REDCap's OWN equations baked verbatim
   (`hhr_calc.js`, verified identical over 102k random states); it opens the populated
   HHR survey for review the same way the frostbite form does.
3. **Iloprost Calculator** — a local infusion-dose calculator (browser-only; it keeps
   its saved calculations in `localStorage` and never transmits them).

The only backend is a tiny **Cloudflare Pages Function** (`functions/api/save.js`, bound to a
Workers **KV** namespace `SAVES`) that backs the **save code**: the browser AES-GCM-encrypts all
three forms under a **fresh random 256-bit key unique to that save** and uploads ONLY `{ct,iv,dtok}`
(`dtok = SHA-256(key)`, the capability that authorizes deleting/overwriting that record). The key
never reaches the server — it travels only inside the save code, as the part after the dot
(`<id>.<key>`). So Cloudflare can never read a save, and one leaked code exposes exactly one record;
saves persist until explicitly deleted (no expiry).
Otherwise each form posts its prefill straight from the browser to the whitelisted REDCap
survey. CSP: `form-action` locks the REDCap destinations; `connect-src 'self'` allows only the
same-origin `/api/save` (and, if the optional bridge Worker below is deployed, the same-origin
`/api/code`).

There is also an **optional** background bridge Worker (`worker/`) that shares save codes with
REDCap's native "Save & Return Later" — see the section at the end and `REDCAP_BRIDGE.md`. It is
off unless deployed; when absent the app falls back to the legacy random save code.

## What gets deployed
Everything in `site/`: `index.html`, `app.js`, `branch.js`, `payload.js`,
`datemask.js` (typed DD-MM-YYYY date entry), `ilop.js` (Iloprost calculator),
`styles.css`, `config.js`, `_headers`, the frostbite dictionary (`dictionary.js`
+ `dictionary.json`), and the Hennepin calculator (`dict_hhr.js`, `hhr_calc.js`,
`hhr_maps.js`, `hhr.js`, and the five clickable anatomical figures in `hhr/img/`
— left/right hand, left/right foot, and the proximal body figure).

The Hennepin and Iloprost tabs are **calculators that feed the Chart Audit** (via an
in-page bridge): "Use score / Use dose in Chart Audit" writes the result into the
Chart Audit's free-text field, and only the Chart Audit POSTs to REDCap. **"Save & get
code"** encrypts all three forms in the browser under a **per-save random key** and stores only the
ciphertext via the `/api/save` Pages Function (Workers KV); the code is `<id>.<key>` (the key rides
along in the code, never on the server), so it resumes on ANY computer (until deleted) and the server can never read it.

## One-time deploy (Cloudflare Pages via Wrangler)
Authenticate to the haddeya.com Cloudflare account, then deploy:

```bash
cd "<project root>"
npx wrangler login                 # opens browser; authorize the haddeya.com account
npx wrangler pages project create frostbite-helper --production-branch main
npx wrangler kv namespace create SAVES   # paste the printed id into wrangler.jsonc -> kv_namespaces
npx wrangler pages deploy --branch main   # config-based: reads wrangler.jsonc (site/ assets + functions/ + KV binding)
```

**Redeploys** use `npx wrangler pages deploy --branch main` from the repo root — it reads
`wrangler.jsonc` (`pages_build_output_dir: "site"`, the `SAVES` KV binding) and bundles the Pages
Function at **`functions/`** (note: in config mode the Function lives at the REPO-ROOT `functions/`,
NOT `site/functions/`). The save Function needs the KV binding, so deploy via the config (not a bare
`pages deploy site`).

This returns a `https://frostbite-helper.pages.dev` URL. Then attach the custom
domain (Cloudflare dashboard → Workers & Pages → frostbite-helper → Custom domains
→ add `redcaphelper.haddeya.com`; the CNAME is created automatically since the zone is
on the same account), or via API.

Alternative auth (headless / CI): set a scoped API token instead of `wrangler login`:
```bash
export CLOUDFLARE_API_TOKEN=...     # Pages: Edit + (for custom domain) Zone DNS: Edit
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages deploy --branch main
```

## Access passphrase
Default is set as a SHA-256 hash in `site/config.js` (plaintext not stored).
To change it:
```bash
node tools/hash.js "your new passphrase"
# paste the hex into site/config.js -> passphraseSha256, redeploy
```
The gate is a **soft deterrent only** (client-side); it is not access control.
For real restriction, put the Pages project behind **Cloudflare Access** (Zero Trust)
limited to your org — that can be added later without code changes.

## Updating after a REDCap survey change
**Frostbite form:**
1. Re-fetch the survey HTML into `tools/survey.html`.
2. `python3 tools/parse_survey.py` (regenerates `site/dictionary.json` + `.js`; it
   **exits non-zero** if the survey uses a field type / branching the app doesn't handle).

**Hennepin calculator:**
1. Re-fetch the calculator HTML into `tools/survey_hhr.html`.
2. `python3 tools/parse_hhr.py` (regenerates `site/dict_hhr.js`, `site/hhr_calc.js`,
   and `site/hhr_maps.js`; it bakes REDCap's `Calculations.jsCode` verbatim so the
   score stays exact, and re-parses the clickable image-map geometry). If the survey's
   figure images changed, the script prints their imgur URLs — re-download them into
   `site/hhr/img/{lh,rh,lf,rf,proximal}.jpg`.

**Both:** test, then redeploy.
3. `node tools/test_datemask.js && node tools/test_ilop.js && node tools/test_branching.js && node tools/test_hhr_calc.js && node tools/test_ui.js && node tools/test_hhr_ui.js && node tools/test_grade_autofill_ui.js && node tools/test_ilop_ui.js && node tools/test_features_ui.js && node tools/test_cryptosave.js && node tools/test_save.js && node tools/test_recordstate.js && node tools/test_bridge_ui.js && node tools/test_bridge_lib.mjs && node tools/verify_vendor.js`
   (and `node tools/test_roundtrip.js` for the live REDCap round-trip — needs network.)
4. Redeploy site: `npx wrangler pages deploy --branch main`

## Optional: REDCap Save-&-Return bridge Worker (`worker/`)
The `worker/` directory is now an **optional** background Worker that makes the app's
save code the SAME code as REDCap's native "Save & Return Later" return code, both
directions — driving the public survey with a headless browser (Cloudflare Browser
Rendering; free on the Workers Free plan), **no REDCap API token**. It serves only
`/api/code` on a route that overlaps this Pages site (so the app calls it same-origin;
CSP `connect-src 'self'` is unchanged). If it is NOT deployed, the app silently falls
back to the legacy random save code — nothing breaks. This path is **not**
zero-knowledge (plaintext chart values pass through the Worker); put the site + the
`/api/code` route behind **Cloudflare Access**. Full setup, trust-model, and the live
selector-locking procedure are in **`REDCAP_BRIDGE.md`**. Quick deploy:
```bash
cd worker && npm install && npx wrangler deploy   # needs Browser Rendering enabled + route zone set
```
