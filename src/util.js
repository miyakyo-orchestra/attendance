/**
 * 文字・日付・CSV・URL の小さな道具。
 *
 * store.js と worker.js の両方から使う。画面に出る言葉や保存する形を
 * 変えないよう、ここでは「数える・切る・形をそろえる」だけを行う。
 */

import { LIMITS } from './limits.js';

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 文字数は見た目の1文字を1と数える（絵文字や、組み合わせてできる文字も1文字）。
 * 長さ（length）で数えたり切ったりすると、絵文字の途中で切れて別の文字（�）に化けるため
 */
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
function chars(s) { return SEGMENTER ? Array.from(SEGMENTER.segment(s), (x) => x.segment) : Array.from(s); }
export function count(s) { return chars(s).length; }
/** max 文字までにする */
export function cut(s, max) { const c = chars(s); return c.length > max ? c.slice(0, max).join('') : s; }

/** 制御文字を除き、前後の空白を除いて、max 文字までにする（改行とタブは残す） */
export function cleanText(v, max) {
  return cut(String(v || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim(), max);
}

/** 氏名をスペース抜きで比べる（前の登録で残ったスペースがあっても同じ人として扱う） */
export const SAME_NAME = "REPLACE(REPLACE(name, '　', ''), ' ', '') = ?";
export function bare(name) { return String(name == null ? '' : name).replace(/[\s　]+/g, ''); }

/**
 * 姓と名から氏名を作る。姓・名の中のスペースは除き、氏名は姓と名をスペースなしでつなぐ（例: 宮教太郎）。
 * 姓と名のどちらかが空なら name を空で返す
 */
export function personName(p) {
  const sei = cut(bare(String(p.sei || '')), LIMITS.NAME);
  const mei = cut(bare(String(p.mei || '')), LIMITS.NAME);
  if (!sei || !mei) return { name: '', sei, mei };
  return { name: sei + mei, sei, mei }; // 氏名は切らない（姓と名がそれぞれ30文字までなので、60文字まで）
}

/** 練習日の日付が正しいか */
export function isDate(d) {
  return DATE.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
}

/** 年度（y年4月1日から翌年3月31日まで） */
export function yearRange(y) { return [`${y}-04-01`, `${y + 1}-03-31`]; }

/** 記録の日時（ISO の形）を、CSV に出す日本時間の 2026-10-20 14:20:48 の形に */
export function jstTime(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? '' : new Date(t + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

/** サイトの起点（https://example.org）。末尾の / などがあってもそろえる。正しくなければ空 */
export function originOf(v) {
  try { return new URL(String(v || '').trim()).origin; } catch (e) { return ''; }
}

/** CSV の1つの値。表計算ソフトで式として動かないようにし、必要なときだけ引用する */
export function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 表計算ソフトで式として動かないように
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 再設定のときの仮の暗証番号（数字だけ） */
export function tempPin() {
  const r = crypto.getRandomValues(new Uint32Array(LIMITS.TEMP_PIN_DIGITS));
  return Array.from(r, (n) => n % 10).join('');
}
