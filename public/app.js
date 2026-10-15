/**
 * 宮教オケ 出欠の画面
 *
 * 1つのページの中で、画面（state.view）を切り替える。
 * - auth     … 登録・ログイン・管理用パスワードでのログイン
 * - home     … 練習日のリストと月のカレンダー
 * - entry    … 練習日ごとの出欠の入力
 * - roster   … パート別の出欠
 * - profile  … 自分の氏名とパートを直す
 * - admin    … 管理（練習日・団員・合言葉・書き出し）
 * サーバーとは POST /api だけでやりとりする（worker.js・store.js）。ログインの印は端末の localStorage に置く。
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'attendance.token';
  const WEEKDAYS = '日月火水木金土';
  const ROLE_LABEL = { member: '団員', officer: '役職', admin: '管理者' };
  const STATUS_LABEL = { attend: '出席', absent: '欠席', none: '未回答' };
  const ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
  };

  const app = document.getElementById('app');
  const state = {
    view: 'auth',
    authMode: location.hash === '#admin' ? 'admin' : 'register',
    open: true,
    parts: [],
    me: null,
    today: '',
    days: [],
    answers: {},
    homeView: 'list',
    month: '',
    showPast: false,
    flash: '',
    error: '',
    busy: false,
    entryId: '',
    roster: null,
    rosterDay: '',
    rosterGroup: 'all',
    rosterReasons: true,
    rosterCal: false,
    rosterMonth: '',
    admin: null,
    editDay: null,
    pickMonth: '', // 練習日をまとめて足すカレンダーの月
    picked: [], // 選んだ日付
    draft: {}, // まとめて足す欄に入れかけの種類・時刻・メモ
  };

  // ---------------- サーバーとのやりとり ----------------
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 保存できない端末では、開いている間だけ */ } memToken = t || ''; }
  let memToken = getToken();

  async function api(action, params) {
    let res;
    try {
      res = await fetch(window.API_URL + '/api', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, memToken ? { Authorization: 'Bearer ' + memToken } : {}),
        body: JSON.stringify({ action, params: params || {} }),
      });
    } catch (e) {
      return { ok: false, code: 'NETWORK', message: '通信できませんでした。電波の状態を確かめてください。' };
    }
    const data = await res.json().catch(() => ({ ok: false, code: 'ERROR', message: 'サーバーの応答を読めませんでした。' }));
    if (data.code === 'UNAUTHORIZED') {
      setToken('');
      state.me = null;
      state.view = 'auth';
      state.authMode = 'login';
    }
    return data;
  }

  async function run(fn) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    setBusy(true);
    try { await fn(); } finally { state.busy = false; render(); }
  }
  function setBusy(on) { app.querySelectorAll('button, input, select, textarea').forEach((el) => { if (on) el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = on || el.dataset.wasDisabled === '1'; }); }

  // ---------------- 小さな道具 ----------------
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function parseDate(d) { const [y, m, dd] = d.split('-').map(Number); return { y, m, d: dd, wd: new Date(Date.UTC(y, m - 1, dd)).getUTCDay() }; }
  function dateLabel(d) { const p = parseDate(d); return `${p.m}月${p.d}日 ${WEEKDAYS[p.wd]}`; }
  function longLabel(d) { const p = parseDate(d); return `${p.m}月${p.d}日 ${WEEKDAYS[p.wd]}曜日`; }
  function shortLabel(d) { const p = parseDate(d); return `${p.m}月${p.d}日`; }
  function timeLabel(day) { return day.st && day.en ? `${day.st}から${day.en}` : day.st ? `${day.st}から` : ''; }
  function metaLabel(day) { return [day.kind, timeLabel(day)].filter(Boolean).join(' '); }
  function statusOf(dayId) { const a = state.answers[dayId]; return a ? a.status : 'none'; }
  function monthOf(d) { return d.slice(0, 7); }
  function addMonth(ym, n) { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); }
  function nextDay() { return state.days.find((d) => d.date >= state.today) || state.days[state.days.length - 1] || null; }
  function isAdmin() { return state.me && state.me.role === 'admin'; }
  function isMember() { return state.me && state.me.id; }
  function partsOf(group) { return state.parts.filter((p) => !group || group === 'all' || p.group === group); }

  // ---------------- 画面の組み立て ----------------
  function render() {
    app.classList.toggle('wide', state.view === 'admin');
    const views = { auth: viewAuth, home: viewHome, entry: viewEntry, roster: viewRoster, profile: viewProfile, admin: viewAdmin };
    app.innerHTML = (views[state.view] || viewAuth)();
    if (state.view === 'roster') {
      const on = app.querySelector('.day-chip[aria-pressed="true"]');
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    if (state.busy) setBusy(true);
  }

  function top(right) {
    return `<header class="top"><span class="brand">宮教オケ 出欠</span>${right || ''}</header>`;
  }
  function whoMenu() {
    if (!state.me) return '';
    const label = state.me.part ? `${esc(state.me.name)} ・ ${esc(state.me.part)}` : esc(state.me.name);
    return `<details class="who"><summary>${label}</summary><div class="menu">
      ${isMember() ? '<button data-act="go-profile">氏名とパート</button>' : ''}
      ${isAdmin() ? '<button data-act="go-admin">管理</button>' : ''}
      <button data-act="logout">ログアウト</button>
    </div></details>`;
  }
  function messages() {
    return (state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : '')
      + (state.flash ? `<div class="flash" role="status">${esc(state.flash)}</div>` : '');
  }
  function partPicker(selected) {
    const chip = (p) => `<label class="chip"><input type="radio" name="part" value="${esc(p.id)}"${p.id === selected ? ' checked' : ''}><span>${esc(p.id)}</span></label>`;
    return `<fieldset><legend>パート</legend>
      <div class="parts strings">${partsOf('strings').map(chip).join('')}</div>
      <div class="parts winds">${partsOf('winds').map(chip).join('')}</div>
    </fieldset>`;
  }

  // 登録・ログイン
  function viewAuth() {
    const mode = state.authMode;
    let body;
    if (mode === 'admin') {
      body = `<h1>管理用パスワード</h1>
        <form data-form="admin-login" class="card pad" style="background:none;padding:0">
          <label class="field">パスワード<input class="input" type="password" name="password" autocomplete="current-password" required></label>
          <button class="cta" type="submit">ログイン</button>
        </form>
        <button class="link" data-act="auth-mode" data-mode="login">団員のログイン</button>`;
    } else {
      const reg = mode === 'register';
      body = `<div class="seg" role="group" aria-label="登録かログイン">
          <button type="button" data-act="auth-mode" data-mode="register" aria-pressed="${reg}">登録</button>
          <button type="button" data-act="auth-mode" data-mode="login" aria-pressed="${!reg}">ログイン</button>
        </div>
        ${!state.open ? '<div class="error">まだ登録を受け付けていません。</div>' : ''}
        <form data-form="${reg ? 'register' : 'login'}" style="display:flex;flex-direction:column;gap:20px">
          <label class="field">合言葉<input class="input" type="password" name="passphrase" autocomplete="off" required></label>
          <label class="field">氏名<input class="input" name="name" placeholder="宮教 太郎" autocomplete="name" maxlength="30" required></label>
          ${reg ? partPicker('') : ''}
          <label class="field">暗証番号<input class="input" type="password" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="4〜8桁の数字" required></label>
          <button class="cta" type="submit">${reg ? '登録する' : 'ログイン'}</button>
        </form>
        ${!reg ? '<button class="link" data-act="auth-mode" data-mode="admin">管理者</button>' : ''}`;
    }
    return top() + `<main>${messages()}${body}</main>`;
  }

  // 練習日のリストとカレンダー
  function viewHome() {
    const list = state.homeView === 'list';
    return top(whoMenu()) + `<main>
      <div class="seg" role="group" aria-label="表示">
        <button data-act="home-view" data-v="list" aria-pressed="${list}">リスト</button>
        <button data-act="home-view" data-v="calendar" aria-pressed="${!list}">カレンダー</button>
      </div>
      ${messages()}
      ${list ? dayList() : calendar(state.month, (d) => d ? `data-act="open-day" data-id="${esc(d.id)}"` : '', true)}
      <button class="link" data-act="go-roster" style="align-self:center">パート別の出欠</button>
    </main>`;
  }

  function dayList() {
    const upcoming = state.days.filter((d) => d.date >= state.today);
    const past = state.days.filter((d) => d.date < state.today).reverse();
    const row = (d, isPast) => {
      const st = statusOf(d.id);
      return `<button class="day${isPast ? ' past' : ''}" data-act="open-day" data-id="${esc(d.id)}">
        <span class="main"><span class="date">${esc(dateLabel(d.date))}</span><span class="meta">${esc(metaLabel(d))}</span></span>
        ${isMember() ? `<span class="pill ${st}">${STATUS_LABEL[st]}</span>` : ''}
      </button>`;
    };
    let html = upcoming.length
      ? `<div class="card">${upcoming.map((d) => row(d, false)).join('')}</div>`
      : '<div class="empty">予定の練習日はありません</div>';
    if (past.length) {
      html += `<button class="link" data-act="toggle-past" aria-expanded="${state.showPast}" style="align-self:center">過去の練習日</button>`;
      if (state.showPast) html += `<div class="card">${past.map((d) => row(d, true)).join('')}</div>`;
    }
    return html;
  }

  /** 月のカレンダー。attrs(練習日) が押したときの data-〜 を返す */
  function calendar(ym, attrs, withLegend, selectedId) {
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const byDate = {};
    for (const d of state.days) if (monthOf(d.date) === ym && !byDate[d.date]) byDate[d.date] = d;
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div class="cal-cell"></div>';
    for (let n = 1; n <= count; n++) {
      const date = `${ym}-${String(n).padStart(2, '0')}`;
      const d = byDate[date];
      const today = date === state.today;
      if (d) {
        const st = statusOf(d.id);
        const label = `${m}月${n}日${isMember() ? ' ' + STATUS_LABEL[st] : ''}`;
        cells += `<div class="cal-cell"><button class="cal-day${today ? ' today' : ''}" ${attrs(d)} aria-label="${esc(label)}"${selectedId ? ` aria-pressed="${d.id === selectedId}"` : ''}>
          <span>${n}</span>${isMember() ? `<span class="dot ${st}"></span>` : ''}</button></div>`;
      } else {
        cells += `<div class="cal-cell"><span class="cal-num${today ? ' today' : ''}">${n}</span></div>`;
      }
    }
    return `<div class="card cal">
      <div class="cal-head">
        <button class="icon" data-act="month" data-n="-1" aria-label="前の月">${ICON.back}</button>
        <span class="cal-title">${y}年${m}月</span>
        <button class="icon" data-act="month" data-n="1" aria-label="次の月">${ICON.next}</button>
      </div>
      <div class="cal-week" aria-hidden="true">${[...WEEKDAYS].map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      ${withLegend && isMember() ? `<div class="legend"><span><span class="dot attend"></span>出席</span><span><span class="dot absent"></span>欠席</span><span><span class="dot"></span>未回答</span></div>` : ''}
    </div>`;
  }

  // 出欠の入力
  function viewEntry() {
    const d = state.days.find((x) => x.id === state.entryId);
    if (!d) { state.view = 'home'; return viewHome(); }
    const a = state.answers[d.id] || { status: '', reason: '' };
    const past = d.date < state.today;
    const dis = past ? ' disabled' : '';
    return top(whoMenu()) + `<main>
      <button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button>
      <div style="display:flex;flex-direction:column;gap:4px">
        <h1 class="title-date">${esc(longLabel(d.date))}</h1>
        <p class="title-meta">${esc(metaLabel(d))}</p>
        ${d.note ? `<p class="title-meta">${esc(d.note)}</p>` : ''}
      </div>
      ${messages()}
      <form data-form="answer" style="display:flex;flex-direction:column;gap:20px">
        <div class="choices" role="radiogroup" aria-label="出欠">
          <label class="choice"><input type="radio" name="status" value="attend"${a.status === 'attend' ? ' checked' : ''}${dis}><span class="attend">出席</span></label>
          <label class="choice"><input type="radio" name="status" value="absent"${a.status === 'absent' ? ' checked' : ''}${dis}><span class="absent">欠席</span></label>
        </div>
        <div class="reason-box" style="display:flex;flex-direction:column;gap:8px"${a.status === 'absent' ? '' : ' hidden'}>
          <div class="label-row">
            <label for="reason">欠席の理由 任意</label>
            <button type="button" class="info" data-act="info" aria-expanded="false" aria-controls="reason-note" aria-label="理由を読める人">${ICON.info}</button>
          </div>
          <p id="reason-note" class="note" role="note" hidden>理由を読めるのは本人と役職・管理者だけです。</p>
          <textarea id="reason" name="reason" class="textarea" rows="4" maxlength="200"${dis}>${esc(a.reason)}</textarea>
        </div>
        ${past ? '' : `<button class="cta" type="submit"${a.status ? '' : ' disabled'}>送信</button>`}
      </form>
    </main>`;
  }

  // パート別の出欠
  function viewRoster() {
    if (!state.days.length) return top(whoMenu()) + `<main><button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button><div class="empty">練習日はまだありません</div></main>`;
    const r = state.roster;
    const chips = state.days.map((d) => {
      const p = parseDate(d.date);
      return `<button class="day-chip" data-act="roster-day" data-id="${esc(d.id)}" aria-pressed="${d.id === state.rosterDay}" aria-label="${esc(dateLabel(d.date))}"><small>${p.m}/${WEEKDAYS[p.wd]}</small><b>${p.d}</b></button>`;
    }).join('');
    let body = '';
    if (r && r.day.id === state.rosterDay) {
      const groupParts = partsOf(state.rosterGroup).map((p) => p.id);
      const shown = r.members.filter((m) => groupParts.includes(m.part));
      const t = { attend: 0, absent: 0, none: 0 };
      shown.forEach((m) => { t[m.status] += 1; });
      const all = shown.length || 1;
      const showReasons = state.rosterReasons;
      const sections = groupParts.map((pid) => {
        const ms = shown.filter((m) => m.part === pid);
        if (!ms.length) return '';
        const c = { attend: 0, absent: 0, none: 0 };
        ms.forEach((m) => { c[m.status] += 1; });
        const bits = ['出席 ' + c.attend];
        if (c.absent) bits.push('欠席 ' + c.absent);
        if (c.none) bits.push('未回答 ' + c.none);
        return `<section class="card"><div class="part-head"><h2>${esc(pid)}</h2><span>${bits.join('  ')}</span></div>
          ${ms.map((m) => `<div class="person"><div class="person-row"><span>${esc(m.name)}</span><span class="pill ${m.status}">${STATUS_LABEL[m.status]}</span></div>
            ${showReasons && 'reason' in m ? `<p class="reason${m.reason ? '' : ' none'}">${m.reason ? esc(m.reason) : '理由の記入なし'}</p>` : ''}</div>`).join('')}
        </section>`;
      }).join('');
      const groupLabel = { all: '全体', strings: '弦', winds: '管打' }[state.rosterGroup];
      body = `<section class="card pad">
          <div class="sum-head"><h1 style="font-size:17px">${esc(longLabel(r.day.date))}</h1><span>${groupLabel} ${shown.length}人</span></div>
          ${metaLabel(r.day) ? `<span style="font-size:13px;color:var(--sub);margin-top:-8px">${esc(metaLabel(r.day))}</span>` : ''}
          <div class="bar" aria-hidden="true"><span class="attend" style="width:${t.attend / all * 100}%"></span><span class="absent" style="width:${t.absent / all * 100}%"></span></div>
          <div class="counts"><div class="attend"><small>出席</small><b>${t.attend}</b></div><div class="absent"><small>欠席</small><b>${t.absent}</b></div><div><small>未回答</small><b>${t.none}</b></div></div>
        </section>
        <div class="filter-row">
          <div class="seg" role="group" aria-label="絞り込み">
            ${[['all', '全体'], ['strings', '弦'], ['winds', '管打']].map(([k, l]) => `<button data-act="roster-group" data-g="${k}" aria-pressed="${state.rosterGroup === k}">${l}</button>`).join('')}
          </div>
          ${r.canReadReasons ? `<button class="link" data-act="roster-reasons" aria-pressed="${showReasons}">${showReasons ? '理由を隠す' : '理由を表示'}</button>` : ''}
        </div>
        ${sections || '<div class="empty">登録している団員はいません</div>'}`;
    }
    return top(whoMenu()) + `<main>
      <button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button>
      ${messages()}
      <div class="days-bar">
        <div class="day-chips" role="group" aria-label="練習日">${chips}</div>
        <button class="cal-btn" data-act="roster-cal" aria-expanded="${state.rosterCal}" aria-label="カレンダーから選ぶ">${ICON.cal}</button>
      </div>
      ${state.rosterCal ? calendar(state.rosterMonth, (d) => `data-act="roster-day" data-id="${esc(d.id)}"`, false, state.rosterDay) : ''}
      ${body}
    </main>`;
  }

  // 自分の氏名とパート
  function viewProfile() {
    return top(whoMenu()) + `<main>
      <button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button>
      <h1>氏名とパート</h1>
      ${messages()}
      <form data-form="profile" style="display:flex;flex-direction:column;gap:20px">
        <label class="field">氏名<input class="input" name="name" value="${esc(state.me.name)}" autocomplete="name" maxlength="30" required></label>
        ${partPicker(state.me.part)}
        <button class="cta" type="submit">保存</button>
      </form>
    </main>`;
  }

  // 管理
  /** 練習日の種類・時刻・メモの欄 */
  function dayFields(v) {
    return `<label class="field full">種類<input class="input" name="kind" list="kinds" value="${esc(v.kind || '')}" maxlength="20"></label>
      <datalist id="kinds"><option value="合奏"><option value="分奏"><option value="パート練習"><option value="本番"></datalist>
      <label class="field">開始<input class="input" type="time" name="st" value="${esc(v.st || '')}"></label>
      <label class="field">終了<input class="input" type="time" name="en" value="${esc(v.en || '')}"></label>
      <label class="field full">メモ<input class="input" name="note" value="${esc(v.note || '')}" maxlength="100"></label>`;
  }

  /** 練習日をまとめて足すときの、日付を何日でも選べるカレンダー */
  function pickCalendar() {
    const ym = state.pickMonth;
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const has = new Set(state.admin.days.map((d) => d.date));
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div class="cal-cell"></div>';
    for (let n = 1; n <= count; n++) {
      const date = `${ym}-${String(n).padStart(2, '0')}`;
      const on = state.picked.includes(date);
      const label = `${m}月${n}日${has.has(date) ? ' 練習日あり' : ''}`;
      cells += `<div class="cal-cell"><button type="button" class="pick-day${date === state.today ? ' today' : ''}${date < state.today ? ' past' : ''}" data-act="pick-day" data-date="${date}" aria-pressed="${on}" aria-label="${esc(label)}">
        <span>${n}</span><span class="dot${has.has(date) ? ' set' : ' none'}"></span></button></div>`;
    }
    return `<div class="cal pick">
      <div class="cal-head">
        <button class="icon" data-act="pick-month" data-n="-1" aria-label="前の月">${ICON.back}</button>
        <span class="cal-title">${y}年${m}月</span>
        <button class="icon" data-act="pick-month" data-n="1" aria-label="次の月">${ICON.next}</button>
      </div>
      <div class="cal-week">${[...WEEKDAYS].map((w, i) => `<button type="button" class="pick-wd" data-act="pick-weekday" data-wd="${i}" aria-label="${y}年${m}月の${w}曜日をまとめて選ぶ">${w}</button>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </div>`;
  }
  /** 種類・時刻・メモの入れかけを、描き直しても消えないよう取っておく */
  function keepDraft() {
    const f = app.querySelector('form[data-form="days"]');
    if (f) state.draft = Object.fromEntries(new FormData(f));
  }
  function togglePicked(dates, on) {
    const set = new Set(state.picked);
    for (const d of dates) { if (on) set.add(d); else set.delete(d); }
    state.picked = [...set].sort();
  }

  function viewAdmin() {
    const a = state.admin;
    if (!a) return top(whoMenu()) + '<main><div class="empty">読み込み中</div></main>';
    const e = state.editDay || {};
    const days = a.days.slice().reverse();
    return top(whoMenu()) + `<main>
      ${isMember() ? `<button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button>` : `<button class="link" data-act="go-roster" style="align-self:flex-start;padding-left:0">パート別の出欠</button>`}
      <h1>管理</h1>
      ${messages()}

      ${isMember() ? '' : `<section class="card pad">
        <div class="section-title"><h2>自分を団員として登録</h2></div>
        <form data-form="register-self" style="display:flex;flex-direction:column;gap:16px">
          <label class="field">氏名<input class="input" name="name" autocomplete="name" maxlength="30" required></label>
          ${partPicker('')}
          <label class="field">暗証番号<input class="input" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password" minlength="4" maxlength="8" required></label>
          <button class="cta" type="submit">管理者として登録</button>
        </form>
      </section>`}

      ${e.id ? `<section class="card pad">
        <div class="section-title"><h2>練習日を直す</h2><button class="link" data-act="cancel-edit">やめる</button></div>
        <form data-form="day" class="form-grid">
          <label class="field full">日付<input class="input" type="date" name="date" value="${esc(e.date || '')}" required></label>
          ${dayFields(e)}
          <button class="cta full" type="submit">保存</button>
        </form>
      </section>` : `<section class="card pad">
        <div class="section-title">
          <div class="label-row"><h2>練習日を足す</h2><button type="button" class="info" data-act="info" aria-expanded="false" aria-controls="pick-note" aria-label="選びかた">${ICON.info}</button></div>
          ${state.picked.length ? '<button class="link" data-act="pick-clear">選び直す</button>' : ''}
        </div>
        <p id="pick-note" class="note" role="note" hidden>日付を押して何日でも選べます。曜日を押すと、その月のその曜日をまとめて選べます。</p>
        ${pickCalendar()}
        <form data-form="days" class="form-grid">
          ${dayFields(state.draft)}
          <button class="cta full" type="submit"${state.picked.length ? '' : ' disabled'}>${state.picked.length ? `${state.picked.length}日を足す` : '日付を選ぶ'}</button>
        </form>
      </section>`}

      <section class="card">
        <div class="part-head"><h2>練習日</h2><span>${a.days.length}日</span></div>
        ${days.length ? days.map((d) => `<div class="list-row"><div class="main"><b>${esc(dateLabel(d.date))}</b><small>${esc([metaLabel(d), d.note].filter(Boolean).join(' ・ '))}</small></div>
          <div class="actions"><button class="ghost" data-act="copy-day" data-id="${esc(d.id)}">複製</button><button class="ghost" data-act="edit-day" data-id="${esc(d.id)}">直す</button><button class="ghost danger" data-act="delete-day" data-id="${esc(d.id)}">消す</button></div></div>`).join('') : '<div class="empty">まだありません</div>'}
      </section>

      <section class="card">
        <div class="part-head"><h2>団員</h2><span>${a.members.length}人</span></div>
        ${a.members.length ? a.members.map((m) => `<div class="list-row"><div class="main"><b>${esc(m.name)}</b><small>${esc(m.part)}</small></div>
          <div class="actions">
            <label class="sr" for="role-${esc(m.id)}">${esc(m.name)}の役割</label>
            <select class="select" id="role-${esc(m.id)}" data-change="role" data-id="${esc(m.id)}">${a.roles.map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
            <button class="ghost danger" data-act="delete-member" data-id="${esc(m.id)}" data-name="${esc(m.name)}">消す</button>
          </div></div>`).join('') : '<div class="empty">まだいません</div>'}
      </section>

      <section class="card pad">
        <div class="section-title"><h2>合言葉</h2><span class="badge${a.open ? ' on' : ''}">${a.open ? '設定済み' : '未設定'}</span></div>
        <form data-form="passphrase" style="display:flex;gap:8px">
          <label class="sr" for="passphrase">新しい合言葉</label>
          <input class="input" id="passphrase" name="passphrase" autocomplete="off" minlength="4" maxlength="64" required>
          <button class="ghost" type="submit" style="flex:none;min-height:48px">変える</button>
        </form>
      </section>

      <section class="card pad">
        <div class="section-title"><h2>書き出し</h2><button class="ghost" data-act="export">CSV</button></div>
      </section>
    </main>`;
  }

  // ---------------- 読み込み ----------------
  async function loadHome() {
    const r = await api('home');
    if (!r.ok) { if (r.code !== 'UNAUTHORIZED') state.error = r.message; return false; }
    state.me = r.me;
    state.today = r.today;
    state.days = r.days;
    state.answers = r.answers;
    state.parts = r.parts;
    if (!state.month) { const n = nextDay(); state.month = n ? monthOf(n.date) : monthOf(r.today); }
    return true;
  }
  async function loadRoster(dayId) {
    state.rosterDay = dayId;
    const r = await api('roster', { dayId });
    if (r.ok) state.roster = r; else if (r.code !== 'UNAUTHORIZED') state.error = r.message;
  }
  async function loadAdmin() {
    const r = await api('adminData');
    if (r.ok) state.admin = r; else if (r.code !== 'UNAUTHORIZED') state.error = r.message;
    if (!state.pickMonth) state.pickMonth = monthOf(state.today || new Date().toISOString());
  }
  async function openRoster() {
    if (!state.days.length) await loadHome();
    const d = state.days.find((x) => x.id === state.rosterDay) || nextDay();
    state.view = 'roster';
    state.flash = '';
    if (d) { state.rosterMonth = monthOf(d.date); await loadRoster(d.id); }
  }
  async function afterLogin(r) {
    setToken(r.token);
    state.me = r.me;
    state.flash = '';
    await loadHome();
    if (isMember()) state.view = 'home';
    else { state.view = 'admin'; await loadAdmin(); }
    if (location.hash) history.replaceState(null, '', location.pathname);
  }

  // ---------------- 操作 ----------------
  const ACTIONS = {
    'auth-mode': (el) => { state.authMode = el.dataset.mode; state.error = ''; render(); },
    'home-view': (el) => { state.homeView = el.dataset.v; state.flash = ''; render(); },
    'toggle-past': () => { state.showPast = !state.showPast; render(); },
    'month': (el) => {
      const n = Number(el.dataset.n);
      if (state.view === 'roster') state.rosterMonth = addMonth(state.rosterMonth, n); else state.month = addMonth(state.month, n);
      render();
    },
    'open-day': (el) => {
      state.entryId = el.dataset.id;
      state.flash = '';
      state.error = '';
      if (!isMember()) { state.rosterDay = el.dataset.id; return run(openRoster); }
      state.view = 'entry';
      render();
      window.scrollTo(0, 0);
    },
    'go-home': () => { state.view = isMember() ? 'home' : 'admin'; state.error = ''; render(); },
    'go-roster': () => run(openRoster),
    'go-profile': () => { state.view = 'profile'; state.flash = ''; state.error = ''; render(); },
    'go-admin': () => run(async () => { state.view = 'admin'; state.flash = ''; state.editDay = null; await loadAdmin(); }),
    'logout': () => run(async () => {
      await api('logout');
      setToken('');
      Object.assign(state, { me: null, view: 'auth', authMode: 'login', days: [], answers: {}, roster: null, admin: null, flash: '' });
    }),
    'info': (el) => {
      const note = document.getElementById(el.getAttribute('aria-controls'));
      const open = note.hidden;
      note.hidden = !open;
      el.setAttribute('aria-expanded', String(open));
    },
    'roster-day': (el) => run(async () => { state.rosterCal = false; await loadRoster(el.dataset.id); }),
    'roster-group': (el) => { state.rosterGroup = el.dataset.g; render(); },
    'roster-reasons': () => { state.rosterReasons = !state.rosterReasons; render(); },
    'roster-cal': () => { state.rosterCal = !state.rosterCal; render(); },
    'edit-day': (el) => { state.editDay = state.admin.days.find((d) => d.id === el.dataset.id) || null; render(); window.scrollTo(0, 0); },
    'cancel-edit': () => { state.editDay = null; render(); },
    'copy-day': (el) => {
      const d = state.admin.days.find((x) => x.id === el.dataset.id);
      if (!d) return;
      state.editDay = null;
      state.draft = { kind: d.kind, st: d.st, en: d.en, note: d.note };
      state.picked = [];
      render();
      window.scrollTo(0, 0);
    },
    'pick-day': (el) => { keepDraft(); const d = el.dataset.date; togglePicked([d], !state.picked.includes(d)); render(); },
    'pick-weekday': (el) => {
      keepDraft();
      const [y, m] = state.pickMonth.split('-').map(Number);
      const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const dates = [];
      for (let n = 1; n <= count; n++) if (new Date(Date.UTC(y, m - 1, n)).getUTCDay() === Number(el.dataset.wd)) dates.push(`${state.pickMonth}-${String(n).padStart(2, '0')}`);
      // 今日より前の日は、まとめて選ぶときには入れない
      const future = dates.filter((d) => d >= state.today);
      const target = future.length ? future : dates;
      togglePicked(target, !target.every((d) => state.picked.includes(d)));
      render();
    },
    'pick-month': (el) => { keepDraft(); state.pickMonth = addMonth(state.pickMonth, Number(el.dataset.n)); render(); },
    'pick-clear': () => { keepDraft(); state.picked = []; render(); },
    'delete-day': (el) => {
      const d = state.admin.days.find((x) => x.id === el.dataset.id);
      if (!d || !confirm(`${dateLabel(d.date)} の練習日と、その日の出欠を消しますか？`)) return;
      run(async () => {
        const r = await api('deleteDay', { id: d.id });
        if (!r.ok) { state.error = r.message; return; }
        state.flash = `${shortLabel(d.date)}を消しました`;
        await Promise.all([loadAdmin(), loadHome()]);
      });
    },
    'delete-member': (el) => {
      if (!confirm(`${el.dataset.name} さんと、その出欠の記録を消しますか？`)) return;
      run(async () => {
        const r = await api('deleteMember', { id: el.dataset.id });
        if (!r.ok) { state.error = r.message; return; }
        state.flash = `${el.dataset.name} さんを消しました`;
        await loadAdmin();
      });
    },
    'export': () => run(async () => {
      const r = await api('exportCsv');
      if (!r.ok) { state.error = r.message; return; }
      // 先頭の印（BOM）があると、Excel でも文字化けしない
      const blob = new Blob(['﻿' + r.csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `出欠_${state.today || 'export'}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }),
  };

  const FORMS = {
    'register': (f) => run(async () => {
      if (!f.part) { state.error = 'パートを選んでください。'; return; }
      const r = await api('register', f);
      if (!r.ok) { state.error = r.message; return; }
      await afterLogin(r);
    }),
    'login': (f) => run(async () => {
      const r = await api('login', f);
      if (!r.ok) { state.error = r.message; return; }
      await afterLogin(r);
    }),
    'admin-login': (f) => run(async () => {
      const r = await api('adminLogin', f);
      if (!r.ok) { state.error = r.message; return; }
      await afterLogin(r);
    }),
    'answer': (f) => run(async () => {
      const d = state.days.find((x) => x.id === state.entryId);
      const r = await api('answer', { dayId: state.entryId, status: f.status, reason: f.reason || '' });
      if (!r.ok) { state.error = r.message; return; }
      state.answers[state.entryId] = r.answer;
      state.flash = `${shortLabel(d.date)}の出欠を送信しました`;
      state.view = 'home';
    }),
    'profile': (f) => run(async () => {
      const r = await api('updateProfile', f);
      if (!r.ok) { state.error = r.message; return; }
      state.me = r.me;
      state.flash = '氏名とパートを保存しました';
      state.view = 'home';
    }),
    'day': (f) => run(async () => {
      const r = await api('saveDay', Object.assign({ id: state.editDay ? state.editDay.id : '' }, f));
      if (!r.ok) { state.error = r.message; return; }
      state.flash = `${shortLabel(f.date)}を保存しました`;
      state.editDay = null;
      await Promise.all([loadAdmin(), loadHome()]);
    }),
    'days': (f) => run(async () => {
      const dates = state.picked.slice();
      const r = await api('saveDays', Object.assign({}, f, { dates }));
      if (!r.ok) { state.error = r.message; state.draft = f; return; }
      state.flash = dates.length === 1 ? `${shortLabel(dates[0])}を足しました` : `${shortLabel(dates[0])}から${shortLabel(dates[dates.length - 1])}までの${dates.length}日を足しました`;
      state.picked = [];
      state.draft = f; // 続けて別の月も同じ種類・時刻で足せるよう残す
      await Promise.all([loadAdmin(), loadHome()]);
    }),
    'register-self': (f) => run(async () => {
      if (!f.part) { state.error = 'パートを選んでください。'; return; }
      const r = await api('registerSelf', f);
      if (!r.ok) { state.error = r.message; return; }
      state.me = r.me;
      state.flash = '管理者として登録しました';
      await Promise.all([loadAdmin(), loadHome()]);
    }),
    'passphrase': (f) => run(async () => {
      const r = await api('setPassphrase', f);
      if (!r.ok) { state.error = r.message; return; }
      state.flash = '合言葉を変えました';
      await loadAdmin();
    }),
  };

  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const menu = el.closest('details');
    if (menu) menu.open = false;
    const fn = ACTIONS[el.dataset.act];
    if (fn) { ev.preventDefault(); fn(el); }
  });
  app.addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-form]');
    if (!form) return;
    ev.preventDefault();
    const fn = FORMS[form.dataset.form];
    if (fn) fn(Object.fromEntries(new FormData(form)));
  });
  app.addEventListener('change', (ev) => {
    const el = ev.target;
    // 欠席を選んだときだけ理由の欄を出す。選んだら送信できるようにする
    if (el.name === 'status') {
      const box = app.querySelector('.reason-box');
      if (box) box.hidden = el.value !== 'absent';
      const submit = app.querySelector('form[data-form="answer"] [type="submit"]');
      if (submit) submit.disabled = false;
    }
    if (el.dataset.change === 'role') {
      run(async () => {
        const r = await api('setRole', { id: el.dataset.id, role: el.value });
        if (!r.ok) state.error = r.message; else state.flash = '役割を変えました';
        await loadAdmin();
        if (state.me && state.me.id === el.dataset.id) await loadHome();
      });
    }
  });
  // メニューの外を押したら閉じる
  document.addEventListener('click', (ev) => {
    const open = app.querySelector('details.who[open]');
    if (open && !open.contains(ev.target)) open.open = false;
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#admin' && state.view === 'auth') { state.authMode = 'admin'; render(); }
  });

  // ---------------- はじめ ----------------
  (async function boot() {
    app.innerHTML = top() + '<main></main>';
    const info = await api('info');
    if (info.ok) { state.parts = info.parts; state.open = info.open; }
    if (memToken) {
      const ok = await loadHome();
      if (ok) {
        if (isMember()) state.view = 'home';
        else { state.view = 'admin'; await loadAdmin(); }
      }
    }
    render();
  })();
})();
