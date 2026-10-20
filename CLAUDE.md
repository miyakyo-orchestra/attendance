# この リポジトリで作業する AI への引き継ぎ

宮城教育大学オーケストラの練習出欠システム。まず docs/仕様書.md（今の動き）と docs/設計メモ.md（決めたことと理由）を読むこと。練習室予約システム（miyakyo-music/yoyaku）の作り方にそろえている。

## 作業の決まり

- 返答・コミットメッセージ・コード中のコメントは日本語。専門用語は避け、平易に書く。
- 動きを変えたら、同じコミットで docs/仕様書.md を書き直す。
- 公開: main に push すると GitHub Actions が画面（public/）を GitHub Pages に、サーバー（src/）を Cloudflare に公開する（本番）。見た目を変える案は、画面を見せて「公開」と言われるまで main に入れない。
- ライトモードとダークモードの両方がある（端末の設定で自動切替）。色は public/style.css の先頭の名前だけを使い、ダークモードの色も足す。
- 画面に説明文を書かない。どうしても要る説明だけを i ボタンに入れる。
- 欠席理由は本人・パートリーダー・管理者にだけ返す。store.js の roster を変えるときは、テストの「欠席理由は本人とパートリーダー・管理者にだけ返す」が通ることを確かめる。
- public/privacy.js のプライバシーポリシーは実装どおりに書いてある。暗証番号・パスキー・ログインの印・欠席理由・接続元の記録の扱いや、消し方を変えたら、同じコミットでここも直し、REVISED に改定日を足す。
- 外部のライブラリは使わない（書体の IBM Plex Sans JP だけ Google Fonts から読む）。

## 確かめかた

- `npm install` のあと `npm test`（store.js のテスト。Node 22.16 以上。テストが使う node:sqlite の columns() が 22.16 から）。
- `npm run dev`（サーバー、127.0.0.1:8787）と `npm run dev:web`（画面）を両方立ち上げ、http://localhost:8765/ を開く。`.dev.vars` に `ADMIN_PASSWORD=admin123` と `ALLOWED_ORIGIN=http://localhost:8765` を書いておく（このファイルは commit しない）。パスキーは 127.0.0.1 では動かないので localhost で開く。Chromium の開発者ツールの WebAuthn の欄（Playwright なら CDP の WebAuthn.addVirtualAuthenticator）で仮の認証器を使って試せる。
- スマホ幅（390px）と PC 幅、ライトとダークの両方を見る。
