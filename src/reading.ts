import { createHash } from 'node:crypto';
import { getBodyPage } from './protocols';
import type { BodyPage } from './protocols';
import { getRequest } from './queries';
import type { RequestDetail } from './queries';
import { resolveRequestId, type Store } from './store';

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
  reason: string | null;
};

const TOKEN_RE = /^r1-[0-9a-f]{64}$/;
const RESULT_PATH_RE = /^request\.messages\[(\d+)\](?:\.content\[(\d+)\])?$/;

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
  LEFT JOIN derive_queue g ON g.conv_key = r.conv_key AND g.actor = r.actor
  LEFT JOIN derive_request_result d ON d.generation = g.published_generation AND d.req_id = r.req_id
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
    const base = { owner_req: canonical, call_ord: callOrd, reading_token: token };
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
    if (match === null || targetCanonical === null || Number(match[1]) !== pair.result_ord) {
      return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'location_mismatch' };
    }
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
    if (match[2] === undefined) {
      // Chat：目标是 role=tool 的整条消息，tool_call_id 必须匹配。
      if ((message as { role?: unknown }).role !== 'tool'
        || (message as { tool_call_id?: unknown }).tool_call_id !== pair.call_id) {
        return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'call_id_mismatch' };
      }
      return { ...base, state:'available', target:located,
        content:(message as { content?: unknown }).content ?? null, is_error:null, reason:null };
    }
    // Anthropic：目标消息里的第 N 个内容块必须是配对的 tool_result。
    const blocks = (message as { content?: unknown }).content;
    const block = Array.isArray(blocks) ? blocks[Number(match[2])] : undefined;
    if (block === undefined || (block as { type?: unknown }).type !== 'tool_result'
      || (block as { tool_use_id?: unknown }).tool_use_id !== pair.call_id) {
      return { ...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'call_id_mismatch' };
    }
    const flagged = (block as { is_error?: unknown }).is_error;
    return { ...base, state:'available', target:located,
      content:(block as { content?: unknown }).content ?? null,
      is_error: flagged === true ? true : flagged === false ? false : null, reason:null };
  })();
}
