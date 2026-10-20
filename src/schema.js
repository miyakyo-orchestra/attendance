/**
 * データベースの表を作り、前の形のデータを今の形に直す。
 *
 * Store を作るたびに呼ばれる。何度呼んでも同じ結果になるよう、
 * 表は IF NOT EXISTS、列やデータの直しは「まだ直していないときだけ」行う。
 */

export function initSchema(db) {
  const x = (q) => db.exec(q);
  const hasColumn = (table, col) => db.exec(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`, col).length > 0;
  x(`CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, part TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', pin TEXT NOT NULL, created_at TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`);
  x('CREATE UNIQUE INDEX IF NOT EXISTS members_name ON members (name)');
  x(`CREATE TABLE IF NOT EXISTS days (id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '',
    st TEXT NOT NULL DEFAULT '', en TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '')`);
  x('CREATE INDEX IF NOT EXISTS days_date ON days (date)');
  // 出欠をとらない予定（授業・祝日など。配るカレンダーにだけ載せる）は noentry = 1（2026-10-15 から）
  if (!hasColumn('days', 'noentry')) {
    x('ALTER TABLE days ADD COLUMN noentry INTEGER NOT NULL DEFAULT 0');
  }
  x(`CREATE TABLE IF NOT EXISTS answers (day_id TEXT NOT NULL, member_id TEXT NOT NULL, status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (day_id, member_id))`);
  if (!hasColumn('answers', 'at')) {
    x("ALTER TABLE answers ADD COLUMN at TEXT NOT NULL DEFAULT ''"); // 遅刻・早退の時刻（2026-10-15 から）
  }
  // 2026-10-15 から姓と名を分けて持つ。氏名（name）は姓と名をスペースなしでつないだもの
  if (!hasColumn('members', 'sei')) {
    x("ALTER TABLE members ADD COLUMN sei TEXT NOT NULL DEFAULT ''");
    x("ALTER TABLE members ADD COLUMN mei TEXT NOT NULL DEFAULT ''");
    // 前に登録した人は、氏名の中のスペースで姓と名に分ける。スペースがなければ全部を姓に入れる（設定で直せる）
    for (const m of db.exec('SELECT id, name FROM members')) {
      const [sei, ...rest] = m.name.split(/[\s　]+/).filter(Boolean);
      const mei = rest.join('');
      const name = (sei || '') + mei;
      const clash = db.exec('SELECT 1 FROM members WHERE name = ? AND id <> ?', name, m.id).length;
      db.exec('UPDATE members SET sei = ?, mei = ?, name = ? WHERE id = ?', sei || m.name, mei, clash ? m.name : name, m.id);
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
  // 2026-10-15 から Vn1 と Vn2 を分けず Vn にまとめた。前に登録した人を一度だけ Vn に直す
  // （あとで管理画面から Vn1 を足して使っても、起きるたびに戻さないよう、済んだ印を kv に残す）
  if (!db.exec("SELECT 1 FROM kv WHERE k = 'migrated:vn'").length) {
    x("UPDATE members SET part = 'Vn' WHERE part IN ('Vn1', 'Vn2')");
    x("INSERT OR REPLACE INTO kv (k, v, exp) VALUES ('migrated:vn', '1', 0)");
  }
}
