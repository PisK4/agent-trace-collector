import type { Store } from '../store';
import { addBodyReadStats, emptyBodyReadStats } from '../body-cache';
import type { BodyReadStats } from '../body-cache';
import { errorCode } from '../monitoring';
import type { DeriveGroupRound, DeriveScope, DrainResult } from './sync';
import { applyDeriveGroup, computeDeriveGroup } from './sync';
import { claimGroupTx, queuePendingSql } from './state';
import { drainRequestPurposesTx } from '../request-purpose';
import { recoverSlice } from './slice/generation';
import { sliceGroupStep } from './slice/scheduler';

/**
 * 派生轮失败的固定错误码：SQLite 锁冲突的英文原文归一成 snake_case，
 * 其余交给通用分类（F11：结构化日志里要能按码认出整轮被丢弃）。
 */
function deriveErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^database is locked$/i.test(message)) return 'database_locked';
  if (/^database table is locked$/i.test(message)) return 'table_locked';
  return errorCode(message);
}

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

/**
 * 计算段的执行位置：不传就在主线程用只读连接算（维护与脚本），传了就把
 * 计算交出去（在线 Worker），落库始终回到主线程的写事务里。
 */
export type DeriveCompute = (convKey: string, actor: string) => Promise<DeriveGroupRound | null>;

async function drain(store: Store, limit: number, scope: DeriveScope | undefined,
  budgetMs: number, compute?: DeriveCompute,
  onRound?: (event: DeriveRoundEvent) => void): Promise<DrainResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
  if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_derive_scope');
  }
  const started = performance.now();
  let nextRound = 1;
  const result: DrainResult = {
    processed: 0, remaining: 0, groups: [], recomputed: 0, retained: 0, discarded: 0,
    purpose_processed: 0, purpose_remaining: 0, body_read: emptyBodyReadStats(), batch_ms: 0,
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
      // 计算不持写锁；落库另起一个短写事务，CAS 挡住计算期间到达的输入。
      // 认领单独一个短事务，落在计算快照之前：写侧边界因此比真实快照更保守。
      // shortcut: 同步单组不可中断，需在读取与长组容量验收后启用切片。
      store.write(db => claimGroupTx(db, candidate.conv_key, candidate.actor), 'derive-claim');
      const corr = `round-${nextRound}`;
      nextRound += 1;
      let computeMs = 0;
      let applyMs = 0;
      try {
        const computeStarted = performance.now();
        const round = compute === undefined
          ? computeDeriveGroup(store.read, candidate.conv_key, candidate.actor)
          : await compute(candidate.conv_key, candidate.actor);
        computeMs = performance.now() - computeStarted;
        if (round === null) break;
        let publish: 'whole' | 'prefix' | null = null;
        const applyStarted = performance.now();
        const group = store.write(db => applyDeriveGroup(db, round, kind => { publish = kind; }), 'derive');
        applyMs = performance.now() - applyStarted;
        if (group === null) break;
        onRound?.({ corr, result: publish ?? 'failure', compute_ms: computeMs, apply_ms: applyMs });
        result.processed += group.processed;
        result.recomputed += group.recomputed;
        result.retained += group.retained;
        addBodyReadStats(result.body_read, group.body_read);
        result.groups.push(candidate);
      } catch (error) {
        onRound?.({ corr, result: 'failure', compute_ms: computeMs, apply_ms: applyMs,
          code: deriveErrorCode(error) });
        throw error;
      }
    } else {
      const step = sliceGroupStep(store, runtime, Date.now(), scope);
      if (step.status === 'idle' || step.status === 'rotated') break;
      if (step.status === 'discarded') {
        result.discarded += 1;
        onRound?.({ corr: step.generation ?? 'slice', result: 'discard',
          stage_ms: step.batch_ms, phase: step.stage ?? undefined });
        continue;
      }
      result.processed += 1;
      if (step.generation === null) continue;
      const generation = step.generation;
      const group = store.read.query<{ conv_key: string; actor: string }, [string]>(
        'SELECT conv_key,actor FROM derive_generation WHERE generation=?').get(generation);
      if (group === null) continue;
      if (!result.groups.some(row => row.conv_key === group.conv_key && row.actor === group.actor)) {
        result.groups.push(group);
      }
      if (step.status === 'published') {
        const counts = store.read.query<{ retention_state: string; n: number }, [string]>(`
          SELECT retention_state,COUNT(*) AS n FROM derive_request_result
          WHERE generation=? GROUP BY retention_state`).all(generation);
        for (const row of counts) {
          if (row.retention_state === 'recomputed') result.recomputed += row.n;
          else result.retained += row.n;
        }
        onRound?.({ corr: generation, result: 'whole', stage_ms: step.batch_ms });
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
export async function drainDeriveEntry(store: Store, limit = 100,
  scope?: DeriveScope): Promise<DrainResult> {
  return drain(store, limit, scope, Number.POSITIVE_INFINITY);
}

/** 在线工作单元的观测出口；计数器只增，回调不改变调度结果。 */
export type DeriveRoundEvent = {
  /** 本轮的关联编号；同步路径由工作单元生成，切片路径用代际。 */
  corr: string;
  result: 'whole' | 'prefix' | 'discard' | 'failure';
  /** 计算段（Worker 或主线程只读）的耗时；切片路径没有这个分段。 */
  compute_ms?: number;
  /** 落库段（主线程写事务）的耗时。 */
  apply_ms?: number;
  stage_ms?: number;
  phase?: string;
  code?: string;
};

export type DeriveUnitOptions = {
  onBodyRead?: (stats: BodyReadStats) => void;
  /** 计算段的执行位置；缺省在主线程算，采集器注入 Worker。 */
  compute?: DeriveCompute;
  /** 每次实际组计算结束回调；空闲 tick 不回调。 */
  onRound?: (event: DeriveRoundEvent) => void;
};

/** 启动恢复与在线调度共用一个工作单元，未发布代在起定时器前丢弃。 */
export function createDeriveUnit(store: Store, unitOptions: DeriveUnitOptions = {}): {
  run(options: { budgetMs: number }): Promise<{ didWork: boolean; nextDueMs: number }>;
} {
  const unfinished = store.read.query(`SELECT 1 FROM derive_queue q
    JOIN derive_generation g ON g.generation=q.compute_generation
    WHERE g.state IN ('building','ready') LIMIT 1`).get();
  if (unfinished !== null) store.write(db => recoverSlice(db, Date.now()), 'derive');
  return {
    async run({ budgetMs }) {
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('invalid_derive_budget');
      const result = await drain(store, ONLINE_LIMIT, undefined, budgetMs, unitOptions.compute,
        unitOptions.onRound);
      if (result.body_read.message_decodes > 0) unitOptions.onBodyRead?.(result.body_read);
      const didWork = result.purpose_processed > 0 || result.processed > 0
        || result.groups.length > 0 || result.discarded > 0;
      return {
        didWork,
        nextDueMs: didWork && (result.remaining > 0 || result.purpose_remaining > 0) ? 0 : IDLE_MS,
      };
    },
  };
}
