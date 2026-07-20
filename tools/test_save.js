/*
 * Offline tests for functions/api/save.js (no network, no Miniflare). Loads the Pages
 * Function's exported handlers into Node by stripping the `export` keywords, then exercises
 * them with a mocked KV (env.SAVES) and mocked Request. Covers the tightened input
 * validation (malformed writes are rejected at the boundary) and the GET/DELETE round-trip — a gap the rest of the
 * suite left untested (test_features_ui mocks the network with a Map and never runs save.js).
 */
const fs = require('fs'), path = require('path');
const SAVE = path.join(path.dirname(__dirname), 'functions', 'api', 'save.js');
const src = fs.readFileSync(SAVE, 'utf8').replace(/export\s+/g, '');
const { onRequestPost, onRequestGet, onRequestDelete } =
  (new Function(src + '\nreturn { onRequestPost, onRequestGet, onRequestDelete };'))();

let fails = 0;
function ok(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { fails++; console.log('  ✗ ' + msg); } }
function makeKV() { const m = new Map(); return { get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; }
function postReq(body) { return { json: async () => body }; }
function urlReq(qs) { return { url: 'https://x.example/api/save' + qs }; }

const goodCt = 'A'.repeat(40), goodIv = 'B'.repeat(16), goodSalt = 'C'.repeat(22);

(async function () {
  console.log('POST validation + round-trip:');
  const env = { SAVES: makeKV() };

  let r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt }), env });
  let j = await r.json();
  ok(r.status === 200 && typeof j.id === 'string' && j.id.length === 8, 'valid blob -> 200 + 8-char id');
  const id = j.id;

  r = await onRequestGet({ request: urlReq('?id=' + id), env }); j = await r.json();
  ok(r.status === 200 && j.ct === goodCt && j.iv === goodIv && j.salt === goodSalt, 'GET returns the stored blob');

  console.log('POST rejects malformed payloads (F-15):');
  r = await onRequestPost({ request: postReq({ ct: 'bad ct with spaces ' + 'x'.repeat(30), iv: goodIv, salt: goodSalt }), env });
  ok(r.status === 400, 'non-base64url ct -> 400');
  r = await onRequestPost({ request: postReq({ ct: 'AAAA', iv: goodIv, salt: goodSalt }), env });
  ok(r.status === 400, 'too-short ct -> 400');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: '', salt: goodSalt }), env });
  ok(r.status === 400, 'empty iv -> 400');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: 'B'.repeat(80), salt: goodSalt }), env });
  ok(r.status === 400, 'over-long iv -> 400');
  r = await onRequestPost({ request: postReq({ ct: 123, iv: goodIv, salt: goodSalt }), env });
  ok(r.status === 400, 'non-string ct -> 400');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: 'has/slash+plus==' }), env });
  ok(r.status === 400, 'non-base64url salt -> 400');

  console.log('GET/DELETE id validation + lifecycle:');
  r = await onRequestGet({ request: urlReq('?id=' + encodeURIComponent('../secret')), env });
  ok(r.status === 400, 'GET non-alnum id -> 400');
  r = await onRequestGet({ request: urlReq('?id=ZZZZZZZZ'), env });
  ok(r.status === 404, 'GET unknown id -> 404');
  r = await onRequestDelete({ request: urlReq('?id=' + encodeURIComponent('a b')), env });
  ok(r.status === 400, 'DELETE non-alnum id -> 400');
  r = await onRequestDelete({ request: urlReq('?id=' + id), env });
  ok(r.status === 204, 'DELETE valid id -> 204');
  r = await onRequestGet({ request: urlReq('?id=' + id), env });
  ok(r.status === 404, 'GET after DELETE -> 404');

  console.log('anchored client-supplied id (bridge REDCap code):');
  // Without the rc:<ID> anchor the bridge writes, a client-chosen id is refused.
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt, id: 'REDCODE12' }), env });
  ok(r.status === 403, 'unanchored client id -> 403 (no squatting)');
  // Simulate the bridge anchoring the code, then the app storing its blob under it.
  await env.SAVES.put('rc:REDCODE12', JSON.stringify({ v: 1 }));
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt, id: 'REDCODE12' }), env });
  j = await r.json();
  ok(r.status === 200 && j.id === 'REDCODE12', 'anchored id -> 200, stored under that code');
  r = await onRequestGet({ request: urlReq('?id=REDCODE12'), env }); j = await r.json();
  ok(r.status === 200 && j.ct === goodCt, 'GET returns the blob stored under the code');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt, id: 'bad id!' }), env });
  ok(r.status === 400, 'malformed client id -> 400');
  // lowercase is normalized to the uppercase anchor
  await env.SAVES.put('rc:LOWER123', JSON.stringify({ v: 1 }));
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt, id: 'lower123' }), env });
  j = await r.json();
  ok(r.status === 200 && j.id === 'LOWER123', 'client id normalized to uppercase anchor');

  console.log('v3 per-record-key blobs (no salt; dtok-gated):');
  const env3 = { SAVES: makeKV() };
  const dtokA = 'a'.repeat(64), dtokB = 'b'.repeat(64), goodCt2 = 'D'.repeat(50);

  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv }), env: env3 });
  ok(r.status === 400, 'v3 POST (no salt) without dtok -> 400');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, dtok: 'nothex' }), env: env3 });
  ok(r.status === 400, 'v3 POST with malformed dtok -> 400');

  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, dtok: dtokA }), env: env3 });
  j = await r.json();
  ok(r.status === 200 && typeof j.id === 'string' && j.id.length === 8, 'valid v3 blob -> 200 + 8-char id');
  const v3id = j.id;
  r = await onRequestGet({ request: urlReq('?id=' + v3id), env: env3 }); j = await r.json();
  ok(r.status === 200 && j.ct === goodCt && j.iv === goodIv && j.v === 3 && j.salt === undefined, 'GET v3 returns {ct,iv,v:3}, no salt');

  r = await onRequestDelete({ request: urlReq('?id=' + v3id), env: env3 });
  ok(r.status === 403, 'DELETE v3 without dtok -> 403');
  r = await onRequestDelete({ request: urlReq('?id=' + v3id + '&dtok=' + dtokB), env: env3 });
  ok(r.status === 403, 'DELETE v3 with wrong dtok -> 403');
  r = await onRequestDelete({ request: urlReq('?id=' + v3id + '&dtok=' + dtokA), env: env3 });
  ok(r.status === 204, 'DELETE v3 with correct dtok -> 204');
  r = await onRequestGet({ request: urlReq('?id=' + v3id), env: env3 });
  ok(r.status === 404, 'GET after v3 DELETE -> 404');

  console.log('v3 overwrite authorization (anchored REDCap code):');
  await env3.SAVES.put('rc:RCV3CODE', JSON.stringify({ v: 1 }));
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, dtok: dtokA, id: 'RCV3CODE' }), env: env3 });
  j = await r.json();
  ok(r.status === 200 && j.id === 'RCV3CODE', 'first v3 save under an anchored code -> 200');
  r = await onRequestPost({ request: postReq({ ct: goodCt2, iv: goodIv, dtok: dtokA, id: 'RCV3CODE' }), env: env3 });
  ok(r.status === 200, 're-save with the matching dtok -> 200 (updates one record)');
  r = await onRequestGet({ request: urlReq('?id=RCV3CODE'), env: env3 }); j = await r.json();
  ok(j.ct === goodCt2, 'the record was overwritten with the new ciphertext');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, dtok: dtokB, id: 'RCV3CODE' }), env: env3 });
  ok(r.status === 403, 'overwrite with a DIFFERENT dtok -> 403 (no clobber)');

  console.log('legacy v2 row self-migrates to v3 on overwrite:');
  await env3.SAVES.put('rc:RCMIG777', JSON.stringify({ v: 1 }));
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt, id: 'RCMIG777' }), env: env3 });
  ok(r.status === 200, 'seed a legacy v2 row (no dtok) under the anchored code');
  r = await onRequestPost({ request: postReq({ ct: goodCt2, iv: goodIv, dtok: dtokA, id: 'RCMIG777' }), env: env3 });
  ok(r.status === 200, 'v3 overwrite of a dtok-less v2 row -> 200 (migration allowed)');
  r = await onRequestGet({ request: urlReq('?id=RCMIG777'), env: env3 }); j = await r.json();
  ok(j.v === 3 && j.ct === goodCt2 && j.salt === undefined, 'the row is now v3 (no salt)');

  console.log('storage binding guard:');
  r = await onRequestPost({ request: postReq({ ct: goodCt, iv: goodIv, salt: goodSalt }), env: {} });
  ok(r.status === 503, 'missing KV binding -> 503');

  console.log(fails ? ('\nFAIL: ' + fails + ' assertion(s) failed.') : '\nPASS: save.js validation + GET/DELETE lifecycle correct.');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('ERROR', e); process.exit(2); });
