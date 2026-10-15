/**
 * 出欠の正本（Cloudflare の Durable Object の中の SQLite）
 *
 * 画面からの呼び出し（POST /api）をここで受けて、確かめてから読み書きする。
 * - データベースの操作は db.exec(SQL, ...値) → 行の配列、db.txn(関数) → 1つの取引にまとめる、の2つだけを使う。
 *   Cloudflare では Durable Object の ctx.storage.sql、テストでは Node の node:sqlite をこの形に合わせて渡す。
 * - 欠席理由は、本人・役職・管理者にだけ返す。返さない相手への応答には、理由の項目そのものを入れない。
 * - 合言葉・暗証番号・管理用パスワードの照合は時間のかかる計算（待ちが入る）なので先に済ませ、
 *   そのあとの読み書きは待たずに一気に行う（途中で別の呼び出しが割り込まない）。
 */

export const PARTS = [
  { id: 'Vn1', group: 'strings' },
  { id: 'Vn2', group: 'strings' },
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
  { id: 'Perc', group: 'winds' },
];
const PART_IDS = PARTS.map((p) => p.id);

// 役割: member（団員）・officer（役職。欠席理由を読める）・admin（管理者）
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
  GATE_FAILURES: 10, // 合言葉・管理用パスワードを、同じ接続元から続けて間違えたら止める回数
  LOCK_SECONDS: 600,
  SESSION_DAYS: 180, // 最後に使ってから、これだけ使わなければログインし直し
  PBKDF2_ROUNDS: 20000,
};

const STATUSES = ['attend', 'absent'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class Store {
  /**
   * @param db {exec(sql, ...binds): object[], txn(fn): any}
   * @param env {ADMIN_PASSWORD}
   * @param clock {() => number} 今の時刻（ミリ秒）。テストで差し替える
   */
  constructor(db, env, clock) {
    this.db = db;
    this.env = env || {};
    this.now = clock || (() => Date.now());
    this.init();
  }

  init() {
    const x = (q) => this.db.exec(q);
    x(`CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, part TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', pin TEXT NOT NULL, created_at TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`);
    x('CREATE UNIQUE INDEX IF NOT EXISTS members_name ON members (name)');
    x(`CREATE TABLE IF NOT EXISTS days (id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '',
      st TEXT NOT NULL DEFAULT '', en TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '')`);
    x('CREATE INDEX IF NOT EXISTS days_date ON days (date)');
    x(`CREATE TABLE IF NOT EXISTS answers (day_id TEXT NOT NULL, member_id TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (day_id, member_id))`);
    // ログインの印。token は元に戻せない形（SHA-256）で置く。member_id が空なら管理用パスワードでのログイン
    x(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, member_id TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, last_used INTEGER NOT NULL)`);
    // 小さな値（合言葉・入力ミスの回数など）。exp は期限（ミリ秒。0 は無期限）
    x('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL DEFAULT 0)');
  }

  // ---------------- 小さな値 ----------------
  kget(k) {
    const row = this.db.exec('SELECT v, exp FROM kv WHERE k = ?', k)[0];
    if (!row) return null;
    if (row.exp && row.exp < this.now()) { this.db.exec('DELETE FROM kv WHERE k = ?', k); return null; }
    return row.v;
  }
  kput(k, v, seconds) {
    this.db.exec('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)', k, String(v), seconds ? this.now() + seconds * 1000 : 0);
  }
  kdel(k) { this.db.exec('DELETE FROM kv WHERE k = ?', k); }

  // ---------------- 呼び出しの入口 ----------------
  /**
   * @param req {action, params}
   * @param ctx {token, ip}
   */
  async api(req, ctx) {
    const action = String((req && req.action) || '');
    const p = (req && req.params && typeof req.params === 'object') ? req.params : {};
    const c = ctx || {};
    try {
      if (Object.prototype.hasOwnProperty.call(PUBLIC, action)) return await PUBLIC[action].call(this, p, c);
      if (!Object.prototype.hasOwnProperty.call(PRIVATE, action)) return fail('不明な操作です。', 'BAD_REQUEST');
      const who = await this.whoAmI(c.token);
      if (!who) return fail('ログインし直してください。', 'UNAUTHORIZED');
      const [need, fn] = PRIVATE[action];
      if (need === 'member' && !who.member) return fail('団員としてログインしてください。', 'FORBIDDEN');
      if (need === 'admin' && who.role !== 'admin') return fail('管理者だけが使えます。', 'FORBIDDEN');
      return await fn.call(this, p, who, c);
    } catch (e) {
      if (e && e.userMessage) return fail(e.userMessage, e.code || 'BAD_REQUEST');
      throw e;
    }
  }

  /** ログインの印から、誰かを調べる。{ member（団員なら行）, role } */
  async whoAmI(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const hash = await sha256(token);
    const s = this.db.exec('SELECT * FROM sessions WHERE token = ?', hash)[0];
    if (!s) return null;
    const now = this.now();
    if (s.last_used + LIMITS.SESSION_DAYS * 86400000 < now) { this.db.exec('DELETE FROM sessions WHERE token = ?', hash); return null; }
    // 使った時刻は1日に1回だけ書き直す（書き込みを減らす）
    if (now - s.last_used > 86400000) this.db.exec('UPDATE sessions SET last_used = ? WHERE token = ?', now, hash);
    if (!s.member_id) return { member: null, role: 'admin', session: hash };
    const m = this.db.exec('SELECT * FROM members WHERE id = ?', s.member_id)[0];
    if (!m) { this.db.exec('DELETE FROM sessions WHERE token = ?', hash); return null; }
    return { member: m, role: m.role, session: hash };
  }

  async newSession(memberId) {
    const token = randomId(32);
    const now = this.now();
    this.db.exec('DELETE FROM sessions WHERE last_used < ?', now - LIMITS.SESSION_DAYS * 86400000); // 期限切れの掃除
    this.db.exec('INSERT INTO sessions (token, member_id, created, last_used) VALUES (?, ?, ?, ?)', await sha256(token), memberId || '', now, now);
    return token;
  }

  /** 合言葉を確かめる。同じ接続元から続けて間違えたら止める */
  async checkPassphrase(input, ip) {
    const stored = this.kget('passphrase');
    if (!stored) throw userError('まだ登録を受け付けていません。管理者に連絡してください。', 'CLOSED');
    this.checkGate(ip);
    const ok = await verifySecret(String(input || ''), stored);
    if (!ok) { this.gateFailed(ip); throw userError('合言葉が違います。', 'WRONG_PASSPHRASE'); }
    this.kdel('gate:' + ip);
  }
  checkGate(ip) {
    const n = Number(this.kget('gate:' + ip) || 0);
    if (n >= LIMITS.GATE_FAILURES) throw userError('入力の誤りが続いたため、しばらく使えません。10分ほどあけてください。', 'LOCKED');
  }
  gateFailed(ip) {
    const n = Number(this.kget('gate:' + ip) || 0) + 1;
    this.kput('gate:' + ip, n, LIMITS.LOCK_SECONDS);
  }

  // ---------------- 読み出し（画面に渡す形） ----------------
  meOf(who) {
    const m = who.member;
    return {
      id: m ? m.id : '',
      name: m ? m.name : '管理者',
      part: m ? m.part : '',
      role: who.role,
      canReadReasons: who.role === 'officer' || who.role === 'admin',
    };
  }
  adminCount() {
    return this.db.exec("SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n;
  }
  listDays() {
    return this.db.exec('SELECT id, date, kind, st, en, note FROM days ORDER BY date, st');
  }
  today() {
    // 日本時間の今日
    return new Date(this.now() + 9 * 3600000).toISOString().slice(0, 10);
  }
}

// ---------------- ログインなしで使える操作 ----------------
const PUBLIC = {
  /** 画面を開いたときに最初に読むもの */
  async info() {
    return { ok: true, parts: PARTS, open: !!this.kget('passphrase') };
  },

  async register(p, c) {
    const name = cleanName(p.name);
    const part = String(p.part || '');
    const pin = String(p.pin || '');
    if (!name) return fail('氏名を入れてください。');
    if (!PART_IDS.includes(part)) return fail('パートを選んでください。');
    if (!LIMITS.PIN.test(pin)) return fail('暗証番号は4〜8桁の数字にしてください。');
    await this.checkPassphrase(p.passphrase, c.ip);
    const pinHash = await hashSecret(pin);
    if (this.db.exec('SELECT 1 FROM members WHERE name = ?', name).length) return fail('同じ氏名の人がすでに登録しています。ログインしてください。', 'DUPLICATE');
    const id = randomId(9);
    this.db.exec('INSERT INTO members (id, name, part, role, pin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, name, part, 'member', pinHash, new Date(this.now()).toISOString());
    const token = await this.newSession(id);
    const who = { member: this.db.exec('SELECT * FROM members WHERE id = ?', id)[0], role: 'member' };
    return { ok: true, token, me: this.meOf(who) };
  },

  async login(p, c) {
    const name = cleanName(p.name);
    const pin = String(p.pin || '');
    if (!name || !pin) return fail('氏名と暗証番号を入れてください。');
    await this.checkPassphrase(p.passphrase, c.ip);
    const m = this.db.exec('SELECT * FROM members WHERE name = ?', name)[0];
    // 登録がない氏名でも、暗証番号の計算は同じだけ行う（登録の有無を、かかる時間から知られないため）
    const ok = await verifySecret(pin, m ? m.pin : DUMMY_HASH);
    if (!m) { this.gateFailed(c.ip); return fail('氏名か暗証番号が違います。', 'WRONG_PIN'); }
    if (m.locked_until > this.now()) return fail('暗証番号の誤りが続いたため、しばらくログインできません。10分ほどあけてください。', 'LOCKED');
    if (!ok) {
      const n = m.failures + 1;
      const lock = n >= LIMITS.PIN_FAILURES;
      this.db.exec('UPDATE members SET failures = ?, locked_until = ? WHERE id = ?', lock ? 0 : n, lock ? this.now() + LIMITS.LOCK_SECONDS * 1000 : 0, m.id);
      return fail('氏名か暗証番号が違います。', 'WRONG_PIN');
    }
    this.db.exec('UPDATE members SET failures = 0, locked_until = 0 WHERE id = ?', m.id);
    const token = await this.newSession(m.id);
    return { ok: true, token, me: this.meOf({ member: m, role: m.role }) };
  },

  /** 管理用パスワード（Cloudflare の秘密の設定 ADMIN_PASSWORD）でのログイン。最初の管理者を決めるときと、管理者がいなくなったとき用 */
  async adminLogin(p, c) {
    const pw = String(this.env.ADMIN_PASSWORD || '');
    if (!pw) return fail('管理用パスワードが設定されていません。', 'DISABLED');
    this.checkGate(c.ip);
    const input = String(p.password || '');
    const ok = await sha256(input) === await sha256(pw); // 長さや中身で比べる時間が変わらないよう、ハッシュどうしで比べる
    if (!ok) { this.gateFailed(c.ip); return fail('管理用パスワードが違います。', 'WRONG_PASSWORD'); }
    this.kdel('gate:' + c.ip);
    const token = await this.newSession('');
    return { ok: true, token, me: this.meOf({ member: null, role: 'admin' }) };
  },
};

// ---------------- ログインが要る操作 [必要な立場, 処理] ----------------
const PRIVATE = {
  home: ['any', function (p, who) {
    const mine = who.member
      ? this.db.exec('SELECT day_id, status, reason FROM answers WHERE member_id = ?', who.member.id)
      : [];
    const answers = {};
    for (const a of mine) answers[a.day_id] = { status: a.status, reason: a.reason };
    return { ok: true, me: this.meOf(who), today: this.today(), days: this.listDays(), answers, parts: PARTS };
  }],

  logout: ['any', function (p, who) {
    this.db.exec('DELETE FROM sessions WHERE token = ?', who.session);
    return { ok: true };
  }],

  answer: ['member', function (p, who) {
    const day = this.db.exec('SELECT * FROM days WHERE id = ?', String(p.dayId || ''))[0];
    if (!day) return fail('練習日が見つかりません。', 'NOT_FOUND');
    if (day.date < this.today()) return fail('過ぎた練習日の出欠は変えられません。', 'PAST');
    const status = String(p.status || '');
    if (!STATUSES.includes(status)) return fail('出席か欠席を選んでください。');
    const reason = status === 'absent' ? cleanText(p.reason, LIMITS.REASON) : '';
    this.db.exec(`INSERT INTO answers (day_id, member_id, status, reason, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (day_id, member_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at`,
    day.id, who.member.id, status, reason, new Date(this.now()).toISOString());
    return { ok: true, answer: { status, reason } };
  }],

  /** 自分の氏名・パートを直す */
  updateProfile: ['member', function (p, who) {
    const name = cleanName(p.name);
    const part = String(p.part || '');
    if (!name) return fail('氏名を入れてください。');
    if (!PART_IDS.includes(part)) return fail('パートを選んでください。');
    const same = this.db.exec('SELECT id FROM members WHERE name = ? AND id <> ?', name, who.member.id);
    if (same.length) return fail('同じ氏名の人がすでに登録しています。', 'DUPLICATE');
    this.db.exec('UPDATE members SET name = ?, part = ? WHERE id = ?', name, part, who.member.id);
    const m = this.db.exec('SELECT * FROM members WHERE id = ?', who.member.id)[0];
    return { ok: true, me: this.meOf({ member: m, role: m.role }) };
  }],

  /** 練習日ごとの、パート別の出欠。欠席理由は本人と、役職・管理者にだけ入れる */
  roster: ['any', function (p, who) {
    const day = this.db.exec('SELECT id, date, kind, st, en, note FROM days WHERE id = ?', String(p.dayId || ''))[0];
    if (!day) return fail('練習日が見つかりません。', 'NOT_FOUND');
    const canRead = who.role === 'officer' || who.role === 'admin';
    const selfId = who.member ? who.member.id : '';
    const rows = this.db.exec(`SELECT m.id, m.name, m.part, a.status, a.reason FROM members m
      LEFT JOIN answers a ON a.member_id = m.id AND a.day_id = ? ORDER BY m.name`, day.id);
    const members = rows.map((r) => {
      const out = { id: r.id, name: r.name, part: r.part, status: r.status || 'none' };
      if (r.status === 'absent' && (canRead || r.id === selfId)) out.reason = r.reason || '';
      return out;
    });
    return { ok: true, day, members, canReadReasons: canRead };
  }],

  // ---------------- 管理者 ----------------
  adminData: ['admin', function () {
    const members = this.db.exec('SELECT id, name, part, role, created_at FROM members ORDER BY name');
    return { ok: true, days: this.listDays(), members, open: !!this.kget('passphrase'), roles: ROLES };
  }],

  saveDay: ['admin', function (p) {
    const date = String(p.date || '');
    const st = String(p.st || '');
    const en = String(p.en || '');
    if (!DATE.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) return fail('日付を入れてください。');
    if (st && !TIME.test(st)) return fail('開始時刻の形が正しくありません。');
    if (en && !TIME.test(en)) return fail('終了時刻の形が正しくありません。');
    if (st && en && en <= st) return fail('終了時刻は開始時刻より後にしてください。');
    const kind = cleanText(p.kind, LIMITS.KIND);
    const note = cleanText(p.note, LIMITS.NOTE);
    let id = String(p.id || '');
    if (id) {
      if (!this.db.exec('SELECT 1 FROM days WHERE id = ?', id).length) return fail('練習日が見つかりません。', 'NOT_FOUND');
      this.db.exec('UPDATE days SET date = ?, kind = ?, st = ?, en = ?, note = ? WHERE id = ?', date, kind, st, en, note, id);
    } else {
      id = randomId(9);
      this.db.exec('INSERT INTO days (id, date, kind, st, en, note) VALUES (?, ?, ?, ?, ?, ?)', id, date, kind, st, en, note);
    }
    return { ok: true, id, days: this.listDays() };
  }],

  deleteDay: ['admin', function (p) {
    const id = String(p.id || '');
    this.db.txn(() => {
      this.db.exec('DELETE FROM answers WHERE day_id = ?', id);
      this.db.exec('DELETE FROM days WHERE id = ?', id);
    });
    return { ok: true, days: this.listDays() };
  }],

  setRole: ['admin', function (p, who) {
    const id = String(p.id || '');
    const role = String(p.role || '');
    if (!ROLES.includes(role)) return fail('役割が正しくありません。');
    const m = this.db.exec('SELECT * FROM members WHERE id = ?', id)[0];
    if (!m) return fail('団員が見つかりません。', 'NOT_FOUND');
    if (m.role === 'admin' && role !== 'admin' && this.adminCount() <= 1 && who.member) {
      return fail('管理者が1人もいなくなるため、外せません。先にほかの人を管理者にしてください。', 'LAST_ADMIN');
    }
    this.db.exec('UPDATE members SET role = ? WHERE id = ?', role, id);
    return { ok: true };
  }],

  /** 団員を消す（出欠の記録も消す。暗証番号を忘れた人は、消してから登録し直してもらう） */
  deleteMember: ['admin', function (p, who) {
    const id = String(p.id || '');
    const m = this.db.exec('SELECT * FROM members WHERE id = ?', id)[0];
    if (!m) return fail('団員が見つかりません。', 'NOT_FOUND');
    if (m.role === 'admin' && this.adminCount() <= 1 && who.member) return fail('最後の管理者は消せません。', 'LAST_ADMIN');
    this.db.txn(() => {
      this.db.exec('DELETE FROM answers WHERE member_id = ?', id);
      this.db.exec('DELETE FROM sessions WHERE member_id = ?', id);
      this.db.exec('DELETE FROM members WHERE id = ?', id);
    });
    return { ok: true };
  }],

  setPassphrase: ['admin', async function (p) {
    const v = String(p.passphrase || '').trim();
    if (v.length < LIMITS.PASSPHRASE_MIN || v.length > LIMITS.PASSPHRASE_MAX) return fail(`合言葉は${LIMITS.PASSPHRASE_MIN}〜${LIMITS.PASSPHRASE_MAX}文字にしてください。`);
    this.kput('passphrase', await hashSecret(v));
    return { ok: true, open: true };
  }],

  exportCsv: ['admin', function () {
    const rows = this.db.exec(`SELECT d.date, d.kind, d.st, d.en, m.name, m.part, a.status, a.reason, a.updated_at
      FROM days d CROSS JOIN members m LEFT JOIN answers a ON a.day_id = d.id AND a.member_id = m.id
      ORDER BY d.date, d.st, m.part, m.name`);
    const label = { attend: '出席', absent: '欠席' };
    const order = Object.fromEntries(PART_IDS.map((id, i) => [id, i]));
    rows.sort((a, b) => (a.date + a.st).localeCompare(b.date + b.st) || (order[a.part] - order[b.part]) || a.name.localeCompare(b.name, 'ja'));
    const lines = [['日付', '種類', '開始', '終了', '氏名', 'パート', '出欠', '欠席理由', '回答日時']];
    for (const r of rows) lines.push([r.date, r.kind, r.st, r.en, r.name, r.part, label[r.status] || '未回答', r.reason || '', r.updated_at || '']);
    return { ok: true, csv: lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }],
};

// ---------------- 小さな道具 ----------------
function fail(message, code) { return { ok: false, code: code || 'BAD_REQUEST', message }; }
function userError(message, code) { const e = new Error(message); e.userMessage = message; e.code = code; return e; }

/** 氏名の空白をそろえる（前後を除き、続く空白は全角1つに） */
function cleanName(v) {
  return String(v || '').replace(/[\s　]+/g, '　').replace(/^　|　$/g, '').slice(0, LIMITS.NAME);
}
function cleanText(v, max) {
  // 制御文字を除く（改行とタブは残す）
  return String(v || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 表計算ソフトで式として動かないように
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function randomId(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}
async function pbkdf2(secret, salt, rounds) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: rounds }, k, 256);
  return b64url(new Uint8Array(bits));
}
/** 元に戻せない形にする（pbkdf2$回数$塩$値） */
async function hashSecret(secret) {
  const salt = randomId(12);
  return `pbkdf2$${LIMITS.PBKDF2_ROUNDS}$${salt}$${await pbkdf2(secret, salt, LIMITS.PBKDF2_ROUNDS)}`;
}
async function verifySecret(secret, stored) {
  const [kind, rounds, salt, value] = String(stored || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = await pbkdf2(secret, salt, Number(rounds));
  return safeEqual(got, value);
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
// 登録のない氏名でログインしようとしたときに、照合の計算だけするための値
const DUMMY_HASH = `pbkdf2$${LIMITS.PBKDF2_ROUNDS}$dummysalt$x`;
