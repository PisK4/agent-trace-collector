/** 切片调度：一次调用推进一个组的一个阶段批次。阶段文件只由这里认识。 */

import type { SliceRuntime } from '../../config';
import type { Store } from '../../store';
import { DERIVE_ALGORITHM, normalizeTargetAlgorithmTx, purposePendingSql, queuePendingSql } from '../state';
import type { DeriveScope } from '../read';
import {
  beginGeneration, one, sliceDiscardReason, type SliceStep,
} from './generation';
import { sliceRequestsStage } from './requests';
import { sliceRolesStage, ROLE_STAGES } from './roles';
import { sliceToolsStage } from './tools';
import { sliceSummaryStage } from './summary';
import { sliceReadyStage } from './ready';

/**
 * 推进一个组的一个阶段批次。
 *
 * 一次只推进一个组：批的边界就是这一代的一个阶段批次，单个长组不会连续占满
 * 事件循环。选择顺序是"先续跑已有代，再取最久没被认领的组"，`dirty_since_ms`
 * 打破平局——积压最久的组先走，热点组不会把冷组饿死。
 */
export function sliceGroupStep(store: Store, runtime: SliceRuntime,
  now: number, scope?: DeriveScope): SliceStep {
  const idle = (): SliceStep =>
    ({ status: 'idle', generation: null, stage: null, rows: 0, batch_ms: 0 });
  // 组里还有未判定用途的请求时不开代：切片的组阶段消费的是已经定下来的用途，
  // 拿默认值把组算干净等于替那些请求猜了一个用途。同步入口在同一处跳过。
  const candidate = store.read.query<{ conv_key: string; actor: string;
    compute_generation: string | null }, [string | null, string | null]>(`
    SELECT q.conv_key,q.actor,q.compute_generation FROM derive_queue q
    WHERE ${queuePendingSql('q')} AND (? IS NULL OR q.conv_key=?)
      AND NOT EXISTS (SELECT 1 FROM request r WHERE r.conv_key=q.conv_key AND r.actor=q.actor
        AND ${purposePendingSql('r')})
    ORDER BY q.last_claimed_ms IS NOT NULL,q.last_claimed_ms,q.dirty_since_ms,q.conv_key,q.actor
    LIMIT 1`).get(scope?.convKey ?? null, scope?.convKey ?? null);
  if (candidate === null) return idle();
  // 认领前把队列行的目标算法归一到本模式的算法号。写入规则与同步认领共用
  // （derive-state 的 normalizeTargetAlgorithmTx），算法号是参数：
  // GROUP_ALGORITHM 与 DERIVE_ALGORITHM 各自保留，产物不能互相复用。
  store.write(db => {
    normalizeTargetAlgorithmTx(db, candidate.conv_key, candidate.actor, DERIVE_ALGORITHM);
    db.run('UPDATE derive_queue SET last_claimed_ms=? WHERE conv_key=? AND actor=?',
      [now, candidate.conv_key, candidate.actor]);
  });
  const generation = candidate.compute_generation
    ?? beginGeneration(store, candidate.conv_key, candidate.actor, now);
  // 认领不到（另一个进程刚认领、或这一行已经不是待派生）时不继续烧批次：
  // 调度下一轮再来，比在这里空转整批更省。
  if (generation === null) {
    return { status: 'rotated', generation: null, stage: null, rows: 0, batch_ms: 0 };
  }
  const head = one<{ stage: string }>(store.read,
    'SELECT stage FROM derive_generation WHERE generation=?', [generation]);
  if (head === null) return idle();
  const stage = head.stage === 'requests' ? sliceRequestsStage
    : ROLE_STAGES.has(head.stage) ? sliceRolesStage
      : head.stage === 'tools' ? sliceToolsStage
        : head.stage === 'summary' ? sliceSummaryStage : null;
  try {
    // `ready` 之外的未知阶段落到完成阶段，由它按状态判定——阶段只前不后，
    // 已经发布或已丢弃的代在这里得到一个 idle，不会被重复推进。
    return stage === null
      ? sliceReadyStage(store, generation, runtime.budget, now, runtime.dbPath)
      : stage(store, generation, runtime.budget, now);
  } catch (error) {
    // 阶段内部的丢弃已经把枚举过的失败处理掉了；这里兜住的是阶段包装外冒出来的
    // 同类失败，一到即丢。别的异常照旧冒泡：把真实故障吞成"切片决策"会让坏掉的
    // 代码看起来像在正常工作。
    sliceDiscardReason(store, generation, error, now);
    return { status: 'discarded', generation, stage: null, rows: 0, batch_ms: 0 };
  }
}
