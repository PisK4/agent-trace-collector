import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture, seedChain, seedRequest, SEED_GROUP } from './fixtures';
import type { ChainSeed } from './fixtures';
import { persistBody } from '../src/body';
import { drainDeriveTx, enqueueDerive } from '../src/derive';
import { GROUP_ALGORITHM } from '../src/derive-state';
import {
  DERIVE_ALGORITHM, beginGeneration, discardGeneration,
  drainDeriveEntry, publishGeneration, readEffectiveGroup, recoverSlice, sliceGroupStep,
  sliceRequestsStage, sliceRolesStage, sliceSummaryStage, sliceToolsStage, sliceReadyStage,
} from '../src/derive-slice';
import type { SliceStep } from '../src/derive-slice';
import { DEFAULT_DERIVE_BUDGET } from '../src/config';
import type { SliceRuntime } from '../src/config';

function seedGroup(f: ReturnType<typeof fixture>): void {
  f.store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,title,title_source,
      input_epoch,input_revision,purpose_revision,purpose_version,req_kind,model_title)
      VALUES (1,'c','a','known',100,'2026-10-22','hook','available',0,1,1,1,
        'old title','model_time','e1',7,11,3,'chat','model title')`);
    db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
      published_revision,target_algorithm,published_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',7,7,5,5,'dirty',50)`);
  });
}

function seedResult(f: ReturnType<typeof fixture>, generation: string, title: string | null): void {
  f.store.write(db => db.run(`INSERT INTO derive_request_result(
    generation,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
    title,title_source,traversal_ord,purpose_revision,purpose_version,algorithm,
    retention_state,basis_json)
    VALUES (?,1,'e1',7,NULL,NULL,100,?,'model_time',0,11,3,5,'recomputed','{}')`,
    [generation, title]));
}

function readyGeneration(f: ReturnType<typeof fixture>, generation: string): void {
  f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
    request_count=1 WHERE generation=?`, [generation]));
}

test('发布指针原子切换并保留旧代结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const first = beginGeneration(f.store, 'c', 'a', 1000)!;
    expect(first).toStartWith('gen-');
    seedResult(f, first, 'first title');
    readyGeneration(f, first);
    expect(publishGeneration(f.store.db, first, 1100)).toBe(true);
    let queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue).toMatchObject({ state: 'clean', published_generation: first,
      published_revision: 7, published_algorithm: 5, legacy_snapshot: 0 });
    expect(queue.compute_generation).toBeNull();

    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',
      input_revision=8,dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const second = beginGeneration(f.store, 'c', 'a', 1300)!;
    seedResult(f, second, 'second title');
    readyGeneration(f, second);
    expect(publishGeneration(f.store.db, second, 1400)).toBe(true);
    queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue.published_generation).toBe(second);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(first)).toEqual({ state: 'retired' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(first)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('修订变化使旧代失去发布资格并丢弃结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, 'stale title');
    readyGeneration(f, generation);
    f.store.write(db => db.run(`UPDATE derive_queue SET input_revision=8 WHERE conv_key='c' AND actor='a'`));
    expect(publishGeneration(f.store.db, generation, 1100)).toBe(false);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>)
      .published_generation).toBeNull();
  } finally { f.close(); }
});

test('重开丢弃未发布代际，不碰上一代已发布结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const published = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, published, 'published title');
    readyGeneration(f, published);
    publishGeneration(f.store.db, published, 1100);
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=8,
      dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const building = beginGeneration(f.store, 'c', 'a', 1300)!;
    seedResult(f, building, 'unpublished');
    expect(recoverSlice(f.store.db, 1400)).toBe(1);
    const queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue.state).toBe('dirty');
    expect(queue.compute_generation).toBeNull();
    expect(queue.published_generation).toBe(published);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(building)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(published)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('同快照读取按组状态屏蔽且不回退旧请求列', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, null);
    readyGeneration(f, generation);
    publishGeneration(f.store.db, generation, 1100);
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=8,
      dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const masked = readEffectiveGroup(f.store.read, 'c', 'a');
    expect(masked.state).toBe('masked');
    expect(masked.rows).toEqual([]);

    f.store.write(db => db.run(`UPDATE derive_queue SET state='clean',input_revision=7,
      published_revision=7 WHERE conv_key='c' AND actor='a'`));
    const current = readEffectiveGroup(f.store.read, 'c', 'a');
    expect(current.state).toBe('current');
    expect(current.rows[0]).toMatchObject({
      generation, req_kind: 'chat', model_title: 'model title', title: null,
    });
    // request.title 仍是 'old title'；结果 title 为 NULL 时必须保持 NULL。
    expect(current.rows[0]!.title).toBeNull();
  } finally { f.close(); }
});

test('丢弃已发布代际时不动结果，也不清发布指针', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, 'kept title');
    readyGeneration(f, generation);
    publishGeneration(f.store.db, generation, 1100);
    discardGeneration(f.store.db, generation, 'slice_request_budget', 1200);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'published' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 1 });
    const queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue.published_generation).toBe(generation);
    expect(queue.state).toBe('clean');
  } finally { f.close(); }
});
/**
 * 阶段级测试直接调阶段函数，绕开了调度入口的算法号归一；这里把队列行补成
 * 切片算法号，让 `beginGeneration` 的认领校验能过。
 */
function switchToSliceAlgorithm(f: ReturnType<typeof fixture>): void {
  f.store.write(db => db.run(
    'UPDATE derive_queue SET target_algorithm=? WHERE conv_key=? AND actor=?',
    [DERIVE_ALGORITHM, SEED_GROUP.convKey, SEED_GROUP.actor],
  ));
}

type StageFn = (store: ReturnType<typeof fixture>['store'], generation: string,
  budget: typeof DEFAULT_DERIVE_BUDGET, now: number) => SliceStep;

/** 把一个阶段驱动到不再前进为止；返回最后那次（无事可做或阶段已推进）的结果。 */
function runStage(
  f: ReturnType<typeof fixture>,
  generation: string,
  stage: StageFn,
  budget: typeof DEFAULT_DERIVE_BUDGET = DEFAULT_DERIVE_BUDGET,
): SliceStep {
  let step = stage(f.store, generation, budget, 20);
  let guard = 0;
  while (step.status === 'advanced' && guard++ < 5000) {
    step = stage(f.store, generation, budget, 20);
  }
  return step;
}

type ChainOutcome = {
  req_id: number; prev_req_id: number | null; prev_relation: string | null;
  delta_ordinals: string | null; chain_role: string;
};

const CHAIN_COLUMNS = 'req_id,prev_req_id,prev_relation,delta_ordinals,chain_role';

function sliceChainRows(f: ReturnType<typeof fixture>, generation: string): ChainOutcome[] {
  return f.store.read.query<ChainOutcome, [string]>(`SELECT ${CHAIN_COLUMNS}
    FROM derive_request_result WHERE generation=? ORDER BY req_id`).all(generation);
}

/** 同步路径在同一组输入上的对照结果：等价性就是拿它与切片逐行比。 */
function syncChainRows(f: ReturnType<typeof fixture>): ChainOutcome[] {
  f.store.write(db => drainDeriveTx(db, { limit: 100 }));
  return f.store.read.query<ChainOutcome, [string, string]>(`SELECT ${CHAIN_COLUMNS}
    FROM request WHERE conv_key=? AND actor=? ORDER BY req_id`)
    .all(SEED_GROUP.convKey, SEED_GROUP.actor);
}

test('请求切片分批物化并按A比较器写traversal_ord', () => {
  const f = fixture();
  try {
    const ids = seedRequest(f.store, [
      { req_id: 1, started_ms: 200, sort_source: 'ledger', sort_key: '1:1:1:1|00000000000000000001' },
      { req_id: 2, started_ms: 100, sort_source: 'ledger', sort_key: '1:1:1:1|00000000000000000002' },
      { req_id: 3, started_ms: 100, sort_source: 'ledger', sort_key: '1:1:1:1|00000000000000000001' },
      { req_id: 4, started_ms: 300, sort_source: null, sort_key: null },
    ]);
    expect(ids).toEqual([1, 2, 3, 4]);
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] },
      reply: { content: [{ type: 'tool_use', id: 'call-1', name: 'read' }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: {
        messages: [{ role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }],
      },
      reply: { content: [{ type: 'text', text: 'done' }] },
      redact_version: 1,
    });
    f.store.write(db => db.run("UPDATE request SET body_state='missing' WHERE req_id=4"));
    switchToSliceAlgorithm(f);

    const generation = beginGeneration(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 2, maxWritesPerBatch: 8 };
    const step = runStage(f, generation, sliceRequestsStage, budget);
    // 驱动到停为止：最后一次调用无事可做，stage 已经过到角色阶段。
    expect(step.status).toBe('idle');
    expect(step.stage).toBe('roles');

    const rows = f.store.read.query<{ req_id: number; traversal_ord: number;
      retention_state: string }, [string]>(`SELECT req_id,traversal_ord,retention_state
      FROM derive_request_result WHERE generation=? ORDER BY traversal_ord`).all(generation);
    // 同一毫秒的账本行按同代际偏移定序，不看 req_id；时间不同的按时间。
    expect(rows.map(row => row.req_id)).toEqual([3, 2, 1, 4]);
    expect(rows.map(row => row.traversal_ord)).toEqual([0, 1, 2, 3]);
    // 正文读不出来的两笔按旧值保留，读得出来的两笔标成本次重算。
    expect(rows.map(row => row.retention_state))
      .toEqual(['retained', 'recomputed', 'recomputed', 'retained']);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_call_work WHERE generation=?')
      .get(generation)).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_result_work WHERE generation=?')
      .get(generation)).toEqual({ n: 1 });
    // 候选带上遍历序写回：配对阶段要按请求顺序推进。
    expect(f.store.read.query<{ traversal_ord: number }, [string]>(
      'SELECT traversal_ord FROM derive_call_work WHERE generation=?').get(generation))
      .toEqual({ traversal_ord: 2 });
    expect(f.store.read.query<{ stage: string; request_count: number }, [string]>(
      'SELECT stage,request_count FROM derive_generation WHERE generation=?').get(generation))
      .toEqual({ stage: 'roles', request_count: 4 });
  } finally { f.close(); }
});

test('请求切片在读取窗口内输入变化时丢弃整代', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [
      { req_id: 1, started_ms: 100, sort_source: null, sort_key: null },
      { req_id: 2, started_ms: 200, sort_source: null, sort_key: null },
    ]);
    // 这一组没有正文，不会由摄入路径自动造出队列行，所以直接种一行。
    f.store.write(db => db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,
      input_revision,published_revision,target_algorithm,state,dirty_since_ms)
      VALUES (?,?,'','g1',0,-1,?,'dirty',10)`,
    [SEED_GROUP.convKey, SEED_GROUP.actor, DERIVE_ALGORITHM]));
    const generation = beginGeneration(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1, maxWritesPerBatch: 1 };
    // 只走一批，让代停在请求阶段；随后再动组修订，模拟页之间夹进来的输入变化。
    const first = sliceRequestsStage(f.store, generation, budget, 20);
    expect(first.status).toBe('advanced');
    expect(first.stage).toBe('requests');
    f.store.write(db => db.run('UPDATE derive_queue SET input_revision=input_revision+1'));
    const second = sliceRequestsStage(f.store, generation, budget, 21);
    expect(second.status).toBe('discarded');
    expect(f.store.read.query<{ state: string }, [string]>(
      'SELECT state FROM derive_generation WHERE generation=?').get(generation))
      .toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
    expect(f.store.read.query<{ compute_generation: string | null; last_error: string | null }, []>(
      'SELECT compute_generation,last_error FROM derive_queue').get())
      .toEqual({ compute_generation: null, last_error: 'slice_group_revision_changed' });
  } finally { f.close(); }
});

/**
 * 把同一组输入喂给切片与同步两条路径，返回两边的关系与角色。
 *
 * `prepare` 在两个 fixture 上做同一件事：要构造不可读正文这类状态时，
 * 两边必须一样，否则比的不是路径差异而是输入差异。
 */
function chainOnBothPaths(
  sessions: readonly ChainSeed[],
  prepare?: (f: ReturnType<typeof fixture>) => void,
): { slice: ChainOutcome[]; sync: ChainOutcome[] } {
  const sliced = fixture();
  const synced = fixture();
  try {
    seedChain(sliced.store, sessions);
    seedChain(synced.store, sessions);
    prepare?.(sliced);
    prepare?.(synced);
    switchToSliceAlgorithm(sliced);
    const generation = beginGeneration(
      sliced.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1, maxWritesPerBatch: 2 };
    runStage(sliced, generation, sliceRequestsStage, budget);
    runStage(sliced, generation, sliceRolesStage, budget);
    return { slice: sliceChainRows(sliced, generation), sync: syncChainRows(synced) };
  } finally {
    sliced.close();
    synced.close();
  }
}

test('线性链与分叉树的切片结果与同步路径逐行一致', () => {
  const sessions = [['S'], ['S', 'A'], ['S', 'B'], ['S', 'A', 'C'], ['S', 'B', 'D']]
    .map(texts => ({ texts }));
  const { slice, sync } = chainOnBothPaths(sessions);
  expect(slice).toEqual(sync);
  // 关系本身也逐个写清楚：整组都等价但两边一起错了的情况要能被看到。
  expect(slice).toEqual([
    { req_id: 1, prev_req_id: null, prev_relation: 'first', delta_ordinals: '[0]', chain_role: 'main' },
    { req_id: 2, prev_req_id: 1, prev_relation: 'confirmed', delta_ordinals: '[1]', chain_role: 'main' },
    { req_id: 3, prev_req_id: 1, prev_relation: 'confirmed', delta_ordinals: '[1]', chain_role: 'main' },
    { req_id: 4, prev_req_id: 2, prev_relation: 'confirmed', delta_ordinals: '[2]', chain_role: 'main' },
    { req_id: 5, prev_req_id: 3, prev_relation: 'confirmed', delta_ordinals: '[2]', chain_role: 'main' },
  ]);
});

test('同毫秒且来源位置不足为证时两边都判顺序未证实', () => {
  const sessions: ChainSeed[] = [
    { texts: ['S'], startedMs: 1000 },
    { texts: ['S', 'A'], startedMs: 2000 },
    { texts: ['S', 'B'], startedMs: 2000 },
    { texts: ['S', 'B', 'C'], startedMs: 3000 },
  ];
  const { slice, sync } = chainOnBothPaths(sessions);
  expect(slice).toEqual(sync);
  // 2 与 3 同毫秒且排序键是 `ledger|000N`（解析不出账本偏移），整桶顺序未证实：
  // 可以遍历，但谁都只能算"没法比"，也不作为后面那一笔的祖先候选。
  expect(slice.map(row => [row.req_id, row.prev_relation]))
    .toEqual([[1, 'first'], [2, 'unknown'], [3, 'unknown'], [4, 'confirmed']]);
  expect(slice[3]).toMatchObject({ prev_req_id: 1, delta_ordinals: '[1,2]' });
});

test('不可读祖先让后续关系降为unknown并保留旧标题', () => {
  const sessions = [['S'], ['S', 'A'], ['S', 'A', 'B']].map(texts => ({ texts }));
  const { slice, sync } = chainOnBothPaths(sessions, f => {
    f.store.write(db => db.run(`UPDATE request SET body_state='missing',
      title='kept title',title_source='user_delta' WHERE req_id=2`));
  });
  expect(slice).toEqual(sync);
  expect(slice.map(row => [row.req_id, row.prev_relation]))
    .toEqual([[1, 'first'], [2, 'unknown'], [3, 'confirmed']]);
  expect(slice[2]).toMatchObject({ prev_req_id: 1, delta_ordinals: '[1,2]' });
});

test('两个互不相接的根按遍历序选主链', () => {
  const sessions: ChainSeed[] = [
    { texts: ['S', 'X'], startedMs: 1000 },
    { texts: ['Y', 'Z'], startedMs: 2000 },
  ];
  const { slice, sync } = chainOnBothPaths(sessions);
  expect(slice).toEqual(sync);
  expect(slice).toEqual([
    { req_id: 1, prev_req_id: null, prev_relation: 'first', delta_ordinals: '[0,1]', chain_role: 'main' },
    { req_id: 2, prev_req_id: null, prev_relation: 'branch', delta_ordinals: null, chain_role: 'branch' },
  ]);
});

test('排除用途不写chain_work，也不进角色森林', () => {
  const sliced = fixture();
  const synced = fixture();
  try {
    const sessions: ChainSeed[] = [
      { texts: ['S'], purposeChain: 'participate' },
      { texts: ['S', 'A'], purposeChain: 'exclude' },
      { texts: ['S', 'A', 'B'], purposeChain: 'participate' },
    ];
    seedChain(sliced.store, sessions);
    seedChain(synced.store, sessions);
    switchToSliceAlgorithm(sliced);
    const generation = beginGeneration(sliced.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    runStage(sliced, generation, sliceRequestsStage);
    runStage(sliced, generation, sliceRolesStage);
    expect(sliceChainRows(sliced, generation)).toEqual(syncChainRows(synced));
    expect(sliceChainRows(sliced, generation).map(row =>
      [row.req_id, row.prev_relation, row.chain_role]))
      .toEqual([[1, 'first', 'main'], [2, 'aux', 'aux'], [3, 'confirmed', 'main']]);
    // 排除用途既不进祖先台账，也不占角色扫描的行。
    expect(sliced.store.read.query('SELECT COUNT(*) AS n FROM derive_chain_work WHERE generation=? AND req_id=2')
      .get(generation)).toEqual({ n: 0 });
    expect(sliced.store.read.query('SELECT COUNT(*) AS n FROM derive_chain_work WHERE generation=?')
      .get(generation)).toEqual({ n: 2 });
  } finally {
    sliced.close();
    synced.close();
  }
});

test('用途在物化之后被重判时丢弃整代', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['S'], ['S', 'A']].map(texts => ({ texts })));
    switchToSliceAlgorithm(f);
    const generation = beginGeneration(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1, maxWritesPerBatch: 1 };
    const requests = runStage(f, generation, sliceRequestsStage, budget);
    expect(requests.stage).toBe('roles');
    // 用途重判到同一结论但换了修订：组修订没动，组级校验拦不住，逐请求校验要拦。
    f.store.write(db => db.run('UPDATE request SET purpose_revision=purpose_revision+1 WHERE req_id=1'));
    const roles = sliceRolesStage(f.store, generation, budget, 21);
    expect(roles.status).toBe('discarded');
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_chain_work WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
  } finally { f.close(); }
});

/**
 * 直接种工作行来隔离工具阶段：请求事实、关系与候选都已就绪，只差配对。
 *
 * `traversal_ord` 与 `request_index` 都取请求序号，`confirmed` 由用例给，
 * 与角色阶段结算后写回 work 行的形态一致。
 */
function seedToolWork(f: ReturnType<typeof fixture>, generation: string): void {
  f.store.write(db => {
    for (let id = 1; id <= 6; id += 1) {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,input_epoch,input_revision,
        purpose_revision,purpose_version,req_kind)
        VALUES (?,'c','a','known',?,'2026-10-22','hook','available',0,1,1,1,'e1',1,11,1,'chat')`,
      [id, 100 + id]);
      db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,
        input_revision,started_ms,traversal_ord,purpose_revision,purpose_version,
        chain_role,algorithm,retention_state,basis_json)
        VALUES (?,?,'e1',1,?,?,11,1,'main',5,'recomputed','{}')`,
      [generation, id, 100 + id, id - 1]);
    }
    const calls: [number, number, string][] = [
      [1, 0, 'call-resolved'], [3, 0, 'call-dup'], [4, 0, 'call-dup'], [6, 0, 'call-early'],
    ];
    for (const [reqId, ord, callId] of calls) {
      db.run(`INSERT INTO derive_call_work(generation,req_id,ord,call_id,tool_name,
        request_index,traversal_ord) VALUES (?,?,?,?,'read',?,?)`,
      [generation, reqId, ord, callId, reqId - 1, reqId - 1]);
    }
    const results: [number, number, string, number][] = [
      [2, 0, 'call-resolved', 1], [5, 0, 'call-dup', 1], [5, 1, 'call-early', 1],
    ];
    for (const [reqId, ord, callId, confirmed] of results) {
      db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,preview,
        request_index,traversal_ord,confirmed) VALUES (?,?,?,?,?,?,?,?,?)`,
      [generation, reqId, ord, String(ord), callId, `${callId} result`,
        reqId - 1, reqId - 1, confirmed]);
    }
    // 上游阶段留下的计数与游标：请求数已定，工具数与游标从头开始。
    db.run(`UPDATE derive_generation SET stage='tools',request_count=6,tool_count=0,
      tool_cursor_ord=-1 WHERE generation=?`, [generation]);
  });
}

test('工具切片与同步配对规则一致且逐页提交', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,
      group_epoch,input_revision,published_revision,target_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',1,0,?, 'dirty',1)`, [DERIVE_ALGORITHM]));
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    seedToolWork(f, generation);
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1, maxWritesPerBatch: 2 };
    const step = runStage(f, generation, sliceToolsStage, budget);
    expect(step.stage).toBe('summary');
    const rows = f.store.read.query<{ call_id: string; state: string;
      result_req: number | null; result_ord: number | null }, [string]>(
    `SELECT call_id,state,result_req,result_ord FROM derive_tool_result
      WHERE generation=? ORDER BY req_id,ord`).all(generation);
    expect(rows).toEqual([
      { call_id: 'call-resolved', state: 'resolved', result_req: 2, result_ord: 0 },
      { call_id: 'call-dup', state: 'ambiguous', result_req: 5, result_ord: 0 },
      { call_id: 'call-dup', state: 'ambiguous', result_req: 5, result_ord: 0 },
      // 结果在调用之前：不看字典序，保持 pending 且不记位置。
      { call_id: 'call-early', state: 'pending', result_req: null, result_ord: null },
    ]);
    expect(f.store.read.query<{ tool_count: number }, [string]>(
      'SELECT tool_count FROM derive_generation WHERE generation=?').get(generation))
      .toEqual({ tool_count: 4 });
    // 切片结果只写这一代：旧表保持空白，读口径的切换由发布指针完成。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM tool_call').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test('重复回传的结果不把已确认的配对降级', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,
      group_epoch,input_revision,published_revision,target_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',1,0,?, 'dirty',1)`, [DERIVE_ALGORITHM]));
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    seedToolWork(f, generation);
    // 同一调用在更晚的请求里被重发，且那一笔的增量关系未知（confirmed=0）。
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,input_epoch,input_revision,
        purpose_revision,purpose_version,req_kind)
        VALUES (7,'c','a','known',107,'2026-10-22','hook','available',0,1,1,1,'e1',1,11,1,'chat')`);
      db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,input_revision,
        started_ms,traversal_ord,prev_relation,purpose_revision,purpose_version,chain_role,
        algorithm,retention_state,basis_json)
        VALUES (?,7,'e1',1,107,6,'unknown',11,1,'main',5,'recomputed','{}')`, [generation]);
      db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,preview,
        request_index,traversal_ord,confirmed)
        VALUES (?,7,0,'0','call-resolved','resent',6,6,0)`, [generation]);
    });
    runStage(f, generation, sliceToolsStage, DEFAULT_DERIVE_BUDGET);
    expect(f.store.read.query<{ state: string; result_req: number }, [string]>(
    `SELECT state,result_req FROM derive_tool_result
      WHERE generation=? AND call_id='call-resolved'`).get(generation))
      .toEqual({ state: 'resolved', result_req: 2 });
  } finally { f.close(); }
});

test('确定增量的工具结果被配成resolved', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [
      { req_id: 1, started_ms: 100, sort_source: 'ledger', sort_key: 'ledger|0000' },
      { req_id: 2, started_ms: 200, sort_source: 'ledger', sort_key: 'ledger|0001' },
    ]);
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }] },
      reply: { content: [{ type: 'tool_use', id: 'call-1', name: 'read' }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file body' }] },
      ] },
      reply: { content: [{ type: 'text', text: 'done' }] },
      redact_version: 1,
    });
    switchToSliceAlgorithm(f);
    const generation = beginGeneration(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    runStage(f, generation, sliceRequestsStage);
    runStage(f, generation, sliceRolesStage);
    const step = runStage(f, generation, sliceToolsStage);
    expect(step.stage).toBe('summary');
    // 结果落在确定增量的 ord（第 3 条消息）上，调用在前一笔：唯一配对，标 resolved。
    expect(f.store.read.query<{ call_id: string; state: string; result_req: number;
      result_ord: number }, [string]>(`SELECT call_id,state,result_req,result_ord
      FROM derive_tool_result WHERE generation=?`).get(generation))
      .toEqual({ call_id: 'call-1', state: 'resolved', result_req: 2, result_ord: 2 });
    expect(f.store.read.query<{ confirmed: number }, [string]>(`SELECT confirmed
      FROM derive_result_work WHERE generation=? AND req_id=2`).get(generation))
      .toEqual({ confirmed: 1 });
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// 完成、发布、磁盘预算与失效回收（Task 18）。
// ---------------------------------------------------------------------------

const PRESENTATION_COLUMNS =
  'title,title_source,input_preview,input_preview_kind,reply_preview';

type PresentationRow = {
  req_id: number; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
  reply_preview: string | null;
};

function sliceRuntime(f: ReturnType<typeof fixture>,
  budget: typeof DEFAULT_DERIVE_BUDGET = DEFAULT_DERIVE_BUDGET): SliceRuntime {
  return { budget, dataDir: f.dir, dbPath: join(f.dir, 'trace.db') };
}

/** 一笔真实正文的工具往返，用途冻结：第 1 笔发起调用，第 2 笔的输入里回传结果。 */
function seedToolRoundTrip(f: ReturnType<typeof fixture>): void {
  seedRequest(f.store, [
    { req_id: 1, started_ms: 100, sort_source: 'ledger', sort_key: 'ledger|0000' },
    { req_id: 2, started_ms: 200, sort_source: 'ledger', sort_key: 'ledger|0001' },
  ]);
  persistBody(f.store, 1, {
    protocol: 'anthropic',
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: '读一下' }] }] },
    reply: { content: [{ type: 'tool_use', id: 'call-1', name: 'read' }] },
    redact_version: 1,
  });
  persistBody(f.store, 2, {
    protocol: 'anthropic',
    request: { messages: [
      { role: 'user', content: [{ type: 'text', text: '读一下' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file body' }] },
    ] },
    reply: { content: [{ type: 'text', text: 'done' }] },
    redact_version: 1,
  });
  // 正文写入会把请求重新标成待判定；这两笔的用途就是种下的这些。
  f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE conv_key=? AND actor=?',
    [SEED_GROUP.convKey, SEED_GROUP.actor]));
  enqueueDerive(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, '');
}

test('摘要阶段与同步路径给出同一套标题与摘录，随后发布', () => {
  const slice = fixture();
  const sync = fixture();
  try {
    seedToolRoundTrip(slice);
    seedToolRoundTrip(sync);
    // 对照就是同步入口在同一组输入上的结果，不手写期望值。
    sync.store.write(db => drainDeriveTx(db, { limit: 10 }));
    const oracle = sync.store.read.query<PresentationRow, [string, string]>(`
      SELECT req_id,${PRESENTATION_COLUMNS} FROM request
      WHERE conv_key=? AND actor=? ORDER BY req_id`).all(SEED_GROUP.convKey, SEED_GROUP.actor);

    switchToSliceAlgorithm(slice);
    const generation = beginGeneration(slice.store, SEED_GROUP.convKey, SEED_GROUP.actor, 10)!;
    runStage(slice, generation, sliceRequestsStage);
    runStage(slice, generation, sliceRolesStage);
    expect(runStage(slice, generation, sliceToolsStage).stage).toBe('summary');
    expect(runStage(slice, generation, sliceSummaryStage).stage).toBe('ready');
    const staged = slice.store.read.query<PresentationRow, [string]>(`
      SELECT req_id,${PRESENTATION_COLUMNS} FROM derive_request_result
      WHERE generation=? ORDER BY req_id`).all(generation);
    expect(staged).toEqual(oracle);
    // 工具往返那一笔的输入里没有用户文本：摘录照实说这一轮回传了什么工具结果，
    // 名字取自本代已确认的关联（按 ord 与 path 精确定位），不是内容兜底。
    expect(staged[1]).toMatchObject({ input_preview_kind: 'tool_result' });
    expect(staged[1]!.input_preview).toBe('工具结果 · read');

    expect(sliceReadyStage(slice.store, generation, DEFAULT_DERIVE_BUDGET, 20,
      join(slice.dir, 'trace.db')).status).toBe('published');
    expect(slice.store.read.query('SELECT * FROM derive_queue').get())
      .toMatchObject({ state: 'clean', published_generation: generation });
    // 构建期的祖先台账与扫描状态发布后不再留着。
    expect(slice.store.read.query('SELECT COUNT(*) AS n FROM derive_chain_work WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
    expect(slice.store.read.query('SELECT COUNT(*) AS n FROM derive_role_work WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
  } finally { slice.close(); sync.close(); }
});

test('排除用途的行不从用户增量取标题', () => {
  const run = (modelTitle: string | null) => {
    const f = fixture();
    try {
      f.store.write(db => {
        db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at,title,title_source,
          input_epoch,input_revision,purpose_revision,purpose_version,purpose_chain,req_kind,
          model_title,model_served)
          VALUES (1,'c','a','known',100,'2026-10-22','hook','available',0,1,1,1,
            '旁路旧标题','user_delta','e1',1,11,1,'exclude','chat',?,'模型X')`, [modelTitle]);
        db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
          published_revision,target_algorithm,state,dirty_since_ms)
          VALUES ('c','a','','g1',1,0,5,'dirty',1)`);
      });
      persistBody(f.store, 1, {
        protocol: 'anthropic',
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: '用户增量标题' }] }] },
        reply: { id: 'msg_1', content: [{ type: 'text', text: 'ok' }] },
        redact_version: 1,
      });
      const generation = beginGeneration(f.store, 'c', 'a', 10)!;
      f.store.write(db => {
        // 正常流程里 aux 行由匹配阶段给出 delta=null，走不到 delta 分支；
        // 这里直接写非空 delta，专门触发 delta 分支里的 aux 判据。
        db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,input_revision,
          started_ms,traversal_ord,purpose_revision,purpose_version,chain_role,delta_ordinals,
          algorithm,retention_state,basis_json)
          VALUES (?,1,'e1',1,100,0,11,1,'aux','[0]',5,'recomputed','{}')`, [generation]);
        db.run(`UPDATE derive_generation SET stage='summary',summary_cursor_ord=-1,
          request_count=1 WHERE generation=?`, [generation]);
      });
      const step = runStage(f, generation, sliceSummaryStage);
      expect(step.stage).toBe('ready');
      return f.store.read.query<PresentationRow & { title_source: string }, [string]>(`
        SELECT title,title_source,input_preview,input_preview_kind
        FROM derive_request_result WHERE generation=? AND req_id=1`).get(generation);
    } finally { f.close(); }
  };
  // model_title 为空：标题保持时间兜底，不写由用户增量推导的标题，也不沿用库里旧标题。
  const plain = run(null)!;
  expect(plain.title_source).toBe('model_time');
  expect(plain.title).not.toContain('用户增量标题');
  expect(plain.title).not.toBe('旁路旧标题');
  // 输入摘录仍走同一 delta 分支，不显示成标题请求。
  expect(plain.input_preview_kind).toBe('delta');
  expect(plain.input_preview).toContain('用户增量标题');
  // model_title 存在：保持模型标题来源，同样不取用户增量。
  const titled = run('模型标题')!;
  expect(titled).toMatchObject({ title: '模型标题', title_source: 'model_title' });
  expect(titled.title).not.toContain('用户增量标题');
});

test('组修订在阶段间变化时丢弃代际', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    // 代际停在角色阶段：这一步要看的是阶段开头的修订校验。
    f.store.write(db => db.run(`UPDATE derive_generation SET stage='roles' WHERE generation=?`,
      [generation]));
    f.store.write(db => db.run(`UPDATE derive_queue SET input_revision=8
      WHERE conv_key='c' AND actor='a'`));
    const step = sliceRolesStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20);
    expect(step.status).toBe('discarded');
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as any).published_generation)
      .toBeNull();
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'discarded' });
  } finally { f.close(); }
});

test('暂存超预算丢弃整代', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    seedResult(f, generation, 'budget title');
    f.store.write(db => db.run(`UPDATE derive_generation SET stage='ready',request_count=1,
      staged_bytes=? WHERE generation=?`,
    [DEFAULT_DERIVE_BUDGET.maxStagedBytes + 1, generation]));
    const step = sliceReadyStage(f.store, generation,
      { ...DEFAULT_DERIVE_BUDGET, maxStagedBytes: 1 }, 20, join(f.dir, 'trace.db'));
    expect(step.status).toBe('discarded');
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
  } finally { f.close(); }
});

test('覆盖不全的代际不发布', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    seedResult(f, generation, 'covered title');
    // 组里又多了一笔已知请求，而这一代里没有它：整代作废，指针不动。
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,input_epoch,input_revision,
        purpose_revision,purpose_version,req_kind)
        VALUES (2,'c','a','known',200,'2026-10-22','hook','available',0,1,1,1,'e1',7,11,3,'chat')`);
      db.run(`UPDATE derive_generation SET stage='ready',request_count=1 WHERE generation=?`,
        [generation]);
    });
    const step = sliceReadyStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20,
      join(f.dir, 'trace.db'));
    expect(step.status).toBe('discarded');
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as any).published_generation)
      .toBeNull();
  } finally { f.close(); }
});

test('发布回收超过上限的退役代，最近两代结果留着', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const published: string[] = [];
    for (let round = 0; round < 4; round++) {
      if (round > 0) {
        f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=?,
          dirty_since_ms=? WHERE conv_key='c' AND actor='a'`, [7 + round, 100 + round]));
      }
      const generation = beginGeneration(f.store, 'c', 'a', 1000 + round)!;
      seedResult(f, generation, `title ${round}`);
      f.store.write(db => db.run(`UPDATE derive_generation SET stage='ready',request_count=1
        WHERE generation=?`, [generation]));
      expect(sliceReadyStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 1000 + round,
        join(f.dir, 'trace.db')).status).toBe('published');
      published.push(generation);
    }
    // 上限是 2：最旧那一代连同结果行一起回收，指针仍指向最新一代。
    const kept = f.store.read.query<{ generation: string; state: string }, []>(
      'SELECT generation,state FROM derive_generation ORDER BY published_at').all();
    expect(kept.map(row => row.generation)).toEqual(published.slice(1));
    expect(kept.map(row => row.state)).toEqual(['retired', 'retired', 'published']);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(published[0])).toEqual({ n: 0 });
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as any).published_generation)
      .toBe(published[3]);
  } finally { f.close(); }
});

test('多个dirty组按last_claimed轮转', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      for (const [actor, key] of [['a', 'c1'], ['b', 'c2']] as const) {
        db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at,input_epoch,input_revision,
          purpose_revision,purpose_version,purpose_pending,req_kind)
          VALUES (?,?,?,'known',1,'2026-10-22','hook','pending',0,1,1,1,'e1',1,0,1,0,'chat')`,
        [actor === 'a' ? 1 : 2, key, actor]);
        db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
          published_revision,target_algorithm,state,dirty_since_ms)
          VALUES (?,?,'','g1',1,0,5,'dirty',1)`, [key, actor]);
      }
    });
    const runtime = sliceRuntime(f);
    expect(sliceGroupStep(f.store, runtime, 1000).status).not.toBe('idle');
    expect(sliceGroupStep(f.store, runtime, 1001).status).not.toBe('idle');
    expect(f.store.read.query(`SELECT DISTINCT actor FROM derive_queue
      WHERE last_claimed_ms IS NOT NULL ORDER BY actor`).all())
      .toEqual([{ actor: 'a' }, { actor: 'b' }]);
  } finally { f.close(); }
});

test('组里还有待判定用途时不认领，认领时把算法号归一到切片', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [
      { req_id: 1, started_ms: 100, sort_source: 'ledger', sort_key: 'ledger|0000' },
    ], { convKey: 'c', actor: 'a' });
    // 入队路径写下的目标算法号是同步的；用途还没结算。
    enqueueDerive(f.store, 'c', 'a', '');
    const runtime = sliceRuntime(f);
    expect(f.store.read.query<{ target_algorithm: number }, []>(
      'SELECT target_algorithm FROM derive_queue').get())
      .toEqual({ target_algorithm: GROUP_ALGORITHM });
    expect(sliceGroupStep(f.store, runtime, 1000).status).toBe('idle');
    expect(f.store.read.query<{ compute_generation: string | null }, []>(
      'SELECT compute_generation FROM derive_queue').get()).toEqual({ compute_generation: null });

    // 用途结算之后同一组就能认领，队列行的算法号在认领时归一到切片号。
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0'));
    expect(sliceGroupStep(f.store, runtime, 1001).status).toBe('advanced');
    expect(f.store.read.query<{ target_algorithm: number; compute_generation: string | null }, []>(
      'SELECT target_algorithm,compute_generation FROM derive_queue').get())
      .toMatchObject({ target_algorithm: DERIVE_ALGORITHM });
  } finally { f.close(); }
});

test('切片入口分批推进到发布，没有运行时的库走同步路径', () => {
  const f = fixture();
  try {
    seedToolRoundTrip(f);
    f.store.deriveRuntime = sliceRuntime(f, { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1,
      maxWritesPerBatch: 1, maxStageBatchMs: 1 });
    // 队列行由正文写入与入队路径造出，带的是同步算法号。
    expect(f.store.read.query<{ target_algorithm: number }, []>(
      'SELECT target_algorithm FROM derive_queue').get())
      .toEqual({ target_algorithm: GROUP_ALGORITHM });
    for (let index = 0; index < 200; index++) {
      const result = drainDeriveEntry(f.store, 1);
      expect(result).toMatchObject({ processed: 1, discarded: 0 });
      if (result.remaining === 0) break;
    }
    const queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue).toMatchObject({ state: 'clean', target_algorithm: DERIVE_ALGORITHM,
      published_algorithm: DERIVE_ALGORITHM });
    expect(queue.published_revision).toBe(queue.input_revision);
    const rows = f.store.read.query<{ req_id: number; prev_relation: string; chain_role: string;
      input_preview: string | null; input_preview_kind: string | null }, [string]>(`
      SELECT req_id,prev_relation,chain_role,input_preview,input_preview_kind
      FROM derive_request_result WHERE generation=? ORDER BY req_id`)
      .all(String(queue.published_generation));
    expect(rows[0]).toMatchObject({ req_id: 1, prev_relation: 'first', chain_role: 'main' });
    expect(rows[1]).toMatchObject({ req_id: 2, prev_relation: 'confirmed', chain_role: 'main',
      input_preview_kind: 'tool_result' });

    // 没有切片运行时的库：同一入口落到同步分支，结果照旧写回 request 行。
    f.store.deriveRuntime = undefined;
    enqueueDerive(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, '');
    // 同步入口的 `processed` 是请求数，切片入口是阶段步数；两边都恒为 0 的是丢弃数。
    expect(drainDeriveEntry(f.store, 10)).toMatchObject({
      processed: 2, remaining: 0, discarded: 0, purpose_remaining: 0, recomputed: 2,
    });
    expect(f.store.read.query<{ prev_relation: string }, [number]>(
      'SELECT prev_relation FROM request WHERE req_id=2').get(2))
      .toEqual({ prev_relation: 'confirmed' });
  } finally { f.close(); }
});
