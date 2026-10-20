/**
 * 宮教オケ 出欠（Cloudflare Workers）
 *
 * - 画面（public/ の HTML・CSS・JS）は GitHub Pages が配る。ここは呼び出し（/api）だけを受ける。
 * - 呼び出しは画面のサイト（ALLOWED_ORIGIN。GitHub Pages）からだけ受け付ける。
 * - POST /api … 画面からの呼び出し。本文は { action, params }、ログインの印は Authorization: Bearer で受ける。
 *   中身の処理は store.js（Durable Object「Main」の中で動かす）。
 * - データは Durable Object の中の SQLite に置く。Cloudflare が自動で控えを取り、30日前までの状態に戻せる。
 *
 * 設定:
 *   ADMIN_PASSWORD … 管理用パスワード（Cloudflare の秘密の設定。GitHub Actions が Secrets から登録する）。
 *                    最初の管理者を決めるときと、管理者がいなくなったときに使う
 *   ALLOWED_ORIGIN … 画面のサイトの起点（wrangler.toml。例: https://miyakyo-orchestra.github.io）
 */

import { Store, originOf } from './store.js';

const MAX_BODY = 64 * 1024; // 呼び出しの本文の上限（バイト）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = originOf(env.ALLOWED_ORIGIN); // 設定の末尾に / が付いていてもそろえる
    const origin = request.headers.get('Origin') || '';
    // ほかのサイトの画面から呼ばれないよう、ブラウザが付ける Origin が画面のサイトのものだけ受ける。
    // Origin のない呼び出し（ブラウザ以外から）は止めない。ブラウザ以外は Origin を自由に書けるので、止めても守りにならない。
    // 本当の守りは、ログインの印と、誤りの回数で止めるしくみ（store.js）
    if (origin && origin !== allowed) return json({ ok: false, code: 'FORBIDDEN' }, 403);
    const withCors = (res) => {
      const h = new Headers(res.headers);
      if (origin) {
        h.set('Access-Control-Allow-Origin', origin);
        h.set('Vary', 'Origin');
      }
      return new Response(res.body, { status: res.status, headers: h });
    };
    if (url.pathname !== '/api') return json({ ok: false, code: 'NOT_FOUND' }, 404);
    // 呼び出しの前の確認（ログインの印を Authorization に入れて送るので、ブラウザが先に聞いてくる）
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      } }));
    }
    if (request.method !== 'POST') return json({ ok: false, code: 'BAD_REQUEST' }, 405);
    // 本文はここで上限まで読み切ってから渡す（大きな本文で Durable Object の手を止めないため）
    const text = await readBody(request);
    if (text === null) return withCors(json({ ok: false, code: 'TOO_LARGE' }, 413));
    const stub = env.MAIN.get(env.MAIN.idFromName('main'));
    return withCors(await stub.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: text })));
  },
};

/** 正本を持つ Durable Object。1つだけ（名前 'main'） */
export class Main {
  constructor(ctx, env) {
    const sql = ctx.storage.sql;
    this.store = new Store({
      exec: (q, ...b) => sql.exec(q, ...b).toArray(),
      txn: (fn) => ctx.storage.transactionSync(fn),
    }, env);
  }

  async fetch(request) {
    const text = await request.text();
    let body;
    try { body = JSON.parse(text || '{}'); } catch (e) { return json({ ok: false, code: 'BAD_REQUEST', message: '形式が正しくありません。' }, 400); }
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    try {
      return json(await this.store.api(body, { token, ip }));
    } catch (e) {
      console.error(e);
      return json({ ok: false, code: 'ERROR', message: 'サーバーで問題が起きました。時間をおいてやり直してください。' }, 500);
    }
  }
}

/**
 * 本文を読む。上限（MAX_BODY バイト）を超えたら、その時点で読むのをやめて null を返す。
 * 日本語は1文字3バイトなので、文字数ではなくバイトで数える
 */
async function readBody(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return null; // 先に分かるときは読まずに断る
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { all.set(part, at); at += part.byteLength; }
  return new TextDecoder().decode(all);
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
