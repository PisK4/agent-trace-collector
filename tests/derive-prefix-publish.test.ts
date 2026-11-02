import { expect, test } from 'bun:test';
import { applyDeriveGroup, computeDeriveGroup, drainDerive, enqueueDerive } from '../src/derive/sync';
import { POSITION_ALL, positionKey, requestPositionTx } from '../src/derive/state';
import { drainRequestPurposesTx } from '../src/request-purpose';
import { getRequest, listRequests } from '../src/queries/requests';
import { fixture, seedTextChain } from './fixtures';
import type { Store } from '../src/store';

// 一致前缀发布：输入在计划之后变过时，只写最早受影响位置之前的行；读侧按同一位置放行。

const CONV = JSON.stringify(['session', 'chain']);
const ACTOR = 'actor-a';

function seedGroup(store: Store, sessions: string[][]): number[] {
  const ids = seedTextChain(store, sessions);
  enqueueDerive(store, CONV, ACTOR, '');
  store.write(db => drainRequestPurposesTx(db, 100, { convKey: CONV }), 'purpose');
  return ids;
}

/** 计划在手之后又有输入变化：位置取某一笔请求的开始时刻，等价于"从这一笔起变了"。 */
function touchFrom(store: Store, reqId: number): void {
  const position = store.write(db => requestPositionTx(db, reqId));
  store.write(db => db.run(
    `UPDATE derive_queue SET input_revision=input_revision+1,state='dirty',from_sort=?
     WHERE conv_key=? AND actor=?`, [position, CONV, ACTOR]));
}

test('冲突轮只写边界之前的行，组保持 dirty', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    const round = computeDeriveGroup(f.store.read, CONV, ACTOR);
    expect(round).not.toBeNull();
    // 第三笔（started_ms=1002）起输入变了：前两笔的祖先与自身输入都没变。
    touchFrom(f.store, 3);
    f.store.write(db => applyDeriveGroup(db, round!), 'derive');
    const rows = f.store.read.query<{
      req_id: number; prev_req_id: number | null; prev_relation: string | null;
      chain_role: string; title: string | null;
    }, []>('SELECT req_id,prev_req_id,prev_relation,chain_role,title FROM request ORDER BY req_id').all();
    // 前缀两笔写下关系与标题；链角色是整组产物，一行都没写。
    expect(rows[0]).toMatchObject({ prev_req_id: null, prev_relation: 'first', chain_role: 'main', title: 'A' });
    expect(rows[1]).toMatchObject({ prev_req_id: 1, prev_relation: 'confirmed', chain_role: 'main', title: 'B' });
    // 边界那一笔与它之后的行原样不动。
    expect(rows[2]).toMatchObject({ prev_req_id: null, prev_relation: null, chain_role: 'main', title: 'seed' });
    // 工具配对与后台作业是整组产物，冲突轮一条都不写。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM tool_call').get()).toEqual({ n: 0 });
    const queue = f.store.read.query<{ state: string; published_revision: number; input_revision: number; from_sort: string }, []>(
      'SELECT state,published_revision,input_revision,from_sort FROM derive_queue').get()!;
    expect(queue.state).toBe('dirty');
    expect(queue.published_revision).not.toBe(queue.input_revision);
    expect(queue.from_sort).toBe(positionKey(1002));
  } finally {
    f.close();
  }
});

test('冲突轮之后整组完成，from_sort 回到全体', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    const stale = computeDeriveGroup(f.store.read, CONV, ACTOR);
    touchFrom(f.store, 3);
    f.store.write(db => applyDeriveGroup(db, stale!), 'derive');
    // 下一轮按最新输入重算，整组落库并清脏。
    drainDerive(f.store);
    const queue = f.store.read.query<{ state: string; from_sort: string }, []>(
      'SELECT state,from_sort FROM derive_queue').get()!;
    expect(queue).toEqual({ state: 'clean', from_sort: POSITION_ALL });
    const roles = f.store.read.query<{ req_id: number; chain_role: string; prev_relation: string | null }, []>(
      'SELECT req_id,chain_role,prev_relation FROM request ORDER BY req_id').all();
    expect(roles).toEqual([
      { req_id: 1, chain_role: 'main', prev_relation: 'first' },
      { req_id: 2, chain_role: 'main', prev_relation: 'confirmed' },
      { req_id: 3, chain_role: 'main', prev_relation: 'confirmed' },
    ]);
  } finally {
    f.close();
  }
});

test('位置未知的冲突轮整轮作废，一行都不写', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B']]);
    const round = computeDeriveGroup(f.store.read, CONV, ACTOR);
    // 来源没给位置（历史脏标记的形态）：不能判断哪一段还成立。
    f.store.write(db => db.run(
      `UPDATE derive_queue SET input_revision=input_revision+1,state='dirty',from_sort=''
       WHERE conv_key=? AND actor=?`, [CONV, ACTOR]));
    expect(() => f.store.write(db => applyDeriveGroup(db, round!), 'derive')).toThrow('derive_input_changed');
    const rows = f.store.read.query<{ title: string | null; prev_relation: string | null }, []>(
      'SELECT title,prev_relation FROM request ORDER BY req_id').all();
    expect(rows).toEqual([{ title: 'seed', prev_relation: null }, { title: 'seed', prev_relation: null }]);
  } finally {
    f.close();
  }
});

test('可写集合按库里此刻的位置取，不按计划算时的位置', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    const stale = computeDeriveGroup(f.store.read, CONV, ACTOR);
    touchFrom(f.store, 3);
    // 第二笔的开始时刻被改到边界之后：它在计划里属于前缀，落库时已不在前缀里。
    f.store.write(db => db.run('UPDATE request SET started_ms=? WHERE req_id=?', [1500, 2]));
    f.store.write(db => applyDeriveGroup(db, stale!), 'derive');
    const rows = f.store.read.query<{ req_id: number; prev_relation: string | null }, []>(
      'SELECT req_id,prev_relation FROM request ORDER BY req_id').all();
    expect(rows[0]!.prev_relation).toBe('first');
    expect(rows[1]!.prev_relation).toBeNull();
    expect(rows[2]!.prev_relation).toBeNull();
  } finally {
    f.close();
  }
});

test('脏组里前缀行可读行级产物，链角色与边界之后的行仍是中性值', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    const stale = computeDeriveGroup(f.store.read, CONV, ACTOR);
    touchFrom(f.store, 3);
    f.store.write(db => applyDeriveGroup(db, stale!), 'derive');
    const page = listRequests(f.store, CONV, 10);
    const [first, second, third] = page.items;
    // 前缀行：标题与摘要按落库值返回，并标明它还没等到整组完成。
    expect(first).toMatchObject({
      derived_state: 'dirty', derived_prefix: true, title: 'A', chain_role: 'unknown',
    });
    expect(second).toMatchObject({ derived_state: 'dirty', derived_prefix: true, title: 'B' });
    // 边界那一笔：前缀不成立，退回时间占位标题与空摘要。
    expect(third).toMatchObject({ derived_state: 'dirty', derived_prefix: false, chain_role: 'unknown' });
    expect(third!.input_preview).toBeNull();
    // 详情层：关系与增量对前缀行放行，链状态记成 prefix。
    const detail = getRequest(f.store, 2)!;
    expect(detail.derivation).toMatchObject({ state: 'dirty', chain_state: 'prefix' });
    expect(detail.prev_relation).toBe('confirmed');
    expect(detail.prev_req_id).toBe(1);
    expect(detail.delta_ordinals).toEqual([1]);
    // 边界之后的行没有关系可读。
    const boundary = getRequest(f.store, 3)!;
    expect(boundary.derivation).toMatchObject({ state: 'dirty', chain_state: 'unavailable' });
    expect(boundary.prev_relation).toBeNull();
    expect(boundary.delta_ordinals).toBeNull();
  } finally {
    f.close();
  }
});

test('发布代非空的组不参与前缀发布', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B']]);
    const stale = computeDeriveGroup(f.store.read, CONV, ACTOR);
    touchFrom(f.store, 2);
    f.store.write(db => applyDeriveGroup(db, stale!), 'derive');
    // 切片路径留下的发布代：行值由代际发布给出，`from_sort` 不描述那一次发布。
    f.store.write(db => db.run(
      `UPDATE derive_queue SET published_generation='gen-x' WHERE conv_key=? AND actor=?`,
      [CONV, ACTOR]));
    const page = listRequests(f.store, CONV, 10);
    expect(page.items.every(item => item.derived_prefix === false)).toBe(true);
    expect(getRequest(f.store, 1)!.derivation).toMatchObject({ chain_state: 'unavailable' });
  } finally {
    f.close();
  }
});

test('整组完成后前缀标记消失', () => {
  const f = fixture();
  try {
    seedGroup(f.store, [['A'], ['A', 'B']]);
    drainDerive(f.store);
    const page = listRequests(f.store, CONV, 10);
    expect(page.items.every(item => item.derived_state === 'current' && item.derived_prefix === false)).toBe(true);
    const detail = getRequest(f.store, 2)!;
    expect(detail.derivation.chain_state).toBe('current');
    expect(detail.chain_role).toBe('main');
  } finally {
    f.close();
  }
});
