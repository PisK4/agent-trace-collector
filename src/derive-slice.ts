import { randomUUID } from 'node:crypto';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Store } from './store';
import { readBodyTx } from './body';
import {
  anthropicReplyCalls, anthropicRequestResults, commonPrefix, compareLogicalOrder,
  compareTraversalOrder, fingerprintsOf, flattenToolContent, uncertainOrderIds,
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
  'slice_purpose_revision_changed',
  'slice_request_budget',
  'slice_candidate_budget',
  'slice_tool_coverage',
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
 * 关系、父节点与增量逐条复刻同步路径的 `matchPredecessor`：父节点要求祖先序列是
 * 本笔的完整前缀且公共长度大于零（零长度祖先不构成证据），长度相同保留先遇到的那个；
 * 前面存在任何参与请求（含正文不可读的）才算"有更早的一笔"；分支关系遇到不可读或
 * 顺序未证实的祖先降为 unknown。
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
    const current = JSON.parse(work.fingerprints_json) as string[];
    if (work.best_parent_len !== null) {
      const length = work.best_parent_len;
      relation = 'confirmed';
      parent = work.best_parent_req;
      delta = current.slice(length).map((_, offset) => offset + length);
    } else if (work.saw_earlier === 0) {
      relation = 'first';
      delta = current.map((_, index) => index);
    } else {
      relation = work.unreadable_earlier === 1 ? 'unknown' : 'branch';
    }
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
  // 结果是否落在"确定新增"的 ord 上，只有这里知道：配对阶段据此决定把候选升成
  // resolved 还是留在 pending。第一次（'first'）整笔都是新增；'confirmed' 只看增量
  // 的 ord；关系未知、分支与排除用途都不构成"本轮新增"。
  const confirmedAll = relation === 'first';
  const deltaOrds = relation === 'confirmed' && delta !== null ? delta : [];
  const rows = db.query<{ ord: number }, [string, number]>(`
    SELECT ord FROM derive_result_work WHERE generation=? AND req_id=?`)
    .all(generation, work.req_id);
  for (const row of rows) {
    const confirmed = confirmedAll || deltaOrds.includes(row.ord) ? 1 : 0;
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
    // 主链根与同步路径同一判据：按遍历序第一个"没有父节点、或父节点不是可比参与请求"
    // 的参与请求。只按 started_ms/req_id 取会把父节点是未知行的那一笔漏掉，
    // 而同步路径把它当根，两边的 trunk 就会分叉。
    const root = one<{ req_id: number }>(db, `
      SELECT w.req_id AS req_id FROM derive_role_work w
      LEFT JOIN derive_role_work p ON p.generation=w.generation AND p.req_id=w.parent_req_id
      WHERE w.generation=? AND w.participating=1 AND w.relation IS NOT NULL AND w.relation<>'unknown'
        AND (w.parent_req_id IS NULL OR p.req_id IS NULL OR p.participating<>1
          OR p.relation IS NULL OR p.relation='unknown')
      ORDER BY w.traversal_ord LIMIT 1`, [generation]);
    db.run(`UPDATE derive_generation SET stage='role_assign',role_assign_ord=-1,
      role_root_req=? WHERE generation=?`, [root?.req_id ?? null, generation]);
    return { kind: 'advanced', stage: 'role_assign', rows: 0, writes: 1 };
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
 * 与同步路径的森林遍历等价：父节点的遍历序一定更早，所以按遍历序推进时父行已经
 * 定好。父节点不是可比参与请求（不存在、不参与、或关系未知）的行按根处理——
 * 同步路径的根就是"没有父节点、或父节点不在参与森林里"。排除用途写 aux；
 * 参与但关系未知的行保持中性 main。角色传播不碰标题与摘要。
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
    let inTrunk = 0;
    let role = 'main';
    if (row.participating !== 1) {
      role = 'aux';
    } else if (row.relation === null || row.relation === 'unknown') {
      role = 'main';
    } else {
      const parent = row.parent_req_id === null ? null
        : roleWork(db, generation, row.parent_req_id);
      const parentIsNode = parent !== null && parent.participating === 1
        && parent.relation !== null && parent.relation !== 'unknown';
      // 父行一定更早，它的 in_trunk 已经定好；根节点只能是本次选出的那一个。
      if (parentIsNode) inTrunk = parent!.in_trunk;
      else inTrunk = row.req_id === gen.role_root_req ? 1 : 0;
      role = inTrunk === 1 ? 'main' : 'branch';
    }
    db.run('UPDATE derive_role_work SET in_trunk=? WHERE generation=? AND req_id=?',
      [inTrunk, generation, row.req_id]);
    db.run('UPDATE derive_request_result SET chain_role=? WHERE generation=? AND req_id=?',
      [role, generation, row.req_id]);
  }
  db.run('UPDATE derive_generation SET role_assign_ord=? WHERE generation=?',
    [rows[rows.length - 1]!.traversal_ord, generation]);
  return { kind: 'work', stage: 'role_assign', rows: rows.length, writes: rows.length * 2 + 1 };
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
type CallWork = { req_id: number; ord: number; call_id: string; tool_name: string | null };
type ResultWork = {
  req_id: number; ord: number; path: string; call_id: string;
  confirmed: number; traversal_ord: number;
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
 * 一笔请求的工具配对。逐条复刻同步路径的 `pairToolCallsTx`：
 *
 * 结果必须晚于调用（同毫秒且顺序未证实不算证据）；重复回传的结果不能把已确认的
 * 配对降级；未确认的增量只建立 pending 候选，并且只记首次见到的位置。
 * 只读 work 行与结果行，不读正文。
 */
function pairRequestTools(db: Database, generation: string, reqId: number): number {
  const own = one<{ purpose_chain: string }>(db, `SELECT purpose_chain
    FROM derive_request_result WHERE generation=? AND req_id=?`, [generation, reqId]);
  // 排除用途是旁路：既不进候选，也不产生工具行。
  if (own === null || own.purpose_chain !== 'participate') return 0;
  const calls = db.query<CallWork, [string, number]>(`
    SELECT req_id,ord,call_id,tool_name FROM derive_call_work
    WHERE generation=? AND req_id=? ORDER BY ord`).all(generation, reqId);
  let writes = 0;
  for (const call of calls) {
    const candidates = candidateCalls(db, generation, call.call_id);
    db.run(`INSERT INTO derive_tool_result(generation,req_id,ord,call_id,tool_name,
      result_req,result_ord,result_path,state,algorithm_version,basis_json,retention_state)
      VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,?,'recomputed')`,
    [generation, call.req_id, call.ord, call.call_id, call.tool_name,
      candidates.length > 1 ? 'ambiguous' : 'pending', DERIVE_ALGORITHM,
      toolBasis(generation, call.call_id)]);
    writes += 1;
    const results = db.query<ResultWork, [string, string]>(`
      SELECT w.req_id,w.ord,w.path,w.call_id,w.confirmed,w.traversal_ord
      FROM derive_result_work w
      JOIN derive_request_result d ON d.generation=w.generation AND d.req_id=w.req_id
      WHERE w.generation=? AND w.call_id=? AND d.purpose_chain='participate'
      ORDER BY w.traversal_ord,w.req_id,w.ord,w.path`).all(generation, call.call_id);
    const callOrder = orderOf(db, generation, call.req_id);
    for (const result of results) {
      if (candidates.length > 1) {
        // 多候选保持 ambiguous，结果位置仍然记下，便于人工核对。
        for (const candidate of candidates) {
          db.run(`UPDATE derive_tool_result SET result_req=?,result_ord=?,result_path=?,
            state='ambiguous' WHERE generation=? AND req_id=? AND ord=?`,
          [result.req_id, result.ord, result.path, generation, candidate.req_id, candidate.ord]);
        }
        writes += candidates.length;
        continue;
      }
      const resultOrder = orderOf(db, generation, result.req_id);
      if (callOrder === null || resultOrder === null) continue;
      // 结果必须晚于调用。同一毫秒且顺序未证实时不配对：身份字典序不是证据。
      if (compareLogicalOrder(callOrder, resultOrder) >= 0) continue;
      if (callOrder.started_ms === resultOrder.started_ms
        && (requestUncertain(db, generation, callOrder.started_ms, call.req_id)
          || requestUncertain(db, generation, resultOrder.started_ms, result.req_id))) continue;
      const paired = one<{ state: string }>(db, `SELECT state FROM derive_tool_result
        WHERE generation=? AND req_id=? AND ord=?`, [generation, call.req_id, call.ord]);
      // 已确认的配对是终态：后续请求会重发整段历史，重发样本只可能把它降级成
      // pending，因此直接跳过。
      if (paired?.state === 'resolved') continue;
      if (result.confirmed !== 1) {
        // 增量关系未知：只建立候选，不标 resolved；已有候选时保留更早的位置。
        if (paired?.state === 'pending') continue;
        db.run(`UPDATE derive_tool_result SET result_req=?,result_ord=?,result_path=?,
          state='pending' WHERE generation=? AND req_id=? AND ord=?`,
        [result.req_id, result.ord, result.path, generation, call.req_id, call.ord]);
        writes += 1;
        continue;
      }
      db.run(`UPDATE derive_tool_result SET result_req=?,result_ord=?,result_path=?,
        state='resolved' WHERE generation=? AND req_id=? AND ord=?`,
      [result.req_id, result.ord, result.path, generation, call.req_id, call.ord]);
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
