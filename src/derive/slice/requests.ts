/** 请求物化阶段：把请求事实与工具候选落进这一代，然后定下遍历顺序。 */

import type { Database } from 'bun:sqlite';
import { readBodyTx } from '../../body';
import type { DeriveBudget } from '../../config';
import type { Store } from '../../store';
import {
  anthropicReplyCalls, anthropicRequestResults, flattenToolContent, replyShapeOf,
} from '../decision';
import { compareTraversalOrder, uncertainOrderIds, type LogicalRow } from '../read';
import { DERIVE_ALGORITHM } from '../state';
import { assertQueueRevision, one, sliceDiscardReason, type SliceStep } from './generation';

/** 单页取多少请求。页就是事务边界，取太大会让一个写事务一直占着事件循环。 */
const REQUEST_PAGE_MAX = 50;
/** 顺序写回的批大小。 */
const ORDER_WRITE_BATCH = 500;
/** 候选摘要先存比展示更长的前缀：配对确定之后才裁到最终长度。 */
const CANDIDATE_PREVIEW_LIMIT = 200;

type StageRow = {
  state: string; stage: string; conv_key: string; actor: string;
  group_epoch: string; input_revision: number; cursor_req_id: number;
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

type RequestFact = {
  req_id: number; input_epoch: string | null; input_revision: number | null;
  sort_source: string | null; sort_key: string | null; started_ms: number;
  body_state: string; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
  reply_preview: string | null; reply_shape: string | null; interrupt_count: number | null;
  purpose_revision: number; purpose_version: number | null;
  purpose_chain: string;
};

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

/**
 * 本代里，一笔请求在同一个 `started_ms` 桶内的顺序是否被证据证实。
 *
 * `uncertainOrderIds` 比的是桶内的来源位置，不跨桶，所以不必把整组的排序键都读进来。
 * 角色扫描与工具配对消费同一判定。
 */
export function requestUncertain(db: Database, generation: string, startedMs: number,
  reqId: number): boolean {
  const bucket = db.query<LogicalRow, [string, number]>(`
    SELECT req_id,started_ms,sort_source,sort_key FROM derive_request_result
    WHERE generation=? AND started_ms=?`).all(generation, startedMs);
  return uncertainOrderIds(bucket).has(reqId);
}
