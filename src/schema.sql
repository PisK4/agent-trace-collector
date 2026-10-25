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
  err TEXT,
  err_type TEXT, computer TEXT, via TEXT,
  archive TEXT,
  tries INTEGER,
  credits REAL, own_cost REAL,
  magpie_version TEXT,
  mapping_version INTEGER,
  privacy_version INTEGER,
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
  magpie_version   TEXT,
  mapping_version  INTEGER,
  privacy_version  INTEGER
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
  -- 请求类别：chat 是正常对话请求，title 是 harness 的 Title Generator 请求。
  -- 标题请求不参与主链，它生成的正式标题另存 model_title。
  req_kind         TEXT NOT NULL DEFAULT 'chat',
  -- 链角色：main 主链、branch 次链、aux 辅助请求（标题生成）。
  -- 同 (conv_key, actor) 内按后续请求数选主链，其余标 branch。
  chain_role       TEXT NOT NULL DEFAULT 'main',
  model_title      TEXT,
  -- 折叠行摘要：派生时写入，列表接口直接返回，不碰正文块。
  -- kind 说明摘要是什么：delta（本轮新增）/ tail（末轮输入，非新增）/
  -- tool_result（本轮没有用户消息，输入是工具结果）/ title（标题生成请求）。
  input_preview    TEXT,
  input_preview_kind TEXT,
  reply_preview    TEXT,
  -- 回复形状位：final / tools / unknown，轮次结算的收尾判定在派生期落这里。
  -- 正文回收后保留派生时的值；NULL 表示从未判定（升级窗口期，回填收口为 unknown）。
  reply_shape      TEXT,
  -- 已识别用户中断：派生解释确定增量里的用户消息时按开头前缀计数。
  -- 正文回收后保留派生时的值；NULL 表示从未判定（正文不可读或派生先于本列）。
  interrupt_count  INTEGER,
  -- 上下文事件位：omp_compaction 表示本笔确定增量新增了 OMP 压缩归档消息
  -- （branch 关系按输入含归档判定）。丢弃量记在 summary_basis 的 dropped_chars。
  -- 正文回收后保留派生时的值；NULL 表示从未判定。
  context_event    TEXT,
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
  instance_key TEXT NOT NULL DEFAULT 'local',
  -- v5：来源事实、投影元数据与请求修订
  model_provider TEXT,
  source_facts_json TEXT,
  projection_meta_json TEXT,
  input_epoch TEXT NOT NULL DEFAULT '',
  input_revision INTEGER NOT NULL DEFAULT 0,
  purpose_revision INTEGER NOT NULL DEFAULT -1,
  purpose_target INTEGER NOT NULL DEFAULT 1,
  purpose_version INTEGER,
  purpose_pending INTEGER NOT NULL DEFAULT 1,
  purpose_status TEXT NOT NULL DEFAULT 'missing',
  purpose_rule TEXT,
  purpose_signals TEXT NOT NULL DEFAULT '[]',
  purpose_chain TEXT NOT NULL DEFAULT 'participate'
    CHECK(purpose_chain IN ('participate','exclude')),
  purpose_retry INTEGER NOT NULL DEFAULT 0,
  summary_algorithm INTEGER,
  summary_basis TEXT,
  summary_state TEXT NOT NULL DEFAULT 'legacy'
);
CREATE INDEX i_req_conv ON request(conv_key, actor, started_ms DESC, req_id DESC);
CREATE INDEX i_req_session_time ON request(conv_key, started_ms DESC, req_id DESC);
CREATE INDEX i_req_time ON request(started_ms DESC, req_id DESC);
CREATE INDEX i_req_route ON request(route_id);
CREATE INDEX i_req_resp ON request(response_id_norm);
CREATE INDEX i_req_day  ON request(day);
CREATE INDEX i_req_body ON request(body_state) WHERE body_state != 'available';
CREATE INDEX i_req_fail ON request(started_ms DESC) WHERE status >= 400;
CREATE INDEX i_req_model_title ON request(conv_key, started_ms DESC, req_id DESC) WHERE req_kind = 'title';
CREATE INDEX i_req_purpose_pending ON request(purpose_pending,req_id)
  WHERE purpose_pending=1;

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
  -- 语义指纹：忽略 cache_control 等传输标记后的规范化消息。
  -- 派生比对用它，不能拿 hash 比：缓存断点移动会让同一内容换哈希。
  fingerprint TEXT NOT NULL,
  z        BLOB NOT NULL,
  raw_size INTEGER NOT NULL
);
CREATE INDEX i_block_fp ON block(fingerprint);

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
  -- 调用参数的两个事实：Edit/Write/Read 的 file_path 与 OMP 同族工具的 path。
  -- 键缺失落 NULL，不猜近邻键；正文回收后随配对行保留。
  arg_path   TEXT,
  arg_skill  TEXT,
  result_req INTEGER,
  result_ord INTEGER,
  result_path TEXT,
  -- 配对结果的失败位：true=1、其余（false、缺席、chat 无失败通道）=0；
  -- 未配对为 NULL。聚合计失败数，缺席按协议缺省读成非失败。
  is_error   INTEGER,
  state      TEXT NOT NULL,
  derive_version INTEGER NOT NULL DEFAULT 1,
  algorithm_version INTEGER,
  basis_json TEXT,
  retention_state TEXT NOT NULL DEFAULT 'legacy',
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
CREATE INDEX i_tool_call_id ON tool_call(call_id, req_id);

-- OMP bash 后台作业的发起→通知配对，纯派生结算表、可整体重建。
-- spawn/notice 各记最早出现的（请求, 消息序号）；主键带 conv_key：
-- OMP 重启后 bg_ 编号从头开始，单以 job_id 为主键会跨 conv 撞键。
-- 时延按两笔请求的 started_ms 差；state: resolved=两端齐、pending=缺通知或缺发起。
CREATE TABLE bg_job (
  job_id       TEXT NOT NULL,
  conv_key     TEXT NOT NULL,
  spawn_req    INTEGER,
  spawn_ord    INTEGER,
  notice_req   INTEGER,
  notice_ord   INTEGER,
  state        TEXT NOT NULL,
  PRIMARY KEY (conv_key, job_id)
) WITHOUT ROWID;

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

-- 持久组状态：clean 行保留，待办查询一律 state<>'clean'。
-- input_revision 随输入变化增长，完成时记 published_revision 与 published_algorithm；
-- dirty_since_ms 只表示首次未完成触发时间，重复 dirty 保最早值，clean 后清 NULL。
CREATE TABLE derive_queue (
  conv_key TEXT NOT NULL, actor TEXT NOT NULL, from_sort TEXT NOT NULL,
  group_epoch TEXT NOT NULL DEFAULT '',
  input_revision INTEGER NOT NULL DEFAULT 0,
  published_revision INTEGER NOT NULL DEFAULT -1,
  target_algorithm INTEGER NOT NULL DEFAULT 1,
  published_algorithm INTEGER,
  state TEXT NOT NULL DEFAULT 'dirty',
  dirty_since_ms INTEGER,
  PRIMARY KEY(conv_key, actor)
) WITHOUT ROWID;
CREATE INDEX i_derive_dirty ON derive_queue(state,conv_key,actor) WHERE state='dirty';

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
