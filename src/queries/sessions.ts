/** 会话列表：聚合窗口、标题选取与状态标志。 */

import { derivedColSql, groupCurrentSql } from '../derive/state';
import { HAVE_BODY, HAVE_LEDGER, HAVE_OTLP, HAVE_ROUTE } from '../evidence';
import type { Store } from '../store';
import { checkLimit, decodeCursor, encodeCursor, type Page } from './cursor';

export type SessionRow = {
  conv_key: string; title: string; last_ms: number; request_count: number;
  agents: string[]; flags: string[];
  /** 组内成本合计；折叠条给工具子事件报总费，其余消费方可忽略。 */
  cost_usd?: number;
  /** 只有传入活跃快照时才有这三个字段；旧调用方拿到的形状不变。 */
  live?: boolean; inflight?: boolean; live_until?: number | null;
};

/** 列表读取只需要两件事：服务端当前时间与在途请求的内存态。 */
export type SessionLive = {
  now: number;
  inflight: (convKey: string) => boolean;
};

export const LIVE_WINDOW_MS = 60_000;

type SessionDbRow = {
  conv_key: string; last_ms: number; request_count: number; title: string | null; agents: string | null;
  has_failed: number; has_unknown: number; has_missing: number; has_participate: number;
  has_background: number; has_recognized_main: number;
  all_probe_kind: number; has_readable_body: number; has_usage: number; has_actor: number;
  all_tool_search: number; has_session: number; cost_usd: number | null;
};

/** 阶段一候选行：覆盖索引上每个会话只取键与真实最近请求时间。 */
type SessionCandidateRow = { conv_key: string; last_ms: number };

/**
 * 会话状态只从确定事实聚合，标志固定按失败、待确认、缺正文、旁路、后台、
 * 探针、工具子事件的顺序输出。失败看 HTTP 状态；待确认看身份未知或前驱关系
 * 未知；缺正文看正文不在可读状态或没拿到回调（`have` 第 1 位是回调位）；旁路
 * 看会话内是否存在参与链请求；探针看整组是否都是 magpie 自己的探测请求；
 * 工具子事件看整组是否都是无会话归属的 WebSearch 检索行。
 */

/** magpie `probelog` 的三个封闭 kind：模型列表、provider 连通性测试、接口探测。 */
const PROBE_KINDS = `'source:model_list','source:provider_test','source:api_detect'`;

const SESSION_FLAG_COLUMNS = `
  MAX(CASE WHEN status IS NOT NULL AND status >= 400 THEN 1 ELSE 0 END) AS has_failed,
  MAX(CASE WHEN actor_state = 'unknown' OR prev_relation = 'unknown' THEN 1 ELSE 0 END) AS has_unknown,
  -- 缺正文按期望位图算：through 期望回调+账本+路由三路、rejected 只期望账本、
  -- otlp 只期望第 4 位——OTLP 行不因缺 magpie 证据被标成采集失败；其余通道
  -- （hook 落位、账本未关联）沿用第 1 位与可读状态的现行语义。
  MAX(CASE WHEN (
    CASE
      WHEN via = 'otlp' THEN (have & ${HAVE_OTLP}) = 0
      WHEN via = 'rejected' THEN (have & ${HAVE_LEDGER}) = 0
      WHEN via = 'through' THEN (have & ${HAVE_BODY | HAVE_LEDGER | HAVE_ROUTE}) <> ${HAVE_BODY | HAVE_LEDGER | HAVE_ROUTE}
        OR body_state <> 'available'
      ELSE body_state <> 'available' OR (have & ${HAVE_BODY}) = 0
    END
  ) THEN 1 ELSE 0 END) AS has_missing,
  MAX(CASE WHEN purpose_chain = 'participate' THEN 1 ELSE 0 END) AS has_participate,
  -- 后台会话：有 ambient/memory 请求，但整组没有任何“已识别的主用途”。
  -- 与 bypass 不同，后台组可以混着来源未知的参与链行（例如迟到的 499），
  -- 仍然折到后台；只要出现一笔已识别的参与链，就按主链显示，成本照计。
  MAX(CASE WHEN req_kind IN ('source:ambient_suggestions','source:memory_consolidation') THEN 1 ELSE 0 END) AS has_background,
  MAX(CASE WHEN purpose_chain = 'participate' AND purpose_status = 'recognized' THEN 1 ELSE 0 END) AS has_recognized_main,
  -- 探针组要四个条件同时成立：全组都是探针 kind、没有可读正文、没有 token 与
  -- 费用、没有任何 actor 归属。任一条件不满足都留在列表里：错折真流量的代价
  -- 高于多显示几行噪音。
  MIN(CASE WHEN req_kind IN (${PROBE_KINDS}) THEN 1 ELSE 0 END) AS all_probe_kind,
  MAX(CASE WHEN body_state = 'available' THEN 1 ELSE 0 END) AS has_readable_body,
  MAX(CASE WHEN coalesce(in_tok,0)+coalesce(out_tok,0)+coalesce(cache_read,0)+coalesce(cache_write,0) > 0
    OR coalesce(cost,0) <> 0 THEN 1 ELSE 0 END) AS has_usage,
  MAX(CASE WHEN actor IS NOT NULL THEN 1 ELSE 0 END) AS has_actor,
  -- 工具子事件：整组都是 WebSearch 检索行（request/conv 回退键上的账本事实），
  -- 且没有任何一笔带真实会话归属。任一条件不满足都留在列表里：这批行没有
  -- actor/session，一旦混入有归属的行就是真实会话的一部分。
  MIN(CASE WHEN req_kind = 'source:web_search' AND conv_source IN ('request','conv') THEN 1 ELSE 0 END) AS all_tool_search,
  MAX(CASE WHEN session IS NOT NULL THEN 1 ELSE 0 END) AS has_session`;

/** 标题跨组绑定的时间窗：标题生成与线程首请求同一时刻，留一小时容错。 */
const TITLE_BIND_WINDOW_MS = 3_600_000;

/**
 * 标题请求与主会话在**不同 conv_key**：唯一可用的身份是内容指纹。
 *
 * 绑定必须双向唯一——同一指纹只有一条标题请求，且只命中一个会话；任何一边
 * 多命中都返回 NULL，宁可退回用户首句，也不把同一标题挂到两张卡上。
 */
const TITLE_BIND_UNIQUE_SQL = `(
  (SELECT COUNT(*) FROM request t2
   JOIN derive_queue q2t ON q2t.conv_key = t2.conv_key AND q2t.actor = t2.actor
   WHERE t2.user_fingerprint = t.user_fingerprint AND t2.agent = t.agent
     AND t2.conv_key <> request.conv_key
     AND t2.req_kind = 'title' AND t2.purpose_chain = 'exclude'
     AND t2.model_title IS NOT NULL AND t2.purpose_pending = 0
     AND abs(t2.started_ms - t.started_ms) <= ${TITLE_BIND_WINDOW_MS}
     AND ${groupCurrentSql('q2t')}) = 1
  AND
  (SELECT COUNT(DISTINCT m2.conv_key) FROM request m2
   JOIN derive_queue q2m ON q2m.conv_key = m2.conv_key AND q2m.actor = m2.actor
   WHERE m2.user_fingerprint = t.user_fingerprint AND m2.agent = t.agent
     AND m2.conv_key IS NOT NULL AND m2.purpose_chain = 'participate'
     AND m2.purpose_pending = 0
     AND abs(m2.started_ms - t.started_ms) <= ${TITLE_BIND_WINDOW_MS}
     AND ${groupCurrentSql('q2m')}) = 1
)`;

const CROSS_GROUP_TITLE_SQL = `(SELECT t.model_title FROM request t
  CROSS JOIN derive_queue qt ON qt.conv_key = t.conv_key AND qt.actor = t.actor
  WHERE t.user_fingerprint IS NOT NULL
    AND t.req_kind = 'title' AND t.purpose_chain = 'exclude'
    AND t.model_title IS NOT NULL AND t.purpose_pending = 0
    AND ${groupCurrentSql('qt')}
    AND t.conv_key <> request.conv_key
    AND t.agent IN (SELECT ra.agent FROM request ra WHERE ra.conv_key = request.conv_key)
    AND EXISTS (SELECT 1 FROM request m
      JOIN derive_queue qm ON qm.conv_key = m.conv_key AND qm.actor = m.actor
      WHERE m.conv_key = request.conv_key AND m.user_fingerprint = t.user_fingerprint
        AND m.purpose_chain = 'participate' AND m.purpose_pending = 0
        AND ${groupCurrentSql('qm')}
        AND abs(t.started_ms - m.started_ms) <= ${TITLE_BIND_WINDOW_MS})
    AND ${TITLE_BIND_UNIQUE_SQL}
  ORDER BY t.started_ms DESC, t.req_id DESC LIMIT 1)`;
// CROSS JOIN 是 SQLite 里唯一能定死连接次序的内连接写法：t 侧按指纹部分索引
// 驱动（只有非空指纹行，title 行更是少数），qt 走主键回查。默认优化器会选
// qt（全部 current 组）驱动、按组反查 title 行——这个形状的成本是
// O(current 组数) × 页内指纹会话数，随会话表线性退化（2026-11-04 实测
// 1,300 组时每组约 12 ms，4 组在页就是 50 ms）。

/**
 * 跨组绑定的入口闸门：本会话没有任何非空指纹时，绑定注定落空。
 *
 * 没有这道闸门时，相关标量子查询对页内每个会话各求值一次，每次都要从
 * derive_queue 驱动反查全部 current 组请求；全库指纹为空时纯属空转。
 * `EXISTS` 只走 `i_req_session_time` 的单会话区间，成本与会话长度脱钩；
 * 有指纹的会话仍走完整绑定逻辑（唯一命中才绑，零命中/多命中不绑）。
 */
const HAS_USER_FINGERPRINT_SQL = `EXISTS (SELECT 1 FROM request x
  WHERE x.conv_key = request.conv_key AND x.user_fingerprint IS NOT NULL)`;

/**
 * 会话标题只取已经结算的当前结果：排除用途提供模型标题，参与链提供用户标题。
 *
 * 四个候选都要求请求用途已判定且所属组已完成；dirty 组或待判定用途的旧标题
 * 不是当前结论，不能拿来命名会话。用户标题不再按 `req_kind='chat'` 过滤：
 * 未知来源类别只要参与链，就可以提供用户首句。
 *
 * 跨组绑定标题插在同会话模型标题之后、用户标题之前：标题请求本身仍是
 * bypass 卡，主会话只是在读侧借用它已经算出的模型标题。
 */
const SESSION_TITLE_SQL = `COALESCE(
  (SELECT r1.model_title FROM request r1
   JOIN derive_queue q1 ON q1.conv_key = r1.conv_key AND q1.actor = r1.actor
   WHERE r1.conv_key = request.conv_key AND r1.purpose_chain = 'exclude'
     AND r1.model_title IS NOT NULL AND r1.purpose_pending = 0
     AND ${groupCurrentSql('q1')}
   ORDER BY r1.started_ms DESC, r1.req_id DESC LIMIT 1),
  CASE WHEN ${HAS_USER_FINGERPRINT_SQL} THEN ${CROSS_GROUP_TITLE_SQL} END,
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

/**
 * 组当前性闸门：整组没有任何 current 组时，四个候选都必然落空。
 *
 * 每个候选都要求所属组 current，而组按 `conv_key` 聚合；脏组与前缀组因此
 * 一个标题也取不到。没有这道闸门时，子查询要扫完该会话全部请求才能证明
 * 「没有」——活跃会话恰恰常是 dirty，列表成本随会话变长线性增长。
 * `EXISTS` 只走 `derive_queue` 主键（每组一行），成本与会话长度脱钩。
 *
 * 多 actor 会话只要有一个 clean 组，闸门就放行，dirty actor 的行仍被扫描；
 * 标题结果不变，只是省不掉这部分成本。
 */
const SESSION_TITLE_GUARD_SQL = `EXISTS (SELECT 1 FROM derive_queue g
  WHERE g.conv_key = request.conv_key AND ${groupCurrentSql('g')})`;

export function listSessions(
  store: Store,
  limit = 50,
  cursor: string | null = null,
  live: SessionLive | null = null,
): Page<SessionRow> {
  const size = checkLimit(limit, 100);
  const bound = cursor === null
    ? null
    : decodeCursor(cursor, value => {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const [lastMs, convKey] = value;
      if (typeof lastMs !== 'number' || !Number.isFinite(lastMs) || typeof convKey !== 'string') return null;
      return { lastMs, convKey };
    });
  // 两个阶段在同一个只读事务里完成：阶段一沿 `i_req_session_time` 覆盖索引只取
  // 会话键与真实最近请求时间，排序取 `limit + 1` 个候选，多取的一条只用于判断
  // next_cursor；游标条件应用在分组之后，首页因此不带 HAVING。阶段二只对页内
  // 会话做标题、计数与标志的宽聚合，页外会话不参与任何宽字段计算，列表读取
  // 不触碰正文。WAL 快照由阶段一首读固定：采集在两阶段之间提交，本页的排序
  // 依据与内容仍来自同一旧快照，下一次调用才可见新会话。
  const { candidates, detail } = store.read.transaction(() => {
    const rows = (bound === null
      ? store.read.query<SessionCandidateRow, [number]>(`
          SELECT conv_key, MAX(started_ms) AS last_ms
          FROM request
          WHERE conv_key IS NOT NULL
          GROUP BY conv_key
          ORDER BY last_ms DESC, conv_key DESC
          LIMIT ?`).all(size + 1)
      : store.read.query<SessionCandidateRow, [number, string, number]>(`
          SELECT conv_key, MAX(started_ms) AS last_ms
          FROM request
          WHERE conv_key IS NOT NULL
          GROUP BY conv_key
          HAVING (MAX(started_ms), conv_key) < (?, ?)
          ORDER BY last_ms DESC, conv_key DESC
          LIMIT ?`).all(bound.lastMs, bound.convKey, size + 1)) as SessionCandidateRow[];
    if (rows.length === 0) return { candidates: rows, detail: [] as SessionDbRow[] };
    const pageKeys = rows.slice(0, size).map(row => row.conv_key);
    const detail = store.read.query<SessionDbRow, string[]>(`
        SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
               CASE WHEN ${SESSION_TITLE_GUARD_SQL} THEN ${SESSION_TITLE_SQL} END AS title,
               -- 同旧查询：agents 是 magpie 的客户端标签，不是 actor 身份。
               GROUP_CONCAT(DISTINCT agent) AS agents,
               SUM(cost) AS cost_usd,
               ${SESSION_FLAG_COLUMNS}
        FROM request
        WHERE conv_key IN (${pageKeys.map(() => '?').join(',')})
        GROUP BY conv_key`).all(...pageKeys) as SessionDbRow[];
    return { candidates: rows, detail };
  }).deferred();

  const page = candidates.slice(0, size);
  const byKey = new Map(detail.map(row => [row.conv_key, row]));
  const items: SessionRow[] = page.map(candidate => {
    const row = byKey.get(candidate.conv_key);
    if (row === undefined) throw new Error('session_page_row_missing');
    return toSessionRow(row, live);
  });
  const last = page[page.length - 1];
  const nextCursor = candidates.length > size && last !== undefined
    ? encodeCursor([last.last_ms, last.conv_key])
    : null;
  return { items, next_cursor: nextCursor };
}

export type TitleBindingStatus = 'bound' | 'ambiguous' | 'unbound';

export type TitleBinding = {
  status: TitleBindingStatus;
  title: string | null;
  /** 同一指纹命中几条标题请求；`>1` 是歧义来源。 */
  title_matches: number;
  /** 同一指纹命中几个会话；`>1` 是另一侧歧义。 */
  session_matches: number;
};

/**
 * 跨组标题绑定的可观测信号：列表只显示 `bound` 的结果，零命中与多命中都
 * 保持未绑定。这里把两侧候选数一起返回，便于排查“为什么这张卡没有模型标题”。
 */
export function titleBindingOf(store: Store, convKey: string): TitleBinding {
  const row = store.read.query<{
    title: string | null; title_matches: number; session_matches: number;
  }, [string, string, string, string]>(`
    SELECT t.model_title AS title,
      (SELECT COUNT(*) FROM request t2
       JOIN derive_queue q2t ON q2t.conv_key = t2.conv_key AND q2t.actor = t2.actor
       WHERE t2.user_fingerprint = t.user_fingerprint AND t2.agent = t.agent
         AND t2.conv_key <> ? AND t2.req_kind = 'title' AND t2.purpose_chain = 'exclude'
         AND t2.model_title IS NOT NULL AND t2.purpose_pending = 0
         AND abs(t2.started_ms - t.started_ms) <= ${TITLE_BIND_WINDOW_MS}
         AND ${groupCurrentSql('q2t')}) AS title_matches,
      (SELECT COUNT(DISTINCT m2.conv_key) FROM request m2
       JOIN derive_queue q2m ON q2m.conv_key = m2.conv_key AND q2m.actor = m2.actor
       WHERE m2.user_fingerprint = t.user_fingerprint AND m2.agent = t.agent
         AND m2.conv_key IS NOT NULL AND m2.purpose_chain = 'participate'
         AND m2.purpose_pending = 0 AND abs(m2.started_ms - t.started_ms) <= ${TITLE_BIND_WINDOW_MS}
         AND ${groupCurrentSql('q2m')}) AS session_matches
    FROM request t
    JOIN derive_queue qt ON qt.conv_key = t.conv_key AND qt.actor = t.actor
    WHERE t.user_fingerprint IS NOT NULL AND t.req_kind = 'title'
      AND t.purpose_chain = 'exclude' AND t.model_title IS NOT NULL AND t.purpose_pending = 0
      AND ${groupCurrentSql('qt')}
      AND t.conv_key <> ?
      AND t.agent IN (SELECT ra.agent FROM request ra WHERE ra.conv_key = ?)
      AND EXISTS (SELECT 1 FROM request m
        JOIN derive_queue qm ON qm.conv_key = m.conv_key AND qm.actor = m.actor
        WHERE m.conv_key = ? AND m.user_fingerprint = t.user_fingerprint
          AND m.purpose_chain = 'participate' AND m.purpose_pending = 0
          AND ${groupCurrentSql('qm')}
          AND abs(t.started_ms - m.started_ms) <= ${TITLE_BIND_WINDOW_MS})
    ORDER BY t.started_ms DESC, t.req_id DESC LIMIT 1`).get(convKey, convKey, convKey, convKey);
  if (row === null || row === undefined) {
    return { status: 'unbound', title: null, title_matches: 0, session_matches: 0 };
  }
  const unique = row.title_matches === 1 && row.session_matches === 1;
  return {
    status: unique ? 'bound' : 'ambiguous',
    title: unique ? row.title : null,
    title_matches: row.title_matches,
    session_matches: row.session_matches,
  };
}

function toSessionRow(row: SessionDbRow, live: SessionLive | null): SessionRow {
  const flags: string[] = [];
  if (row.has_failed === 1) flags.push('failed');
  if (row.has_unknown === 1) flags.push('unknown');
  if (row.has_missing === 1) flags.push('missing_body');
  // 全员 exclude 的会话是旁路（标题生成、skill 描述压缩）：列表默认折叠由
  // 渲染层做，这里只给事实标志。任一笔参与链请求都不折叠，错藏真会话的
  // 代价远高于多显示一条噪音。
  if (row.has_participate === 0) flags.push('bypass');
  // 后台组（Codex ambient/memory）：没有已识别的主用途时折到后台，成本仍在
  // 汇总里；一旦出现主链请求就解除，避免把真实会话藏起来。
  if (row.has_background === 1 && row.has_recognized_main === 0) flags.push('background');
  // 探针组是 magpie 自己的探测请求，不是对话：没有正文可读，没有用量，也没有
  // 会话归属。四个条件全满足才折叠，判定依据留在读模型里，渲染层只认标志。
  if (row.all_probe_kind === 1 && row.has_readable_body === 0
    && row.has_usage === 0 && row.has_actor === 0) flags.push('probe');
  // 工具子事件是 Harness 工具执行的账本记录（WebSearch 检索），不是会话：
  // 默认折叠由渲染层做，折叠条带这批成本合计，行与成本都不删除。
  if (row.all_tool_search === 1 && row.has_session === 0) flags.push('tool_event');
  const base = {
    conv_key: row.conv_key,
    title: row.title ?? '',
    last_ms: row.last_ms,
    request_count: row.request_count,
    agents: row.agents === null ? [] : row.agents.split(',').filter(value => value.length > 0),
    flags,
    cost_usd: row.cost_usd ?? 0,
  };
  if (live === null) return base;
  // 活跃集合由读模型判定：在途请求，或最近 60 秒内有更新。60 秒只看本行已有的
  // last_ms，不再查库；在途状态来自摄入回调维护的内存态。
  const inflight = live.inflight(row.conv_key);
  const recent = live.now - row.last_ms <= LIVE_WINDOW_MS;
  return {
    ...base,
    live: inflight || recent,
    inflight,
    live_until: recent ? row.last_ms + LIVE_WINDOW_MS : null,
  };
}
