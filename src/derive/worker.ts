import type { DeriveGroupRound } from './sync';

const ENTRY = new URL('./worker-entry.ts', import.meta.url).href;

type Reply =
  | { kind: 'result'; id: number; round: DeriveGroupRound | null }
  | { kind: 'error'; id: number; message: string };

export type DeriveWorker = {
  /** 在计算线程算一组，返回计划与读数；`null` 表示这一组本轮不该做。 */
  compute(convKey: string, actor: string): Promise<DeriveGroupRound | null>;
  /** 终止线程并拒绝在飞的请求；之后的 `compute` 一律失败。 */
  close(): void;
};

/**
 * 计算段的执行位置。懒启动：没有积压时不起线程，空闲进程不多一个 Worker。
 *
 * 一次只有一个在飞请求：在线派生由 `guard` 按任务名防重入，第二个请求说明
 * 调用方绕过了调度，直接拒绝而不是排队——排队会把丢弃变成静默延迟。
 *
 * Worker 出错或退出时拒绝在飞请求并丢弃实例：下一轮重起一个，组仍是 dirty，
 * 不会半发布。
 */
export function createDeriveWorker(dbPath: string): DeriveWorker {
  let worker: Worker | null = null;
  let pending: {
    id: number; resolve: (round: DeriveGroupRound | null) => void; reject: (error: Error) => void;
  } | null = null;
  let nextId = 1;
  let closed = false;

  function drop(error: Error): void {
    const current = pending;
    pending = null;
    if (worker !== null) {
      worker.terminate();
      worker = null;
    }
    current?.reject(error);
  }

  function start(): Worker {
    const created = new Worker(ENTRY);
    created.onmessage = (event: MessageEvent) => {
      const reply = event.data as Reply;
      const current = pending;
      // 迟到回复（上一轮已因出错被拒绝）按 id 丢弃，不改当前请求的状态。
      if (current === null || reply.id !== current.id) return;
      pending = null;
      if (reply.kind === 'error') current.reject(new Error(reply.message));
      else current.resolve(reply.round);
    };
    created.onerror = event => drop(new Error(String(event.message ?? 'derive_worker_error')));
    return created;
  }

  return {
    compute(convKey, actor) {
      if (closed) return Promise.reject(new Error('derive_worker_closed'));
      if (pending !== null) return Promise.reject(new Error('derive_worker_busy'));
      worker ??= start();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
        worker!.postMessage({ kind: 'compute', id, dbPath, convKey, actor });
      });
    },
    close() {
      closed = true;
      drop(new Error('derive_worker_closed'));
    },
  };
}
