import type { Store } from './store';
import { modelTimeTitle } from './sources/magpie';

export type Page<T> = { items: T[]; next_cursor: string | null };
export type CostState = 'priced' | 'zero' | 'unpriced' | 'absent';
export type BodyState = 'pending' | 'available' | 'partial' | 'evicted' | 'unsupported';

/**
 * 这一行现在能不能当"当前结论"读。
 *
 * `current` 是唯一可以当作已确认结果的取值：请求用途已判定、所属组已完成、
 * 完成的修订与算法都还是当前目标。其余三种都不是：
 * `dirty` 表示结果还没追上输入，`retained` 表示正文已回收、摘要按旧值保留，
 * `legacy` 表示从未按当前算法算过。三者在界面上都不该与 `current` 长得一样。
 */
export type DerivedState = 'dirty' | 'current' | 'retained' | 'legacy';

export type RequestRow = {
  req_id: number; conv_key: string; actor: string | null;
  /** magpie 给的客户端标签（claude / omp 等）；与 actor（会话/子代理身份）不是一回事。 */
  agent: string | null;
  actor_state: 'known' | 'unknown'; started_ms: number;
  title: string; title_source: string | null; status: number | null; model_requested: string | null;
  model_served: string | null; in_tok: number | null; out_tok: number | null;
  cache_read: number | null; cache_write: number | null;
  cost: number | null; cost_state: CostState; have: number;
  ms: number | null; ttft_ms: number | null; flow_ms: number | null;
  body_state: BodyState; miss_reason: string | null;
  /** 折叠行摘要：派生时写入，不读正文块。kind 说明摘要来自新增还是末轮输入。 */
  input_preview: string | null;
  input_preview_kind: 'delta' | 'tail' | 'tool_result' | 'title' | null;
  reply_preview: string | null;
  /** chat 是正常对话请求；title 是 harness 的 Title Generator 请求。 */
  req_kind: 'chat' | 'title';
  /** main 主链、branch 次链、aux 辅助请求（标题生成）；unknown 表示组未完成，角色不可确认。 */
  chain_role: 'main' | 'branch' | 'aux' | 'unknown';
  derived_state: DerivedState;
};

export type SessionRow = {
  conv_key: string; title: string; last_ms: number; request_count: number;
  agents: string[]; flags: string[];
};

export type ToolCallRow = {
  call_id: string; ord: number; tool_name: string | null;
  result_req: number | null; result_ord: number | null;
  result_path: string | null; state: string;
};

export type RequestDetail = RequestRow & {
  prev_req_id: number | null;
  prev_relation: 'confirmed' | 'unknown' | 'first' | 'branch' | 'aux' | null;
  delta_ordinals: number[] | null;
  parse_state: string | null;
  reply_state: string | null;
  ms: number | null;
  ttft_ms: number | null;
  flow_ms: number | null;
  first_text_ms: number | null;
  reasoning: number | null;
  prompt_tokens: number | null;
  prompt_counted: number | null;
  prompt_window: number | null;
  prompt_turns: number | null;
  parts: unknown;
  attempt_count: number | null;
  attempt_billed: number | null;
  attempt_in: number | null;
  attempt_out: number | null;
  attempt_cache_read: number | null;
  attempt_cache_write: number | null;
  attempt_reasoning: number | null;
  attempt_cost: number | null;
  attempt_cost_state: CostState;
  title_source: string;
  /** 摘要的实际算法与依据；null 算法表示从未按当前算法算过。 */
  summary_state: string;
  summary_algorithm: number | null;
  summary_basis: string | null;
  derive_version: number;
  archive: string | null;
  route_state: string;
  tool_calls: ToolCallRow[];
  /**
   * 非当前行在这里附上旧的派生结论，标明它不是当前值。
   * 当前行为 null：当前值就在顶层字段里，不需要再抄一份。
   */
  historical: HistoricalResult | null;
};

/** 旧派生结论的只读副本；读它的人要自己承担"这不是当前值"。 */
export type HistoricalResult = {
  derived_state: DerivedState;
  title: string | null;
  title_source: string | null;
  input_preview: string | null;
  input_preview_kind: string | null;
  prev_req_id: number | null;
  prev_relation: string | null;
  delta_ordinals: number[] | null;
  chain_role: string | null;
};

export class QueryInputError extends Error {}

function encodeCursor(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string, check: (value: unknown) => T | null): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new QueryInputError('invalid_cursor');
  }
  const checked = check(parsed);
  if (checked === null) throw new QueryInputError('invalid_cursor');
  return checked;
}

function checkLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new QueryInputError('invalid_limit');
  return limit;
}

type SessionDbRow = {
  conv_key: string; last_ms: number; request_count: number; title: string | null; agents: string | null;
};

/**
 * 会话标题：Title Generator 的正式标题优先，同一会话多次生成取最新一次；
 * 没有正式标题才退到主链上最早的用户首句，最后才是任意一笔的兜底标题。
 */
const SESSION_TITLE_SQL = `COALESCE(
  (SELECT r1.model_title FROM request r1
   WHERE r1.conv_key = request.conv_key AND r1.req_kind = 'title'
     AND r1.model_title IS NOT NULL
   ORDER BY r1.started_ms DESC, r1.req_id DESC LIMIT 1),
  (SELECT r2.title FROM request r2
   WHERE r2.conv_key = request.conv_key AND r2.title_source = 'user_delta'
     AND r2.req_kind = 'chat' AND r2.chain_role = 'main' AND r2.title IS NOT NULL
   ORDER BY r2.started_ms ASC, r2.req_id ASC LIMIT 1),
  (SELECT r3.title FROM request r3
   WHERE r3.conv_key = request.conv_key AND r3.title_source = 'user_delta'
     AND r3.req_kind = 'chat' AND r3.title IS NOT NULL
   ORDER BY r3.started_ms ASC, r3.req_id ASC LIMIT 1),
  (SELECT r4.title FROM request r4
   WHERE r4.conv_key = request.conv_key AND r4.req_kind = 'chat' AND r4.title IS NOT NULL
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
               GROUP_CONCAT(DISTINCT agent) AS agents
        FROM request
        WHERE conv_key IS NOT NULL
        GROUP BY conv_key
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`)
      .all(size + 1)
    : store.read.query<SessionDbRow, [number, string, number]>(`
        SELECT conv_key, last_ms, request_count, title, agents FROM (
          SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
                 ${SESSION_TITLE_SQL} AS title,
                 -- 同首查：agents 是 magpie 的客户端标签，不是 actor 身份。
                 GROUP_CONCAT(DISTINCT agent) AS agents
          FROM request
          WHERE conv_key IS NOT NULL
          GROUP BY conv_key
        ) GROUPED
        WHERE (last_ms, conv_key) < (?, ?)
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`)
      .all(bound.lastMs, bound.convKey, size + 1)) as SessionDbRow[];

  const page = rows.slice(0, size);
  const items: SessionRow[] = page.map(row => ({
    conv_key: row.conv_key,
    title: row.title ?? '',
    last_ms: row.last_ms,
    request_count: row.request_count,
    agents: row.agents === null ? [] : row.agents.split(',').filter(value => value.length > 0),
    flags: [],
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > size && last !== undefined
    ? encodeCursor([last.last_ms, last.conv_key])
    : null;
  return { items, next_cursor: nextCursor };
}

/**
 * 一行的派生状态。只有 `current` 能当已确认结论读。
 *
 * 组状态由 `LEFT JOIN derive_queue` 一起取出：请求的用途、组完成的修订与算法
 * 三者任一没追上，这一行就还是 dirty。未知归属的请求没有组可加入，
 * `group_state` 为 null，同样只能是 dirty——它没有可确认的关系。
 */
export function derivedStateOf(row: {
  purpose_pending: number; summary_state: string;
  summary_algorithm: number | null; group_state: string | null;
  group_input: number | null; group_published: number | null;
  target_algorithm: number | null; published_algorithm: number | null;
}): DerivedState {
  if (row.purpose_pending !== 0 || row.group_state !== 'clean'
    || row.group_input !== row.group_published
    || row.target_algorithm !== row.published_algorithm) return 'dirty';
  if (row.summary_state === 'retained') return 'retained';
  if (row.summary_algorithm === null) return 'legacy';
  return 'current';
}

/**
 * 读模型的行投影：当前值放顶层，非当前值挪到 `historical`。
 *
 * 关系、增量、链角色与折叠行摘要都是组的产物：组没算完时它们描述的是上一次
 * 完成时的输入，不是现在的。留在顶层就等于把它们当作当前结论返回。
 * 独立事实（耗时、费用、正文、模型、时间兜底标题）不受影响，照常返回。
 */
const GROUP_READ_JOIN = 'LEFT JOIN derive_queue g ON g.conv_key=r.conv_key AND g.actor=r.actor';

const GROUP_READ_COLUMNS = `g.state AS group_state,g.input_revision AS group_input,
  g.published_revision AS group_published,g.target_algorithm,g.published_algorithm`;

/** 顶层与 `historical` 之间挪动的派生列；同一份清单两处使用。 */
const DERIVED_COLUMNS = `prev_req_id, prev_relation, delta_ordinals, chain_role,
  title, title_source, input_preview, input_preview_kind`;

type DerivedColumns = {
  prev_req_id: number | null; prev_relation: string | null; delta_ordinals: string | null;
  chain_role: string | null; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
};

type StateColumns = {
  purpose_pending: number; summary_state: string; summary_algorithm: number | null;
  group_state: string | null; group_input: number | null; group_published: number | null;
  target_algorithm: number | null; published_algorithm: number | null;
};

/**
 * 投影能接受的行：SQL 读出来的原始形状。
 *
 * 它与 `RequestRow` 的区别只在"值可能是 null、链角色还没归一化、没有派生状态"，
 * 投影负责把这些变成对外契约。
 */
type ProjectableRow = StateColumns & DerivedColumns & {
  req_id: number; conv_key: string | null; actor: string | null; agent: string | null;
  actor_state: string; started_ms: number; status: number | null;
  model_requested: string | null; model_served: string | null;
  in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null;
  cost: number | null; cost_state: string | null; have: number; body_state: string;
  miss_reason: string | null; reply_preview: string | null;
  req_kind: string | null; model_title: string | null; ms: number | null;
  ttft_ms: number | null; flow_ms: number | null;
};

/** 标题兜底：时间与模型构成的占位标题从不依赖正文，任何状态都能读。 */
function fallbackTitle(modelServed: string | null, startedMs: number): string {
  return modelTimeTitle(modelServed, startedMs);
}

/**
 * 把一行 SQL 结果投影成可返回的请求行。
 *
 * `current` 之外的状态一律把派生列换成中性值：关系 null、链角色 `unknown`、
 * 折叠行摘要 null；标题退到"不依赖正文"的那一档——标题请求用回复里的正式标题，
 * 其余用模型时间占位。这样界面上不会出现"看起来像当前结论"的旧值。
 */
function projectRow(row: ProjectableRow): {
  safe: RequestRow; state: DerivedState; historical: HistoricalResult | null;
} {
  const state = derivedStateOf(row);
  const current = state === 'current';
  // 标题请求的正式标题来自回复，与组结果无关；用途还没判完时才不可信。
  const modelTitleUsable = row.purpose_pending === 0 && row.req_kind === 'title'
    && row.model_title !== null;
  const historical: HistoricalResult | null = current ? null : {
    derived_state: state,
    title: row.title,
    title_source: row.title_source,
    input_preview: row.input_preview,
    input_preview_kind: row.input_preview_kind,
    prev_req_id: row.prev_req_id,
    prev_relation: row.prev_relation,
    delta_ordinals: Array.isArray(parseJsonOrNull(row.delta_ordinals))
      ? parseJsonOrNull(row.delta_ordinals) as number[] : null,
    chain_role: row.chain_role,
  };
  const safe: RequestRow = {
    req_id: row.req_id,
    conv_key: row.conv_key ?? '',
    actor: row.actor,
    agent: row.agent,
    actor_state: row.actor_state === 'known' ? 'known' : 'unknown',
    started_ms: row.started_ms,
    title: current
      ? row.title ?? ''
      : modelTitleUsable ? row.model_title! : fallbackTitle(row.model_served, row.started_ms),
    title_source: current ? row.title_source : modelTitleUsable ? 'model_title' : 'model_time',
    status: row.status,
    model_requested: row.model_requested,
    model_served: row.model_served,
    in_tok: row.in_tok,
    out_tok: row.out_tok,
    cache_read: row.cache_read,
    cache_write: row.cache_write,
    cost: row.cost,
    cost_state: row.cost_state as CostState,
    have: row.have,
    ms: row.ms,
    ttft_ms: row.ttft_ms,
    flow_ms: row.flow_ms,
    body_state: row.body_state as BodyState,
    miss_reason: row.miss_reason,
    input_preview: current ? row.input_preview : null,
    input_preview_kind: current
      ? row.input_preview_kind as RequestRow['input_preview_kind'] : null,
    reply_preview: row.reply_preview,
    req_kind: row.req_kind === 'title' ? 'title' : 'chat',
    chain_role: current
      ? (row.chain_role === 'branch' || row.chain_role === 'aux' ? row.chain_role : 'main')
      : 'unknown',
    derived_state: state,
  };
  return { safe, state, historical };
}

type RequestDbRow = ProjectableRow;

/** 列表不带摘要版本列：它是详情给 E 用的依据，列表只判断 `derived_state`。 */
const REQUEST_COLUMNS = `r.req_id, r.conv_key, r.actor, r.agent, r.actor_state, r.started_ms,
  r.title, r.title_source, r.status, r.model_requested, r.model_served, r.in_tok, r.out_tok,
  r.cache_read, r.cache_write, r.cost, r.cost_state, r.have,
  r.ms, r.ttft_ms, r.flow_ms, r.body_state, r.miss_reason, r.req_kind, r.chain_role,
  r.model_title, r.input_preview, r.input_preview_kind, r.reply_preview,
  r.purpose_pending, r.summary_state, r.summary_algorithm`;

export function listRequests(store: Store, key: string, limit = 100, cursor: string | null = null): Page<RequestRow> {
  const size = checkLimit(limit, 200);
  const bound = cursor === null
    ? null
    : decodeCursor(cursor, value => {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const [startedMs, reqId] = value;
      if (typeof startedMs !== 'number' || !Number.isFinite(startedMs) || !Number.isInteger(reqId)) return null;
      return { startedMs, reqId };
    });
  // 分页与状态判定必须在同一个快照里：分成两次读会把分页时的行与状态时的行混在一起。
  const rows = store.read.transaction(() => (bound === null
    ? store.read.query<RequestDbRow, [string, number]>(`
        SELECT ${REQUEST_COLUMNS}, ${GROUP_READ_COLUMNS} FROM request r
        ${GROUP_READ_JOIN}
        WHERE r.conv_key = ?
        ORDER BY r.started_ms ASC, r.req_id ASC
        LIMIT ?`)
      .all(key, size + 1)
    : store.read.query<RequestDbRow, [string, number, number, number]>(`
        SELECT ${REQUEST_COLUMNS}, ${GROUP_READ_COLUMNS} FROM request r
        ${GROUP_READ_JOIN}
        WHERE r.conv_key = ? AND (r.started_ms, r.req_id) > (?, ?)
        ORDER BY r.started_ms ASC, r.req_id ASC
        LIMIT ?`)
      .all(key, bound.startedMs, bound.reqId, size + 1)))() as RequestDbRow[];

  const page = rows.slice(0, size);
  const items = page.map(row => ({
    ...projectRow(row).safe, conv_key: row.conv_key ?? key,
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > size && last !== undefined
    ? encodeCursor([last.started_ms, last.req_id])
    : null;
  return { items, next_cursor: nextCursor };
}

type DetailDbRow = ProjectableRow & {
  parse_state: string | null; reply_state: string | null;
  first_text_ms: number | null;
  reasoning: number | null; prompt_tokens: number | null; prompt_counted: number | null;
  prompt_window: number | null; prompt_turns: number | null; parts_json: string | null;
  attempt_count: number | null; attempt_billed: number | null; attempt_in: number | null;
  attempt_out: number | null; attempt_cache_read: number | null; attempt_cache_write: number | null;
  attempt_reasoning: number | null; attempt_cost: number | null; attempt_cost_state: string | null;
  derive_version: number; archive: string | null;
  summary_basis: string | null;
  route_id: number | null; summary_exists: number | null;
};

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function resolveRequestId(store: Store, id: number): number | null {
  const seen = new Set<number>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const alias = store.read.query<{ new_id: number }, [number]>(
      'SELECT new_id FROM request_alias WHERE old_id=?',
    ).get(current);
    if (alias != null) {
      current = alias.new_id;
      continue;
    }
    const exists = store.read.query<{ req_id: number }, [number]>(
      'SELECT req_id FROM request WHERE req_id=?',
    ).get(current);
    return exists != null ? current : null;
  }
}

export function getRequest(store: Store, id: number): RequestDetail | null {
  const canonical = resolveRequestId(store, id);
  if (canonical === null) return null;
  // 行、组状态与工具行必须在同一个只读快照里取：分几次读会得到"行已更新、
  // 工具还是上一批"的混合视图，而 `derived_state` 是这三者共同的判定。
  const snapshot = store.read.transaction(() => {
    const row = store.read.query<DetailDbRow, [number]>(`
      SELECT r.*, ${GROUP_READ_COLUMNS},
             (SELECT 1 FROM route_summary s WHERE s.route_id = r.route_id) AS summary_exists
      FROM request r ${GROUP_READ_JOIN} WHERE r.req_id = ?`).get(canonical) as DetailDbRow | null;
    if (row == null) return null;
    const toolCalls = store.read.query<ToolCallRow, [number]>(`
      SELECT call_id, ord, tool_name, result_req, result_ord, result_path, state
      FROM tool_call WHERE req_id = ? ORDER BY ord`).all(canonical);
    return { row, toolCalls };
  })();
  if (snapshot === null) return null;
  const { row, toolCalls } = snapshot;
  const projected = projectRow(row);
  const current = projected.state === 'current';
  const routeState = row.route_id === null
    ? 'absent'
    : row.summary_exists === null ? 'expired' : 'available';
  return {
    ...projected.safe,
    conv_key: row.conv_key ?? '',
    // 关系、增量与工具配对是组的结果：组没算完时它们描述的是上一次的输入。
    prev_req_id: current ? row.prev_req_id : null,
    prev_relation: current ? row.prev_relation as RequestDetail['prev_relation'] : null,
    delta_ordinals: current && Array.isArray(parseJsonOrNull(row.delta_ordinals))
      ? parseJsonOrNull(row.delta_ordinals) as number[] : null,
    parse_state: row.parse_state,
    reply_state: row.reply_state,
    first_text_ms: row.first_text_ms,
    reasoning: row.reasoning,
    prompt_tokens: row.prompt_tokens,
    prompt_counted: row.prompt_counted,
    prompt_window: row.prompt_window,
    prompt_turns: row.prompt_turns,
    parts: parseJsonOrNull(row.parts_json),
    attempt_count: row.attempt_count,
    attempt_billed: row.attempt_billed,
    attempt_in: row.attempt_in,
    attempt_out: row.attempt_out,
    attempt_cache_read: row.attempt_cache_read,
    attempt_cache_write: row.attempt_cache_write,
    attempt_reasoning: row.attempt_reasoning,
    attempt_cost: row.attempt_cost,
    attempt_cost_state: (row.attempt_cost_state ?? 'absent') as CostState,
    title_source: projected.safe.title_source ?? 'model_time',
    summary_state: row.summary_state,
    summary_algorithm: row.summary_algorithm,
    summary_basis: row.summary_basis,
    derive_version: row.derive_version,
    archive: row.archive,
    route_state: routeState,
    // 工具候选同样是组结果：非当前时只保留调用身份，结果位置不外露。
    tool_calls: current ? toolCalls : toolCalls.map(call => ({
      ...call, result_req: null, result_ord: null, result_path: null,
      state: 'pending',
    })),
    historical: projected.historical,
  };
}

export function getRoute(store: Store, id: number): { state: 'available' | 'absent' | 'expired'; summary: unknown } {
  const canonical = resolveRequestId(store, id);
  if (canonical === null) return { state: 'absent', summary: null };
  const request = store.read.query<{ route_id: number | null }, [number]>(
    'SELECT route_id FROM request WHERE req_id=?',
  ).get(canonical);
  if (request == null || request.route_id === null) return { state: 'absent', summary: null };
  const summary = store.read.query<{
    route_id: number; time_ms: number; model: string | null; served: string | null; provider: string | null;
    status: number | null; ms: number | null; ttft: number | null; flow: number | null; first_text: number | null;
    order_json: string | null; tries_json: string | null; affinity_json: string | null;
  }, [number]>(`
    SELECT route_id,time_ms,model,served,provider,status,ms,ttft,flow,first_text,order_json,tries_json,affinity_json
    FROM route_summary WHERE route_id=?`).get(request.route_id);
  if (summary == null) return { state: 'expired', summary: null };
  return {
    state: 'available',
    summary: {
      route_id: summary.route_id,
      time_ms: summary.time_ms,
      model: summary.model,
      served: summary.served,
      provider: summary.provider,
      status: summary.status,
      ms: summary.ms,
      ttft: summary.ttft,
      flow: summary.flow,
      first_text: summary.first_text,
      order: parseJsonOrNull(summary.order_json),
      tries: parseJsonOrNull(summary.tries_json),
      affinity: parseJsonOrNull(summary.affinity_json),
    },
  };
}

export type Stats = {
  cursors: {
    source_kind: string; source_name: string; file_generation: string;
    committed_off: number; observed_off: number; last_ok_ms: number;
  }[];
  issues: { source_kind: string; reason: string; count: number }[];
  gaps: { source_kind: string; source_name: string; state: string; from_off: number; to_off: number }[];
  pending_hooks: number;
  requests: number;
  body_states: { state: string; count: number }[];
  open_gaps: number;
  /** 费用扫描因系统时钟回退停住时的计数与阻塞时点；正常时为 null。 */
  cost_health: unknown;
  probe: unknown;
};

export function getStats(store: Store): Stats {
  const cursors = store.read.query(`
    SELECT source_kind, source_name, file_generation, committed_off, observed_off, last_ok_ms
    FROM source_cursor ORDER BY source_kind, source_name`).all() as Stats['cursors'];
  const issues = store.read.query(`
    SELECT source_kind, reason, COUNT(*) AS count FROM ingest_issue
    GROUP BY source_kind, reason ORDER BY source_kind, reason`).all() as Stats['issues'];
  const gaps = store.read.query(`
    SELECT source_kind, source_name, state, from_off, to_off FROM source_gap
    ORDER BY source_kind, source_name, from_off`).all() as Stats['gaps'];
  const pending = store.read.query('SELECT COUNT(*) AS n FROM pending_hook').get() as { n: number };
  const requests = store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number };
  const bodyStates = store.read.query(`
    SELECT body_state AS state, COUNT(*) AS count FROM request GROUP BY body_state ORDER BY body_state`)
    .all() as Stats['body_states'];
  const openGaps = store.read.query(
    "SELECT COUNT(*) AS n FROM source_gap WHERE state IN ('open','resumable')").get() as { n: number };
  const probe = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['magpie', 'probe']));
  const costHealth = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['cost', 'clock_conflict']));
  return {
    cursors,
    issues,
    gaps,
    pending_hooks: pending.n,
    requests: requests.n,
    body_states: bodyStates,
    open_gaps: openGaps.n,
    cost_health: costHealth == null ? null : parseJsonOrNull(costHealth.value_json),
    probe: probe == null ? null : parseJsonOrNull(probe.value_json),
  };
}
