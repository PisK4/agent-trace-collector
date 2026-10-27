/** 路由解释：route_summary 的安全读取、尝试链投影与按请求取路由。 */

import { zstdDecompressSync } from 'node:zlib';
import { resolveRequestId, type Store } from '../store';
import { finite, isRecord, parseJsonOrNull, stringOrNull } from './projection';

/** prompt item 的白名单标量：名字、身份 tag、聚合数与 token；不透出正文。 */
export type PromptItem = {
  name: string;
  tag: string | null;
  n: number | null;
  tokens: number;
};

export type RoutePromptPart = {
  kind: string;
  tokens: number;
  items?: PromptItem[];
};

export type RoutePrompt = {
  tokens: number;
  counted: boolean;
  window: number | null;
  held: boolean | null;
  turns: number | null;
  parts: RoutePromptPart[];
};

export type RouteColumns = {
  route_id: number;
  time_ms: number;
  model: string | null;
  served: string | null;
  provider: string | null;
  status: number | null;
  ms: number | null;
  ttft: number | null;
  flow: number | null;
  first_text: number | null;
  order_json: string | null;
  tries_json: string | null;
  affinity_json: string | null;
};

export type AttemptItem = {
  index: number;
  model: string | null;
  effort: string | null;
  status: number | null;
  fail: string | null;
  error: string | null;
  start_ms: number | null;
  ms: number | null;
  ttft_ms: number | null;
  flow_ms: number | null;
  first_text_ms: number | null;
  first_reasoning_ms: number | null;
  served: string | null;
  done: boolean | null;
  tier_served: string | null;
  reasoning_hidden: boolean | null;
};

export type AttemptChain = {
  state: 'present' | 'empty' | 'unavailable';
  items: AttemptItem[];
  timing: { state: 'recorded' | 'partial' | 'absent'; note: string };
};

export type RouteSummaryReading = {
  format: 1 | 2;
  route_id: number;
  time_ms: number;
  model: string | null;
  served: string | null;
  provider: string | null;
  status: number | null;
  ms: number | null;
  ttft: number | null;
  flow: number | null;
  first_text: number | null;
  kind: string | null;
  folder: string | null;
  effort: string | null;
  prompt: RoutePrompt | null;
  error: string | null;
  order: Record<string, unknown>[];
  attempts: AttemptChain;
  affinity: Record<string, unknown> | null;
};

function simpleValue(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null) return null;
  return undefined;
}

function safeOrder(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const picked: Record<string, unknown> = {};
    for (const key of ['provider', 'name', 'model', 'kind', 'agent', 'plan', 'used', 'limit', 'unit', 'fast', 'fallback', 'shared']) {
      const scalar = simpleValue(item[key]);
      if (scalar !== undefined) picked[key] = scalar;
    }
    out.push(picked);
  }
  return out;
}

function safeAffinity(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const picked: Record<string, unknown> = {};
  // 上游 affinity 用 camelCase。`last` 是账号/来源身份，永不透出；
  // 蛇形旧键在真实数据里一次也没有出现，不作为后备读法。
  for (const key of ['mode', 'why', 'turn', 'at', 'lastTurn', 'within', 'kept', 'cacheRead', 'cacheWrite']) {
    const scalar = simpleValue(value[key]);
    if (scalar !== undefined) picked[key] = scalar;
  }
  return Object.keys(picked).length === 0 ? null : picked;
}

/**
 * `prompt.parts` 的白名单投影：kind 与 tokens 之外，item 级只挑 name/tag/n/tokens
 * 四个标量，非法项剔除。route_summary 的 `z` 与 request 落列的 `parts_json`
 * 同源同形状，共用这一个读取。
 */
export function safePromptParts(value: unknown): RoutePromptPart[] {
  if (!Array.isArray(value)) return [];
  const parts: RoutePromptPart[] = [];
  for (const part of value) {
    if (!isRecord(part) || typeof part.kind !== 'string') continue;
    const count = finite(part.tokens);
    if (count === null) continue;
    const items: PromptItem[] = [];
    if (Array.isArray(part.items)) {
      for (const item of part.items) {
        if (!isRecord(item) || typeof item.name !== 'string') continue;
        const itemTokens = finite(item.tokens);
        if (itemTokens === null) continue;
        items.push({ name: item.name, tag: stringOrNull(item.tag), n: finite(item.n), tokens: itemTokens });
      }
    }
    parts.push(items.length > 0 ? { kind: part.kind, tokens: count, items } : { kind: part.kind, tokens: count });
  }
  return parts;
}

export function safePrompt(value: unknown): RoutePrompt | null {
  if (!isRecord(value)) return null;
  const tokens = finite(value.tokens);
  if (tokens === null) return null;
  return {
    tokens,
    counted: value.counted === true,
    window: finite(value.window),
    held: typeof value.held === 'boolean' ? value.held : null,
    turns: finite(value.turns),
    parts: safePromptParts(value.parts),
  };
}

function timeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 尝试链的安全投影。
 *
 * 只保留真实存在的白名单字段；未知 `fail` 原样保留，`start_ms` 只从合法的
 * 开始时间解析。缺时间时标 partial 并说明不推算间隔——没有任何相邻差值字段。
 * `id` 是来源身份、`net` 与 `rest` 是嵌套透传对象（`rest.key` 含账号），
 * 都不进入返回对象。
 */
export function attemptChainOf(tries: unknown): AttemptChain {
  if (tries === null || tries === undefined) {
    return { state: 'unavailable', items: [], timing: { state: 'absent', note: '没有尝试数组' } };
  }
  if (!Array.isArray(tries)) {
    return { state: 'unavailable', items: [], timing: { state: 'absent', note: '尝试字段不是数组' } };
  }
  if (tries.length === 0) {
    return { state: 'empty', items: [], timing: { state: 'absent', note: '没有记录尝试' } };
  }
  const items: AttemptItem[] = [];
  for (const [index, entry] of tries.entries()) {
    if (!isRecord(entry)) continue;
    items.push({
      index,
      model: stringOrNull(entry.model),
      effort: stringOrNull(entry.effort),
      status: finite(entry.status),
      fail: stringOrNull(entry.fail),
      error: stringOrNull(entry.error),
      start_ms: timeMs(entry.start),
      ms: finite(entry.ms),
      ttft_ms: finite(entry.ttft),
      flow_ms: finite(entry.flow),
      first_text_ms: finite(entry.firstText),
      first_reasoning_ms: finite(entry.firstReasoning),
      served: stringOrNull(entry.served),
      done: typeof entry.done === 'boolean' ? entry.done : null,
      tier_served: stringOrNull(entry.tierServed),
      reasoning_hidden: typeof entry.reasoningHidden === 'boolean' ? entry.reasoningHidden : null,
    });
  }
  if (items.length === 0) {
    return { state: 'unavailable', items: [], timing: { state: 'absent', note: '尝试项不是对象' } };
  }
  const complete = items.every(item => item.start_ms !== null);
  return {
    state: 'present',
    items,
    timing: {
      state: complete ? 'recorded' : 'partial',
      note: complete ? '时间来自各次尝试的开始时间' : '部分尝试没有开始时间，不推算间隔',
    },
  };
}

/**
 * route summary 的安全读取。
 *
 * 列始终是身份与读数的权威；`z` 只补充 format 2 的展示字段。旧 format 1
 * 不补 kind、folder、effort 与 prompt，order/tries/affinity 仍按旧列或旧 z 读取。
 * account、host 与任意未知键不会进入返回对象。
 */
export function routeSummaryReading(raw: unknown, columns: RouteColumns): RouteSummaryReading {
  const record = isRecord(raw) ? raw : null;
  const format = record?.format === 2 ? 2 : 1;
  const tries = record !== null && Array.isArray(record.tries)
    ? record.tries
    : parseJsonOrNull(columns.tries_json);
  const order = record !== null && Array.isArray(record.order)
    ? record.order
    : parseJsonOrNull(columns.order_json);
  const affinity = record !== null && record.affinity !== undefined
    ? record.affinity
    : parseJsonOrNull(columns.affinity_json);
  return {
    format,
    route_id: columns.route_id,
    time_ms: columns.time_ms,
    model: columns.model ?? (typeof record?.model === 'string' ? record.model : null),
    served: columns.served ?? (typeof record?.served === 'string' ? record.served : null),
    provider: columns.provider ?? (typeof record?.provider === 'string' ? record.provider : null),
    status: columns.status ?? finite(record?.status),
    ms: columns.ms ?? finite(record?.ms),
    ttft: columns.ttft ?? finite(record?.ttft),
    flow: columns.flow ?? finite(record?.flow),
    first_text: columns.first_text ?? finite(record?.first_text),
    kind: format === 2 && typeof record?.kind === 'string' ? record.kind : null,
    folder: format === 2 && typeof record?.folder === 'string' ? record.folder : null,
    effort: format === 2 && typeof record?.effort === 'string' ? record.effort : null,
    prompt: format === 2 ? safePrompt(record?.prompt) : null,
    error: typeof record?.error === 'string' ? record.error : null,
    order: safeOrder(order),
    attempts: attemptChainOf(tries),
    affinity: safeAffinity(affinity),
  };
}

export function getRoute(store: Store, id: number): { state: 'available' | 'absent' | 'expired'; summary: unknown } {
  const canonical = resolveRequestId(store, id);
  if (canonical === null) return { state: 'absent', summary: null };
  const request = store.read.query<{ route_id: number | null }, [number]>(
    'SELECT route_id FROM request WHERE req_id=?',
  ).get(canonical);
  if (request == null || request.route_id === null) return { state: 'absent', summary: null };
  const summary = store.read.query<RouteColumns & { z: Uint8Array | null }, [number]>(`
    SELECT route_id,time_ms,model,served,provider,status,ms,ttft,flow,first_text,
           order_json,tries_json,affinity_json,z
    FROM route_summary WHERE route_id=?`).get(request.route_id);
  if (summary == null) return { state: 'expired', summary: null };
  let raw: unknown = null;
  if (summary.z !== null) {
    try {
      raw = JSON.parse(zstdDecompressSync(summary.z).toString('utf8'));
    } catch {
      raw = null;
    }
  }
  return { state: 'available', summary: routeSummaryReading(raw, summary) };
}
