# aiblocker

生成AIが作成したコンテンツを、ブラウザ上で「ゆるやかに隠す」クラウドソース型システム。
広告ブロッカーに近いが、ブロックではなく blur によるソフトな抑制を行う。

- 対象は **ホスト単位**（フルホスト名、サブドメイン保持）。要素単位の検出はしない。
- 検出は利用者の能動報告を集約。閾値到達でリスト入り。
- プライバシー最優先。既定は **閲覧時の通信ゼロ**（Bloom filter による完全ローカル照合）。

詳細仕様は [`docs/spec.md`](docs/spec.md)。

## 構成

- `api/` … 配布・収集 API（Cloudflare Workers + D1 + KV）。詳細は [`api/README.md`](api/README.md)。
- `extension/` … ブラウザ拡張（Manifest V3）。最小プロト実装済み（`/filter` DL → フルホスト照合 → blur）。詳細は [`extension/README.md`](extension/README.md)。

## 進捗

- [x] 仕様確定（`docs/spec.md`）
- [x] API 実装 + ローカル検証（報告→昇格→再ビルド→配布、Bloom 往復一致まで確認）
- [x] 本番リソース作成と接続（D1 / KV / `TURNSTILE_SECRET` / cron、公開 URL 有効）
- [ ] 拡張機能（最小プロト実装済み：DL→照合→blur。報告 UI・ハイブリッド照合は残）

## 本番（接続済み）

- URL: `https://aiblocker-api.kusanaginoturugi.workers.dev`
- D1 `aiblocker` / KV `DIST` 作成・`api/wrangler.jsonc` に反映済み。
- `TURNSTILE_SECRET` 登録済み＝検証 ON（widget sitekey `0x4AAAAAADncg2eAPsF8mQ0T`、mode `managed`、許可ドメイン `localhost` / `127.0.0.1` / 上記 workers.dev）。token 無しの `/report` は 403。
- cron `0 * * * *`（active から配布物を毎時再ビルド）。
- 更新は `api/` で `npx wrangler deploy`。スキーマ変更時は先に `npm run migrate:remote`。

## 次にやること

拡張機能（`extension/`）の最小プロトタイプ（`/filter` DL → ローカル照合 → blur）に着手。
