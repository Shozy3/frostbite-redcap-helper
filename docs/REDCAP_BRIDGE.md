# REDCap Save-&-Return bridge (shared save codes)

This makes the web app's **save code the same code REDCap uses** for its native
**Save & Return Later** feature, in **both directions** — without a REDCap API token.

- **Save in the app → get REDCap's code.** When you click *Save & get code*, the
  app sends the Chart Audit fields to a background Cloudflare **Worker**. The Worker
  drives the real public survey with a headless browser (Cloudflare Browser
  Rendering): it prefills the survey, clicks REDCap's own *Save & Return Later*, and
  reads back the **return code REDCap generated**. That code is what the app shows
  you. Enter it on the real REDCap survey (**Returning? → enter code**) to continue
  there, or in the app to bring everything back.
- **Resume from a code → the app works backwards.** *Resume from code* first looks
  for the app's encrypted copy; if there isn't one (e.g. the code was created on the
  REDCap side), it asks the Worker to **resume that response in REDCap and read the
  saved field values back out**, then repopulates the Chart Audit form.

The app also keeps its existing three-form encrypted blob (Chart Audit + Hennepin +
Iloprost) under that same code, so one code restores the two calculators too — those
aren't REDCap fields, so a REDCap-born code restores the chart only.

## How it drives REDCap: pure HTTP first, headless browser as fallback

REDCap only ever mints its own return codes — there is no API, URL parameter, or
module that lets an outside system choose or set one (verified against the REDCap
API surface, PyCap/redcapAPI, and the module ecosystem). And you don't have a REDCap
API token. So the only way to obtain REDCap's code and to read a partial response
back is to **use the survey the way a person does**.

**Primary path — plain HTTP (`worker/httpbridge.js`, added 2026-07-09):** a REDCap
survey is a server-rendered HTML form, and everything its JS does on a Save & Return
click is mechanical: copy the button's name into the hidden `submit-action` field,
append `&__return=1` to the form action, convert dates from ISO to the field's
display format (`fv` attribute), and post the form (checkbox state lives in
`__chk__<var>_RC_<code>` hidden inputs; the CSRF token is the `csrfToken` JS global
echoed into `redcap_csrf_token`). The driver replicates exactly those requests with
`fetch()` + HTML parsing: **~1 s per save, no Browser Run, no metered budget, no
429s** — this removed the free tier's 10-browser-minutes/DAY cap that used to 503
every save once spent. Live-verified end-to-end (both directions, re-save with
clear/uncheck) on 2026-07-09.

**Fallback — headless browser (puppeteer + Browser Run):** kept for REDCap
upgrade/markup drift. Used only when the HTTP driver fails BEFORE its save POST
could have created a record (a fresh save whose POST already fired errors instead
of re-driving — duplicate-record safety; re-saves are idempotent and always fall
back). Force it with `HTTP_DRIVER: "off"` for debugging. Free-tier limits when it
runs: 10 browser-min/day, 3 concurrent, 1 new browser per 20 s.

## Trust model — this path is NOT zero-knowledge (by design, owner-approved)

The app's original save codes are zero-knowledge: only ciphertext ever leaves the
browser. **The bridge is different.** Plaintext Chart Audit values pass through the
Worker so it can type them into REDCap, and it reads plaintext back on resume. This
is an accepted trade-off for the interoperability.

**The `/api/code` endpoint is gated by the access passphrase** — the same passphrase
that unlocks the app. The client sends the plaintext passphrase in an `x-fb-pass`
header; the Worker serves the request only if its SHA-256 matches `GATE_SHA256` (the
hash already published in `site/config.js`). Because SHA-256 is preimage-resistant,
knowing the public hash doesn't let anyone forge the header — only holders of the
passphrase can drive the survey or read a code's data. This is what stops a
leaked/guessed return code from being a plaintext-PHI read, and stops scripted record
creation / browser-budget drain, **without requiring a Cloudflare login**.

- **`GATE_SHA256`** (set) — SHA-256 of the access passphrase; identical to
  `site/config.js` `passphraseSha256`. **If you rotate the passphrase, update both.**
  Unset it to disable the gate (e.g. local dev).
- **Best-effort rate limiting** (always on) — per-IP/minute (`RL_PER_MIN`, default 20)
  and account-wide/day (`RL_PER_DAY`, default 400) KV counters cap abuse and daily
  browser-op volume against the 10-min/day budget (approximate; KV is eventually consistent).
- **`workers_dev: false`** — the Worker is reachable only via the custom-domain route,
  not a `*.workers.dev` URL, so the gate can't be sidestepped.
- **`REQUIRE_CF_ACCESS=1`** (optional, off) — if you later add Cloudflare Access for a
  stronger login-based control, set this to also require Access's JWT header.

Trade-off of the passphrase gate: the passphrase is sent to the Worker on each bridge
call, and the Worker types plaintext chart values into the real survey, so this path is
deliberately **not** zero-knowledge (a Cloudflare-as-operator could observe those values
in transit). It does **not**, however, expose the `/api/save` blobs: those are encrypted
under a per-record random key that lives only in the save code and is never sent to any
server (see `functions/api/save.js`). Cloudflare Access is the alternative if you need even
the bridge's plaintext to stay off Cloudflare.

Other mitigating facts:

- The survey is a **public survey link** — anyone with the link can already submit
  to it. The Worker holds **no REDCap credential** (there is none).
- A read-only resume (GET) does **not** grant blob-write rights: the `rc:<CODE>` KV
  marker that lets `/api/save` accept a blob under a code is written only when a save
  actually mints/updates that code, never on a lookup. The Hennepin/Iloprost blob
  stays encrypted-at-rest via `/api/save`.
- `/api/save` DELETE and overwrite now require `dtok = SHA-256(key)` — proof that the
  caller holds the record's key — so a bare code (or a leaked id on its own) can neither
  delete nor clobber a saved blob.

The bridge is **entirely server-side** — the web app calls it same-origin, so no
client-side or CSP changes are needed to use it.

## Integrity — every save is verified

Headless form automation can silently drop a value (branching, a missed field) — or,
on a re-save, fail to *clear* a value the user removed. So the client sends the
**complete** intended state of every visible field (blanks and empty checkbox groups
included), and the Worker both **sets and clears** to match it exactly (unchecking
stale boxes, deselecting stale radios, blanking cleared text), then **independently
resumes the code and diffs REDCap's own saved copy against that full intent** —
normalizing date-format skew (ISO vs DD-MM-YYYY), numeric equality, and checkbox sets
(`worker/lib.js` `diff`). Because the intent is complete, a field the user *cleared*
is verified too, not silently skipped. On a mismatch it **retries once** (resuming and
updating the same record — never a duplicate). The app shows `✓ Verified` or a
**warning listing the fields that didn't match**, so a corrupted save is never
silently trusted. Turn off with `VERIFY_ROUNDTRIP=off` (not recommended).

Errors never strand data: the code is anchored the instant a save yields it (before
verification), and a fresh save is never blindly retried (which could create a
duplicate record) — only an already-obtained code is ever re-driven.

## Speed / throughput

**Primary (HTTP driver): no budget at all.** A verified save is ~4 quick fetches
(load form → save POST → resume → parse), about 1–2 s total; Workers Free allows
100k requests/day, so capacity is effectively unlimited for this tool. Everything
below applies only to the browser FALLBACK when it runs:

- **One browser per request, closed when done:** a save (prefill + Save & Return +
  the verify resume) shares a SINGLE browser, and the Worker `close()`s it as soon
  as the request finishes. It does NOT keep sessions warm: an idle keep-alive
  browser bills its idle seconds against the free **10-min/DAY** budget, which
  capped the whole day at ~6 saves and exhausted the budget in normal use
  (learned live 2026-07-09). Free sessions are still reused if one happens to exist.
- **Creation throttle handling:** the free tier allows **1 new browser per 20 s**.
  On a creation 429 the Worker waits 21 s and retries once; if the retry also 429s,
  the account's DAILY allowance is spent (the daily cap returns the same
  "Rate limit exceeded" message — its Retry-After is the next UTC midnight), and
  the Worker responds `503 {error:'busy', reason:'daily_limit'}`. The app then
  falls back to a legacy app-only save code for fresh sessions (with honest
  wording), refuses to orphan sessions tied to an existing REDCap record, and
  tells resumers when the allowance resets (midnight UTC = 6 PM Edmonton).
- **Per-request isolation:** each request runs in its own incognito context, so
  concurrent saves/resumes never share cookies or session.
- **Resource blocking:** images, fonts, and media are aborted (JS + CSS + XHR kept,
  since REDCap's branching needs them), cutting page-load time and browser-seconds.
- **Hard timeout** per request so a hung page can't drain the budget.
- **Capacity reality check (fallback only):** a browser-driven verified save costs
  ~30–60 browser-seconds, so the free plan supports roughly **10–15 browser saves
  per UTC day**. Irrelevant while the HTTP driver is primary; Workers Paid ($5/mo)
  removes the cap if the fallback ever needs to carry real volume.

## Deploy

The site stays on Cloudflare Pages (`frostbite-helper`). The bridge is a **separate
Worker** (`worker/`) on a route that overlaps the site so the app calls it
same-origin (keeps CSP `connect-src 'self'` — no CSP change needed).

1. **Enable Browser Rendering** on the account (Workers Free is fine). No config
   beyond the `browser` binding already in `worker/wrangler.jsonc`.
2. **Point the route at your zone.** In `worker/wrangler.jsonc` the route is
   `redcaphelper.haddeya.com/api/code*` with `zone_name: haddeya.com`. Adjust if your
   domain differs. The **`*` is required** — an exact `/api/code` pattern only matches
   the bare path, so `/api/code?code=…` and `/api/code/` fall through to the Pages
   project (verified the hard way). The wildcard makes all variants hit the Worker;
   the handler still 404s any path that isn't exactly `/api/code`. Pages keeps serving
   the site and `/api/save`. Because it's same-origin, the app calls `/api/code` with
   no CSP change and no CORS.
3. **Confirm `SURVEY_URL`** in `worker/wrangler.jsonc` matches the app's
   `DICT.post_action` (`site/dictionary.json`) — currently
   `https://redcap.ualberta.ca/surveys/?s=RLREFHHMMWXAEPJJ`.
4. **Deploy the Worker:**
   ```sh
   cd worker
   npm install
   npx wrangler deploy
   ```
5. **Deploy the site** as usual (`npx wrangler pages deploy` per `DEPLOY.md`). No
   site change is required for the bridge to work, but redeploy to pick up the
   updated `app.js`/`payload.js`/`cryptosave.js`.
6. **Access control** is the passphrase gate (`GATE_SHA256`, already set) — no extra
   setup, and the app stays reachable with just the passphrase. Optionally add
   Cloudflare Access + `REQUIRE_CF_ACCESS=1` for a stronger login-based control (Zero
   Trust → Access → application for `redcaphelper.haddeya.com`, policy = your org
   emails) — see the trust-model section for when that's worth it.

If the Worker is **not** deployed, `/api/code` isn't served, the app's fetch fails/
501s, and it **falls back to the legacy random save code** automatically — nothing
breaks, you just don't get REDCap interop.

## Validate live (lock the one fragile piece)

**Already done for this survey (2026-07-08).** A live probe confirmed the return code
is the readonly input `input[aria-labelledby="return-step1"]` on REDCap's post-save
confirmation, and `RETURN_CODE_SELECTOR` is set to it in `worker/wrangler.jsonc`. A
real end-to-end save returned `{code, verified:true}`, so extraction, resume, and
verification all work against the live survey. You only need to re-run the probe if
the survey's confirmation/resume markup changes. To re-lock:

1. Temporarily set `PROBE=1` (dashboard var or `wrangler dev`).
2. Send one probe request (creates a throwaway record):
   ```sh
   curl -X POST https://redcaphelper.haddeya.com/api/code \
     -H 'content-type: application/json' -d '{"probe":true}'
   ```
   Locally instead: `cd worker && npx wrangler dev`, then curl `http://localhost:8787/api/code`.
3. The response includes `foundCode`, a `confirmationHtmlSnippet`, and a
   `resumeScrape`, and the script tells you which of two things (if any) to fix:
   - `foundCode` empty → set **`RETURN_CODE_SELECTOR`** from the snippet (the code
     isn't where the text-proximity heuristic looked).
   - `foundCode` present but `resumeScrape` empty → the **resume form** differs from
     the defaults; set **`RETURN_FORM_SELECTOR`** and/or **`RETURN_CODE_INPUT_SELECTOR`**
     (defaults `#return_code_form` / `input[name=__code]`).
4. **Delete the `PROBE-DELETE-ME` test record** in REDCap, then **unset `PROBE`**.

Also confirm the survey settings: **Save & Return Later enabled**, "Allow
respondents to return **without** a return code" **off**, and pre-filling allowed
(the app's existing "Open populated REDCap form" already relies on prefill).

## Files

| File | Role |
|------|------|
| `worker/index.js` | Bridge Worker: `/api/code` POST (save→code, verified) and GET (code→values); HTTP driver first, browser fallback. |
| `worker/httpbridge.js` | PRIMARY driver: pure-HTTP form save/resume (fetch + HTML parsing, no Browser Run). |
| `worker/lib.js` | Pure logic: payload validation, intended-state, date/number/checkbox diff. |
| `worker/wrangler.jsonc` | Browser + KV bindings, route, vars (`HTTP_DRIVER: "off"` forces the browser fallback). |
| `functions/api/save.js` | Unchanged blob store; now also accepts an **anchored** client id (a bridge-minted code) so one code carries the encrypted three-form blob. |
| `site/payload.js` | `buildPayload` (fresh prefill) + `buildIntended` (complete visible-field spec for clear+verify) + `recordToState` (inverse, for bridge resume). |
| `site/app.js` | Save/resume wired bridge-first with legacy fallback; sends `{payload, intended, code?}`; provenance-tracked re-saves; verify/warn UI. |
| `tools/test_bridge_lib.mjs`, `tools/test_bridge_ui.js`, `tools/test_httpbridge.mjs` | Offline tests (the last pins the HTTP driver's parsing against `tools/survey.html`). |
| `tools/test_bridge_live.js` | LIVE end-to-end test through the deployed Worker (creates a test record — delete it). |
| `tools/test_httpbridge_live.mjs` | LIVE test of the HTTP driver directly from Node, no Cloudflare (creates a test record — delete it). |
