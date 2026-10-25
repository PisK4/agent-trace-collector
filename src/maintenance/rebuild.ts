/** 单会话重建：显式升级用途目标、整链重排与排空，拼出 CLI 报告字段。 */

import { GROUP_ALGORITHM, queuePendingSql } from '../derive-state';
import { rebuildDerived } from '../derive';
import { drainDeriveEntry } from '../derive-unit';
import { upgradePurposeTargetTx } from '../request-purpose';
import type { Store } from '../store';

/** CLI rebuild 命令的 JSON 字段；`session` 由 CLI 层补上。 */
export type RebuildSessionReport = {
  queued: number;
  unavailable: number;
  reasons: Record<string, number>;
  derive_version: number;
  queue_remaining: number;
  purpose_remaining: number;
  purpose_processed: number;
  purpose_upgraded: number;
  recomputed_requests: number;
  retained_requests: number;
  target_algorithm: number;
  actual_algorithms: Record<string, number>;
  legacy_requests: number;
  pending_groups: number;
};

/**
 * 显式重建一个会话：先升级历史用途目标，再整链重排，最后只排空目标会话。
 *
 * 这是唯一升级历史用途目标的入口：把目标会话里旧目标的行重新排进用途阶段，
 * 再按当前规则重算；普通 tick 不碰已结算的 clean 行。只排空目标会话：其它
 * 会话的积压留给它自己的维护窗口。两个阶段都要排空：组没算完是积压，请求
 * 用途没判完也是——组的输入依赖用途。
 */
export function rebuildSession(store: Store, session: string): RebuildSessionReport {
  const purposeUpgraded = store.write(db => upgradePurposeTargetTx(db, session));
  const report = rebuildDerived(store, session);
  let drained: ReturnType<typeof drainDeriveEntry>;
  let recomputedRequests = 0;
  let retainedRequests = 0;
  let purposeProcessed = 0;
  do {
    drained = drainDeriveEntry(store, 100, { convKey: session });
    recomputedRequests += drained.recomputed;
    retainedRequests += drained.retained;
    purposeProcessed += drained.purpose_processed;
    if ((drained.remaining > 0 || drained.purpose_remaining > 0)
      && drained.groups.length === 0 && drained.purpose_processed === 0) {
      throw new Error('derive_no_progress');
    }
  } while (drained.remaining > 0 || drained.purpose_remaining > 0);
  const version = store.read.query<{ v: number | null }, [string]>(
    'SELECT MAX(derive_version) AS v FROM request WHERE conv_key=?').get(session);
  // 目标版本、实际算法分布与保留行分开报告：`derive_version` 已经不再逐次累加，
  // 拿它的 MAX 当"当前算法"会把保留行误报成最新。
  const algorithms = store.read.query<{ algorithm: number | null; n: number }, [string]>(`
    SELECT summary_algorithm AS algorithm, COUNT(*) AS n FROM request
    WHERE conv_key=? AND summary_state='recomputed'
    GROUP BY summary_algorithm ORDER BY summary_algorithm`).all(session);
  const actualAlgorithms: Record<string, number> = {};
  for (const row of algorithms) actualAlgorithms[String(row.algorithm ?? 'legacy')] = row.n;
  const legacy = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM request WHERE conv_key=? AND summary_state='legacy'`).get(session)?.n ?? 0;
  const pending = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=? AND ${queuePendingSql()}`).get(session)?.n ?? 0;
  // 正文与 raw 都没了的分组只报告数量和原因，旧标题与工具关系保持原样。
  return {
    queued: report.queued, unavailable: report.unavailable,
    reasons: report.reasons, derive_version: version?.v ?? 0,
    queue_remaining: drained.remaining, purpose_remaining: drained.purpose_remaining,
    purpose_processed: purposeProcessed, purpose_upgraded: purposeUpgraded,
    recomputed_requests: recomputedRequests, retained_requests: retainedRequests,
    target_algorithm: GROUP_ALGORITHM, actual_algorithms: actualAlgorithms,
    legacy_requests: legacy, pending_groups: pending,
  };
}
