-- ATC schema v6: derive generations, staged results, work tables, publish pointer.
-- Executed by openStore() when it creates a brand-new database. v6 is not migrated into:
-- an existing lower-version database is refused and rebuilt by the operator.
-- Legacy request/tool_call columns stay in place and are never mixed field-by-field.

ALTER TABLE derive_queue ADD COLUMN legacy_snapshot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derive_queue ADD COLUMN compute_generation TEXT;
ALTER TABLE derive_queue ADD COLUMN published_generation TEXT;
ALTER TABLE derive_queue ADD COLUMN compute_started_ms INTEGER;
ALTER TABLE derive_queue ADD COLUMN last_claimed_ms INTEGER;
ALTER TABLE derive_queue ADD COLUMN last_completed_ms INTEGER;
ALTER TABLE derive_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derive_queue ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS i_derive_queue_dirty
  ON derive_queue(state, dirty_since_ms);
CREATE INDEX IF NOT EXISTS i_derive_queue_compute
  ON derive_queue(compute_generation) WHERE compute_generation IS NOT NULL;

CREATE TABLE IF NOT EXISTS derive_generation (
  generation          TEXT PRIMARY KEY,
  conv_key            TEXT NOT NULL,
  actor               TEXT NOT NULL,
  group_epoch         TEXT NOT NULL,
  input_revision      INTEGER NOT NULL,
  algorithm           INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK(state IN ('building','ready','published','retired','discarded')),
  stage               TEXT NOT NULL CHECK(stage IN ('requests','roles','role_assign','tools','summary','ready','done')),
  created_at          INTEGER NOT NULL,
  sealed_at           INTEGER,
  published_at        INTEGER,
  source_request_count INTEGER NOT NULL DEFAULT 0,
  source_tool_count   INTEGER NOT NULL DEFAULT 0,
  request_count       INTEGER NOT NULL DEFAULT 0,
  tool_count          INTEGER NOT NULL DEFAULT 0,
  cursor_req_id       INTEGER NOT NULL DEFAULT 0,
  role_scan_ord       INTEGER NOT NULL DEFAULT -1,
  role_assign_ord     INTEGER NOT NULL DEFAULT -1,
  role_root_req       INTEGER,
  tool_cursor_ord     INTEGER NOT NULL DEFAULT -1,
  summary_cursor_ord  INTEGER NOT NULL DEFAULT -1,
  ready_cursor_ord    INTEGER NOT NULL DEFAULT -1,
  source_request_sha256 TEXT NOT NULL DEFAULT '',
  source_tool_sha256    TEXT NOT NULL DEFAULT '',
  copied_request_sha256 TEXT NOT NULL DEFAULT '',
  copied_tool_sha256    TEXT NOT NULL DEFAULT '',
  staged_bytes        INTEGER NOT NULL DEFAULT 0,
  CHECK(length(generation) >= 16)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_generation_group
  ON derive_generation(conv_key, actor, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS i_derive_generation_published
  ON derive_generation(conv_key, actor) WHERE state='published';

CREATE TABLE IF NOT EXISTS derive_request_result (
  generation         TEXT NOT NULL,
  req_id             INTEGER NOT NULL CHECK(req_id > 0),
  input_epoch        TEXT,
  input_revision     INTEGER,
  sort_source        TEXT,
  sort_key           TEXT,
  started_ms         INTEGER NOT NULL,
  prev_req_id        INTEGER,
  prev_relation      TEXT,
  delta_ordinals     TEXT,
  chain_role         TEXT,
  title              TEXT,
  title_source       TEXT,
  input_preview      TEXT,
  input_preview_kind TEXT,
  reply_preview      TEXT,
  reply_shape        TEXT,
  traversal_ord      INTEGER NOT NULL DEFAULT -1,
  purpose_revision   INTEGER NOT NULL,
  purpose_version    INTEGER,
  purpose_chain      TEXT NOT NULL DEFAULT 'participate'
                     CHECK(purpose_chain IN ('participate','exclude')),
  algorithm          INTEGER NOT NULL,
  retention_state    TEXT NOT NULL CHECK(retention_state IN ('recomputed','retained','legacy')),
  basis_json         TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(generation, req_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_request_result_req
  ON derive_request_result(req_id);
CREATE INDEX IF NOT EXISTS i_derive_request_result_order
  ON derive_request_result(generation, traversal_ord);

-- Build-only ancestor fingerprints. Deleted on publish/discard; never a long-term copy.
CREATE TABLE IF NOT EXISTS derive_chain_work (
  generation      TEXT NOT NULL,
  req_id          INTEGER NOT NULL,
  traversal_ord   INTEGER NOT NULL,
  fingerprints_json TEXT,
  participating   INTEGER NOT NULL DEFAULT 1,
  byte_length     INTEGER NOT NULL,
  PRIMARY KEY(generation, req_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_chain_work_order
  ON derive_chain_work(generation, traversal_ord);

-- Build-only chain scan state. One row per participating request; the ancestor
-- keyset cursor lives here so a crash resumes instead of rescanning from the head.
CREATE TABLE IF NOT EXISTS derive_role_work (
  generation         TEXT NOT NULL,
  req_id             INTEGER NOT NULL,
  traversal_ord      INTEGER NOT NULL,
  started_ms         INTEGER NOT NULL,
  participating      INTEGER NOT NULL,
  parent_req_id      INTEGER,
  relation           TEXT,
  fingerprints_json  TEXT,
  scan_ord           INTEGER NOT NULL DEFAULT -1,
  best_parent_req    INTEGER,
  best_parent_len    INTEGER,
  saw_earlier        INTEGER NOT NULL DEFAULT 0,
  unreadable_earlier INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL CHECK(state IN ('scanning','done')),
  in_trunk           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(generation, req_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_role_work_order
  ON derive_role_work(generation, traversal_ord, req_id);

CREATE TABLE IF NOT EXISTS derive_tool_result (
  generation        TEXT NOT NULL,
  req_id            INTEGER NOT NULL,
  ord               INTEGER NOT NULL,
  call_id           TEXT NOT NULL,
  tool_name         TEXT,
  result_req        INTEGER,
  result_ord        INTEGER,
  result_path       TEXT,
  state             TEXT NOT NULL,
  algorithm_version INTEGER,
  basis_json        TEXT NOT NULL DEFAULT '{}',
  retention_state   TEXT NOT NULL CHECK(retention_state IN ('recomputed','retained','legacy')),
  PRIMARY KEY(generation, req_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_tool_result_call
  ON derive_tool_result(generation, call_id);

CREATE TABLE IF NOT EXISTS derive_call_work (
  generation    TEXT NOT NULL,
  req_id        INTEGER NOT NULL,
  ord           INTEGER NOT NULL,
  call_id       TEXT NOT NULL,
  tool_name     TEXT,
  request_index INTEGER NOT NULL,
  traversal_ord INTEGER NOT NULL,
  PRIMARY KEY(generation, req_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_call_work_id
  ON derive_call_work(generation, call_id);

CREATE TABLE IF NOT EXISTS derive_result_work (
  generation    TEXT NOT NULL,
  req_id        INTEGER NOT NULL,
  ord           INTEGER NOT NULL,
  path          TEXT NOT NULL,
  call_id       TEXT NOT NULL,
  preview       TEXT,
  request_index INTEGER NOT NULL,
  traversal_ord INTEGER NOT NULL,
  confirmed     INTEGER NOT NULL,
  PRIMARY KEY(generation, req_id, ord, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_result_work_id
  ON derive_result_work(generation, call_id);

CREATE VIEW IF NOT EXISTS published_derive_request AS
SELECT q.conv_key AS conv_key, q.actor AS actor,
       q.published_generation AS generation,
       q.legacy_snapshot AS legacy_snapshot,
       d.req_id AS req_id, d.prev_req_id AS prev_req_id,
       d.prev_relation AS prev_relation, d.delta_ordinals AS delta_ordinals,
       d.title AS title, d.title_source AS title_source,
       d.chain_role AS chain_role, d.input_preview AS input_preview,
       d.input_preview_kind AS input_preview_kind,
       d.reply_preview AS reply_preview,
       d.reply_shape AS reply_shape,
       d.purpose_revision AS consumed_purpose_revision,
       d.purpose_version AS consumed_purpose_version,
       d.algorithm AS algorithm, d.retention_state AS retention_state,
       d.basis_json AS basis_json
FROM derive_queue q
JOIN derive_request_result d ON d.generation = q.published_generation
WHERE q.published_generation IS NOT NULL;

CREATE VIEW IF NOT EXISTS effective_request AS
SELECT r.req_id AS req_id, r.conv_key AS conv_key, r.actor AS actor,
       r.started_ms AS started_ms,
       r.req_kind AS req_kind, r.model_title AS model_title,
       r.purpose_revision AS current_purpose_revision,
       q.state AS group_state, q.legacy_snapshot AS legacy_snapshot,
       d.generation AS generation,
       d.title AS title, d.title_source AS title_source,
       d.chain_role AS chain_role, d.prev_req_id AS prev_req_id,
       d.prev_relation AS prev_relation, d.delta_ordinals AS delta_ordinals,
       d.input_preview AS input_preview,
       d.input_preview_kind AS input_preview_kind,
       d.reply_preview AS reply_preview,
       d.reply_shape AS reply_shape,
       d.purpose_revision AS consumed_purpose_revision,
       d.purpose_version AS consumed_purpose_version,
       d.algorithm AS algorithm, d.retention_state AS retention_state
FROM request r
LEFT JOIN derive_queue q ON q.conv_key = r.conv_key AND q.actor = r.actor
LEFT JOIN derive_request_result d
  ON d.generation = q.published_generation AND d.req_id = r.req_id;