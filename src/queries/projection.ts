/** 行投影：SQL 原始行到对外契约的转换，附查询层共用的安全读取原语。 */

import type { BodyState } from '../store';
import { modelTimeTitle } from '../format';
import { groupCurrentSql, groupIsCurrent } from '../derive/state';

export type CostState = 'priced' | 'zero' | 'unpriced' | 'absent';

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
  /** 回复形状位：final 才能当轮次终点；NULL 表示从未判定（升级窗口期）。 */
  reply_shape: 'final' | 'tools' | 'unknown' | null;
  /** 用途阶段写下的请求类别；未知值原样返回，查询不折叠成 chat。 */
  req_kind: string;
  /** main 主链、branch 次链、aux 辅助请求（排除用途）；unknown 表示组未完成，角色不可确认。 */
  chain_role: string;
  /** 正式标题；只有用途阶段写下的值，回复文本不再参与。 */
  model_title: string | null;
  purpose_status: string;
  purpose_version: number | null;
  purpose_rule: string | null;
  purpose_chain: string;
  derived_state: DerivedState;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 一行的派生状态。只有 `current` 能当已确认结论读。
 *
 * 组状态由 `LEFT JOIN derive_queue` 一起取出：请求的用途、组完成的修订与算法
 * 三者任一没追上，这一行就还是 dirty。未知归属的请求没有组可加入，
 * `group_state` 为 null，同样只能是 dirty——它没有可确认的关系。
 */
export function derivedStateOf(row: {
  purpose_pending: number; summary_state: string | null;
  summary_algorithm: number | null; group_state: string | null;
  group_input: number | null; group_published: number | null;
  target_algorithm: number | null; published_algorithm: number | null;
}): DerivedState {
  // 组判据唯一落在 `groupIsCurrent`：这里只做 join 别名到队列列名的映射。
  if (row.purpose_pending !== 0 || !groupIsCurrent({
    state: row.group_state,
    input_revision: row.group_input,
    published_revision: row.group_published,
    target_algorithm: row.target_algorithm,
    published_algorithm: row.published_algorithm,
  })) return 'dirty';
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
export const GROUP_READ_COLUMNS = `g.state AS group_state,g.input_revision AS group_input,
  g.published_revision AS group_published,g.target_algorithm,g.published_algorithm`;

/** 摘要状态与依据：发布代映射 retention/algorithm/basis；组不 current 时置 NULL，让 derived_state 落到非 current。 */
export const SUMMARY_STATE_COL = (g: string, d: string, r: string) => `CASE WHEN ${g}.published_generation IS NOT NULL THEN ${d}.retention_state WHEN ${groupCurrentSql(g)} THEN ${r}.summary_state ELSE NULL END`;
export const SUMMARY_ALGO_COL = (g: string, d: string, r: string) => `CASE WHEN ${g}.published_generation IS NOT NULL THEN CASE WHEN ${d}.retention_state='legacy' THEN NULL ELSE ${d}.algorithm END WHEN ${groupCurrentSql(g)} THEN ${r}.summary_algorithm ELSE NULL END`;
export const SUMMARY_BASIS_COL = (g: string, d: string, r: string) => `CASE WHEN ${g}.published_generation IS NOT NULL THEN ${d}.basis_json WHEN ${groupCurrentSql(g)} THEN ${r}.summary_basis ELSE NULL END`;

type DerivedColumns = {
  prev_req_id: number | null; prev_relation: string | null; delta_ordinals: string | null;
  chain_role: string | null; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
  reply_shape: string | null;
};

type StateColumns = {
  purpose_pending: number; summary_state: string | null; summary_algorithm: number | null;
  group_state: string | null; group_input: number | null; group_published: number | null;
  target_algorithm: number | null; published_algorithm: number | null;
};

/**
 * 投影能接受的行：SQL 读出来的原始形状。
 *
 * 它与 `RequestRow` 的区别只在"值可能是 null、链角色还没归一化、没有派生状态"，
 * 投影负责把这些变成对外契约。
 */
export type ProjectableRow = StateColumns & DerivedColumns & {
  req_id: number; conv_key: string | null; actor: string | null; agent: string | null;
  actor_state: string; started_ms: number; status: number | null;
  model_requested: string | null; model_served: string | null;
  in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null;
  cost: number | null; cost_state: string | null; have: number; body_state: string;
  miss_reason: string | null; reply_preview: string | null;
  req_kind: string | null; model_title: string | null; ms: number | null;
  purpose_status: string; purpose_version: number | null; purpose_rule: string | null;
  purpose_chain: string;
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
export function projectRow(row: ProjectableRow): {
  safe: RequestRow; state: DerivedState; historical: HistoricalResult | null;
} {
  const state = derivedStateOf(row);
  const current = state === 'current';
  // 标题请求的正式标题来自用途列，与组结果无关；用途还没判完时才不可信。
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
    reply_shape: current ? row.reply_shape as RequestRow['reply_shape'] : null,
    req_kind: row.req_kind ?? 'unknown',
    chain_role: current ? (row.chain_role ?? 'unknown') : 'unknown',
    model_title: row.model_title,
    purpose_status: row.purpose_status,
    purpose_version: row.purpose_version,
    purpose_rule: row.purpose_rule,
    purpose_chain: row.purpose_chain,
    derived_state: state,
  };
  return { safe, state, historical };
}
