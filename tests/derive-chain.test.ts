import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, seedPurposeRequest, seedTextChain, seedDeriveRound, deriveSnapshot, rebuildDeriveGroup, DERIVE_GROUP, DERIVE_ACTOR } from './fixtures';
import { confirmedDeltaOf, matchPredecessor } from '../src/derive/decision';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { incrementalInputOf } from '../src/derive/read';
import { messageFingerprint } from '../src/fingerprint';
import { listSessions } from '../src/queries/sessions';
import { openStore } from '../src/store';
import { persistBody } from '../src/body';
import type { BodyInput } from '../src/body';

// 链关系与增量：前驱匹配、遍历序与确定增量的行为。
test('重复消息仍按位置计新增', () => {
  // 集合差会吞掉真正新增的那条；序列比较按位置计增量，判据在 matchPredecessor。
  expect(matchPredecessor([], ['u:hello', 'u:hello'], false))
    .toEqual({ parent: null, relation: 'first', delta: [0, 1], near: null });
});

test('确定增量判据五分支：首笔全确认，confirmed 只看增量，其余不确认', () => {
  expect(confirmedDeltaOf('first', [0, 1])).toEqual({ all: true, ords: [] });
  // first 没有增量记录也仍是整笔新增：它本来就不需要增量来证明。
  expect(confirmedDeltaOf('first', null)).toEqual({ all: true, ords: [] });
  expect(confirmedDeltaOf('confirmed', [2, 3])).toEqual({ all: false, ords: [2, 3] });
  // 关系说 confirmed 但没有增量记录时不能替它补一个空增量当全部确认。
  expect(confirmedDeltaOf('confirmed', null)).toEqual({ all: false, ords: [] });
  expect(confirmedDeltaOf('unknown', [1])).toEqual({ all: false, ords: [] });
  expect(confirmedDeltaOf('branch', [1])).toEqual({ all: false, ords: [] });
  expect(confirmedDeltaOf('aux', [1])).toEqual({ all: false, ords: [] });
  expect(confirmedDeltaOf(null, null)).toEqual({ all: false, ords: [] });
});

test('前驱在链上任意祖先里找，不只看上一笔', () => {
  // 分支：1 是根，2 续自 1。
  const ancestors = [
    { reqId: 1, fingerprints: ['u:hello'] },
    { reqId: 2, fingerprints: ['u:hello', 'a:answer', 'u:more'] },
  ];
  // 本笔完整包含 req 2：真前驱是 2，不是紧挨着它的 1。
  expect(matchPredecessor(ancestors, ['u:hello', 'a:answer', 'u:more', 'a:next']))
    .toEqual({
      parent: 2, relation: 'confirmed', delta: [3],
      near: { reqId: 2, shared: 3 },
    });
  // 本笔从根重新分支：1 整条仍是前缀，所以前驱是 1 而不是"无前驱"。
  expect(matchPredecessor(ancestors, ['u:hello', 'u:other']))
    .toEqual({
      parent: 1, relation: 'confirmed', delta: [1],
      near: { reqId: 1, shared: 1 },
    });
  // 换了开头就对不上任何祖先：另起一支，但仍记下最接近的那一支。
  const branch = matchPredecessor(ancestors, ['u:different', 'u:other']);
  expect(branch.parent).toBeNull();
  expect(branch.relation).toBe('branch');
  expect(branch.delta).toBeNull();
  expect(branch.near).toBeNull();
});

test('缓存断点移动不打断增量', () => {
  // 同一段历史消息，只因 cache_control 位置不同而字节不同，指纹必须相同。
  const withBreakpoint = { role: 'user', content: [{ type: 'text', text: '同一条消息', cache_control: { type: 'ephemeral' } }] };
  const without = { role: 'user', content: [{ type: 'text', text: '同一条消息' }] };
  expect(messageFingerprint(withBreakpoint)).toBe(messageFingerprint(without));
  // 角色参与指纹：同样的文本换了角色就不能算同一条。
  expect(messageFingerprint({ role: 'assistant', content: '同一条消息' }))
    .not.toBe(messageFingerprint({ role: 'user', content: '同一条消息' }));
  // 数组与裸字符串两种写法压成同一种。
  expect(messageFingerprint({ role: 'user', content: [{ type: 'text', text: 'x' }] }))
    .toBe(messageFingerprint({ role: 'user', content: 'x' }));
});

for (const state of ['partial', 'available'] as const) {
  for (const edge of ['0000', 'zzzz'] as const) {
    test(`${state}无骨架${edge}不充当祖先或主链根`, () => {
      const f = fixture();
      try {
        seedTextChain(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
        f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,
          actor_state,started_ms,day,via,body_state,derive_version,have,created_at,
          updated_at,sort_source,sort_key) VALUES (99,?,'actor-a','known',
          999,'2026-10-22','hook',?,0,1,1,1,'ledger',?)`,
          [JSON.stringify(['session', 'chain']), state, `ledger|${edge}`]));
        enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
        drainDerive(f.store);
        expect(f.store.read.query(`SELECT prev_relation,prev_req_id FROM request
          WHERE req_id=99`).get()).toEqual({ prev_relation: 'unknown', prev_req_id: null });
        // 99 排最前且不可比：1 连「本组第一笔」都证明不了（relation 同样 unknown），
        // 2、3 的 confirmed 链经过它。整组归属无法证明，角色如实落 unknown。
        expect(f.store.read.query(`SELECT req_id,chain_role FROM request
          WHERE req_id IN (1,2,3) ORDER BY req_id`).all()).toEqual([
          { req_id: 1, chain_role: 'unknown' }, { req_id: 2, chain_role: 'unknown' },
          { req_id: 3, chain_role: 'unknown' },
        ]);
        expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=3`).get())
          .toEqual({ prev_req_id: 2 });
      } finally { f.close(); }
    });
  }
}

test('增量输入不判成 confirmed，也不充当后续请求的祖先', () => {
  const f = fixture();
  try {
    // 四笔 Responses 请求：1 是完整历史 [A]，2 续上 [A, B]，3 只带增量 [C] 并用
    // previous_response_id 指向 2，4 又是完整历史 [A, B, C, D]。
    const ids = [1, 2, 3, 4];
    f.store.write(db => {
      for (const [index, id] of ids.entries()) {
        db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
          day,via,body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
          VALUES (?,?,'session','actor-a','known',?,'2026-10-22','hook','pending',0,1,1,1,
          'ledger',?)`,
        [id, JSON.stringify(['session', 'chain']), 1000 + index,
          `ledger|${String(index).padStart(4, '0')}`]);
      }
    });
    const body = (texts: string[], extra: Record<string, unknown> = {}) => ({
      protocol: 'responses',
      request: {
        input: texts.map(text => ({
          type: 'message', role: 'user', content: [{ type: 'input_text', text }],
        })),
        ...extra,
      },
      reply: { id: `resp_${texts.join('')}`, status: 'completed', output: [] },
      redact_version: 1,
    });
    persistBody(f.store, 1, body(['A']));
    persistBody(f.store, 2, body(['A', 'B']));
    persistBody(f.store, 3, body(['C'], { previous_response_id: 'resp_2' }));
    persistBody(f.store, 4, body(['A', 'B', 'C', 'D']));
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{ req_id: number; prev_req_id: number | null;
      prev_relation: string; chain_role: string }, []>(
      `SELECT req_id,prev_req_id,prev_relation,chain_role FROM request
       WHERE req_id IN (1,2,3,4) ORDER BY req_id`).all();
    // 2 的完整历史包含 1，照常确认；3 的输入不是完整历史，关系只能是未知；
    // 4 整笔历史仍包含 2，确认关系不因中间那笔增量而失效。
    expect(rows.map(row => [row.req_id, row.prev_req_id, row.prev_relation])).toEqual([
      [1, null, 'first'],
      [2, 1, 'confirmed'],
      [3, null, 'unknown'],
      [4, 2, 'confirmed'],
    ]);
    // 3 是关系 unknown 的节点，角色显式落 unknown；4 的前缀证据接回已证明主链，
    // 重新锚定记 main。
    expect(rows.map(row => row.chain_role)).toEqual(['main', 'main', 'unknown', 'main']);
  } finally {
    f.close();
  }
});

test('增量输入只凭骨架判定，不读消息块', () => {
  const f = fixture();
  try {
    const incremental = seedPurposeRequest(f.store, {
      convKey: 'conv-incremental', protocol: 'responses',
      request: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A' }] }],
        previous_response_id: 'resp_0',
      },
    });
    expect(incrementalInputOf(f.store.read, incremental)).toBe(true);
    const full = seedPurposeRequest(f.store, {
      convKey: 'conv-incremental', protocol: 'responses',
      request: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'B' }] }] },
    });
    expect(incrementalInputOf(f.store.read, full)).toBe(false);
    // 正文不可读（回收）与行不存在都不是增量：没有可读骨架就不下这个结论。
    expect(incrementalInputOf(f.store.read, 9999)).toBe(false);
  } finally {
    f.close();
  }
});

test('合法空messages可读但不证明后续请求的父节点', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [[], ['A']]);
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT prev_relation,delta_ordinals FROM request
      WHERE req_id=1`).get()).toEqual({ prev_relation: 'first', delta_ordinals: '[]' });
    expect(f.store.read.query(`SELECT prev_req_id,prev_relation FROM request
      WHERE req_id=2`).get()).toEqual({ prev_req_id: null, prev_relation: 'branch' });
    expect(matchPredecessor([{ reqId: 1, fingerprints: [] }], ['A']))
      .toEqual({ parent: null, relation: 'branch', delta: null, near: null });
  } finally {
    f.close();
  }
});

test('有骨架但无messages不参与消息前驱比较', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['A'], ['A', 'B']]);
    persistBody(f.store, 1, { protocol: 'anthropic', request: { system: 'synthetic' },
      reply: { content: [] }, redact_version: 1 });
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT prev_relation FROM request WHERE req_id=1`).get())
      .toEqual({ prev_relation: 'unknown' });
    expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=2`).get())
      .toEqual({ prev_req_id: null });
  } finally {
    f.close();
  }
});

test('缺消息引用不能缩成合法空序列', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['A'], ['A', 'B']]);
    f.store.write(db => db.run('DELETE FROM request_block WHERE req_id=1'));
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT prev_relation FROM request WHERE req_id=1`).get())
      .toEqual({ prev_relation: 'unknown' });
    expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=2`).get())
      .toEqual({ prev_req_id: null });
  } finally {
    f.close();
  }
});

test('同毫秒交换摄入ID仍得到相同链角色和工具关系', () => {
  const a = fixture(); const b = fixture();
  try {
    seedDeriveRound(a.store, [1, 2]); seedDeriveRound(b.store, [2, 1]);
    rebuildDeriveGroup(a.store);
    rebuildDeriveGroup(b.store);
    expect(deriveSnapshot(a.store, [1, 2])).toEqual(deriveSnapshot(b.store, [2, 1]));
    expect(deriveSnapshot(b.store, [2, 1]).tools[0]).toMatchObject({
      state: 'resolved', result_req: 'second',
    });
  } finally { a.close(); b.close(); }
});

test('时间优先于跨代际物理键字典序', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2], [1000, 2000]);
    f.store.write(db => db.run(`UPDATE request SET sort_key=CASE req_id
      WHEN 1 THEN '9:8:7:0|00000000000000000000'
      ELSE '1:2:3:0|00000000000000000100' END`));
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).requests[1]?.prev_req_id).toBe('first');
    expect(deriveSnapshot(f.store, [1, 2]).tools[0]?.state).toBe('resolved');
  } finally { f.close(); }
});

test('同代际重复偏移不能由ID创造确定关系', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    f.store.write(db => db.run(`UPDATE request
      SET sort_key='1:2:3:0|00000000000000000000'`));
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).requests.map(r => r.prev_relation))
      .toEqual(['unknown', 'unknown']);
    expect(deriveSnapshot(f.store, [1, 2]).tools[0]?.state).toBe('pending');
  } finally { f.close(); }
});

test('缺键同时间桶保守且来源后补可重算', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    f.store.write(db => db.run('UPDATE request SET sort_source=NULL,sort_key=NULL'));
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).tools[0]?.state).toBe('pending');
    f.store.write(db => {
      for (const id of [1, 2]) db.run(`UPDATE request
        SET sort_source='ledger',sort_key=? WHERE req_id=?`,
        [`1:2:3:0|${String((id - 1) * 100).padStart(20, '0')}`, id]);
    });
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).tools[0]?.state).toBe('resolved');
  } finally { f.close(); }
});

const unsupportedOrders = [
  [['ledger', '1:2:3:0|00000000000000000000'], ['ledger', '9:8:7:0|00000000000000000100']],
  [['ledger', '1:2:3:0|00000000000000000000'], ['route', '00000000000000000002']],
  [['hook', '00000000-0000-4000-8000-000000000001'], ['hook', 'ffffffff-ffff-4fff-8fff-ffffffffffff']],
] as const;

for (const [index, sources] of unsupportedOrders.entries()) {
  test(`无同源位置证据${index}交换ID也不生成确定关系`, () => {
    const a = fixture(); const b = fixture();
    try {
      for (const [f, ids] of [[a, [1, 2]], [b, [2, 1]]] as const) {
        seedDeriveRound(f.store, ids);
        f.store.write(db => {
          for (const [i, id] of ids.entries()) db.run(`UPDATE request
            SET sort_source=?,sort_key=? WHERE req_id=?`, [...sources[i]!, id]);
        });
        rebuildDeriveGroup(f.store);
        expect(deriveSnapshot(f.store, ids).requests.map(row => row.prev_relation))
          .toEqual(['unknown', 'unknown']);
        expect(deriveSnapshot(f.store, ids).tools[0]?.state).toBe('pending');
      }
      expect(deriveSnapshot(a.store, [1, 2])).toEqual(deriveSnapshot(b.store, [2, 1]));
    } finally { a.close(); b.close(); }
  });
}

test('稳定排序重算得到确定增量与标题', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['a'], ['a', 'b'], ['a', 'b', 'c']]);
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    const result = drainDerive(f.store);
    expect(result.processed).toBe(3);
    const rows = f.store.read.query<{ req_id: number; prev_relation: string; delta_ordinals: string | null; title: string }, []>(
      'SELECT req_id, prev_relation, delta_ordinals, title FROM request ORDER BY req_id').all();
    expect(rows.map(row => row.prev_relation)).toEqual(['first', 'confirmed', 'confirmed']);
    expect(rows.map(row => row.delta_ordinals)).toEqual(['[0]', '[1]', '[2]']);
    expect(rows.map(row => row.title)).toEqual(['a', 'b', 'c']);
  } finally {
    f.close();
  }
});

test('到达顺序不影响派生结果', () => {
  const chain = [['a'], ['a', 'b'], ['a', 'b', 'c']];
  const collect = (order: number[]): string[] => {
    const f = fixture();
    try {
      // 先建好全部行，再按给定顺序逐笔补正文，模拟迟到正文。
      seedRows(f.store, chain.length);
      for (const position of order) {
        persistBody(f.store, position + 1, bodyFor(chain[position]!));
      }
      enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
      drainDerive(f.store);
      const rows = f.store.read.query<{ req_id: number; prev_relation: string; delta_ordinals: string | null; title: string }, []>(
        'SELECT req_id, prev_relation, delta_ordinals, title FROM request ORDER BY req_id').all();
      return rows.map(row => `${row.prev_relation}:${row.delta_ordinals}:${row.title}`);
    } finally {
      f.close();
    }
  };
  const forward = collect([0, 1, 2]);
  const reversed = collect([2, 1, 0]);
  const shuffled = collect([1, 2, 0]);
  expect(reversed).toEqual(forward);
  expect(shuffled).toEqual(forward);
  expect(forward).toEqual([
    'first:[0]:a',
    'confirmed:[1]:b',
    'confirmed:[2]:c',
  ]);
});

test('完整组重建关闭重开后保持增量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-chain-'));
  const store = openStore(join(dir, 'trace.db'));
  try {
    const chain = Array.from({ length: 250 }, (_, index) =>
      Array.from({ length: index + 1 }, (_, position) => `m${position}`));
    seedRows(store, chain.length);
    for (let index = 0; index < chain.length; index++) persistBody(store, index + 1, bodyFor(chain[index]!));
    enqueueDerive(store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    const done = drainDerive(store);
    expect(done.processed).toBe(250);
    const versions = store.read.query<{ derive_version: number }, []>(
      'SELECT DISTINCT derive_version FROM request').all();
    expect(versions.length).toBe(1);
    const lastBefore = store.read.query<{ delta_ordinals: string }, [number]>(
      'SELECT delta_ordinals FROM request WHERE req_id=?').get(250);
    store.close();

    // 重开后再排一次，应当得到同样的结果（版本号再涨一，但增量不变）。
    const reopened = openStore(join(dir, 'trace.db'));
    try {
      enqueueDerive(reopened, JSON.stringify(['session', 'chain']), 'actor-a', '');
      drainDerive(reopened);
      const lastAfter = reopened.read.query<{ delta_ordinals: string }, [number]>(
        'SELECT delta_ordinals FROM request WHERE req_id=?').get(250);
      expect(lastAfter?.delta_ordinals).toBe(lastBefore?.delta_ordinals);
      expect(reopened.read.query("SELECT count(*) AS n FROM derive_queue WHERE state<>'clean'").get())
        .toEqual({ n: 0 });
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* closed above */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('前驱正文缺失时本轮记为unknown且不算增量', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['a'], ['a', 'b']]);
    // 抹掉第一笔的正文：第二笔无法确认前驱
    f.store.write(db => db.run("UPDATE request SET body_state='pending', skeleton_z=NULL WHERE req_id=1"));
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{
      req_id: number; prev_relation: string; delta_ordinals: string | null; chain_role: string;
    }, []>('SELECT req_id, prev_relation, delta_ordinals, chain_role FROM request ORDER BY req_id').all();
    expect(rows).toEqual([
      { req_id: 1, prev_relation: 'unknown', delta_ordinals: null, chain_role: 'unknown' },
      { req_id: 2, prev_relation: 'unknown', delta_ordinals: null, chain_role: 'unknown' },
    ]);
  } finally {
    f.close();
  }
});

test('标题生成请求不占主链，时间最早的链才是主链', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'title-and-branch']);
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (?,?,'session','actor-a','known',?,'2026-10-20','hook','pending',0,1,1,1,'seed','model_time','ledger',?)`,
      );
      insert.run(1, key, 1000, 'ledger|0001');
      insert.run(2, key, 2000, 'ledger|0002');
      insert.run(3, key, 3000, 'ledger|0003');
      insert.run(4, key, 4000, 'ledger|0004');
      insert.run(5, key, 5000, 'ledger|0005');
      insert.run(6, key, 6000, 'ledger|0006');
    });
    const message = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
    // 1 是 Title Generator：单块 <session>，回复是正式标题。
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [message('<session>当前项目显示 title 有问题</session>')] },
      reply: { id: 'msg_title', content: [{ type: 'text', text: '{"title":"trace 面板 UI 改版"}' }] },
      redact_version: 1,
    });
    // 2 是真正的主对话起点；3 续写 2；4 是另一条不相接的链，5/6 继续 4。
    // 即使 4 的后继更多，主链仍然是时间最早的 2。
    persistBody(f.store, 2, bodyFor(['系统指令', '工具调用']));
    persistBody(f.store, 3, bodyFor(['系统指令', '工具调用', '继续']));
    persistBody(f.store, 4, bodyFor(['另一份 CLAUDE.md', '另一条历史']));
    persistBody(f.store, 5, bodyFor(['另一份 CLAUDE.md', '另一条历史', '分支继续']));
    persistBody(f.store, 6, bodyFor(['另一份 CLAUDE.md', '另一条历史', '分支继续', '再继续']));
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{
      req_id: number; prev_relation: string; req_kind: string; chain_role: string; title: string;
    }, []>('SELECT req_id, prev_relation, req_kind, chain_role, title FROM request ORDER BY req_id').all();
    expect(rows.map(row => [row.req_id, row.prev_relation, row.req_kind, row.chain_role])).toEqual([
      [1, 'aux', 'title', 'aux'],
      [2, 'first', 'chat', 'main'],
      [3, 'confirmed', 'chat', 'main'],
      [4, 'branch', 'chat', 'branch'],
      [5, 'confirmed', 'chat', 'branch'],
      [6, 'confirmed', 'chat', 'branch'],
    ]);
    // Title Generator 的正式标题优先于用户首句，作为会话标题。
    expect(listSessions(f.store, 10, null).items[0]?.title).toBe('trace 面板 UI 改版');
  } finally {
    f.close();
  }
});

function bodyFor(texts: string[]): BodyInput {
  return {
    protocol: 'anthropic',
    request: { messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })) },
    reply: { id: 'msg_chain', content: [{ type: 'text', text: 'ok' }] },
    redact_version: 1,
  };
}

/** 只建请求行，不写正文；用于模拟"行先到、正文后到"。 */
function seedRows(store: ReturnType<typeof fixture>['store'], count: number): void {
  store.write(db => {
    for (let index = 0; index < count; index++) {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (?,?,?,'actor-a','known',?,'2026-10-20','hook','pending',0,1,1,1,'seed','model_time','ledger',?)`,
        [
          index + 1, JSON.stringify(['session', 'chain']), 'session',
          1000 + index, `ledger|${String(index).padStart(4, '0')}`,
        ],
      );
    }
  });
}

