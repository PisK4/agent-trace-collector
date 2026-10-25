/** 完成阶段：磁盘与覆盖校验、发布、构建期表回收。 */

import { statSync } from 'node:fs';
import type { DeriveBudget } from '../../config';
import type { Store } from '../../store';
import {
  assertQueueRevision, count, discardGenerationTx, gcRetired, one, publishGeneration,
  type SliceStep,
} from './generation';

/** WAL 文件当前字节数。文件还没建（没有写入）时是 0，不是错误。 */
function walBytes(dbPath: string): number {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * 完成并发布一代。
 *
 * 校验顺序固定：组修订 → 磁盘预算 → basis 大小 → 逐请求修订 → 覆盖，全过才发布。
 * 任何一条不过就丢弃这一代，宁可重算也不发布一份说不清来源的结果。
 *
 * WAL 检查在写事务之外做（checkpoint 与 writer 事务互相等，同一个事务里做只会把
 * 等待叠成死等）。WAL 是整库的量、不是这一代的量：拿它当丢弃理由意味着别处灌了
 * WAL 时这一组也会被反复重建。这是有意的选择——磁盘安全先于进度，而"因为磁盘"
 * 而停在 dirty 是可在 `last_error` 与丢弃计数里看见的状态，不是静默的错误结果。
 */
export function sliceReadyStage(store: Store, generation: string,
  budget: DeriveBudget, now: number, dbPath: string): SliceStep {
  const started = performance.now();
  if (walBytes(dbPath) > budget.maxWalGrowthBytes) store.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  return store.write(db => {
    const gen = one<{ state: string; stage: string; conv_key: string; actor: string;
      group_epoch: string; input_revision: number; request_count: number; tool_count: number;
      staged_bytes: number }>(db, `SELECT state,stage,conv_key,actor,group_epoch,input_revision,
      request_count,tool_count,staged_bytes FROM derive_generation WHERE generation=?`,
    [generation]);
    if (gen === null || gen.state !== 'building') {
      return { status: 'idle', generation, stage: gen?.stage ?? null, rows: 0,
        batch_ms: performance.now() - started };
    }
    if (gen.stage !== 'ready') {
      return { status: 'idle', generation, stage: gen.stage, rows: 0,
        batch_ms: performance.now() - started };
    }
    const discard = (reason: string): SliceStep => {
      // 这里的丢弃与这一代的校验同在一个事务里：它不是"抛错回滚之后的补救"，
      // 而是校验结论本身，与结果行的删除一起提交才自洽。
      discardGenerationTx(db, generation, reason, now);
      return { status: 'discarded', generation, stage: null, rows: 0,
        batch_ms: performance.now() - started };
    };
    if (!assertQueueRevision(db, gen)) return discard('slice_group_revision_changed');
    if (gen.staged_bytes > budget.maxStagedBytes
      || walBytes(dbPath) > budget.maxWalGrowthBytes) return discard('slice_disk_budget');
    // 结果行的 basis 是发布出去的事实来源，超过预算就说明这一代存了不该存的东西。
    // 当前 basis 恒为代际身份与调用号，远在预算之下：这条是阶段边界上的不变量断言。
    const oversizedBasis = count(db, `SELECT COUNT(*) FROM derive_request_result
      WHERE generation=? AND length(CAST(basis_json AS BLOB))>4096`, [generation])
      + count(db, `SELECT COUNT(*) FROM derive_tool_result
      WHERE generation=? AND length(CAST(basis_json AS BLOB))>4096`, [generation]);
    if (oversizedBasis !== 0) return discard('slice_basis_budget');
    // 逐请求修订：组级校验只看组修订，用途重判到同一结论但换了修订时它拦不住，
    // 而结果行里记的修订是要发布出去的。
    const stale = count(db, `SELECT COUNT(*) FROM derive_request_result d
      JOIN request r ON r.req_id=d.req_id
      WHERE d.generation=? AND r.actor_state='known'
        AND (r.input_revision<>d.input_revision OR r.purpose_revision<>d.purpose_revision)`,
    [generation]);
    if (stale !== 0) return discard('slice_stamp_invalidated');
    // 覆盖：参与请求的每一笔候选都要有结果行，组里每一笔已知请求都要进这一代。
    // 筛选按 `purpose_chain`，与工具阶段同一条判据（`chain_role` 是它的推论）。
    const missingCalls = count(db, `SELECT COUNT(*) FROM derive_call_work c
      JOIN derive_request_result d ON d.generation=c.generation AND d.req_id=c.req_id
      WHERE c.generation=? AND d.purpose_chain='participate'
        AND NOT EXISTS (SELECT 1 FROM derive_tool_result t
        WHERE t.generation=c.generation AND t.req_id=c.req_id AND t.ord=c.ord)`, [generation]);
    const missingRequests = count(db, `SELECT COUNT(*) FROM request r
      WHERE r.conv_key=? AND r.actor=? AND r.actor_state='known'
        AND NOT EXISTS (SELECT 1 FROM derive_request_result d
        WHERE d.generation=? AND d.req_id=r.req_id)`, [gen.conv_key, gen.actor, generation]);
    const requests = count(db, `SELECT COUNT(*) FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known'`, [gen.conv_key, gen.actor]);
    if (missingCalls !== 0 || missingRequests !== 0 || requests !== gen.request_count) {
      return discard('slice_coverage_budget');
    }
    db.run(`UPDATE derive_generation SET state='ready',stage='done' WHERE generation=?`,
      [generation]);
    // 发布失败已经被 `publishGeneration` 自己丢弃并记下原因，这里只回报状态。
    if (!publishGeneration(db, generation, now)) {
      return { status: 'discarded', generation, stage: null, rows: 0,
        batch_ms: performance.now() - started };
    }
    // 祖先台账与扫描状态只在构建期有读者：发布之后留着只占空间。
    db.run('DELETE FROM derive_chain_work WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_role_work WHERE generation=?', [generation]);
    gcRetired(db, gen.conv_key, gen.actor, budget.maxRetiredGenerations);
    return { status: 'published', generation, stage: 'done', rows: 0,
      batch_ms: performance.now() - started };
  });
}
