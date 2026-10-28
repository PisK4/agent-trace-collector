import { expect, test } from 'bun:test';
import { createTracePreparation } from '../web/trace-preparation.js';
import type { ReaderStore, RequestRead } from '../web/reader-store.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(ids: number[]) {
  const rows = ids.map(req_id => ({ req_id }));
  const reads = new Map<number, any>();
  const starts: number[] = [];
  const completed: number[] = [];
  let getRequest = async (id: number) => reads.get(id);
  const store = {
    getWindow: () => ({ requests: rows }),
    peekRequest: (id: number) => reads.get(id) ?? null,
    readRequest: async (id: number) => { starts.push(id); return getRequest(id); },
    loadDelta: async (id: number, _pages: number) => reads.get(id),
  } as unknown as ReaderStore;
  const preparation = createTracePreparation(store, id => completed.push(id));
  const fresh = (id: number, extra: Record<string, unknown> = {}) => ({
    status: 'fresh', token: `token-${id}`, detail: { prev_relation: 'first', prev_req_id: null, tool_results: [] },
    meta: {}, delta: { done: true, error: null }, ...extra,
  });
  for (const id of ids) reads.set(id, fresh(id));
  return { rows, reads, starts, completed, store, preparation, fresh,
    onRead: (fn: (id: number) => Promise<RequestRead>) => { getRequest = fn; } };
}

test('目标先准备，其余每批四组，全部完成才结束', async () => {
  const h = harness([1, 2, 3, 4, 5, 6]);
  const first = gate(), batch = gate();
  h.onRead(async id => { await (id === 3 ? first.promise : batch.promise); return h.reads.get(id); });
  const pending = h.preparation.prepareWindow(3);
  await tick();
  expect(h.starts).toEqual([3]);
  first.release();
  await tick();
  expect(h.completed).toEqual([3]);
  expect(h.starts).toEqual([3, 1, 2, 4, 5]);
  batch.release();
  expect(await pending).toBe(true);
  expect(h.starts).toEqual([3, 1, 2, 4, 5, 6]);
  expect(h.completed).toHaveLength(6);
});

test('失败组重试期间撤下旧提交资格，完成后才恢复', async () => {
  const h = harness([1]);
  h.reads.set(1, { status: 'failed', detail: null, token: null });
  h.onRead(async () => { throw new Error('unavailable'); });
  await h.preparation.prepareWindow(null);
  expect(h.preparation.has(1)).toBe(true);
  const reread = gate();
  h.onRead(async () => { await reread.promise; h.reads.set(1, h.fresh(1)); return h.reads.get(1); });
  const retry = h.preparation.prepareWindow(null);
  expect(h.preparation.has(1)).toBe(false);
  reread.release();
  await retry;
  expect(h.preparation.has(1)).toBe(true);
});

test('等待依赖时请求版本更换，按新版本重新准备依赖', async () => {
  const h = harness([1, 2, 3]);
  const oldDependency = gate();
  h.reads.set(1, h.fresh(1, { token: 'old', detail: { prev_relation: 'confirmed', prev_req_id: 2, tool_results: [] } }));
  h.onRead(async id => { if (id === 2) await oldDependency.promise; return h.reads.get(id); });
  const pending = h.preparation.prepare(1);
  await tick();
  expect(h.starts).toEqual([1, 2]);
  h.reads.set(1, h.fresh(1, { token: 'new', detail: { prev_relation: 'confirmed', prev_req_id: 3, tool_results: [] } }));
  oldDependency.release();
  await pending;
  expect(h.starts).toContain(3);
  expect(h.preparation.has(1)).toBe(true);
});

test('等待依赖期间作废时交给 store 重读，不自行抢读', async () => {
  const h = harness([1, 2]);
  const dependency = gate();
  h.reads.set(1, h.fresh(1, { detail: { prev_relation: 'confirmed', prev_req_id: 2, tool_results: [] } }));
  h.onRead(async id => { if (id === 2) await dependency.promise; return h.reads.get(id); });
  const pending = h.preparation.prepare(1);
  await tick();
  h.reads.set(1, { status: 'invalidated', detail: null, token: null });
  dependency.release();
  await pending;
  expect(h.starts).toEqual([1, 2]);
  expect(h.preparation.has(1)).toBe(false);
});

test('换代后旧任务不得提交或释放新任务，同组并发共享任务', async () => {
  const h = harness([1]);
  const old = gate(), current = gate();
  let call = 0;
  h.onRead(async () => { await (++call === 1 ? old.promise : current.promise); return h.reads.get(1); });
  const first = h.preparation.prepare(1);
  expect(h.preparation.prepare(1)).toBe(first);
  h.preparation.reset();
  const second = h.preparation.prepare(1);
  old.release();
  await first;
  expect(h.completed).toEqual([]);
  expect(h.preparation.prepare(1)).toBe(second);
  current.release();
  await second;
  expect(h.completed).toEqual([1]);
  expect(h.starts).toEqual([1, 1]);
});

test('依赖只补窗口内已确认位置，失败降级，增量预算为二十片', async () => {
  const h = harness([1, 2, 3]);
  h.reads.set(1, h.fresh(1, {
    detail: { prev_relation: 'confirmed', prev_req_id: 2,
      tool_results: [{ state: 'resolved', owner_req: 3 }, { state: 'resolved', owner_req: 9 }, { state: 'pending', owner_req: 2 }] },
    delta: { done: false, error: null },
  }));
  h.onRead(async id => { if (id === 2) throw new Error('unavailable'); return h.reads.get(id); });
  let pieces = 0;
  h.store.loadDelta = async (id, count = 2) => { pieces += count; return h.reads.get(id); };
  await h.preparation.prepare(1);
  expect(h.starts).toEqual([1, 2, 3]);
  expect(pieces).toBe(20);
  expect(h.preparation.has(1)).toBe(true);
});
