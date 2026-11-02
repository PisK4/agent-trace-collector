/**
 * perf-derive-worker.ts 的 Worker 入口：打开同一个 WAL 库，跑一组同步派生，
 * 把每步耗时回报主线程。不改变派生算法，只换执行位置。
 */
import { openStore } from '../src/store';
import { drainDeriveEntry } from '../src/derive/unit';

type StartMessage = { kind: 'start'; dbPath: string; convKey: string; actor: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as StartMessage;
  if (message.kind !== 'start') return;
  const store = openStore(message.dbPath);
  try {
    const started = performance.now();
    const steps: number[] = [];
    for (let call = 0; call < 100; call++) {
      const t = performance.now();
      const result = drainDeriveEntry(store, 1, { convKey: message.convKey });
      steps.push(performance.now() - t);
      const queue = store.read.query<{ state: string }, [string, string]>(
        'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?')
        .get(message.convKey, message.actor);
      if (queue?.state === 'clean') break;
      if (result.processed === 0 && result.discarded === 0 && result.groups.length === 0) break;
    }
    scope.postMessage({ kind: 'done', ms: performance.now() - started, steps });
  } catch (error) {
    scope.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    store.close();
  }
};
