# aiblocker

生成AIが作成したコンテンツを、ブラウザ上で「ゆるやかに隠す」クラウドソース型システム。
広告ブロッカーに近いが、ブロックではなく blur によるソフトな抑制を行う。

- 対象は **URL 単位 / ドメイン単位**（要素単位の検出はしない）。
- 検出は利用者の能動報告を集約。閾値到達でリスト入り。
- プライバシー最優先。既定は **閲覧時の通信ゼロ**（Bloom filter による完全ローカル照合）。

詳細仕様は [`docs/spec.md`](docs/spec.md)。

## 構成

- `api/` … 配布・収集 API（Cloudflare Workers + D1 + KV）。詳細は [`api/README.md`](api/README.md)。
- `extension/` … ブラウザ拡張（Manifest V3）。**未着手**。

## 進捗

- [x] 仕様確定（`docs/spec.md`）
- [x] API 実装 + ローカル検証（報告→昇格→再ビルド→配布、Bloom 往復一致まで確認）
- [ ] 本番リソース作成と接続
- [ ] 拡張機能

## 次にやること（オーナー作業）

リソース作成はアカウント権限が要るので手動。`api/` で:

1. `npx wrangler d1 create aiblocker` → 発行された `database_id` を `api/wrangler.jsonc` に反映
2. `npx wrangler kv namespace create DIST` → 発行された `id` を同上に反映
3. `npx wrangler secret put TURNSTILE_SECRET` で Turnstile シークレット登録（widget は `turnstile-spin` で作成）
4. `npm run migrate:remote` で本番 D1 にスキーマ適用
5. `npx wrangler deploy` で公開、`/report` を実 Turnstile 込みで疎通確認
6. GitHub リモート作成 → push（このリポジトリはまだ remote 未設定）

その後、拡張機能（`extension/`）の最小プロトタイプ（`/filter` DL → ローカル照合 → blur）に着手。
