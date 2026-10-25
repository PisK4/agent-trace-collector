/** 切片代际生命周期：开代、发布指针、丢弃、恢复与退役回收，附阶段共用的辅助。 */

import { randomUUID } from 'node:crypto';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Store } from '../../store';
import { DERIVE_ALGORITHM } from '../state';

/** 阶段步进结果。 */
export type SliceStep = {
  status: 'idle' | 'advanced' | 'published' | 'discarded' | 'rotated';
  generation: string | null; stage: string | null; rows: number; batch_ms: number;
};

export function one<T>(db: Database, sql: string, params: SQLQueryBindings[] = []): T | null {
  return db.query(sql).get(...params) as T | null;
}

export function count(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const row = one<Record<string, unknown>>(db, sql, params);
  return row === null ? 0 : Number(Object.values(row)[0]);
}

type QueueRow = {
  state: string; input_revision: number; group_epoch: string;
  target_algorithm: number; compute_generation: string | null;
};

/**
 * 认领一个组，开一代。只认领一个组：批的边界就是这一代的一个阶段批次，
 * 让单个长组不会连续占满事件循环。
 */
export function beginGeneration(store: Store, convKey: string, actor: string, now: number): string | null {
  return store.write(db => {
    const queue = one<QueueRow>(db,
      `SELECT state,input_revision,group_epoch,target_algorithm,compute_generation
       FROM derive_queue WHERE conv_key=? AND actor=?`, [convKey, actor]);
    if (queue === null || queue.state === 'clean' || queue.compute_generation !== null) return null;
    if (queue.target_algorithm !== DERIVE_ALGORITHM) throw new Error('derive_algorithm_mismatch');
    const generation = `gen-${randomUUID().replaceAll('-', '')}`;
    db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,
      input_revision,algorithm,state,stage,created_at)
      VALUES (?,?,?,?,?,?,'building','requests',?)`,
    [generation, convKey, actor, queue.group_epoch, queue.input_revision,
      DERIVE_ALGORITHM, now]);
    db.run(`UPDATE derive_queue SET compute_generation=?,compute_started_ms=?,
      last_claimed_ms=?,attempts=attempts+1,last_error=NULL
      WHERE conv_key=? AND actor=?`, [generation, now, now, convKey, actor]);
    return generation;
  });
}

/**
 * 丢弃未发布的一代：只删结果与工作行，源事实与上一条已发布代都不动。
 *
 * 已发布或已退役的代不走这里：它们是历史，回收只由保留上限处理。
 * 事务由调用方决定（`publishGeneration` 已经在自己的事务里）。
 */
export function discardGenerationTx(db: Database, generation: string, reason: string, now: number): void {
  const gen = one<{ state: string; conv_key: string; actor: string }>(db,
    'SELECT state,conv_key,actor FROM derive_generation WHERE generation=?', [generation]);
  if (gen === null || gen.state === 'published' || gen.state === 'retired') return;
  db.run('DELETE FROM derive_result_work WHERE generation=?', [generation]);
  db.run('DELETE FROM derive_call_work WHERE generation=?', [generation]);
  db.run('DELETE FROM derive_chain_work WHERE generation=?', [generation]);
  db.run('DELETE FROM derive_role_work WHERE generation=?', [generation]);
  db.run('DELETE FROM derive_tool_result WHERE generation=?', [generation]);
  db.run('DELETE FROM derive_request_result WHERE generation=?', [generation]);
  db.run(`UPDATE derive_generation SET state='discarded' WHERE generation=?`, [generation]);
  db.run(`UPDATE derive_queue SET compute_generation=NULL,compute_started_ms=NULL,
    last_completed_ms=?,last_error=? WHERE conv_key=? AND actor=? AND compute_generation=?`,
  [now, reason, gen.conv_key, gen.actor, generation]);
}

export function discardGeneration(db: Database, generation: string, reason: string, now: number): void {
  db.transaction(() => discardGenerationTx(db, generation, reason, now)).immediate();
}

type GenerationRow = {
  state: string; stage: string; conv_key: string; actor: string;
  group_epoch: string; input_revision: number; algorithm: number;
  request_count: number; tool_count: number;
};

/**
 * 切换发布指针。所有校验都在切换之前完成，因此过期的一代不会短暂出现在
 * `published_generation` 上：校验不过就丢弃这一代并返回 false。
 */
export function publishGeneration(db: Database, generation: string, now: number): boolean {
  return db.transaction(() => {
    const gen = one<GenerationRow>(db, `SELECT state,stage,conv_key,actor,group_epoch,
      input_revision,algorithm,request_count,tool_count
      FROM derive_generation WHERE generation=?`, [generation]);
    if (gen === null || gen.state !== 'ready' || gen.stage !== 'done') return false;
    const queue = one<{ state: string; group_epoch: string; input_revision: number; target_algorithm: number }>(
      db, `SELECT state,group_epoch,input_revision,target_algorithm
        FROM derive_queue WHERE conv_key=? AND actor=?`, [gen.conv_key, gen.actor]);
    const requests = count(db, `SELECT COUNT(*) FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known'`, [gen.conv_key, gen.actor]);
    const missing = count(db, `SELECT COUNT(*) FROM request r
      WHERE r.conv_key=? AND r.actor=? AND r.actor_state='known' AND NOT EXISTS
        (SELECT 1 FROM derive_request_result d WHERE d.generation=? AND d.req_id=r.req_id)`,
    [gen.conv_key, gen.actor, generation]);
    const tools = count(db, 'SELECT COUNT(*) FROM derive_tool_result WHERE generation=?', [generation]);
    // 发布事务只做指针级校验；逐请求的修订比较与 basis 大小已在 ready 阶段分批完成。
    if (queue === null || queue.group_epoch !== gen.group_epoch ||
        queue.input_revision !== gen.input_revision ||
        queue.target_algorithm !== gen.algorithm || requests !== gen.request_count ||
        missing !== 0 || tools !== gen.tool_count) {
      discardGenerationTx(db, generation, 'publish_invalidated', now);
      return false;
    }
    db.run(`UPDATE derive_generation SET state='retired'
      WHERE conv_key=? AND actor=? AND state='published'`, [gen.conv_key, gen.actor]);
    db.run(`UPDATE derive_generation SET state='published',published_at=
      CASE WHEN published_at IS NULL THEN ? ELSE published_at END WHERE generation=?`,
    [now, generation]);
    db.run(`UPDATE derive_queue SET published_generation=?,published_revision=input_revision,
      published_algorithm=?,state='clean',dirty_since_ms=NULL,legacy_snapshot=0,
      compute_generation=NULL,compute_started_ms=NULL,last_completed_ms=?,last_error=NULL
      WHERE conv_key=? AND actor=?`,
    [generation, gen.algorithm, now, gen.conv_key, gen.actor]);
    return true;
  }).immediate();
}

/**
 * 这一代消费的输入还是不是当前输入。
 *
 * 比组身份与组修订，不比每个请求自己的 `input_revision`：请求行的修订是它自己的
 * 变更计数，与组修订不是同一个量——组修订每有一位成员变动就涨一次，所以从未变过的
 * 成员修订天然低于组修订。拿两者相等当条件会让每一代都被判过期。
 */
export function assertQueueRevision(db: Database, gen: {
  conv_key: string; actor: string; group_epoch: string; input_revision: number;
}): boolean {
  const queue = one<{ group_epoch: string; input_revision: number }>(db,
    `SELECT group_epoch,input_revision FROM derive_queue WHERE conv_key=? AND actor=?`,
    [gen.conv_key, gen.actor]);
  return queue !== null && queue.group_epoch === gen.group_epoch &&
    queue.input_revision === gen.input_revision;
}

/**
 * 进程重开时丢弃上一轮没发布完的代。
 * 未发布的代没有任何读者，留着只会在下一次认领时被误当成续跑目标。
 */
export function recoverSlice(db: Database, now: number): number {
  const rows = db.query<{ generation: string }, []>(`
    SELECT q.compute_generation AS generation FROM derive_queue q
    JOIN derive_generation g ON g.generation=q.compute_generation
    WHERE q.compute_generation IS NOT NULL AND g.state IN ('building','ready')`).all();
  for (const row of rows) discardGeneration(db, row.generation, 'reopened_unpublished', now);
  return rows.length;
}

export type EffectiveRow = Record<string, unknown> & { generation: string | null };
export type EffectiveGroup = {
  state: 'current' | 'masked';
  generation: string | null;
  rows: EffectiveRow[];
};

/**
 * 一次事务里读队列指针与整组结果。组不是 clean 就一行都不返回：
 * 半套结果比旧结果更坏，所以宁可屏蔽，也不逐字段回退到 `request` 旧列。
 */
export function readEffectiveGroup(read: Database, convKey: string, actor: string): EffectiveGroup {
  read.exec('BEGIN DEFERRED');
  try {
    const queue = one<{ state: string; published_generation: string | null }>(read,
      `SELECT state,published_generation FROM derive_queue WHERE conv_key=? AND actor=?`,
      [convKey, actor]);
    if (queue === null || queue.state !== 'clean' || queue.published_generation === null) {
      return { state: 'masked', generation: queue?.published_generation ?? null, rows: [] };
    }
    const rows = read.query<EffectiveRow, [string, string]>(`
      SELECT * FROM effective_request WHERE conv_key=? AND actor=?
      ORDER BY started_ms,req_id`).all(convKey, actor);
    for (const row of rows) {
      if (row.generation !== queue.published_generation) throw new Error('derive_snapshot_mismatch');
    }
    return { state: 'current', generation: queue.published_generation, rows };
  } finally {
    read.exec('COMMIT');
  }
}

/**
 * 只有这些失败把这一代丢掉。其余异常照旧冒泡：把真实故障吞成"切片决策"
 * 会让坏掉的代码看起来像在正常工作。
 *
 * 完成阶段那几条（磁盘、basis、逐请求修订、覆盖）不在抛错路径上：它在自己那个
 * 写事务里判完即丢，与结果行的删除同事务提交。名字列在这里，因为它们是同一件事
 * 的另一种说法——"这一代不能发布"。
 */
const SLICE_DISCARD_REASONS = new Set([
  'slice_group_revision_changed',
  'slice_purpose_revision_changed',
  'slice_request_budget',
  'slice_summary_budget',
  'slice_candidate_budget',
  'slice_tool_coverage',
  'slice_disk_budget',
  'slice_basis_budget',
  'slice_stamp_invalidated',
  'slice_coverage_budget',
]);

/**
 * 阶段步进里的失败处理：只有列明的失败把这一代丢掉，其余照旧冒泡。
 *
 * 丢弃必须开一次新的写事务：抛错的页事务已经回滚，在同一个事务里丢弃会被
 * 一起带走，那一代就以"半套结果、状态仍是 building"的形态留在库里。
 */
export function sliceDiscardReason(store: Store, generation: string, error: unknown, now: number): string {
  const reason = error instanceof Error ? error.message : 'slice_unknown_failure';
  if (!SLICE_DISCARD_REASONS.has(reason)) throw error;
  discardGeneration(store.db, generation, reason, now);
  return reason;
}

/**
 * 回收超过保留上限的退役代。
 *
 * 发布是把上一代转成 retired，不是删除：当前代与最近几代的原算法结果要留给
 * 历史详情与对照。删的是最旧的那几代，顺序按发布时间。
 */
export function gcRetired(db: Database, convKey: string, actor: string, keep: number): void {
  const old = db.query<{ generation: string }, [string, string, number]>(`
    SELECT generation FROM derive_generation
    WHERE conv_key=? AND actor=? AND state='retired'
    ORDER BY published_at DESC LIMIT -1 OFFSET ?`).all(convKey, actor, keep);
  for (const row of old) {
    db.run('DELETE FROM derive_result_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_call_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_chain_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_role_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_tool_result WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_request_result WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_generation WHERE generation=?', [row.generation]);
  }
}
