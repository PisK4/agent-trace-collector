import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Store } from './store';
import { readBodyTx } from './body';
import {
  normalizeTargetAlgorithmTx, purposePendingSql, queuePendingSql,
} from './derive-state';
import {
  anthropicReplyCalls, anthropicRequestResults, chainTrunk, chainTrunkRoot, commonPrefix,
  confirmedDeltaOf, flattenToolContent, initialPairState, pairOutcome, presentationDecision,
  replyShapeOf, settleRelation,
} from './derive-decision';
import type { ResolvedTool } from './derive-decision';
import type { DeriveBudget, SliceRuntime } from './config';
import {
  compareLogicalOrder, compareTraversalOrder, fingerprintsOf, interruptCountTx, presentationPortsOf,
  replyInfoOf, uncertainOrderIds,
} from './derive-read';
import type { DeriveScope, LogicalRow } from './derive-read';

/** 切片派生的算法号。与同步组的 `GROUP_ALGORITHM` 分开：两者算出的结果不能互相复用。 */
export const DERIVE_ALGORITHM = 7;

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
function sliceDiscardReason(store: Store, generation: string, error: unknown, now: number): string {
  const reason = error instanceof Error ? error.message : 'slice_unknown_failure';
  if (!SLICE_DISCARD_REASONS.has(reason)) throw error;
  discardGeneration(store.db, generation, reason, now);
  return reason;
}

type StageRow = {
  state: string; stage: string; conv_key: string; actor: string;
  group_epoch: string; input_revision: number; cursor_req_id: number;
};

type RequestFact = {
  req_id: number; input_epoch: string | null; input_revision: number | null;
  sort_source: string | null; sort_key: string | null; started_ms: number;
  body_state: string; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
  reply_preview: string | null; reply_shape: string | null; interrupt_count: number | null;
  purpose_revision: number; purpose_version: number | null;
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
      title,title_source,input_preview,input_preview_kind,reply_preview,reply_shape,
      interrupt_count,purpose_revision,purpose_version,purpose_chain
    FROM request WHERE conv_key=? AND actor=? AND actor_state='known' AND req_id>?
    ORDER BY req_id LIMIT ?`)
    .all(gen.conv_key, gen.actor, gen.cursor_req_id,
      Math.min(REQUEST_PAGE_MAX, budget.maxCandidatesPerBatch));
  if (page.length === 0) {
    finishRequestOrder(db, generation);
    return { kind: 'finished' };
  }

  let writes = 0;
  // 暂存行占用按行数估算：每笔结果行 512 字节、每笔候选行 256 字节。
  // 这是给发布前磁盘上界用的粗估（预览文本有长度上界，512 覆盖得住），
  // 真正的硬闸门是 ready 阶段的 WAL 检查——它量的是真实字节。
  let staged = 0;
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
      title,title_source,input_preview,input_preview_kind,reply_preview,reply_shape,
      interrupt_count,purpose_revision,purpose_version,purpose_chain,algorithm,retention_state,basis_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')`, [
      generation, row.req_id, row.input_epoch, row.input_revision, row.sort_source,
      row.sort_key, row.started_ms,
      // 可读时留空，由摘要阶段写本次重算的值；不可读时原样保留旧列。
      // 形状位不进摘要阶段：正文在手时当场判定，不可读时保留旧值。
      readable ? null : row.title,
      readable ? null : row.title_source,
      readable ? null : row.input_preview,
      readable ? null : row.input_preview_kind,
      readable ? null : row.reply_preview,
      body === null ? row.reply_shape : replyShapeOf(body.reply),
      // 中断计数先暂存旧值：摘要阶段 delta 在手才按本次增量重算并覆盖。
      row.interrupt_count,
      row.purpose_revision, row.purpose_version, row.purpose_chain,
      DERIVE_ALGORITHM, readable ? 'recomputed' : 'retained',
    ]);
    writes += 1;
    staged += 512 + (calls.length + results.length) * 256;
    for (const call of calls) {
      db.run(`INSERT INTO derive_call_work(generation,req_id,ord,call_id,tool_name,
        arg_path,arg_skill,request_index,traversal_ord) VALUES (?,?,?,?,?,?,?,-1,-1)`,
      [generation, row.req_id, call.ord, call.id, call.name, call.argPath, call.argSkill]);
      writes += 1;
    }
    for (const result of results) {
      db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,
        preview,is_error,request_index,traversal_ord,confirmed) VALUES (?,?,?,?,?,?,?,-1,-1,0)`,
      [generation, row.req_id, result.ord, result.path, result.id,
        previewText(result.value), result.isError]);
      writes += 1;
    }
    if (performance.now() - rowStarted > budget.maxRequestMs) {
      throw new Error('slice_request_budget');
    }
  }
  const last = page[page.length - 1]!.req_id;
  db.run(`UPDATE derive_generation SET cursor_req_id=?,
    request_count=request_count+?,staged_bytes=staged_bytes+? WHERE generation=?`,
  [last, page.length, staged, generation]);
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
      sliceDiscardReason(store, generation, error, now);
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

// ---------------------------------------------------------------------------
// 角色阶段：逐请求扫祖先定关系，再按遍历序传播主链角色。
// ---------------------------------------------------------------------------

const ROLE_STAGES = new Set(['roles', 'role_assign']);

type RoleGen = {
  state: string; stage: string; conv_key: string; actor: string;
  group_epoch: string; input_revision: number;
  role_scan_ord: number; role_assign_ord: number; role_root_req: number | null;
};

const ROLE_GEN_COLUMNS = `state,stage,conv_key,actor,group_epoch,input_revision,
  role_scan_ord,role_assign_ord,role_root_req`;

const ROLE_WORK_COLUMNS = `req_id,traversal_ord,started_ms,participating,parent_req_id,
  relation,fingerprints_json,scan_ord,best_parent_req,best_parent_len,
  saw_earlier,unreadable_earlier,state,in_trunk`;

type RoleWork = {
  req_id: number; traversal_ord: number; started_ms: number; participating: number;
  parent_req_id: number | null; relation: string | null; fingerprints_json: string | null;
  scan_ord: number; best_parent_req: number | null; best_parent_len: number | null;
  saw_earlier: number; unreadable_earlier: number; state: string; in_trunk: number;
};

/** 阶段步进的结果：`work` 表示又推进了一步，另外两种表示这次调用到头了。 */
type StageOutcome = { kind: 'work' | 'advanced' | 'stalled'; stage: string | null;
  rows: number; writes: number };

function roleGen(db: Database, generation: string): RoleGen | null {
  return one<RoleGen>(db,
    `SELECT ${ROLE_GEN_COLUMNS} FROM derive_generation WHERE generation=?`, [generation]);
}

function roleWork(db: Database, generation: string, reqId: number): RoleWork | null {
  return one<RoleWork>(db, `SELECT ${ROLE_WORK_COLUMNS} FROM derive_role_work
    WHERE generation=? AND req_id=?`, [generation, reqId]);
}

/**
 * 本笔的顺序是否被证据证实。
 *
 * 判据只看同一个 `started_ms` 桶：`uncertainOrderIds` 比的是桶内的来源位置，
 * 不跨桶，所以不必把整组的排序键都读进来。
 */
function requestUncertain(db: Database, generation: string, startedMs: number,
  reqId: number): boolean {
  const bucket = db.query<LogicalRow, [string, number]>(`
    SELECT req_id,started_ms,sort_source,sort_key FROM derive_request_result
    WHERE generation=? AND started_ms=?`).all(generation, startedMs);
  return uncertainOrderIds(bucket).has(reqId);
}

/**
 * 这一笔扫完祖先后的关系结算。
 *
 * 结算唯一落在共享内核的 `settleRelation`：扫描侧（`scanRoleStep`）只累计三个量
 * ——最长完整前缀祖先、前面有没有参与请求、有没有不可比祖先——与同步路径的
 * `matchPredecessor` 消费同一份判据，不再各自维护一套结论规则。
 */
function finishRoleWork(db: Database, generation: string, work: RoleWork): void {
  let relation = 'unknown';
  let parent: number | null = null;
  let delta: number[] | null = null;
  if (work.participating !== 1) {
    relation = 'aux';
  } else if (work.fingerprints_json === null) {
    relation = 'unknown';
  } else {
    const settled = settleRelation({
      current: JSON.parse(work.fingerprints_json) as string[],
      parent: work.best_parent_len === null ? null
        : { reqId: work.best_parent_req!, length: work.best_parent_len },
      sawEarlier: work.saw_earlier === 1,
      unreadableEarlier: work.unreadable_earlier === 1,
    });
    relation = settled.relation;
    parent = settled.parent;
    delta = settled.delta;
  }
  db.run(`UPDATE derive_request_result SET prev_req_id=?,prev_relation=?,delta_ordinals=?
    WHERE generation=? AND req_id=?`,
  [parent, relation, delta === null ? null : JSON.stringify(delta), generation, work.req_id]);
  // 父节点也要写回工作行：角色传播靠它继承主链，只存在结果行里就读不到了。
  db.run(`UPDATE derive_role_work SET relation=?,parent_req_id=?,state='done'
    WHERE generation=? AND req_id=?`,
  [relation, parent, generation, work.req_id]);
  if (work.participating === 1) {
    // 只有参与请求进祖先台账。指纹为空的那些（正文不可读或顺序未证实）照样占一行：
    // 后续请求要凭它知道"前面有参与请求"以及"那段证据不可比"。
    db.run(`INSERT OR REPLACE INTO derive_chain_work(generation,req_id,traversal_ord,
      fingerprints_json,participating,byte_length) VALUES (?,?,?,?,1,?)`,
    [generation, work.req_id, work.traversal_ord, work.fingerprints_json,
      work.fingerprints_json === null ? 0 : Buffer.byteLength(work.fingerprints_json, 'utf8')]);
  }
  db.run('UPDATE derive_generation SET role_scan_ord=? WHERE generation=?',
    [work.traversal_ord, generation]);
  // 结果是否落在"确定新增"的 ord 上：first 整笔新增、confirmed 只看增量的
  // 判据住在 derive-decision（confirmedDeltaOf），同步配对阶段走同一份。
  // 关系未知、分支与排除用途都不构成"本轮新增"。
  const confirmedDelta = confirmedDeltaOf(relation, delta);
  const rows = db.query<{ ord: number }, [string, number]>(`
    SELECT ord FROM derive_result_work WHERE generation=? AND req_id=?`)
    .all(generation, work.req_id);
  for (const row of rows) {
    const confirmed = confirmedDelta.all || confirmedDelta.ords.includes(row.ord) ? 1 : 0;
    db.run('UPDATE derive_result_work SET confirmed=? WHERE generation=? AND req_id=? AND ord=?',
      [confirmed, generation, work.req_id, row.ord]);
  }
}

/** 取下一笔待处理的请求；全组扫完后选出主链根并推进到角色传播。 */
function openRoleWork(db: Database, generation: string): StageOutcome {
  const next = one<{ req_id: number; traversal_ord: number; started_ms: number;
    purpose_chain: string | null; purpose_revision: number }>(db, `
    SELECT req_id,traversal_ord,started_ms,purpose_chain,purpose_revision
    FROM derive_request_result WHERE generation=? AND traversal_ord>?
    ORDER BY traversal_ord LIMIT 1`,
  [generation, roleGen(db, generation)!.role_scan_ord]);
  if (next === null) {
    // 根与 trunk 由共享判定给出：遍历序第一个「没有可比较父节点」的参与请求是根，
    // 根的可达集是主链。早先只按 started_ms/req_id 取根会把父节点是未知行的那一笔
    // 漏掉，与同步路径分叉——判据收进 chainTrunkRoot/chainTrunk 后只剩一个位置。
    // 成员归属在收尾的这个事务里写进工作行，角色传播按它读，不再逐行从父行继承；
    // 长组这里是单笔事务里最多的一次写入（每行一列），量级与同步路径整组重算相当。
    const nodes = db.query<{ req_id: number; parent_req_id: number | null;
      participating: number; relation: string | null }, [string]>(`
      SELECT req_id,parent_req_id,participating,relation FROM derive_role_work
      WHERE generation=? ORDER BY traversal_ord`).all(generation);
    const chain = nodes.filter(row => row.participating === 1
        && row.relation !== null && row.relation !== 'unknown')
      .map(row => ({ reqId: row.req_id, parentReqId: row.parent_req_id }));
    const root = chainTrunkRoot(chain);
    const trunk = chainTrunk(chain, root);
    const mark = db.prepare(
      'UPDATE derive_role_work SET in_trunk=? WHERE generation=? AND req_id=?');
    for (const node of chain) mark.run(trunk.has(node.reqId) ? 1 : 0, generation, node.reqId);
    db.run(`UPDATE derive_generation SET stage='role_assign',role_assign_ord=-1,
      role_root_req=? WHERE generation=?`, [root, generation]);
    return { kind: 'advanced', stage: 'role_assign', rows: 0, writes: chain.length + 2 };
  }
  const current = one<{ purpose_revision: number }>(db,
    'SELECT purpose_revision FROM request WHERE req_id=?', [next.req_id]);
  // 用途在物化之后被重判过：这一代消费的是旧结论。组被标脏时上面那步已经拦下，
  // 这里是结论没变但也换了修订的那一档——照旧不能让它拿着旧修订发布。
  if ((current?.purpose_revision ?? -1) !== next.purpose_revision) {
    throw new Error('slice_purpose_revision_changed');
  }
  const participating = next.purpose_chain === 'participate' ? 1 : 0;
  const comparable = participating === 1
    && !requestUncertain(db, generation, next.started_ms, next.req_id);
  const fingerprints = comparable ? fingerprintsOf(db, next.req_id) : null;
  db.run(`INSERT INTO derive_role_work(generation,req_id,traversal_ord,started_ms,
    participating,parent_req_id,relation,fingerprints_json,scan_ord,best_parent_req,
    best_parent_len,saw_earlier,unreadable_earlier,state)
    VALUES (?,?,?,?,?,NULL,NULL,?,-1,NULL,NULL,0,0,'scanning')`,
  [generation, next.req_id, next.traversal_ord, next.started_ms, participating,
    fingerprints === null ? null : JSON.stringify(fingerprints)]);
  return { kind: 'work', stage: 'roles', rows: 1, writes: 1 };
}

/**
 * 一页祖先的扫描。游标是祖先的 `traversal_ord`（chain_work 已按它建索引），
 * 累计的比对状态写回工作行；页为空才结算。崩溃或丢弃后重跑从 `scan_ord` 继续，
 * 祖先数组不跨页保留。
 */
function scanRoleStep(db: Database, generation: string, budget: DeriveBudget): StageOutcome {
  const work = one<RoleWork>(db, `SELECT ${ROLE_WORK_COLUMNS} FROM derive_role_work
    WHERE generation=? AND state='scanning' ORDER BY traversal_ord LIMIT 1`, [generation]);
  if (work === null) return openRoleWork(db, generation);
  if (work.participating !== 1 || work.fingerprints_json === null) {
    finishRoleWork(db, generation, work);
    return { kind: 'work', stage: 'roles', rows: 1, writes: 4 };
  }
  const current = JSON.parse(work.fingerprints_json) as string[];
  const page = db.query<{ req_id: number; traversal_ord: number; fingerprints_json: string | null },
    [string, number, number, number]>(`
    SELECT req_id,traversal_ord,fingerprints_json FROM derive_chain_work
    WHERE generation=? AND traversal_ord>? AND traversal_ord<?
    ORDER BY traversal_ord LIMIT ?`)
    .all(generation, work.scan_ord, work.traversal_ord, budget.maxCandidatesPerBatch);
  let bestReq = work.best_parent_req;
  let bestLen = work.best_parent_len;
  let saw = work.saw_earlier;
  let unreadable = work.unreadable_earlier;
  for (const ancestor of page) {
    saw = 1;
    if (ancestor.fingerprints_json === null) { unreadable = 1; continue; }
    const previous = JSON.parse(ancestor.fingerprints_json) as string[];
    const shared = commonPrefix(previous, current);
    // 公共长度为零的祖先不构成证据：空序列是任何序列的前缀，认它当父节点等于
    // 用"那一笔没有消息"证明"本笔续自它"。长度相同保留先遇到的那个。
    if (shared > 0 && shared === previous.length
        && (bestLen === null || previous.length > bestLen)) {
      bestReq = ancestor.req_id;
      bestLen = previous.length;
    }
  }
  const last = page.length === 0 ? work.traversal_ord : page[page.length - 1]!.traversal_ord;
  db.run(`UPDATE derive_role_work SET scan_ord=?,best_parent_req=?,best_parent_len=?,
    saw_earlier=?,unreadable_earlier=? WHERE generation=? AND req_id=?`,
  [last, bestReq, bestLen, saw, unreadable, generation, work.req_id]);
  if (page.length > 0) return { kind: 'work', stage: 'roles', rows: 0, writes: 1 };
  finishRoleWork(db, generation, roleWork(db, generation, work.req_id)!);
  return { kind: 'work', stage: 'roles', rows: 1, writes: 5 };
}

/**
 * 一页主链角色传播。
 *
 * trunk 归属已在角色扫描收尾时由共享判定（`chainTrunkRoot`/`chainTrunk`）写进
 * 工作行，这里只把它翻成角色：排除用途写 aux；参与但关系未知的行保持中性 main，
 * 不误标分支；其余按 in_trunk 给 main/branch。角色传播不碰标题与摘要。
 */
function assignRoleStep(db: Database, generation: string, gen: RoleGen,
  budget: DeriveBudget): StageOutcome {
  const pageSize = Math.max(1, Math.min(budget.maxCandidatesPerBatch, budget.maxWritesPerBatch));
  const rows = db.query<RoleWork, [string, number, number]>(`SELECT ${ROLE_WORK_COLUMNS}
    FROM derive_role_work WHERE generation=? AND traversal_ord>?
    ORDER BY traversal_ord LIMIT ?`).all(generation, gen.role_assign_ord, pageSize);
  if (rows.length === 0) {
    db.run("UPDATE derive_generation SET stage='tools' WHERE generation=?", [generation]);
    return { kind: 'advanced', stage: 'tools', rows: 0, writes: 1 };
  }
  for (const row of rows) {
    let role: string;
    if (row.participating !== 1) {
      role = 'aux';
    } else if (row.relation === null || row.relation === 'unknown') {
      role = 'main';
    } else {
      role = row.in_trunk === 1 ? 'main' : 'branch';
    }
    db.run('UPDATE derive_request_result SET chain_role=? WHERE generation=? AND req_id=?',
      [role, generation, row.req_id]);
  }
  db.run('UPDATE derive_generation SET role_assign_ord=? WHERE generation=?',
    [rows[rows.length - 1]!.traversal_ord, generation]);
  return { kind: 'work', stage: 'role_assign', rows: rows.length, writes: rows.length + 1 };
}

function roleStep(db: Database, generation: string, budget: DeriveBudget): StageOutcome {
  const gen = roleGen(db, generation);
  if (gen === null || gen.state !== 'building') {
    return { kind: 'stalled', stage: gen?.stage ?? null, rows: 0, writes: 0 };
  }
  if (!ROLE_STAGES.has(gen.stage)) {
    return { kind: 'stalled', stage: gen.stage, rows: 0, writes: 0 };
  }
  if (!assertQueueRevision(db, gen)) throw new Error('slice_group_revision_changed');
  return gen.stage === 'role_assign'
    ? assignRoleStep(db, generation, gen, budget)
    : scanRoleStep(db, generation, budget);
}

/**
 * 角色阶段。一次调用连续跑到预算用尽：每一步一个写事务，步与步之间可以被打断，
 * 中断后从 `role_scan_ord`/`role_assign_ord` 接着走。
 */
export function sliceRolesStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const head = roleGen(store.read, generation);
  if (head === null || head.state !== 'building') {
    return { status: 'idle', generation, stage: head?.stage ?? null, rows: 0, batch_ms: elapsed() };
  }
  if (!ROLE_STAGES.has(head.stage)) {
    return { status: 'idle', generation, stage: head.stage, rows: 0, batch_ms: elapsed() };
  }

  let rows = 0;
  let writes = 0;
  let stage: string = head.stage;
  for (;;) {
    let outcome: StageOutcome;
    try {
      outcome = store.write(db => roleStep(db, generation, budget));
    } catch (error) {
      sliceDiscardReason(store, generation, error, now);
      return { status: 'discarded', generation, stage: null, rows, batch_ms: elapsed() };
    }
    if (outcome.stage !== null) stage = outcome.stage;
    rows += outcome.rows;
    writes += outcome.writes;
    if (outcome.kind !== 'work') {
      return { status: outcome.kind === 'advanced' ? 'advanced' : 'idle', generation,
        stage: outcome.stage, rows, batch_ms: elapsed() };
    }
    if (writes >= budget.maxWritesPerBatch || elapsed() >= budget.maxStageBatchMs) {
      return { status: 'advanced', generation, stage, rows, batch_ms: elapsed() };
    }
  }
}

// ---------------------------------------------------------------------------
// 工具阶段：把候选配成往返，写进这一代的工具结果表。
// ---------------------------------------------------------------------------

/** 一页处理多少笔请求。页是事务边界，也是一次调用里最小的可续跑单位。 */
const TOOL_PAGE_MAX = 20;

type ToolGen = {
  state: string; stage: string; conv_key: string; actor: string;
  group_epoch: string; input_revision: number; tool_cursor_ord: number;
};

const TOOL_GEN_COLUMNS = `state,stage,conv_key,actor,group_epoch,input_revision,tool_cursor_ord`;

type CandidateCall = { req_id: number; ord: number };
type CallWork = {
  req_id: number; ord: number; call_id: string; tool_name: string | null;
  arg_path: string | null; arg_skill: string | null;
};
type ResultWork = {
  req_id: number; ord: number; path: string; call_id: string;
  confirmed: number; traversal_ord: number; is_error: number;
};
type OrderRow = {
  started_ms: number; sort_source: string | null; sort_key: string | null;
};

/** 一条工具行的算法依据：这一代与调用身份，足以复现配对输入。 */
function toolBasis(generation: string, callId: string): string {
  return JSON.stringify({ generation, call_id: callId, algorithm: DERIVE_ALGORITHM });
}

function orderOf(db: Database, generation: string, reqId: number): LogicalRow | null {
  return one<LogicalRow>(db, `SELECT req_id,started_ms,sort_source,sort_key
    FROM derive_request_result WHERE generation=? AND req_id=?`, [generation, reqId]);
}

/**
 * 本代里可以当工具候选的 call：只算参与用途的请求。
 *
 * 候选集合就是同 `call_id` 的参与调用——多于一笔即 ambiguous。为了不依赖
 * "调用行是否已经写进结果表"，这里直接数 work 行：先写调用再配对的那套顺序
 * 约束就不存在了，页与页之间也不会因为顺序不同而给出不同的判定。
 */
function candidateCalls(db: Database, generation: string, callId: string): CandidateCall[] {
  return db.query<CandidateCall, [string, string]>(`
    SELECT c.req_id AS req_id,c.ord AS ord FROM derive_call_work c
    JOIN derive_request_result d ON d.generation=c.generation AND d.req_id=c.req_id
    WHERE c.generation=? AND c.call_id=? AND d.purpose_chain='participate'
    ORDER BY c.traversal_ord,c.req_id,c.ord`).all(generation, callId);
}

/**
 * 一笔请求的工具配对。
 *
 * 阶梯顺序（多候选 → 结果必须更晚 → 同毫秒顺序可证 → resolved 终态 →
 * 未确认增量只建 pending 且保留首见位置）在共享内核的 `pairOutcome` 里，
 * 与同步路径的 `pairToolCallsTx` 消费同一份判据；这里只读 work 行与结果行、
 * 把结论写进本代的工具结果表，不读正文。
 */
function pairRequestTools(db: Database, generation: string, reqId: number): number {
  const own = one<{ purpose_chain: string }>(db, `SELECT purpose_chain
    FROM derive_request_result WHERE generation=? AND req_id=?`, [generation, reqId]);
  // 排除用途是旁路：既不进候选，也不产生工具行。
  if (own === null || own.purpose_chain !== 'participate') return 0;
  const calls = db.query<CallWork, [string, number]>(`
    SELECT req_id,ord,call_id,tool_name,arg_path,arg_skill FROM derive_call_work
    WHERE generation=? AND req_id=? ORDER BY ord`).all(generation, reqId);
  let writes = 0;
  for (const call of calls) {
    const candidates = candidateCalls(db, generation, call.call_id);
    db.run(`INSERT INTO derive_tool_result(generation,req_id,ord,call_id,tool_name,
      arg_path,arg_skill,result_req,result_ord,result_path,is_error,state,
      algorithm_version,basis_json,retention_state)
      VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,?,'recomputed')`,
    [generation, call.req_id, call.ord, call.call_id, call.tool_name,
      call.arg_path, call.arg_skill,
      initialPairState(candidates.length), DERIVE_ALGORITHM,
      toolBasis(generation, call.call_id)]);
    writes += 1;
    const results = db.query<ResultWork, [string, string]>(`
      SELECT w.req_id,w.ord,w.path,w.call_id,w.confirmed,w.traversal_ord,w.is_error
      FROM derive_result_work w
      JOIN derive_request_result d ON d.generation=w.generation AND d.req_id=w.req_id
      WHERE w.generation=? AND w.call_id=? AND d.purpose_chain='participate'
      ORDER BY w.traversal_ord,w.req_id,w.ord,w.path`).all(generation, call.call_id);
    const callOrder = orderOf(db, generation, call.req_id);
    for (const result of results) {
      if (candidates.length > 1) {
        // 多候选保持 ambiguous，结果位置与失败位照样记下，便于人工核对。
        for (const candidate of candidates) {
          db.run(`UPDATE derive_tool_result SET result_req=?,result_ord=?,result_path=?,
            is_error=?,state='ambiguous' WHERE generation=? AND req_id=? AND ord=?`,
          [result.req_id, result.ord, result.path, result.is_error,
            generation, candidate.req_id, candidate.ord]);
        }
        writes += candidates.length;
        continue;
      }
      const resultOrder = orderOf(db, generation, result.req_id);
      if (callOrder === null || resultOrder === null) continue;
      const paired = one<{ state: string }>(db, `SELECT state FROM derive_tool_result
        WHERE generation=? AND req_id=? AND ord=?`, [generation, call.req_id, call.ord]);
      const outcome = pairOutcome({
        candidateCount: candidates.length,
        resultLater: compareLogicalOrder(callOrder, resultOrder) < 0,
        orderCertain: callOrder.started_ms !== resultOrder.started_ms
          || (!requestUncertain(db, generation, callOrder.started_ms, call.req_id)
            && !requestUncertain(db, generation, resultOrder.started_ms, result.req_id)),
        alreadyResolved: paired?.state === 'resolved',
        alreadyPending: paired?.state === 'pending',
        resultConfirmed: result.confirmed === 1,
      });
      if (outcome === 'skip') continue;
      db.run(`UPDATE derive_tool_result SET result_req=?,result_ord=?,result_path=?,
        is_error=?,state=? WHERE generation=? AND req_id=? AND ord=?`,
      [result.req_id, result.ord, result.path, result.is_error, outcome,
        generation, call.req_id, call.ord]);
      writes += 1;
    }
  }
  return writes;
}

function toolGen(db: Database, generation: string): ToolGen | null {
  return one<ToolGen>(db,
    `SELECT ${TOOL_GEN_COLUMNS} FROM derive_generation WHERE generation=?`, [generation]);
}

/** 一页请求的工具配对。工具行数与游标在同一事务里前进。 */
function toolStep(db: Database, generation: string, budget: DeriveBudget): StageOutcome {
  const gen = toolGen(db, generation);
  if (gen === null || gen.state !== 'building') {
    return { kind: 'stalled', stage: gen?.stage ?? null, rows: 0, writes: 0 };
  }
  if (gen.stage !== 'tools') {
    return { kind: 'stalled', stage: gen.stage, rows: 0, writes: 0 };
  }
  if (!assertQueueRevision(db, gen)) throw new Error('slice_group_revision_changed');
  const page = db.query<{ req_id: number; traversal_ord: number }, [string, number, number]>(`
    SELECT DISTINCT c.req_id,c.traversal_ord FROM derive_call_work c
    JOIN derive_request_result d ON d.generation=c.generation AND d.req_id=c.req_id
    WHERE c.generation=? AND c.traversal_ord>? AND d.purpose_chain='participate'
    ORDER BY c.traversal_ord,c.req_id LIMIT ?`)
    .all(generation, gen.tool_cursor_ord, Math.min(TOOL_PAGE_MAX, budget.maxCandidatesPerBatch));
  if (page.length === 0) {
    // 收尾校验：每个参与请求的每一笔 call work 都必须有结果行。少一行就说明配对
    // 漏了片段，这一代不能带着一套不完整的工具行发布。
    const missing = count(db, `SELECT COUNT(*) FROM derive_call_work c
      JOIN derive_request_result d ON d.generation=c.generation AND d.req_id=c.req_id
      WHERE c.generation=? AND d.purpose_chain='participate'
        AND NOT EXISTS (SELECT 1 FROM derive_tool_result t WHERE t.generation=c.generation
          AND t.req_id=c.req_id AND t.ord=c.ord)`, [generation]);
    if (missing > 0) throw new Error('slice_tool_coverage');
    db.run(`UPDATE derive_generation SET stage='summary',summary_cursor_ord=-1
      WHERE generation=?`, [generation]);
    return { kind: 'advanced', stage: 'summary', rows: 0, writes: 1 };
  }
  let writes = 0;
  let rows = 0;
  for (const request of page) {
    const inserted = pairRequestTools(db, generation, request.req_id);
    writes += inserted;
    // 工具行数只统计真正写进去的调用：发布时的覆盖校验拿它与结果表比。
    if (inserted > 0) rows += 1;
  }
  db.run('UPDATE derive_generation SET tool_cursor_ord=?,tool_count=tool_count+? WHERE generation=?',
    [page[page.length - 1]!.traversal_ord, rows, generation]);
  return { kind: 'work', stage: 'tools', rows, writes: writes + 2 };
}

/**
 * 工具阶段。与角色阶段同构：一步一页、一页一个写事务，超预算停在
 * `tool_cursor_ord`，下一次从那里接着配。结果只写这一代的工具结果表，
 * 不碰 `request`/`tool_call` 旧表——读口径的切换由发布指针完成。
 */
export function sliceToolsStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const head = toolGen(store.read, generation);
  if (head === null || head.state !== 'building') {
    return { status: 'idle', generation, stage: head?.stage ?? null, rows: 0, batch_ms: elapsed() };
  }
  if (head.stage !== 'tools') {
    return { status: 'idle', generation, stage: head.stage, rows: 0, batch_ms: elapsed() };
  }

  let rows = 0;
  let writes = 0;
  for (;;) {
    let outcome: StageOutcome;
    try {
      outcome = store.write(db => toolStep(db, generation, budget));
    } catch (error) {
      sliceDiscardReason(store, generation, error, now);
      return { status: 'discarded', generation, stage: null, rows, batch_ms: elapsed() };
    }
    rows += outcome.rows;
    writes += outcome.writes;
    if (outcome.kind !== 'work') {
      return { status: outcome.kind === 'advanced' ? 'advanced' : 'idle', generation,
        stage: outcome.stage, rows, batch_ms: elapsed() };
    }
    if (writes >= budget.maxWritesPerBatch || elapsed() >= budget.maxStageBatchMs) {
      return { status: 'advanced', generation, stage: 'tools', rows, batch_ms: elapsed() };
    }
  }
}

// ---------------------------------------------------------------------------
// 摘要阶段：标题、输入摘要与回复摘要。
//
// 展示分支住在共享内核的 `presentationDecision`，两条路径消费同一份判据；
// 这里读的是**当前** `request` 行（用途、标题、旧预览都是事实，不是这一代物化
// 那一刻的快照），写的是本代的结果行。
// ---------------------------------------------------------------------------

/** 一页写多少笔摘要。页是事务边界，也是一次调用里最小的可续跑单位。 */
const SUMMARY_PAGE_MAX = 50;

type SummaryGen = {
  state: string; stage: string; conv_key: string; actor: string; group_epoch: string;
  input_revision: number; summary_cursor_ord: number;
};

const SUMMARY_GEN_COLUMNS =
  'state,stage,conv_key,actor,group_epoch,input_revision,summary_cursor_ord';

/** 摘要阶段一行要的事实：暂存行给增量与消费过的用途修订，当前请求行给展示输入。 */
type SummaryRow = {
  req_id: number; traversal_ord: number; started_ms: number; delta_ordinals: string | null;
  staged_interrupt_count: number | null;
  staged_purpose_revision: number; live_purpose_revision: number;
  purpose_chain: string; req_kind: string | null; model_served: string | null;
  model_title: string | null; agent: string | null;
  live_title: string | null; live_title_source: string | null;
  live_input_preview: string | null; live_input_preview_kind: string | null;
  live_reply_preview: string | null;
};

function summaryGen(db: Database, generation: string): SummaryGen | null {
  return one<SummaryGen>(db,
    `SELECT ${SUMMARY_GEN_COLUMNS} FROM derive_generation WHERE generation=?`, [generation]);
}

/**
 * 本页要用的工具往返，按**结果所属请求**取。
 *
 * 关联行的 `req_id` 是发起调用的那一笔，与回传结果的那一笔可能隔着页边界：
 * 按调用侧筛会让同一份结果在不同页大小下得到不同的摘要，而摘要正是文档里
 * 说"只从本次确定下来的关联取"的那个东西。
 */
function pageAssociations(db: Database, generation: string,
  ids: readonly number[]): ResolvedTool[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query<ResolvedTool, SQLQueryBindings[]>(`
    SELECT req_id AS callReq,ord AS callOrd,call_id AS callId,tool_name AS name,
      result_req AS resultReq,result_ord AS resultOrd,result_path AS resultPath
    FROM derive_tool_result WHERE generation=? AND state='resolved'
      AND result_req IN (${placeholders})`).all(generation, ...ids);
}

/**
 * 一页请求的展示结果。
 *
 * 分支顺序（标题请求 → 正文不可读 → 增量非空 → 增量存在但为空 → 关系未知）
 * 由共享内核的 `presentationDecision` 固定；这里只做用途修订守卫、可读性判定
 * 与本代结果行的写回。
 */
function summaryStep(db: Database, generation: string, budget: DeriveBudget): StageOutcome {
  const gen = summaryGen(db, generation);
  if (gen === null || gen.state !== 'building') {
    return { kind: 'stalled', stage: gen?.stage ?? null, rows: 0, writes: 0 };
  }
  if (gen.stage !== 'summary') {
    return { kind: 'stalled', stage: gen.stage, rows: 0, writes: 0 };
  }
  if (!assertQueueRevision(db, gen)) throw new Error('slice_group_revision_changed');
  const page = db.query<SummaryRow, [string, number, number]>(`
    SELECT d.req_id,d.traversal_ord,d.started_ms,d.delta_ordinals,
      d.interrupt_count AS staged_interrupt_count,
      d.purpose_revision AS staged_purpose_revision,r.purpose_revision AS live_purpose_revision,
      r.purpose_chain,r.req_kind,r.model_served,r.model_title,r.agent,
      r.title AS live_title,r.title_source AS live_title_source,
      r.input_preview AS live_input_preview,r.input_preview_kind AS live_input_preview_kind,
      r.reply_preview AS live_reply_preview
    FROM derive_request_result d JOIN request r ON r.req_id=d.req_id
    WHERE d.generation=? AND r.actor_state='known' AND d.traversal_ord>?
    ORDER BY d.traversal_ord LIMIT ?`)
    .all(generation, gen.summary_cursor_ord,
      Math.min(SUMMARY_PAGE_MAX, budget.maxCandidatesPerBatch));
  if (page.length === 0) {
    db.run(`UPDATE derive_generation SET stage='ready',ready_cursor_ord=-1 WHERE generation=?`,
      [generation]);
    return { kind: 'advanced', stage: 'ready', rows: 0, writes: 1 };
  }
  const associations = pageAssociations(db, generation, page.map(row => row.req_id));
  const ports = presentationPortsOf(db);
  let writes = 0;
  for (const row of page) {
    const rowStarted = performance.now();
    // 用途分类器改判时在同一次写入里更新 purpose_chain/req_kind 并 bump 修订：
    // 修订不一致说明这一代消费的用途结论已经不是当前结论，整代作废，
    // 不拿新的用途去配旧的链结果。
    if (row.live_purpose_revision !== row.staged_purpose_revision) {
      throw new Error('slice_purpose_revision_changed');
    }
    // 可读性只看正文读不读得出来，不看 `body_state`：骨架损坏时正文同样读不出来，
    // 那时旧标题必须原样保留，不能标成本次重算。
    const current = fingerprintsOf(db, row.req_id);
    const replyInfo = current === null
      ? { preview: row.live_reply_preview }
      : replyInfoOf(db, row.req_id);
    // 中断计数：排除用途按规则贡献 0（排除是判定，改判行不带旧值）；确定增量
    // 在手（first/confirmed，隐含正文可读且参与）时按本次增量重算；其余场合
    // 保留物化时暂存的旧值，不冒充 0。
    const delta = row.delta_ordinals === null ? null : JSON.parse(row.delta_ordinals) as number[];
    const interruptCount = row.purpose_chain === 'exclude' ? 0
      : delta === null ? row.staged_interrupt_count : interruptCountTx(db, row.req_id, delta);
    const decision = presentationDecision(ports, {
      reqId: row.req_id,
      agent: row.agent,
      modelServed: row.model_served,
      startedMs: row.started_ms,
      isAux: row.purpose_chain === 'exclude',
      isTitle: row.req_kind === 'title',
      modelTitle: row.model_title,
      current,
      delta,
      retained: current === null
        ? {
          title: row.live_title,
          titleSource: row.live_title_source,
          inputPreview: row.live_input_preview,
          inputPreviewKind: row.live_input_preview_kind,
        }
        : null,
      replyPreview: replyInfo.preview,
    }, associations);
    db.run(`UPDATE derive_request_result SET title=?,title_source=?,input_preview=?,
      input_preview_kind=?,reply_preview=?,interrupt_count=?,retention_state=?
      WHERE generation=? AND req_id=?`,
    [decision.title, decision.titleSource, decision.inputPreview, decision.inputKind,
      decision.replyPreview, interruptCount,
      current === null ? 'retained' : 'recomputed', generation, row.req_id]);
    if (performance.now() - rowStarted > budget.maxRequestMs) {
      throw new Error('slice_summary_budget');
    }
    writes += 1;
  }
  db.run('UPDATE derive_generation SET summary_cursor_ord=? WHERE generation=?',
    [page[page.length - 1]!.traversal_ord, generation]);
  return { kind: 'work', stage: 'summary', rows: page.length, writes: writes + 1 };
}

/**
 * 摘要阶段。与角色、工具阶段同构：一步一页、一页一个写事务，超预算停在
 * `summary_cursor_ord`，下一次从那里接着写。
 */
export function sliceSummaryStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const head = summaryGen(store.read, generation);
  if (head === null || head.state !== 'building') {
    return { status: 'idle', generation, stage: head?.stage ?? null, rows: 0, batch_ms: elapsed() };
  }
  if (head.stage !== 'summary') {
    return { status: 'idle', generation, stage: head.stage, rows: 0, batch_ms: elapsed() };
  }

  let rows = 0;
  let writes = 0;
  for (;;) {
    let outcome: StageOutcome;
    try {
      outcome = store.write(db => summaryStep(db, generation, budget));
    } catch (error) {
      sliceDiscardReason(store, generation, error, now);
      return { status: 'discarded', generation, stage: null, rows, batch_ms: elapsed() };
    }
    rows += outcome.rows;
    writes += outcome.writes;
    if (outcome.kind !== 'work') {
      return { status: outcome.kind === 'advanced' ? 'advanced' : 'idle', generation,
        stage: outcome.stage, rows, batch_ms: elapsed() };
    }
    if (writes >= budget.maxWritesPerBatch || elapsed() >= budget.maxStageBatchMs) {
      return { status: 'advanced', generation, stage: 'summary', rows, batch_ms: elapsed() };
    }
  }
}

// ---------------------------------------------------------------------------
// 完成阶段：磁盘与覆盖校验、发布、构建期表回收、退役代际上限。
// ---------------------------------------------------------------------------

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

/**
 * 回收超过保留上限的退役代。
 *
 * 发布是把上一代转成 retired，不是删除：当前代与最近几代的原算法结果要留给
 * 历史详情与对照。删的是最旧的那几代，顺序按发布时间。
 */
function gcRetired(db: Database, convKey: string, actor: string, keep: number): void {
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

// ---------------------------------------------------------------------------
// 调度：一次调用推进一个组的一个阶段批次。
// ---------------------------------------------------------------------------

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
