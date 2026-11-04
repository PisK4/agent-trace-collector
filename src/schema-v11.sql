-- ATC schema v11: droid 会话文件摄入。Additive only —— v10 库单事务原地升级。
--
-- raw_droid_event：转录行的脱敏原文与物理身份 (file_generation, byte_offset)，
-- 供重放与审计；行类型与事件时间提到列上，只有审计才需要解析 payload。
-- session_usage：会话级累计用量，主键 (agent, session)；只对主会话的 settings
-- 写入，子代理用量计入调用它的会话，不在这里另算。source_hash 用来识别覆盖写。

CREATE TABLE IF NOT EXISTS raw_droid_event (
  file_generation TEXT NOT NULL,
  byte_offset      INTEGER NOT NULL,
  session_id       TEXT,
  line_type        TEXT NOT NULL,
  event_at_ms      INTEGER,
  payload_json     TEXT NOT NULL,
  privacy_version  INTEGER NOT NULL,
  PRIMARY KEY (file_generation, byte_offset)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_raw_droid_event_session ON raw_droid_event(session_id);

CREATE TABLE IF NOT EXISTS session_usage (
  agent                 TEXT NOT NULL,
  session               TEXT NOT NULL,
  model                 TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  thinking_tokens       INTEGER,
  factory_credits       REAL,
  source_path           TEXT NOT NULL,
  source_hash           TEXT NOT NULL,
  observed_at           INTEGER NOT NULL,
  PRIMARY KEY (agent, session)
) WITHOUT ROWID;