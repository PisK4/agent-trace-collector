import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest } from './fixtures';
import { listRequests } from '../src/queries/requests';
import { getReadingDetail, getReadingBody } from '../src/reading';
import { projectSteps, projectTailReply } from '../web/trace-view.js';
import { createTraceModel } from '../web/trace-model.js';

/** 手工快照按 RequestRead 契约构造；contentRevision 模拟 store 的推进。 */
function snapshot(detail: any, extra: Record<string, unknown> = {}) {
  return {
    status: 'fresh', detailError: null, contentRevision: 1,
    token: detail.reading_token, detail, meta: null,
    messages: new Map(), entries: [],
    structure: { back: 0, next: 0, total: 0, ords: [], loading: false, error: null },
    delta: { next: 0, done: true, loading: false, error: null, unconfirmed: false },
    ...extra,
  };
}

function preparingStep(row: any) {
  return {
    key: `${row.req_id}:preparing`, reqId: row.req_id, kind: 'record' as const, text: '正在读取请求…',
    messageOrd: null, callOrd: null, source: null, raw: null, unrecognized: false,
    status: null, result: null, pairOwner: null,
  };
}

/** 组装 model 与计数：project/projectTail 包住真实投影并计数。 */
function countedModel() {
  let calls = 0;
  let tailCalls = 0;
  const model = createTraceModel({
    project: (row: any, read: any) => {
      calls += 1;
      return projectSteps(row, read);
    },
    projectTail: (row: any, read: any) => {
      tailCalls += 1;
      return projectTailReply(row, read);
    },
    preparing: preparingStep,
  });
  return { model, counter: { get calls() { return calls; }, get tailCalls() { return tailCalls; } } };
}

test('不变输入复用旧组投影', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'model-synthetic',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-synthetic').items;
    const snapshotOne = snapshot(getReadingDetail(f.store, id), {
      meta: getReadingBody(f.store, id, 0, 0, null),
    });
    const { model, counter } = countedModel();
    const input = { rows, reads: new Map([[id, snapshotOne]]), ready: new Set([id]),
      bgJobs: [], complete: false };
    model.update({ ...input, changedIds: [id] });
    expect(counter.calls).toBe(1);
    const before = model.get(id);
    model.update({ ...input, changedIds: [] });
    expect(counter.calls).toBe(1);
    expect(model.get(id)).toBe(before);
    model.reset();
  } finally { f.close(); }
});

test('相同 token 的消息新增推进修订后必须重投影', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'model-synthetic',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-synthetic').items;
    const first = snapshot(getReadingDetail(f.store, id));
    const { model, counter } = countedModel();
    const input = { rows, ready: new Set([id]), bgJobs: [], complete: false };
    model.update({ ...input, reads: new Map([[id, first]]), changedIds: [id] });
    expect(counter.calls).toBe(1);
    // 消息新增：token 不变，contentRevision 推进。
    const second = snapshot(getReadingDetail(f.store, id), { contentRevision: 2 });
    model.update({ ...input, reads: new Map([[id, second]]), changedIds: [] });
    expect(counter.calls).toBe(2);
    model.reset();
  } finally { f.close(); }
});

test('前驱变更只更新对应后继，无关组不动', () => {
  const f = fixture();
  try {
    const prevId = seedPurposeRequest(f.store, { convKey: 'model-deps',
      messages: [], cleanGroup: true, purposePending: 0 });
    const nextId = seedPurposeRequest(f.store, { convKey: 'model-deps',
      messages: [], cleanGroup: true, purposePending: 0 });
    const otherId = seedPurposeRequest(f.store, { convKey: 'model-deps',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-deps').items;
    const prevRow = rows.find(row => row.req_id === prevId)!;
    const nextRow = rows.find(row => row.req_id === nextId)!;
    const otherRow = rows.find(row => row.req_id === otherId)!;
    const prevDetail = getReadingDetail(f.store, prevId);
    const nextDetail = { ...getReadingDetail(f.store, nextId),
      prev_relation: 'confirmed', prev_req_id: prevId };
    const otherDetail = getReadingDetail(f.store, otherId);
    const prevSnap = snapshot(prevDetail);
    const nextSnap = snapshot(nextDetail);
    const otherSnap = snapshot(otherDetail);
    const reads = new Map([
      [prevId, prevSnap],
      [nextId, nextSnap],
      [otherId, otherSnap],
    ]);
    const { model, counter } = countedModel();
    const ready = new Set([prevId, nextId, otherId]);
    const input = { rows: [prevRow, nextRow, otherRow], reads, ready, bgJobs: [], complete: false };
    model.update({ ...input, changedIds: [prevId, nextId, otherId] });
    expect(counter.calls).toBe(3);
    // 前驱内容变化：后继沿依赖边重投影；无关组快照不变不重投。
    const prevNext = snapshot(prevDetail, { contentRevision: 2 });
    const readsNext = new Map([[prevId, prevNext], [nextId, nextSnap], [otherId, otherSnap]]);
    model.update({ ...input, reads: readsNext, changedIds: [prevId] });
    expect(counter.calls).toBe(5);
    // 再次传入相同输入：不再重投影。
    model.update({ ...input, reads: readsNext, changedIds: [] });
    expect(counter.calls).toBe(5);
    model.reset();
  } finally { f.close(); }
});

test('工具 owner 变化沿依赖边影响结果组', () => {
  const f = fixture();
  try {
    const ownerId = seedPurposeRequest(f.store, { convKey: 'model-tools',
      messages: [], cleanGroup: true, purposePending: 0 });
    const resultId = seedPurposeRequest(f.store, { convKey: 'model-tools',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-tools').items;
    const ownerRow = rows.find(row => row.req_id === ownerId)!;
    const resultRow = rows.find(row => row.req_id === resultId)!;
    const ownerDetail = getReadingDetail(f.store, ownerId);
    const resultDetail = { ...getReadingDetail(f.store, resultId),
      tool_results: [{ state: 'resolved', owner_req: ownerId, ord: 0, tool_use_id: 't1' }] };
    const reads = new Map([
      [ownerId, snapshot(ownerDetail)],
      [resultId, snapshot(resultDetail)],
    ]);
    const { model, counter } = countedModel();
    const input = { rows: [ownerRow, resultRow], reads, ready: new Set([ownerId, resultId]),
      bgJobs: [], complete: false };
    model.update({ ...input, changedIds: [ownerId, resultId] });
    expect(counter.calls).toBe(2);
    // owner 内容变化：owner 与结果组都重投影。
    const ownerNext = snapshot(ownerDetail, { contentRevision: 3 });
    const readsNext = new Map([[ownerId, ownerNext], [resultId, snapshot(resultDetail)]]);
    model.update({ ...input, reads: readsNext, changedIds: [ownerId] });
    expect(counter.calls).toBe(4);
    model.reset();
  } finally { f.close(); }
});

test('读取未备齐保留旧投影并声明归属，失败改标 failed', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'model-stale',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-stale').items;
    const first = snapshot(getReadingDetail(f.store, id));
    const { model, counter } = countedModel();
    const input = { rows, reads: new Map([[id, first]]), ready: new Set([id]),
      bgJobs: [], complete: false };
    model.update({ ...input, changedIds: [id] });
    expect(counter.calls).toBe(1);
    // 读取作废：资格丢失，保留旧投影并标 reading。
    model.update({ rows, reads: new Map(), ready: new Set(), bgJobs: [], complete: false, changedIds: [] });
    const retained = model.get(id);
    expect(retained?.stale).toBe('reading');
    expect(retained?.steps).toBe(first === null ? null : model.get(id)?.steps);
    // 失败态：同一保留投影改标 failed。
    const failed = { ...first, status: 'failed', detailError: 'unavailable' };
    model.update({ rows, reads: new Map([[id, failed]]), ready: new Set(), bgJobs: [], complete: false, changedIds: [] });
    expect(model.get(id)?.stale).toBe('failed');
    model.reset();
  } finally { f.close(); }
});

test('就绪资格集合引用变化不触发重投影', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'model-select',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-select').items;
    const snap = snapshot(getReadingDetail(f.store, id));
    const { model, counter } = countedModel();
    const reads = new Map([[id, snap]]);
    const bgJobs: unknown[] = [];
    model.update({ rows, reads, ready: new Set([id]), bgJobs, complete: false, changedIds: [id] });
    expect(counter.calls).toBe(1);
    // 选择与资格集合身份变化都不在证据修订里：不重投影。
    model.update({ rows, reads, ready: new Set([id]), bgJobs, complete: false, changedIds: [] });
    expect(counter.calls).toBe(1);
    model.reset();
  } finally { f.close(); }
});

test('未就绪且无缓存的组给占位步骤', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'model-placeholder',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-placeholder').items;
    const { model } = countedModel();
    model.update({ rows, reads: new Map(), ready: new Set(), bgJobs: [], complete: false, changedIds: [] });
    const view = model.get(id);
    expect(view?.placeholder).toBe(true);
    expect(view?.steps).toHaveLength(1);
    expect(view?.steps[0]?.key).toBe(`${id}:preparing`);
    model.reset();
  } finally { f.close(); }
});

test('bgJobs 引用变化使窗口全部失效，仅事件发生时执行', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'model-bgjobs',
      messages: [], cleanGroup: true, purposePending: 0 });
    const rows = listRequests(f.store, 'model-bgjobs').items;
    const snap = snapshot(getReadingDetail(f.store, id));
    const { model, counter } = countedModel();
    const input = { rows, reads: new Map([[id, snap]]), ready: new Set([id]), complete: false };
    const emptyJobs: unknown[] = [];
    model.update({ ...input, bgJobs: emptyJobs, changedIds: [id] });
    expect(counter.calls).toBe(1);
    model.update({ ...input, bgJobs: emptyJobs, changedIds: [] });
    expect(counter.calls).toBe(1);
    model.update({ ...input, bgJobs: [{ id: 1 }], changedIds: [] });
    expect(counter.calls).toBe(2);
    model.reset();
  } finally { f.close(); }
});
