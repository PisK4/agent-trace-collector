/** 工具配对阶段：把候选配成往返，写进这一代的工具结果表。 */

import type { Database } from 'bun:sqlite';
import type { DeriveBudget } from '../../config';
import type { Store } from '../../store';
import { initialPairState, pairOutcome } from '../decision';
import { compareLogicalOrder, type LogicalRow } from '../read';
import { DERIVE_ALGORITHM } from '../state';
import { assertQueueRevision, count, one, sliceDiscardReason, type SliceStep } from './generation';
import { requestUncertain } from './requests';

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

/** 阶段步进的结果：`work` 表示又推进了一步，另外两种表示这次调用到头了。 */
type StageOutcome = { kind: 'work' | 'advanced' | 'stalled'; stage: string | null;
  rows: number; writes: number };

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
