import { randomUUID } from 'node:crypto';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Store } from './store';
import { readBodyTx } from './body';
import {
  anthropicReplyCalls, anthropicRequestResults, compareTraversalOrder, flattenToolContent,
} from './derive';
import type { LogicalRow } from './derive';

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

/**
 * 这一代消费的输入还是不是当前输入。
 *
 * 比组身份与组修订，不比每个请求自己的 `input_revision`：请求行的修订是它自己的
 * 变更计数，与组修订不是同一个量——组修订每有一位成员变动就涨一次，所以从未变过的
 * 成员修订天然低于组修订。拿两者相等当条件会让每一代都被判过期。
 */
function assertQueueRevision(db: Database, gen: {
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
// ---------------------------------------------------------------------------
// 请求阶段：把请求事实与工具候选落进这一代，然后定下遍历顺序。
// ---------------------------------------------------------------------------

/** 单页取多少请求。页就是事务边界，取太大会让一个写事务一直占着事件循环。 */
const REQUEST_PAGE_MAX = 50;
/** 顺序写回的批大小。 */
const ORDER_WRITE_BATCH = 500;
/** 候选摘要先存比展示更长的前缀：配对确定之后才裁到最终长度。 */
const CANDIDATE_PREVIEW_LIMIT = 200;

/**
 * 只有这些失败把这一代丢掉。其余异常照旧冒泡：把真实故障吞成"切片决策"
 * 会让坏掉的代码看起来像在正常工作。
 */
const SLICE_DISCARD_REASONS = new Set([
  'slice_group_revision_changed',
  'slice_request_budget',
  'slice_candidate_budget',
]);

type StageRow = {
  state: string; stage: string; conv_key: string; actor: string;
  group_epoch: string; input_revision: number; cursor_req_id: number;
};

type RequestFact = {
  req_id: number; input_epoch: string | null; input_revision: number | null;
  sort_source: string | null; sort_key: string | null; started_ms: number;
  body_state: string; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
  reply_preview: string | null; purpose_revision: number; purpose_version: number | null;
  purpose_chain: string;
};

const STAGE_COLUMNS = `state,stage,conv_key,actor,group_epoch,input_revision,cursor_req_id`;

function stageRow(db: Database, generation: string): StageRow | null {
  return one<StageRow>(db,
    `SELECT ${STAGE_COLUMNS} FROM derive_generation WHERE generation=?`, [generation]);
}

/** 候选摘要：压平后取前若干字符，空内容存 NULL 而不是空串。 */
function previewText(value: unknown): string | null {
  const flat = flattenToolContent(value).replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  const chars = [...flat];
  return chars.length <= CANDIDATE_PREVIEW_LIMIT
    ? flat
    : `${chars.slice(0, CANDIDATE_PREVIEW_LIMIT).join('')}…`;
}

type PageOutcome =
  | { kind: 'finished' }
  | { kind: 'page'; rows: number; writes: number };

/**
 * 一批请求一个事务。
 *
 * 可读性按"读得出正文"判定，不按 `body_state`：骨架或块引用损坏时正文读不出来，
 * 这时旧标题必须原样保留，不能被标成本次重算的结果。
 *
 * 逐请求的时间预算超了就整代作废，不把一笔请求切两半——半套请求事实没有读者，
 * 留在库里只会让下一代误以为可以续跑。
 */
function materializePage(db: Database, generation: string, budget: DeriveBudget): PageOutcome {
  const gen = stageRow(db, generation);
  if (gen === null || gen.state !== 'building' || gen.stage !== 'requests') {
    return { kind: 'finished' };
  }
  // 每页开头都验一次：页之间可能夹进别的事务，修订变了这一代就已经过期。
  if (!assertQueueRevision(db, gen)) throw new Error('slice_group_revision_changed');
  const page = db.query<RequestFact, [string, string, number, number]>(`
    SELECT req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,body_state,
      title,title_source,input_preview,input_preview_kind,reply_preview,
      purpose_revision,purpose_version,purpose_chain
    FROM request WHERE conv_key=? AND actor=? AND actor_state='known' AND req_id>?
    ORDER BY req_id LIMIT ?`)
    .all(gen.conv_key, gen.actor, gen.cursor_req_id,
      Math.min(REQUEST_PAGE_MAX, budget.maxCandidatesPerBatch));
  if (page.length === 0) {
    finishRequestOrder(db, generation);
    return { kind: 'finished' };
  }

  let writes = 0;
  for (const row of page) {
    const rowStarted = performance.now();
    const body = readBodyTx(db, row.req_id);
    const readable = body !== null;
    const calls = body === null ? [] : anthropicReplyCalls(body.reply);
    const results = body === null ? [] : anthropicRequestResults(body.request);
    // 候选也整笔算：只写一半候选会让配对在"这一笔确实没有第二个工具调用"与
    // "第二个还没写进来"之间分不清，宁可直接丢掉这一代。
    if (calls.length + results.length > budget.maxCandidatesPerBatch) {
      throw new Error('slice_candidate_budget');
    }
    db.run(`INSERT INTO derive_request_result(
      generation,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
      title,title_source,input_preview,input_preview_kind,reply_preview,
      purpose_revision,purpose_version,purpose_chain,algorithm,retention_state,basis_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')`, [
      generation, row.req_id, row.input_epoch, row.input_revision, row.sort_source,
      row.sort_key, row.started_ms,
      // 可读时留空，由摘要阶段写本次重算的值；不可读时原样保留旧列。
      readable ? null : row.title,
      readable ? null : row.title_source,
      readable ? null : row.input_preview,
      readable ? null : row.input_preview_kind,
      readable ? null : row.reply_preview,
      row.purpose_revision, row.purpose_version, row.purpose_chain,
      DERIVE_ALGORITHM, readable ? 'recomputed' : 'retained',
    ]);
    writes += 1;
    for (const call of calls) {
      db.run(`INSERT INTO derive_call_work(generation,req_id,ord,call_id,tool_name,
        request_index,traversal_ord) VALUES (?,?,?,?,?,-1,-1)`,
      [generation, row.req_id, call.ord, call.id, call.name]);
      writes += 1;
    }
    for (const result of results) {
      db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,
        preview,request_index,traversal_ord,confirmed) VALUES (?,?,?,?,?,?,-1,-1,0)`,
      [generation, row.req_id, result.ord, result.path, result.id, previewText(result.value)]);
      writes += 1;
    }
    if (performance.now() - rowStarted > budget.maxRequestMs) {
      throw new Error('slice_request_budget');
    }
  }
  const last = page[page.length - 1]!.req_id;
  db.run(`UPDATE derive_generation SET cursor_req_id=?,
    request_count=request_count+? WHERE generation=?`, [last, page.length, generation]);
  return { kind: 'page', rows: page.length, writes };
}

/**
 * 读取本代的轻量排序键，按 A 的同一比较器排好遍历序，再分批写回。
 *
 * 内存里只有 `(req_id, started_ms, sort_source, sort_key)` 这样的元组：
 * 排序需要全组可比，但正文与结果都不必驻留。
 */
function finishRequestOrder(db: Database, generation: string): void {
  const rows = db.query<LogicalRow, [string]>(`
    SELECT req_id,started_ms,sort_source,sort_key FROM derive_request_result
    WHERE generation=?`).all(generation);
  rows.sort(compareTraversalOrder);
  for (let start = 0; start < rows.length; start += ORDER_WRITE_BATCH) {
    const batch = rows.slice(start, start + ORDER_WRITE_BATCH);
    for (const [index, row] of batch.entries()) {
      const ord = start + index;
      db.run(`UPDATE derive_request_result SET traversal_ord=?
        WHERE generation=? AND req_id=?`, [ord, generation, row.req_id]);
      db.run(`UPDATE derive_call_work SET traversal_ord=?,request_index=?
        WHERE generation=? AND req_id=?`, [ord, ord, generation, row.req_id]);
      db.run(`UPDATE derive_result_work SET traversal_ord=?,request_index=?
        WHERE generation=? AND req_id=?`, [ord, ord, generation, row.req_id]);
    }
  }
  db.run(`UPDATE derive_generation SET stage='roles' WHERE generation=?`, [generation]);
}

/**
 * 请求阶段：分批物化请求事实与工具候选，全部到齐后定顺序并交给角色阶段。
 *
 * 一次调用就是一个阶段批次：页到了预算就返回 `advanced`，由调度方下一轮接着来。
 */
export function sliceRequestsStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const head = one<StageRow>(store.read,
    `SELECT ${STAGE_COLUMNS} FROM derive_generation WHERE generation=?`, [generation]);
  if (head === null || head.state !== 'building') {
    return { status: 'idle', generation, stage: head?.stage ?? null, rows: 0, batch_ms: elapsed() };
  }
  // 阶段只前不后：已经走过请求阶段的代再调这里就是无事可做。
  if (head.stage !== 'requests') {
    return { status: 'idle', generation, stage: head.stage, rows: 0, batch_ms: elapsed() };
  }

  let rows = 0;
  let writes = 0;
  for (;;) {
    let outcome: PageOutcome;
    try {
      outcome = store.write(db => materializePage(db, generation, budget));
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'slice_unknown_failure';
      if (!SLICE_DISCARD_REASONS.has(reason)) throw error;
      // 页事务已经回滚，丢弃要另开一次写：否则整代作废会被同一事务的回滚一起带走。
      discardGeneration(store.db, generation, reason, now);
      return { status: 'discarded', generation, stage: null, rows, batch_ms: elapsed() };
    }
    if (outcome.kind === 'finished') {
      return { status: 'advanced', generation, stage: 'roles', rows, batch_ms: elapsed() };
    }
    rows += outcome.rows;
    writes += outcome.writes;
    if (writes >= budget.maxWritesPerBatch || elapsed() >= budget.maxStageBatchMs) {
      return { status: 'advanced', generation, stage: 'requests', rows, batch_ms: elapsed() };
    }
  }
}
