/**
 * パスキー（WebAuthn）の確かめ方。外部のライブラリを使わずに、必要な分だけを読む。
 *
 * - 作るとき: ブラウザが返す attestationObject（CBOR という形）から公開鍵を取り出す。
 *   誰が作った認証器かの証明（attestation）は求めない（"none"）。ログイン中の本人が作るので、それで足りる。
 * - ログインのとき: authenticatorData と clientDataJSON の SHA-256 をつないだものに対する署名を、公開鍵で確かめる。
 * - 使える鍵は ES256（-7。iPhone・Android・Windows・Mac のパスキーはほぼこれ）と RS256（-257）。
 */

import { toB64url } from './secret.js';

export const ALGS = [-7, -257];

/** clientDataJSON を読み、種類・チャレンジ・呼び出し元のサイトを確かめる。チャレンジを返す */
export function readClientData(bytes, type, origin) {
  let c;
  try { c = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw bad(); }
  if (!c || c.type !== type || c.origin !== origin || typeof c.challenge !== 'string') throw bad();
  return c.challenge;
}

/**
 * authenticatorData を読む。rpIdHash（サイトの名前の SHA-256）と、本人が操作した印を確かめる。
 * withKey なら、続く公開鍵（作るときだけ入っている）も取り出す。
 */
export async function readAuthData(bytes, rpId, withKey) {
  if (bytes.length < 37) throw bad();
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  for (let i = 0; i < 32; i++) if (bytes[i] !== rpHash[i]) throw bad();
  const flags = bytes[32];
  if (!(flags & 0x01)) throw bad(); // 本人が触れた（UP）
  if (!(flags & 0x04)) throw bad(); // 指紋・顔・端末の暗証番号で本人と確かめた（UV）
  if (!withKey) return {};
  if (!(flags & 0x40) || bytes.length < 55) throw bad();
  const idLen = (bytes[53] << 8) | bytes[54];
  const credId = bytes.slice(55, 55 + idLen);
  const { value: cose } = cbor(bytes, 55 + idLen);
  const key = coseToJwk(cose);
  return { credId, alg: key.alg, jwk: key.jwk };
}

/** attestationObject から authData を取り出す */
export function authDataOf(attestationObject) {
  const { value } = cbor(attestationObject, 0);
  if (!value || !(value.get('authData') instanceof Uint8Array)) throw bad();
  return value.get('authData');
}

/** 署名を確かめる */
export async function verifySignature(jwk, alg, authData, clientDataBytes, signature) {
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
  const data = new Uint8Array(authData.length + 32);
  data.set(authData, 0);
  data.set(clientHash, authData.length);
  if (alg === -7) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const raw = derToRaw(signature);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data);
  }
  if (alg === -257) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  return false;
}

// ---------------- 内側の道具 ----------------
function bad() { const e = new Error('passkey'); e.passkey = true; return e; }

/** COSE の鍵を JWK（WebCrypto が読める形）に。返すのは { alg, jwk } */
function coseToJwk(m) {
  if (!(m instanceof Map)) throw bad();
  const kty = m.get(1);
  const alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: toB64url(m.get(-2)), y: toB64url(m.get(-3)), ext: true } };
  }
  if (kty === 3 && alg === -257) {
    return { alg, jwk: { kty: 'RSA', n: toB64url(m.get(-1)), e: toB64url(m.get(-2)), alg: 'RS256', ext: true } };
  }
  throw bad();
}

/** ECDSA の署名は DER という形で届くので、WebCrypto が読む r と s を並べた形（64バイト）に直す */
function derToRaw(sig) {
  if (sig[0] !== 0x30) throw bad();
  let i = 2;
  const out = new Uint8Array(64);
  for (let k = 0; k < 2; k++) {
    if (sig[i] !== 0x02) throw bad();
    let len = sig[i + 1];
    let start = i + 2;
    i = start + len;
    while (len > 32 && sig[start] === 0) { start++; len--; } // 先頭の 0 を除く
    if (len > 32) throw bad();
    out.set(sig.slice(start, start + len), k * 32 + (32 - len));
  }
  return out;
}

/** CBOR を読む（パスキーに出てくる形だけ: 整数・バイト列・文字列・配列・連想配列） */
function cbor(b, pos, depth = 0) {
  if (depth > 8 || pos >= b.length) throw bad();
  const head = b[pos++];
  const major = head >> 5;
  let n = head & 0x1f;
  if (n === 24) n = b[pos++];
  else if (n === 25) { n = (b[pos] << 8) | b[pos + 1]; pos += 2; }
  else if (n === 26) { n = ((b[pos] << 24) >>> 0) + ((b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]); pos += 4; }
  else if (n > 26) throw bad();
  switch (major) {
    case 0: return { value: n, end: pos };
    case 1: return { value: -1 - n, end: pos };
    case 2: if (pos + n > b.length) throw bad(); return { value: b.slice(pos, pos + n), end: pos + n };
    case 3: if (pos + n > b.length) throw bad(); return { value: new TextDecoder().decode(b.slice(pos, pos + n)), end: pos + n };
    case 4: {
      const arr = [];
      for (let i = 0; i < n; i++) { const r = cbor(b, pos, depth + 1); arr.push(r.value); pos = r.end; }
      return { value: arr, end: pos };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < n; i++) {
        const k = cbor(b, pos, depth + 1); const v = cbor(b, k.end, depth + 1);
        map.set(k.value, v.value); pos = v.end;
      }
      return { value: map, end: pos };
    }
    default: throw bad();
  }
}
