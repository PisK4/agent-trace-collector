/**
 * 本地会话来源的历史重复行修复。
 *
 * 适配器早期按模型名等值匹配，跨来源模型写法不同（网关 `group/auto-…`、本地
 * `auto/…`）时同一笔调用会各建一行。匹配规则修好后，已经落库的重复行不会
 * 自动消失：这里按同一套身份规则再找一次 owner，把只有会话证据的源行并入。
 *
 * 只认精确身份（response id、turn ref、四段用量指纹）。弱时间窗
 * （`conv_time_model.v1`）是猜测，不能用于事后改行，只计数不动手。
 */

import type { Database } from 'bun:sqlite';
import type { Store } from '../store';
import { findRequestOwnerTx } from '../owner';
import type { UsageFingerprint } from '../owner';
import { MATCH_BY_CONV_TIME_MODEL } from '../evidence';
import { mergeRequestTx } from '../merge';
import { SESSION_ADAPTERS } from '../sources/session/registry';

type SessionRow = {
  req_id: number;
  source_kind: string;
  response_id_norm: string | null;
  turn_ref: string | null;
  conv_key: string | null;
  agent: string | null;
  started_ms: number;
  model_requested: string | null;
  model_served: string | null;
  in_tok: number | null;
  out_tok: number | null;
  cache_read: number | null;
  cache_write: number | null;
};

export type SessionDedupeReport = {
  scanned: number;
  candidates: number;
  merged: number;
  ambiguous: number;
  /** 只有弱时间窗能配上的行：明确不合并。 */
  weak_only: number;
  /** 目标已带同来源证据：不是这一轮能处理的重复。 */
  already_owned: number;
  by_source: Record<string, number>;
};

type Action = { sourceId: number; targetId: number; sourceKind: string };

function emptyReport(): SessionDedupeReport {
  return {
    scanned: 0, candidates: 0, merged: 0, ambiguous: 0,
    weak_only: 0, already_owned: 0, by_source: {},
  };
}

function usageOf(row: SessionRow): UsageFingerprint | null {
  if (row.in_tok === null || row.out_tok === null
    || row.cache_read === null || row.cache_write === null) return null;
  return {
    input: row.in_tok, output: row.out_tok,
    cacheRead: row.cache_read, cacheWrite: row.cache_write,
  };
}

/**
 * 只有一条会话证据的行才是待修复对象：已经并入 hook/账本证据的行是正式
 * owner，不能再被并走。
 */
function sessionRows(db: Database, kinds: readonly string[]): SessionRow[] {
  const placeholders = kinds.map(() => '?').join(',');
  return db.query<SessionRow, string[]>(`
    SELECT r.req_id,e.source_kind,r.response_id_norm,r.turn_ref,r.conv_key,r.agent,r.started_ms,
      r.model_requested,r.model_served,r.in_tok,r.out_tok,r.cache_read,r.cache_write
    FROM request r
    JOIN request_evidence e ON e.req_id=r.req_id
    WHERE e.source_kind IN (${placeholders})
      AND (SELECT COUNT(*) FROM request_evidence x WHERE x.req_id=r.req_id)=1
    ORDER BY r.req_id`).all(...kinds);
}

function analyze(db: Database): { actions: Action[]; report: SessionDedupeReport } {
  const report = emptyReport();
  const actions: Action[] = [];
  const rows = sessionRows(db, SESSION_ADAPTERS.map(adapter => adapter.evidenceKind));
  report.scanned = rows.length;
  for (const row of rows) {
    const owner = findRequestOwnerTx(db, {
      responseIdNorm: row.response_id_norm,
      turnRef: row.turn_ref,
      convKey: row.conv_key,
      agent: row.agent,
      startedMs: row.started_ms,
      model: row.model_requested ?? row.model_served,
      usage: usageOf(row),
      excludeSourceKind: row.source_kind,
    });
    if (owner.outcome === 'absent') continue;
    if (owner.outcome === 'ambiguous') {
      report.ambiguous += 1;
      continue;
    }
    if (owner.rule === MATCH_BY_CONV_TIME_MODEL) {
      report.weak_only += 1;
      continue;
    }
    if (owner.reqId === null || owner.reqId === row.req_id) continue;
    const owned = db.query<{ req_id: number }, [number, string]>(
      'SELECT req_id FROM request_evidence WHERE req_id=? AND source_kind=?',
    ).get(owner.reqId, row.source_kind);
    if (owned !== null && owned !== undefined) {
      report.already_owned += 1;
      continue;
    }
    report.candidates += 1;
    actions.push({ sourceId: row.req_id, targetId: owner.reqId, sourceKind: row.source_kind });
  }
  return { actions, report };
}

export function previewSessionDedupe(store: Store): SessionDedupeReport {
  return analyze(store.read).report;
}

export function dedupeSessionDuplicates(store: Store, now: number): SessionDedupeReport {
  return store.write(db => {
    const { actions, report } = analyze(db);
    for (const action of actions) {
      mergeRequestTx(db, action.sourceId, action.targetId, now, { fillIdentity: true });
      report.merged += 1;
      report.by_source[action.sourceKind] = (report.by_source[action.sourceKind] ?? 0) + 1;
    }
    return report;
  }, 'session-dedupe');
}
