/*
 * Client-side encryption for the cross-computer save code.
 *
 * KEY MODEL (v3): every saved record gets its OWN random 256-bit AES-GCM key,
 * generated in the browser with crypto.getRandomValues. The key is NEVER sent to
 * the server — it travels only inside the save code the user copies, as the part
 * AFTER the dot:  <id>.<base64url(key)>. Only { ct, iv } are uploaded, so neither
 * this app's server nor Cloudflare can ever decrypt a stored blob, and one leaked
 * code exposes exactly one record. Because the key is uniformly random there is no
 * low-entropy secret to stretch, so v3 uses NO PBKDF2 and NO salt.
 *
 * Delete/overwrite of a stored blob is authorized with dtok = SHA-256(key): the
 * server stores dtok and requires a caller to prove knowledge of the key (present
 * the same dtok) before it will overwrite or delete — without ever seeing the key.
 *
 * The gate passphrase is NOT involved in encryption anymore (it is only a soft UI
 * gate + the bridge's x-fb-pass header). The passphrase-based helpers below
 * (deriveKey / encryptWithPass / decryptWithPass) are retained as generic crypto
 * primitives — the app no longer uses them to save/restore data.
 *
 * UMD-style export (window.FBCRYPTO); Node's global webcrypto satisfies crypto.subtle
 * so the exact code is unit-tested in Node.
 */
(function (g) {
  'use strict';
  var subtle = (g.crypto && g.crypto.subtle) ? g.crypto.subtle : null;
  var PBKDF2_ITERS = 150000;

  function getRandom(n) { var a = new Uint8Array(n); g.crypto.getRandomValues(a); return a; }
  function b64urlFromBytes(bytes) {
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return g.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function bytesFromB64url(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '=';
    var bin = g.atob(str), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  // ---------------- v3: per-record random key (the shipping scheme) ----------------

  // A fresh, uniformly-random 256-bit AES-GCM key for one saved record.
  function generateKeyBytes() { return getRandom(32); }
  // The key <-> the base64url suffix carried in the save code (43 chars, no padding).
  function keyToCode(bytes) { return b64urlFromBytes(bytes); }
  function keyFromCode(str) { return bytesFromB64url(str); }

  function importAesKey(rawBytes) {
    return subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // Encrypt a JSON-able object under a raw 256-bit key -> { ct, iv } (base64url). No salt.
  function encryptWithKey(obj, rawKeyBytes) {
    var iv = getRandom(12);
    return importAesKey(rawKeyBytes).then(function (key) {
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ctBuf) {
      return { ct: b64urlFromBytes(new Uint8Array(ctBuf)), iv: b64urlFromBytes(iv) };
    });
  }

  // Decrypt (ct, iv) under a raw key -> the object. Rejects on a wrong key or tampered
  // blob (AES-GCM is authenticated).
  function decryptWithKey(ctB64, ivB64, rawKeyBytes) {
    return importAesKey(rawKeyBytes).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64url(ivB64) }, key, bytesFromB64url(ctB64));
    }).then(function (ptBuf) {
      return JSON.parse(new TextDecoder().decode(ptBuf));
    });
  }

  // dtok = SHA-256(key) as lowercase hex — the delete/overwrite capability token stored
  // server-side. Given dtok you cannot recover the key, but the key's holder can prove
  // possession by presenting the matching dtok.
  function dtokFromKeyBytes(rawKeyBytes) {
    return subtle.digest('SHA-256', rawKeyBytes).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  // Split a user-facing save code "<id>.<key>" into its parts. The id half is normalized
  // exactly like a bare code (uppercase, alnum, capped at 16 — matches REDCap's return
  // code + the legacy 8-char id). The key half preserves case (base64url is case-sensitive)
  // and is charset-filtered. A code with no "." is a bare id (key === '').
  function splitCode(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var dot = s.indexOf('.');
    var idPart = dot < 0 ? s : s.slice(0, dot);
    var keyPart = dot < 0 ? '' : s.slice(dot + 1);
    var id = idPart.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    var key = keyPart.replace(/\s+/g, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    return { id: id, key: key };
  }

  // ---------------- passphrase-based primitives (generic; not used for app saves) ----------------

  // PBKDF2(passphrase, salt) -> AES-GCM-256 key.
  function deriveKey(passphrase, saltBytes) {
    return subtle.importKey('raw', new TextEncoder().encode(String(passphrase == null ? '' : passphrase)), { name: 'PBKDF2' }, false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey({ name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  // Encrypt a JSON-able object under the passphrase -> { ct, iv, salt } (base64url).
  function encryptWithPass(obj, passphrase) {
    var salt = getRandom(16), iv = getRandom(12);
    return deriveKey(passphrase, salt).then(function (key) {
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ctBuf) {
      return { ct: b64urlFromBytes(new Uint8Array(ctBuf)), iv: b64urlFromBytes(iv), salt: b64urlFromBytes(salt) };
    });
  }

  // Decrypt (ct, iv, salt) under the passphrase -> the object. Rejects on a wrong
  // passphrase or tampered blob (AES-GCM is authenticated).
  function decryptWithPass(ctB64, ivB64, saltB64, passphrase) {
    return deriveKey(passphrase, bytesFromB64url(saltB64)).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64url(ivB64) }, key, bytesFromB64url(ctB64));
    }).then(function (ptBuf) {
      return JSON.parse(new TextDecoder().decode(ptBuf));
    });
  }

  // Normalize a BARE code (no key suffix): uppercase, drop spaces/dashes/ambiguous
  // punctuation, cap at 16 chars (REDCap's __code input is maxlength 15; 8-char legacy
  // ids are unaffected). For a full "<id>.<key>" code use splitCode instead.
  function normalizeCode(code) {
    return String(code == null ? '' : code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  }

  g.FBCRYPTO = {
    // v3 per-record key (used by the app)
    generateKeyBytes: generateKeyBytes, keyToCode: keyToCode, keyFromCode: keyFromCode,
    importAesKey: importAesKey, encryptWithKey: encryptWithKey, decryptWithKey: decryptWithKey,
    dtokFromKeyBytes: dtokFromKeyBytes, splitCode: splitCode,
    // shared helpers + passphrase primitives (generic)
    b64urlFromBytes: b64urlFromBytes, bytesFromB64url: bytesFromB64url,
    encryptWithPass: encryptWithPass, decryptWithPass: decryptWithPass,
    normalizeCode: normalizeCode, available: !!subtle
  };
})(typeof window !== 'undefined' ? window : globalThis);
