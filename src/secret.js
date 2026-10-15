/**
 * 秘密の値の扱い（暗証番号・合言葉・ログインの印）と、そのための小さな道具。
 *
 * - 暗証番号と合言葉は、元に戻せない形（PBKDF2。pbkdf2$回数$塩$値）にして置く。
 * - ログインの印は SHA-256 にして置く。
 * - 照合では、比べる時間が中身で変わらないようにする（長さや一致した文字数を、かかる時間から知られないため）。
 * - base64url（URL に入れても崩れない文字だけの形）との行き来は、パスキー（passkey.js）でも使う。
 */

export const PBKDF2_ROUNDS = 20000;

/** バイト列を base64url の文字列に */
export function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url の文字列をバイト列に */
export function fromB64url(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 推測できない乱数の文字列（bytes バイト分） */
export function randomId(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toB64url(a);
}

export async function sha256(text) {
  return toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

async function pbkdf2(secret, salt, rounds) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: rounds }, k, 256);
  return toB64url(new Uint8Array(bits));
}

/** 元に戻せない形にする（pbkdf2$回数$塩$値） */
export async function hashSecret(secret) {
  const salt = randomId(12);
  return `pbkdf2$${PBKDF2_ROUNDS}$${salt}$${await pbkdf2(secret, salt, PBKDF2_ROUNDS)}`;
}

/** hashSecret で作った値と、入力が合うか */
export async function verifySecret(secret, stored) {
  const [kind, rounds, salt, value] = String(stored || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = await pbkdf2(secret, salt, Number(rounds));
  return safeEqual(got, value);
}

/** 登録のない氏名でログインしようとしたときに、照合の計算だけするための値 */
export const DUMMY_HASH = `pbkdf2$${PBKDF2_ROUNDS}$dummysalt$x`;

function safeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
