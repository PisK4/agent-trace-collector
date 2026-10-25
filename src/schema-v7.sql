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

CREATE TABLE IF NOT EXISTS raw_otlp_log (
  record_hash     BLOB PRIMARY KEY,
  received_at     INTEGER NOT NULL,
  service         TEXT,
  trace_id        BLOB,
  span_id         BLOB,
  time_ms         INTEGER,
  body            TEXT,
  attributes_json TEXT NOT NULL,
  privacy_version INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_raw_otlp_log_trace ON raw_otlp_log(trace_id);

CREATE TABLE IF NOT EXISTS otlp_body_ref (
  request_body_id TEXT PRIMARY KEY,
  trace_id        BLOB NOT NULL,
  req_id          INTEGER,
  request_ref     TEXT,
  response_ref    TEXT,
  message_id      TEXT,
  state           TEXT NOT NULL,
  detail          TEXT,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_otlp_body_ref_pending ON otlp_body_ref(trace_id) WHERE state='pending_span';
