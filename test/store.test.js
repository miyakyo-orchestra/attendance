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
  const store = new Store(db, Object.assign({ ADMIN_PASSWORD: 'admin-pass' }, opts), () => now);
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
