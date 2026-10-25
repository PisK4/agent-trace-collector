/** 会话列表：聚合窗口、标题选取与状态标志。 */

import { derivedColSql, groupCurrentSql } from '../derive/state';
import { HAVE_BODY } from '../evidence';
import type { Store } from '../store';
import { checkLimit, decodeCursor, encodeCursor, type Page } from './cursor';

export type SessionRow = {
  conv_key: string; title: string; last_ms: number; request_count: number;
  agents: string[]; flags: string[];
};

type SessionDbRow = {
  conv_key: string; last_ms: number; request_count: number; title: string | null; agents: string | null;
  has_failed: number; has_unknown: number; has_missing: number; has_participate: number;
};

/**
 * 会话状态只从确定事实聚合，四个标志固定按失败、待确认、缺正文、旁路的顺序输出。
 * 失败看 HTTP 状态；待确认看身份未知或前驱关系未知；缺正文看正文不在可读状态
 * 或没拿到回调（`have` 第 1 位是回调位）；旁路看会话内是否存在参与链请求。
 */
const SESSION_FLAG_COLUMNS = `
  MAX(CASE WHEN status IS NOT NULL AND status >= 400 THEN 1 ELSE 0 END) AS has_failed,
  MAX(CASE WHEN actor_state = 'unknown' OR prev_relation = 'unknown' THEN 1 ELSE 0 END) AS has_unknown,
  MAX(CASE WHEN body_state <> 'available' OR (have & ${HAVE_BODY}) = 0 THEN 1 ELSE 0 END) AS has_missing,
  MAX(CASE WHEN purpose_chain = 'participate' THEN 1 ELSE 0 END) AS has_participate`;

/**
 * 会话标题只取已经结算的当前结果：排除用途提供模型标题，参与链提供用户标题。
 *
 * 四个候选都要求请求用途已判定且所属组已完成；dirty 组或待判定用途的旧标题
 * 不是当前结论，不能拿来命名会话。用户标题不再按 `req_kind='chat'` 过滤：
 * 未知来源类别只要参与链，就可以提供用户首句。
 */
const SESSION_TITLE_SQL = `COALESCE(
  (SELECT r1.model_title FROM request r1
   JOIN derive_queue q1 ON q1.conv_key = r1.conv_key AND q1.actor = r1.actor
   WHERE r1.conv_key = request.conv_key AND r1.purpose_chain = 'exclude'
     AND r1.model_title IS NOT NULL AND r1.purpose_pending = 0
     AND ${groupCurrentSql('q1')}
   ORDER BY r1.started_ms DESC, r1.req_id DESC LIMIT 1),
  (SELECT ${derivedColSql('q2', 'e2', 'r2', 'title')} FROM request r2
   JOIN derive_queue q2 ON q2.conv_key = r2.conv_key AND q2.actor = r2.actor
   LEFT JOIN derive_request_result e2 ON e2.generation = q2.published_generation AND e2.req_id = r2.req_id
   WHERE r2.conv_key = request.conv_key AND ${derivedColSql('q2', 'e2', 'r2', 'title_source')} = 'user_delta'
     AND r2.purpose_chain = 'participate' AND ${derivedColSql('q2', 'e2', 'r2', 'chain_role')} = 'main'
     AND ${derivedColSql('q2', 'e2', 'r2', 'title')} IS NOT NULL AND r2.purpose_pending = 0
     AND ${groupCurrentSql('q2')}
   ORDER BY r2.started_ms ASC, r2.req_id ASC LIMIT 1),
  (SELECT ${derivedColSql('q3', 'e3', 'r3', 'title')} FROM request r3
   JOIN derive_queue q3 ON q3.conv_key = r3.conv_key AND q3.actor = r3.actor
   LEFT JOIN derive_request_result e3 ON e3.generation = q3.published_generation AND e3.req_id = r3.req_id
   WHERE r3.conv_key = request.conv_key AND ${derivedColSql('q3', 'e3', 'r3', 'title_source')} = 'user_delta'
     AND r3.purpose_chain = 'participate' AND ${derivedColSql('q3', 'e3', 'r3', 'title')} IS NOT NULL
     AND r3.purpose_pending = 0
     AND ${groupCurrentSql('q3')}
   ORDER BY r3.started_ms ASC, r3.req_id ASC LIMIT 1),
  (SELECT ${derivedColSql('q4', 'e4', 'r4', 'title')} FROM request r4
   JOIN derive_queue q4 ON q4.conv_key = r4.conv_key AND q4.actor = r4.actor
   LEFT JOIN derive_request_result e4 ON e4.generation = q4.published_generation AND e4.req_id = r4.req_id
   WHERE r4.conv_key = request.conv_key AND r4.purpose_chain = 'participate'
     AND ${derivedColSql('q4', 'e4', 'r4', 'title')} IS NOT NULL AND r4.purpose_pending = 0
     AND ${groupCurrentSql('q4')}
   ORDER BY r4.started_ms ASC, r4.req_id ASC LIMIT 1)
)`;

export function listSessions(store: Store, limit = 50, cursor: string | null = null): Page<SessionRow> {
  const size = checkLimit(limit, 100);
  const bound = cursor === null
    ? null
    : decodeCursor(cursor, value => {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const [lastMs, convKey] = value;
      if (typeof lastMs !== 'number' || !Number.isFinite(lastMs) || typeof convKey !== 'string') return null;
      return { lastMs, convKey };
    });
  const rows = (bound === null
    ? store.read.query<SessionDbRow, [number]>(`
        SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
               -- 会话标题取正式标题；没有才退回用户首句。MAX(title) 是字典序最大值，
               -- 会把 group/... 之类的模型名排在前面，会话就被命名成和内容无关的字符串。
               ${SESSION_TITLE_SQL} AS title,
               -- agents 取 magpie 的客户端标签（claude / omp 等）；actor 是会话/子代理身份，
               -- 拿 actor 当 agents 会把 UUID 当成客户端名展示。
               GROUP_CONCAT(DISTINCT agent) AS agents,
               ${SESSION_FLAG_COLUMNS}
        FROM request
        WHERE conv_key IS NOT NULL
        GROUP BY conv_key
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`)
      .all(size + 1)
    : store.read.query<SessionDbRow, [number, string, number]>(`
        SELECT conv_key, last_ms, request_count, title, agents, has_failed, has_unknown, has_missing, has_participate FROM (
          SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
                 ${SESSION_TITLE_SQL} AS title,
                 -- 同首查：agents 是 magpie 的客户端标签，不是 actor 身份。
                 GROUP_CONCAT(DISTINCT agent) AS agents,
                 ${SESSION_FLAG_COLUMNS}
          FROM request
          WHERE conv_key IS NOT NULL
          GROUP BY conv_key
        ) GROUPED
        WHERE (last_ms, conv_key) < (?, ?)
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`)
      .all(bound.lastMs, bound.convKey, size + 1)) as SessionDbRow[];

  const page = rows.slice(0, size);
  const items: SessionRow[] = page.map(row => {
    const flags: string[] = [];
    if (row.has_failed === 1) flags.push('failed');
    if (row.has_unknown === 1) flags.push('unknown');
    if (row.has_missing === 1) flags.push('missing_body');
    // 全员 exclude 的会话是旁路（标题生成、skill 描述压缩）：列表默认折叠由
    // 渲染层做，这里只给事实标志。任一笔参与链请求都不折叠，错藏真会话的
    // 代价远高于多显示一条噪音。
    if (row.has_participate === 0) flags.push('bypass');
    return {
      conv_key: row.conv_key,
      title: row.title ?? '',
      last_ms: row.last_ms,
      request_count: row.request_count,
      agents: row.agents === null ? [] : row.agents.split(',').filter(value => value.length > 0),
      flags,
    };
  });
  const last = page[page.length - 1];
  const nextCursor = rows.length > size && last !== undefined
    ? encodeCursor([last.last_ms, last.conv_key])
    : null;
  return { items, next_cursor: nextCursor };
}
