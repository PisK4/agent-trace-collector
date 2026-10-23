import { randomUUID } from 'node:crypto';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Store } from './store';

/** 切片派生的算法号。与同步组的 `GROUP_ALGORITHM` 分开：两者算出的结果不能互相复用。 */
export const DERIVE_ALGORITHM = 5;

export type DeriveBudget = {
  maxRequestMs: number;
  maxStageBatchMs: number;
  maxCandidatesPerBatch: number;
  maxWritesPerBatch: number;
  maxStagedBytes: number;
  maxWalGrowthBytes: number;
  maxRetiredGenerations: number;
};

export const DEFAULT_DERIVE_BUDGET: DeriveBudget = {
  maxRequestMs: 10,
  maxStageBatchMs: 250,
  maxCandidatesPerBatch: 100,
  maxWritesPerBatch: 500,
  maxStagedBytes: 64 * 1024 * 1024,
  maxWalGrowthBytes: 32 * 1024 * 1024,
  maxRetiredGenerations: 2,
};

export type SliceStep = {
  status: 'idle' | 'advanced' | 'published' | 'discarded' | 'rotated';
  generation: string | null; stage: string | null; rows: number; batch_ms: number;
};

function one<T>(db: Database, sql: string, params: SQLQueryBindings[] = []): T | null {
  return db.query(sql).get(...params) as T | null;
}

function count(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
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

function assertQueueRevision(db: Database, gen: GenerationRow): boolean {
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