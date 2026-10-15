/**
 * 宮教オケ 出欠の画面
 *
 * 1つのページの中で、画面（state.view）を切り替える。
 * - auth     … 登録・ログイン・管理用パスワードでのログイン
 * - offer    … 登録やログインのすぐあとに、パスキーを作るよう勧める
 * - home     … 練習日のカレンダーとリスト
 * - entry    … 練習日ごとの出欠の入力
 * - roster   … パート別の出欠（下のタブの「一覧」）
 * - profile  … 設定（自分の氏名とパート、パスキー）
 * - admin    … 管理（練習日・団員・パート・記録）
 * 画面は render() で state から HTML を作り直して描く。ボタンは data-act、フォームは data-form の名前で、
 * 下の ACTIONS と FORMS の処理につながる。
 * サーバーとは POST /api だけでやりとりする（src/worker.js・src/store.js）。ログインの印は端末の localStorage に置く。
 */
(function () {
  'use strict';

  // ---------------- 決まった値 ----------------
  const TOKEN_KEY = 'attendance.token';
  const VIEW_KEY = 'attendance.homeView'; // 練習日をカレンダーとリストのどちらで見るか（端末ごとに覚える）
  const WEEKDAYS = '日月火水木金土';
  const ROLE_LABEL = { member: '団員', officer: '役職', admin: '管理者' };
  const STATUS_LABEL = { attend: '出席', late: '遅刻', early: '早退', absent: '欠席', none: '未回答' };
  const GROUP_LABEL = { strings: '弦', winds: '管打' };
  const KINDS = ['合奏', '個人／パート', '分奏', 'リハーサル', '演奏会', '本番', '授業', '休み']; // 練習日の種類の候補
  const ADMIN_TABS = [['days', '練習日'], ['members', '団員'], ['parts', 'パート'], ['records', '記録']];

  // アイコン（線で描く。size を渡すと幅と高さも付ける）
  const svg = (body, size) => `<svg viewBox="0 0 24 24"${size ? ` width="${size}" height="${size}"` : ''} fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${body}</svg>`;
  const CALENDAR = '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>';
  const ICON = {
    back: svg('<path d="M15 6l-6 6 6 6"/>'),
    next: svg('<path d="M9 6l6 6-6 6"/>'),
    list: svg(CALENDAR, 22),
    people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18 14.8c2 .8 3.2 2.6 3.5 5.2"/>', 22),
    gear: svg('<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/>', 22),
    down: svg('<path d="M6 9l6 6 6-6"/>', 18),
    up: svg('<path d="M6 15l6-6 6 6"/>', 18),
    copy: svg('<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>', 20),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>', 20),
    trash: svg('<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/>', 20),
    cal: svg(CALENDAR, 20),
  };

  // ---------------- 画面の状態 ----------------
  const app = document.getElementById('app');
  const state = {
    view: 'auth',
    authMode: location.hash === '#admin' ? 'admin' : 'login',
    open: true, // 登録を受け付けているか（合言葉が決まっているか）
    parts: [],
    me: null,
    today: '',
    days: [], // 出欠をとる練習日
    events: [], // 練習日と、出欠をとらない予定（授業・祝日など）の全部。カレンダーに出す
    answers: {},
    homeView: savedHomeView(),
    month: '', // 練習日のカレンダーの月
    calDate: '', // カレンダーで選んでいる日
    showPast: false,
    flash: '',
    error: '',
    busy: false,
    entryId: '',
    roster: null,
    rosterDay: '',
    rosterGroup: 'all',
    rosterReasons: true,
    rosterOpen: {}, // パート別の一覧で、出席の人の名前を開いているパート
    rosterCal: false,
    rosterMonth: '',
    passkeys: null, // 自分のパスキーの一覧（設定の画面）
    admin: null,
    adminTab: 'days', // 管理画面のタブ
    editDay: null,
    pickMonth: '', // 練習日をまとめて足すカレンダーの月
    picked: [], // 選んだ日付
    draft: {}, // まとめて足す欄に入れかけの種類・時刻・メモ
    selMembers: [], // 管理画面でまとめて消すために選んだ団員
  };
  function savedHomeView() { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'calendar'; } catch (e) { return 'calendar'; } }

  // ---------------- サーバーとのやりとり ----------------
  let memToken = getToken();
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 保存できない端末では、開いている間だけ */ } memToken = t || ''; }

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
  /** 応答が失敗なら、その言葉を画面に出す。成功なら true */
  function check(r) {
    if (!r.ok) state.error = r.message;
    return r.ok;
  }

  /** サーバーとやりとりする操作を1つずつ行う。終わるまでボタンと欄を押せなくし、終わったら描き直す */
  async function run(fn) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    setBusy(true);
    try { await fn(); } finally { state.busy = false; render(); }
  }
  function setBusy(on) { app.querySelectorAll('button, input, select, textarea').forEach((el) => { if (on) el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = on || el.dataset.wasDisabled === '1'; }); }

  // ---------------- パスキー ----------------
  const PASSKEY = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  function fromB64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }
  function toB64(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  /** パスキーを作って登録する。やめたときは false */
  async function createPasskey() {
    const o = await api('passkeyRegisterOptions');
    if (!check(o)) return false;
    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: {
        challenge: fromB64(o.challenge),
        rp: o.rp,
        user: { id: new TextEncoder().encode(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: o.exclude.map((id) => ({ type: 'public-key', id: fromB64(id) })),
        attestation: 'none',
        timeout: 120000,
      } });
    } catch (e) {
      if (e && e.name === 'InvalidStateError') state.error = 'この端末のパスキーはすでに登録しています。';
      else if (!e || e.name !== 'NotAllowedError') state.error = 'パスキーを作れませんでした。';
      return false;
    }
    const r = await api('passkeyRegister', { clientDataJSON: toB64(cred.response.clientDataJSON), attestationObject: toB64(cred.response.attestationObject) });
    if (!check(r)) return false;
    state.passkeys = r.passkeys;
    return true;
  }
  async function passkeyLogin() {
    const o = await api('passkeyLoginOptions');
    if (!check(o)) return;
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: { challenge: fromB64(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: 120000 } });
    } catch (e) {
      if (!e || e.name !== 'NotAllowedError') state.error = 'パスキーでログインできませんでした。';
      return;
    }
    const r = await api('passkeyLogin', {
      id: cred.id,
      clientDataJSON: toB64(cred.response.clientDataJSON),
      authenticatorData: toB64(cred.response.authenticatorData),
      signature: toB64(cred.response.signature),
    });
    if (check(r)) await afterLogin(r);
  }

  // ---------------- i ボタン（説明の吹き出し） ----------------
  // 練習室予約システムと同じ作り。吹き出しは1つだけで、ページの一番外側に置く（枠の中で切れないように）。
  // マウスのある端末: ボタンの上にしばらく止めると、マウスの右下に小さく出る。外れるとすぐ消える。
  // 指の端末: 押すと出て、もう一度押すか、ほかを押すと消える。
  function tip(label, text) {
    return `<button type="button" class="info" aria-label="${esc(label)}" aria-expanded="false" data-tip="${esc(text)}"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6.4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="4.1" r="0.9" fill="currentColor"/><rect x="6.35" y="5.9" width="1.3" height="4.6" rx="0.65" fill="currentColor"/></svg></button>`;
  }
  let tipFor = null, tipTimer = 0;
  const tipPop = document.createElement('div');
  tipPop.className = 'tip-pop';
  tipPop.setAttribute('role', 'tooltip');
  tipPop.hidden = true;
  document.body.appendChild(tipPop);
  function showTip(b, x, y) {
    tipFor = b; b.setAttribute('aria-expanded', 'true');
    tipPop.textContent = b.dataset.tip; tipPop.hidden = false;
    const w = tipPop.offsetWidth, h = tipPop.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let left = x + 10, top = y + 18;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (top + h > vh - 8) top = y - h - 10; // 下に入らなければ上に
    tipPop.style.left = `${window.scrollX + left}px`;
    tipPop.style.top = `${window.scrollY + top}px`;
  }
  function closeTip() { clearTimeout(tipTimer); if (tipFor) tipFor.setAttribute('aria-expanded', 'false'); tipFor = null; tipPop.hidden = true; }
  const canHover = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (canHover) {
    document.addEventListener('mouseover', (e) => {
      const b = e.target.closest && e.target.closest('.info');
      if (!b || b === tipFor) return;
      closeTip();
      const { clientX: x, clientY: y } = e;
      tipTimer = setTimeout(() => showTip(b, x, y), 500);
    });
    document.addEventListener('mouseout', (e) => {
      const b = e.target.closest && e.target.closest('.info');
      if (b && !b.contains(e.relatedTarget)) closeTip();
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.info');
    if (!b) { closeTip(); return; }
    e.preventDefault(); e.stopPropagation();
    if (canHover) return; // マウスでは、止めておくだけで出る
    if (tipFor === b) { closeTip(); return; }
    closeTip();
    const r = b.getBoundingClientRect();
    showTip(b, r.left, r.bottom - 10);
  }, true);
  window.addEventListener('scroll', closeTip, { passive: true });
  window.addEventListener('resize', closeTip);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTip(); });

  // ---------------- 小さな道具 ----------------
  /** CSV をファイルとして保存させる。先頭の印（BOM）があると、Excel でも文字化けしない */
  function download(csv, name) {
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function parseDate(d) { const [y, m, dd] = d.split('-').map(Number); return { y, m, d: dd, wd: new Date(Date.UTC(y, m - 1, dd)).getUTCDay() }; }
  /** 日付を 10/15(木) の形に */
  function dateLabel(d) { const p = parseDate(d); return `${p.m}/${p.d}(${WEEKDAYS[p.wd]})`; }
  /** 練習の時刻を 13:00〜17:00 の形に（終わりがなければ 13:00〜、どちらもなければ空） */
  function timeLabel(day) { return day.st && day.en ? `${day.st}〜${day.en}` : day.st ? `${day.st}〜` : ''; }
  function metaLabel(day) { return [day.kind, timeLabel(day)].filter(Boolean).join(' '); }
  function monthOf(d) { return d.slice(0, 7); }
  function addMonth(ym, n) { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); }
  /** 日付の年度（4月始まり） */
  function fiscalYear(d) { const p = parseDate(d); return p.m >= 4 ? p.y : p.y - 1; }
  /** 月（YYYY-MM）の形。first は1日の曜日（日曜が 0）、count は日数、date(n) はその月の n 日の日付 */
  function monthGrid(ym) {
    const [y, m] = ym.split('-').map(Number);
    return {
      y, m,
      first: new Date(Date.UTC(y, m - 1, 1)).getUTCDay(),
      count: new Date(Date.UTC(y, m, 0)).getUTCDate(),
      date: (n) => `${ym}-${String(n).padStart(2, '0')}`,
    };
  }
  /** 今日以降でいちばん近い練習日（なければ最後の練習日） */
  function nextDay() { return state.days.find((d) => d.date >= state.today) || state.days[state.days.length - 1] || null; }
  function isMember() { return state.me && state.me.id; }
  function isOfficer() { return state.me && (state.me.role === 'officer' || state.me.role === 'admin'); }
  function isAdmin() { return state.me && state.me.role === 'admin'; }
  function statusOf(dayId) { const a = state.answers[dayId]; return a ? a.status : 'none'; }
  /** 出欠の札の文字。遅刻・早退は時刻も */
  function statusText(a) { return STATUS_LABEL[a.status] + (a.at ? ' ' + a.at : ''); }
  function partsOf(group) { return state.parts.filter((p) => !group || group === 'all' || p.group === group); }
  /** 予定の色の組。合奏・本番など・それ以外の練習・出欠をとらない予定（plain） */
  function toneOf(d) {
    if (d.noentry) return 'plain';
    if (/合奏/.test(d.kind)) return 'tutti';
    if (/本番|演奏|リハ|ゲネ|GP|コンサート/i.test(d.kind)) return 'stage';
    return 'part';
  }

  // ---------------- 画面の組み立て（共通） ----------------
  const VIEWS = { auth: viewAuth, offer: viewOffer, home: viewHome, entry: viewEntry, roster: viewRoster, profile: viewProfile, admin: viewAdmin };
  const TAB_VIEWS = ['home', 'roster', 'admin', 'entry', 'profile']; // 下のタブを出す画面

  function render() {
    app.classList.toggle('has-tabs', TAB_VIEWS.includes(state.view) && !!state.me);
    closeTip();
    app.innerHTML = (VIEWS[state.view] || viewAuth)();
    if (state.view === 'roster') {
      const on = app.querySelector('.day-chip[aria-pressed="true"]');
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    if (state.busy) setBusy(true);
    syncHistory();
  }
  /** 練習日（管理用パスワードで入ったときは管理）に戻る */
  function goHome() {
    state.view = isMember() ? 'home' : 'admin';
    state.error = '';
    state.flash = '';
    render();
    window.scrollTo(0, 0);
  }

  // 出欠の入力と設定の画面を開いたら、ブラウザの履歴を一つ積む。
  // iPhone で画面の左端から右へなぞる「戻る」や、Android の戻るボタンで練習日に戻れるようにするため
  const SUB_VIEWS = ['entry', 'profile'];
  let subPushed = false;
  let ignorePop = false;
  function syncHistory() {
    const sub = SUB_VIEWS.includes(state.view);
    if (sub && !subPushed) { history.pushState({ sub: 1 }, ''); subPushed = true; }
    if (!sub && subPushed) { subPushed = false; ignorePop = true; history.back(); }
  }
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop = false; return; }
    if (!subPushed) return;
    subPushed = false;
    goHome();
  });

  // 下のタブ。練習日・一覧・管理（役職と管理者）
  function tabs() {
    if (!state.me) return '';
    const items = [];
    if (isMember()) items.push(['home', '練習日', 'go-home', ICON.list]);
    items.push(['roster', '一覧', 'go-roster', ICON.people]);
    if (isOfficer()) items.push(['admin', '管理', 'go-admin', ICON.gear]);
    const current = state.view === 'entry' ? 'home' : state.view; // 出欠の入力は練習日のタブの中
    return `<nav class="tabs" aria-label="画面">${items.map(([v, l, act, icon]) => `<button data-act="${act}" aria-label="${l}"${current === v ? ' aria-current="page"' : ''}>${icon}</button>`).join('')}</nav>`;
  }
  /** 上の帯。right は右に置くもの（氏名のメニュー） */
  function top(right) {
    return `<header class="top"><span class="brand">宮教オケ 出欠</span>${right || ''}</header>`;
  }
  /** ログインのある画面の外枠（上の帯・中身・下のタブ） */
  function page(body) {
    return top(whoMenu()) + `<main>${body}</main>` + tabs();
  }
  function whoMenu() {
    if (!state.me) return '';
    const label = state.me.part ? `${esc(state.me.name)} ・ ${esc(state.me.part)}` : esc(state.me.name);
    return `<details class="who"><summary>${label}${ICON.down}</summary><div class="menu">
      ${isMember() ? '<button data-act="go-profile">設定</button>' : ''}
      <button data-act="logout">ログアウト</button>
    </div></details>`;
  }
  function messages() {
    return (state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : '')
      + (state.flash ? `<div class="flash" role="status">${esc(state.flash)}</div>` : '');
  }
  /** 曜日の並び（日〜土） */
  function weekRow() {
    return `<div class="cal-week" aria-hidden="true">${[...WEEKDAYS].map((w) => `<span>${w}</span>`).join('')}</div>`;
  }
  /** 自分の出欠の札。これからの日でまだ答えていないものは、枠つきの札で目立たせる */
  function myPill(d, isPast) {
    const a = state.answers[d.id] || { status: 'none' };
    return `<span class="pill ${a.status}${!isPast && a.status === 'none' ? ' todo' : ''}">${esc(statusText(a))}</span>`;
  }
  /** 姓と名の欄（姓と名はスペースなしでつないで氏名にする） */
  function nameFields(me) {
    const v = (k) => (me ? ` value="${esc(me[k] || '')}"` : '');
    return `<div class="row"><label class="field">姓<input class="input" name="sei" placeholder="宮教"${v('sei')} autocomplete="family-name" maxlength="15" required></label><label class="field">名<input class="input" name="mei" placeholder="太郎"${v('mei')} autocomplete="given-name" maxlength="15" required></label></div>`;
  }
  function partPicker(selected) {
    const chip = (p) => `<label class="chip"><input type="radio" name="part" value="${esc(p.id)}"${p.id === selected ? ' checked' : ''}><span>${esc(p.id)}</span></label>`;
    return `<fieldset><legend>パート</legend>
      <div class="parts strings">${partsOf('strings').map(chip).join('')}</div>
      <div class="parts winds">${partsOf('winds').map(chip).join('')}</div>
    </fieldset>`;
  }
  // パスキーの説明（i ボタンで開く）
  function passkeyInfo() {
    return tip('パスキーとは', '指紋や顔、画面ロックでログインできるようになります。暗証番号でのログインも使えます。');
  }

  // ---------------- 登録・ログイン ----------------
  function viewAuth() {
    const mode = state.authMode;
    let body;
    if (mode === 'admin') {
      body = `<h1>管理者</h1>
        <form data-form="admin-login" class="stack">
          <label class="field">管理用パスワード<input class="input" type="password" name="password" autocomplete="current-password" required></label>
          <button class="cta" type="submit">ログイン</button>
        </form>
        <p class="auth-alt"><button class="link" data-act="auth-mode" data-mode="login">団員のログインに戻る</button></p>`;
    } else if (mode === 'register') {
      body = `<h1>登録</h1>
        ${!state.open ? '<div class="error">まだ登録を受け付けていません。</div>' : ''}
        <form data-form="register" class="stack">
          <label class="field">合言葉<input class="input" type="password" name="passphrase" autocomplete="off" required></label>
          ${nameFields()}
          ${partPicker('')}
          <label class="field">暗証番号<input class="input" type="password" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="new-password" placeholder="4〜8桁の数字" required></label>
          <button class="cta" type="submit">登録する</button>
        </form>
        <p class="auth-alt">登録済みの方は<button class="link" data-act="auth-mode" data-mode="login">ログイン</button></p>`;
    } else {
      body = `<h1>ログイン</h1>
        <form data-form="login" class="stack">
          <label class="field">氏名<input class="input" name="name" placeholder="宮教太郎" autocomplete="username" maxlength="30" required></label>
          <label class="field">暗証番号<input class="input" type="password" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="current-password" placeholder="4〜8桁の数字" required></label>
          <button class="${PASSKEY ? 'ghost wide-btn' : 'cta'}" type="submit">${PASSKEY ? '暗証番号でログイン' : 'ログイン'}</button>
        </form>
        <p class="auth-alt">はじめての方は<button class="link" data-act="auth-mode" data-mode="register">登録</button></p>
        <div class="auth-bottom">
          ${PASSKEY ? '<button class="cta" data-act="passkey-login">パスキーでログイン</button>' : ''}
          <p class="auth-alt small"><button class="link" data-act="auth-mode" data-mode="admin">管理者の方</button></p>
        </div>`;
    }
    return top() + `<main class="auth">${messages()}${body}</main>`;
  }

  // 登録やログインのすぐあとに、パスキーを作るよう勧める
  function viewOffer() {
    return top(whoMenu()) + `<main class="offer">
      <div class="offer-head"><h1>パスキーを作りますか</h1>${passkeyInfo()}</div>
      ${messages()}
      <button class="cta" data-act="passkey-create">作る</button>
      <button class="link" data-act="go-home">あとで</button>
    </main>`;
  }

  // ---------------- 練習日（ホーム） ----------------
  function viewHome() {
    const list = state.homeView === 'list';
    return page(`
      <div class="seg" role="group" aria-label="表示">
        <button data-act="home-view" data-v="calendar" aria-pressed="${!list}">カレンダー</button>
        <button data-act="home-view" data-v="list" aria-pressed="${list}">リスト</button>
      </div>
      ${messages()}
      ${list ? dayList() : monthView() + agenda()}
    `);
  }

  /** 練習日のリスト。次の練習（同じ日に二つあれば両方）を大きく出し、その先は月ごとに区切る */
  function dayList() {
    const upcoming = state.days.filter((d) => d.date >= state.today);
    const past = state.days.filter((d) => d.date < state.today).reverse();
    let html = '';
    if (!upcoming.length) html = '<div class="empty">これからの練習日はありません</div>';
    else {
      const next = upcoming.filter((d) => d.date === upcoming[0].date);
      const rest = upcoming.slice(next.length);
      html = `<div class="card next-day"><span class="next-label">次の練習</span>${next.map((d) => dayRow(d, false)).join('')}</div>`;
      const year = parseDate(state.today).y;
      let cur = '';
      let group = [];
      const flush = () => {
        if (!group.length) return;
        const [y, m] = cur.split('-').map(Number);
        html += `<div class="month-group"><h2 class="month-label">${y !== year ? y + '年' : ''}${m}月</h2><div class="card">${group.map((d) => dayRow(d, false)).join('')}</div></div>`;
        group = [];
      };
      for (const d of rest) {
        if (monthOf(d.date) !== cur) { flush(); cur = monthOf(d.date); }
        group.push(d);
      }
      flush();
    }
    if (past.length) {
      html += `<button class="link center" data-act="toggle-past" aria-expanded="${state.showPast}">過去の練習日</button>`;
      if (state.showPast) html += `<div class="card">${past.map((d) => dayRow(d, true)).join('')}</div>`;
    }
    return html;
  }
  /** 練習日の1行 */
  function dayRow(d, isPast) {
    return `<button class="day${isPast ? ' past' : ''}" data-act="open-day" data-id="${esc(d.id)}">
      <span class="ag-bar ${toneOf(d)}"></span><span class="main"><span class="date">${esc(dateLabel(d.date))}</span><span class="meta">${esc(metaLabel(d))}</span></span>
      ${isMember() ? myPill(d, isPast) : ''}
    </button>`;
  }

  /** カレンダーで最初に選ぶ日。今日がその月なら今日、なければその月の最初の予定の日 */
  function defaultCalDate(ym) {
    if (monthOf(state.today) === ym) return state.today;
    const e = state.events.find((d) => monthOf(d.date) === ym);
    return e ? e.date : `${ym}-01`;
  }
  /** 練習日のカレンダー。iPhone のカレンダーのように、日ごとに予定の名前を色つきで並べる */
  function monthView() {
    const ym = state.month;
    const g = monthGrid(ym);
    if (monthOf(state.calDate) !== ym) state.calDate = defaultCalDate(ym);
    const byDate = {};
    for (const d of state.events) if (monthOf(d.date) === ym) (byDate[d.date] = byDate[d.date] || []).push(d);
    const withDot = (d) => !d.noentry && isMember(); // 自分の出欠の点を付けるか
    let cells = '';
    for (let i = 0; i < g.first; i++) cells += '<div class="mv-cell blank"></div>';
    for (let n = 1; n <= g.count; n++) {
      const date = g.date(n);
      const ds = byDate[date] || [];
      const wd = (g.first + n - 1) % 7;
      // 予定は三つまで出し、それより多ければ二つと残りの数を出す
      const shown = ds.length > 3 ? ds.slice(0, 2) : ds;
      const label = `${g.m}月${n}日 ${ds.map((d) => (d.kind || '練習') + (withDot(d) ? ' ' + STATUS_LABEL[statusOf(d.id)] : '')).join('、')}`;
      cells += `<button class="mv-cell${date === state.today ? ' today' : ''}${wd === 0 || wd === 6 ? ' holiday' : ''}${date < state.today ? ' past' : ''}" data-act="cal-date" data-date="${date}" aria-pressed="${state.calDate === date}" aria-label="${esc(label)}">
        <span class="mv-num">${n}</span>
        ${shown.map((d) => `<span class="mv-ev ${toneOf(d)}">${withDot(d) ? `<span class="dot ${statusOf(d.id)}"></span>` : ''}<span class="mv-name">${esc(d.kind || '練習')}</span></span>`).join('')}
        ${ds.length > shown.length ? `<span class="mv-more">他${ds.length - shown.length}件</span>` : ''}
      </button>`;
    }
    const away = state.calDate !== state.today;
    return `<div class="mv">
      <div class="mv-head">
        <h2 class="mv-title"><small>${g.y}年</small>${g.m}月</h2>
        ${away ? '<button class="mv-today" data-act="cal-today">今日</button>' : ''}
        <button class="icon" data-act="month" data-n="-1" aria-label="前の月">${ICON.back}</button>
        <button class="icon" data-act="month" data-n="1" aria-label="次の月">${ICON.next}</button>
      </div>
      ${weekRow()}
      <div class="mv-grid">${cells}</div>
      ${isMember() ? `<div class="legend"><span><span class="dot attend"></span>出席</span><span><span class="dot late"></span>遅刻・早退</span><span><span class="dot absent"></span>欠席</span><span><span class="dot"></span>未回答</span></div>` : ''}
    </div>`;
  }
  /** カレンダーの下に、選んだ日の予定を時刻の順に並べる。練習を押すと出欠の入力に進む */
  function agenda() {
    const date = state.calDate;
    const ds = state.events.filter((d) => d.date === date);
    const past = date < state.today;
    const rows = ds.map((d) => {
      const time = d.st ? `<span class="ag-time"><b>${esc(d.st)}</b>${d.en ? `<span>${esc(d.en)}</span>` : ''}</span>` : '<span class="ag-time"><span>終日</span></span>';
      const main = `<span class="ag-bar ${toneOf(d)}"></span><span class="main"><span class="ag-title">${esc(d.kind || '練習')}</span>${d.note ? `<span class="meta">${esc(d.note)}</span>` : ''}</span>`;
      if (d.noentry) return `<div class="ag-row">${time}${main}</div>`;
      return `<button class="ag-row" data-act="open-day" data-id="${esc(d.id)}">${time}${main}${isMember() ? myPill(d, past) : ''}</button>`;
    }).join('');
    return `<div class="agenda"><h2 class="month-label">${esc(dateLabel(date))}</h2>
      <div class="card">${rows || '<div class="empty">予定はありません</div>'}</div></div>`;
  }

  // ---------------- 出欠の入力 ----------------
  function viewEntry() {
    const d = state.days.find((x) => x.id === state.entryId);
    if (!d) { state.view = 'home'; return viewHome(); }
    const a = state.answers[d.id] || { status: '', reason: '' };
    const past = d.date < state.today;
    const dis = past ? ' disabled' : '';
    return page(`
      <div class="title-block">
        <div class="title-row"><button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button><h1 class="title-date">${esc(dateLabel(d.date))}</h1></div>
        <p class="title-meta">${esc(metaLabel(d))}</p>
        ${d.note ? `<p class="title-meta">${esc(d.note)}</p>` : ''}
      </div>
      ${messages()}
      <form data-form="answer" class="stack">
        <div class="choices" role="radiogroup" aria-label="出欠">
          ${['attend', 'late', 'early', 'absent'].map((k) => `<label class="choice"><input type="radio" name="status" value="${k}"${a.status === k ? ' checked' : ''}${dis}><span class="${k}">${STATUS_LABEL[k]}</span></label>`).join('')}
        </div>
        <div class="at-box"${a.status === 'late' || a.status === 'early' ? '' : ' hidden'}>
          <label class="field" for="at">時刻 任意</label>
          <input id="at" name="at" class="input" type="time" value="${esc(a.at || '')}"${dis}>
        </div>
        <div class="reason-box"${a.status === 'absent' ? '' : ' hidden'}>
          <div class="label-row">
            <label for="reason">欠席の理由 任意</label>
            ${tip('理由を読める人', '理由を読めるのは本人と役職と管理者だけです。')}
          </div>
          <textarea id="reason" name="reason" class="textarea" rows="4" maxlength="200"${dis}>${esc(a.reason)}</textarea>
        </div>
        ${past ? '' : `<button class="cta" type="submit"${a.status && a.status !== 'attend' ? '' : ' hidden'}>送信する</button>`}
      </form>
    `);
  }

  // ---------------- パート別の出欠（一覧） ----------------
  // 出席の人は人数だけにまとめ、押すと名前が出る
  function viewRoster() {
    if (!state.days.length) return page('<div class="empty">練習日はまだありません</div>');
    const perDate = {};
    state.days.forEach((d) => { perDate[d.date] = (perDate[d.date] || 0) + 1; });
    const chips = state.days.map((d) => {
      const p = parseDate(d.date);
      // 同じ日に二つ以上あるときは、月と曜日の代わりに開始の時刻（なければ種類）を出して見分ける
      const small = perDate[d.date] > 1 ? (d.st || d.kind || `${p.m}/${WEEKDAYS[p.wd]}`) : `${p.m}/${WEEKDAYS[p.wd]}`;
      return `<button class="day-chip" data-act="roster-day" data-id="${esc(d.id)}" aria-pressed="${d.id === state.rosterDay}" aria-label="${esc(dateLabel(d.date) + ' ' + metaLabel(d))}"><small>${esc(small)}</small><b>${p.d}</b></button>`;
    }).join('');
    const r = state.roster;
    return page(`
      ${messages()}
      <div class="days-bar">
        <div class="day-chips" role="group" aria-label="練習日">${chips}</div>
        <button class="cal-btn" data-act="roster-cal" aria-expanded="${state.rosterCal}" aria-label="カレンダーから選ぶ">${ICON.cal}</button>
      </div>
      ${state.rosterCal ? rosterCalendar() : ''}
      ${r && r.day.id === state.rosterDay ? rosterBody(r) : ''}
    `);
  }
  /** 出欠ごとの人数 */
  function countOf(ms) {
    const c = { attend: 0, late: 0, early: 0, absent: 0, none: 0 };
    ms.forEach((m) => { c[m.status] += 1; });
    return c;
  }
  /** 選んだ練習日の人数・帯・絞り込みと、パートごとの一覧 */
  function rosterBody(r) {
    const groupParts = partsOf(state.rosterGroup).map((p) => p.id);
    const shown = r.members.filter((m) => groupParts.includes(m.part));
    const t = countOf(shown);
    const all = shown.length || 1;
    const showReasons = state.rosterReasons;
    const order = { absent: 0, late: 1, early: 2, none: 3 };
    const sections = groupParts.map((pid) => {
      const ms = shown.filter((m) => m.part === pid);
      if (!ms.length) return '';
      const c = countOf(ms);
      const bits = ['出席 ' + c.attend];
      if (c.late + c.early) bits.push('遅刻・早退 ' + (c.late + c.early));
      if (c.absent) bits.push('欠席 ' + c.absent);
      if (c.none) bits.push('未回答 ' + c.none);
      const others = ms.filter((m) => m.status !== 'attend').sort((x, y) => order[x.status] - order[y.status]);
      const attending = ms.filter((m) => m.status === 'attend');
      const open = !!state.rosterOpen[pid];
      return `<section class="card"><div class="part-head"><h2>${esc(pid)}</h2><span>${bits.join('  ')}</span></div>
          ${others.map((m) => `<div class="person"><div class="person-row"><span>${esc(m.name)}</span><span class="pill ${m.status}">${esc(statusText(m))}</span></div>
            ${showReasons && 'reason' in m ? `<p class="reason${m.reason ? '' : ' none'}">${m.reason ? esc(m.reason) : '理由の記入なし'}</p>` : ''}</div>`).join('')}
          ${attending.length ? `<button class="attend-row" data-act="roster-open" data-part="${esc(pid)}" aria-expanded="${open}"><span>出席 ${attending.length}人</span>${open ? ICON.up : ICON.down}</button>
            ${open ? `<div class="names">${attending.map((m) => `<span>${esc(m.name)}</span>`).join('')}</div>` : ''}` : ''}
        </section>`;
    }).join('');
    const groupLabel = { all: '全体', strings: '弦', winds: '管打' }[state.rosterGroup];
    const part = t.late + t.early;
    return `<section class="card pad">
          <div class="sum-head"><h1>${esc(dateLabel(r.day.date))}</h1><span>${groupLabel} ${shown.length}人</span></div>
          ${metaLabel(r.day) ? `<span class="sum-meta">${esc(metaLabel(r.day))}</span>` : ''}
          <div class="bar" aria-hidden="true"><span class="attend" style="width:${t.attend / all * 100}%"></span><span class="late" style="width:${part / all * 100}%"></span><span class="absent" style="width:${t.absent / all * 100}%"></span></div>
          <div class="counts"><div class="attend"><small><i class="dot attend"></i>出席</small><b>${t.attend}</b></div><div class="late"><small><i class="dot late"></i>遅刻・早退</small><b>${part}</b></div><div class="absent"><small><i class="dot absent"></i>欠席</small><b>${t.absent}</b></div><div><small><i class="dot none"></i>未回答</small><b>${t.none}</b></div></div>
        </section>
        <div class="filter-row">
          <div class="seg" role="group" aria-label="絞り込み">
            ${[['all', '全体'], ['strings', '弦'], ['winds', '管打']].map(([k, l]) => `<button data-act="roster-group" data-g="${k}" aria-pressed="${state.rosterGroup === k}">${l}</button>`).join('')}
          </div>
          ${r.canReadReasons ? `<button class="link" data-act="roster-reasons" aria-pressed="${showReasons}">${showReasons ? '理由を隠す' : '理由を見る'}</button>` : ''}
        </div>
        ${sections || '<div class="empty">団員はまだいません</div>'}`;
  }
  /** 一覧の練習日を選ぶ月のカレンダー。練習のある日だけ押せる。同じ日に二つあるときは、押すたびに次の練習に移る */
  function rosterCalendar() {
    const g = monthGrid(state.rosterMonth);
    const byDate = {};
    for (const d of state.days) if (monthOf(d.date) === state.rosterMonth) (byDate[d.date] = byDate[d.date] || []).push(d);
    let cells = '';
    for (let i = 0; i < g.first; i++) cells += '<div class="cal-cell"></div>';
    for (let n = 1; n <= g.count; n++) {
      const date = g.date(n);
      const ds = byDate[date];
      const today = date === state.today;
      if (ds) {
        // 同じ日に練習が二つ以上あれば、点もその数だけ並べる
        const label = `${g.m}月${n}日${ds.length > 1 ? ` 練習${ds.length}つ` : ''}${isMember() ? ' ' + ds.map((d) => STATUS_LABEL[statusOf(d.id)]).join('・') : ''}`;
        const i = ds.findIndex((d) => d.id === state.rosterDay);
        cells += `<div class="cal-cell"><button class="cal-day${today ? ' today' : ''}" data-act="roster-day" data-id="${esc(ds[(i + 1) % ds.length].id)}" aria-label="${esc(label)}" aria-pressed="${i >= 0}">
          <span>${n}</span>${isMember() ? `<span class="dots">${ds.map((d) => `<span class="dot ${statusOf(d.id)}"></span>`).join('')}</span>` : ''}</button></div>`;
      } else {
        cells += `<div class="cal-cell"><span class="cal-num${today ? ' today' : ''}">${n}</span></div>`;
      }
    }
    return `<div class="card cal">
      <div class="cal-head">
        <button class="icon" data-act="month" data-n="-1" aria-label="前の月">${ICON.back}</button>
        <span class="cal-title">${g.y}年${g.m}月</span>
        <button class="icon" data-act="month" data-n="1" aria-label="次の月">${ICON.next}</button>
      </div>
      ${weekRow()}
      <div class="cal-grid">${cells}</div>
    </div>`;
  }

  // ---------------- 設定 ----------------
  function viewProfile() {
    const keys = state.passkeys;
    return page(`
      <div class="title-row"><button class="icon back" data-act="go-home" aria-label="戻る">${ICON.back}</button><h1>設定</h1></div>
      ${messages()}
      <section class="card pad">
        <form data-form="profile" class="stack">
          ${nameFields(state.me)}
          ${partPicker(state.me.part)}
          <button class="cta" type="submit">保存する</button>
        </form>
      </section>
      ${PASSKEY ? `<section class="card">
        <div class="part-head"><div class="label-row"><h2>パスキー</h2>${passkeyInfo()}</div><span>${keys ? keys.length + '個' : ''}</span></div>
        ${keys && keys.length ? keys.map((k) => `<div class="list-row"><div class="main"><b>${esc(dateLabel(k.created_at.slice(0, 10)))}に作成</b><small>${k.last_used ? esc(dateLabel(k.last_used.slice(0, 10))) + 'に使用' : '未使用'}</small></div>
          <div class="actions"><button class="ghost icon danger" data-act="passkey-delete" data-id="${esc(k.id)}" aria-label="消す" title="消す">${ICON.trash}</button></div></div>`).join('') : ''}
        <div class="pad-box"><button class="ghost wide-btn" data-act="passkey-create">パスキーを作る</button></div>
      </section>` : ''}
    `);
  }

  // ---------------- 管理 ----------------
  function viewAdmin() {
    const a = state.admin;
    if (!a) return page('<div class="empty">読み込み中</div>');
    const admin = isAdmin();
    const tab = admin ? state.adminTab : 'days'; // 役職には練習日だけ
    const body = { days: adminDays, members: adminMembers, parts: adminParts, records: adminRecords }[tab](a);
    return page(`
      <h1>管理</h1>
      ${admin ? `<div class="seg" role="group" aria-label="管理の項目">${ADMIN_TABS.map(([k, l]) => `<button data-act="admin-tab" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div>` : ''}
      ${messages()}
      ${body}
    `);
  }

  // 管理: 練習日（役職も使える）
  function adminDays(a) {
    const e = state.editDay || {};
    const days = a.days.slice().reverse();
    return `${e.id ? `<section class="card pad">
        <div class="section-title"><h2>練習日を直す</h2><button class="link" data-act="cancel-edit">やめる</button></div>
        <form data-form="day" class="form-grid">
          <label class="field full">日付<input class="input" type="date" name="date" value="${esc(e.date || '')}" required></label>
          ${dayFields(e)}
          <button class="cta full" type="submit">保存する</button>
        </form>
      </section>` : `<section class="card pad">
        <div class="section-title">
          <div class="label-row"><h2>練習日を足す</h2>${tip('選びかた', '日付を押すと何日でも選べます。曜日を押すと、その月のその曜日をまとめて選べます。')}</div>
          ${state.picked.length ? '<button class="link" data-act="pick-clear">選び直す</button>' : ''}
        </div>
        ${pickCalendar()}
        <form data-form="days" class="form-grid">
          ${dayFields(state.draft)}
          <button class="cta full" type="submit"${state.picked.length ? '' : ' disabled'}>${state.picked.length ? `${state.picked.length}日を足す` : '日付を選ぶ'}</button>
        </form>
      </section>`}

      <section class="card">
        <div class="part-head"><h2>練習日</h2><span>${a.days.length}日</span></div>
        ${days.length ? days.map((d) => `<div class="list-row"><div class="main"><b>${esc(dateLabel(d.date))}</b><small>${d.noentry ? '<span class="badge">出欠なし</span> ' : ''}${esc([metaLabel(d), d.note].filter(Boolean).join(' ・ '))}</small></div>
          <div class="actions tight"><button class="ghost icon" data-act="copy-day" data-id="${esc(d.id)}" aria-label="複製" title="複製">${ICON.copy}</button><button class="ghost icon" data-act="edit-day" data-id="${esc(d.id)}" aria-label="直す" title="直す">${ICON.edit}</button><button class="ghost icon danger" data-act="delete-day" data-id="${esc(d.id)}" aria-label="消す" title="消す">${ICON.trash}</button></div></div>`).join('') : '<div class="empty">練習日はまだありません</div>'}
      </section>`;
  }
  /** 練習日の種類・時刻・メモの欄 */
  function dayFields(v) {
    return `<label class="field full">種類<input class="input" name="kind" list="kinds" value="${esc(v.kind || '')}" maxlength="20"></label>
      <datalist id="kinds">${KINDS.map((k) => `<option value="${k}">`).join('')}</datalist>
      <label class="field">開始<input class="input" type="time" name="st" value="${esc(v.st || '')}"></label>
      <label class="field">終了<input class="input" type="time" name="en" value="${esc(v.en || '')}"></label>
      <label class="field full">メモ<input class="input" name="note" value="${esc(v.note || '')}" maxlength="100"></label>
      <label class="switch full"><input type="checkbox" name="noentry"${v.noentry && v.noentry !== '0' ? ' checked' : ''}><span>出欠をとらない</span>${tip('出欠をとらない予定', '授業や祝日など、カレンダーに載せるだけの予定にします。')}</label>`;
  }
  /** 練習日をまとめて足すときの、日付を何日でも選べるカレンダー */
  function pickCalendar() {
    const g = monthGrid(state.pickMonth);
    const has = new Set(state.admin.days.map((d) => d.date));
    let cells = '';
    for (let i = 0; i < g.first; i++) cells += '<div class="cal-cell"></div>';
    for (let n = 1; n <= g.count; n++) {
      const date = g.date(n);
      const on = state.picked.includes(date);
      const label = `${g.m}月${n}日${has.has(date) ? ' 練習日あり' : ''}`;
      cells += `<div class="cal-cell"><button type="button" class="pick-day${date === state.today ? ' today' : ''}${date < state.today ? ' past' : ''}" data-act="pick-day" data-date="${date}" aria-pressed="${on}" aria-label="${esc(label)}">
        <span>${n}</span><span class="dot${has.has(date) ? ' set' : ' none'}"></span></button></div>`;
    }
    return `<div class="cal pick">
      <div class="cal-head">
        <button class="icon" data-act="pick-month" data-n="-1" aria-label="前の月">${ICON.back}</button>
        <span class="cal-title">${g.y}年${g.m}月</span>
        <button class="icon" data-act="pick-month" data-n="1" aria-label="次の月">${ICON.next}</button>
      </div>
      <div class="cal-week">${[...WEEKDAYS].map((w, i) => `<button type="button" class="pick-wd" data-act="pick-weekday" data-wd="${i}" aria-label="${g.y}年${g.m}月の${w}曜日をまとめて選ぶ">${w}</button>`).join('')}</div>
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

  // 管理: 団員と合言葉
  function adminMembers(a) {
    const sel = state.selMembers.filter((id) => a.members.some((m) => m.id === id));
    return `<section class="card">
        <div class="part-head"><h2>団員</h2>${sel.length ? `<button class="ghost danger" data-act="delete-members">${sel.length}人を消す</button>` : `<span>${a.members.length}人</span>`}</div>
      </section>
      ${a.members.length ? memberGroups(a).map(([part, ms]) => `<section class="card">
        <div class="part-head"><h2>${esc(part)}</h2><span>${ms.length}人</span></div>
        ${ms.map((m) => `<div class="list-row">
          <label class="check"><input type="checkbox" data-change="sel-member" value="${esc(m.id)}"${sel.includes(m.id) ? ' checked' : ''}><span class="sr">${esc(m.name)}を選ぶ</span></label>
          <div class="main"><b>${esc(m.name)}</b></div>
          <div class="actions">
            <label class="sr" for="role-${esc(m.id)}">${esc(m.name)}の役割</label>
            <select class="select" id="role-${esc(m.id)}" data-change="role" data-id="${esc(m.id)}">${a.roles.map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
          </div></div>`).join('')}
      </section>`).join('') : '<div class="empty">団員はまだいません</div>'}
      <details class="card pad fold"${a.open ? '' : ' open'}>
        <summary><h2>合言葉</h2><span class="badge${a.open ? ' on' : ''}">${a.open ? '設定済み' : '未設定'}</span>${ICON.down}</summary>
        <form data-form="passphrase" class="inline">
          <label class="sr" for="passphrase">新しい合言葉</label>
          <input class="input" id="passphrase" name="passphrase" autocomplete="off" minlength="4" maxlength="64" required>
          <button class="ghost" type="submit">変える</button>
        </form>
      </details>`;
  }
  /** 団員をパートの並び順でまとめる。パートの一覧にないパートの人は最後に */
  function memberGroups(a) {
    const order = a.parts.map((p) => p.id);
    const by = {};
    a.members.forEach((m) => { (by[m.part] = by[m.part] || []).push(m); });
    const extra = Object.keys(by).filter((k) => !order.includes(k)).sort();
    return [...order, ...extra].filter((k) => by[k]).map((k) => [k, by[k]]);
  }

  // 管理: パートの足し引き
  function adminParts(a) {
    const used = {};
    a.members.forEach((m) => { used[m.part] = (used[m.part] || 0) + 1; });
    const group = (g) => `<section class="card">
        <div class="part-head"><h2>${GROUP_LABEL[g]}</h2><span>${a.parts.filter((p) => p.group === g).length}</span></div>
        ${a.parts.filter((p) => p.group === g).map((p) => `<div class="list-row"><div class="main"><b>${esc(p.id)}</b><small>${used[p.id] || 0}人</small></div>
          <div class="actions"><button class="ghost icon danger" data-act="part-delete" data-id="${esc(p.id)}"${used[p.id] ? ' disabled' : ''} aria-label="${esc(p.id)}を消す" title="消す">${ICON.trash}</button></div></div>`).join('')}
      </section>`;
    return `${group('strings')}${group('winds')}
      <section class="card pad">
        <div class="section-title"><h2>パートを足す</h2></div>
        <form data-form="part" class="inline">
          <label class="sr" for="part-id">パートの名前</label>
          <input class="input" id="part-id" name="id" placeholder="Hp" maxlength="8" pattern="[A-Za-z0-9.]{1,8}" required>
          <label class="sr" for="part-group">弦か管打</label>
          <select class="select fit" id="part-group" name="group">${Object.entries(GROUP_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <button class="ghost" type="submit">足す</button>
        </form>
      </section>`;
  }

  // 管理: 記録の書き出しと、年度ごとの片付け
  function adminRecords(a) {
    const thisYear = fiscalYear(state.today);
    const years = [...new Set(a.days.map((d) => fiscalYear(d.date)))].filter((y) => y < thisYear).sort((x, y) => y - x);
    return `<section class="card pad">
        <div class="section-title"><h2>書き出し</h2><button class="ghost" data-act="export">CSV</button></div>
      </section>
      <section class="card pad">
        <div class="section-title"><h2>年度で消す</h2></div>
        ${years.length ? `<div class="inline">
          <label class="sr" for="year">年度</label>
          <select class="select" id="year">${years.map((y) => `<option value="${y}">${y}年度</option>`).join('')}</select>
          <button class="ghost danger" data-act="delete-year">書き出して消す</button>
        </div>` : '<div class="empty small">終わった年度の練習日はありません</div>'}
      </section>`;
  }

  // ---------------- 読み込み ----------------
  async function loadHome() {
    const r = await api('home');
    if (!r.ok) { if (r.code !== 'UNAUTHORIZED') state.error = r.message; return false; }
    state.me = r.me;
    state.today = r.today;
    state.events = r.days;
    state.days = r.days.filter((d) => !d.noentry);
    state.answers = r.answers;
    state.parts = r.parts;
    if (!state.month) { const n = nextDay(); state.month = n ? monthOf(n.date) : monthOf(r.today); }
    return true;
  }
  async function loadRoster(dayId) {
    state.rosterDay = dayId;
    const r = await api('roster', { dayId });
    if (r.ok) { state.roster = r; state.parts = r.parts; } else if (r.code !== 'UNAUTHORIZED') state.error = r.message;
  }
  async function loadAdmin() {
    const r = await api('adminData');
    if (r.ok) state.admin = r; else if (r.code !== 'UNAUTHORIZED') state.error = r.message;
    if (!state.pickMonth) state.pickMonth = monthOf(state.today || new Date().toISOString());
  }
  /** 練習日を変えたあとに、管理画面とホームの両方を読み直す */
  function reloadAll() { return Promise.all([loadAdmin(), loadHome()]); }
  async function openRoster() {
    if (!state.days.length) await loadHome();
    const d = state.days.find((x) => x.id === state.rosterDay) || nextDay();
    state.view = 'roster';
    state.flash = '';
    if (d) { state.rosterMonth = monthOf(d.date); await loadRoster(d.id); }
  }
  /** 管理用パスワードで入ったときは、練習日の代わりに管理画面から始める */
  async function openStart() {
    if (isMember()) state.view = 'home';
    else { state.view = 'admin'; await loadAdmin(); }
  }
  async function afterLogin(r) {
    setToken(r.token);
    state.me = r.me;
    state.flash = '';
    await loadHome();
    if (isMember() && PASSKEY && !r.hasPasskey) state.view = 'offer';
    else await openStart();
    if (location.hash) history.replaceState(null, '', location.pathname);
  }
  /** 登録・ログインを送り、通ればログインのあとの画面へ */
  async function signIn(action, f) {
    const r = await api(action, f);
    if (check(r)) await afterLogin(r);
  }

  // ---------------- 操作（ボタン。data-act の名前で呼ぶ） ----------------
  const ACTIONS = {
    'auth-mode': (el) => { state.authMode = el.dataset.mode; state.error = ''; render(); window.scrollTo(0, 0); },
    'passkey-login': () => run(passkeyLogin),
    'logout': () => run(async () => {
      await api('logout');
      setToken('');
      Object.assign(state, { me: null, view: 'auth', authMode: 'login', days: [], answers: {}, roster: null, admin: null, flash: '' });
    }),

    // 画面の行き来
    'go-home': goHome,
    'go-roster': () => run(openRoster),
    'go-admin': () => run(async () => { state.view = 'admin'; state.flash = ''; state.editDay = null; await loadAdmin(); window.scrollTo(0, 0); }),
    'go-profile': () => run(async () => {
      state.view = 'profile'; state.flash = '';
      const r = await api('passkeys');
      state.passkeys = r.ok ? r.passkeys : [];
    }),
    'open-day': (el) => {
      state.entryId = el.dataset.id;
      state.flash = '';
      state.error = '';
      if (!isMember()) { state.rosterDay = el.dataset.id; return run(openRoster); }
      state.view = 'entry';
      render();
      window.scrollTo(0, 0);
    },

    // 練習日（ホーム）
    'home-view': (el) => { state.homeView = el.dataset.v; try { localStorage.setItem(VIEW_KEY, el.dataset.v); } catch (e) { /* 残せなくても動く */ } state.flash = ''; render(); },
    'toggle-past': () => { state.showPast = !state.showPast; render(); },
    'cal-date': (el) => { state.calDate = el.dataset.date; render(); },
    'cal-today': () => { state.month = monthOf(state.today); state.calDate = state.today; render(); },
    'month': (el) => {
      const n = Number(el.dataset.n);
      if (state.view === 'roster') state.rosterMonth = addMonth(state.rosterMonth, n); else state.month = addMonth(state.month, n);
      render();
    },

    // 一覧
    'roster-day': (el) => run(async () => { state.rosterCal = false; await loadRoster(el.dataset.id); }),
    'roster-group': (el) => { state.rosterGroup = el.dataset.g; render(); },
    'roster-reasons': () => { state.rosterReasons = !state.rosterReasons; render(); },
    'roster-cal': () => { state.rosterCal = !state.rosterCal; render(); },
    'roster-open': (el) => { const k = el.dataset.part; state.rosterOpen[k] = !state.rosterOpen[k]; render(); },

    // 設定のパスキー
    'passkey-create': () => run(async () => {
      const done = await createPasskey();
      if (!done) return;
      state.flash = 'パスキーを作りました';
      if (state.view === 'offer') state.view = 'home';
    }),
    'passkey-delete': (el) => {
      if (!confirm('このパスキーを消しますか？')) return;
      run(async () => {
        const r = await api('passkeyDelete', { id: el.dataset.id });
        if (!check(r)) return;
        state.passkeys = r.passkeys;
        state.flash = 'パスキーを消しました';
      });
    },

    // 管理
    'admin-tab': (el) => { state.adminTab = el.dataset.tab; state.flash = ''; state.error = ''; state.editDay = null; render(); },
    'edit-day': (el) => { state.editDay = state.admin.days.find((d) => d.id === el.dataset.id) || null; render(); window.scrollTo(0, 0); },
    'cancel-edit': () => { state.editDay = null; render(); },
    'copy-day': (el) => {
      const d = state.admin.days.find((x) => x.id === el.dataset.id);
      if (!d) return;
      state.editDay = null;
      state.draft = { kind: d.kind, st: d.st, en: d.en, note: d.note, noentry: d.noentry };
      state.picked = [];
      render();
      window.scrollTo(0, 0);
    },
    'delete-day': (el) => {
      const d = state.admin.days.find((x) => x.id === el.dataset.id);
      if (!d || !confirm(`${dateLabel(d.date)} の練習日と、その日の出欠を消しますか？`)) return;
      run(async () => {
        const r = await api('deleteDay', { id: d.id });
        if (!check(r)) return;
        state.flash = `${dateLabel(d.date)}を消しました`;
        await reloadAll();
      });
    },
    'pick-day': (el) => { keepDraft(); const d = el.dataset.date; togglePicked([d], !state.picked.includes(d)); render(); },
    'pick-weekday': (el) => {
      keepDraft();
      const g = monthGrid(state.pickMonth);
      const dates = [];
      for (let n = 1; n <= g.count; n++) if ((g.first + n - 1) % 7 === Number(el.dataset.wd)) dates.push(g.date(n));
      // 今日より前の日は、まとめて選ぶときには入れない
      const future = dates.filter((d) => d >= state.today);
      const target = future.length ? future : dates;
      togglePicked(target, !target.every((d) => state.picked.includes(d)));
      render();
    },
    'pick-month': (el) => { keepDraft(); state.pickMonth = addMonth(state.pickMonth, Number(el.dataset.n)); render(); },
    'pick-clear': () => { keepDraft(); state.picked = []; render(); },
    'delete-members': () => {
      const ids = state.selMembers.slice();
      const names = state.admin.members.filter((m) => ids.includes(m.id)).map((m) => m.name);
      if (!ids.length || !confirm(`${names.join('、')} の${ids.length}人と、その出欠の記録を消しますか？`)) return;
      run(async () => {
        const r = await api('deleteMembers', { ids });
        if (!check(r)) return;
        state.selMembers = [];
        state.flash = `${r.deleted}人を消しました`;
        await loadAdmin();
      });
    },
    'part-delete': (el) => {
      if (!confirm(`${el.dataset.id} を消しますか？`)) return;
      run(async () => {
        const r = await api('deletePart', { id: el.dataset.id });
        if (!check(r)) return;
        state.flash = `${el.dataset.id} を消しました`;
        state.parts = r.parts;
        await loadAdmin();
      });
    },
    'export': () => run(async () => {
      const r = await api('exportCsv');
      if (!check(r)) return;
      download(r.csv, `出欠_${state.today || 'export'}.csv`);
    }),
    'delete-year': () => {
      const y = Number(app.querySelector('#year').value);
      run(async () => {
        const csv = await api('exportCsv', { year: y });
        if (!check(csv)) return;
        download(csv.csv, `出欠_${y}年度.csv`);
        // 書き出しが済んでから尋ねる
        await new Promise((ok) => setTimeout(ok, 300));
        if (!confirm(`${y}年度の練習日と出欠をすべて消しますか？書き出したファイルを保存したことを確かめてください。`)) return;
        const r = await api('deleteYear', { year: y });
        if (!check(r)) return;
        state.flash = `${y}年度の練習日${r.deleted}日を消しました`;
        await reloadAll();
      });
    },
  };

  // ---------------- 送信（フォーム。data-form の名前で呼ぶ。f は欄の値） ----------------
  const FORMS = {
    'register': (f) => run(async () => {
      if (!f.part) { state.error = 'パートを選んでください。'; return; }
      await signIn('register', f);
    }),
    'login': (f) => run(() => signIn('login', f)),
    'admin-login': (f) => run(() => signIn('adminLogin', f)),
    'answer': (f) => run(async () => {
      const d = state.days.find((x) => x.id === state.entryId);
      const r = await api('answer', { dayId: state.entryId, status: f.status, reason: f.reason || '', at: f.at || '' });
      if (!check(r)) return;
      state.answers[state.entryId] = r.answer;
      state.flash = `${dateLabel(d.date)}の出欠を送信しました`;
      state.view = 'home';
    }),
    'profile': (f) => run(async () => {
      const r = await api('updateProfile', f);
      if (!check(r)) return;
      state.me = r.me;
      state.flash = '氏名とパートを保存しました';
      state.view = 'home';
    }),
    'day': (f) => run(async () => {
      const r = await api('saveDay', Object.assign({ id: state.editDay ? state.editDay.id : '' }, f));
      if (!check(r)) return;
      state.flash = `${dateLabel(f.date)}を保存しました`;
      state.editDay = null;
      await reloadAll();
    }),
    'days': (f) => run(async () => {
      const dates = state.picked.slice();
      const r = await api('saveDays', Object.assign({}, f, { dates }));
      if (!check(r)) { state.draft = f; return; }
      state.flash = dates.length === 1 ? `${dateLabel(dates[0])}を足しました` : `${dateLabel(dates[0])}から${dateLabel(dates[dates.length - 1])}までの${dates.length}日を足しました`;
      state.picked = [];
      state.draft = f; // 続けて別の月も同じ種類・時刻で足せるよう残す
      await reloadAll();
    }),
    'part': (f) => run(async () => {
      const r = await api('addPart', f);
      if (!check(r)) return;
      state.flash = `${f.id} を足しました`;
      state.parts = r.parts;
      await loadAdmin();
    }),
    'passphrase': (f) => run(async () => {
      const r = await api('setPassphrase', f);
      if (!check(r)) return;
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
    // 出席は押しただけで送る。遅刻・早退は時刻、欠席は理由の欄を出して送信を待つ
    if (el.name === 'status') {
      const form = el.closest('form');
      if (el.value === 'attend') { form.requestSubmit(); return; }
      app.querySelector('.reason-box').hidden = el.value !== 'absent';
      app.querySelector('.at-box').hidden = el.value !== 'late' && el.value !== 'early';
      const submit = form.querySelector('[type="submit"]');
      if (submit) submit.hidden = false;
    }
    if (el.dataset.change === 'sel-member') {
      const set = new Set(state.selMembers);
      if (el.checked) set.add(el.value); else set.delete(el.value);
      state.selMembers = [...set];
      render();
    }
    if (el.dataset.change === 'role') {
      run(async () => {
        const r = await api('setRole', { id: el.dataset.id, role: el.value });
        if (check(r)) state.flash = '役割を変えました';
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
    if (memToken && await loadHome()) await openStart();
    render();
  })();
})();
