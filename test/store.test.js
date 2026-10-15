// store.js の動きを、Node の SQLite（node:sqlite）で確かめる。npm test で流す
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

function setup(opts) {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    exec: (q, ...b) => {
      const st = sqlite.prepare(q);
      return st.columns().length ? st.all(...b) : (st.run(...b), []);
    },
    txn: (fn) => {
      sqlite.exec('BEGIN');
      try { const r = fn(); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  let now = Date.parse('2026-10-15T03:00:00Z'); // 日本時間 10月15日 12時
  const store = new Store(db, Object.assign({ ADMIN_PASSWORD: 'admin-pass', ALLOWED_ORIGIN: 'https://orch.example.org' }, opts), () => now);
  const call = (action, params, token, ip) => store.api({ action, params }, { token, ip: ip || '1.1.1.1' });
  return { store, call, advance: (ms) => { now += ms; } };
}

async function ready() {
  const t = setup();
  const admin = await t.call('adminLogin', { password: 'admin-pass' });
  assert.equal(admin.ok, true);
  assert.equal((await t.call('setPassphrase', { passphrase: 'orchestra' }, admin.token)).ok, true);
  const day = await t.call('saveDay', { date: '2026-10-17', kind: '分奏', st: '13:00', en: '17:00' }, admin.token);
  assert.equal(day.ok, true);
  return Object.assign(t, { adminToken: admin.token, dayId: day.id });
}

async function join(t, name, part, pin) {
  const r = await t.call('register', { passphrase: 'orchestra', name, part, pin: pin || '1234' });
  assert.equal(r.ok, true, r.message);
  return r.token;
}

test('合言葉が決まるまでは登録できない', async () => {
  const t = setup();
  assert.equal((await t.call('info')).open, false);
  const r = await t.call('register', { passphrase: 'x', name: '宮教 太郎', part: 'Vn', pin: '1234' });
  assert.equal(r.code, 'CLOSED');
});

test('管理用パスワードが違えば入れず、続けば止まる', async () => {
  const t = setup();
  for (let i = 0; i < 10; i++) assert.equal((await t.call('adminLogin', { password: 'nope' })).code, 'WRONG_PASSWORD');
  assert.equal((await t.call('adminLogin', { password: 'admin-pass' })).code, 'LOCKED');
  assert.equal((await t.call('adminLogin', { password: 'admin-pass' }, null, '2.2.2.2')).ok, true);
});

test('登録・ログイン・出欠の入力', async () => {
  const t = await ready();
  assert.equal((await t.call('register', { passphrase: 'wrong', name: 'A', part: 'Vn', pin: '1234' })).code, 'WRONG_PASSPHRASE');
  assert.equal((await t.call('register', { passphrase: 'orchestra', name: 'A', part: 'Vn', pin: '12' })).ok, false);
  const token = await join(t, ' 宮教  太郎 ', 'Vn');
  const home = await t.call('home', {}, token);
  assert.equal(home.me.name, '宮教　太郎');
  assert.equal(home.days.length, 1);
  assert.deepEqual(home.answers, {});
  // 同じ氏名では登録できない
  assert.equal((await t.call('register', { passphrase: 'orchestra', name: '宮教　太郎', part: 'Va', pin: '9999' })).code, 'DUPLICATE');

  const a = await t.call('answer', { dayId: t.dayId, status: 'absent', reason: '教育実習' }, token);
  assert.equal(a.ok, true);
  assert.deepEqual((await t.call('home', {}, token)).answers[t.dayId], { status: 'absent', reason: '教育実習' });
  // 出席に変えると理由は消える
  await t.call('answer', { dayId: t.dayId, status: 'attend', reason: 'のこる？' }, token);
  assert.deepEqual((await t.call('home', {}, token)).answers[t.dayId], { status: 'attend', reason: '' });

  // 別の端末からログイン
  const login = await t.call('login', { name: '宮教 太郎', pin: '1234' });
  assert.equal(login.ok, true);
  assert.equal(login.me.part, 'Vn');
  // ログアウトすると、その印は使えない
  await t.call('logout', {}, token);
  assert.equal((await t.call('home', {}, token)).code, 'UNAUTHORIZED');
  assert.equal((await t.call('home', {}, login.token)).ok, true);
});

test('暗証番号を5回間違えると10分止まる', async () => {
  const t = await ready();
  await join(t, '佐藤', 'Vc', '2468');
  for (let i = 0; i < 5; i++) assert.equal((await t.call('login', { name: '佐藤', pin: '0000' })).code, 'WRONG_PIN');
  assert.equal((await t.call('login', { name: '佐藤', pin: '2468' })).code, 'LOCKED');
  t.advance(601 * 1000);
  assert.equal((await t.call('login', { name: '佐藤', pin: '2468' })).ok, true);
});

test('欠席理由は本人と役職・管理者にだけ返す', async () => {
  const t = await ready();
  const absent = await join(t, '欠席する人', 'Va');
  const other = await join(t, 'ほかの団員', 'Fl');
  const officer = await join(t, '役職の人', 'Hr');
  await t.call('answer', { dayId: t.dayId, status: 'absent', reason: '体調不良' }, absent);
  await t.call('answer', { dayId: t.dayId, status: 'attend' }, other);
  const ids = (await t.call('adminData', {}, t.adminToken)).members;
  const officerId = ids.find((m) => m.name === '役職の人').id;
  assert.equal((await t.call('setRole', { id: officerId, role: 'officer' }, t.adminToken)).ok, true);

  const find = (r, name) => r.members.find((m) => m.name === name);
  const byOther = await t.call('roster', { dayId: t.dayId }, other);
  assert.equal(byOther.canReadReasons, false);
  assert.equal(find(byOther, '欠席する人').status, 'absent');
  assert.equal('reason' in find(byOther, '欠席する人'), false);
  assert.equal(JSON.stringify(byOther).includes('体調不良'), false);
  assert.equal(find(byOther, '役職の人').status, 'none');

  assert.equal(find(await t.call('roster', { dayId: t.dayId }, absent), '欠席する人').reason, '体調不良');
  assert.equal(find(await t.call('roster', { dayId: t.dayId }, officer), '欠席する人').reason, '体調不良');
  assert.equal(find(await t.call('roster', { dayId: t.dayId }, t.adminToken), '欠席する人').reason, '体調不良');
});

test('団員は管理の操作をできない', async () => {
  const t = await ready();
  const token = await join(t, '団員', 'Cb');
  for (const action of ['adminData', 'saveDay', 'deleteDay', 'setRole', 'deleteMember', 'setPassphrase', 'exportCsv']) {
    assert.equal((await t.call(action, {}, token)).code, 'FORBIDDEN', action);
  }
  assert.equal((await t.call('adminData', {})).code, 'UNAUTHORIZED');
});

test('過ぎた練習日の出欠は変えられない', async () => {
  const t = await ready();
  const token = await join(t, '団員', 'Tp');
  const past = await t.call('saveDay', { date: '2026-10-14' }, t.adminToken);
  assert.equal((await t.call('answer', { dayId: past.id, status: 'attend' }, token)).code, 'PAST');
  assert.equal((await t.call('answer', { dayId: t.dayId, status: 'attend' }, token)).ok, true);
});

test('練習日の入力を確かめる', async () => {
  const t = await ready();
  assert.equal((await t.call('saveDay', { date: '2026-13-01' }, t.adminToken)).ok, false);
  assert.equal((await t.call('saveDay', { date: '2026-10-20', st: '18:00', en: '17:00' }, t.adminToken)).ok, false);
  const r = await t.call('saveDay', { id: t.dayId, date: '2026-10-18', kind: '合奏', st: '10:00', en: '12:00' }, t.adminToken);
  assert.equal(r.ok, true);
  assert.equal(r.days[0].date, '2026-10-18');
});

test('最後の管理者は自分を外せない', async () => {
  const t = await ready();
  const token = await join(t, '管理する人', 'Ob');
  const id = (await t.call('home', {}, token)).me.id;
  await t.call('setRole', { id, role: 'admin' }, t.adminToken);
  assert.equal((await t.call('setRole', { id, role: 'member' }, token)).code, 'LAST_ADMIN');
  assert.equal((await t.call('deleteMember', { id }, token)).code, 'LAST_ADMIN');
  // 管理用パスワードでのログインからは外せる（管理者がいなくなったときの立て直し用）
  assert.equal((await t.call('setRole', { id, role: 'member' }, t.adminToken)).ok, true);
});

test('団員を消すと出欠の記録とログインも消える', async () => {
  const t = await ready();
  const token = await join(t, '消える人', 'Fg');
  await t.call('answer', { dayId: t.dayId, status: 'attend' }, token);
  const id = (await t.call('home', {}, token)).me.id;
  assert.equal((await t.call('deleteMember', { id }, t.adminToken)).ok, true);
  assert.equal((await t.call('home', {}, token)).code, 'UNAUTHORIZED');
  const r = await t.call('roster', { dayId: t.dayId }, t.adminToken);
  assert.equal(r.members.length, 0);
});

test('CSV の書き出し', async () => {
  const t = await ready();
  const a = await join(t, '=式の人', 'Va');
  await join(t, '未回答の人', 'Vn');
  await t.call('answer', { dayId: t.dayId, status: 'absent', reason: 'カンマ, と "引用"' }, a);
  const r = await t.call('exportCsv', {}, t.adminToken);
  const lines = r.csv.trim().split('\r\n');
  assert.equal(lines[0], '日付,種類,開始,終了,氏名,パート,出欠,欠席理由,回答日時');
  assert.match(lines[1], /^2026-10-17,分奏,13:00,17:00,未回答の人,Vn,未回答,,$/);
  assert.match(lines[2], /^2026-10-17,分奏,13:00,17:00,'=式の人,Va,欠席,"カンマ, と ""引用""",2026/);
});

test('自分の氏名とパートを直せる', async () => {
  const t = await ready();
  const token = await join(t, '旧姓', 'Cl');
  await join(t, '別の人', 'Cl');
  assert.equal((await t.call('updateProfile', { name: '別の人', part: 'Cl' }, token)).code, 'DUPLICATE');
  const r = await t.call('updateProfile', { name: '新姓', part: 'Fl' }, token);
  assert.equal(r.me.name, '新姓');
  assert.equal(r.me.part, 'Fl');
});

test('しばらく使わないログインは切れる', async () => {
  const t = await ready();
  const token = await join(t, '久しぶり', 'Perc');
  t.advance(179 * 86400000);
  assert.equal((await t.call('home', {}, token)).ok, true);
  t.advance(179 * 86400000);
  assert.equal((await t.call('home', {}, token)).ok, true);
  t.advance(181 * 86400000);
  assert.equal((await t.call('home', {}, token)).code, 'UNAUTHORIZED');
});

test('練習日をまとめて足す', async () => {
  const t = await ready();
  const r = await t.call('saveDays', { dates: ['2026-10-24', '2026-10-31', '2026-10-24'], kind: '合奏', st: '13:00', en: '17:00' }, t.adminToken);
  assert.equal(r.ok, true);
  assert.equal(r.added, 2);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-10-17', '2026-10-24', '2026-10-31']);
  assert.equal(r.days[2].kind, '合奏');
  assert.equal((await t.call('saveDays', { dates: [] }, t.adminToken)).ok, false);
  assert.equal((await t.call('saveDays', { dates: ['2026-02-30'] }, t.adminToken)).ok, false);
  assert.equal((await t.call('saveDays', { dates: ['2026-11-01'], st: '18:00', en: '17:00' }, t.adminToken)).ok, false);
  const many = Array.from({ length: 101 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10));
  assert.equal((await t.call('saveDays', { dates: many }, t.adminToken)).ok, false);
  const member = await join(t, '団員', 'Va');
  assert.equal((await t.call('saveDays', { dates: ['2026-11-01'] }, member)).code, 'FORBIDDEN');
});

test('管理用パスワードで入った人は、自分を管理者として登録できる', async () => {
  const t = setup();
  const admin = await t.call('adminLogin', { password: 'admin-pass' });
  // 合言葉が決まっていなくても登録できる
  const r = await t.call('registerSelf', { name: '最初の 管理者', part: 'Vc', pin: '2468' }, admin.token);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.me.role, 'admin');
  assert.equal(r.me.name, '最初の　管理者');
  // 同じログインのまま、団員として出欠を入れられる
  const home = await t.call('home', {}, admin.token);
  assert.equal(home.me.id, r.me.id);
  assert.equal((await t.call('registerSelf', { name: 'もう一人', part: 'Vc', pin: '2468' }, admin.token)).ok, false);
  // 団員の登録・ログインと同じ暗証番号で入り直せる
  assert.equal((await t.call('setPassphrase', { passphrase: 'orchestra' }, admin.token)).ok, true);
  const again = await t.call('login', { name: '最初の 管理者', pin: '2468' });
  assert.equal(again.ok, true);
  assert.equal(again.me.role, 'admin');
});

test('前に Vn1・Vn2 で登録した人は Vn にそろう', async () => {
  const t = await ready();
  await join(t, '前の人', 'Vn');
  t.store.db.exec("UPDATE members SET part = 'Vn2'");
  t.store.init();
  assert.equal(t.store.db.exec('SELECT part FROM members')[0].part, 'Vn');
  assert.equal((await t.call('register', { passphrase: 'orchestra', name: '新しい人', part: 'Vn1', pin: '1234' })).ok, false);
});

test('ログインに合言葉は要らないが、同じ接続元からの誤りが続けば止まる', async () => {
  const t = await ready();
  await join(t, '鈴木', 'Hr', '1357');
  assert.equal((await t.call('login', { name: '鈴木', pin: '1357' })).ok, true);
  // 名前を変えながら暗証番号を試し続けても、接続元ごとに止まる
  for (let i = 0; i < 10; i++) await t.call('login', { name: i % 2 ? '鈴木' : '登録のない人' + i, pin: '0000' }, undefined, '9.9.9.9');
  assert.equal((await t.call('login', { name: '鈴木', pin: '1357' }, undefined, '9.9.9.9')).code, 'LOCKED');
  assert.equal((await t.call('login', { name: '鈴木', pin: '1357' }, undefined, '8.8.8.8')).code, 'LOCKED'); // 本人の5回の誤りで本人も止まる
});

// ---------------- パスキー（認証器のふりをして確かめる） ----------------
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
function cborEnc(v) {
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
  if (typeof v === 'number') return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (typeof v === 'string') { const t = new TextEncoder().encode(v); return Uint8Array.from([...head(3, t.length), ...t]); }
  if (v instanceof Map) { const parts = [...v].flatMap(([k, x]) => [...cborEnc(k), ...cborEnc(x)]); return Uint8Array.from([...head(5, v.size), ...parts]); }
  throw new Error('cbor');
}
function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Uint8Array.from([0, ...b]); return [0x02, b.length, ...b]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}
async function authenticator(rpId, origin) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const rpHash = await sha(new TextEncoder().encode(rpId));
  const clientData = (type, challenge, o) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin: o || origin }));
  return {
    id: b64u(credId),
    async create(challenge, opts = {}) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const authData = Uint8Array.from([...rpHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, credId.length, ...credId, ...cborEnc(cose)]);
      const att = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { clientDataJSON: b64u(clientData('webauthn.create', challenge, opts.origin)), attestationObject: b64u(att) };
    },
    async get(challenge, opts = {}) {
      const authData = Uint8Array.from([...rpHash, opts.flags ?? 0x05, 0, 0, 0, 1]);
      const cd = clientData('webauthn.get', challenge, opts.origin);
      const data = Uint8Array.from([...authData, ...await sha(cd)]);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data));
      return { id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(rawToDer(sig)) };
    },
  };
}

test('パスキーを作り、氏名も暗証番号もなしでログインできる', async () => {
  const t = await ready();
  const token = await join(t, '田中', 'Fl');
  const dev = await authenticator('orch.example.org', 'https://orch.example.org');
  const opt = await t.call('passkeyRegisterOptions', {}, token);
  assert.equal(opt.ok, true);
  assert.equal(opt.rp.id, 'orch.example.org');
  const reg = await t.call('passkeyRegister', await dev.create(opt.challenge), token);
  assert.equal(reg.ok, true, reg.message);
  assert.equal(reg.passkeys.length, 1);
  // 同じチャレンジは二度使えない
  assert.equal((await t.call('passkeyRegister', await dev.create(opt.challenge), token)).ok, false);

  const lo = await t.call('passkeyLoginOptions', {});
  const r = await t.call('passkeyLogin', await dev.get(lo.challenge));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.me.name, '田中');
  assert.equal(r.hasPasskey, true);
  assert.equal((await t.call('home', {}, r.token)).me.name, '田中');
  // 使い終えたチャレンジ、ほかのサイト、本人確認なし、知らない鍵では入れない
  assert.equal((await t.call('passkeyLogin', await dev.get(lo.challenge))).ok, false);
  let c = await t.call('passkeyLoginOptions', {});
  assert.equal((await t.call('passkeyLogin', await dev.get(c.challenge, { origin: 'https://evil.example' }))).ok, false);
  c = await t.call('passkeyLoginOptions', {});
  assert.equal((await t.call('passkeyLogin', await dev.get(c.challenge, { flags: 0x01 }))).ok, false);
  const other = await authenticator('orch.example.org', 'https://orch.example.org');
  c = await t.call('passkeyLoginOptions', {});
  assert.equal((await t.call('passkeyLogin', await other.get(c.challenge))).code, 'PASSKEY_UNKNOWN');
  // 署名をすり替えても入れない
  c = await t.call('passkeyLoginOptions', {});
  const forged = await dev.get(c.challenge);
  forged.signature = (await other.get(c.challenge)).signature;
  assert.equal((await t.call('passkeyLogin', forged)).ok, false);
  // 消したら使えない
  await t.call('passkeyDelete', { id: dev.id }, token);
  c = await t.call('passkeyLoginOptions', {});
  assert.equal((await t.call('passkeyLogin', await dev.get(c.challenge))).code, 'PASSKEY_UNKNOWN');
});

test('パスキーはほかの人のチャレンジやサイトでは作れず、団員を消すと消える', async () => {
  const t = await ready();
  const a = await join(t, '一人目', 'Va');
  const b = await join(t, '二人目', 'Vc');
  const dev = await authenticator('orch.example.org', 'https://orch.example.org');
  const optA = await t.call('passkeyRegisterOptions', {}, a);
  assert.equal((await t.call('passkeyRegister', await dev.create(optA.challenge), b)).ok, false);
  const optB = await t.call('passkeyRegisterOptions', {}, b);
  assert.equal((await t.call('passkeyRegister', await dev.create(optB.challenge, { origin: 'https://evil.example' }), b)).ok, false);
  const wrongSite = await authenticator('evil.example', 'https://orch.example.org');
  const optB2 = await t.call('passkeyRegisterOptions', {}, b);
  assert.equal((await t.call('passkeyRegister', await wrongSite.create(optB2.challenge), b)).ok, false);
  const optB3 = await t.call('passkeyRegisterOptions', {}, b);
  assert.equal((await t.call('passkeyRegister', await dev.create(optB3.challenge), b)).ok, true);
  const id = (await t.call('home', {}, b)).me.id;
  await t.call('deleteMember', { id }, t.adminToken);
  assert.equal(t.store.db.exec('SELECT COUNT(*) AS n FROM passkeys')[0].n, 0);
});
