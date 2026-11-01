/**
 * 读取调度：有界活动槽、有界待发队列、优先级公平性与 owner 取消。
 *
 * 接收已命名的异步任务，不识别 URL 或请求正文。scope 是对象引用（page、
 * session、dialog 各持一个），cancelScope 取消该 owner 的全部任务。任务必须
 * settle：取消不计为服务器读取失败；忽略取消的任务仍占活动槽，直到它自己
 * settle——提前放下一个会造成超并发。dispose 不把未停止的任务记为已停止。
 */

/** @typedef {'interactive' | 'background'} ReadPriority */

/**
 * @param {{
 *   activeLimit?: number,
 *   pendingLimit?: number,
 *   backgroundLimit?: number,
 *   interactiveBurstLimit?: number,
 *   clock?: () => number,
 * }} [options]
 *   默认活动 4、待发 64、后台活动 3、连续交互 8；clock 是 monotonic 毫秒。
 */
export function createReadScheduler({
  activeLimit = 4,
  pendingLimit = 64,
  backgroundLimit = 3,
  interactiveBurstLimit = 8,
  clock = () => performance.now(),
} = {}) {
  const cancelledError = () =>
    Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const queueFullError = () =>
    Object.assign(new Error('queue_full'), { code: 'queue_full' });

  /** @type {object[]} 待发任务，先进先出；淘汰与取消即时移除。 */
  const queue = [];
  /** @type {Set<object>} 已执行未 settle 的任务。 */
  const activeTasks = new Set();

  let active = 0;
  let backgroundActive = 0;
  /** 连续服务的交互任务数；后台任务执行时归零。 */
  let interactiveRun = 0;
  let disposed = false;

  const counters = {
    enqueued: 0, executed: 0, cancelled: 0, queueFull: 0, evicted: 0, errors: 0,
  };
  const timing = {
    queueWaitMs: { sum: 0, max: 0 },
    runMs: { sum: 0, max: 0 },
  };
  const record = (bucket, value) => {
    bucket.sum += value;
    if (value > bucket.max) bucket.max = value;
  };

  /**
   * 一次 settle。任务生命周期里 resolve/reject 各至多一次；取消、异常与
   * 正常完成共用同一条路径，finally 负责释放活动槽。未执行的任务把等待
   * 计入 queueWaitMs；已执行的任务把执行区间计入 runMs。
   * @param {object} task
   * @param {boolean} fulfilled
   * @param {unknown} value
   */
  function settle(task, fulfilled, value) {
    if (task.settled) return;
    if (task.startedAt !== null) {
      record(timing.runMs, Math.max(0, clock() - task.startedAt));
    } else {
      record(timing.queueWaitMs, Math.max(0, clock() - task.createdAt));
    }
    if (fulfilled) task.resolve(value);
    else task.reject(value);
  }

  /** @param {object} task 未执行的取消：移出队列、清理监听并立即 settle。 */
  function cancelQueued(task) {
    removeFromQueue(task);
    task.cleanup();
    counters.cancelled += 1;
    settle(task, false, cancelledError());
  }

  /** @param {object} task 外部 signal 或 dispose 的在途取消：只 abort，不 settle。 */
  function abortActive(task) {
    task.controller.abort();
  }

  /** @param {object} task 活动槽释放：计数回收、清理监听并继续装填。 */
  function releaseSlot(task) {
    active -= 1;
    if (task.priority === 'background') backgroundActive -= 1;
    activeTasks.delete(task);
    task.cleanup();
    pump();
  }

  function pump() {
    while (!disposed && active < activeLimit && queue.length > 0) {
      const task = pickNext();
      if (task === null) break;
      removeFromQueue(task);
      start(task);
    }
  }

  /** @returns {object | null} 公平规则下的下一个可运行任务。 */
  function pickNext() {
    // 连续交互达到上限且后台有槽：先取最早的可运行后台，抑制交互饥饿后台。
    if (interactiveRun >= interactiveBurstLimit) {
      const background = queue.find(task =>
        task.priority === 'background' && backgroundActive < backgroundLimit);
      if (background !== undefined) return background;
    }
    return queue.find(task =>
      task.priority !== 'background' || backgroundActive < backgroundLimit) ?? null;
  }

  function removeFromQueue(task) {
    const index = queue.indexOf(task);
    if (index !== -1) queue.splice(index, 1);
  }

  /** @param {object} task 出队执行：活动槽计时自此开始。 */
  function start(task) {
    record(timing.queueWaitMs, Math.max(0, clock() - task.createdAt));
    task.state = 'active';
    task.startedAt = clock();
    active += 1;
    activeTasks.add(task);
    if (task.priority === 'background') {
      backgroundActive += 1;
      interactiveRun = 0;
    } else {
      interactiveRun += 1;
    }
    counters.executed += 1;
    Promise.resolve()
      .then(() => task.execute(task.controller.signal))
      .then(
        value => settle(task, true, value),
        error => {
          counters.errors += 1;
          settle(task, false, error);
        },
      )
      .finally(() => releaseSlot(task));
  }

  return {
    /**
     * @template T
     * @param {{ scope: object, priority?: ReadPriority, signal?: AbortSignal }} options
     * @param {(signal: AbortSignal) => Promise<T>} task
     * @returns {Promise<T>}
     */
    run({ scope, priority = 'interactive', signal }, task) {
      if (disposed) return Promise.reject(cancelledError());
      const internal = new AbortController();
      /** @type {(value: unknown) => void} */
      let resolveTask;
      /** @type {(error: unknown) => void} */
      let rejectTask;
      let settled = false;
      const promise = new Promise((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      });
      const onExternalAbort = () => {
        if (settled) return;
        if (entry.state === 'pending') cancelQueued(entry);
        else if (entry.state === 'active') abortActive(entry);
      };
      const entry = {
        scope,
        priority,
        execute: task,
        controller: internal,
        resolve: value => { settled = true; resolveTask(value); },
        reject: error => { settled = true; rejectTask(error); },
        get settled() { return settled; },
        state: 'pending',
        createdAt: clock(),
        startedAt: null,
        cleanup() {
          signal?.removeEventListener('abort', onExternalAbort);
        },
      };
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      // 待发满：新交互可淘汰最旧待发后台；后台与无可淘汰时拒绝，不无限堆积。
      if (queue.length >= pendingLimit) {
        if (priority === 'interactive') {
          const victim = queue.find(candidate => candidate.priority === 'background');
          if (victim !== undefined) {
            counters.evicted += 1;
            cancelQueued(victim);
          }
        }
        if (queue.length >= pendingLimit) {
          counters.queueFull += 1;
          entry.cleanup();
          return Promise.reject(queueFullError());
        }
      }

      queue.push(entry);
      counters.enqueued += 1;
      pump();
      return promise;
    },

    /** @param {object} scope 取消该 owner 的待发与在途任务。 */
    cancelScope(scope) {
      for (const task of [...queue]) {
        if (task.scope === scope && task.state === 'pending') cancelQueued(task);
      }
      for (const task of [...activeTasks]) {
        if (task.scope === scope) abortActive(task);
      }
    },

    /** 取消全部任务并停止接收；已在跑的任务只收到 abort，是否停止由它决定。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const task of [...queue]) cancelQueued(task);
      for (const task of [...activeTasks]) abortActive(task);
    },

    /** 聚合观测：活动与待发的即时数，其余为累计计数；不含任务正文与 scope。 */
    stats() {
      return {
        active,
        pending: queue.length,
        ...counters,
        queueWaitMs: { ...timing.queueWaitMs },
        runMs: { ...timing.runMs },
      };
    },
  };
}
