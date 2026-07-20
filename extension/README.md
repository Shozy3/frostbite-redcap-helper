# Frostbite REDCap Helper — browser extension

This folder is the **Manifest V3 browser extension** half of the [Frostbite
REDCap Helper](../README.md) project. For the other half (the standalone web
app at [redcaphelper.haddeya.com](https://redcaphelper.haddeya.com)) and the
full project overview, see the [repo-root README](../README.md).

The extension injects **only** on the target high-grade-frostbite chart-audit
survey — `https://redcap.ualberta.ca/surveys/*` — and does nothing on any
other page.

## What it does

- **Reshapes one long survey into 7 logical tabs, in place.** REDCap's own
  fields are never moved, cloned, or altered — the extension only shows/hides
  the rows that belong to each tab, so REDCap's own branching logic and
  validation keep working underneath, exactly as they would with the
  extension off. The 7 tabs are:
  1. Patient & Demographics
  2. Presentation & Assessment
  3. Frostbite Grading
  4. Amputation
  5. Medications
  6. Imaging & Consults
  7. Disposition & Follow-up
- **A live "required fields" progress bar** that updates as you fill in the
  form, plus a per-tab completion indicator.
- **A "Review missing" jump list** — lists every blank required field and
  jumps you straight to it (tab + scroll + highlight) when clicked.
- **Date pre-fill** for a handful of date fields, applied only when a field is
  still empty — it never overwrites anything you've typed or REDCap has
  saved.

It makes **no network calls** and uses **no storage** — no localStorage, no
sessionStorage, no cookies, nothing. It only ever reads and reorganizes the
DOM of the one survey page it's scoped to.

## Install (Chrome / Edge)

1. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder (the one
   containing `manifest.json`).
4. It appears as **Frostbite REDCap Helper**. It will only activate when you
   open the target REDCap survey.

To update after pulling new changes, click the reload icon on the extension's
card and reload the survey tab. To remove it, click **Remove** on the card.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 config — scopes the content script to `https://redcap.ualberta.ca/surveys/*`. |
| `content.js` | Reads the survey's existing fields, builds the 7 tabs, tracks required-field progress, and applies date pre-fill. |
| `styles.css` | Styling for the tab bar, progress bar, and review-missing panel. |

## Privacy

The extension makes no network requests and uses no storage of any kind
(localStorage, sessionStorage, cookies, IndexedDB). It only reads and
reorganizes fields already present on the page. See
[../docs/TESTING.md](../docs/TESTING.md) for the DevTools verification
checklist (confirming zero network activity and empty storage while the
extension runs).

---

Part of the [Frostbite REDCap Helper](../README.md) project by Shahzaib Ahmed
and Haddeya Sultani, licensed under the [MIT License](../LICENSE).
