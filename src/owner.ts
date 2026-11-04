/**
 * 统一 owner 查找：新来源写入前先找它认领的既有请求。
 *
 * 依次尝试四条身份线索，只有唯一命中才算认领：
 * 1. `response_id_norm` 精确命中；
 * 2. `turn_ref` 命中（Codex 的 thread turn 身份）；
 * 3. 同 conv_key、同 agent、±2 秒、四段用量逐段相等（本地会话与网关指纹）；
 * 4. 同 conv_key、同 agent、±60 秒时间窗、同模型。
 *
 * 多候选与零候选都不合并：同一会话里相邻的两笔调用不该被时间窗并成一笔，
 * 所以第 4 条只作为跨来源线索，不认领已有同来源证据的行。查找本身不写库，
 * 由调用方按 outcome 决定建行、合并与证据规则名。
 */

import type { Database } from 'bun:sqlite';
import {
  MATCH_BY_CONV_TIME_MODEL, MATCH_BY_RESPONSE_ID, MATCH_BY_TURN, MATCH_BY_USAGE_FINGERPRINT,
} from './evidence';

/** 四段用量指纹；与 session 来源的 SessionUsage 同形，owner 不反向依赖采集层。 */
export type UsageFingerprint = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type RequestOwner = {
  reqId: number | null;
  outcome: 'matched' | 'ambiguous' | 'absent';
  /** 命中或歧义来自哪条规则；零候选为 null。 */
  rule: string | null;
};

export type OwnerQuery = {
  responseIdNorm: string | null;
  turnRef: string | null;
  convKey: string | null;
  agent: string | null;
  startedMs: number;
  endMs?: number | null;
  /** 入站请求声明的模型；与候选的 requested/served 任一相等即可。 */
  model: string | null;
  /** 四段用量；有值才走指纹步骤，缺任一段不猜。 */
  usage?: UsageFingerprint | null;
  /**
   * 入站证据自己的 source_kind。第 3、4 条线索会跳过已有该来源证据的行：
   * 同来源的相邻调用是两笔调用，不是同一笔的重复记录。
   */
  excludeSourceKind: string;
};

const TURN_DEDUPE_WINDOW_MS = 60_000;
const FINGERPRINT_WINDOW_MS = 2_000;
const ABSENT: RequestOwner = { reqId: null, outcome: 'absent', rule: null };

function byResponseId(db: Database, responseIdNorm: string): RequestOwner {
  const rows = db.query<{ req_id: number }, [string]>(`
    SELECT req_id FROM request
    WHERE response_id_norm=? AND via<>'rejected'
    ORDER BY req_id LIMIT 2`,
  ).all(responseIdNorm);
  if (rows.length === 1) return { reqId: rows[0]!.req_id, outcome: 'matched', rule: MATCH_BY_RESPONSE_ID };
  if (rows.length > 1) return { reqId: null, outcome: 'ambiguous', rule: MATCH_BY_RESPONSE_ID };
  return ABSENT;
}

function byTurnRef(
  db: Database,
  turnRef: string,
  agent: string | null,
  excludeSourceKind: string,
): RequestOwner {
  // 同来源证据排除：一个 user turn 里可能有多笔模型调用（工具循环），
  // 它们的 turn_ref 相同。若把它们也当候选，第二笔会认领第一笔并少建一行。
  const rows = agent === null
    ? db.query<{ req_id: number }, [string, string]>(`
        SELECT req_id FROM request
        WHERE turn_ref=? AND via<>'rejected'
          AND NOT EXISTS (
            SELECT 1 FROM request_evidence e WHERE e.req_id=request.req_id AND e.source_kind=?
          )
        ORDER BY req_id LIMIT 2`).all(turnRef, excludeSourceKind)
    : db.query<{ req_id: number }, [string, string, string]>(`
        SELECT req_id FROM request
        WHERE turn_ref=? AND agent=? AND via<>'rejected'
          AND NOT EXISTS (
            SELECT 1 FROM request_evidence e WHERE e.req_id=request.req_id AND e.source_kind=?
          )
        ORDER BY req_id LIMIT 2`)
      .all(turnRef, agent, excludeSourceKind);
  if (rows.length === 1) return { reqId: rows[0]!.req_id, outcome: 'matched', rule: MATCH_BY_TURN };
  if (rows.length > 1) return { reqId: null, outcome: 'ambiguous', rule: MATCH_BY_TURN };
  return ABSENT;
}

/**
 * 四段用量指纹：本地会话先到、网关/direct 后到（或反过来）时，两边对同一笔
 * 调用记下的 token 四元组逐段相等。窗口只有 ±2 秒；候选必须唯一。
 */
function byUsageFingerprint(
  db: Database,
  query: OwnerQuery,
  convKey: string,
  agent: string,
  usage: UsageFingerprint,
): RequestOwner {
  const from = query.startedMs - FINGERPRINT_WINDOW_MS;
  const to = query.startedMs + FINGERPRINT_WINDOW_MS;
  const sql = `
    SELECT r.req_id FROM request r
    WHERE r.conv_key=? AND r.agent=? AND r.started_ms BETWEEN ? AND ?
      AND r.in_tok=? AND r.out_tok=? AND r.cache_read=? AND r.cache_write=?
      AND r.via<>'rejected'
      AND NOT EXISTS (
        SELECT 1 FROM request_evidence e WHERE e.req_id=r.req_id AND e.source_kind=?
      )`;
  const rows = query.model === null
    ? db.query<{ req_id: number }, [string, string, number, number, number, number, number, number, string]>(`
        ${sql}
        ORDER BY r.started_ms, r.req_id LIMIT 2`,
    ).all(convKey, agent, from, to, usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
      query.excludeSourceKind)
    : db.query<{ req_id: number }, [string, string, number, number, number, number, number, number, string, string, string]>(`
        ${sql} AND (r.model_requested=? OR r.model_served=?)
        ORDER BY r.started_ms, r.req_id LIMIT 2`,
    ).all(convKey, agent, from, to, usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
      query.excludeSourceKind, query.model, query.model);
  if (rows.length === 1) {
    return { reqId: rows[0]!.req_id, outcome: 'matched', rule: MATCH_BY_USAGE_FINGERPRINT };
  }
  if (rows.length > 1) {
    return { reqId: null, outcome: 'ambiguous', rule: MATCH_BY_USAGE_FINGERPRINT };
  }
  return ABSENT;
}

function byConvTimeModel(
  db: Database,
  query: OwnerQuery,
  convKey: string,
  agent: string,
  model: string,
): RequestOwner {
  const from = query.startedMs - TURN_DEDUPE_WINDOW_MS;
  const to = (query.endMs ?? query.startedMs) + TURN_DEDUPE_WINDOW_MS;
  const rows = db.query<{ req_id: number }, [string, string, number, number, string, string, string]>(`
    SELECT r.req_id FROM request r
    WHERE r.conv_key=? AND r.agent=? AND r.started_ms BETWEEN ? AND ?
      AND (r.model_requested=? OR r.model_served=?)
      AND r.via<>'rejected'
      AND NOT EXISTS (
        SELECT 1 FROM request_evidence e WHERE e.req_id=r.req_id AND e.source_kind=?
      )
    ORDER BY r.started_ms, r.req_id LIMIT 2`,
  ).all(convKey, agent, from, to, model, model, query.excludeSourceKind);
  if (rows.length === 1) {
    return { reqId: rows[0]!.req_id, outcome: 'matched', rule: MATCH_BY_CONV_TIME_MODEL };
  }
  if (rows.length > 1) {
    return { reqId: null, outcome: 'ambiguous', rule: MATCH_BY_CONV_TIME_MODEL };
  }
  return ABSENT;
}

export function findRequestOwnerTx(db: Database, query: OwnerQuery): RequestOwner {
  if (query.responseIdNorm !== null) {
    const found = byResponseId(db, query.responseIdNorm);
    if (found.outcome !== 'absent') return found;
  }
  if (query.turnRef !== null) {
    const found = byTurnRef(db, query.turnRef, query.agent, query.excludeSourceKind);
    if (found.outcome !== 'absent') return found;
  }
  // 指纹必须先于时间窗：同会话相邻调用在 60 秒窗里常有两个候选，用量相等能把
  // 它们分开；缺任一段用量时不猜。
  if (query.usage !== undefined && query.usage !== null
    && query.convKey !== null && query.agent !== null) {
    const found = byUsageFingerprint(db, query, query.convKey, query.agent, query.usage);
    if (found.outcome !== 'absent') return found;
  }
  // 模型是否相同必须两边都有值才可证；缺模型时不按时间窗猜。
  if (query.convKey === null || query.agent === null || query.model === null) return ABSENT;
  return byConvTimeModel(db, query, query.convKey, query.agent, query.model);
}