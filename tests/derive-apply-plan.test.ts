import { expect, test } from 'bun:test';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { applyDeriveGroup, computeDeriveGroup, drainDeriveGroupTx } from '../src/derive/sync';
import { drainRequestPurposesTx } from '../src/request-purpose';
import { fixture, seedTextChain } from './fixtures';
import type { Store } from '../src/store';

// 算/写接缝：计算段只读产出计划，落库段一个事务执行计划。

const CONV = JSON.stringify(['session', 'chain']);
const ACTOR = 'actor-a';
/** 组的用途判定先结算：在线单元也是先判用途再算组，计算段自己不做这一步。 */
function seedGroup(store: Store, sessions: string[][]): void {
  seedTextChain(store, sessions);
  enqueueDerive(store, CONV, ACTOR, '');
  store.write(db => drainRequestPurposesTx(db, 100, { convKey: CONV }), 'purpose');
}
// 组世代是随机号，不是派生结论：两个库比对前先对齐，其余列逐列比。
const ORDER: Record<string, string> = {
  request: 'req_id', tool_call: 'req_id,ord', bg_job: 'conv_key,job_id',
  derive_queue: 'conv_key,actor',
};
// 跨库比对要抹掉的行身份与写入时钟：它们由种子生成，不是派生结论。
const VOLATILE = new Set(['input_epoch', 'created_at', 'updated_at']);

/** 派生会写的表的全列快照；BLOB 列与不稳定列排除，按主键排序。 */
function dumpTables(store: Store): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  for (const [table, order] of Object.entries(ORDER)) {
    const columns = (store.read.query(`PRAGMA table_info(${table})`).all() as {
      name: string; type: string;
    }[]).filter(column => column.type !== 'BLOB' && !VOLATILE.has(column.name))
      .map(column => column.name);
    dump[table] = store.read.query(
      `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${order}`).all();
  }
  // summary_basis 里带着本行的输入身份，同样换成占位符再比。
  const epochs = new Map(store.read.query<{ req_id: number; input_epoch: string }, []>(
    'SELECT req_id,input_epoch FROM request').all().map(row => [row.req_id, row.input_epoch]));
  for (const row of dump.request as Record<string, unknown>[]) {
    if (typeof row.summary_basis === 'string') {
      row.summary_basis = row.summary_basis.split(epochs.get(row.req_id as number)!).join('<epoch>');
    }
  }
  return dump;
}

function alignEpoch(from: Store, to: Store): void {
  const epoch = from.read.query<{ group_epoch: string }, []>(
    'SELECT group_epoch FROM derive_queue').get()!.group_epoch;
  to.write(db => db.run('UPDATE derive_queue SET group_epoch=?', [epoch]));
}

test('计算段只读：只读连接上算完计划，写计数与库内容都不变', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    const before = dumpTables(f.store);
    const writes = f.store.writeStats.count;
    // 只读连接开了 query_only：计算段一旦有写语句就会直接抛错。
    const round = computeDeriveGroup(f.store.read, CONV, ACTOR);
    expect(round).not.toBeNull();
    expect(f.store.writeStats.count).toBe(writes);
    expect(dumpTables(f.store)).toEqual(before);
    // 计划里的关系与角色就是本轮结论：首笔起链，后两笔各自续上前一笔。
    expect(round!.plan.chain.map(row => [row.reqId, row.prevReqId, row.relation, row.chainRole]))
      .toEqual([[1, null, 'first', 'main'], [2, 1, 'confirmed', 'main'], [3, 2, 'confirmed', 'main']]);
    expect(round!.plan.roles).toEqual([
      { reqId: 1, role: 'main' }, { reqId: 2, role: 'main' }, { reqId: 3, role: 'main' },
    ]);
    // 读数与整组规模一致：三笔全部重算，没有保留行。
    expect(round!.outcome).toMatchObject({ processed: 3, recomputed: 3, retained: 0 });
    expect(round!.plan.normalize_algorithm).toBe(false);
  } finally {
    f.close();
  }
});

test('读连接算出的计划落库与单事务路径逐表一致', () => {
  const a = fixture();
  const b = fixture();
  try {
    for (const f of [a, b]) {
      seedGroup(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    }
    alignEpoch(a.store, b.store);
    const round = computeDeriveGroup(a.store.read, CONV, ACTOR);
    expect(round).not.toBeNull();
    // A：只读连接算 + 独立写事务落库；B：旧口径，读与写同一个事务。
    expect(a.store.write(db => applyDeriveGroup(db, round!))).toEqual(round!.outcome);
    expect(b.store.write(db => drainDeriveGroupTx(db, CONV, ACTOR))).toEqual(round!.outcome);
    expect(dumpTables(a.store)).toEqual(dumpTables(b.store));
  } finally {
    a.close();
    b.close();
  }
});

test('计划落库前输入变过就整轮丢弃，库回到计划前状态', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B']]);
    const round = computeDeriveGroup(f.store.read, CONV, ACTOR);
    expect(round).not.toBeNull();
    // 计划在手之后又来了一笔：CAS 的 group_epoch 与 input_revision 对不上。
    enqueueDerive(f.store, CONV, ACTOR, '');
    const before = dumpTables(f.store);
    expect(() => f.store.write(db => applyDeriveGroup(db, round!))).toThrow('derive_input_changed');
    // 落库段整体回滚：一条链关系、一个角色、一行工具都没有留下。
    expect(dumpTables(f.store)).toEqual(before);
  } finally {
    f.close();
  }
});

test('没有待办组时计算段返回 null 且不写', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B']]);
    drainDerive(f.store);
    const before = dumpTables(f.store);
    const writes = f.store.writeStats.count;
    expect(computeDeriveGroup(f.store.read, CONV, ACTOR)).toBeNull();
    expect(f.store.writeStats.count).toBe(writes);
    expect(dumpTables(f.store)).toEqual(before);
  } finally {
    f.close();
  }
});