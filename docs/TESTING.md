# Test plan — Frostbite REDCap Helper (tabbed view)

Use a **blank / test** survey record; don't use real patient data while testing.

## 1. Branching + date (MOST IMPORTANT)
- [ ] On load, **no** "SURVEY ERRORS EXIST / Branching Logic errors" message.
- [ ] Open **Date of Birth**: the **Today** button works, the calendar opens,
      and picking a date does **not** jump to a wrong year (2099) and does **not**
      trigger a branching error.
- [ ] Answer a question that reveals dependent fields (e.g. **Iloprost given →
      Yes**): the dependent fields appear (on the same tab).
- [ ] Answer one that hides fields: they hide. Behavior matches Chrome with the
      extension off.

## 2. Tabs
- [ ] A tab bar shows at the top: Patient & Demographics, Presentation &
      Assessment, Frostbite Grading, Amputation, Medications, Imaging & Consults,
      Disposition & Follow-up, plus a Submit tab.
- [ ] Clicking a tab shows only that tab's questions and hides the others.
- [ ] **Medications** tab shows the meds together: rewarming, NSAID dosing grid,
      non-NSAID pain control, iloprost (+ its branch fields), alteplase (+ its
      branch fields), heparin, tetanus, antibiotics, aloe vera.
- [ ] The **NSAID dosing grid** and the **hand/foot/digit grids** look correct
      (column headers aligned) on their tabs.
- [ ] No question is missing from all tabs. (Every field appears on exactly one
      tab; if something seems gone, check the Medications/Follow-up tabs and
      report it.)

## 3. Required-field tracker
- [ ] Progress bar starts at a sensible `0 / N`.
- [ ] Filling a required field increases the count and turns that row's left
      edge green.
- [ ] Each tab's badge shows the number of required fields still missing on that
      tab; turns to a green check when that tab is complete.
- [ ] Branch-hidden required fields are **not** counted. Reveal/hide a branch and
      watch the total adjust.

## 4. Review missing
- [ ] **Review missing** lists blank required fields grouped by tab.
- [ ] Clicking an item switches to that tab, scrolls to the field, highlights it,
      and focuses its input.
- [ ] When all required fields are filled, it reports none missing.

## 4b. Date pre-fill
- [ ] On a blank form, **all** date fields are pre-filled to today's day/month
      with year **2099**: Date of Birth as a date (e.g. 18-06-2099), and ED
      arrival / MD assessment / rewarming time as date+time (e.g. 18-06-2099
      00:00).
- [ ] Date of Birth shows no format error (it's filled date-only, not with a
      time).
- [ ] Pre-filled dates are accepted by REDCap (no format error on the field).
- [ ] If a date field already has a value (e.g. after Save & Return), it is **not**
      overwritten.
- [ ] Picking a different date in a pre-filled field still works normally (no
      jump, no freeze).

## 5. Submit
- [ ] **Go to Submit** (and the Submit tab) scrolls to REDCap's own Submit /
      Save & Return Later buttons, which are always visible.
- [ ] Save & Return Later works. Submitting with a blank required field still
      shows REDCap's own validation. A valid submit completes.

## 6. Resilience
- [ ] Reload: exactly one tab bar (no duplicates).
- [ ] No uncaught extension errors in the Console (REDCap's own messages are
      unrelated).

## 7. Privacy / security (do this)
DevTools (**F12**):
- [ ] **Network**: interacting with the form produces no requests from
      `content.js`; only REDCap's own traffic.
- [ ] **Console**:
  - `Object.keys(localStorage).filter(k => /fbh|frostbite/i.test(k))` → `[]`
  - `Object.keys(sessionStorage).filter(k => /fbh|frostbite/i.test(k))` → `[]`
  - `indexedDB.databases && indexedDB.databases().then(d => console.log(d.filter(x => /fbh|frostbite/i.test(x.name))))` → empty
  - `document.cookie` → no fbh/frostbite cookie
- [ ] Code: `content.js` has no `fetch`/`XMLHttpRequest`/`sendBeacon`/`WebSocket`/
      storage/`cloneNode` outside comments; no `innerHTML`; the only DOM
      insertions target the extension's own elements (its root). Tab switching is
      `classList.toggle` on existing rows — no row is moved.

## Notes
- The tracker is a convenience, not a validator; REDCap remains the source of
  truth for required fields and validity.
- Because no field is moved, if a future REDCap change alters the survey, at
  worst a field lands on the wrong tab or the counts look off — the form keeps
  working. Report it and the tab mapping can be updated.
