-- 個別の報告ログ
CREATE TABLE reports (
  id         INTEGER PRIMARY KEY,
  hash       TEXT    NOT NULL,           -- フル SHA-256(hex)
  kind       TEXT    NOT NULL,           -- 'url' | 'domain'
  reporter   TEXT    NOT NULL,           -- 匿名 UUID
  created_at INTEGER NOT NULL,           -- epoch 秒
  UNIQUE(hash, reporter)                 -- 同一端末の二重票を弾く
);

CREATE INDEX idx_reports_hash ON reports(hash);

-- 集計済みの確定リスト（配布の素）
CREATE TABLE entries (
  hash         TEXT    PRIMARY KEY,
  kind         TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,         -- hash 先頭 N 文字（配布の索引）
  report_count INTEGER NOT NULL,
  status       TEXT    NOT NULL,         -- 'pending' | 'active'
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_entries_prefix ON entries(prefix, status);
CREATE INDEX idx_entries_status ON entries(status);
