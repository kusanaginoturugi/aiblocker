# aiblocker-extension

ブラウザ拡張（Manifest V3）。最小プロト：`/filter` を定期 DL → フルホスト名をローカル照合 → ヒットしたら blur。

仕様は [`../docs/spec.md`](../docs/spec.md)。照合単位は **フルホスト名**（サブドメインを保持。`blog.example.com` と `example.com` は別物。`api/src/url.ts` に準拠）。

## 設計

- **background**（service worker）… 通信を担う唯一の場所。起動時と 6 時間ごとに `/filter` を DL し `chrome.storage.local` に焼く。content / popup からは現ホストだけを受け取り、保持する Bloom filter でヒット可否を返す。報告者の匿名 UUID もここで一度だけ生成・永続化する。
- **content** … 現ページの `location.hostname` を background に問い合わせ、ヒットなら body を blur（ホバーで解除）＋リンクバッジ。blur 中は報告用オーバーレイボタンを出す。**閲覧時のネットワーク通信はしない**。
- **popup**（ツールバー）… 現タブのホストと登録状況を表示し、報告ボタンを出す。
- `src/bloom.js` / `src/normalize.js` は `api/src/bloom.ts` / `api/src/url.ts` と同一アルゴリズム（往復照合の前提）。

## 報告 UI

- 入口は **popup**（ツールバーアイコン）と blur 中ページの **オーバーレイボタン** の2つ。
- どちらも background に `openReport` を投げ、background が API の `GET /report-page` を**新タブで開く**。`host`/`vote`/`reporter` は URL fragment(`#`)で渡す（サーバーには届かない）。
- Turnstile は報告ページ（workers.dev ドメイン）上で通す。`chrome-extension://` では Turnstile が動かないための回避。拡張側は Turnstile を一切触らない。

## ビルド

```sh
npm install
npm run build      # src/ を dist/ にバンドル
npm run watch      # 変更監視
```

## 読み込み（開発）

1. `npm run build` で `dist/` を生成
2. Chrome で `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→ この `extension/` を選択

## 未実装（次段）

- ハイブリッド照合（`/list?prefix=` による二次照合・オプトイン）
- blur 強度 3 段階のユーザー設定
