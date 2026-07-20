// The worker/ directory is now the REDCap "Save & Return Later" bridge (browser
// automation via Cloudflare Browser Rendering). Its code can't run in plain Node
// (it imports @cloudflare/puppeteer, a Workers-only module), so it is exercised by:
//   - tools/test_bridge_lib.mjs  — the Worker's pure logic (validation, diff, dates)
//   - tools/test_bridge_ui.js    — the client wiring in site/app.js against a mock
//   - tools/probe_redcap_live.js — the real headless flow against the live survey
// This file stays a no-op skip so the offline suite never touches the network.
console.log('SKIP: test_worker — bridge Worker logic is covered by test_bridge_lib.mjs / test_bridge_ui.js; live flow by probe_redcap_live.js.');
process.exit(0);
