import type { Database } from 'bun:sqlite';
import type { Store } from '../store';
import {
  GROUP_ALGORITHM, POSITION_ALL, POSITION_UNKNOWN, claimGroupTx, markGroupDirtyTx,
  normalizeTargetAlgorithmTx, positionKey, purposePendingSql, queuePendingSql,
} from './state';
import { drainRequestPurposesTx } from '../request-purpose';
import { readBodyTx } from '../body';
import {
  addBodyReadStats, bodyReadCounters, createBodyReadCache, emptyBodyReadStats,
} from '../body-cache';
import type { BodyReadCache, BodyReadStats } from '../body-cache';
import { planBackgroundJobs, writeBackgroundJobsTx } from './bg-jobs';
import type { BgJobPlan } from './bg-jobs';
import {
  chainRolesOf, confirmedDeltaOf, initialPairState, matchPredecessor, pairOutcome,
  presentationDecision, replyCallsOf, requestResultsOf,
} from './decision';
import type { PredecessorMatch, ResolvedTool } from './decision';
import {
  compareLogicalOrder, compareTraversalOrder, contextEventTx, fingerprintsOf, incrementalInputOf,
  interruptCountTx, presentationPortsOf, replyInfoOf, uncertainOrderIds,
} from './read';
import type { ContextEventFacts, DeriveScope, LogicalRow, ReplyInfo } from './read';

/** 派生范围由共享读取层持有；两条路径与维护入口共用同一个形状。 */
export type { DeriveScope } from './read';

/**
 * 派生的同步路径：在事务里按序读正文、整理输入形状并落库。
 *
 * 「怎么判」住在 `derive-decision.ts`，「怎么读」住在 `derive-read.ts`；
 * 这里只保留同步写 adapter 与队列完成流程。
 *
 * 归属未知（actor_state='unknown'）的请求不参与派生：不进队列、不算增量、
 * 不配工具、标题回落到模型时间。身份确认后才入队，避免跨子代理串数据。
 */

/** 只接受已确认归属的分组；调用方先守卫，这里再挡一层。 */
export function enqueueDerive(store: Store, convKey: string, actor: string, fromSort: string): void {
  store.write(db => enqueueDeriveTx(db, convKey, actor, fromSort));
}

/** 事务内版本：调用方已在事务里时用它，避免嵌套事务。 */
export function enqueueDeriveTx(db: Database, convKey: string, actor: string, fromSort: string): void {
  const known = db.query<{ req_id: number }, [string, string]>(`
    SELECT req_id FROM request
    WHERE conv_key=? AND actor=? AND actor_state='known' LIMIT 1`).get(convKey, actor);
  if (known == null) return;
  markGroupDirtyTx(db, convKey, actor, fromSort);
}

type ChainRow = {
  req_id: number; actor: string; agent: string | null; actor_state: string; started_ms: number;
  sort_source: string | null; sort_key: string | null;
  prev_req_id: number | null; prev_relation: string | null;
  title_source: string | null; title: string | null; model_served: string | null;
  req_kind: string | null; model_title: string | null; purpose_chain: string;
  input_preview: string | null; input_preview_kind: string | null; reply_preview: string | null;
  reply_shape: string | null; interrupt_count: number | null; context_event: string | null;
};

/** 链阶段为摘要准备的输入：本轮关系、当前可读序列与用途结论。 */
type PresentationInput = {
  row: ChainRow; current: readonly string[] | null;
  replyInfo: ReplyInfo; isAux: boolean; isTitle: boolean; modelTitle: string | null;
  match: PredecessorMatch;
  /** 本笔确定增量的中断计数；delta 为 null 时沿用旧行值，不冒充 0。 */
  interrupts: number | null;
  /** 本笔上下文事件位；null 表示这次判不出来，沿用旧行值。 */
  context: ContextEventFacts | null;
};

/**
 * 写标题与折叠行摘要。必须在工具配对之后调用：增量里的工具结果轮次
 * 只能消费本次确定下来的关联，不能跨组按 call_id 取首行。
 *
 * 判定在 `presentationDecision`（两条路径唯一）；这里只负责取旧值、组装输入、
 * 把判定结果连同摘要依据写回 `request` 行。
 *
 * 正文可读时标题从当前输入重算，不沿用旧派生值；正文不可读时旧标题与旧摘要
 * 原样保留——那是当时按正文算出来的，没有正文重算只会把它们降级成时间兜底。
 */
/** 展示阶段的待写列值：标题、摘要依据与可比较位；落库段按同一 SQL 写回。 */
type PresentationWrite = {
  reqId: number;
  title: string | null; titleSource: string | null; inputPreview: string | null;
  inputKind: string | null; replyPreview: string | null; replyShape: string | null;
  interruptCount: number | null; contextEvent: string | null;
  comparable: boolean; basis: string;
  /** 本次写入是否真的改变行内容；未变化时落库段跳过，derive_version 也不加一。 */
  changed: boolean;
};

function presentationWrite(db: Database, input: PresentationInput,
  associations: readonly ResolvedTool[], group: QueuedGroup, bodyCache: BodyReadCache): PresentationWrite {
  const { row, current, replyInfo, isAux, isTitle, modelTitle, match, interrupts, context } = input;
  const decision = presentationDecision(presentationPortsOf(db, bodyCache), {
    reqId: row.req_id,
    agent: row.agent,
    modelServed: row.model_served,
    startedMs: row.started_ms,
    isAux,
    isTitle,
    modelTitle,
    current,
    delta: match.delta,
    retained: current === null
      ? {
        title: row.title,
        titleSource: row.title_source,
        inputPreview: row.input_preview,
        inputPreviewKind: row.input_preview_kind,
      }
      : null,
    replyPreview: replyInfo.preview,
  }, associations);
  // 摘要与标题是派生结果，不是来源事实：可比较时记下算法与本次消费的输入身份，
  // 不可比较时保留原算法与 basis 只把状态标成 retained——不能把旧值冒充成本次重算。
  const inputRow = db.query<{
    input_epoch: string; input_revision: number;
    summary_algorithm: number | null; summary_basis: string | null; summary_state: string | null;
  }, [number]>(
    'SELECT input_epoch,input_revision,summary_algorithm,summary_basis,summary_state FROM request WHERE req_id=?')
    .get(row.req_id);
  const basis = JSON.stringify({
    epoch: inputRow?.input_epoch ?? '', input_revision: inputRow?.input_revision ?? 0,
    group_epoch: group.group_epoch, algorithm: GROUP_ALGORITHM,
    ...(context !== null && context.event !== null
      ? { context_event: context.event, dropped_chars: context.droppedChars } : {}),
  });
  const comparable = current !== null;
  // 形状位与摘要同一套保留语义：正文可读时按本次 reply 重算，不可读时保留
  // 派生时的旧值（回收不清除不重算；升级前从未算过的行保持 NULL，由回填收口）。
  const replyShape = replyInfo.shape ?? row.reply_shape;
  // 中断计数同一套保留语义：delta 在手时按本次增量计，其余场合沿用旧值。
  const interruptCount = interrupts ?? row.interrupt_count;
  // 上下文事件位同一套保留语义：判定在手时按本次写，判不出来沿用旧值。
  const contextEvent = context?.event ?? row.context_event;
  const summaryAlgorithm = comparable ? GROUP_ALGORITHM : inputRow?.summary_algorithm ?? null;
  const summaryBasis = comparable ? basis : inputRow?.summary_basis ?? null;
  const summaryState = comparable ? 'recomputed' : 'retained';
  // 整组重算常把同一批行原样写回；比较所有待写列，跳过无变化行。
  const changed =
    (row.title ?? null) !== decision.title ||
    (row.title_source ?? null) !== decision.titleSource ||
    (row.input_preview ?? null) !== decision.inputPreview ||
    (row.input_preview_kind ?? null) !== decision.inputKind ||
    (row.reply_preview ?? null) !== decision.replyPreview ||
    (row.reply_shape ?? null) !== replyShape ||
    (row.interrupt_count ?? null) !== interruptCount ||
    (row.context_event ?? null) !== contextEvent ||
    (inputRow?.summary_algorithm ?? null) !== summaryAlgorithm ||
    (inputRow?.summary_basis ?? null) !== summaryBasis ||
    (inputRow?.summary_state ?? null) !== summaryState;
  return {
    reqId: row.req_id,
    title: decision.title, titleSource: decision.titleSource,
    inputPreview: decision.inputPreview, inputKind: decision.inputKind,
    replyPreview: decision.replyPreview, replyShape, interruptCount, contextEvent,
    comparable, basis, changed,
  };
}

/** 展示列的落库：只写实际变化的行；derive_version 记录内容真正变化的次数。 */
function writePresentationTx(db: Database, write: PresentationWrite): void {
  if (!write.changed) return;
  db.run(`UPDATE request SET title=?,title_source=?,input_preview=?,
    input_preview_kind=?,reply_preview=?,reply_shape=?,interrupt_count=?,context_event=?,
    derive_version=derive_version+1,
    summary_algorithm=CASE WHEN ?=1 THEN ? ELSE summary_algorithm END,
    summary_basis=CASE WHEN ?=1 THEN ? ELSE summary_basis END,
    summary_state=CASE WHEN ?=1 THEN 'recomputed' ELSE 'retained' END
    WHERE req_id=?`, [
    write.title, write.titleSource, write.inputPreview, write.inputKind,
    write.replyPreview, write.replyShape, write.interruptCount, write.contextEvent,
    write.comparable ? 1 : 0, GROUP_ALGORITHM, write.comparable ? 1 : 0, write.basis,
    write.comparable ? 1 : 0, write.reqId,
  ]);
}

/**
 * 主链判定。同一 (conv_key, actor) 里可能同时存在几条互不相接的真实请求链
 * （标题请求已在派生时排除）。会话的第一笔真实请求是主链根，其余可证明不相接
 * 的根及其后继标 branch——分支是相对"从第一笔开始的主线"而言，不是按后续
 * 请求数重新选一次主线，否则一次后来的独立重跑会把真正的开头挤成分支。
 *
 * 严格前缀只能说明"这一笔是谁的续写"，不能说明"哪条是主线"；主线要等整组
 * 请求都到齐后再按根的时间顺序选，所以每批派生末尾重算一次。
 *
 * 角色由共享判定（`chainRolesOf`）给出：森林含关系 unknown 的节点，trunk 照旧，
 * unknown 节点及其 confirmed 后继的不确定闭包记 unknown——链上存在无法证明的
 * 环节时，后继不能因为 trunk 够不到就被读成另起一支。
 */
function planChainRoles(ordered: readonly { req_id: number; purpose_chain: string }[],
  relations: ReadonlyMap<number, { parent: number | null; relation: string }>):
  Map<number, string> {
  // 顺序按 compareTraversalOrder 全序（同位置按 req_id 兜底），先排序再筛参与用途
  // 与先筛再排序得到同一顺序；节点关系取本轮内存结论，不回读刚写下的行。
  const nodes = ordered
    .filter(row => row.purpose_chain === 'participate')
    .map(row => {
      const known = relations.get(row.req_id);
      return { reqId: row.req_id, parentReqId: known?.parent ?? null, relation: known?.relation ?? 'unknown' };
    });
  if (nodes.length === 0) return new Map();
  // trunk 与不确定闭包都在 chainRolesOf 里；切片路径按同一判据传播。
  const roles = chainRolesOf(nodes);
  return new Map(nodes.map(node => [node.reqId, roles.get(node.reqId) ?? 'branch']));
}

export type DrainResult = {
  processed: number;
  /** 当前 scope 内未完成组；省略 scope 时是全队列。 */
  remaining: number;
  /** 全部阶段已提交的组。 */
  groups: Group[];
  /** 本批具有可比较消息序列的请求，包括真实空数组。 */
  recomputed: number;
  /** 消息序列不可比较、标题与摘要按旧值保留的请求。 */
  retained: number;
  /** 本批完成用途判定的请求数。 */
  purpose_processed: number;
  /** 当前 scope 内仍待判定用途的请求数；未完成时组不能被宣布为最新。 */
  purpose_remaining: number;
  /** 本批被丢弃的未发布代际数：只有切片入口会丢，同步入口恒为 0。 */
  discarded: number;
  /** 本批同步组派生的消息块解码计数；切片路径暂不计入。 */
  body_read: BodyReadStats;
  /** 本批耗时（毫秒），供调度与容量观测使用。 */
  batch_ms: number;
};

export type DrainOptions = { limit: number; scope?: DeriveScope; purposeLimit?: number };

/**
 * 处理队列里的一批分组。每个分组按稳定顺序从头重算整条链：
 * 这样乱序到达、迟到正文与归属变化都收敛到同一个结果，与到达顺序无关。
 *
 * 链、主链角色、工具配对、摘要与队列确认在同一个同步事务内按序完成；
 * 任一阶段失败，整批回滚并保留任务。
 *
 * 这是迁移与在线共用的唯一完成入口：链、工具与摘要都没有各自的完成出口，
 * 因为任何一段单独提交都会留下"部分更新"的组。
 */
export function drainDeriveTx(db: Database, options: DrainOptions): DrainResult {
  const started = performance.now();
  const { limit, scope } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
  if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_derive_scope');
  }
  // 先完成请求用途：组阶段只消费已经定下来的用途，不在组里再识别一次。
  //
  // `limit` 按组计数，而组的完成条件是"组内没有 pending"：本次要处理的组里
  // 所有成员都必须先结算，否则一个大组会被切到多轮、迟迟不能发布。
  // `purposeLimit` 是每批大小，不是总量上限；每次都会推进，错误重试到顶后
  // 该行以 error 终态出列，所以循环会结束。
  const purposeLimit = options.purposeLimit ?? 100;
  let purposeProcessed = 0;
  let purposeRemaining = 0;
  for (;;) {
    const batch = drainRequestPurposesTx(db, purposeLimit, scope);
    purposeProcessed += batch.processed;
    purposeRemaining = batch.remaining;
    if (batch.remaining === 0 || batch.processed === 0) break;
  }
  const columns = 'conv_key,actor,group_epoch,input_revision,target_algorithm';
  const groups = scope === undefined
    ? db.query<QueuedGroup, [number]>(`SELECT ${columns} FROM derive_queue
        WHERE ${queuePendingSql()} ORDER BY conv_key,actor LIMIT ?`).all(limit)
    : db.query<QueuedGroup, [string, number]>(`SELECT ${columns} FROM derive_queue
        WHERE conv_key=? AND ${queuePendingSql()} ORDER BY actor LIMIT ?`).all(scope.convKey, limit);
  const touched: Group[] = [];
  let processed = 0;
  let recomputed = 0;
  let retained = 0;
  const bodyRead = emptyBodyReadStats();
  for (const group of groups) {
    const result = drainDeriveGroupTx(db, group.conv_key, group.actor);
    if (result === null) continue;
    processed += result.processed;
    recomputed += result.recomputed;
    retained += result.retained;
    addBodyReadStats(bodyRead, result.body_read);
    touched.push({ conv_key: group.conv_key, actor: group.actor });
  }
  const remaining = scope === undefined
    ? db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM derive_queue WHERE ${queuePendingSql()}`).get()!.n
    : db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM derive_queue
        WHERE conv_key=? AND ${queuePendingSql()}`).get(scope.convKey)!.n;
  return {
    processed, remaining, groups: touched, recomputed, retained,
    purpose_processed: purposeProcessed, purpose_remaining: purposeRemaining,
    discarded: 0, body_read: bodyRead, batch_ms: performance.now() - started,
  };
}

/** 组派生可注入读取上下文：受控测量可换成小预算缓存，生产调用不传。 */
export type DeriveGroupOptions = { bodyCache?: BodyReadCache };

/** 组派生的落库计划：计算段只读产出它，落库段用一个事务执行它。 */
export type ApplyPlan = {
  /** 认领时读到的队列身份；CAS 用 `group_epoch` 与 `input_revision` 挡住期间到达的输入。 */
  group: QueuedGroup;
  /** 认领时把旧算法号归一：落库段先写这一行，再按新号完成。 */
  normalize_algorithm: boolean;
  chain: {
    reqId: number; prevReqId: number | null; relation: string;
    deltaJson: string | null; chainRole: string; changed: boolean;
  }[];
  tools: ToolPlan;
  jobs: BgJobPlan;
  presentations: PresentationWrite[];
};

/** 一组的读数：计算段算出来，随结果交回调度方。 */
export type DeriveGroupOutcome = {
  processed: number; recomputed: number; retained: number; body_read: BodyReadStats;
};

/** 计算段的产物：待执行的计划与本次读数。 */
export type DeriveGroupRound = { plan: ApplyPlan; outcome: DeriveGroupOutcome };

/**
 * 组派生的计算段：只读，产出落库计划。
 *
 * 只读连接与写连接都能传：这一段读的都是本轮不改的行（正文、块、请求身份），
 * 本轮定下的结论全部留在内存与计划里，所以两种连接算出同一个计划。
 * 返回 `null` 表示这个组本轮不该做（不脏、还有用途未判定）。
 */
export function computeDeriveGroup(db: Database, convKey: string, actor: string,
  groupOptions: DeriveGroupOptions = {}): DeriveGroupRound | null {
  const group = db.query<QueuedGroup, [string, string]>(`
    SELECT conv_key,actor,group_epoch,input_revision,target_algorithm FROM derive_queue
    WHERE conv_key=? AND actor=? AND ${queuePendingSql()}`).get(convKey, actor);
  if (group === null) return null;
  // 认领前把队列行的目标算法归一到当前同步算法号：组变脏时旧行保留旧号，
  // 直接完成等于宣称产物是新算法算的。规则住在 derive-state，切片认领走同一个；
  // 这里只在计划里记下要归一，写留给落库段。
  const normalizeAlgorithm = group.target_algorithm !== GROUP_ALGORITHM;
  if (normalizeAlgorithm) group.target_algorithm = GROUP_ALGORITHM;
  let processed = 0;
  let recomputed = 0;
  let retained = 0;
  // 组里还有未判定用途的请求时不能完成：把组算干净等于替它们猜了一个用途。
  // 这是认领后的复查（TOCTOU）：选组之后、处理之前可能又有请求挂进来。
  // 与切片选组时的外层过滤共用同一段谓词，但查询角色各自保留。
  const waiting = db.query<{ n: number }, [string, string]>(`
    SELECT COUNT(*) AS n FROM request
    WHERE conv_key=? AND actor=? AND ${purposePendingSql()}`)
    .get(group.conv_key, group.actor)!.n;
  if (waiting > 0) return null;
  // 一轮组派生只建立一个块级读取作用域：链、工具、后台作业与展示阶段
  // 共享同一份解压结果，组结束或失败即随局部变量一起释放。
  const bodyCache = groupOptions.bodyCache ?? createBodyReadCache();
  const rows = db.query<ChainRow, [string, string]>(`
    SELECT req_id, actor, agent, actor_state, started_ms, sort_source, sort_key, prev_req_id, prev_relation,
           title_source, title, model_served, req_kind, model_title, purpose_chain,
           input_preview, input_preview_kind, reply_preview, reply_shape, interrupt_count, context_event
    FROM request WHERE conv_key=? AND actor=? AND actor_state='known'`).all(group.conv_key, group.actor);
  const ordered = [...rows].sort(compareTraversalOrder);
  // 同毫秒且没有来源位置证据的请求：可以遍历，但不能用来证明先后。
  const uncertain = uncertainOrderIds(ordered);
  // 本组已处理过的请求，供后面每一笔在链上找前驱。按正序推进，
  // 所以这里只会看到"早于本笔"的祖先。
  const ancestors: { reqId: number; fingerprints: readonly string[] }[] = [];
  // 有正文不可读的祖先时，链是断的：后面那些请求即使对不上已知祖先，
  // 也只能算"没法比"，不能断言成"另起一支"。
  let sawEarlier = false;
  let unreadableEarlier = false;
  // 链阶段只收集；工具与摘要依赖本次配对，必须等全部关系确定后再写。
  const chain: ApplyPlan['chain'] = [];
  const pairRows: PairRow[] = [];
  const presentations: PresentationInput[] = [];
  // 本轮结论按 req_id 留一份内存副本：角色判定消费它，不再回读刚写下的行。
  const relationByReq = new Map<number, { parent: number | null; relation: string }>();
  for (const row of ordered) {
    const current = fingerprintsOf(db, row.req_id);
    // 增量输入（Responses 的 previous_response_id）不含完整历史：
    // 既不能拿它找前驱，也不能让它充当后面请求的祖先。
    const incremental = incrementalInputOf(db, row.req_id);
    const replyInfo = current === null
      ? { preview: row.reply_preview, shape: null }
      : replyInfoOf(db, row.req_id, bodyCache);
    // 用途已在请求阶段定下来：组阶段只消费 purpose_chain 与 req_kind，
    // 不再自己认一遍标题或分类器请求。两处各认一次就会出现"用途说是 chat、
    // 关系却按 title 算"的分裂。
    const isAux = row.purpose_chain === 'exclude';
    const isTitle = row.req_kind === 'title';
    const modelTitle = row.model_title;
    let match: PredecessorMatch;
    if (isAux) {
      match = { parent: null, relation: 'aux', delta: null, near: null };
    } else if (current === null) {
      // 本笔正文不可读：没法比，但也不能把上一笔的结论照抄过来。
      match = { parent: null, relation: 'unknown', delta: null, near: null };
    } else if (uncertain.has(row.req_id)) {
      // 顺序未证实：同毫秒的来源身份只够排序，不够当因果证据。
      match = { parent: null, relation: 'unknown', delta: null, near: null };
    } else if (incremental) {
      // 本笔只带新增部分：共同前缀比较没有可比对象，判成 confirmed 或 branch
      // 都是拿不完整的历史下结论。
      match = { parent: null, relation: 'unknown', delta: null, near: null };
    } else {
      // 顺序未证实的行在祖先扫描里仍占位（sawEarlier/unreadableEarlier 已记账），
      // 分支到 unknown 的降级在 settleRelation 里完成，不再由调用方修补。
      match = matchPredecessor(ancestors, current, sawEarlier, unreadableEarlier);
    }
    if (!isAux) {
      // 排除用途是旁路，不能让后面的主请求误以为"前面还有一笔可比的请求"。
      sawEarlier = true;
      // 增量输入的指纹只是本笔新增部分：链在这里断开，后面的请求对不上
      // 已知祖先时只能算"没法比"，不能断言成"另起一支"。
      if (current === null || uncertain.has(row.req_id) || incremental) unreadableEarlier = true;
    }

    const delta = match.delta;
    const deltaJson = delta === null ? null : JSON.stringify(delta);
    // 关系是本阶段唯一的写入；标题、摘要与版本留到工具配对之后。
    // req_kind/model_title 属于请求用途，不在这里覆盖。
    // 角色这里只记 aux/main 的初值，最终角色由 planChainRoles 在同一轮算出，
    // 合并后才比较：旧实现先写初值再逐行改写，等于整组白写一遍。
    chain.push({
      reqId: row.req_id, prevReqId: match.parent, relation: match.relation,
      deltaJson, chainRole: isAux ? 'aux' : 'main', changed: false,
    });
    relationByReq.set(row.req_id, { parent: match.parent, relation: match.relation });
    pairRows.push({ ...row,
      prev_relation: match.relation, delta_ordinals: deltaJson });
    // 中断计数：排除用途按规则贡献 0（排除是判定，不留 NULL，改判行也不带旧值）；
    // 确定增量在手（first/confirmed，隐含正文可读且参与）时按本次增量重算；
    // 关系未知与分支没有"新增"可言，保留旧值，不冒充 0。
    const interrupts = isAux ? 0
      : delta === null ? null : interruptCountTx(db, row.req_id, delta, bodyCache);
    // 上下文事件位：排除用途判 none（标题请求不压缩）；正文可读时按关系与
    // 增量判定，其余场合 null 保留旧值。
    const context = current === null ? null
      : contextEventTx(db, row.req_id, match.relation, match.delta, bodyCache);
    presentations.push({ row, current, replyInfo, isAux, isTitle, modelTitle, match, interrupts, context });
    if (current === null) retained += 1;
    else recomputed += 1;
    if (!isAux && current !== null && !uncertain.has(row.req_id) && !incremental) {
      ancestors.push({ reqId: row.req_id, fingerprints: current });
    }
    processed += 1;
  }
  // 角色判定消费本轮的链关系；工具配对产出的关联再喂给展示阶段。
  const roles = planChainRoles(ordered, relationByReq);
  // 合并出每行最终角色后与库里现有值比较，只写变化的行。
  const existingChain = db.query<{
    req_id: number; prev_req_id: number | null; prev_relation: string | null;
    delta_ordinals: string | null; chain_role: string;
  }, [string, string]>(`
    SELECT req_id,prev_req_id,prev_relation,delta_ordinals,chain_role
    FROM request WHERE conv_key=? AND actor=? AND actor_state='known'`)
    .all(group.conv_key, group.actor);
  const existingByReq = new Map(existingChain.map(row => [row.req_id, row]));
  for (const row of chain) {
    const finalRole = row.chainRole === 'aux' ? 'aux' : roles.get(row.reqId) ?? 'branch';
    row.chainRole = finalRole;
    const cur = existingByReq.get(row.reqId);
    row.changed = cur === undefined
      || (cur.prev_req_id ?? null) !== row.prevReqId
      || (cur.prev_relation ?? null) !== row.relation
      || (cur.delta_ordinals ?? null) !== row.deltaJson
      || cur.chain_role !== finalRole;
  }
  const tools = planToolCalls(db, group, pairRows, uncertain, bodyCache);
  const plan: ApplyPlan = {
    group, normalize_algorithm: normalizeAlgorithm,
    chain, tools,
    // 背景作业配对与工具配对同批：都在组完成事务里按当前可读正文重建。
    jobs: planBackgroundJobs(db, pairRows, bodyCache),
    presentations: presentations.map(input =>
      presentationWrite(db, input, tools.associations, group, bodyCache)),
  };
  return {
    plan,
    outcome: {
      processed, recomputed, retained,
      body_read: bodyReadCounters(bodyCache.snapshot()),
    },
  };
}

/**
 * 落库段：一个事务按序执行计划。
 *
 * 计划算完之后输入可能又变过。输入没变时整组落库并清脏；变过时只写「最早受影响
 * 位置」之前的行——这些行的祖先与自身输入都没变，本轮算出的值仍然成立。位置之后
 * 的行一行都不写，组保持 dirty，等下一轮补齐。组身份或目标算法变过则整轮作废。
 *
 * 边界按库里此刻的 `started_ms` 取，不按计划算时的位置：迟到账本会改写开始时刻，
 * 计划里的位置可能已经过期。`started_ms` 只用于取可写集合，结论本身来自计划。
 */
export function applyDeriveGroup(db: Database, round: DeriveGroupRound): DeriveGroupOutcome {
  const { plan } = round;
  const group = plan.group;
  if (plan.normalize_algorithm) normalizeTargetAlgorithmTx(db, group.conv_key, group.actor, GROUP_ALGORITHM);
  const now = db.query<{
    group_epoch: string; input_revision: number; target_algorithm: number;
    from_sort: string; claim_from_sort: string;
  }, [string, string]>(`SELECT group_epoch,input_revision,target_algorithm,from_sort,claim_from_sort
      FROM derive_queue WHERE conv_key=? AND actor=?`).get(group.conv_key, group.actor);
  if (now === null || now.group_epoch !== group.group_epoch
    || now.target_algorithm !== group.target_algorithm) throw new Error('derive_input_changed');
  const full = now.input_revision === group.input_revision;
  // 写侧边界：本轮认领以来最早受影响的位置，位置严格小于它的行可写；相等说明
  // 分不出先后，一并排除。读侧仍看 `from_sort`，所以计算期间页面不会失去已发布前缀。
  const boundary = now.claim_from_sort;
  // 边界必须是位置串。空串表示来源没给位置（这一组还没按认领流程跑过），
  // `~` 表示认领之后没有任何变化——两种情况都与「修订变了」自相矛盾，
  // 说明有别的路径推进了修订，此时不能认任何行：整轮作废，与旧口径同义。
  if (!full && (boundary === POSITION_UNKNOWN || boundary === POSITION_ALL)) {
    throw new Error('derive_input_changed');
  }
  // 可写集合：整组完成时是全部行，否则按库里此刻的位置筛出边界之前的行。
  // 前缀轮只查这一次，组规模与一次组读同量级。
  const allowed: Set<number> | null = full ? null : new Set(
    db.query<{ req_id: number; position: string }, [string, string, string]>(`
      SELECT req_id, printf('%016d',started_ms) AS position FROM request
      WHERE conv_key=? AND actor=? AND purpose_pending=0 AND printf('%016d',started_ms)<?`)
      .all(group.conv_key, group.actor, boundary)
      .map(row => row.req_id),
  );
  const writable = (reqId: number): boolean => allowed === null || allowed.has(reqId);
  if (full) {
    // 链角色是整组产物，只在整组完成时写。
    const relation = db.prepare(`UPDATE request SET prev_req_id=?,prev_relation=?,delta_ordinals=?,
      chain_role=? WHERE req_id=?`);
    for (const row of plan.chain) {
      if (row.changed) relation.run(row.prevReqId, row.relation, row.deltaJson, row.chainRole, row.reqId);
    }
    writeToolPlanTx(db, group, plan.tools);
    writeBackgroundJobsTx(db, group, plan.jobs);
  } else {
    const relation = db.prepare(`UPDATE request SET prev_req_id=?,prev_relation=?,delta_ordinals=?
      WHERE req_id=?`);
    for (const row of plan.chain) {
      if (row.changed && writable(row.reqId)) {
        relation.run(row.prevReqId, row.relation, row.deltaJson, row.reqId);
      }
    }
  }
  for (const write of plan.presentations) {
    if (writable(write.reqId)) writePresentationTx(db, write);
  }
  if (full) {
    // 整组完成：整条链都按这一版落过，两个边界一起清成「无待处理」，
    // 下一次标记从这里重新计边界。
    // CAS 失败回滚本组的全部阶段。在线已提交组保留，维护由外层事务决定整批回滚。
    const changed = db.run(
      `UPDATE derive_queue SET state='clean',dirty_since_ms=NULL,
         published_revision=?,published_algorithm=?,from_sort=?,claim_from_sort=?
       WHERE conv_key=? AND actor=? AND group_epoch=? AND input_revision=? AND target_algorithm=?`,
      [group.input_revision, group.target_algorithm, POSITION_ALL, POSITION_ALL,
        group.conv_key, group.actor,
        group.group_epoch, group.input_revision, group.target_algorithm],
    ).changes;
    if (changed !== 1) throw new Error('derive_input_changed');
  } else {
    // 前缀轮：已发布前缀推进到写侧边界。读侧 `from_sort` 因此跟着前进，
    // 组仍 dirty，下一轮认领会重新起算。
    db.run(`UPDATE derive_queue SET from_sort=? WHERE conv_key=? AND actor=?
      AND state<>'clean' AND from_sort<>?`,
    [boundary, group.conv_key, group.actor, POSITION_ALL]);
  }
  return round.outcome;
}

/** 组内全部阶段与 CAS 在调用方的同一个事务内完成；失败回滚当前事务。 */
export function drainDeriveGroupTx(db: Database, convKey: string, actor: string,
  groupOptions: DeriveGroupOptions = {}): DeriveGroupOutcome | null {
  // 认领与计算在同一事务里，写侧边界就是这一份快照的起点。
  claimGroupTx(db, convKey, actor);
  const round = computeDeriveGroup(db, convKey, actor, groupOptions);
  return round === null ? null : applyDeriveGroup(db, round);
}

/** 显式批事务入口；在线调度由 derive-unit 按组提交并检查预算。 */
export function drainDerive(store: Store, limit = 100, scope?: DeriveScope): DrainResult {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
  if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_derive_scope');
  }
  return store.write(db => drainDeriveTx(db, { limit, scope }));
}

type Group = { conv_key: string; actor: string };

/** 取组时一并读出的完成身份；ack 用它与当前行比对，防止覆盖后到的输入变化。 */
type QueuedGroup = Group & {
  group_epoch: string; input_revision: number; target_algorithm: number;
};

/** 工具配对消费的行：链阶段刚写下的关系、顺序与用途结论。 */
export type PairRow = LogicalRow & {
  req_kind: string | null; purpose_chain: string;
  prev_relation: string | null; delta_ordinals: string | null;
};

/**
 * 工具配对的产物：本组按当前正文重建出的最终行，与库里现有行逐列比较后只写差异。
 *
 * `upserts` 是缺失或内容不同的行（携带完整最终值），`deletes` 是现有行里最终
 * 不存在的调用。计划与写分开，是为了让计算段不持有写锁。
 */
export type ToolPlan = {
  upserts: {
    callId: string; reqId: number; ord: number; name: string;
    argPath: string | null; argSkill: string | null;
    resultReq: number | null; resultOrd: number | null; resultPath: string | null;
    isError: number | null; state: string; basis: string;
  }[];
  deletes: { reqId: number; ord: number }[];
  associations: ResolvedTool[];
};

/**
 * 工具往返的计算段。配对阶梯（`pairOutcome`）的 `alreadyResolved` /
 * `alreadyPending` 只看本轮初值：重建式语义下旧行在落库时先被删除，读回自己
 * 刚写的行等于读本轮内存状态，所以在状态表里推进，不再查表。
 */
function planToolCalls(db: Database, group: Group, ordered: readonly PairRow[],
  uncertain: ReadonlySet<number>, bodyCache: BodyReadCache): ToolPlan {
  const rows = ordered;
  if (rows.length === 0) return { upserts: [], deletes: [], associations: [] };

  type Call = {
    req_id: number; ord: number; call_id: string; name: string; index: number;
    arg_path: string | null; arg_skill: string | null;
  };
  const calls: Call[] = [];
  const results: {
    req_id: number; index: number; ord: number; path: string; call_id: string;
    value: unknown; confirmed: boolean; is_error: number;
  }[] = [];

  for (const [index, row] of rows.entries()) {
    // 排除用途是旁路：不进入工具候选，与它不进祖先集合同一个理由。
    if (row.purpose_chain === 'exclude') continue;
    const body = readBodyTx(db, row.req_id, bodyCache);
    if (body === null) continue;
    // 结果是否落在确定增量的 ord 上：first 整笔新增、confirmed 只看增量的规则
    // 住在 derive-decision，切片结算走同一判据。
    const delta = row.delta_ordinals === null ? null : JSON.parse(row.delta_ordinals) as number[];
    const confirmedDelta = confirmedDeltaOf(row.prev_relation, delta);
    const ordinalConfirmed = (ord: number): boolean =>
      confirmedDelta.all || confirmedDelta.ords.includes(ord);
    for (const block of replyCallsOf(body.protocol, body.reply)) {
      calls.push({
        req_id: row.req_id, ord: block.ord, call_id: block.id, name: block.name, index,
        arg_path: block.argPath, arg_skill: block.argSkill,
      });
    }
    for (const result of requestResultsOf(body.protocol, body.request)) {
      results.push({
        req_id: row.req_id, index, ord: result.ord, path: result.path,
        call_id: result.id, value: result.value, confirmed: ordinalConfirmed(result.ord),
        is_error: result.isError,
      });
    }
  }

  const byCallId = new Map<string, Call[]>();
  for (const call of calls) {
    const list = byCallId.get(call.call_id) ?? [];
    list.push(call);
    byCallId.set(call.call_id, list);
  }

  const plan: ToolPlan = { upserts: [], deletes: [], associations: [] };
  const key = (reqId: number, ord: number): string => `${reqId}:${ord}`;
  // 本轮的行状态：插入时的初值，随结果更新推进；等价于旧实现的读回结果。
  const stateByKey = new Map<string, string>();
  const resultByKey = new Map<string, { req: number; ord: number; path: string }>();
  const finalByKey = new Map<string, ToolPlan['upserts'][number]>();
  for (const call of calls) {
    const state = initialPairState((byCallId.get(call.call_id) ?? []).length);
    finalByKey.set(key(call.req_id, call.ord), {
      callId: call.call_id, reqId: call.req_id, ord: call.ord, name: call.name,
      argPath: call.arg_path, argSkill: call.arg_skill,
      resultReq: null, resultOrd: null, resultPath: null, isError: null, state,
      basis: toolBasis(group, call.call_id),
    });
    stateByKey.set(key(call.req_id, call.ord), state);
  }

  for (const result of results) {
    const candidates = byCallId.get(result.call_id) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      // 多候选保持 ambiguous，结果位置与失败位照样记下，便于人工核对。
      for (const call of candidates) {
        const row = finalByKey.get(key(call.req_id, call.ord));
        if (row !== undefined) {
          row.resultReq = result.req_id; row.resultOrd = result.ord;
          row.resultPath = result.path; row.isError = result.is_error; row.state = 'ambiguous';
        }
        stateByKey.set(key(call.req_id, call.ord), 'ambiguous');
      }
      continue;
    }
    const call = candidates[0]!;
    const callRow = rows[call.index]!;
    const resultRow = rows[result.index]!;
    const current = stateByKey.get(key(call.req_id, call.ord)) ?? 'pending';
    // 阶梯顺序（多候选 → 必须更晚 → 顺序可证 → resolved 终态 → pending 保留首见）
    // 在 pairOutcome 里，两条路径共用。
    const outcome = pairOutcome({
      candidateCount: candidates.length,
      resultLater: compareLogicalOrder(callRow, resultRow) < 0,
      orderCertain: callRow.started_ms !== resultRow.started_ms
        || (!uncertain.has(callRow.req_id) && !uncertain.has(resultRow.req_id)),
      alreadyResolved: current === 'resolved',
      alreadyPending: current === 'pending',
      resultConfirmed: result.confirmed,
    });
    if (outcome === 'skip') continue;
    const row = finalByKey.get(key(call.req_id, call.ord));
    if (row !== undefined) {
      row.resultReq = result.req_id; row.resultOrd = result.ord;
      row.resultPath = result.path; row.isError = result.is_error; row.state = outcome;
    }
    stateByKey.set(key(call.req_id, call.ord), outcome);
    resultByKey.set(key(call.req_id, call.ord), { req: result.req_id, ord: result.ord, path: result.path });
  }

  // 本次确定下来的关联：只从本轮新建且最终 resolved 的调用行形成。
  for (const call of calls) {
    const state = stateByKey.get(key(call.req_id, call.ord));
    const placed = resultByKey.get(key(call.req_id, call.ord));
    if (state !== 'resolved' || placed === undefined) continue;
    plan.associations.push({
      callReq: call.req_id, callOrd: call.ord, callId: call.call_id, name: call.name,
      resultReq: placed.req, resultOrd: placed.ord, resultPath: placed.path,
    });
  }

  // 现有行只在重建范围内比较：正文已回收的请求不参与重建，它们的行原样保留。
  const existing = db.query<{
    call_id: string; req_id: number; ord: number; tool_name: string | null;
    arg_path: string | null; arg_skill: string | null;
    result_req: number | null; result_ord: number | null; result_path: string | null;
    is_error: number | null; state: string; derive_version: number;
    algorithm_version: number | null; basis_json: string | null; retention_state: string;
  }, [string, string]>(`
    SELECT call_id,req_id,ord,tool_name,arg_path,arg_skill,result_req,result_ord,
           result_path,is_error,state,derive_version,algorithm_version,basis_json,retention_state
    FROM tool_call WHERE req_id IN (
      SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known'
        AND body_state IN ('available','partial'))`)
    .all(group.conv_key, group.actor);
  const existingByKey = new Map(existing.map(row => [key(row.req_id, row.ord), row]));
  for (const row of finalByKey.values()) {
    const cur = existingByKey.get(key(row.reqId, row.ord));
    if (cur !== undefined
      && cur.call_id === row.callId && (cur.tool_name ?? null) === row.name
      && (cur.arg_path ?? null) === row.argPath && (cur.arg_skill ?? null) === row.argSkill
      && (cur.result_req ?? null) === row.resultReq && (cur.result_ord ?? null) === row.resultOrd
      && (cur.result_path ?? null) === row.resultPath && (cur.is_error ?? null) === row.isError
      && cur.state === row.state && cur.derive_version === 1
      && cur.algorithm_version === GROUP_ALGORITHM
      && (cur.basis_json ?? null) === row.basis && cur.retention_state === 'recomputed') continue;
    plan.upserts.push(row);
  }
  for (const row of existing) {
    if (!finalByKey.has(key(row.req_id, row.ord))) plan.deletes.push({ reqId: row.req_id, ord: row.ord });
  }
  return plan;
}

/** 计划落库：只写与现有行不同的调用，删除最终不存在的调用，最后标出保留行。 */
function writeToolPlanTx(db: Database, group: Group, plan: ToolPlan): void {
  for (const row of plan.upserts) {
    db.run(
      `INSERT INTO tool_call(call_id,req_id,ord,tool_name,arg_path,arg_skill,
         result_req,result_ord,result_path,is_error,state,derive_version,
         algorithm_version,basis_json,retention_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,'recomputed')
       ON CONFLICT(req_id,ord) DO UPDATE SET call_id=excluded.call_id,tool_name=excluded.tool_name,
         arg_path=excluded.arg_path,arg_skill=excluded.arg_skill,
         result_req=excluded.result_req,result_ord=excluded.result_ord,
         result_path=excluded.result_path,is_error=excluded.is_error,state=excluded.state,
         derive_version=excluded.derive_version,
         algorithm_version=excluded.algorithm_version,basis_json=excluded.basis_json,
         retention_state='recomputed'`,
      [row.callId, row.reqId, row.ord, row.name, row.argPath, row.argSkill,
        row.resultReq, row.resultOrd, row.resultPath, row.isError, row.state,
        GROUP_ALGORITHM, row.basis],
    );
  }
  const remove = db.prepare('DELETE FROM tool_call WHERE req_id=? AND ord=?');
  for (const row of plan.deletes) remove.run(row.reqId, row.ord);
  // 保留行原 metadata 不动，只标出它们本轮没有被重算：正文已回收的请求不在
  // 重建范围内，把它们的算法版本提升到本次版本等于声称重算过。
  db.run(
    `UPDATE tool_call SET retention_state='retained' WHERE req_id IN (
      SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known'
        AND body_state NOT IN ('available','partial'))`,
    [group.conv_key, group.actor],
  );
}

/** 一条工具行的算法依据：组身份与调用身份，足以复现配对输入。 */
function toolBasis(group: Group, callId: string): string {
  return JSON.stringify({ group: [group.conv_key, group.actor], call_id: callId, algorithm: GROUP_ALGORITHM });
}

/** 工具往返的独立入口：维护与回填脚本迁移完成前仍可用，不参与摘要。 */
export type RebuildReport = {
  queued: number;
  unavailable: number;
  /** 按原因分类的不可用请求数；只有正文可读的请求会被真正重算。 */
  reasons: Record<string, number>;
};

/** 这笔请求的证据在 raw 层是否还有原文（hook 或账本文件那一段）。 */
function hasRawEvidence(db: Database, reqId: number): boolean {
  const rows = db.query<{ source_kind: string; ref_key: string }, [number]>(
    'SELECT source_kind, ref_key FROM request_evidence WHERE req_id=?').all(reqId);
  for (const row of rows) {
    if (row.source_kind === 'hook') {
      if (db.query('SELECT 1 FROM raw_hook WHERE hook_id=?').get(row.ref_key) !== null) return true;
      continue;
    }
    if (row.source_kind !== 'ledger') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.ref_key);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed[0] !== 'file' || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'number') continue;
    if (db.query('SELECT 1 FROM raw_ledger WHERE source_kind=? AND file_generation=? AND byte_offset=?')
      .get('file', parsed[1], parsed[2]) !== null) return true;
  }
  return false;
}

/**
 * 维护命令：整条链重排一次；正文不可用的请求保持未知。
 *
 * 返回不可用的数量与原因，调用方据此决定要不要继续处理：正文和 raw 都没了的
 * 请求没法重算，旧标题与工具关系也不该被重写成空。
 */
export function rebuildDerived(store: Store, convKey: string): RebuildReport {
  return store.write(db => {
    const actors = db.query<{ actor: string }, [string]>(`
      SELECT DISTINCT actor FROM request
      WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known'`).all(convKey);
    let unavailable = 0;
    const reasons: Record<string, number> = {};
    const bump = (reason: string): void => {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    for (const { actor } of actors) {
      const missing = db.query<{ req_id: number; body_state: string }, [string, string]>(`
        SELECT req_id, body_state FROM request
        WHERE conv_key=? AND actor=? AND actor_state='known'
          AND body_state NOT IN ('available','partial')`).all(convKey, actor);
      unavailable += missing.length;
      for (const row of missing) {
        if (row.body_state !== 'evicted') {
          bump(`body_${row.body_state}`);
        } else {
          bump(hasRawEvidence(db, row.req_id) ? 'body_evicted_raw_present' : 'body_evicted_raw_expired');
        }
      }
      markGroupDirtyTx(db, convKey, actor, '');
    }
    return { queued: actors.length, unavailable, reasons };
  });
}
