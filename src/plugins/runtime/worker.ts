/**
 * 社区轨执行线程：外部代码只在这里跑，崩溃、死循环与抛错都止步于这个实例。
 *
 * 队列单飞：一个线程同一时刻只跑一个任务。读路径的并发来自多个页面请求，与
 * 派生的防重入不同，后来的任务排队而不是直接拒绝。超时到点就 terminate 并
 * 丢弃实例；出错或超时的包记入 dead，本进程内不再重试，避免每次读都等满一个
 * 超时。线程消息只回固定分类码，包内的异常文本不外传。
 */
import type { CommunityTodoSource, TodoCall } from '../types';
import type { TodoSnapshot } from '../todo/dto';

const ENTRY = new URL('./worker-entry.ts', import.meta.url).href;
/** 折叠一个包的一批调用只该是内存操作；超过这个量级视为包卡住。 */
const DEFAULT_TIMEOUT_MS = 1500;

type Reply =
  | { kind: 'result'; id: number; snapshot: TodoSnapshot | null }
  | { kind: 'error'; id: number; code: string };

type Task = {
  id: number; entryPath: string; agent: string;
  previous: TodoSnapshot | null; calls: readonly TodoCall[];
  resolve: (snapshot: TodoSnapshot | null) => void;
  reject: (error: Error) => void;
};

export type CommunityWorker = {
  /** 让一个包折叠一批调用；失败时 reject 固定分类码。 */
  fold(entryPath: string, agent: string, previous: TodoSnapshot | null,
    calls: readonly TodoCall[]): Promise<TodoSnapshot | null>;
  close(): void;
};

export type CommunityWorkerOptions = {
  timeoutMs?: number;
  /** 线程错误、超时或包内异常时上报固定分类码；正常 close 不报。 */
  onFailure?: (code: string) => void;
};

export function createCommunityWorker(options: CommunityWorkerOptions = {}): CommunityWorker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dead = new Set<string>();
  const queue: Task[] = [];
  let worker: Worker | null = null;
  let current: Task | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let closed = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stopWorker(): void {
    if (worker !== null) {
      worker.terminate();
      worker = null;
    }
  }

  /** 当前任务失败：终止线程、记死该包、放行队列里的下一个。 */
  function fail(code: string): void {
    const task = current;
    current = null;
    clearTimer();
    stopWorker();
    if (task !== null) {
      dead.add(task.entryPath);
      options.onFailure?.(code);
      task.reject(new Error(code));
    }
    pump();
  }

  function start(): Worker {
    const created = new Worker(ENTRY);
    created.onmessage = (event: MessageEvent) => {
      const reply = event.data as Reply;
      const task = current;
      // 迟到回复按 id 丢弃：超时或崩溃后实例已换，旧回复不能写回。
      if (task === null || reply.id !== task.id) return;
      current = null;
      clearTimer();
      if (reply.kind === 'error') {
        dead.add(task.entryPath);
        options.onFailure?.(reply.code);
        task.reject(new Error(reply.code));
      } else {
        task.resolve(reply.snapshot);
      }
      pump();
    };
    created.onerror = event => fail(String(event.message ?? 'plugin_worker_error'));
    return created;
  }

  function pump(): void {
    if (closed || current !== null || queue.length === 0) return;
    const task = queue.shift()!;
    if (dead.has(task.entryPath)) {
      task.reject(new Error('plugin_failed'));
      pump();
      return;
    }
    current = task;
    worker ??= start();
    timer = setTimeout(() => fail('plugin_timeout'), timeoutMs);
    worker.postMessage({
      kind: 'fold', id: task.id, entryPath: task.entryPath,
      agent: task.agent, previous: task.previous, calls: task.calls,
    });
  }

  return {
    fold(entryPath, agent, previous, calls) {
      if (closed) return Promise.reject(new Error('plugin_worker_closed'));
      if (dead.has(entryPath)) return Promise.reject(new Error('plugin_failed'));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, entryPath, agent, previous, calls, resolve, reject });
        pump();
      });
    },
    close() {
      closed = true;
      clearTimer();
      stopWorker();
      const pending = current === null ? queue.splice(0) : [current, ...queue.splice(0)];
      current = null;
      for (const task of pending) task.reject(new Error('plugin_worker_closed'));
    },
  };
}

/** 把清单里通过校验的包接成查询层认识的折叠入口；次序即认领优先级。 */
export function communitySources(
  packages: readonly { agent: string; entryPath: string }[],
  worker: CommunityWorker,
): CommunityTodoSource[] {
  return packages.map(pkg => ({
    agent: pkg.agent,
    fold: (previous, calls) => worker.fold(pkg.entryPath, pkg.agent, previous, calls),
  }));
}