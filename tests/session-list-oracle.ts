/**
 * 旧版单条聚合会话列表的冻结快照（commit 58033fc 的 src/queries/sessions.ts）：
 * 对全部历史会话计算宽字段后再排序分页。只给两阶段实现做等价对照，
 * 测试与性能脚本共用；有意变更列表语义时应一并审视这份对照是否仍要成立。
 */

import type { Database } from 'bun:sqlite';

const LEGACY_TITLE_SQL = `COALESCE(
  (SELECT r1.model_title FROM request r1
   JOIN derive_queue q1 ON q1.conv_key = r1.conv_key AND q1.actor = r1.actor
   WHERE r1.conv_key = request.conv_key AND r1.purpose_chain = 'exclude'
     AND r1.model_title IS NOT NULL AND r1.purpose_pending = 0
     AND q1.state='clean' AND q1.published_revision=q1.input_revision
     AND q1.published_algorithm=q1.target_algorithm
   ORDER BY r1.started_ms DESC, r1.req_id DESC LIMIT 1),
  (SELECT CASE WHEN q2.published_generation IS NOT NULL THEN e2.title ELSE r2.title END FROM request r2
   JOIN derive_queue q2 ON q2.conv_key = r2.conv_key AND q2.actor = r2.actor
   LEFT JOIN derive_request_result e2 ON e2.generation = q2.published_generation AND e2.req_id = r2.req_id
   WHERE r2.conv_key = request.conv_key
     AND (CASE WHEN q2.published_generation IS NOT NULL THEN e2.title_source ELSE r2.title_source END) = 'user_delta'
     AND r2.purpose_chain = 'participate'
     AND (CASE WHEN q2.published_generation IS NOT NULL THEN e2.chain_role ELSE r2.chain_role END) = 'main'
     AND (CASE WHEN q2.published_generation IS NOT NULL THEN e2.title ELSE r2.title END) IS NOT NULL
     AND r2.purpose_pending = 0
     AND q2.state='clean' AND q2.published_revision=q2.input_revision
     AND q2.published_algorithm=q2.target_algorithm
   ORDER BY r2.started_ms ASC, r2.req_id ASC LIMIT 1),
  (SELECT CASE WHEN q3.published_generation IS NOT NULL THEN e3.title ELSE r3.title END FROM request r3
   JOIN derive_queue q3 ON q3.conv_key = r3.conv_key AND q3.actor = r3.actor
   LEFT JOIN derive_request_result e3 ON e3.generation = q3.published_generation AND e3.req_id = r3.req_id
   WHERE r3.conv_key = request.conv_key
     AND (CASE WHEN q3.published_generation IS NOT NULL THEN e3.title_source ELSE r3.title_source END) = 'user_delta'
     AND r3.purpose_chain = 'participate'
     AND (CASE WHEN q3.published_generation IS NOT NULL THEN e3.title ELSE r3.title END) IS NOT NULL
     AND r3.purpose_pending = 0
     AND q3.state='clean' AND q3.published_revision=q3.input_revision
     AND q3.published_algorithm=q3.target_algorithm
   ORDER BY r3.started_ms ASC, r3.req_id ASC LIMIT 1),
  (SELECT CASE WHEN q4.published_generation IS NOT NULL THEN e4.title ELSE r4.title END FROM request r4
   JOIN derive_queue q4 ON q4.conv_key = r4.conv_key AND q4.actor = r4.actor
   LEFT JOIN derive_request_result e4 ON e4.generation = q4.published_generation AND e4.req_id = r4.req_id
   WHERE r4.conv_key = request.conv_key AND r4.purpose_chain = 'participate'
     AND (CASE WHEN q4.published_generation IS NOT NULL THEN e4.title ELSE r4.title END) IS NOT NULL
     AND r4.purpose_pending = 0
     AND q4.state='clean' AND q4.published_revision=q4.input_revision
     AND q4.published_algorithm=q4.target_algorithm
   ORDER BY r4.started_ms ASC, r4.req_id ASC LIMIT 1)
)`;

const LEGACY_FLAG_COLUMNS = `
  MAX(CASE WHEN status IS NOT NULL AND status >= 400 THEN 1 ELSE 0 END) AS has_failed,
  MAX(CASE WHEN actor_state = 'unknown' OR prev_relation = 'unknown' THEN 1 ELSE 0 END) AS has_unknown,
  MAX(CASE WHEN (
    CASE
      WHEN via = 'otlp' THEN (have & 8) = 0
      WHEN via = 'rejected' THEN (have & 2) = 0
      WHEN via = 'through' THEN (have & 7) <> 7 OR body_state <> 'available'
      ELSE body_state <> 'available' OR (have & 1) = 0
    END
  ) THEN 1 ELSE 0 END) AS has_missing,
  MAX(CASE WHEN purpose_chain = 'participate' THEN 1 ELSE 0 END) AS has_participate,
  MIN(CASE WHEN req_kind IN ('source:model_list','source:provider_test','source:api_detect') THEN 1 ELSE 0 END) AS all_probe_kind,
  MAX(CASE WHEN body_state = 'available' THEN 1 ELSE 0 END) AS has_readable_body,
  MAX(CASE WHEN coalesce(in_tok,0)+coalesce(out_tok,0)+coalesce(cache_read,0)+coalesce(cache_write,0) > 0
    OR coalesce(cost,0) <> 0 THEN 1 ELSE 0 END) AS has_usage,
  MAX(CASE WHEN actor IS NOT NULL THEN 1 ELSE 0 END) AS has_actor`;

export const LEGACY_LIST_WIDE = `
  SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
         ${LEGACY_TITLE_SQL} AS title,
         GROUP_CONCAT(DISTINCT agent) AS agents,
         SUM(cost) AS cost_usd,
         ${LEGACY_FLAG_COLUMNS}
  FROM request
  WHERE conv_key IS NOT NULL
  GROUP BY conv_key`;

export type LegacySessionDbRow = {
  conv_key: string; last_ms: number; request_count: number; title: string | null; agents: string | null;
  has_failed: number; has_unknown: number; has_missing: number; has_participate: number;
  all_probe_kind: number; has_readable_body: number; has_usage: number; has_actor: number;
  cost_usd: number | null;
};

export function legacyListSessions(store: { read: Database }, limit: number, cursor: string | null) {
  const bound = cursor === null
    ? null
    : (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [number, string]);
  const rows = (bound === null
    ? store.read.query(`${LEGACY_LIST_WIDE}
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`).all(limit + 1)
    : store.read.query(`SELECT conv_key, last_ms, request_count, title, agents, has_failed, has_unknown, has_missing, has_participate,
               all_probe_kind, has_readable_body, has_usage, has_actor, cost_usd FROM (
          ${LEGACY_LIST_WIDE}
        ) GROUPED
        WHERE (last_ms, conv_key) < (?, ?)
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`).all(bound[0], bound[1], limit + 1)) as LegacySessionDbRow[];
  const page = rows.slice(0, limit);
  const items = page.map(row => {
    const flags: string[] = [];
    if (row.has_failed === 1) flags.push('failed');
    if (row.has_unknown === 1) flags.push('unknown');
    if (row.has_missing === 1) flags.push('missing_body');
    if (row.has_participate === 0) flags.push('bypass');
    if (row.all_probe_kind === 1 && row.has_readable_body === 0
      && row.has_usage === 0 && row.has_actor === 0) flags.push('probe');
    return {
      conv_key: row.conv_key,
      title: row.title ?? '',
      last_ms: row.last_ms,
      request_count: row.request_count,
      agents: row.agents === null ? [] : row.agents.split(',').filter(value => value.length > 0),
      flags,
      cost_usd: row.cost_usd ?? 0,
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    next_cursor: rows.length > limit && last !== undefined
      ? Buffer.from(JSON.stringify([last.last_ms, last.conv_key]), 'utf8').toString('base64url')
      : null,
  };
}
