-- ATC schema v12: 会话原始层统一。Additive/rename only —— v11 库单事务原地升级。
--
-- raw_droid_event 是 v11 为 droid 建的批次间重放层；五个本地 Agent 适配器复用
-- 同一形状，只剩来源列不同。升级先把表改名，再加 source_kind 列；旧行默认
-- 'droid_transcript'，不需要扫描或回填。索引按 (source_kind, session_id) 重建。

ALTER TABLE raw_droid_event RENAME TO raw_session_event;
DROP INDEX IF EXISTS i_raw_droid_event_session;
ALTER TABLE raw_session_event ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'droid_transcript';
CREATE INDEX IF NOT EXISTS i_raw_session_event_session ON raw_session_event(source_kind, session_id);