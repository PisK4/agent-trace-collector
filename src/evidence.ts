import type { Database } from 'bun:sqlite';

/**
 * 三路证据的登记词汇：have 位义、会话键回退形状与 request_evidence 登记。
 * 位义与会话键形状是派生组身份的一部分，改动等于重判历史；这里只收拢写法，
 * 不新增语义。have 的 1/2/4 定义见 docs/architecture-design.md。
 */

/** 请求行已拿到 hook 正文回调。 */
export const HAVE_BODY = 1;
/** 请求行已关联账本用量。 */
export const HAVE_LEDGER = 2;
/** 请求行已关联路由历史。 */
export const HAVE_ROUTE = 4;

/** 会话归属引用：key 是 JSON 数组形状的组键，source 记录归属来源。 */
export type ConvRef = { key: string; source: string };

/**
 * 会话归属引用：投影确认身份后把组提升到 session。
 */
export function sessionRef(session: string): ConvRef {
  return { key: JSON.stringify(['session', session]), source: 'session' };
}

// 三种回退前缀逐字固定：hook ['hook', id]、账本 ['request', refKey]、
// 路由 ['conv', id]；conv_source 参与归属优先级。统一前缀等于改派生组身份，
// 测试夹具也按同一形状构造组键。

/** hook 阶段只知道会话：有会话用 session，否则回退 hook 自身。 */
export function hookConv(session: string | null, hookId: string): ConvRef {
  return session !== null
    ? sessionRef(session)
    : { key: JSON.stringify(['hook', hookId]), source: 'hook' };
}

/** 账本请求行：有会话用 session，否则回退账本行引用。 */
export function ledgerConv(session: string | null, refKey: string): ConvRef {
  return session !== null
    ? sessionRef(session)
    : { key: JSON.stringify(['request', refKey]), source: 'request' };
}

/** 路由归属：session 优先，其次 conv 文件；两者都缺时该路由不带归属。 */
export function routeConv(session: string | null, conv: string | null): ConvRef | null {
  if (session !== null) return sessionRef(session);
  if (conv !== null) return { key: JSON.stringify(['conv', conv]), source: 'conv' };
  return null;
}

/** hook 证据的匹配规则名：按 response_id_norm 关联账本请求。 */
export const MATCH_BY_RESPONSE_ID = 'response_id_norm.v1';

/**
 * 在调用方现有事务内登记一条来源证据：INSERT OR IGNORE，重复幂等。
 * 不自行开事务；merge_state 取 pending（待关联）或 merged（已落位）。
 */
export function insertEvidenceTx(
  db: Database, reqId: number, sourceKind: string, refKey: string,
  mergeState: 'pending' | 'merged', matchRule: string | null, now: number,
): void {
  db.run(
    'INSERT OR IGNORE INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at) VALUES (?,?,?,?,?,?)',
    [reqId, sourceKind, refKey, mergeState, matchRule, now],
  );
}
