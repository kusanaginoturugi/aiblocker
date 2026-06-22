-- 報告に投票方向を追加。+1 = AI生成だと報告、-1 = AIではないと報告（unvote）。
-- 既存行は AI 報告とみなして 1。
ALTER TABLE reports ADD COLUMN vote INTEGER NOT NULL DEFAULT 1;
