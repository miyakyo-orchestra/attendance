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

import { ALGS, fromB64url, toB64url, readClientData, readAuthData, authDataOf, verifySignature } from './passkey.js';

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
  { id: 'Tuba', group: 'winds' },
  { id: 'Perc', group: 'winds' },
];
// パートの一覧は管理画面から変えられる。変えたものは kv の parts に置き、なければ上の PARTS を使う
const GROUPS = ['strings', 'winds'];

// 役割: member（団員）・officer（役職。欠席理由を読め、練習日を登録できる）・admin（管理者）
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
  DAYS_AT_ONCE: 100, // 練習日をまとめて足すときの上限
  PART_ID: /^[A-Za-z0-9.]{1,8}$/, // パートの名前（Vn・Tuba など）
  PART_COUNT: 30,
  PASSKEYS: 10, // 一人が作れるパスキーの数
  CHALLENGE_SECONDS: 300, // パスキーの操作を始めてから終えるまでの時間
};

// 出欠: attend（出席）・late（遅刻）・early（早退）・absent（欠席）。遅刻と早退は時刻（at）を書ける
const STATUSES = ['attend', 'late', 'early', 'absent'];
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
    // 出欠をとらない予定（授業・祝日など。配るカレンダーにだけ載せる）は noentry = 1（2026-10-15 から）
    if (!this.db.exec("SELECT 1 FROM pragma_table_info('days') WHERE name = 'noentry'").length) {
      x('ALTER TABLE days ADD COLUMN noentry INTEGER NOT NULL DEFAULT 0');
    }
    x(`CREATE TABLE IF NOT EXISTS answers (day_id TEXT NOT NULL, member_id TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (day_id, member_id))`);
    if (!this.db.exec("SELECT 1 FROM pragma_table_info('answers') WHERE name = 'at'").length) {
      x("ALTER TABLE answers ADD COLUMN at TEXT NOT NULL DEFAULT ''"); // 遅刻・早退の時刻（2026-10-15 から）
    }
    // 2026-10-15 から姓と名を分けて持つ。氏名（name）は姓と名をスペースなしでつないだもの
    if (!this.db.exec("SELECT 1 FROM pragma_table_info('members') WHERE name = 'sei'").length) {
      x("ALTER TABLE members ADD COLUMN sei TEXT NOT NULL DEFAULT ''");
      x("ALTER TABLE members ADD COLUMN mei TEXT NOT NULL DEFAULT ''");
      // 前に登録した人は、氏名の中のスペースで姓と名に分ける。スペースがなければ全部を姓に入れる（設定で直せる）
      for (const m of this.db.exec('SELECT id, name FROM members')) {
        const [sei, ...rest] = m.name.split(/[\s　]+/).filter(Boolean);
        const mei = rest.join('');
        const name = (sei || '') + mei;
        const clash = this.db.exec('SELECT 1 FROM members WHERE name = ? AND id <> ?', name, m.id).length;
        this.db.exec('UPDATE members SET sei = ?, mei = ?, name = ? WHERE id = ?', sei || m.name, mei, clash ? m.name : name, m.id);
      }
    }
    // ログインの印。token は元に戻せない形（SHA-256）で置く。member_id が空なら管理用パスワードでのログイン
    x(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, member_id TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, last_used INTEGER NOT NULL)`);
    // パスキー。id は認証器が決める番号（base64url）、jwk は公開鍵、alg は署名の方式
    x(`CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, jwk TEXT NOT NULL,
      alg INTEGER NOT NULL, created_at TEXT NOT NULL, last_used TEXT NOT NULL DEFAULT '')`);
    x('CREATE INDEX IF NOT EXISTS passkeys_member ON passkeys (member_id)');
    // 小さな値（合言葉・入力ミスの回数など）。exp は期限（ミリ秒。0 は無期限）
    x('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL DEFAULT 0)');
    // 2026-10-15 から Vn1 と Vn2 を分けず Vn にまとめた。前に登録した人も Vn に直す
    x("UPDATE members SET part = 'Vn' WHERE part IN ('Vn1', 'Vn2')");
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
      if (!who) return fail('ログインが切れました。もう一度ログインしてください。', 'UNAUTHORIZED');
      const [need, fn] = PRIVATE[action];
      if (need === 'member' && !who.member) return fail('団員としてログインしてください。', 'FORBIDDEN');
      if (need === 'admin' && who.role !== 'admin') return fail('管理者だけが使えます。', 'FORBIDDEN');
      if (need === 'officer' && who.role !== 'admin' && who.role !== 'officer') return fail('役職と管理者だけが使えます。', 'FORBIDDEN');
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
      sei: m ? m.sei : '',
      mei: m ? m.mei : '',
      part: m ? m.part : '',
      role: who.role,
      canReadReasons: who.role === 'officer' || who.role === 'admin',
    };
  }
  adminCount() {
    return this.db.exec("SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n;
  }
  listDays() {
    return this.db.exec('SELECT id, date, kind, st, en, note, noentry FROM days ORDER BY date, st');
  }
  /** 今のパートの一覧 [{ id, group }] */
  parts() {
    const v = this.kget('parts');
    if (v) { try { return JSON.parse(v); } catch (e) { /* 壊れていれば初めの一覧 */ } }
    return PARTS;
  }
  partIds() { return this.parts().map((p) => p.id); }

  /** パスキーの相手のサイト（ALLOWED_ORIGIN）と、その名前（rpId） */
  site() {
    const origin = String(this.env.ALLOWED_ORIGIN || '').trim();
    let rpId = '';
    try { rpId = new URL(origin).hostname; } catch (e) { /* 設定がなければパスキーは使えない */ }
    return { origin, rpId };
  }
  /** パスキーの操作のためのチャレンジ（1回だけ使える乱数）を作る。what は使い道 */
  newChallenge(what) {
    this.db.exec('DELETE FROM kv WHERE exp > 0 AND exp < ?', this.now()); // 期限切れの掃除
    const challenge = randomId(32);
    this.kput('pk:' + challenge, what, LIMITS.CHALLENGE_SECONDS);
    return challenge;
  }
  /** チャレンジを使い切る。使い道が合っていれば true */
  useChallenge(challenge, what) {
    const v = this.kget('pk:' + challenge);
    this.kdel('pk:' + challenge);
    return v === what;
  }
  passkeyList(memberId) {
    return this.db.exec('SELECT id, created_at, last_used FROM passkeys WHERE member_id = ? ORDER BY created_at', memberId);
  }
  hasPasskey(memberId) {
    return this.db.exec('SELECT 1 FROM passkeys WHERE member_id = ? LIMIT 1', memberId).length > 0;
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
    return { ok: true, parts: this.parts(), open: !!this.kget('passphrase') };
  },

  async register(p, c) {
    const { name, sei, mei } = personName(p);
    const part = String(p.part || '');
    const pin = String(p.pin || '');
    if (!name) return fail('姓と名を入れてください。');
    if (!this.partIds().includes(part)) return fail('パートを選んでください。');
    if (!LIMITS.PIN.test(pin)) return fail('暗証番号は4〜8桁の数字にしてください。');
    await this.checkPassphrase(p.passphrase, c.ip);
    const pinHash = await hashSecret(pin);
    if (this.db.exec(`SELECT 1 FROM members WHERE ${SAME_NAME}`, bare(name)).length) return fail('同じ氏名の人がすでに登録しています。ログインしてください。', 'DUPLICATE');
    const id = randomId(9);
    this.db.exec('INSERT INTO members (id, name, sei, mei, part, role, pin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, sei, mei, part, 'member', pinHash, new Date(this.now()).toISOString());
    const token = await this.newSession(id);
    const who = { member: this.db.exec('SELECT * FROM members WHERE id = ?', id)[0], role: 'member' };
    return { ok: true, token, me: this.meOf(who) };
  },

  async login(p, c) {
    // ログインは氏名を一つの欄で受ける。スペースの有無は問わない（姓と名で送られても受ける）
    const name = p.name !== undefined ? bare(String(p.name)).slice(0, LIMITS.NAME) : personName(p).name;
    const pin = String(p.pin || '');
    if (!name || !pin) return fail('氏名と暗証番号を入れてください。');
    // 合言葉は登録のときだけ。ログインは氏名と暗証番号で、同じ接続元からの誤りが続けば止める
    this.checkGate(c.ip);
    const m = this.db.exec(`SELECT * FROM members WHERE ${SAME_NAME}`, bare(name))[0];
    // 登録がない氏名でも、暗証番号の計算は同じだけ行う（登録の有無を、かかる時間から知られないため）
    const ok = await verifySecret(pin, m ? m.pin : DUMMY_HASH);
    if (!m) { this.gateFailed(c.ip); return fail('氏名か暗証番号が違います。', 'WRONG_PIN'); }
    if (m.locked_until > this.now()) return fail('暗証番号の誤りが続いたため、しばらくログインできません。10分ほどあけてください。', 'LOCKED');
    if (!ok) {
      this.gateFailed(c.ip);
      const n = m.failures + 1;
      const lock = n >= LIMITS.PIN_FAILURES;
      this.db.exec('UPDATE members SET failures = ?, locked_until = ? WHERE id = ?', lock ? 0 : n, lock ? this.now() + LIMITS.LOCK_SECONDS * 1000 : 0, m.id);
      return fail('氏名か暗証番号が違います。', 'WRONG_PIN');
    }
    this.db.exec('UPDATE members SET failures = 0, locked_until = 0 WHERE id = ?', m.id);
    this.kdel('gate:' + c.ip);
    const token = await this.newSession(m.id);
    return { ok: true, token, me: this.meOf({ member: m, role: m.role }), hasPasskey: this.hasPasskey(m.id) };
  },

  /** パスキーでログインする前に、チャレンジを受け取る */
  async passkeyLoginOptions() {
    const { rpId } = this.site();
    if (!rpId) return fail('このページではパスキーを使えません。', 'DISABLED');
    return { ok: true, challenge: this.newChallenge('login'), rpId };
  },

  /** パスキーでログインする。氏名も暗証番号も要らない */
  async passkeyLogin(p, c) {
    this.checkGate(c.ip);
    const { origin, rpId } = this.site();
    const failed = () => { this.gateFailed(c.ip); return fail('パスキーでログインできませんでした。', 'PASSKEY_FAILED'); };
    try {
      const clientData = fromB64url(p.clientDataJSON);
      const authData = fromB64url(p.authenticatorData);
      const challenge = readClientData(clientData, 'webauthn.get', origin);
      if (!this.useChallenge(challenge, 'login')) return failed();
      await readAuthData(authData, rpId, false);
      const key = this.db.exec('SELECT * FROM passkeys WHERE id = ?', String(p.id || ''))[0];
      if (!key) return fail('このパスキーは登録されていません。暗証番号でログインしてください。', 'PASSKEY_UNKNOWN');
      const ok = await verifySignature(JSON.parse(key.jwk), key.alg, authData, clientData, fromB64url(p.signature));
      if (!ok) return failed();
      const m = this.db.exec('SELECT * FROM members WHERE id = ?', key.member_id)[0];
      if (!m) return failed();
      this.kdel('gate:' + c.ip);
      this.db.exec('UPDATE passkeys SET last_used = ? WHERE id = ?', new Date(this.now()).toISOString(), key.id);
      const token = await this.newSession(m.id);
      return { ok: true, token, me: this.meOf({ member: m, role: m.role }), hasPasskey: true };
    } catch (e) {
      if (e && e.passkey) return failed();
      throw e;
    }
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
      ? this.db.exec('SELECT day_id, status, reason, at FROM answers WHERE member_id = ?', who.member.id)
      : [];
    const answers = {};
    for (const a of mine) answers[a.day_id] = { status: a.status, reason: a.reason, at: a.at };
    return { ok: true, me: this.meOf(who), today: this.today(), days: this.listDays(), answers, parts: this.parts() };
  }],

  logout: ['any', function (p, who) {
    this.db.exec('DELETE FROM sessions WHERE token = ?', who.session);
    return { ok: true };
  }],

  answer: ['member', function (p, who) {
    const day = this.db.exec('SELECT * FROM days WHERE id = ?', String(p.dayId || ''))[0];
    if (!day || day.noentry) return fail('練習日が見つかりません。', 'NOT_FOUND');
    if (day.date < this.today()) return fail('過ぎた練習日の出欠は変えられません。', 'PAST');
    const status = String(p.status || '');
    if (!STATUSES.includes(status)) return fail('出欠を選んでください。');
    const reason = status === 'absent' ? cleanText(p.reason, LIMITS.REASON) : '';
    const at = status === 'late' || status === 'early' ? String(p.at || '') : '';
    if (at && !TIME.test(at)) return fail('時刻の形が正しくありません。');
    this.db.exec(`INSERT INTO answers (day_id, member_id, status, reason, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day_id, member_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at, updated_at = excluded.updated_at`,
    day.id, who.member.id, status, reason, at, new Date(this.now()).toISOString());
    return { ok: true, answer: { status, reason, at } };
  }],

  /** 自分の氏名・パートを直す */
  updateProfile: ['member', function (p, who) {
    const { name, sei, mei } = personName(p);
    const part = String(p.part || '');
    if (!name) return fail('姓と名を入れてください。');
    if (!this.partIds().includes(part)) return fail('パートを選んでください。');
    const same = this.db.exec(`SELECT id FROM members WHERE ${SAME_NAME} AND id <> ?`, bare(name), who.member.id);
    if (same.length) return fail('同じ氏名の人がすでに登録しています。', 'DUPLICATE');
    this.db.exec('UPDATE members SET name = ?, sei = ?, mei = ?, part = ? WHERE id = ?', name, sei, mei, part, who.member.id);
    const m = this.db.exec('SELECT * FROM members WHERE id = ?', who.member.id)[0];
    return { ok: true, me: this.meOf({ member: m, role: m.role }) };
  }],

  /** 自分のパスキーの一覧 */
  passkeys: ['member', function (p, who) {
    return { ok: true, passkeys: this.passkeyList(who.member.id) };
  }],

  /** パスキーを作る前に、チャレンジと、作るのに要る値を受け取る */
  passkeyRegisterOptions: ['member', function (p, who) {
    const { rpId } = this.site();
    if (!rpId) return fail('このページではパスキーを使えません。', 'DISABLED');
    const m = who.member;
    return {
      ok: true,
      challenge: this.newChallenge('reg:' + m.id),
      rp: { id: rpId, name: '宮教オケ 出欠' },
      user: { id: m.id, name: m.name, displayName: m.name },
      algs: ALGS,
      exclude: this.passkeyList(m.id).map((k) => k.id),
    };
  }],

  /** 作ったパスキーを登録する */
  passkeyRegister: ['member', async function (p, who) {
    const { origin, rpId } = this.site();
    const m = who.member;
    const failed = () => fail('パスキーを登録できませんでした。', 'PASSKEY_FAILED');
    let key;
    try {
      const clientData = fromB64url(p.clientDataJSON);
      const challenge = readClientData(clientData, 'webauthn.create', origin);
      if (!this.useChallenge(challenge, 'reg:' + m.id)) return failed();
      key = await readAuthData(authDataOf(fromB64url(p.attestationObject)), rpId, true);
    } catch (e) {
      if (e && e.passkey) return failed();
      throw e;
    }
    const id = toB64url(key.credId);
    if (!id || id.length > 1400) return failed();
    if (this.passkeyList(m.id).length >= LIMITS.PASSKEYS) return fail(`パスキーは${LIMITS.PASSKEYS}個までです。使わないものを消してください。`);
    if (this.db.exec('SELECT 1 FROM passkeys WHERE id = ?', id).length) return fail('このパスキーはすでに登録しています。', 'DUPLICATE');
    this.db.exec('INSERT INTO passkeys (id, member_id, jwk, alg, created_at) VALUES (?, ?, ?, ?, ?)',
      id, m.id, JSON.stringify(key.jwk), key.alg, new Date(this.now()).toISOString());
    return { ok: true, passkeys: this.passkeyList(m.id) };
  }],

  passkeyDelete: ['member', function (p, who) {
    this.db.exec('DELETE FROM passkeys WHERE id = ? AND member_id = ?', String(p.id || ''), who.member.id);
    return { ok: true, passkeys: this.passkeyList(who.member.id) };
  }],

  /** 練習日ごとの、パート別の出欠。欠席理由は本人と、役職・管理者にだけ入れる */
  roster: ['any', function (p, who) {
    const day = this.db.exec('SELECT id, date, kind, st, en, note FROM days WHERE id = ? AND noentry = 0', String(p.dayId || ''))[0];
    if (!day) return fail('練習日が見つかりません。', 'NOT_FOUND');
    const canRead = who.role === 'officer' || who.role === 'admin';
    const selfId = who.member ? who.member.id : '';
    const rows = this.db.exec(`SELECT m.id, m.name, m.part, a.status, a.reason, a.at FROM members m
      LEFT JOIN answers a ON a.member_id = m.id AND a.day_id = ? ORDER BY m.name`, day.id);
    const members = rows.map((r) => {
      const out = { id: r.id, name: r.name, part: r.part, status: r.status || 'none' };
      if (r.at) out.at = r.at; // 遅刻・早退の時刻は誰にでも見せる
      if (r.status === 'absent' && (canRead || r.id === selfId)) out.reason = r.reason || '';
      return out;
    });
    return { ok: true, day, members, canReadReasons: canRead, parts: this.parts() };
  }],

  // ---------------- 管理者 ----------------
  /** 管理画面に出すもの。役職には練習日だけを返す */
  adminData: ['officer', function (p, who) {
    if (who.role !== 'admin') return { ok: true, days: this.listDays() };
    const members = this.db.exec('SELECT id, name, part, role, created_at FROM members ORDER BY name');
    return { ok: true, days: this.listDays(), members, open: !!this.kget('passphrase'), roles: ROLES, parts: this.parts() };
  }],

  saveDay: ['officer', function (p) {
    const date = String(p.date || '');
    if (!isDate(date)) return fail('日付を入れてください。');
    const f = dayFields(p);
    if (f.error) return fail(f.error);
    let id = String(p.id || '');
    if (id) {
      if (!this.db.exec('SELECT 1 FROM days WHERE id = ?', id).length) return fail('練習日が見つかりません。', 'NOT_FOUND');
      this.db.exec('UPDATE days SET date = ?, kind = ?, st = ?, en = ?, note = ?, noentry = ? WHERE id = ?', date, f.kind, f.st, f.en, f.note, f.noentry, id);
    } else {
      id = randomId(9);
      this.db.exec('INSERT INTO days (id, date, kind, st, en, note, noentry) VALUES (?, ?, ?, ?, ?, ?, ?)', id, date, f.kind, f.st, f.en, f.note, f.noentry);
    }
    return { ok: true, id, days: this.listDays() };
  }],

  /** 同じ種類・時刻・メモの練習日を、いくつもの日付にまとめて足す */
  saveDays: ['officer', function (p) {
    const dates = [...new Set(Array.isArray(p.dates) ? p.dates.map(String) : [])].sort();
    if (!dates.length) return fail('日付を選んでください。');
    if (dates.length > LIMITS.DAYS_AT_ONCE) return fail(`一度に足せるのは${LIMITS.DAYS_AT_ONCE}日までです。`);
    if (!dates.every(isDate)) return fail('日付の形が正しくありません。');
    const f = dayFields(p);
    if (f.error) return fail(f.error);
    this.db.txn(() => {
      for (const date of dates) {
        this.db.exec('INSERT INTO days (id, date, kind, st, en, note, noentry) VALUES (?, ?, ?, ?, ?, ?, ?)', randomId(9), date, f.kind, f.st, f.en, f.note, f.noentry);
      }
    });
    return { ok: true, added: dates.length, days: this.listDays() };
  }],

  deleteDay: ['officer', function (p) {
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
    return PRIVATE.deleteMembers[1].call(this, { ids: [p.id] }, who);
  }],

  /** 団員をまとめて消す（卒業した人など） */
  deleteMembers: ['admin', function (p, who) {
    const ids = [...new Set(Array.isArray(p.ids) ? p.ids.map(String) : [])];
    if (!ids.length) return fail('団員を選んでください。');
    const rows = ids.map((id) => this.db.exec('SELECT * FROM members WHERE id = ?', id)[0]);
    if (rows.some((m) => !m)) return fail('団員が見つかりません。', 'NOT_FOUND');
    const admins = rows.filter((m) => m.role === 'admin').length;
    if (admins && this.adminCount() - admins < 1 && who.member) return fail('最後の管理者は消せません。', 'LAST_ADMIN');
    this.db.txn(() => {
      for (const id of ids) {
        this.db.exec('DELETE FROM answers WHERE member_id = ?', id);
        this.db.exec('DELETE FROM sessions WHERE member_id = ?', id);
        this.db.exec('DELETE FROM passkeys WHERE member_id = ?', id);
        this.db.exec('DELETE FROM members WHERE id = ?', id);
      }
    });
    return { ok: true, deleted: ids.length };
  }],

  /** 年度（4月から翌年3月）の練習日と、その出欠をまとめて消す */
  deleteYear: ['admin', function (p) {
    const y = Number(p.year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return fail('年度を選んでください。');
    const [from, to] = yearRange(y);
    if (to >= this.today()) return fail('終わっていない年度は消せません。');
    let n = 0;
    this.db.txn(() => {
      const ids = this.db.exec('SELECT id FROM days WHERE date BETWEEN ? AND ?', from, to).map((d) => d.id);
      for (const id of ids) {
        this.db.exec('DELETE FROM answers WHERE day_id = ?', id);
        this.db.exec('DELETE FROM days WHERE id = ?', id);
      }
      n = ids.length;
    });
    return { ok: true, deleted: n, days: this.listDays() };
  }],

  /** パートを足す。弦か管打の最後に入る */
  addPart: ['admin', function (p) {
    const id = String(p.id || '').trim();
    const group = String(p.group || '');
    if (!LIMITS.PART_ID.test(id)) return fail('パートの名前は英数字8文字までにしてください。');
    if (!GROUPS.includes(group)) return fail('弦か管打を選んでください。');
    const parts = this.parts().slice();
    if (parts.some((x) => x.id.toLowerCase() === id.toLowerCase())) return fail('同じ名前のパートがあります。', 'DUPLICATE');
    if (parts.length >= LIMITS.PART_COUNT) return fail(`パートは${LIMITS.PART_COUNT}までです。`);
    let at = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].group === group) { at = i + 1; break; }
    if (group === 'strings' && !parts.some((x) => x.group === 'strings')) at = 0;
    parts.splice(at, 0, { id, group });
    this.kput('parts', JSON.stringify(parts));
    return { ok: true, parts };
  }],

  /** パートを消す。そのパートの団員がいれば消せない */
  deletePart: ['admin', function (p) {
    const id = String(p.id || '');
    const parts = this.parts();
    if (!parts.some((x) => x.id === id)) return fail('パートが見つかりません。', 'NOT_FOUND');
    const n = this.db.exec('SELECT COUNT(*) AS n FROM members WHERE part = ?', id)[0].n;
    if (n) return fail(`${id} の団員が${n}人いるため消せません。先にその人のパートを変えてください。`, 'IN_USE');
    const next = parts.filter((x) => x.id !== id);
    this.kput('parts', JSON.stringify(next));
    return { ok: true, parts: next };
  }],

  setPassphrase: ['admin', async function (p) {
    const v = String(p.passphrase || '').trim();
    if (v.length < LIMITS.PASSPHRASE_MIN || v.length > LIMITS.PASSPHRASE_MAX) return fail(`合言葉は${LIMITS.PASSPHRASE_MIN}〜${LIMITS.PASSPHRASE_MAX}文字にしてください。`);
    this.kput('passphrase', await hashSecret(v));
    return { ok: true, open: true };
  }],

  /** CSV の書き出し。year を渡すとその年度の練習日だけ */
  exportCsv: ['admin', function (p) {
    const [from, to] = p && p.year ? yearRange(Number(p.year)) : ['0000-00-00', '9999-99-99'];
    const rows = this.db.exec(`SELECT d.date, d.kind, d.st, d.en, m.name, m.part, a.status, a.reason, a.at, a.updated_at
      FROM days d CROSS JOIN members m LEFT JOIN answers a ON a.day_id = d.id AND a.member_id = m.id
      WHERE d.noentry = 0 AND d.date BETWEEN ? AND ? ORDER BY d.date, d.st, m.part, m.name`, from, to);
    const label = { attend: '出席', late: '遅刻', early: '早退', absent: '欠席' };
    const order = Object.fromEntries(this.partIds().map((id, i) => [id, i]));
    const pos = (part) => (part in order ? order[part] : 999);
    rows.sort((a, b) => (a.date + a.st).localeCompare(b.date + b.st) || (pos(a.part) - pos(b.part)) || a.name.localeCompare(b.name, 'ja'));
    const lines = [['日付', '種類', '開始', '終了', '氏名', 'パート', '出欠', '時刻', '欠席理由', '回答日時']];
    for (const r of rows) lines.push([r.date, r.kind, r.st, r.en, r.name, r.part, label[r.status] || '未回答', r.at || '', r.reason || '', r.updated_at || '']);
    return { ok: true, csv: lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }],
};

// ---------------- 小さな道具 ----------------
/** 年度（y年4月1日から翌年3月31日まで） */
function yearRange(y) { return [`${y}-04-01`, `${y + 1}-03-31`]; }
/** 練習日の日付が正しいか */
function isDate(d) { return DATE.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d; }
/** 練習日の種類・時刻・メモを確かめてそろえる。誤りがあれば { error } */
function dayFields(p) {
  const st = String(p.st || '');
  const en = String(p.en || '');
  if (st && !TIME.test(st)) return { error: '開始時刻の形が正しくありません。' };
  if (en && !TIME.test(en)) return { error: '終了時刻の形が正しくありません。' };
  if (st && en && en <= st) return { error: '終了時刻は開始時刻より後にしてください。' };
  const noentry = p.noentry === true || p.noentry === 1 || p.noentry === '1' || p.noentry === 'on' ? 1 : 0;
  const kind = cleanText(p.kind, LIMITS.KIND);
  if (noentry && !kind) return { error: '出欠をとらない予定には種類（授業・祝日など）を入れてください。' };
  return { kind, st, en, note: cleanText(p.note, LIMITS.NOTE), noentry };
}
function fail(message, code) { return { ok: false, code: code || 'BAD_REQUEST', message }; }
function userError(message, code) { const e = new Error(message); e.userMessage = message; e.code = code; return e; }

/**
 * 姓と名から氏名を作る。姓・名の中のスペースは除き、氏名は姓と名をスペースなしでつなぐ（例: 宮教太郎）。
 * 姓と名のどちらかが空なら name を空で返す
 */
function personName(p) {
  const sei = String(p.sei || '').replace(/[\s　]+/g, '').slice(0, LIMITS.NAME);
  const mei = String(p.mei || '').replace(/[\s　]+/g, '').slice(0, LIMITS.NAME);
  if (!sei || !mei) return { name: '', sei, mei };
  return { name: (sei + mei).slice(0, LIMITS.NAME), sei, mei };
}
/** 氏名をスペース抜きで比べる（前の登録で残ったスペースがあっても同じ人として扱う） */
const SAME_NAME = "REPLACE(REPLACE(name, '　', ''), ' ', '') = ?";
function bare(name) { return name.replace(/[\s　]+/g, ''); }
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
