# aiblocker 仕様

生成AIが作成したコンテンツを、ブラウザ上で「ゆるやかに隠す」クラウドソース型システム。
広告ブロッカーに近いが、ブロックではなく blur によるソフトな抑制を行う。

## 方針

- ブロック対象は **URL 単位** と **ドメイン単位**。要素単位の検出は行わない（自動判別が非現実的なため）。
- 検出は自動ではなく、**利用者の能動的な報告**を集約して行う。
- 表示は攻撃的に消さず、**blur でゆるやかに隠す**。強度はユーザー設定。
- プライバシー最優先。**閲覧時の通信ゼロ**を既定とする（完全ローカル照合）。

## コンポーネント

- **拡張機能（Manifest V3）** … URL 正規化・ハッシュ化・ローカル照合・blur 表示・報告 UI。
- **API（Cloudflare Workers）** … フィルタ配布・プレフィックス照合・報告受付。
- **ストレージ** … D1（報告ログと集計）／ KV（配布物のキャッシュ）。

## URL 正規化

報告側と照合側で**完全に同一**の正規化をかけること（ハッシュ一致の前提）。

1. スキームを除去（`http`/`https` を区別しない）
2. ホストを小文字化し、先頭 `www.` を除去
3. 末尾スラッシュを除去
4. フラグメント `#...` を除去
5. クエリ文字列を**全削除**（utm 等のノイズ除去を優先、単純さ重視）
6. パスは大文字小文字を保持

正規化後、2 種類の文字列を作る:

- `domain` 例: `example.com`
- `url` 例: `example.com/path/to/article`

`?id=` でページが変わる SPA を取りこぼす欠点があるが許容する。許可リスト方式は将来検討。

## ハッシュと照合

- `hash = SHA-256(正規化文字列)` を 16 進小文字で表現。
- 閲覧時は**生 URL を送らない**。

### 一次照合（既定・完全オフライン）

- 拡張は **Bloom filter** をローカルに保持し、`domain` / `url` のハッシュを照合。
- 閲覧時の通信は発生しない。
- Bloom の偽陽性（稀に無関係サイトが薄く blur される）は許容する。

### 二次照合（オプトイン・ハイブリッド）

- Bloom がヒットした時のみ、**ハッシュ先頭 5 文字のプレフィックスだけ**を送信。
- サーバから該当プレフィックス帯のフルハッシュ群を受け取り、**残りはローカル照合**（k-匿名性）。
- 生ドメインは一切送らない。漏れるのは曖昧なプレフィックスのみ。
- 偽陽性を解消できるが、ヒット時に通信が発生する。

### プライバシーモード（ユーザー選択）

- **完全オフライン**（既定）… 一次照合のみ。閲覧時通信ゼロ。偽陽性を受容。
- **ハイブリッド**（オプトイン）… 二次照合あり。精度重視。

## 配布形式

- 既定は **Bloom filter**。10 万件・偽陽性率 0.1% で約 180KB。
- バージョン番号付きで丸ごと配布（差分配信はしない）。ETag + 数時間キャッシュ。
- 拡張は起動時と N 時間ごとに DL → メモリ展開。
- 当面は規模が小さいため、必要に応じてフルハッシュ全配布へ切替も可。

## 報告

- `POST /report` でフルハッシュを送信（能動的行為なので許容）。元 URL は送らない。
- **reporter ID = 匿名 UUID**（拡張がローカル生成）。個人特定は不可、同一端末の二重投票は防止。
- bot 対策に **Turnstile** トークンを付与（初期から導入）。`turnstile-spin` スキルで組む。

## 昇格ロジック（スパム耐性）

- 報告を `reports` に挿入し、同一 `hash` の distinct reporter 数を集計。
- 閾値 **N（初期 3）** 以上で `status='active'` に昇格。運用しながら調整。
- `active` のみを配布物（Bloom / プレフィックス）に反映。

## データモデル（D1）

```sql
-- 個別の報告ログ
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,           -- フル SHA-256(hex)
  kind TEXT NOT NULL,           -- 'url' | 'domain'
  reporter TEXT NOT NULL,       -- 匿名 UUID
  created_at INTEGER NOT NULL,  -- epoch 秒
  UNIQUE(hash, reporter)        -- 同一端末の二重票を弾く
);

-- 集計済みの確定リスト（配布の素）
CREATE TABLE entries (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  prefix TEXT NOT NULL,         -- hash 先頭 5 文字（配布の索引）
  report_count INTEGER NOT NULL,
  status TEXT NOT NULL,         -- 'pending' | 'active'
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_entries_prefix ON entries(prefix, status);
```

## API

```
GET  /filter
  → Bloom filter 本体（+ バージョン）。全員が定期 DL。KV に焼いて配信。

GET  /list?prefix=ab12c
  → { "url": ["残りhash...", ...], "domain": ["残りhash...", ...] }
  → ハイブリッド勢のみヒット時に叩く。KV にプレフィックス単位で焼く。

POST /report
  body: { hash, kind, reporter, turnstileToken? }
  → 201。閾値到達で昇格。
```

- 配布経路（`/filter`, `/list`）は KV 読みのみで高速化。
- D1 は集計・昇格バッチ専用とし、配布経路から切り離す。

## 表示

- 既定は `blur(4px)` + ホバーで解除。
- 強度 3 段階（バッジのみ / 薄める / 隠す）をユーザー設定で切替。

## 確定事項

- クエリ文字列: 全削除
- 昇格閾値 N: 3（運用しながら調整）
- Turnstile: 初期から導入

## 実装順

3（データモデル / API 仕様）→ 1（Workers + D1/KV）→ 2（拡張機能）。
