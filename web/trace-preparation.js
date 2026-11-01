// @ts-check
/**
 * 窗口准备只持有提交资格与在跑任务；正文快照仍由 reader-store 持有。
 * 单组准备走完整单项链（详情→依赖→增量）；窗口准备按块批量推进：最多 32 笔
 * 一次 readings 批取 bundle，窗口内依赖一次批补齐，增量按每请求两片、总预算
 * 二十片打包区间批。每块完成聚合一次通知，不把后继任务预排进有限队列。
 * @param {import('./reader-store.js').ReaderStore} store
 * @param {(ids: number[], dependencies: number[]) => void} onPrepared
 */
export function createTracePreparation(store, onPrepared) {
  const ready = new Set();
  /** @type {Map<number, {epoch: number, task: Promise<void>}>} */
  const pending = new Map();
  let epoch = 0;
  const DELTA_PIECE_BUDGET = 20;
  const READ_CHUNK = 32;

  /** @param {number} id */
  const inWindow = id => store.getWindow().requests.some(row => row.req_id === id);

  /** @param {number} id @returns {Promise<number[]>} */
  async function settleDependencies(id) {
    const detail = store.peekRequest(id)?.detail ?? null;
    if (detail === null) return [];
    const deps = new Set();
    if (detail.prev_relation === 'confirmed' && detail.prev_req_id !== null) deps.add(detail.prev_req_id);
    for (const item of detail.tool_results) {
      if (item.state === 'resolved') deps.add(item.owner_req);
    }
    deps.delete(id);
    const wanted = [...deps].filter(depId => inWindow(depId));
    await Promise.all(wanted.map(async depId => {
      try { await store.readRequest(depId); } catch { /* 依赖失败时降级显示 */ }
    }));
    return wanted;
  }

  /** @param {number} id @param {number} currentEpoch */
  async function runPrepare(id, currentEpoch) {
    while (currentEpoch === epoch && inWindow(id)) {
      try { await store.readRequest(id); } catch { /* 失败态由快照表达 */ }
      if (currentEpoch !== epoch || !inWindow(id)) return;
      const read = store.peekRequest(id);
      const token = read?.token ?? null;
      /** @type {number[]} */
      let dependencies = [];
      if (read !== null && read.detail !== null) {
        dependencies = await settleDependencies(id);
        if (currentEpoch !== epoch || !inWindow(id)) return;
        const afterDependencies = store.peekRequest(id);
        if (afterDependencies?.token !== token) {
          if (afterDependencies?.detail !== null && afterDependencies?.detail !== undefined) continue;
          onPrepared([id], dependencies);
          return;
        }
        for (let spent = 0; spent < DELTA_PIECE_BUDGET; spent += 2) {
          const current = store.peekRequest(id);
          const delta = current?.delta ?? null;
          if (current === null || current.token !== token || current.detail === null || current.meta === null || delta === null || delta.done || delta.error !== null) break;
          try { await store.loadDelta(id, 2); } catch { break; }
          if (currentEpoch !== epoch || !inWindow(id)) return;
        }
      }
      const final = store.peekRequest(id);
      if (final !== null && final.detail !== null && final.token !== token) continue;
      if (final !== null && (final.detail !== null || final.status === 'failed')) ready.add(id);
      onPrepared([id], dependencies);
      return;
    }
  }

  /** @param {number} id @returns {Promise<void>} */
  function prepare(id) {
    const existing = pending.get(id);
    if (existing !== undefined && existing.epoch === epoch) return existing.task;
    ready.delete(id);
    const task = runPrepare(id, epoch);
    pending.set(id, { epoch, task });
    const release = () => {
      if (pending.get(id)?.task === task) pending.delete(id);
    };
    void task.then(release, release);
    return task;
  }

  /**
   * 真实依赖集：已确认前驱与已解析结果的工具 owner，都在窗口内的才算。
   * @param {number[]} ids
   * @returns {number[]}
   */
  function windowDependencies(ids) {
    const windowIds = new Set(store.getWindow().requests.map(row => row.req_id));
    const deps = new Set();
    for (const id of ids) {
      const detail = store.peekRequest(id)?.detail ?? null;
      if (detail === null) continue;
      if (detail.prev_relation === 'confirmed' && detail.prev_req_id !== null) deps.add(detail.prev_req_id);
      for (const item of detail.tool_results) {
        if (item.state === 'resolved') deps.add(item.owner_req);
      }
    }
    for (const id of ids) deps.delete(id);
    return [...deps].filter(depId => windowIds.has(depId));
  }

  /**
   * 目标先独立准备；其余按最多 32 笔读取块获取 bundle，窗口内依赖一次批补齐，
   * 增量按每请求两片、总预算二十片打包区间块。块内资格仍逐组判断，完成一块
   * 聚合一次 onPrepared。旧代次完成时返回 false。
   * @param {number | null} target
   */
  async function prepareWindow(target) {
    const currentEpoch = epoch;
    const wanted = store.getWindow().requests.filter(row => {
      const read = store.peekRequest(row.req_id);
      if (read !== null && read.status === 'invalidated') return false;
      return !ready.has(row.req_id) || read !== null && read.status === 'failed';
    });
    // 重试与批量补读期间先撤资格，逐组重新判断后恢复。
    for (const row of wanted) ready.delete(row.req_id);
    const first = target === null ? undefined : wanted.find(row => row.req_id === target);
    if (first !== undefined) {
      await prepare(first.req_id);
      if (currentEpoch !== epoch) return false;
    }
    const rest = wanted.filter(row => row !== first);
    for (let index = 0; index < rest.length; index += READ_CHUNK) {
      if (currentEpoch !== epoch) return false;
      const chunk = rest.slice(index, index + READ_CHUNK);
      const ids = chunk.map(row => row.req_id);
      try {
        await store.readRequests(ids);
      } catch { /* 批级失败：逐组资格判断，失败态由快照表达，不展开单项风暴 */ }
      if (currentEpoch !== epoch) return false;
      // 窗口内依赖批：bundle 在手后一次补齐，块内已有的与已就绪的跳过。
      const chunkIds = new Set(ids);
      const depIds = windowDependencies(ids)
        .filter(depId => !chunkIds.has(depId) && !ready.has(depId));
      if (depIds.length > 0) {
        try { await store.readRequests(depIds); } catch { /* 依赖失败降级显示 */ }
        if (currentEpoch !== epoch) return false;
      }
      // 有界区间块：delta 未完且无错误的请求每轮各推进两片，窗口总预算二十片。
      let spent = 0;
      while (spent < DELTA_PIECE_BUDGET && currentEpoch === epoch) {
        const deltaWanted = ids.filter(id => {
          const read = store.peekRequest(id);
          return read !== null && read.detail !== null
            && !read.delta.done && !read.delta.loading && read.delta.error === null;
        });
        if (deltaWanted.length === 0) break;
        await store.loadDeltas(deltaWanted, 2);
        spent += 2 * deltaWanted.length;
      }
      if (currentEpoch !== epoch) return false;
      // 块内资格逐组判断：详情在手（或失败态可见）才取得提交资格。
      const preparedIds = [];
      for (const id of ids) {
        const read = store.peekRequest(id);
        if (read !== null && (read.detail !== null || read.status === 'failed')) {
          ready.add(id);
          preparedIds.push(id);
        }
      }
      if (preparedIds.length > 0) onPrepared(preparedIds, windowDependencies(ids));
    }
    return currentEpoch === epoch;
  }

  return {
    has: (/** @type {number} */ id) => ready.has(id),
    forget: (/** @type {number} */ id) => { ready.delete(id); },
    prepare,
    prepareWindow,
    reset: () => { epoch += 1; ready.clear(); pending.clear(); },
  };
}
