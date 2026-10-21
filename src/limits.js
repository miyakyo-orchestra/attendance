/**
 * このシステムで決まっている値。
 *
 * パート・役割・入力の上限・出欠の種類など、store.js の処理と画面の両方から
 * 参照する値をここにまとめる。動きを変えるときは、仕様書の「入力の上限」も
 * 同じコミットで直す。
 */

export const PARTS = [
  { id: 'Vn', group: 'strings' },
  { id: 'Va', group: 'strings' },
  { id: 'Vc', group: 'strings' },
  { id: 'Cb', group: 'strings' },
  { id: 'Fl', group: 'winds' },
  { id: 'Ob', group: 'winds' },
  { id: 'Cl', group: 'winds' },
  { id: 'Fg', group: 'winds' },
  { id: 'Hr', group: 'winds' },
  { id: 'Tp', group: 'winds' },
  { id: 'Tb', group: 'winds' },
  { id: 'Tu', group: 'winds' },
  { id: 'Perc', group: 'winds' },
];
// パートの一覧は管理画面から変えられる。変えたものは kv の parts に置き、なければ上の PARTS を使う
export const GROUPS = ['strings', 'winds'];

// 役割: member（団員）・officer（パートリーダー。欠席理由を読め、練習日を登録できる）・admin（管理者）
export const ROLES = ['member', 'officer', 'admin'];

export const LIMITS = {
  NAME: 30,
  KIND: 20,
  NOTE: 100,
  REASON: 200,
  PASSPHRASE_MIN: 4,
  PASSPHRASE_MAX: 64,
  PIN: /^\d{4,8}$/,
  PIN_FAILURES: 5, // 続けて間違えたら止める回数
  TEMP_PIN_DIGITS: 6, // 暗証番号を再設定したときの仮の番号の桁数
  GATE_FAILURES: 10, // 合言葉・管理用パスワードを、同じ接続元から続けて間違えたら止める回数
  LOCK_SECONDS: 600,
  SESSION_DAYS: 180, // 最後に使ってから、これだけ使わなければログインし直し
  DAYS_AT_ONCE: 100, // 練習日をまとめて足すときの上限
  PART_ID: /^[A-Za-z0-9]{1,8}$/, // パートの名前（Vn・Tu など）
  PART_COUNT: 30,
  PASSKEYS: 10, // 一人が作れるパスキーの数
  CHALLENGE_SECONDS: 300, // パスキーの操作を始めてから終えるまでの時間
};

// 出欠: attend（出席）・late（遅刻）・early（早退）・absent（欠席）。遅刻と早退は時刻（at）を書ける
export const STATUS_LABEL = { attend: '出席', late: '遅刻', early: '早退', absent: '欠席' };
export const STATUSES = Object.keys(STATUS_LABEL);

export const DAY_MS = 86400000;
