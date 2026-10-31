/**
 * 出欠の正本（Cloudflare の Durable Object の中の SQLite）
 *
 * 画面からの呼び出し（POST /api）をここで受けて、確かめてから読み書きする。
 * - データベースの操作は db.exec(SQL, ...値) → 行の配列、db.txn(関数) → 1つの取引にまとめる、の2つだけを使う。
 *   Cloudflare では Durable Object の ctx.storage.sql、テストでは Node の node:sqlite をこの形に合わせて渡す。
 * - 欠席理由は、本人・パートリーダー・管理者にだけ返す。返さない相手への応答には、理由の項目そのものを入れない。
 * - 合言葉・暗証番号・管理用パスワードの照合は時間のかかる計算（待ちが入る）なので先に済ませ、
 *   そのあとの読み書きは待たずに一気に行う（途中で別の呼び出しが割り込まない）。
 */

import { ALGS, bytesOf, readClientData, readAuthData, authDataOf, verifySignature } from './passkey.js';
import { DUMMY_HASH, toB64url, randomId, sha256, hashSecret, verifySecret } from './secret.js';
import { GROUPS, LIMITS, PARTS, ROLES, SECTIONS, SECTION_PARTS, STATUSES, STATUS_LABEL, DAY_MS } from './limits.js';
import { initSchema } from './schema.js';
import {
  SAME_NAME, TIME, bare, cleanText, count, csvCell, cut, isDate, jstTime, originOf, personName, tempPin, yearRange,
} from './util.js';

export { GROUPS, LIMITS, PARTS, ROLES, SECTIONS, STATUS_LABEL, STATUSES } from './limits.js';

/** パートリーダーか管理者か（欠席理由を読め、練習日を登録できる） */
function isOfficer(role) { return role === 'officer' || role === 'admin'; }
/** 練習日の管理の画面に入れるか（パートリーダー・セクションリーダー・管理者） */
function isLead(who) { return isOfficer(who.role) || !!(who.member && SECTIONS[who.member.lead]); }

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

  /** 表を作り、前の形のデータを今の形に直す。何度呼んでもよい */
  init() { initSchema(this.db); }

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
      if (!ALLOWED[need](who)) return fail(DENIED[need], 'FORBIDDEN');
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
    if (s.last_used + LIMITS.SESSION_DAYS * DAY_MS < now) { this.db.exec('DELETE FROM sessions WHERE token = ?', hash); return null; }
    // 使った時刻は1日に1回だけ書き直す（書き込みを減らす）
    if (now - s.last_used > DAY_MS) this.db.exec('UPDATE sessions SET last_used = ? WHERE token = ?', now, hash);
    if (!s.member_id) {
      // 管理用パスワードでのログインは、作ったときのパスワードに結び付けてある。パスワードを変えたり消したりしたら、前のログインは使えない
      const pw = String(this.env.ADMIN_PASSWORD || '');
      if (!pw || s.admin_pw !== await adminTag(token, pw)) { this.db.exec('DELETE FROM sessions WHERE token = ?', hash); return null; }
      return { member: null, role: 'admin', session: hash };
    }
    const m = this.member(s.member_id);
    if (!m) { this.db.exec('DELETE FROM sessions WHERE token = ?', hash); return null; }
    return { member: m, role: m.role, session: hash };
  }

  async newSession(memberId) {
    const token = randomId(32);
    const now = this.now();
    // 管理用パスワードでのログインには、そのときのパスワードとの結び付きを置く（団員のログインは空）
    const tag = memberId ? '' : await adminTag(token, String(this.env.ADMIN_PASSWORD || ''));
    this.db.exec('DELETE FROM sessions WHERE last_used < ?', now - LIMITS.SESSION_DAYS * DAY_MS); // 期限切れの掃除
    this.db.exec('INSERT INTO sessions (token, member_id, created, last_used, admin_pw) VALUES (?, ?, ?, ?, ?)', await sha256(token), memberId || '', now, now, tag);
    return token;
  }
  /** ログインの印を作り、ログインできたときの応答を返す。m が null なら管理用パスワードでのログイン */
  async signIn(m, extra) {
    const token = await this.newSession(m ? m.id : '');
    const me = this.meOf(m ? { member: m, role: m.role } : { member: null, role: 'admin' });
    return Object.assign({ ok: true, token, me }, extra);
  }

  /**
   * 暗証番号の誤りを数える。5回ごとに止め、止めるたびに止める時間を倍にする（10分、20分、40分…最長1日）。
   * 数え直すのは正しく入れたときと、再設定したときだけ（止まるたびに数え直すと、時間をかければ4桁を当てられるため）
   */
  pinFailed(m) {
    const n = m.failures + 1;
    const lock = n % LIMITS.PIN_FAILURES === 0;
    const seconds = Math.min(LIMITS.LOCK_SECONDS * 2 ** (n / LIMITS.PIN_FAILURES - 1), LIMITS.PIN_LOCK_MAX_SECONDS);
    this.db.exec('UPDATE members SET failures = ?, locked_until = ? WHERE id = ?', n, lock ? this.now() + seconds * 1000 : 0, m.id);
  }

  /** 合言葉を確かめる。同じ接続元から続けて間違えたら止める */
  async checkPassphrase(input, ip) {
    const stored = this.kget('passphrase');
    if (!stored) throw userError('まだ登録を受け付けていません。管理者に連絡してください。', 'CLOSED');
    this.checkGate(ip);
    const ok = await verifySecret(String(input || '').trim(), stored); // 設定のときと同じく前後の空白は除く
    this.checkGate(ip); // 待つあいだに同じ接続元の誤りが重なっていれば、結果を返さず止める
    if (!ok) { this.gateFailed(ip); throw userError('合言葉が違います。', 'WRONG_PASSPHRASE'); }
    this.gatePassed(ip);
  }
  // 合言葉・管理用パスワード・ログインの誤りの回数（同じ接続元ごと）
  checkGate(ip) {
    const n = Number(this.kget('gate:' + ip) || 0);
    if (n >= LIMITS.GATE_FAILURES) throw userError('入力の誤りが続いたため、しばらく使えません。10分ほどあけてください。', 'LOCKED');
  }
  gateFailed(ip) {
    const n = Number(this.kget('gate:' + ip) || 0) + 1;
    this.kput('gate:' + ip, n, LIMITS.LOCK_SECONDS);
  }
  gatePassed(ip) { this.kdel('gate:' + ip); }

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
      lead: m && SECTIONS[m.lead] ? m.lead : '',
      canReadReasons: isOfficer(who.role),
    };
  }
  adminCount() {
    return this.db.exec("SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n;
  }
  listDays() {
    return this.db.exec('SELECT id, date, kind, st, en, note, noentry, splits FROM days ORDER BY date, st').map(withSplits);
  }
  /** 今のパートの一覧 [{ id, group }] */
  parts() {
    const v = this.kget('parts');
    if (v) { try { return JSON.parse(v); } catch (e) { /* 壊れていれば初めの一覧 */ } }
    return PARTS;
  }
  partIds() { return this.parts().map((p) => p.id); }
  /** セクションのパート。弦は弦の組のパート全部、木管と金管は決まったパートのうち今あるもの */
  sectionParts(section) {
    if (section === 'strings') return this.parts().filter((p) => p.group === 'strings').map((p) => p.id);
    return (SECTION_PARTS[section] || []).filter((id) => this.partIds().includes(id));
  }
  /**
   * パートごとの内容（分奏など）を書いてよいか。管理者は全部、パートリーダーは自分のパートだけの内容、
   * セクションリーダーは自分のセクションの中のパートだけの内容
   */
  canEditSplit(who, parts) {
    if (who.role === 'admin') return true;
    const m = who.member;
    if (!m) return false;
    if (who.role === 'officer' && parts.length === 1 && parts[0] === m.part) return true;
    const sec = SECTIONS[m.lead] ? this.sectionParts(m.lead) : [];
    return sec.length > 0 && parts.every((x) => sec.includes(x));
  }
  /**
   * 送られてきたパートごとの内容を、書いてよい分だけ受ける。書けない内容は、前のまま残っていなければ断る
   * （ほかの人の内容を足したり、変えたり、消したりはできない）。前の内容は old
   */
  checkSplits(who, old, next) {
    if (who.role === 'admin') return null;
    const key = (s) => JSON.stringify([s.parts, s.kind, s.st, s.en]);
    const oldOthers = old.filter((s) => !this.canEditSplit(who, s.parts)).map(key);
    const nextOthers = next.filter((s) => !this.canEditSplit(who, s.parts)).map(key);
    const same = oldOthers.length === nextOthers.length && oldOthers.every((k) => nextOthers.includes(k));
    return same ? null : (who.role === 'officer' ? '自分のパートの内容' : '自分のセクションの内容') + 'だけを変えられます。';
  }

  /** パスキーの相手のサイト（ALLOWED_ORIGIN）と、その名前（rpId） */
  site() {
    const origin = originOf(this.env.ALLOWED_ORIGIN);
    return { origin, rpId: origin ? new URL(origin).hostname : '' }; // 設定がなければパスキーは使えない
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
  /** 記録に残す今の日時（ISO の形） */
  stamp() { return new Date(this.now()).toISOString(); }
  member(id) { return this.db.exec('SELECT * FROM members WHERE id = ?', id)[0]; }

  /** 練習日を1つ足す。f は dayFields で確かめたもの */
  addDay(date, f) {
    const id = randomId(9);
    this.db.exec('INSERT INTO days (id, date, kind, st, en, note, noentry, splits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, date, f.kind, f.st, f.en, f.note, f.noentry, JSON.stringify(f.splits));
    return id;
  }
  /** 練習日を、その出欠ごと消す（呼ぶ側で db.txn に入れる） */
  removeDays(ids) {
    for (const id of ids) {
      this.db.exec('DELETE FROM answers WHERE day_id = ?', id);
      this.db.exec('DELETE FROM days WHERE id = ?', id);
    }
  }
  /** 団員を、出欠の記録・ログイン・パスキーごと消す。最後の管理者は、団員としてのログインからは消せない */
  removeMembers(ids, who) {
    const rows = ids.map((id) => this.member(id));
    if (rows.some((m) => !m)) return fail('団員が見つかりません。', 'NOT_FOUND');
    const admins = rows.filter((m) => m.role === 'admin').length;
    if (admins && this.adminCount() - admins < 1 && who.member) return fail('最後の管理者は消せません。', 'LAST_ADMIN');
    this.db.txn(() => {
      for (const id of ids) {
        for (const table of ['answers', 'sessions', 'passkeys']) this.db.exec(`DELETE FROM ${table} WHERE member_id = ?`, id);
        this.db.exec('DELETE FROM members WHERE id = ?', id);
      }
    });
    return { ok: true, deleted: ids.length };
  }
}

// 操作に要る立場と、足りないときの言葉。any はログインしていれば誰でも
const ALLOWED = {
  any: () => true,
  member: (who) => !!who.member,
  lead: (who) => isLead(who),
  officer: (who) => isOfficer(who.role),
  admin: (who) => who.role === 'admin',
};
const DENIED = {
  member: '団員としてログインしてください。',
  lead: 'パートリーダー・セクションリーダー・管理者だけが使えます。',
  officer: 'パートリーダーと管理者だけが使えます。',
  admin: '管理者だけが使えます。',
};

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
      id, name, sei, mei, part, 'member', pinHash, this.stamp());
    return this.signIn(this.member(id));
  },

  async login(p, c) {
    // ログインは氏名を一つの欄で受ける。スペースの有無は問わない（姓と名で送られても受ける）
    const name = p.name !== undefined ? cut(bare(String(p.name)), LIMITS.NAME * 2) : personName(p).name;
    const pin = String(p.pin || '');
    if (!name || !pin) return fail('氏名と暗証番号を入れてください。');
    // 合言葉は登録のときだけ。ログインは氏名と暗証番号で、同じ接続元からの誤りが続けば止める
    this.checkGate(c.ip);
    const found = this.db.exec(`SELECT * FROM members WHERE ${SAME_NAME}`, bare(name))[0];
    // 登録がない氏名でも、暗証番号の計算は同じだけ行う（登録の有無を、かかる時間から知られないため）
    const ok = await verifySecret(pin, found ? found.pin : DUMMY_HASH);
    // 照合を待つあいだにほかの呼び出しが進んでいることがあるので、誤りの回数と団員の行を読み直してから決める
    // （同時にたくさん送って回数の数え漏れを狙うことや、番号を変えた直後に古い番号で入ることを防ぐ）
    this.checkGate(c.ip);
    const m = found && this.member(found.id);
    if (!m || m.pin !== found.pin) { this.gateFailed(c.ip); return fail('氏名か暗証番号が違います。', 'WRONG_PIN'); }
    if (m.locked_until > this.now()) return fail(PIN_LOCKED, 'LOCKED');
    if (!ok) {
      this.gateFailed(c.ip);
      this.pinFailed(m);
      return fail('氏名か暗証番号が違います。', 'WRONG_PIN');
    }
    this.db.exec('UPDATE members SET failures = 0, locked_until = 0 WHERE id = ?', m.id);
    this.gatePassed(c.ip);
    return this.signIn(m, { hasPasskey: this.hasPasskey(m.id) });
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
      const clientData = bytesOf(p.clientDataJSON);
      const authData = bytesOf(p.authenticatorData);
      const challenge = readClientData(clientData, 'webauthn.get', origin);
      if (!this.useChallenge(challenge, 'login')) return failed();
      await readAuthData(authData, rpId, false);
      const key = this.db.exec('SELECT * FROM passkeys WHERE id = ?', String(p.id || ''))[0];
      if (!key) return fail('このパスキーは登録されていません。暗証番号でログインしてください。', 'PASSKEY_UNKNOWN');
      const ok = await verifySignature(JSON.parse(key.jwk), key.alg, authData, clientData, bytesOf(p.signature));
      if (!ok) return failed();
      const m = this.member(key.member_id);
      if (!m) return failed();
      this.gatePassed(c.ip);
      this.db.exec('UPDATE passkeys SET last_used = ? WHERE id = ?', this.stamp(), key.id);
      return await this.signIn(m, { hasPasskey: true });
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
    this.checkGate(c.ip); // 待つあいだに同じ接続元の誤りが重なっていれば、結果を返さず止める
    if (!ok) { this.gateFailed(c.ip); return fail('管理用パスワードが違います。', 'WRONG_PASSWORD'); }
    this.gatePassed(c.ip);
    return this.signIn(null);
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
    // none は答えを取り消して未回答に戻す（リストの札を押し直したとき）
    if (status === 'none') {
      this.db.exec('DELETE FROM answers WHERE day_id = ? AND member_id = ?', day.id, who.member.id);
      return { ok: true, answer: { status: 'none', reason: '', at: '' } };
    }
    if (!STATUSES.includes(status)) return fail('出欠を選んでください。');
    const reason = status === 'absent' ? cleanText(p.reason, LIMITS.REASON) : '';
    const at = status === 'late' || status === 'early' ? String(p.at || '') : '';
    if (at && !TIME.test(at)) return fail('時刻の形が正しくありません。');
    this.db.exec(`INSERT INTO answers (day_id, member_id, status, reason, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day_id, member_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at, updated_at = excluded.updated_at`,
    day.id, who.member.id, status, reason, at, this.stamp());
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
    const m = this.member(who.member.id);
    return { ok: true, me: this.meOf({ member: m, role: m.role }) };
  }],

  /** 自分の暗証番号を変える。今の番号を確かめ、ほかの端末のログインは切る（いま使っている端末はそのまま） */
  changePin: ['member', async function (p, who) {
    const pin = String(p.pin || '');
    const next = String(p.newPin || '');
    if (!pin) return fail('今の暗証番号を入れてください。');
    if (!LIMITS.PIN.test(next)) return fail('新しい暗証番号は4〜8桁の数字にしてください。');
    const ok = await verifySecret(pin, who.member.pin);
    const nextHash = await hashSecret(next);
    // 照合のあいだに変わっているかもしれないので、読み直してから書く
    const m = this.member(who.member.id);
    if (!m) return fail('団員が見つかりません。', 'NOT_FOUND');
    if (m.locked_until > this.now()) return fail(PIN_LOCKED, 'LOCKED');
    if (!ok || m.pin !== who.member.pin) {
      this.pinFailed(m); // ログインと同じく、続けて間違えたら止める
      return fail('今の暗証番号が違います。', 'WRONG_PIN');
    }
    this.db.txn(() => {
      this.db.exec('UPDATE members SET pin = ?, failures = 0, locked_until = 0 WHERE id = ?', nextHash, m.id);
      this.db.exec('DELETE FROM sessions WHERE member_id = ? AND token <> ?', m.id, who.session);
    });
    return { ok: true };
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
      const clientData = bytesOf(p.clientDataJSON);
      const challenge = readClientData(clientData, 'webauthn.create', origin);
      if (!this.useChallenge(challenge, 'reg:' + m.id)) return failed();
      key = await readAuthData(authDataOf(bytesOf(p.attestationObject)), rpId, true);
    } catch (e) {
      if (e && e.passkey) return failed();
      throw e;
    }
    const id = toB64url(key.credId);
    if (!id || id.length > 1400) return failed();
    if (this.passkeyList(m.id).length >= LIMITS.PASSKEYS) return fail(`パスキーは${LIMITS.PASSKEYS}個までです。使わないものを消してください。`);
    if (this.db.exec('SELECT 1 FROM passkeys WHERE id = ?', id).length) return fail('このパスキーはすでに登録しています。', 'DUPLICATE');
    this.db.exec('INSERT INTO passkeys (id, member_id, jwk, alg, created_at) VALUES (?, ?, ?, ?, ?)',
      id, m.id, JSON.stringify(key.jwk), key.alg, this.stamp());
    return { ok: true, passkeys: this.passkeyList(m.id) };
  }],

  passkeyDelete: ['member', function (p, who) {
    this.db.exec('DELETE FROM passkeys WHERE id = ? AND member_id = ?', String(p.id || ''), who.member.id);
    return { ok: true, passkeys: this.passkeyList(who.member.id) };
  }],

  /** 練習日ごとの、パート別の出欠。欠席理由は本人と、パートリーダー・管理者にだけ入れる */
  roster: ['any', function (p, who) {
    const row = this.db.exec('SELECT id, date, kind, st, en, note, splits FROM days WHERE id = ? AND noentry = 0', String(p.dayId || ''))[0];
    if (!row) return fail('練習日が見つかりません。', 'NOT_FOUND');
    const day = withSplits(row);
    const canRead = isOfficer(who.role);
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
  /** 管理画面に出すもの。パートリーダーには練習日だけを返す */
  adminData: ['lead', function (p, who) {
    // セクションリーダー（パートリーダーでない人）には練習日だけ
    if (!isOfficer(who.role)) return { ok: true, days: this.listDays(), parts: this.parts() };
    // パートリーダーには、暗証番号の再設定のために団員の氏名・パート・役割も返す
    if (who.role !== 'admin') return { ok: true, days: this.listDays(), members: this.db.exec('SELECT id, name, part, role FROM members ORDER BY name'), parts: this.parts() };
    const members = this.db.exec('SELECT id, name, part, role, lead, created_at FROM members ORDER BY name');
    return { ok: true, days: this.listDays(), members, open: !!this.kget('passphrase'), roles: ROLES, sections: SECTIONS, parts: this.parts() };
  }],

  saveDay: ['officer', function (p, who) {
    const date = String(p.date || '');
    if (!isDate(date)) return fail('日付を入れてください。');
    const f = dayFields(p, this.partIds());
    if (f.error) return fail(f.error);
    let id = String(p.id || '');
    const row = id ? this.db.exec('SELECT splits FROM days WHERE id = ?', id)[0] : { splits: '[]' };
    if (!row) return fail('練習日が見つかりません。', 'NOT_FOUND');
    const denied = this.checkSplits(who, withSplits(row).splits, f.splits);
    if (denied) return fail(denied, 'FORBIDDEN');
    if (id) {
      // 出欠をとらない予定に変えると、その日の出欠は消す。入っていれば、先に画面で確かめてもらう（dropAnswers）
      const n = f.noentry ? this.db.exec('SELECT COUNT(*) AS n FROM answers WHERE day_id = ?', id)[0].n : 0;
      if (n && p.dropAnswers !== true) return fail(`${n}人の出欠も消えます。出欠をとらない予定にしますか？`, 'HAS_ANSWERS');
      this.db.txn(() => {
        if (n) this.db.exec('DELETE FROM answers WHERE day_id = ?', id);
        this.db.exec('UPDATE days SET date = ?, kind = ?, st = ?, en = ?, note = ?, noentry = ?, splits = ? WHERE id = ?', date, f.kind, f.st, f.en, f.note, f.noentry, JSON.stringify(f.splits), id);
      });
    } else {
      id = this.addDay(date, f);
    }
    return { ok: true, id, days: this.listDays() };
  }],

  /** 同じ種類・時刻・メモの練習日を、いくつもの日付にまとめて足す */
  saveDays: ['officer', function (p, who) {
    const dates = [...new Set(Array.isArray(p.dates) ? p.dates.map(String) : [])].sort();
    if (!dates.length) return fail('日付を選んでください。');
    if (dates.length > LIMITS.DAYS_AT_ONCE) return fail(`一度に足せるのは${LIMITS.DAYS_AT_ONCE}日までです。`);
    if (!dates.every(isDate)) return fail('日付の形が正しくありません。');
    const f = dayFields(p, this.partIds());
    if (f.error) return fail(f.error);
    const denied = this.checkSplits(who, [], f.splits);
    if (denied) return fail(denied, 'FORBIDDEN');
    this.db.txn(() => { for (const date of dates) this.addDay(date, f); });
    return { ok: true, added: dates.length, days: this.listDays() };
  }],

  /** パートごとの内容だけを直す。パートリーダーとセクションリーダーは自分の分だけ */
  saveSplits: ['lead', function (p, who) {
    const row = this.db.exec('SELECT * FROM days WHERE id = ? AND noentry = 0', String(p.id || ''))[0];
    if (!row) return fail('練習日が見つかりません。', 'NOT_FOUND');
    const s = splitFields(p.splits, this.partIds());
    if (s.error) return fail(s.error);
    const denied = this.checkSplits(who, withSplits(row).splits, s.list);
    if (denied) return fail(denied, 'FORBIDDEN');
    this.db.exec('UPDATE days SET splits = ? WHERE id = ?', JSON.stringify(s.list), row.id);
    return { ok: true, id: row.id, days: this.listDays() };
  }],

  deleteDay: ['officer', function (p) {
    const id = String(p.id || '');
    this.db.txn(() => this.removeDays([id]));
    return { ok: true, days: this.listDays() };
  }],

  setRole: ['admin', function (p, who) {
    const id = String(p.id || '');
    const role = String(p.role || '');
    if (!ROLES.includes(role)) return fail('役割が正しくありません。');
    const m = this.member(id);
    if (!m) return fail('団員が見つかりません。', 'NOT_FOUND');
    if (m.role === 'admin' && role !== 'admin' && this.adminCount() <= 1 && who.member) {
      return fail('管理者が1人もいなくなるため、外せません。先にほかの人を管理者にしてください。', 'LAST_ADMIN');
    }
    this.db.exec('UPDATE members SET role = ? WHERE id = ?', role, id);
    return { ok: true };
  }],

  /** セクションリーダーにする（lead は strings・woodwinds・brass、空なら外す） */
  setLead: ['admin', function (p) {
    const lead = String(p.lead || '');
    if (lead && !SECTIONS[lead]) return fail('セクションが正しくありません。');
    if (!this.member(String(p.id || ''))) return fail('団員が見つかりません。', 'NOT_FOUND');
    this.db.exec('UPDATE members SET lead = ? WHERE id = ?', lead, String(p.id));
    return { ok: true };
  }],

  /** 団員を消す（出欠の記録・ログイン・パスキーも消す） */
  deleteMember: ['admin', function (p, who) {
    return this.removeMembers([String(p.id)], who);
  }],

  /** 団員をまとめて消す（卒業した人など） */
  deleteMembers: ['admin', function (p, who) {
    const ids = [...new Set(Array.isArray(p.ids) ? p.ids.map(String) : [])];
    if (!ids.length) return fail('団員を選んでください。');
    return this.removeMembers(ids, who);
  }],

  /**
   * 暗証番号を忘れた人のために、仮の番号に変える。出欠の記録・ログイン・パスキーはそのまま残す。
   * 仮の番号はこの応答でだけ返し、置くのは元に戻せない形だけ。パートリーダーが変えられるのは団員（member）だけ
   */
  resetPin: ['officer', async function (p, who) {
    const id = String(p.id || '');
    const target = this.member(id);
    if (!target) return fail('団員が見つかりません。', 'NOT_FOUND');
    if (who.role !== 'admin' && target.role !== 'member') return fail('パートリーダーと管理者の暗証番号は、管理者だけが再設定できます。', 'FORBIDDEN');
    const pin = tempPin();
    const hash = await hashSecret(pin);
    // 計算を待つあいだに役割が変わっていることがあるので、読み直して確かめ直す
    const fresh = this.member(id);
    if (!fresh) return fail('団員が見つかりません。', 'NOT_FOUND');
    const by = who.member ? this.member(who.member.id) : null;
    const role = who.member ? (by ? by.role : '') : 'admin';
    if (!isOfficer(role)) return fail(DENIED.officer, 'FORBIDDEN');
    if (role !== 'admin' && fresh.role !== 'member') return fail('パートリーダーと管理者の暗証番号は、管理者だけが再設定できます。', 'FORBIDDEN');
    this.db.exec('UPDATE members SET pin = ?, failures = 0, locked_until = 0 WHERE id = ?', hash, id);
    return { ok: true, name: target.name, pin };
  }],

  /** 年度（4月から翌年3月）の練習日と、その出欠をまとめて消す */
  deleteYear: ['admin', function (p) {
    const y = Number(p.year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return fail('年度を選んでください。');
    const [from, to] = yearRange(y);
    if (to >= this.today()) return fail('終わっていない年度は消せません。');
    const ids = this.db.txn(() => {
      const found = this.db.exec('SELECT id FROM days WHERE date BETWEEN ? AND ?', from, to).map((d) => d.id);
      this.removeDays(found);
      return found;
    });
    return { ok: true, deleted: ids.length, days: this.listDays() };
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
    const n = count(v);
    if (n < LIMITS.PASSPHRASE_MIN || n > LIMITS.PASSPHRASE_MAX) return fail(`合言葉は${LIMITS.PASSPHRASE_MIN}〜${LIMITS.PASSPHRASE_MAX}文字にしてください。`);
    this.kput('passphrase', await hashSecret(v));
    return { ok: true, open: true };
  }],

  /** CSV の書き出し。year を渡すとその年度の練習日だけ */
  exportCsv: ['admin', function (p) {
    const [from, to] = p && p.year ? yearRange(Number(p.year)) : ['0000-00-00', '9999-99-99'];
    const rows = this.db.exec(`SELECT d.date, d.kind, d.st, d.en, d.splits, m.name, m.part, a.status, a.reason, a.at, a.updated_at
      FROM days d CROSS JOIN members m LEFT JOIN answers a ON a.day_id = d.id AND a.member_id = m.id
      WHERE d.noentry = 0 AND d.date BETWEEN ? AND ? ORDER BY d.date, d.st, m.part, m.name`, from, to);
    const order = Object.fromEntries(this.partIds().map((id, i) => [id, i]));
    const pos = (part) => (part in order ? order[part] : 999);
    rows.sort((a, b) => (a.date + a.st).localeCompare(b.date + b.st) || (pos(a.part) - pos(b.part)) || a.name.localeCompare(b.name, 'ja'));
    const lines = [['日付', '種類', '開始', '終了', '氏名', 'パート', '出欠', '時刻', '欠席理由', '回答日時']];
    for (const row of rows) {
      // 分けて書いた内容があれば、その人のパートの内容と時刻を出す
      const s = withSplits(row).splits.find((x) => x.parts.includes(row.part));
      const r = s ? Object.assign({}, row, { kind: s.kind, st: s.st, en: s.en }) : row;
      lines.push([r.date, r.kind, r.st, r.en, r.name, r.part, STATUS_LABEL[r.status] || '未回答', r.at || '', r.reason || '', jstTime(r.updated_at)]);
    }
    return { ok: true, csv: lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }],
};

// ---------------- 小さな道具 ----------------
/** 練習日の種類・時刻・メモと、分けて書いた内容を確かめてそろえる。誤りがあれば { error } */
function dayFields(p, partIds) {
  const st = String(p.st || '');
  const en = String(p.en || '');
  if (st && !TIME.test(st)) return { error: '開始時刻の形が正しくありません。' };
  if (en && !TIME.test(en)) return { error: '終了時刻の形が正しくありません。' };
  if (st && en && en <= st) return { error: '終了時刻は開始時刻より後にしてください。' };
  const noentry = p.noentry === true || p.noentry === 1 || p.noentry === '1' || p.noentry === 'on' ? 1 : 0;
  const kind = cleanText(p.kind, LIMITS.KIND);
  if (noentry && !kind) return { error: '出欠をとらない予定には種類（授業・祝日など）を入れてください。' };
  const splits = noentry ? { list: [] } : splitFields(p.splits, partIds || []);
  if (splits.error) return { error: splits.error };
  return { kind, st, en, note: cleanText(p.note, LIMITS.NOTE), noentry, splits: splits.list };
}
/**
 * 1日の練習の中で、組やパートごとに分けた内容（弦は分奏、Hr はパート練習など）を確かめる。
 * [{ parts: ['Vn', …], kind, st, en }]。一つのパートは一つの内容にだけ入れられる。画面からは JSON の文字でも届く
 */
function splitFields(v, partIds) {
  let a = v;
  if (typeof a === 'string') { try { a = a ? JSON.parse(a) : []; } catch (e) { return { error: '分けた内容の形が正しくありません。' }; } }
  if (a === undefined || a === null) a = [];
  if (!Array.isArray(a)) return { error: '分けた内容の形が正しくありません。' };
  if (a.length > LIMITS.SPLITS) return { error: `分けられる内容は${LIMITS.SPLITS}までです。` };
  const used = new Set();
  const list = [];
  for (const s of a) {
    const parts = [...new Set(Array.isArray(s && s.parts) ? s.parts.map(String) : [])].filter((x) => partIds.includes(x));
    if (!parts.length) return { error: '分けた内容にパートを選んでください。' };
    if (parts.some((x) => used.has(x))) return { error: '一つのパートを二つの内容に入れることはできません。' };
    parts.forEach((x) => used.add(x));
    const kind = cleanText(s.kind, LIMITS.KIND);
    if (!kind) return { error: '分けた内容に種類（分奏など）を入れてください。' };
    const st = String(s.st || '');
    const en = String(s.en || '');
    if ((st && !TIME.test(st)) || (en && !TIME.test(en))) return { error: '時刻の形が正しくありません。' };
    if (st && en && en <= st) return { error: '終了時刻は開始時刻より後にしてください。' };
    list.push({ parts: partIds.filter((x) => parts.includes(x)), kind, st, en });
  }
  return { list };
}
/** データベースの行の splits（JSON の文字）を配列にする */
function withSplits(row) {
  let splits = [];
  try { splits = JSON.parse(row.splits || '[]'); } catch (e) { /* 壊れていれば分けていない日として扱う */ }
  return Object.assign({}, row, { splits: Array.isArray(splits) ? splits : [] });
}
const PIN_LOCKED = '暗証番号の誤りが続いたため、しばらく使えません。時間をあけるか、パートリーダーに暗証番号の再設定を頼んでください。';
/** 管理用パスワードでのログインと、そのときのパスワードとの結び付き。印そのものと混ぜるので、置いた値からパスワードは割り出せない */
function adminTag(token, password) { return sha256(token + '\n' + password); }
function fail(message, code) { return { ok: false, code: code || 'BAD_REQUEST', message }; }
function userError(message, code) { const e = new Error(message); e.userMessage = message; e.code = code; return e; }

