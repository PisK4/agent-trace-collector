/** 请求列表与详情：窗口分页、单笔详情读取与工具配对行。 */

import { zstdDecompressSync } from 'node:zlib';
import { deriveJoinSql, derivedColSql, groupCurrentSql } from '../derive/state';
import { resolveRequestId, type Store } from '../store';
import { checkLimit, decodeCursor, encodeCursor, QueryInputError, type Page } from './cursor';
import {
  GROUP_READ_COLUMNS, isRecord, parseJsonOrNull, projectRow,
  SUMMARY_ALGO_COL, SUMMARY_BASIS_COL, SUMMARY_STATE_COL,
  type CostState, type HistoricalResult, type ProjectableRow, type RequestRow,
} from './projection';
import {
  derivationOf, projectionMetaReading, promptReadingOf, sourceFactsReading,
  type DerivationReading, type ProjectionMetaReading, type PromptReading, type SourceFactsReading,
} from './readings';

export type ToolCallRow = {
  call_id: string; ord: number; tool_name: string | null;
  result_req: number | null; result_ord: number | null;
  result_path: string | null; state: string;
};

/** 反向配对：本请求承载的结果块指向的调用，owner_req 是发起调用的请求。 */
export type ToolResultIndexRow = ToolCallRow & { owner_req: number };

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
  /** 摘要的实际算法与依据；null 算法表示从未按当前算法算过，null 状态表示当前没有可读来源。 */
  summary_state: string | null;
  summary_algorithm: number | null;
  summary_basis: string | null;
  derive_version: number;
  archive: string | null;
  route_state: string;
  model_provider: string | null;
  source_facts: SourceFactsReading;
  projection_meta: ProjectionMetaReading;
  prompt: PromptReading;
  derivation: DerivationReading;
  tool_calls: ToolCallRow[];
  /** 反向配对索引：与 tool_calls 同源同闸门，非 current 时为空。 */
  tool_results: ToolResultIndexRow[];
  /**
   * 非当前行在这里附上旧的派生结论，标明它不是当前值。
   * 当前行为 null：当前值就在顶层字段里，不需要再抄一份。
   */
  historical: HistoricalResult | null;
};

/** 列表不带摘要版本列：它是详情给 E 用的依据，列表只判断 `derived_state`。 */
const REQUEST_COLUMNS = `r.req_id, r.conv_key, r.actor, r.agent, r.actor_state, r.started_ms,
  ${derivedColSql('g', 'd', 'r', 'title')} AS title,
  ${derivedColSql('g', 'd', 'r', 'title_source')} AS title_source,
  r.status, r.model_requested, r.model_served, r.in_tok, r.out_tok,
  r.cache_read, r.cache_write, r.cost, r.cost_state, r.have,
  r.ms, r.ttft_ms, r.flow_ms, r.body_state, r.miss_reason, r.req_kind,
  ${derivedColSql('g', 'd', 'r', 'chain_role')} AS chain_role,
  r.model_title, r.purpose_status, r.purpose_version, r.purpose_rule, r.purpose_chain,
  ${derivedColSql('g', 'd', 'r', 'input_preview')} AS input_preview,
  ${derivedColSql('g', 'd', 'r', 'input_preview_kind')} AS input_preview_kind,
  ${derivedColSql('g', 'd', 'r', 'reply_preview')} AS reply_preview,
  ${derivedColSql('g', 'd', 'r', 'reply_shape')} AS reply_shape,
  ${derivedColSql('g', 'd', 'r', 'context_event')} AS context_event,
  r.purpose_pending,
  ${SUMMARY_STATE_COL('g', 'd', 'r')} AS summary_state,
  ${SUMMARY_ALGO_COL('g', 'd', 'r')} AS summary_algorithm`;

export type RequestDirection = 'forward' | 'older';

/**
 * 会话内请求分页。forward 从最早页向后追加（默认）；older 无游标取最近窗口，
 * 之后向更早方向翻。返回 items 始终按 (started_ms, req_id) 升序，两个方向
 * 只是比较符与扫描方向不同；older 游标额外绑定会话与方向，禁止与 forward 混用。
 */
export function listRequests(
  store: Store, key: string, limit = 100,
  cursor: string | null = null, direction: RequestDirection = 'forward',
): Page<RequestRow> {
  const size = checkLimit(limit, 200);
  if (direction !== 'forward' && direction !== 'older') throw new QueryInputError('invalid_direction');
  const bound = cursor === null
    ? null
    : direction === 'older'
      ? decodeCursor(cursor, value => {
        if (!Array.isArray(value) || value.length !== 4) return null;
        const [tag, boundKey, startedMs, reqId] = value;
        if (tag !== 'older' || boundKey !== key) return null;
        if (typeof startedMs !== 'number' || !Number.isFinite(startedMs) || !Number.isInteger(startedMs)) return null;
        if (!Number.isSafeInteger(reqId)) return null;
        return { startedMs, reqId };
      })
      : decodeCursor(cursor, value => {
        if (!Array.isArray(value) || value.length !== 2) return null;
        const [startedMs, reqId] = value;
        if (typeof startedMs !== 'number' || !Number.isFinite(startedMs) || !Number.isInteger(reqId)) return null;
        return { startedMs, reqId };
      });
  // 分页与状态判定必须在同一个快照里：分成两次读会把分页时的行与状态时的行混在一起。
  const rows = store.read.transaction(() => {
    if (direction === 'older') {
      return (bound === null
        ? store.read.query<ProjectableRow, [string, number]>(`
            SELECT ${REQUEST_COLUMNS}, ${GROUP_READ_COLUMNS} FROM request r
            ${deriveJoinSql('g', 'd', 'r')}
            WHERE r.conv_key = ?
            ORDER BY r.started_ms DESC, r.req_id DESC
            LIMIT ?`)
          .all(key, size + 1)
        : store.read.query<ProjectableRow, [string, number, number, number]>(`
            SELECT ${REQUEST_COLUMNS}, ${GROUP_READ_COLUMNS} FROM request r
            ${deriveJoinSql('g', 'd', 'r')}
            WHERE r.conv_key = ? AND (r.started_ms, r.req_id) < (?, ?)
            ORDER BY r.started_ms DESC, r.req_id DESC
            LIMIT ?`)
          .all(key, bound.startedMs, bound.reqId, size + 1)) as ProjectableRow[];
    }
    return (bound === null
      ? store.read.query<ProjectableRow, [string, number]>(`
          SELECT ${REQUEST_COLUMNS}, ${GROUP_READ_COLUMNS} FROM request r
          ${deriveJoinSql('g', 'd', 'r')}
          WHERE r.conv_key = ?
          ORDER BY r.started_ms ASC, r.req_id ASC
          LIMIT ?`)
        .all(key, size + 1)
      : store.read.query<ProjectableRow, [string, number, number, number]>(`
          SELECT ${REQUEST_COLUMNS}, ${GROUP_READ_COLUMNS} FROM request r
          ${deriveJoinSql('g', 'd', 'r')}
          WHERE r.conv_key = ? AND (r.started_ms, r.req_id) > (?, ?)
          ORDER BY r.started_ms ASC, r.req_id ASC
          LIMIT ?`)
        .all(key, bound.startedMs, bound.reqId, size + 1)) as ProjectableRow[];
  })() as ProjectableRow[];

  // older 先按 DESC 取页，再反转成正序返回；游标编码本页最早行，下一页严格小于它。
  const page = rows.slice(0, size);
  if (direction === 'older') page.reverse();
  const items = page.map(row => ({
    ...projectRow(row).safe, conv_key: row.conv_key ?? key,
  }));
  const cursorRow = direction === 'older' ? page[0] : page[page.length - 1];
  const nextCursor = rows.length > size && cursorRow !== undefined
    ? direction === 'older'
      ? encodeCursor(['older', key, cursorRow.started_ms, cursorRow.req_id])
      : encodeCursor([cursorRow.started_ms, cursorRow.req_id])
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
  model_provider: string | null;
  source_facts_json: string | null;
  projection_meta_json: string | null;
  route_id: number | null; summary_exists: number | null;
  summary_z: Uint8Array | null;
  derive_source: 'generation' | 'synchronous' | 'unavailable';
  published_generation: string | null;
};

export function getRequest(store: Store, id: number): RequestDetail | null {
  // 行、组状态与工具行必须在同一个只读快照里取：分几次读会得到"行已更新、
  // 工具还是上一批"的混合视图，而 `derived_state` 是这三者共同的判定。
  // alias 解析也放进同一事务，避免 alias 与行跨快照。
  const snapshot = store.read.transaction(() => {
    const canonical = resolveRequestId(store, id);
    if (canonical === null) return null;
    // r.* 之后用同名覆盖派生列：发布代、同步旧列或 NULL 由同一条件整组决定。
    const row = store.read.query<DetailDbRow, [number]>(`
      SELECT r.*, ${GROUP_READ_COLUMNS},
             ${derivedColSql('g', 'd', 'r', 'title')} AS title,
             ${derivedColSql('g', 'd', 'r', 'title_source')} AS title_source,
             ${derivedColSql('g', 'd', 'r', 'input_preview')} AS input_preview,
             ${derivedColSql('g', 'd', 'r', 'input_preview_kind')} AS input_preview_kind,
             ${derivedColSql('g', 'd', 'r', 'reply_preview')} AS reply_preview,
             ${derivedColSql('g', 'd', 'r', 'reply_shape')} AS reply_shape,
             ${derivedColSql('g', 'd', 'r', 'context_event')} AS context_event,
             ${derivedColSql('g', 'd', 'r', 'prev_req_id')} AS prev_req_id,
             ${derivedColSql('g', 'd', 'r', 'prev_relation')} AS prev_relation,
             ${derivedColSql('g', 'd', 'r', 'delta_ordinals')} AS delta_ordinals,
             ${derivedColSql('g', 'd', 'r', 'chain_role')} AS chain_role,
             ${SUMMARY_STATE_COL('g', 'd', 'r')} AS summary_state,
             ${SUMMARY_ALGO_COL('g', 'd', 'r')} AS summary_algorithm,
             ${SUMMARY_BASIS_COL('g', 'd', 'r')} AS summary_basis,
             CASE WHEN g.published_generation IS NOT NULL THEN 'generation'
                  WHEN ${groupCurrentSql('g')} THEN 'synchronous'
                  ELSE 'unavailable' END AS derive_source,
             g.published_generation,
             (SELECT 1 FROM route_summary s WHERE s.route_id = r.route_id) AS summary_exists,
             (SELECT z FROM route_summary s WHERE s.route_id = r.route_id) AS summary_z
      FROM request r ${deriveJoinSql('g', 'd', 'r')} WHERE r.req_id = ?`).get(canonical) as DetailDbRow | null;
    if (row == null) return null;
    // 工具同样按来源整组读取：发布代查代际结果表；发布代缺行或无指针时回退
    // 同步旧表——它仍是调用身份的家。配对是否可信由 current 屏蔽决定。
    const toolCallsFromSync = () => store.read.query<ToolCallRow, [number]>(`
      SELECT call_id, ord, tool_name, result_req, result_ord, result_path, state
      FROM tool_call WHERE req_id = ? ORDER BY ord`).all(canonical);
    let toolCalls: ToolCallRow[] = toolCallsFromSync();
    if (row.published_generation !== null) {
      const generational = store.read.query<ToolCallRow, [string, number]>(`
        SELECT call_id, ord, tool_name, result_req, result_ord, result_path, state
        FROM derive_tool_result WHERE generation = ? AND req_id = ? ORDER BY ord`)
        .all(row.published_generation, canonical);
      if (generational.length > 0) toolCalls = generational;
    }
    // 反向配对与 tool_calls 同源：发布代表先（generation 是无 rowid 主键前缀，代内有界）；
    // 同步回退没有 result_req 索引，用同组请求做 IN 子查询驱动 (req_id, ord) 主键，
    // 候选规模是组内请求数，不全局扫描 tool_call，也顺带排除跨组的脏行。
    const toolResultsFromSync = () => store.read.query<ToolResultIndexRow, [number, string | null, string | null]>(`
      SELECT call_id, ord, tool_name, result_req, result_ord, result_path, state, req_id AS owner_req
      FROM tool_call
      WHERE result_req = ? AND req_id IN (SELECT req_id FROM request WHERE conv_key IS ? AND actor IS ?)
      ORDER BY req_id, ord`).all(canonical, row.conv_key, row.actor);
    let toolResults: ToolResultIndexRow[] = toolResultsFromSync();
    if (row.published_generation !== null) {
      const generationalResults = store.read.query<ToolResultIndexRow, [string, number]>(`
        SELECT call_id, ord, tool_name, result_req, result_ord, result_path, state, req_id AS owner_req
        FROM derive_tool_result WHERE generation = ? AND result_req = ? ORDER BY req_id, ord`)
        .all(row.published_generation, canonical);
      if (generationalResults.length > 0) toolResults = generationalResults;
    }
    return { row, toolCalls, toolResults };
  })();
  if (snapshot === null) return null;
  const { row, toolCalls, toolResults } = snapshot;
  const projected = projectRow(row);
  const current = projected.state === 'current';
  let summaryRaw: unknown = null;
  if (row.summary_z !== null) {
    try {
      summaryRaw = JSON.parse(zstdDecompressSync(row.summary_z).toString('utf8'));
    } catch {
      summaryRaw = null;
    }
  }
  const sourceFacts = sourceFactsReading(parseJsonOrNull(row.source_facts_json));
  const projectionMeta = projectionMetaReading(parseJsonOrNull(row.projection_meta_json));
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
    model_provider: row.model_provider,
    source_facts: sourceFacts,
    projection_meta: projectionMeta,
    prompt: promptReadingOf(
      isRecord(summaryRaw) ? summaryRaw.prompt : null,
      projectionMeta.prompt,
      parseJsonOrNull(row.parts_json),
      row.prompt_tokens,
    ),
    derivation: derivationOf({
      derived_state: projected.state,
      summary_state: row.summary_state,
    }),
    derive_version: row.derive_version,
    archive: row.archive,
    route_state: routeState,
    // 工具候选同样是组结果：非当前时只保留调用身份，结果位置不外露。
    tool_calls: current ? toolCalls : toolCalls.map(call => ({
      ...call, result_req: null, result_ord: null, result_path: null,
      state: 'pending',
    })),
    // 反向索引整条都是组结果：非当前时没有可保留的身份，直接为空。
    tool_results: current ? toolResults : [],
    historical: projected.historical,
  };
}
