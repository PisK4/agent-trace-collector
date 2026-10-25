/** 摘要阶段：标题、输入摘要与回复摘要。 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { DeriveBudget } from '../../config';
import type { Store } from '../../store';
import { presentationDecision, type ResolvedTool } from '../decision';
import { fingerprintsOf, interruptCountTx, presentationPortsOf, replyInfoOf } from '../read';
import { assertQueueRevision, one, sliceDiscardReason, type SliceStep } from './generation';

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

/** 阶段步进的结果：`work` 表示又推进了一步，另外两种表示这次调用到头了。 */
type StageOutcome = { kind: 'work' | 'advanced' | 'stalled'; stage: string | null;
  rows: number; writes: number };

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
 * 与本代结果行的写回。读的是**当前** `request` 行（用途、标题、旧预览都是事实，
 * 不是这一代物化那一刻的快照），写的是本代的结果行。
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
