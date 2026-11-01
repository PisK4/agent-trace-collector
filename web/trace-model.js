// @ts-check
import { tailEligibleIds as tailIdsOf } from './trace-view.js';

/**
 * 依赖感知显示模型：组与尾组投影按内容修订与依赖边重算，读取无变化时重用
 * 上一次的对象。project/projectTail 是纯投影 adapter（现有 projectSteps/
 * projectTailReply 的 store 绑定包装），preparing 生成占位步骤，测试可注入
 * 计数。model 只保留最近一次显示版本，不持有 DOM 与 URL；依赖来自 detail
 * 的真实前驱与工具 owner，不由调用者手写缓存键。bgJobs 按引用判事件，
 * 调用方传 store 的稳定数组，不逐帧新建。
 * @param {{project: (row: any, read: any) => import('./trace-view.js').TraceStep[],
 *   projectTail: (row: any, read: any) => {steps: import('./trace-view.js').TraceStep[], eligible: boolean},
 *   preparing: (row: any) => import('./trace-view.js').TraceStep}} adapters
 * @returns {{update: (input: {rows: any[], reads: Map<number, any>, ready: Set<number>,
 *   bgJobs: unknown, complete: boolean, changedIds: number[]}) => void,
 *   get: (id: number) => any, tailEligibleIds: () => Set<number>, reset: () => void}}
 */
export function createTraceModel({ project, projectTail, preparing }) {
  /** @type {Map<number, {read: any, result: {steps: any[], stale: string | null, placeholder: boolean, tail: any}}>} 组显示缓存：read 是投影用的快照，result 是稳定的显示形状。 */
  const groups = new Map();
  /** @type {Map<number, {read: any, result: any}>} 尾组缓存。 */
  const tails = new Map();
  /** @type {Map<number, Set<number>>} 组的正向依赖：组 → 真实前驱与工具 owner。 */
  const depsOf = new Map();
  /** @type {Map<number, Set<number>>} 反向依赖：owner → 依赖它的组。 */
  const dependents = new Map();
  /** @type {Map<number, number>} reqId → 窗口序号，窗口变化一次建立。 */
  const ordinalOf = new Map();
  let lastBgJobs = /** @type {unknown} */ (null);
  let lastComplete = false;
  /** @type {string | null} 上次窗口行键；null 表示还没有窗口。 */
  let lastRowKey = null;
  /** @type {Set<number> | null} 尾组资格缓存；complete 或窗口变化时重建。 */
  let tailIdsCache = null;
  /** @type {any[]} 最近一次 update 的窗口行，尾组资格计算用。 */
  let currentRows = [];

  /** @param {number} id 摘除该组的全部正向依赖边。 */
  function dropDeps(id) {
    const old = depsOf.get(id);
    if (old === undefined) return;
    for (const owner of old) {
      const set = dependents.get(owner);
      if (set !== undefined) {
        set.delete(id);
        if (set.size === 0) dependents.delete(owner);
      }
    }
    depsOf.delete(id);
  }

  /** @param {number} id @param {any} read 从快照记录真实依赖边：变更时先删旧边再加新边。 */
  function recordDeps(id, read) {
    dropDeps(id);
    const detail = read?.detail ?? null;
    if (detail === null) return;
    const deps = new Set();
    if (detail.prev_relation === 'confirmed' && typeof detail.prev_req_id === 'number') deps.add(detail.prev_req_id);
    for (const item of detail.tool_results ?? []) {
      if (item.state === 'resolved') deps.add(item.owner_req);
    }
    if (deps.size === 0) return;
    depsOf.set(id, deps);
    for (const owner of deps) {
      let set = dependents.get(owner);
      if (set === undefined) { set = new Set(); dependents.set(owner, set); }
      set.add(id);
    }
  }

  /**
   * 失效闭包：种子（本轮内容修订变化的组，或 bgJobs 事件的全窗口）沿反向
   * 依赖传播给后继与工具结果组。
   * @param {Iterable<number>} seeds
   * @returns {Set<number>}
   */
  function invalidationClosure(seeds) {
    const out = new Set(seeds);
    const queue = [...out];
    while (queue.length > 0) {
      const deps = dependents.get(/** @type {number} */ (queue.pop()));
      if (deps === undefined) continue;
      for (const dep of deps) {
        if (!out.has(dep)) { out.add(dep); queue.push(dep); }
      }
    }
    return out;
  }

  /**
   * 一次显示更新：rows 为当前窗口行序，reads 为对应读取快照（可缺），
   * ready 是提交资格；bgJobs/complete 是事件输入，引用或取值变化才触发
   * 失效，不每笔准备都重算；changedIds 是本轮 contentRevision 变化的组。
   * @param {{rows: any[], reads: Map<number, any>, ready: Set<number>,
   *   bgJobs: unknown, complete: boolean, changedIds: number[]}} input
   */
  function update({ rows, reads, ready, bgJobs, complete, changedIds }) {
    const rowKey = rows.map(row => row.req_id).join(',');
    const rowsChanged = rowKey !== lastRowKey;
    const bgChanged = bgJobs !== lastBgJobs;
    const completeChanged = complete !== lastComplete;
    lastRowKey = rowKey;
    lastBgJobs = bgJobs;
    lastComplete = complete;
    currentRows = rows;

    if (rowsChanged) {
      ordinalOf.clear();
      rows.forEach((row, index) => ordinalOf.set(row.req_id, index));
      tailIdsCache = null;
    }
    const invalidated = invalidationClosure(bgChanged ? [...groups.keys()] : changedIds);

    for (const row of rows) {
      const id = row.req_id;
      const read = reads.get(id) ?? null;
      const prepared = ready.has(id) && read !== null && read.detail !== null;
      const cached = groups.get(id);
      if (prepared) {
        if (cached === undefined || invalidated.has(id)
          || cached.read !== read || cached.read.contentRevision !== read.contentRevision) {
          const fresh = { steps: project(row, read), stale: null, placeholder: false, tail: null };
          groups.set(id, { read, result: fresh });
          recordDeps(id, read);
          applyTail(id, row, read, fresh);
        } else if (cached.result.stale !== null) {
          // 保留投影与当前读取一致：只清保留态，不重投影。
          cached.result.stale = null;
          cached.result.placeholder = false;
          applyTail(id, row, read, cached.result);
        }
      } else if (cached !== undefined) {
        const stale = read !== null && read.status === 'failed' ? 'failed' : 'reading';
        if (cached.result.stale !== stale) cached.result.stale = stale;
      } else if (read !== null && (read.status === 'failed' || read.status === 'invalidated')) {
        // 失败与作废没有可显示的新投影：缺口行如实给原因，不当成读取中。
        groups.set(id, { read, result: { steps: project(row, read), stale: null, placeholder: false, tail: null } });
      } else {
        groups.set(id, { read, result: { steps: [preparing(row)], stale: null, placeholder: true, tail: null } });
      }

      const tailCached = tails.get(id);
      if (!prepared && tailCached !== undefined && (invalidated.has(id) || rowsChanged)) {
        // 尾组没有保留显示：依赖失效或离窗即撤下，不把旧回复冒充当前。
        tails.delete(id);
        cached?.result && (cached.result.tail = null);
      }
    }

    if (rowsChanged) {
      const live = new Set(rows.map(row => row.req_id));
      for (const id of [...groups.keys()]) if (!live.has(id)) groups.delete(id);
      for (const id of [...tails.keys()]) if (!live.has(id)) tails.delete(id);
      for (const id of [...depsOf.keys()]) if (!live.has(id)) dropDeps(id);
    }
  }

  /**
   * 尾组投影：prepared 时按同判据重算并写进组显示形状的 tail 字段；
   * 未备齐时保留旧 eligible 尾组并声明归属，无缓存或失效即 null。
   * @param {number} id @param {any} row @param {any} read @param {{tail: any}} slot
   */
  function applyTail(id, row, read, slot) {
    const tailCached = tails.get(id);
    if (tailCached !== undefined && tailCached.read === read
      && tailCached.read.contentRevision === read.contentRevision && !tailCached.result.stale) {
      slot.tail = tailCached.result.eligible ? tailCached.result : null;
      return;
    }
    const projected = projectTail(row, read);
    tails.set(id, { read, result: projected });
    slot.tail = projected.eligible ? { steps: projected.steps, stale: null } : null;
  }

  /**
   * 末尾组的请求集合：会话已完整加载、请求不是辅助、没有已加载的非辅助请求
   * 把它当作已确认前驱，且它之后没有前驱未知的请求。单次后向扫描 + 缓存，
   * 判定本身是 trace-view 的纯函数，用既有测试对照。
   * @returns {Set<number>}
   */
  function tailEligibleIds() {
    if (tailIdsCache !== null) return tailIdsCache;
    const rows = currentRows.filter(row => row.purpose_chain !== 'exclude' && row.chain_role !== 'aux');
    const entries = rows.map(row => {
      const read = groups.get(row.req_id)?.read ?? null;
      const detail = read?.detail ?? null;
      const confirmed = detail !== null && detail.prev_relation === 'confirmed';
      return {
        id: row.req_id,
        prevId: confirmed && typeof detail.prev_req_id === 'number' ? detail.prev_req_id : null,
        undetermined: detail === null || (detail.prev_relation !== 'confirmed' && detail.prev_relation !== 'first'),
      };
    });
    tailIdsCache = tailIdsOf(entries, lastComplete);
    return tailIdsCache;
  }

  /**
   * 最近一次显示版本：现有 stepsOf/tailOf 的合并形状，同一显示版本返回
   * 同一对象。tail 只在有可显示内容时返回，否则 null。
   * @param {number} id
   */
  function get(id) {
    return groups.get(id)?.result ?? null;
  }

  function reset() {
    groups.clear();
    tails.clear();
    depsOf.clear();
    dependents.clear();
    ordinalOf.clear();
    tailIdsCache = null;
    currentRows = [];
    lastBgJobs = null;
    lastComplete = false;
    lastRowKey = null;
  }

  return { update, get, tailEligibleIds, reset };
}
