/**
 * 画面の設定。
 * API_URL … 出欠を保存するサーバー（Cloudflare Workers）の URL。公開したときに GitHub Actions の記録に出る URL を書く。
 * 手元で試すとき（127.0.0.1・localhost で開いたとき）は、npm run dev のサーバーを使う。
 */
window.API_URL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname)
  ? 'http://127.0.0.1:8787'
  : 'https://miyakyo-orchestra-attendance.kuridanho.workers.dev';
