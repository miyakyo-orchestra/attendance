/**
 * 宮教オケ 出欠（Cloudflare Workers）
 *
 * - 画面（public/ の HTML・CSS・JS）は、Workers の静的アセットの機能が配る（wrangler.toml の [assets]）。
 *   ここに届くのは /api だけ。
 * - POST /api … 画面からの呼び出し。本文は { action, params }、ログインの印は Authorization: Bearer で受ける。
 *   中身の処理は store.js（Durable Object「Main」の中で動かす）。
 * - データは Durable Object の中の SQLite に置く。Cloudflare が自動で控えを取り、30日前までの状態に戻せる。
 *
 * 設定（Cloudflare の秘密の設定。GitHub Actions が Secrets から登録する）:
 *   ADMIN_PASSWORD … 管理用パスワード。最初の管理者を決めるときと、管理者がいなくなったときに使う
 */

import { Store } from './store.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      if (request.method !== 'POST') return json({ ok: false, code: 'BAD_REQUEST' }, 405);
      // ほかのサイトから呼ばれないよう、同じサイトからの呼び出しだけ受ける
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ ok: false, code: 'FORBIDDEN' }, 403);
      const stub = env.MAIN.get(env.MAIN.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
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
    if (text.length > 64 * 1024) return json({ ok: false, code: 'TOO_LARGE' }, 413);
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

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
