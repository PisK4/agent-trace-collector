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
/** 请求行来自 OTLP span（第四通道）。 */
export const HAVE_OTLP = 8;
/** 请求行来自 droid 会话文件（第五通道）。 */
export const HAVE_SESSION = 16;

/** 会话归属引用：key 是 JSON 数组形状的组键，source 记录归属来源。 */
export type ConvRef = { key: string; source: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 会话 id 的前缀归一口径：本地库与网关对同一个会话可能写 `session_`/`sess_`
 * 前缀或裸 UUID。只剥掉可与 UUID 对上的前缀，不认识的前缀原样保留。
 */
export function canonicalSessionId(raw: string): string {
  const value = raw.trim();
  for (const prefix of ['session_', 'sess_']) {
    if (value.startsWith(prefix) && UUID_RE.test(value.slice(prefix.length))) {
      return value.slice(prefix.length);
    }
  }
  return value;
}

/**
 * 会话身份的唯一入口：空串不是会话身份，按缺失处理；非空值按
 * `canonicalSessionId` 去掉能与 UUID 对上的前缀。原始值只在 raw_hook 保留。
 * 账本与路由的映射层在映射时归一，hook envelope 在 `insertHookRequest`
 * 读取时经这里归一，三条入口落在同一个组键上。
 */
export function sessionIdentity(session: string | null): string | null {
  const identity = session === null ? null : canonicalSessionId(session);
  return identity !== null && identity.length > 0 ? identity : null;
}

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
  const identity = sessionIdentity(session);
  return identity !== null
    ? sessionRef(identity)
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

/**
 * OTLP 归属：组键与 sessionRef 逐字相同（`gen_ai.conversation.id` 与 magpie
 * session 同值空间，撞键是常态），conv_source 单记 `otlp-session` 区分来源。
 * span 没带会话 id 时返回 null——该行不进派生组，只作独立记录可查。
 */
export function otlpConv(session: string | null): ConvRef | null {
  return session === null
    ? null
    : { key: JSON.stringify(['session', session]), source: 'otlp-session' };
}

/** hook 证据的匹配规则名：按 response_id_norm 关联账本请求。 */
export const MATCH_BY_RESPONSE_ID = 'response_id_norm.v1';

/** OTLP span 证据的匹配规则名：物理身份 (trace_id, span_id) 直接落位，不猜关联。 */
export const MATCH_BY_SPAN_IDENTITY = 'trace_span.v1';

/** 同会话 ±60 秒窗口 + 同模型认领：只在唯一命中时使用。 */
export const MATCH_BY_CONV_TIME_MODEL = 'conv_time_model.v1';

/**
 * 同会话 ±2 秒的完成时间对齐：本地只能读到消息落库时刻时，与网关
 * `started_ms + ms` 比较，唯一命中才认领。
 */
export const MATCH_BY_CONV_END = 'conv_end.v1';

/** 同会话 ±2 秒、四段用量逐段相等：本地会话与网关/direct 的去重指纹。 */
export const MATCH_BY_USAGE_FINGERPRINT = 'usage_fingerprint.v1';

/** 统一 owner 查找的零候选结果：独立成行，没有可认领的既有行。 */
export const MATCH_ABSENT = 'match_absent';

/** 统一 owner 查找的多候选结果：不合并，独立成行，留痕供审计。 */
export const MATCH_AMBIGUOUS = 'match_ambiguous';

/** 上游 turn 身份相同：未按 response ID 命中时，hook 证据落到 OTLP 占位行。 */
export const MATCH_BY_TURN = 'turn_ref.v1';

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
