# aiblocker-api

生成AIコンテンツ抑制リストの配布・収集 API（Cloudflare Workers）。
仕様は [`../docs/spec.md`](../docs/spec.md)。

## エンドポイント

- `GET  /filter` … Bloom filter 本体（バイナリ）。`x-filter-version` ヘッダ付き。全員が定期 DL し完全ローカル照合。
- `GET  /list?prefix=xxxxx` … 該当プレフィックス帯の active フルハッシュ群（k-匿名性の二次照合用）。
- `POST /report` … 報告。`{ hash, kind, reporter, turnstileToken? }`。閾値到達で `active` に昇格。

配布物（Bloom / プレフィックス）は Cron（毎時）で `active` エントリから再ビルドし KV に焼く。

## セットアップ

```sh
npm install

# リソース作成（発行された ID を wrangler.jsonc に反映）
npx wrangler d1 create aiblocker
npx wrangler kv namespace create DIST

# Turnstile シークレット登録
npx wrangler secret put TURNSTILE_SECRET

# マイグレーション
npm run migrate:local      # ローカル
npm run migrate:remote     # 本番
```

## 開発

```sh
npm run dev                # ローカル起動（D1/KV はエミュレート）
npm run typecheck
```

`wrangler dev --test-scheduled` 時は `GET /__scheduled` で Cron 再ビルドを手動発火できる。

## 設定

`wrangler.jsonc` の `vars`:

- `PROMOTE_THRESHOLD` … 昇格に必要な distinct reporter 数（既定 3）
- `PREFIX_LEN` … ハッシュプレフィックス長（既定 5）

## 注意

- `database_id` / KV `id` はプレースホルダ。作成後に差し替えること。
- ローカルでマイグレーション追跡がずれた場合は `npx wrangler d1 execute aiblocker --local --file migrations/0001_init.sql` で直接適用できる。
