// 配っているカレンダーを貼り付けて、練習日の候補に読み替える。
// 表計算ソフトから写した表（タブ区切り）と、「10/2 合奏 18:30〜20:00」のような1行1件の書き方の両方を読む。
// 画面（app.js）とテスト（test/paste.test.js）の両方から使う。
(function (root) {
  // 練習として足す候補にする言葉。これを含まず時刻もないもの（授業・祝日など）は、はじめは選ばない
  const PRACTICE = /合奏|分奏|パート|個人|練習|リハ|本番|演奏|ゲネ|GP/i;
  const TIME = /(\d{1,2})[:：](\d{2})\s*[〜～~\-－–—]\s*(?:(\d{1,2})[:：](\d{2}))?/;
  const KIND_MAX = 20;

  /** 全角の数字・記号を半角にそろえる */
  function normalize(s) {
    return String(s || '')
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[：]/g, ':')
      .replace(/\r\n?/g, '\n');
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function hm(h, m) { return h == null ? '' : `${pad(Number(h))}:${m}`; }
  function validTime(t) { return !t || /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

  /** タブ区切りの表を行と欄に分ける。欄の中の改行は「"」で囲まれている */
  function splitTsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows;
  }

  /** 表の欄が日付だけなら { m, d }（m は書いていなければ 0） */
  function dateCell(s) {
    const t = s.trim();
    let r = t.match(/^(?:(\d{1,2})月)?(\d{1,2})日$/);
    if (r) return { m: Number(r[1] || 0), d: Number(r[2]) };
    r = t.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (r) return { m: Number(r[1]), d: Number(r[2]) };
    r = t.match(/^(\d{1,2})$/);
    if (r) return { m: 0, d: Number(r[1]), bare: true };
    return null;
  }

  /** 日付の文字（年・月・日）を YYYY-MM-DD にする。ありえない日なら '' */
  function ymd(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  /** 表から、日付ごとの文字の並びを作る */
  function fromGrid(rows, ctx) {
    const out = [];
    let cols = [];
    let prev = null;
    for (const row of rows) {
      const cells = row.map((c) => c.trim());
      const filled = cells.filter(Boolean);
      const dates = cells.map(dateCell);
      // 日付の行: 埋まった欄がすべて日付（数字だけの日付は3つ以上並ぶとき）
      const isDateRow = filled.length && cells.every((c, i) => !c || dates[i]) &&
        (dates.some((d) => d && !d.bare) || filled.length >= 3);
      if (isDateRow) {
        cols = cells.map((c, i) => {
          const dc = dates[i];
          if (!dc) return null;
          let { y, m } = ctx;
          if (dc.m) {
            if (prev && dc.m < prev.m && prev.m - dc.m > 6) y = ctx.y + 1;
            m = dc.m;
          } else if (prev) {
            m = prev.m;
            if (dc.d < prev.d) m += 1; // 月が替わった
          } else if (ctx.titled && dc.d > 20) {
            m = ctx.m - 1; // 表の初めの、前の月の終わりの日
          }
          if (m > 12) { m -= 12; y += 1; }
          if (m < 1) { m += 12; y -= 1; }
          ctx.y = y;
          prev = { m, d: dc.d };
          const entry = { date: ymd(y, m, dc.d), texts: [] };
          out.push(entry);
          return entry;
        });
        continue;
      }
      cells.forEach((c, i) => { if (c && cols[i]) cols[i].texts.push(...c.split('\n')); });
    }
    return out;
  }

  /** 1行1件の書き方から、日付ごとの文字の並びを作る */
  function fromLines(lines, ctx) {
    const out = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const r = line.match(/^(?:(\d{4})[\/年\-.])?(\d{1,2})[\/月\-.](\d{1,2})日?\s*(?:[(（][^)）]{1,3}[)）])?\s*(.*)$/);
      if (r) {
        const y = r[1] ? Number(r[1]) : ctx.y;
        cur = { date: ymd(y, Number(r[2]), Number(r[3])), texts: [] };
        out.push(cur);
        if (r[4]) cur.texts.push(...r[4].split(/[\s　]*[、,][\s　]*/));
      } else if (cur) cur.texts.push(line);
    }
    return out;
  }

  /** 一つの日付の文字の並びを、種類と時刻の組に分ける */
  function itemsOf(entry) {
    const items = [];
    let waiting = null; // 時刻がまだ付いていない項目
    for (const raw of entry.texts) {
      const t = raw.replace(/[\s　]+/g, ' ').trim();
      if (!t) continue;
      const m = t.match(TIME);
      if (m) {
        const st = hm(m[1], m[2]);
        const en = hm(m[3], m[4]);
        const rest = t.replace(TIME, '').trim();
        if (rest) items.push({ kind: rest, st, en });
        else if (waiting && !waiting.st) { waiting.st = st; waiting.en = en; }
        else items.push({ kind: '', st, en });
        waiting = null;
      } else {
        waiting = { kind: t, st: '', en: '' };
        items.push(waiting);
      }
    }
    return items.map((it) => ({ date: entry.date, kind: it.kind.slice(0, KIND_MAX), st: it.st, en: it.en }));
  }

  /**
   * 貼り付けた文字を練習日の候補にする。
   * opts.today（YYYY-MM-DD）から年と月の見当を付ける。表の上に「2026年10月」があればそれを使う。
   * 返すのは [{ date, kind, st, en, practice, error }]。practice は練習らしいもの（時刻があるか、種類が合奏・本番など）
   */
  function parsePaste(text, opts) {
    const s = normalize(text);
    const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
    const ctx = { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)), titled: false };
    const title = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (title) { ctx.y = Number(title[1]); ctx.m = Number(title[2]); ctx.titled = true; }
    const entries = s.includes('\t') ? fromGrid(splitTsv(s), ctx) : fromLines(s.split('\n'), ctx);
    const items = [];
    for (const e of entries) {
      for (const it of itemsOf(e)) {
        let error = '';
        if (!it.date) error = '日付が正しくありません';
        else if (!validTime(it.st) || !validTime(it.en)) error = '時刻が正しくありません';
        else if (it.st && it.en && it.en <= it.st) error = '終了が開始より前です';
        items.push(Object.assign(it, { practice: !!(it.st || PRACTICE.test(it.kind)), error }));
      }
    }
    return items;
  }

  root.parsePaste = parsePaste;
})(typeof window !== 'undefined' ? window : globalThis);
