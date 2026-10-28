// @ts-check
/**
 * 窗口准备只持有提交资格与在跑任务；正文快照仍由 reader-store 持有。
 * @param {import('./reader-store.js').ReaderStore} store
 * @param {(id: number, dependencies: number[]) => void} onPrepared
 */
export function createTracePreparation(store, onPrepared) {
  const ready = new Set();
  /** @type {Map<number, {epoch: number, task: Promise<void>}>} */
  const pending = new Map();
  let epoch = 0;
  const DELTA_PIECE_BUDGET = 20;
  const PREPARE_CHUNK = 4;

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
          onPrepared(id, dependencies);
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
      onPrepared(id, dependencies);
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

  /** 目标先准备，其余按窗口顺序四组一批；旧代次完成时返回 false。 @param {number | null} target */
  async function prepareWindow(target) {
    const currentEpoch = epoch;
    const wanted = store.getWindow().requests.filter(row => {
      const read = store.peekRequest(row.req_id);
      if (read !== null && read.status === 'invalidated') return false;
      return !ready.has(row.req_id) || read !== null && read.status === 'failed';
    });
    const first = target === null ? undefined : wanted.find(row => row.req_id === target);
    if (first !== undefined) {
      await prepare(first.req_id);
      if (currentEpoch !== epoch) return false;
    }
    const rest = wanted.filter(row => row !== first);
    for (let index = 0; index < rest.length; index += PREPARE_CHUNK) {
      if (currentEpoch !== epoch) return false;
      await Promise.all(rest.slice(index, index + PREPARE_CHUNK).map(row => prepare(row.req_id)));
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
