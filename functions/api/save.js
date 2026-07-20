/*
 * Cloudflare Pages Function — save-code blob store for the helper.
 *
 * Stores ONLY the client-encrypted { ct, iv } in KV (binding SAVES). Each record is
 * encrypted in the browser under its OWN random 256-bit key (see site/cryptosave.js).
 * That key never reaches here — it lives only inside the save code the user copies
 * (the part after the dot). So neither this function nor Cloudflare can decrypt a
 * blob, and one leaked code exposes exactly one record. Records persist until deleted
 * (no TTL). Same-origin (/api/save), so no CORS.
 *
 *   POST   /api/save   {ct, iv, dtok}       -> { id }   (fresh 8-char lookup id)
 *   POST   /api/save   {ct, iv, dtok, id}   -> { id }   (store under a REDCap return
 *          code — accepted ONLY if KV holds the rc:<ID> anchor the bridge Worker wrote,
 *          so clients can't squat ids). Lets one code carry BOTH the REDCap-side chart
 *          data and the app-only Hennepin/Iloprost state.
 *   GET    /api/save?id=ID                  -> { ct, iv, v }   (404 if missing/deleted)
 *   DELETE /api/save?id=ID&dtok=DTOK        -> 204  (blob only; the REDCap record and
 *          the rc:<ID> anchor are untouched — the code still resumes on REDCap)
 *
 * dtok = SHA-256(record key), lowercase hex. It is the delete/overwrite capability:
 * the server stores it and requires a caller to present the matching dtok to overwrite
 * or delete an existing record — proving key possession WITHOUT ever seeing the key
 * (closes the former unauthenticated-delete gap). GET stays id-only, which is safe: the
 * ciphertext is inert without the key. Input validation rejects malformed writes.
 *
 * Legacy v2 blobs ({ct, iv, salt}, passphrase-derived) are still ACCEPTED on write and
 * readable on GET so an already-open tab keeps working across an atomic Pages deploy;
 * the shipping client only ever writes v3.
 */
const MAX_CT = 512 * 1024;            // ciphertext cap (a full 3-form blob is a few KB)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/1/I/O (unambiguous)
const B64URL = /^[A-Za-z0-9_-]+$/;    // ct/iv/salt are base64url, no padding — see site/cryptosave.js
const ID_RE  = /^[A-Za-z0-9]+$/;      // lookup ids are alphanumeric (superset of newId's ALPHABET)
const DTOK_RE = /^[0-9a-f]{64}$/;     // SHA-256(key) hex

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
function newId() {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  let s = ''; for (let i = 0; i < 8; i++) s += ALPHABET[a[i] % 32];
  return s; // 8 chars, ~40 bits
}

export async function onRequestPost({ request, env }) {
  if (!env.SAVES) return json({ error: 'storage_unavailable' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
  const ct = body && body.ct, iv = body && body.iv, salt = body && body.salt, dtok = body && body.dtok;
  // ct/iv are always required. Validate strictly: correct types, base64url charset, and
  // length bounds matching the client's AES-GCM output (12-byte IV -> 16 chars; ct is KBs).
  if (typeof ct !== 'string' || typeof iv !== 'string'
      || ct.length < 24 || ct.length > MAX_CT || !B64URL.test(ct)
      || iv.length < 16 || iv.length > 64 || !B64URL.test(iv)) {
    return json({ error: 'bad_payload' }, 400);
  }
  // Version by shape: a salt means a legacy v2 (passphrase) blob; no salt means a v3
  // per-record-key blob, which MUST carry a dtok so it can later be deleted/overwritten.
  let v;
  if (typeof salt === 'string') {
    if (salt.length < 16 || salt.length > 64 || !B64URL.test(salt)) return json({ error: 'bad_payload' }, 400);
    v = 2;
  } else if (salt == null) {
    if (typeof dtok !== 'string' || !DTOK_RE.test(dtok)) return json({ error: 'bad_payload' }, 400);
    v = 3;
  } else {
    return json({ error: 'bad_payload' }, 400);
  }
  let id;
  if (body.id != null) {
    // Client-supplied id: allowed ONLY for codes the /api/code bridge minted and
    // anchored in KV (rc:<CODE>). Anything else is rejected so callers cannot squat
    // weak/predictable ids or clobber other users' random ids.
    id = String(body.id).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(id)) return json({ error: 'bad_id' }, 400);
    if ((await env.SAVES.get('rc:' + id)) === null) return json({ error: 'unanchored_id' }, 403);
  } else {
    id = newId();
    let tries = 0;
    while ((await env.SAVES.get(id)) !== null && tries++ < 6) id = newId(); // avoid the (tiny) collision chance
  }
  // Overwrite authorization: if a record already lives at this id and it carries a dtok
  // (a v3 record), the caller must present the matching dtok. A legacy v2 row (no dtok)
  // may be overwritten — that's how a re-save self-migrates it to v3.
  const existingRaw = await env.SAVES.get(id);
  if (existingRaw) {
    let ex; try { ex = JSON.parse(existingRaw); } catch (e) { ex = null; }
    if (ex && ex.dtok && dtok !== ex.dtok) return json({ error: 'dtok_mismatch' }, 403);
  }
  // No TTL is set, so saved forms persist until the user explicitly deletes them.
  const rec = { ct: ct, iv: iv, v: v };
  if (v === 2) rec.salt = salt;
  if (typeof dtok === 'string') rec.dtok = dtok;
  await env.SAVES.put(id, JSON.stringify(rec));
  return json({ id: id });
}

export async function onRequestGet({ request, env }) {
  if (!env.SAVES) return json({ error: 'storage_unavailable' }, 503);
  const id = new URL(request.url).searchParams.get('id');
  if (!id || id.length > 64 || !ID_RE.test(id)) return json({ error: 'bad_id' }, 400);
  const raw = await env.SAVES.get(id);
  if (!raw) return json({ error: 'not_found' }, 404);
  let rec; try { rec = JSON.parse(raw); } catch (e) { return json({ error: 'corrupt' }, 500); }
  // Inert without the record key. salt is present only for legacy v2 blobs; omitted (undefined) for v3.
  return json({ ct: rec.ct, iv: rec.iv, salt: rec.salt, v: rec.v });
}

export async function onRequestDelete({ request, env }) {
  if (!env.SAVES) return json({ error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id || id.length > 64 || !ID_RE.test(id)) return json({ error: 'bad_id' }, 400);
  const raw = await env.SAVES.get(id);
  if (!raw) return new Response(null, { status: 204 });   // idempotent no-op (no existence oracle beyond GET's)
  let rec; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  // A v3 record (has dtok) can only be deleted by proving key possession. Legacy v2
  // rows (no dtok) delete unconditionally, matching prior behavior.
  if (rec && rec.dtok && url.searchParams.get('dtok') !== rec.dtok) return json({ error: 'dtok_mismatch' }, 403);
  await env.SAVES.delete(id);
  return new Response(null, { status: 204 });
}
