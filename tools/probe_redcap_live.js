/*
 * Live probe for the REDCap bridge Worker — locks the one piece that can't be known
 * without saving to the real survey: WHERE REDCap prints the return code on its
 * post-save confirmation page.
 *
 * It calls the Worker's PROBE endpoint (enabled only when the Worker is deployed/run
 * with env PROBE=1), which does one real Save & Return Later and reports the code it
 * found, the surrounding confirmation HTML, and a resume read-back.
 *
 *   1. Run the Worker with PROBE on:
 *        cd worker && PROBE=1 npx wrangler dev        # local (uses real Browser Rendering)
 *      or set the PROBE=1 var on the deployed Worker temporarily.
 *   2. node tools/probe_redcap_live.js [baseUrl]
 *        baseUrl default http://localhost:8787  (use your https domain for a deployed probe)
 *   3. Read the output:
 *        - foundCode present + resumeScrape shows your fields  -> defaults work, done.
 *        - otherwise pick a stable CSS selector from confirmationHtmlSnippet and set
 *          RETURN_CODE_SELECTOR on the Worker.
 *   4. DELETE the "PROBE-DELETE-ME" test record in REDCap, then UNSET PROBE.
 *
 * Creates ONE throwaway record. Do not run against a project you can't clean up.
 */
const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const url = base + '/api/code';

(async function () {
  if (typeof fetch !== 'function') {
    console.error('Needs Node 18+ (global fetch).'); process.exit(2);
  }
  console.log('POST ' + url + '  {probe:true}\n(this performs one real Save & Return Later on the survey)\n');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ probe: true })
    });
  } catch (e) {
    console.error('Request failed:', e.message);
    console.error('Is the Worker running with PROBE=1? (cd worker && PROBE=1 npx wrangler dev)');
    process.exit(1);
  }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  if (res.status === 400 && body && body.error === 'bad_payload') {
    console.error('HTTP 400 bad_payload — is PROBE=1 set on the Worker? (probe is gated by it)');
    process.exit(1);
  }
  if (!res.ok && !(body && body.probe)) {
    console.error('HTTP ' + res.status + ':', body);
    process.exit(1);
  }
  console.log('foundCode:        ', JSON.stringify(body.foundCode));
  console.log('resumeScrape:     ', JSON.stringify(body.resumeScrape));
  console.log('\nbodyTextSample:\n' + (body.bodyTextSample || '(none)'));
  console.log('\nconfirmationHtmlSnippet (pick a stable selector for the code from here):\n');
  console.log(body.confirmationHtmlSnippet || '(none)');
  console.log('\n--- ' + (body.note || '') + ' ---');
  const codeOk = !!body.foundCode;
  const resumeOk = body.resumeScrape && Object.keys(body.resumeScrape || {}).length > 0;
  if (codeOk && resumeOk) {
    console.log('\nOK: return-code extraction AND resume both worked. No selector overrides needed.');
  } else if (!codeOk) {
    console.log('\nACTION: the return code was NOT found on the confirmation page — set RETURN_CODE_SELECTOR');
    console.log('        from a stable element in the snippet above.');
  } else {
    // Code found but resume/scrape failed -> the problem is the RESUME form, not the code scrape.
    console.log('\nACTION: the return code WAS found, but resuming it did not read any fields back.');
    console.log('        This points at the resume form, NOT the return-code selector. Check the');
    console.log('        __return=1 page and, if its markup differs from the defaults, set');
    console.log('        RETURN_FORM_SELECTOR and/or RETURN_CODE_INPUT_SELECTOR.');
  }
  process.exit(0);
})();
