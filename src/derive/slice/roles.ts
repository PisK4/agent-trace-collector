/** 角色阶段：逐请求扫祖先定关系，再按遍历序传播主链角色。 */

import type { Database } from 'bun:sqlite';
import type { DeriveBudget } from '../../config';
import type { Store } from '../../store';
import {
  chainRolesOf, chainTrunkRoot, commonPrefix, confirmedDeltaOf, settleRelation,
} from '../decision';
import { fingerprintsOf, incrementalInputOf } from '../read';
import { assertQueueRevision, one, sliceDiscardReason, type SliceStep } from './generation';
import { requestUncertain } from './requests';

/** 角色阶段横跨的两个阶段名：扫描（roles）与传播（role_assign）。 */
export const ROLE_STAGES = new Set(['roles', 'role_assign']);

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
    // 角色由共享判定（chainRolesOf）给出：森林含关系 unknown 的行，trunk 照旧，
    // unknown 行及其 confirmed 后继的不确定闭包记 unknown。早先只按
    // started_ms/req_id 取根会把父节点是未知行的那一笔漏掉，与同步路径分叉——
    // 判据收进 decision 后只剩一个位置。三态编码进 in_trunk（1=main、2=unknown、
    // 0=branch），角色传播按它翻译；长组这里是单笔事务里最多的一次写入
    // （每行一列），量级与同步路径整组重算相当。
    const nodes = db.query<{ req_id: number; parent_req_id: number | null;
      participating: number; relation: string | null }, [string]>(`
      SELECT req_id,parent_req_id,participating,relation FROM derive_role_work
      WHERE generation=? ORDER BY traversal_ord`).all(generation);
    const chain = nodes.filter(row => row.participating === 1)
      .map(row => ({ reqId: row.req_id, parentReqId: row.parent_req_id, relation: row.relation }));
    const roles = chainRolesOf(chain);
    const mark = db.prepare(
      'UPDATE derive_role_work SET in_trunk=? WHERE generation=? AND req_id=?');
    for (const node of chain) {
      const role = roles.get(node.reqId);
      mark.run(role === 'main' ? 1 : role === 'unknown' ? 2 : 0, generation, node.reqId);
    }
    db.run(`UPDATE derive_generation SET stage='role_assign',role_assign_ord=-1,
      role_root_req=? WHERE generation=?`, [chainTrunkRoot(chain), generation]);
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
  // 增量输入不含完整历史：与顺序未证实同档，指纹留空让关系落 unknown，
  // 同时让后续请求把这条祖先记为不可比。
  const comparable = participating === 1
    && !requestUncertain(db, generation, next.started_ms, next.req_id)
    && !incrementalInputOf(db, next.req_id);
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
 * trunk 与不确定闭包已在角色扫描收尾时由共享判定（`chainRolesOf`）编码进工作行
 * 的 `in_trunk`（1=main、2=unknown、0=branch），这里只翻译：排除用途写 aux，
 * 参与行按编码落 main/unknown/branch。角色传播不碰标题与摘要。
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
    const role = row.participating !== 1 ? 'aux'
      : row.in_trunk === 1 ? 'main' : row.in_trunk === 2 ? 'unknown' : 'branch';
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
