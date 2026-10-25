import type { Store } from '../store';
import type { DeriveScope, DrainResult } from './sync';
import { drainDeriveGroupTx } from './sync';
import { queuePendingSql } from './state';
import { drainRequestPurposesTx } from '../request-purpose';
import { recoverSlice, sliceGroupStep } from './slice';

const IDLE_MS = 2000;
const ONLINE_LIMIT = 10;
const PURPOSE_BATCH = 10;

function remainingWork(store: Store, scope?: DeriveScope): { groups: number; purposes: number } {
  const params: [string | null, string | null] = [scope?.convKey ?? null, scope?.convKey ?? null];
  const groups = store.read.query<{ n: number }, typeof params>(`
    SELECT COUNT(*) AS n FROM derive_queue WHERE ${queuePendingSql()}
      AND (? IS NULL OR conv_key=?)`).get(...params)!.n;
  const purposes = store.read.query<{ n: number }, typeof params>(`
    SELECT COUNT(*) AS n FROM request WHERE purpose_pending=1
      AND (? IS NULL OR conv_key=?)`).get(...params)!.n;
  return { groups, purposes };
}

function drain(store: Store, limit: number, scope: DeriveScope | undefined,
  budgetMs: number): DrainResult {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
  if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_derive_scope');
  }
  const started = performance.now();
  const result: DrainResult = {
    processed: 0, remaining: 0, groups: [], recomputed: 0, retained: 0, discarded: 0,
    purpose_processed: 0, purpose_remaining: 0, batch_ms: 0,
  };
  let remaining = remainingWork(store, scope);
  while (remaining.purposes > 0 && performance.now() - started < budgetMs) {
    const batch = store.write(db => drainRequestPurposesTx(db, PURPOSE_BATCH, scope), 'derive');
    result.purpose_processed += batch.processed;
    remaining.purposes = batch.remaining;
    if (batch.processed === 0) break;
  }
  for (let index = 0; index < limit && performance.now() - started < budgetMs; index++) {
    const runtime = store.deriveRuntime;
    if (runtime === undefined) {
      const candidate = store.read.query<{ conv_key: string; actor: string }, [string | null, string | null]>(`
        SELECT q.conv_key,q.actor FROM derive_queue q
        WHERE ${queuePendingSql('q')} AND (? IS NULL OR q.conv_key=?)
          AND NOT EXISTS (SELECT 1 FROM request r WHERE r.conv_key=q.conv_key AND r.actor=q.actor
            AND r.actor_state='known' AND r.purpose_pending=1)
        ORDER BY q.conv_key,q.actor LIMIT 1`).get(scope?.convKey ?? null, scope?.convKey ?? null);
      if (candidate === null) break;
      // shortcut: 同步单组不可中断，需在读取与长组容量验收后启用切片。
      const group = store.write(db => drainDeriveGroupTx(db, candidate.conv_key, candidate.actor), 'derive');
      if (group === null) break;
      result.processed += group.processed;
      result.recomputed += group.recomputed;
      result.retained += group.retained;
      result.groups.push(candidate);
    } else {
      const step = sliceGroupStep(store, runtime, Date.now(), scope);
      if (step.status === 'idle' || step.status === 'rotated') break;
      if (step.status === 'discarded') { result.discarded += 1; continue; }
      result.processed += 1;
      if (step.generation === null) continue;
      const group = store.read.query<{ conv_key: string; actor: string }, [string]>(
        'SELECT conv_key,actor FROM derive_generation WHERE generation=?').get(step.generation);
      if (group === null) continue;
      if (!result.groups.some(row => row.conv_key === group.conv_key && row.actor === group.actor)) {
        result.groups.push(group);
      }
      if (step.status === 'published') {
        const counts = store.read.query<{ retention_state: string; n: number }, [string]>(`
          SELECT retention_state,COUNT(*) AS n FROM derive_request_result
          WHERE generation=? GROUP BY retention_state`).all(step.generation);
        for (const row of counts) {
          if (row.retention_state === 'recomputed') result.recomputed += row.n;
          else result.retained += row.n;
        }
      }
    }
  }
  remaining = remainingWork(store, scope);
  result.remaining = remaining.groups;
  result.purpose_remaining = remaining.purposes;
  result.batch_ms = performance.now() - started;
  return result;
}

/** 维护与容量实验的排空入口；同步每组独立提交，limit 按组或切片步骤计数。 */
export function drainDeriveEntry(store: Store, limit = 100, scope?: DeriveScope): DrainResult {
  return drain(store, limit, scope, Number.POSITIVE_INFINITY);
}

/** 启动恢复与在线调度共用一个工作单元，未发布代在起定时器前丢弃。 */
export function createDeriveUnit(store: Store): {
  run(options: { budgetMs: number }): { didWork: boolean; nextDueMs: number };
} {
  const unfinished = store.read.query(`SELECT 1 FROM derive_queue q
    JOIN derive_generation g ON g.generation=q.compute_generation
    WHERE g.state IN ('building','ready') LIMIT 1`).get();
  if (unfinished !== null) store.write(db => recoverSlice(db, Date.now()), 'derive');
  return {
    run({ budgetMs }) {
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('invalid_derive_budget');
      const result = drain(store, ONLINE_LIMIT, undefined, budgetMs);
      const didWork = result.purpose_processed > 0 || result.processed > 0
        || result.groups.length > 0 || result.discarded > 0;
      return {
        didWork,
        nextDueMs: didWork && (result.remaining > 0 || result.purpose_remaining > 0) ? 0 : IDLE_MS,
      };
    },
  };
}
