-- ATC schema v7: OTLP receiver raw layer. Additive only — existing v6 databases
-- upgrade in place via these statements; no column on an existing table changes.
-- Executed by openStore() both on fresh databases (after schema.sql + schema-v6.sql)
-- and on upgrade from user_version 6.

CREATE TABLE IF NOT EXISTS raw_otlp_span (
  trace_id   BLOB NOT NULL,
  span_id    BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  service    TEXT,
  scope_name TEXT,
  name       TEXT NOT NULL,
  kind       INTEGER,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER,
  status_code INTEGER,
  attributes_json TEXT NOT NULL,
  mapping_version INTEGER NOT NULL,
  privacy_version INTEGER NOT NULL,
  PRIMARY KEY (trace_id, span_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_raw_otlp_span_time ON raw_otlp_span(start_ms);
