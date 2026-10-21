-- Schema v1. Fresh databases only; see src/store.ts for version checks.
-- request uses AUTOINCREMENT so committed IDs survive merges and are never reused.

CREATE TABLE source_cursor (
  source_kind      TEXT NOT NULL,
  source_name      TEXT NOT NULL,
  file_generation  TEXT NOT NULL,
  committed_off    INTEGER NOT NULL,
  seen_size        INTEGER,
  head_len         INTEGER,
  head_hash        TEXT,
  fingerprint      TEXT,
  last_ok_ms       INTEGER NOT NULL,
  rewrite_epoch    INTEGER NOT NULL DEFAULT 0,
  observed_off     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_kind, source_name)
);

CREATE TABLE raw_ledger (
  source_kind      TEXT NOT NULL,
  file_generation  TEXT NOT NULL,
  byte_offset      INTEGER NOT NULL,
  route_id         INTEGER,
  t_text           TEXT NOT NULL,
  t_ms             INTEGER NOT NULL,
  source           TEXT NOT NULL,
  handed_on        INTEGER NOT NULL DEFAULT 0,
  kind             TEXT,
  agent TEXT, provider TEXT, host TEXT, account TEXT,
  model TEXT, requested TEXT, served TEXT,
  in_tok INTEGER, out_tok INTEGER,
  cache_read INTEGER, cache_write INTEGER,
  reasoning INTEGER, effort TEXT,
  ms INTEGER, status INTEGER, stop TEXT,
  response_id TEXT, response_id_norm TEXT, rid TEXT, ep TEXT,
  session TEXT, native_session TEXT, subagent TEXT, parent_agent TEXT,
  ttft_ms INTEGER, flow_ms INTEGER, first_text_ms INTEGER,
  sent_ms INTEGER, retried_ms INTEGER, queued_ms INTEGER,
  own_ms INTEGER, reasoning_hidden INTEGER,
  tier_asked TEXT, tier_sent TEXT, tier_served TEXT,
  err_type TEXT, computer TEXT, via TEXT,
  archive TEXT,
  tries INTEGER,
  credits REAL, own_cost REAL,
  magpie_version TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (source_kind, file_generation, byte_offset)
) WITHOUT ROWID;

CREATE INDEX i_raw_ledger_route ON raw_ledger(route_id);
CREATE INDEX i_raw_ledger_resp  ON raw_ledger(response_id_norm);
CREATE INDEX i_raw_ledger_time  ON raw_ledger(t_ms);

CREATE TABLE raw_route (
  route_id         INTEGER PRIMARY KEY,
  time_ms          INTEGER NOT NULL,
  day              TEXT NOT NULL,
  agent TEXT, session TEXT, conv TEXT, folder TEXT,
  subagent_id TEXT, kind TEXT, for_json TEXT,
  model TEXT, provider TEXT, served TEXT, effort TEXT,
  status INTEGER, error TEXT, done INTEGER,
  ms INTEGER, ttft INTEGER, first_text INTEGER, flow INTEGER,
  tokens INTEGER, out_tok INTEGER, reasoning INTEGER,
  payload_json     TEXT NOT NULL,
  magpie_version   TEXT
);

CREATE TABLE raw_hook (
  hook_id          TEXT PRIMARY KEY,
  received_at      INTEGER NOT NULL,
  protocol TEXT, path TEXT, agent TEXT, session TEXT, cwd TEXT,
  origin TEXT, model TEXT, stream INTEGER, success INTEGER, duration_ms INTEGER,
  request_z        BLOB, response_z BLOB,
  request_bytes    INTEGER, response_bytes INTEGER,
  parse_state      TEXT NOT NULL,
  reply_state      TEXT,
  miss_reason      TEXT,
  magpie_version   TEXT
);

CREATE TABLE route_summary (
  route_id    INTEGER PRIMARY KEY,
  time_ms     INTEGER NOT NULL,
  model TEXT, served TEXT, provider TEXT,
  status INTEGER, ms INTEGER, ttft INTEGER, flow INTEGER, first_text INTEGER,
  order_json  TEXT,
  tries_json  TEXT,
  affinity_json TEXT,
  z           BLOB
);

CREATE TABLE request (
  req_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id         INTEGER,
  response_id_norm TEXT,
  agent TEXT, session TEXT, conv_key TEXT, conv_source TEXT,
  actor TEXT,
  subagent TEXT, parent_agent TEXT,
  started_ms       INTEGER NOT NULL,
  day              TEXT NOT NULL,
  via              TEXT NOT NULL,
  status INTEGER, stop TEXT,
  model_requested TEXT, model_served TEXT, provider TEXT,
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning INTEGER,
  cost REAL, cost_state TEXT, cost_at INTEGER,
  ms INTEGER, ttft_ms INTEGER, flow_ms INTEGER, first_text_ms INTEGER,
  attempt_count INTEGER, attempt_billed INTEGER,
  attempt_in INTEGER, attempt_out INTEGER,
  attempt_cache_read INTEGER, attempt_cache_write INTEGER,
  attempt_reasoning INTEGER,
  attempt_cost REAL, attempt_cost_state TEXT,
  attempt_derive_version INTEGER,
  prompt_tokens INTEGER, prompt_counted INTEGER,
  prompt_window INTEGER, prompt_turns INTEGER, parts_json TEXT,
  body_state       TEXT NOT NULL,
  body_prev_state  TEXT,
  body_evicted_at  INTEGER, body_evict_reason TEXT,
  archive TEXT,
  skeleton_z       BLOB,
  body_bytes       INTEGER,
  msg_count        INTEGER,
  prev_req_id      INTEGER,
  prev_relation    TEXT,
  delta_ordinals   TEXT,
  title TEXT, title_source TEXT,
  derive_version   INTEGER NOT NULL,
  have             INTEGER NOT NULL,
  miss_reason      TEXT,
  magpie_version   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sort_source TEXT,
  sort_key TEXT,
  actor_state TEXT NOT NULL DEFAULT 'unknown',
  parse_state TEXT,
  reply_state TEXT,
  adapter_version INTEGER,
  redact_version INTEGER,
  match_version INTEGER,
  pricing_version TEXT,
  cost_reason TEXT,
  attempt_state TEXT NOT NULL DEFAULT 'known',
  instance_key TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX i_req_conv ON request(conv_key, actor, started_ms DESC, req_id DESC);
CREATE INDEX i_req_session_time ON request(conv_key, started_ms DESC, req_id DESC);
CREATE INDEX i_req_time ON request(started_ms DESC, req_id DESC);
CREATE INDEX i_req_route ON request(route_id);
CREATE INDEX i_req_resp ON request(response_id_norm);
CREATE INDEX i_req_day  ON request(day);
CREATE INDEX i_req_body ON request(body_state) WHERE body_state != 'available';
CREATE INDEX i_req_fail ON request(started_ms DESC) WHERE status >= 400;

CREATE TABLE request_evidence (
  req_id      INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  ref_key     TEXT NOT NULL,
  merge_state TEXT NOT NULL,
  match_rule  TEXT,
  added_at    INTEGER NOT NULL,
  payload_state TEXT NOT NULL DEFAULT 'present',
  PRIMARY KEY (req_id, source_kind, ref_key)
) WITHOUT ROWID;
CREATE UNIQUE INDEX i_evidence_owner ON request_evidence(source_kind, ref_key);

CREATE TABLE pending_hook (
  hook_id     TEXT PRIMARY KEY,
  response_id TEXT, response_id_norm TEXT,
  first_seen  INTEGER NOT NULL,
  last_tried  INTEGER,
  candidates  TEXT
);

CREATE TABLE block (
  id       INTEGER PRIMARY KEY,
  hash     BLOB NOT NULL UNIQUE,
  z        BLOB NOT NULL,
  raw_size INTEGER NOT NULL
);

CREATE TABLE request_block (
  req_id INTEGER NOT NULL,
  ord    INTEGER NOT NULL,
  role   INTEGER NOT NULL,
  block  INTEGER NOT NULL,
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
CREATE INDEX i_rb_block ON request_block(block);

CREATE TABLE tool_call (
  call_id    TEXT NOT NULL,
  req_id     INTEGER NOT NULL,
  ord        INTEGER NOT NULL,
  tool_name  TEXT,
  result_req INTEGER,
  result_ord INTEGER,
  result_path TEXT,
  state      TEXT NOT NULL,
  derive_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
CREATE INDEX i_tool_call_id ON tool_call(call_id, req_id);

CREATE TABLE collector_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE request_alias (
  old_id INTEGER PRIMARY KEY,
  new_id INTEGER NOT NULL REFERENCES request(req_id),
  CHECK(old_id <> new_id)
);
CREATE INDEX i_request_alias_target ON request_alias(new_id);

CREATE TABLE derive_queue (
  conv_key TEXT NOT NULL, actor TEXT NOT NULL, from_sort TEXT NOT NULL,
  PRIMARY KEY(conv_key, actor)
) WITHOUT ROWID;

CREATE TABLE ingest_issue (
  source_kind TEXT NOT NULL, ref_key TEXT NOT NULL, reason TEXT NOT NULL,
  observed_at INTEGER NOT NULL, byte_length INTEGER,
  PRIMARY KEY(source_kind, ref_key, reason)
) WITHOUT ROWID;

CREATE TABLE source_gap (
  source_kind TEXT NOT NULL, source_name TEXT NOT NULL, file_generation TEXT NOT NULL,
  from_off INTEGER NOT NULL, to_off INTEGER NOT NULL, reason TEXT NOT NULL,
  state TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_kind, source_name, file_generation, from_off)
) WITHOUT ROWID;

-- 主动淘汰的长期记录：先写事件再删行，purged_evidence 是重放时的墓碑。
CREATE TABLE retention_event (
  id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, action TEXT NOT NULL,
  first_day TEXT, last_day TEXT, request_count INTEGER NOT NULL,
  reason TEXT NOT NULL, approval_id TEXT
);

CREATE TABLE purged_evidence (
  source_kind TEXT NOT NULL, ref_key TEXT NOT NULL, purged_at INTEGER NOT NULL,
  PRIMARY KEY(source_kind,ref_key)
) WITHOUT ROWID;

CREATE TABLE cost_observation (
  ref_key TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  projection_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  magpie_version TEXT, pricing_version TEXT,
  PRIMARY KEY(ref_key, observed_at)
) WITHOUT ROWID;
