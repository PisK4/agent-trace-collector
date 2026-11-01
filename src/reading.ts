import { createHash } from 'node:crypto';
import { appendMessages, bodyRangeError, getBodyPage, preparedPage, prepareBody, SUPPORTED_PROTOCOLS } from './protocols';
import type { BodyPage } from './protocols';
import type { BodyPrep } from './protocols';
import { encodeCursor, decodeCursor } from './queries/cursor';
import { getRequest } from './queries/requests';
import type { RequestDetail } from './queries/requests';
import { deriveJoinSql } from './derive/state';
import { resolveRequestId, type Store } from './store';
import type { BatchItem, BatchPage, RangeInput } from './read-contract';
import type { ReadingBundle } from './read-contract';

/**
 * 阅读身份：一笔请求在某个读取时点的轨迹输入与派生位置指纹。
 *
 * 它只保证「同一个 token 期间，详情、正文与工具结果面对的是同一批派生输入」；
 * 不冻结用量价格，也不是认证凭证。费用更新不换 token，输入修订、组代际、
 * 指针、正文状态与用途身份变化都会换。
 */
export type ReadingDetail = RequestDetail & { reading_token: string };
export type ReadingBody = BodyPage & { req_id: number; reading_token: string };

export class ReadingConflictError extends Error {
  constructor(reason = 'reading_changed') { super(reason); }
}

export type ToolResultReading = {
  owner_req: number;
  call_ord: number;
  reading_token: string;
  state: 'available' | 'pending' | 'ambiguous' | 'unpaired'
    | 'unavailable' | 'invalid_location';
  target: { req_id: number; ord: number; path: string } | null;
  content: unknown;
  is_error: boolean | null;
  /** available 时是精确协议对象：Anthropic 为 tool_result 块，Chat 为整条 role=tool 消息，Responses 为工具结果顶层项。 */
  raw: unknown;
  reason: string | null;
};

const TOKEN_RE = /^r1-[0-9a-f]{64}$/;
/**
 * 结果位置的三种落点：Anthropic 的内容块 `request.messages[N].content[M]`、
 * chat 的整条消息 `request.messages[N]`、Responses 的顶层项 `request.input[N]`。
 * 第二段捕获只对 Anthropic 有意义；键名本身区分协议。
 */
const RESULT_PATH_RE = /^request\.(messages|input)\[(\d+)\](?:\.content\[(\d+)\])?$/;

export function isValidReadingToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

const tokenOf = (identity: readonly unknown[]): string =>
  'r1-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');

// expected 只做严格相等比较；格式校验归 HTTP 层。
const requireReading = (actual: string, expected: string | null): void => {
  if (expected !== null && expected !== actual) throw new ReadingConflictError('reading_changed');
};

type IdentityRow = {
  req_id: number; conv_key: string | null; actor: string | null; actor_state: string;
  input_epoch: string; input_revision: number;
  purpose_pending: number; purpose_revision: number; purpose_target: number; purpose_version: number | null;
  body_state: string; parse_state: string | null; reply_state: string | null; adapter_version: number | null;
  group_epoch: string | null; group_input: number | null; published_revision: number | null;
  group_state: string | null; target_algorithm: number | null; published_algorithm: number | null;
  published_generation: string | null; legacy_snapshot: number | null;
  d_input_epoch: string | null; d_input_revision: number | null; d_purpose_revision: number | null;
  d_algorithm: number | null; d_retention_state: string | null; d_basis_json: string | null;
  summary_state: string | null; summary_algorithm: number | null; summary_basis: string | null;
};

/**
 * 一行读取身份。数组位置固定：组不存在时用固定 null 槽位，不省略位置，
 * 让不同来源的身份不可能碰撞。实际派生来源的算法与保留状态跟在组槽位后：
 * 发布代绑定代际行，同步绑定摘要三列。
 */
function identityOf(row: IdentityRow): string {
  const generational = row.published_generation !== null;
  return tokenOf([
    row.req_id, row.input_epoch, row.input_revision,
    row.conv_key, row.actor, row.actor_state,
    row.purpose_pending, row.purpose_revision, row.purpose_target, row.purpose_version,
    row.body_state, row.parse_state, row.reply_state, row.adapter_version,
    row.group_epoch, row.group_input, row.published_revision, row.group_state,
    row.target_algorithm, row.published_algorithm, row.published_generation, row.legacy_snapshot,
    generational ? row.d_algorithm : row.summary_algorithm,
    generational ? row.d_retention_state : row.summary_state,
    generational ? row.d_basis_json : row.summary_basis,
    generational ? [row.d_input_epoch, row.d_input_revision, row.d_purpose_revision] : null,
  ]);
}

// 身份槽位语义（组不存在时的固定 null 槽、两条取源列并读）在本文件；
// 与行查询共享的 join 形状来自 derive-state，发布代按队列指针取。
const IDENTITY_SQL = `
  SELECT r.req_id, r.conv_key, r.actor, r.actor_state, r.input_epoch, r.input_revision,
         r.purpose_pending, r.purpose_revision, r.purpose_target, r.purpose_version,
         r.body_state, r.parse_state, r.reply_state, r.adapter_version,
         g.group_epoch, g.input_revision AS group_input, g.published_revision,
         g.state AS group_state, g.target_algorithm, g.published_algorithm,
         g.published_generation, g.legacy_snapshot,
         d.input_epoch AS d_input_epoch, d.input_revision AS d_input_revision,
         d.purpose_revision AS d_purpose_revision, d.algorithm AS d_algorithm,
         d.retention_state AS d_retention_state, d.basis_json AS d_basis_json,
         r.summary_state, r.summary_algorithm, r.summary_basis
  FROM request r
  ${deriveJoinSql('g', 'd', 'r')}
  WHERE r.req_id = ?`;

export function getReadingDetail(store: Store, id: number): ReadingDetail | null {
  // alias 解析、身份与详情同在一个只读快照：getRequest 内嵌套事务走保存点。
  return store.read.transaction(() => {
    const canonical = resolveRequestId(store, id);
    if (canonical === null) return null;
    const row = store.read.query<IdentityRow, [number]>(IDENTITY_SQL).get(canonical);
    if (row === null) return null;
    const detail = getRequest(store, canonical);
    return detail === null ? null : { ...detail, reading_token: identityOf(row) };
  })();
}

export function getReadingBody(
  store: Store, id: number, from: number, to: number,
  expected: string | null,
): ReadingBody | null {
  return store.read.transaction(() => {
    const canonical = resolveRequestId(store, id);
    if (canonical === null) return null;
    const row = store.read.query<IdentityRow, [number]>(IDENTITY_SQL).get(canonical);
    if (row === null) return null;
    const token = identityOf(row);
    requireReading(token, expected);
    const page = getBodyPage(store, canonical, from, to);
    return page === null ? null : { ...page, req_id: canonical, reading_token: token };
  })();
}

/**
 * 按调用位置读取工具结果：owner 的调用序号唯一确定一次调用，结果按记录的
 * result_req + result_ord + result_path 精确取一个内容块，不跨请求搜索、
 * 不按名称或时间猜配。resolved 只代表关联已确认，不代表工具成功。
 */
export function getToolResultReading(
  store: Store, ownerId: number, callOrd: number,
  expected: string,
): ToolResultReading | null {
  return store.read.transaction((): ToolResultReading | null => {
    const canonical = resolveRequestId(store, ownerId);
    if (canonical === null) return null;
    const row = store.read.query<IdentityRow, [number]>(IDENTITY_SQL).get(canonical);
    if (row === null) return null;
    const token = identityOf(row);
    requireReading(token, expected);
    const base = { owner_req: canonical, call_ord: callOrd, reading_token: token, raw: null };
    const detail = getRequest(store, canonical);
    if (detail === null) return null;
    const pair = detail.tool_calls.find(call => call.ord === callOrd);
    if (pair === undefined) {
      return { ...base, state:'unpaired', target:null, content:null, is_error:null, reason:'call_not_found' };
    }
    // 组没算完时调用身份在、位置不可信：一律 pending，不外露旧位置。
    if (detail.derivation.chain_state !== 'current') {
      return { ...base, state:'pending', target:null, content:null, is_error:null, reason:'derive_not_current' };
    }
    if (pair.state !== 'resolved' || pair.result_req === null
      || pair.result_ord === null || pair.result_path === null) {
      const state: ToolResultReading['state'] = pair.state === 'ambiguous'
        ? 'ambiguous' : pair.state === 'pending' ? 'pending' : 'unpaired';
      return { ...base, state, target:null, content:null, is_error:null, reason:pair.state };
    }
    const match = RESULT_PATH_RE.exec(pair.result_path);
    const targetCanonical = match === null ? null : resolveRequestId(store, pair.result_req);
    if (match === null || targetCanonical === null || Number(match[2]) !== pair.result_ord) {
      return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'location_mismatch' };
    }
    const locationKey = match[1];
    const blockIndex = match[3];
    const target = store.read.query<{ conv_key: string | null; actor: string | null }, [number]>(
      'SELECT conv_key, actor FROM request WHERE req_id=?').get(targetCanonical);
    if (target === null || target.conv_key !== detail.conv_key || target.actor !== detail.actor) {
      return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'owner_mismatch' };
    }
    const page = getBodyPage(store, targetCanonical, pair.result_ord, pair.result_ord + 1);
    if (page === null || page.state !== 'available' && page.state !== 'partial') {
      return { ...base, state:'unavailable', target:null, content:null, is_error:null, reason:'body_evicted' };
    }
    const message = page.messages.find(item => item.ord === pair.result_ord)?.value;
    if (message === undefined || message === null || typeof message !== 'object') {
      return { ...base, state:'unavailable', target:null, content:null, is_error:null, reason:'message_missing' };
    }
    const located = { req_id: targetCanonical, ord: pair.result_ord, path: pair.result_path };
    if (locationKey === 'input') {
      // Responses：目标是带 call_id 的工具结果顶层项，正文在 output 上。
      const type = (message as { type?: unknown }).type;
      if ((type !== 'function_call_output' && type !== 'custom_tool_call_output')
        || (message as { call_id?: unknown }).call_id !== pair.call_id) {
        return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'call_id_mismatch' };
      }
      return { ...base, state:'available', target:located,
        content:(message as { output?: unknown }).output ?? null, is_error:null,
        raw: message, reason:null };
    }
    if (blockIndex === undefined) {
      // Chat：目标是 role=tool 的整条消息，tool_call_id 必须匹配。
      if ((message as { role?: unknown }).role !== 'tool'
        || (message as { tool_call_id?: unknown }).tool_call_id !== pair.call_id) {
        return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'call_id_mismatch' };
      }
      return { ...base, state:'available', target:located,
        content:(message as { content?: unknown }).content ?? null, is_error:null,
        raw: message, reason:null };
    }
    // Anthropic：目标消息里的第 N 个内容块必须是配对的 tool_result。
    const blocks = (message as { content?: unknown }).content;
    const block = Array.isArray(blocks) ? blocks[Number(blockIndex)] : undefined;
    if (block === undefined || (block as { type?: unknown }).type !== 'tool_result'
      || (block as { tool_use_id?: unknown }).tool_use_id !== pair.call_id) {
      return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'call_id_mismatch' };
    }
    const flagged = (block as { is_error?: unknown }).is_error;
    return { ...base, state: 'available', target: located,
      content:(block as { content?: unknown }).content ?? null,
      raw: block,
      is_error: flagged === true ? true : flagged === false ? false : null, reason:null };
  })();
}
// —— 有界阅读批：一次只读事务内的版本化批量读取 ——

/** 批次预算：单项完成后检查；单项解码不可抢占，超时计入观测不截断当前项。 */
export type BatchBudget = { maxBytes: number; maxMs: number; clock: () => number };

/** 默认预算：HTTP 端固定使用，不接受调用者覆盖；进程内测试可注入。 */
export const READING_BATCH_BUDGET: BatchBudget = {
  maxBytes: 1024 * 1024, maxMs: 20, clock: () => performance.now(),
};

/** 外层 envelope（{items:[],next_index}）的固定字节开销近似。 */
const ENVELOPE_OVERHEAD = 64;

/**
 * 逐项读取一批详情与回复元信息。canonical 别名按旧 id 请求返回折叠后的现身
 * 内容；每项先 canonical 解析再核对所属会话，跨会话一律 not_found 不返回内容。
 * 同批项共享同一只读快照，全部带同一时点的阅读身份。
 */
export function getReadingBatch(
  store: Store, key: string, ids: readonly number[],
  budget: BatchBudget = READING_BATCH_BUDGET,
): BatchPage<ReadingBundle> {
  return store.read.transaction(() => {
    const start = budget.clock();
    const items: BatchItem<ReadingBundle>[] = [];
    let bytes = ENVELOPE_OVERHEAD;
    for (let index = 0; index < ids.length; index += 1) {
      const requested = ids[index]!;
      const bounded = boundAndMeasure(batchBundle(store, key, requested, index), budget);
      bytes += bounded.size;
      items.push(bounded.item);
      // 软预算只在项边界检查：单项解码不可抢占，超时计入观测、不截断当前项。
      if (budget.clock() - start >= budget.maxMs || bytes > budget.maxBytes) break;
    }
    return { items, next_index: items.length < ids.length ? items.length : null };
  })();
}

/**
 * 逐项读取一批正文区间。同一请求的多个区间共享一次准备（状态行、骨架、系统
 * 文本与解压缓存），不跨版本缓存；token 冲突单列 reading_changed，不抛出整批。
 */
export function getReadingRangeBatch(
  store: Store, key: string, ranges: readonly RangeInput[],
  budget: BatchBudget = READING_BATCH_BUDGET,
): BatchPage<BodyPage & { req_id: number; reading_token: string }> {
  return store.read.transaction(() => {
    const start = budget.clock();
    const items: BatchItem<BodyPage & { req_id: number; reading_token: string }>[] = [];
    /** canonical → 共享准备与阅读身份；null 表示请求不存在。 */
    const prepared = new Map<number, { prep: BodyPrep; token: string } | null>();
    let bytes = ENVELOPE_OVERHEAD;
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      const bounded = boundAndMeasure(batchRange(store, key, range, index, prepared), budget);
      bytes += bounded.size;
      items.push(bounded.item);
      if (budget.clock() - start >= budget.maxMs || bytes > budget.maxBytes) break;
    }
    return { items, next_index: items.length < ranges.length ? items.length : null };
  })();
}

/**
 * 逐项结果归一：ok 项序列化超过单项上限时替换为 oversized（内容不返回），
 * 预算仍按原始内容字节计——单项顶爆了本批预算，剩余项留给续读。
 * @returns 归一后的项与测量字节
 */
function boundAndMeasure<T>(
  item: BatchItem<T>, budget: BatchBudget,
): { item: BatchItem<T>; size: number } {
  if (item.state !== 'ok') return { item, size: Buffer.byteLength(JSON.stringify(item)) };
  const size = Buffer.byteLength(JSON.stringify(item));
  if (size > budget.maxBytes) {
    return {
      item: {
        index: item.index, requested_id: item.requested_id,
        state: 'oversized', reason: 'item_too_large',
      },
      size,
    };
  }
  return { item, size };
}

/** 单项详情+元信息：身份与正文同快照；内部异常只返回固定 failed 原因。 */
function batchBundle(
  store: Store, key: string, requested: number, index: number,
): BatchItem<ReadingBundle> {
  const fail = (state: 'not_found' | 'failed', reason: string): BatchItem<ReadingBundle> =>
    ({ index, requested_id: requested, state, reason });
  try {
    const canonical = resolveRequestId(store, requested);
    if (canonical === null) return fail('not_found', 'not_found');
    const row = store.read.query<IdentityRow, [number]>(IDENTITY_SQL).get(canonical);
    if (row === null) return fail('not_found', 'not_found');
    // 先 canonical 解析再核对所属会话：跨会话 id 不返回内容。
    if (row.conv_key !== key) return fail('not_found', 'session_mismatch');
    const detail = getRequest(store, canonical);
    if (detail === null) return fail('not_found', 'not_found');
    const meta = getBodyPage(store, canonical, 0, 0);
    if (meta === null) return fail('not_found', 'not_found');
    const token = identityOf(row);
    return {
      index, requested_id: requested, state: 'ok',
      value: {
        detail: { ...detail, reading_token: token },
        meta: { ...meta, req_id: canonical, reading_token: token },
      },
    };
  } catch {
    return fail('failed', 'read_failed');
  }
}

/** 单项正文区间：token 核对冲突单列 reading_changed；区间规则防御共用 bodyRangeError。 */
function batchRange(
  store: Store, key: string, range: RangeInput, index: number,
  prepared: Map<number, { prep: BodyPrep; token: string } | null>,
): BatchItem<BodyPage & { req_id: number; reading_token: string }> {
  const fail = (state: 'not_found' | 'reading_changed' | 'failed', reason: string):
    BatchItem<BodyPage & { req_id: number; reading_token: string }> =>
    ({ index, requested_id: range.id, state, reason });
  try {
    parseBodyRange(range.from, range.to);
    const canonical = resolveRequestId(store, range.id);
    if (canonical === null) return fail('not_found', 'not_found');
    let entry = prepared.get(canonical);
    if (entry === undefined) {
      const prep = prepareBody(store, canonical);
      entry = prep === null ? null
        : { prep, token: identityOf(store.read.query<IdentityRow, [number]>(IDENTITY_SQL).get(canonical)!) };
      prepared.set(canonical, entry);
    }
    if (entry === null) return fail('not_found', 'not_found');
    if (entry.prep.stateRow.conv_key !== key) return fail('not_found', 'session_mismatch');
    requireReading(entry.token, range.token);
    const page = preparedPage(entry.prep, range.from, range.to);
    appendMessages(store, entry.prep, canonical, page, range.from, range.to);
    return {
      index, requested_id: range.id, state: 'ok',
      value: { ...page, req_id: canonical, reading_token: entry.token },
    };
  } catch (error) {
    if (error instanceof ReadingConflictError) return fail('reading_changed', 'reading_changed');
    return fail('failed', 'read_failed');
  }
}

/** 批内区间防御：与 HTTP 层共用同一条规则（bodyRangeError）。 */
function parseBodyRange(from: number, to: number): void {
  const error = bodyRangeError(from, to);
  if (error !== null) throw new Error(error);
}

// —— 上下文条目目录：点击明细的第一跳 ——

/**
 * 正文对应解释的版本。轮次承载、类别目录与名称核对规则变化时升版；
 * 消费方按版本判断结果的覆盖语义，不跨版本混读目录。
 */
export const CTX_EXPLAIN_VERSION = 2;

/** 一次响应最多返回的目录条目；余下用游标续扫，不在单个 HTTP 请求里铺完。 */
const CONTEXT_ENTRY_MAX = 80;

/** 目录里有定位规则的类别白名单；上游出现的未知类别不在其中。 */
const CONTEXT_KINDS = ['system', 'tools', 'memory', 'files', 'results', 'chat', 'skills'];

export type ContextItemEntry = {
  /**
   * 结果块可能承载在组内其它请求上；条目正文按 req_id + ord 走既有正文分页，
   * 工具结果优先走 `/tools/:ord/result` 的按位置读取。
   */
  req_id: number;
  /** 消息序号；顶层请求字段为 null，不参与游标推进。 */
  ord: number | null;
  /** 正文位置：`request.messages[N]`、`request.messages[N].content[M]` 或 `request.tools[M]`。 */
  path: string;
  /** located=片段已确认；carrier=仅定位到承载块，片段尚未分离。 */
  precision: 'located' | 'carrier';
  tool_name: string | null;
  call_ord: number | null;
  owner_req: number | null;
  role: string | null;
};

export type ContextItemReading = {
  req_id: number;
  reading_token: string;
  explain_version: number;
  kind: string;
  name: string | null;
  tag: string | null;
  /** 正文可读性按事实透传：目录只在正文可读时建立。 */
  state: 'available' | 'partial' | 'pending' | 'evicted' | 'unsupported' | 'summary';
  reason: string | null;
  entries: ContextItemEntry[];
  next_cursor: string | null;
  /** 覆盖边界说明：未分离、未确认对应、回退扫描等，界面原文呈现。 */
  notes: string[];
};

export type ContextItemQuery = {
  kind: string;
  name: string | null;
  tag: string | null;
  cursor: string | null;
};

type ContextDir = {
  entries: ContextItemEntry[];
  /** 本页最后一条的游标位；无更多时为 null。 */
  after: number | null;
  notes: string[];
};

const ROLE_NAMES = ['user', 'assistant', 'system', 'tool'] as const;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 承载块目录：按 request_block.role 取消息序号，不解压正文。 */
function blockDir(
  store: Store, id: number, roles: readonly number[], after: number, notes: string[],
): ContextDir {
  const rows = store.read.query<{ ord: number; role: number }, [number, number, number]>(
    `SELECT ord, role FROM request_block WHERE req_id=? AND role IN (${roles.join(',')})
     AND ord>? ORDER BY ord LIMIT ?`).all(id, after, CONTEXT_ENTRY_MAX + 1);
  const more = rows.length > CONTEXT_ENTRY_MAX;
  const page = more ? rows.slice(0, CONTEXT_ENTRY_MAX) : rows;
  return {
    entries: page.map(row => ({
      req_id: id, ord: row.ord, path: `request.messages[${row.ord}]`,
      precision: 'carrier', tool_name: null, call_ord: null, owner_req: null,
      role: ROLE_NAMES[row.role] ?? 'unknown',
    })),
    after: more ? page[page.length - 1]!.ord : null,
    notes: more ? [...notes, '目录未扫完，用继续位置取余下条目'] : notes,
  };
}

/** 结果块在输入里的完整次序：消息序号，同消息内再按内容块下标。 */
const blockIndexOf = (resultPath: string | null): number => {
  const match = /\.content\[(\d+)\]$/.exec(resultPath ?? '');
  return match === null ? 0 : Number(match[1]);
};

const resultOrder = (a: { result_ord: number | null; result_path: string | null; ord: number },
  b: { result_ord: number | null; result_path: string | null; ord: number }): number =>
  a.result_ord! - b.result_ord!
  || blockIndexOf(a.result_path) - blockIndexOf(b.result_path)
  || a.ord - b.ord;

export function getContextItemReading(
  store: Store, id: number, query: ContextItemQuery, expected: string,
): ContextItemReading | null {
  return store.read.transaction((): ContextItemReading | null => {
    const canonical = resolveRequestId(store, id);
    if (canonical === null) return null;
    const row = store.read.query<IdentityRow, [number]>(IDENTITY_SQL).get(canonical);
    if (row === null) return null;
    const token = identityOf(row);
    requireReading(token, expected);
    const detail = getRequest(store, canonical);
    if (detail === null) return null;
    const head = {
      req_id: canonical, reading_token: token, explain_version: CTX_EXPLAIN_VERSION,
      kind: query.kind, name: query.name, tag: query.tag,
    };
    // 游标绑定请求与类别：跨请求或跨类别复用游标一律 invalid_cursor。
    const after = query.cursor === null ? -1 : decodeCursor(query.cursor, value => {
      if (!Array.isArray(value) || value.length !== 4) return null;
      const [tag, reqId, kind, bound] = value;
      if (tag !== 'ctxitem' || reqId !== canonical || kind !== query.kind) return null;
      if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < -1) return null;
      return bound;
    });
    // 类别白名单先于正文状态：kind 不支持时正文状态与此无关。
    if (!CONTEXT_KINDS.includes(query.kind)) {
      return { ...head, state: 'unsupported', reason: 'unknown_kind',
        entries: [], next_cursor: null,
        notes: ['该类别来自上游分解，本仓还没有它的正文定位规则'] };
    }
    // 正文不可读：目录无从建立，按事实返回缺口，不用空数组冒充完整正文。
    const bodyState = detail.body_state;
    if (bodyState === 'pending' || bodyState === 'evicted'
      || bodyState === 'unsupported' || bodyState === 'summary') {
      return { ...head, state: bodyState, reason: detail.miss_reason ?? bodyState,
        entries: [], next_cursor: null, notes: [] };
    }
    // 骨架一次：协议名与顶层请求字段；承载块目录不依赖它，但状态与 tools 需要。
    const meta = getBodyPage(store, canonical, 0, 0);
    if (meta === null || !SUPPORTED_PROTOCOLS.includes(meta.protocol as never)) {
      return { ...head, state: 'unsupported', reason: 'protocol_unsupported',
        entries: [], next_cursor: null, notes: [] };
    }
    const dir = buildContextDir(store, canonical, detail, meta, query, after);
    return {
      ...head,
      state: bodyState === 'partial' ? 'partial' : 'available',
      reason: null,
      entries: dir.entries,
      next_cursor: dir.after !== null && dir.after > after
        ? encodeCursor(['ctxitem', canonical, query.kind, dir.after]) : null,
      notes: dir.notes,
    };
  })();
}

/** 按类别建立目录；results/files 用配对表列定位，其余用消息角色与骨架字段。 */
function buildContextDir(
  store: Store, id: number, detail: RequestDetail, meta: BodyPage,
  query: ContextItemQuery, after: number,
): ContextDir {
  const notes: string[] = [];
  const fields = isPlainRecord(meta.request_fields) ? meta.request_fields : null;
  switch (query.kind) {
    case 'system': {
      const dir = blockDir(store, id, [2], after, notes);
      if (after === -1) {
        for (const field of ['system', 'instructions'] as const) {
          if (fields !== null && fields[field] !== undefined) {
            dir.entries.unshift({
              req_id: id, ord: null, path: `request.${field}`,
              precision: 'carrier', tool_name: null, call_ord: null, owner_req: null,
              role: 'system',
            });
          }
        }
      }
      dir.notes.push('系统消息可能同时承载记忆与技能内容，未做片段分离');
      return dir;
    }
    case 'tools': {
      const fieldName = fields !== null && Array.isArray(fields.tools) ? 'tools'
        : fields !== null && Array.isArray(fields.functions) ? 'functions' : null;
      const list = fieldName === null ? [] : fields![fieldName] as unknown[];
      const items = list
        .map((item, index) => ({ item, index }))
        .filter(entry => entry.index > after)
        .filter(entry => query.name === null
          || (isPlainRecord(entry.item) && entry.item.name === query.name))
        .slice(0, CONTEXT_ENTRY_MAX + 1);
      const more = items.length > CONTEXT_ENTRY_MAX;
      const entries = (more ? items.slice(0, CONTEXT_ENTRY_MAX) : items).map(entry => ({
        req_id: id, ord: null, path: `request.${fieldName}[${entry.index}]`,
        precision: 'located' as const, tool_name: isPlainRecord(entry.item)
          && typeof entry.item.name === 'string' ? entry.item.name : null,
        call_ord: null, owner_req: null, role: null,
      }));
      return { entries, after: more ? items[CONTEXT_ENTRY_MAX - 1]!.index : null, notes };
    }
    case 'results': {
      // 反向配对表列直接给出结果块位置；零消息块解压。同名工具多行全部保留。
      const paired = detail.tool_results.filter(call => call.result_ord !== null);
      const pairedOrds = new Set(paired.map(call => call.result_ord!));
      const named = paired
        .filter(call => query.name === null || call.tool_name === query.name)
        .filter(call => call.result_ord! > after)
        .sort(resultOrder);
      // 消息级承载块只对 chat/Responses 成立：工具结果是独立消息，role=3 一次
      // 索引查询可列；Anthropic 的结果块藏在 user 消息 content 数组里，消息级
      // 分不出来。配对已确认的序号不重复出条目，承载行只声明消息身份。
      const carrierProtocol = meta.protocol === 'chat' || meta.protocol === 'responses';
      const nameHasPair = query.name !== null && detail.tool_results
        .some(call => call.tool_name === query.name && call.result_ord !== null);
      const carrierOrds = !carrierProtocol || nameHasPair ? [] : store.read
        .query<{ ord: number }, [number, number]>(
          'SELECT ord FROM request_block WHERE req_id=? AND role=3 AND ord>? ORDER BY ord')
        .all(id, after)
        .map(row => row.ord)
        .filter(ord => !pairedOrds.has(ord));
      // 承载行与配对行按消息序号合并后统一分页：乱序追加会让游标推进到承载
      // 行的序号，下一页把高序号的配对行重列一遍。
      const rows = [
        ...named.map(call => ({ ord: call.result_ord!, block: blockIndexOf(call.result_path), call })),
        ...carrierOrds.map(ord => ({ ord, block: 0, call: null })),
      ].sort((a, b) => a.ord - b.ord || a.block - b.block);
      const more = rows.length > CONTEXT_ENTRY_MAX;
      const page = more ? rows.slice(0, CONTEXT_ENTRY_MAX) : rows;
      const entries: ContextItemEntry[] = page.map(row => row.call === null
        ? {
          req_id: id, ord: row.ord, path: `request.messages[${row.ord}]`,
          precision: 'carrier' as const, tool_name: null, call_ord: null, owner_req: null, role: 'tool',
        }
        : {
          req_id: id, ord: row.call.result_ord,
          path: row.call.result_path ?? `request.messages[${row.call.result_ord}]`,
          precision: 'located' as const, tool_name: row.call.tool_name, call_ord: row.call.ord,
          owner_req: row.call.owner_req, role: 'tool',
        });
      if (carrierOrds.length > 0) {
        notes.push('历史结果副本未经配对确认，按消息级承载块列出');
        if (query.name !== null) notes.push('未找到该名称的配对结果，下列为全部承载块');
      }
      if (!carrierProtocol) {
        notes.push('该协议的工具结果块承载在 user 消息内，消息级分不出来，不列承载块');
      }
      return {
        entries,
        after: more ? page[page.length - 1]!.ord : null,
        notes: more ? [...notes, '目录未扫完，用继续位置取余下条目'] : notes,
      };
    }
    case 'files': {
      // 先按扫描进度取页并核对调用参数；单项有对齐行时只列对齐行，
      // 没有对齐行时降级列出全部结果块并说明，不用首项匹配冒充精确对应。
      const rows = detail.tool_results
        .filter(call => call.result_ord !== null && call.result_ord > after)
        .sort(resultOrder);
      const more = rows.length > CONTEXT_ENTRY_MAX;
      const page = more ? rows.slice(0, CONTEXT_ENTRY_MAX) : rows;
      const afterNext = more ? page[page.length - 1]!.result_ord! : null;
      const entries: ContextItemEntry[] = page.map(call => ({
        req_id: id, ord: call.result_ord, path: call.result_path ?? `request.messages[${call.result_ord}]`,
        precision: 'carrier' as const, tool_name: call.tool_name, call_ord: call.ord,
        owner_req: call.owner_req, role: 'tool',
      }));
      annotateFiles(store, page, query.name, entries);
      if (query.name === null) {
        return {
          entries, after: afterNext,
          notes: more ? [...notes, '目录未扫完，用继续位置取余下条目'] : notes,
        };
      }
      const aligned = entries.filter(entry => entry.precision === 'located');
      if (aligned.length > 0) {
        return { entries: aligned, after: afterNext, notes };
      }
      notes.push('未找到调用参数与该名称对应的精确片段，下列为该类全部结果块');
      return {
        entries, after: afterNext,
        notes: more ? [...notes, '目录未扫完，用继续位置取余下条目'] : notes,
      };
    }
    case 'chat': {
      const dir = blockDir(store, id, [0, 1], after, notes);
      dir.notes.push('上游上下文轮次与消息块的成员对应未建立，下列为全部对话承载块');
      return dir;
    }
    case 'memory': {
      const dir = blockDir(store, id, [0], after, notes);
      dir.notes.push('记忆与对话内容可能同一消息块，未做片段分离');
      return dir;
    }
    case 'skills': {
      const dir = blockDir(store, id, [0, 2], after, notes);
      dir.notes.push('技能声明在系统提示或注入块中，未做片段分离');
      return dir;
    }
    default:
      return { entries: [], after: null, notes };
  }
}

/** files 的名称核对：调用参数（Read/Write/Edit 的文件路径）与条目名对齐。 */
function annotateFiles(
  store: Store, calls: readonly { owner_req: number; ord: number }[],
  name: string | null, entries: ContextItemEntry[],
): void {
  const argOf = store.read.query<{ arg_path: string | null; arg_skill: string | null }, [number, number]>(
    'SELECT arg_path, arg_skill FROM tool_call WHERE req_id=? AND ord=?');
  entries.forEach((entry, index) => {
    const call = calls[index];
    if (call === undefined) return;
    const argPath = argOf.get(call.owner_req, call.ord)?.arg_path ?? null;
    if (name === null) {
      entry.precision = argPath !== null ? 'located' : 'carrier';
      return;
    }
    // 条目名与参数路径相等，或条目名落在参数目录之下（上游按目录聚合）。
    const aligned = argPath !== null
      && (argPath === name || name.startsWith(`${argPath}/`) || argPath.startsWith(`${name}/`));
    entry.precision = aligned ? 'located' : 'carrier';
  });
}
