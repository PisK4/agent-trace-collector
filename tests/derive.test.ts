import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, seedPurposeRequest } from './fixtures';
import { openStore } from '../src/store';
import { runMaintenance } from '../src/maintenance';
import type { Store } from '../src/store';
import { compareSequence, deriveTitle, drainDerive, drainDeriveTx, enqueueDerive,
  matchPredecessor } from '../src/derive';
import { PURPOSE_VERSION } from '../src/semantics';
import { GROUP_ALGORITHM } from '../src/derive-state';
import { listSessions } from '../src/queries';
import { modelTimeTitle } from '../src/sources/magpie';
import { messageFingerprint } from '../src/fingerprint';
import { persistBody } from '../src/body';
import type { BodyInput } from '../src/body';

test('重复消息仍按位置计新增', () => {
  expect(compareSequence(['a', 'b'], ['a', 'b', 'a'], true)).toEqual({ relation: 'confirmed', delta: [2] });
  expect(compareSequence(['a', 'b'], ['b', 'a'], true)).toEqual({ relation: 'unknown', delta: null });
  expect(compareSequence(null, ['a', 'b'], true)).toEqual({ relation: 'unknown', delta: null });
  expect(compareSequence(null, ['a', 'b'], false)).toEqual({ relation: 'first', delta: [0, 1] });
  expect(compareSequence(['a'], ['a'], true)).toEqual({ relation: 'confirmed', delta: [] });
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

test('标题取首个新增用户文本并去掉 harness 包装', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>\n修复登录错误' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'not a title' }] },
  ];
  const derived = deriveTitle(messages, [0, 1], 'model · 10:00');
  expect(derived).toEqual({ title: '修复登录错误', source: 'user_delta' });
});

test('会话外壳、技能注入与 harness 提示都不当标题', () => {
  const fallback = 'model · 10:00';
  const cases = [
    ['<session>\n评估压缩机制文档\n/de-AI-writing\n</session>', '评估压缩机制文档'],
    ['Base directory for this skill: /Users/pis/.claude/skills/x\n\n# 技能正文', fallback],
    ['The user stepped away and is coming back. Recap in under 40 words.', fallback],
    ['<command-name>/auto-mode-setup</command-name>\n<command-args></command-args>\n\n改', '改'],
    ['<transcript>\n{"user":"历史"}\n</transcript>', fallback],
  ];
  for (const [text, expected] of cases) {
    const derived = deriveTitle([{ role: 'user', content: [{ type: 'text', text }] }], [0], fallback);
    expect(derived.title).toBe(expected);
  }
});

test('没有用户增量时回落到模型时间', () => {
  expect(deriveTitle([{ role: 'assistant', content: 'only assistant' }], [0], 'fallback')).toEqual({
    title: 'fallback', source: 'model_time',
  });
  expect(deriveTitle([{ role: 'user', content: 'x' }], null, 'fallback')).toEqual({
    title: 'fallback', source: 'model_time',
  });
});

test('标题按 Unicode 字符截到 60 字', () => {
  const long = '中'.repeat(80);
  const derived = deriveTitle([{ role: 'user', content: long }], [0], 'fallback');
  expect([...derived.title].length).toBe(60);
});

test('标题取首行且压空白', () => {
  const derived = deriveTitle([{ role: 'user', content: 'first   line\nsecond' }], [0], 'fallback');
  expect(derived.title).toBe('first line');
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

function seedChain(store: ReturnType<typeof fixture>['store'], sessions: string[][]): number[] {
  // sessions 是每笔请求的完整消息文本序列；返回 req_id 列表。
  const ids: number[] = [];
  store.write(db => {
    for (const [index, texts] of sessions.entries()) {
      const reqId = index + 1;
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (?,?,?,'actor-a','known',?,'2026-10-20','hook','pending',0,1,1,1,'seed','model_time','ledger',?)`,
        [reqId, JSON.stringify(['session', 'chain']), 'session', 1000 + index, `ledger|${String(index).padStart(4, '0')}`],
      );
      persistBody(store, reqId, {
        protocol: 'anthropic',
        request: { messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })) },
        reply: { id: `msg_${reqId}`, content: [{ type: 'text', text: 'ok' }] },
        redact_version: 1,
      });
      ids.push(reqId);
    }
  });
  return ids;
}

for (const state of ['partial', 'available'] as const) {
  for (const edge of ['0000', 'zzzz'] as const) {
    test(`${state}无骨架${edge}不充当祖先或主链根`, () => {
      const f = fixture();
      try {
        seedChain(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
        f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,
          actor_state,started_ms,day,via,body_state,derive_version,have,created_at,
          updated_at,sort_source,sort_key) VALUES (99,?,'actor-a','known',
          999,'2026-10-22','hook',?,0,1,1,1,'ledger',?)`,
          [JSON.stringify(['session', 'chain']), state, `ledger|${edge}`]));
        enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
        drainDerive(f.store);
        expect(f.store.read.query(`SELECT prev_relation,prev_req_id FROM request
          WHERE req_id=99`).get()).toEqual({ prev_relation: 'unknown', prev_req_id: null });
        expect(f.store.read.query(`SELECT req_id,chain_role FROM request
          WHERE req_id IN (1,2,3) ORDER BY req_id`).all()).toEqual([
          { req_id: 1, chain_role: 'main' }, { req_id: 2, chain_role: 'main' },
          { req_id: 3, chain_role: 'main' },
        ]);
        expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=3`).get())
          .toEqual({ prev_req_id: 2 });
      } finally { f.close(); }
    });
  }
}

test('合法空messages可读但不证明后续请求的父节点', () => {
  const f = fixture();
  try {
    seedChain(f.store, [[], ['A']]);
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
    seedChain(f.store, [['A'], ['A', 'B']]);
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
    seedChain(f.store, [['A'], ['A', 'B']]);
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

type TestStore = ReturnType<typeof fixture>['store'];
const GROUP = 'synthetic-derive';
const ACTOR = 'actor-synthetic';

function seedRound(store: TestStore, ids: readonly [number, number],
  times: readonly [number, number] = [1000, 1000]): void {
  store.write(db => {
    for (const [i, id] of ids.entries()) {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,
        started_ms,day,via,body_state,derive_version,have,created_at,
        updated_at,sort_source,sort_key)
        VALUES (?,?,?,'known',?,'2026-10-22','hook','pending',0,1,1,1,'ledger',?)`,
        [id, GROUP, ACTOR, times[i]!, `1:2:3:0|${String(i * 100).padStart(20, '0')}`]);
    }
  });
  const user = { role: 'user', content: [{ type: 'text', text: 'synthetic input' }] };
  const call = { type: 'tool_use', id: 'synthetic_call', name: 'read_file', input: {} };
  persistBody(store, ids[0], { protocol: 'anthropic',
    request: { messages: [user] }, reply: { content: [call] }, redact_version: 1 });
  persistBody(store, ids[1], { protocol: 'anthropic', request: { messages: [user,
    { role: 'assistant', content: [call] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic_call',
      content: 'synthetic output' }] }] }, reply: { content: [] }, redact_version: 1 });
}

function snapshot(store: TestStore, ids: readonly [number, number]) {
  const [first, second] = ids;
  const requests = ids.map(id => store.read.query<{
    prev_req_id: number | null; prev_relation: string; delta_ordinals: string | null;
    chain_role: string; req_kind: string; title: string | null;
    title_source: string | null; input_preview: string | null;
    input_preview_kind: string | null; reply_preview: string | null;
  }, [number]>(`SELECT prev_req_id,prev_relation,delta_ordinals,chain_role,
    req_kind,title,title_source,input_preview,input_preview_kind,reply_preview
    FROM request WHERE req_id=?`).get(id)!).map(row => ({ ...row,
      prev_req_id: row.prev_req_id === first ? 'first'
        : row.prev_req_id === second ? 'second' : row.prev_req_id,
    }));
  const tools = store.read.query<{
    req_id: number; ord: number; call_id: string; tool_name: string | null;
    result_req: number | null; result_ord: number | null; result_path: string | null; state: string;
  }, [number, number]>(`SELECT req_id,ord,call_id,tool_name,result_req,
    result_ord,result_path,state FROM tool_call WHERE req_id IN (?,?)
    ORDER BY req_id,ord`).all(first, second).map(row => ({ ...row,
      req_id: row.req_id === first ? 'first' : 'second',
      result_req: row.result_req === first ? 'first'
        : row.result_req === second ? 'second' : row.result_req,
    })).sort((a, b) => String(a.req_id).localeCompare(String(b.req_id)) || a.ord - b.ord);
  return { requests, tools };
}

function rebuild(store: TestStore): void {
  enqueueDerive(store, GROUP, ACTOR, '');
  drainDerive(store);
}

test('同毫秒交换摄入ID仍得到相同链角色和工具关系', () => {
  const a = fixture(); const b = fixture();
  try {
    seedRound(a.store, [1, 2]); seedRound(b.store, [2, 1]);
    rebuild(a.store);
    rebuild(b.store);
    expect(snapshot(a.store, [1, 2])).toEqual(snapshot(b.store, [2, 1]));
    expect(snapshot(b.store, [2, 1]).tools[0]).toMatchObject({
      state: 'resolved', result_req: 'second',
    });
  } finally { a.close(); b.close(); }
});

test('时间优先于跨代际物理键字典序', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2], [1000, 2000]);
    f.store.write(db => db.run(`UPDATE request SET sort_key=CASE req_id
      WHEN 1 THEN '9:8:7:0|00000000000000000000'
      ELSE '1:2:3:0|00000000000000000100' END`));
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).requests[1]?.prev_req_id).toBe('first');
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('resolved');
  } finally { f.close(); }
});

test('同代际重复偏移不能由ID创造确定关系', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => db.run(`UPDATE request
      SET sort_key='1:2:3:0|00000000000000000000'`));
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).requests.map(r => r.prev_relation))
      .toEqual(['unknown', 'unknown']);
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('pending');
  } finally { f.close(); }
});

test('缺键同时间桶保守且来源后补可重算', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => db.run('UPDATE request SET sort_source=NULL,sort_key=NULL'));
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('pending');
    f.store.write(db => {
      for (const id of [1, 2]) db.run(`UPDATE request
        SET sort_source='ledger',sort_key=? WHERE req_id=?`,
        [`1:2:3:0|${String((id - 1) * 100).padStart(20, '0')}`, id]);
    });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('resolved');
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
        seedRound(f.store, ids);
        f.store.write(db => {
          for (const [i, id] of ids.entries()) db.run(`UPDATE request
            SET sort_source=?,sort_key=? WHERE req_id=?`, [...sources[i]!, id]);
        });
        rebuild(f.store);
        expect(snapshot(f.store, ids).requests.map(row => row.prev_relation))
          .toEqual(['unknown', 'unknown']);
        expect(snapshot(f.store, ids).tools[0]?.state).toBe('pending');
      }
      expect(snapshot(a.store, [1, 2])).toEqual(snapshot(b.store, [2, 1]));
    } finally { a.close(); b.close(); }
  });
}

test('完整派生首次即使用本次工具关联且重建不漂移', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]); rebuild(f.store);
    const first = snapshot(f.store, [1, 2]);
    expect(first.tools[0]).toMatchObject({ state: 'resolved', result_req: 'second' });
    expect(first.requests[1]?.input_preview).toBe('工具结果 · read_file');
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
    f.store.write(db => {
      db.run('DELETE FROM tool_call WHERE req_id IN (1,2)');
      db.run(`UPDATE request SET prev_req_id=NULL,prev_relation=NULL,
        delta_ordinals=NULL,title=NULL,title_source=NULL,input_preview=NULL,
        input_preview_kind=NULL,reply_preview=NULL WHERE req_id IN (1,2)`);
    });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
  } finally { f.close(); }
});

test('其它组同call_id不能污染本次摘要', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (99,'other','other','known',0,'2026-10-22','hook','pending',0,1,1,1)`);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('synthetic_call',99,0,'unrelated_tool','resolved',1)`);
    });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('可读工具轮次标题不依赖旧值且缺正文标题保留', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`UPDATE request SET title='stale derived title',title_source='user_delta'
        WHERE req_id=2`);
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1,
        'retained title','user_delta')`, [GROUP, ACTOR]);
    });
    rebuild(f.store);
    const first = snapshot(f.store, [1, 2]);
    expect(first.requests[1]).toMatchObject({
      title: modelTimeTitle(null, 1000), title_source: 'model_time',
    });
    expect(first.requests[1]?.title?.startsWith('unknown · ')).toBe(true);
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
    f.store.write(db => db.run(`UPDATE request SET title=NULL,title_source=NULL
      WHERE req_id IN (1,2)`));
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
    expect(f.store.read.query(`SELECT title,title_source FROM request WHERE req_id=3`).get())
      .toEqual({ title: 'retained title', title_source: 'user_delta' });
  } finally { f.close(); }
});

test('工具行记算法依据，保留行不改原版本', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1)`, [GROUP, ACTOR]);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('old-retained',3,0,'old','resolved',7)`);
    });
    // 旧 derive_version 不再累加：重算只写算法版本与依据，重复运行结果稳定。
    for (let run = 0; run < 2; run++) {
      rebuild(f.store);
      expect(f.store.read.query(
        `SELECT derive_version,algorithm_version,retention_state FROM tool_call WHERE req_id=1`).get(),
      ).toEqual({
        derive_version: 1, algorithm_version: GROUP_ALGORITHM, retention_state: 'recomputed',
      });
      // 正文已回收的保留行原样保留：版本仍是它当时的，只标出本轮没有重算。
      expect(f.store.read.query(
        `SELECT derive_version,algorithm_version,retention_state FROM tool_call WHERE req_id=3`).get(),
      ).toEqual({
        derive_version: 7, algorithm_version: null, retention_state: 'retained',
      });
    }
  } finally { f.close(); }
});

test('同一消息里第二个工具结果按精确path取到调用名', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    // 第二笔的增量消息里放两个结果：第一个指向别的调用，第二个才是本次调用。
    persistBody(f.store, 2, { protocol: 'anthropic', request: { messages: [
      { role: 'user', content: [{ type: 'text', text: 'synthetic input' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic_call',
        name: 'read_file', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'other_call', content: 'unrelated' },
        { type: 'tool_result', tool_use_id: 'synthetic_call', content: 'synthetic output' },
      ] },
    ] }, reply: { content: [] }, redact_version: 1 });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).tools[0]).toMatchObject({
      state: 'resolved', result_ord: 2,
      result_path: 'request.messages[2].content[1]',
    });
    expect(snapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('chat协议工具结果位置与名称由本次关联给出', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    const user = { role: 'user', content: 'synthetic input' };
    const call = { id: 'synthetic_call', type: 'function',
      function: { name: 'read_file', arguments: '{}' } };
    const assistant = { role: 'assistant', content: null, tool_calls: [call] };
    persistBody(f.store, 1, { protocol: 'chat', request: { messages: [user] },
      reply: { choices: [{ message: assistant }] }, redact_version: 1 });
    persistBody(f.store, 2, { protocol: 'chat', request: { messages: [user, assistant,
      { role: 'tool', tool_call_id: 'synthetic_call', content: 'synthetic output' }] },
      reply: { choices: [{ message: { role: 'assistant', content: 'done' } }] }, redact_version: 1 });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).tools[0]).toMatchObject({
      state: 'resolved', result_ord: 2, result_path: 'request.messages[2]',
    });
    expect(snapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('标题请求的回复含工具调用也不产生工具行', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    persistBody(f.store, 1, { protocol: 'anthropic', request: { messages: [
      { role: 'user', content: [{ type: 'text', text: '<session>synthetic</session>' }] },
    ] }, reply: { content: [
      { type: 'text', text: '{"title":"合成标题"}' },
      { type: 'tool_use', id: 'title_side_call', name: 'side_tool', input: {} },
    ] }, redact_version: 1 });
    rebuild(f.store);
    expect(f.store.read.query(`SELECT req_kind,chain_role FROM request WHERE req_id=1`).get())
      .toEqual({ req_kind: 'title', chain_role: 'aux' });
    expect(f.store.read.query(`SELECT call_id FROM tool_call
      WHERE call_id='title_side_call'`).get()).toBeNull();
  } finally { f.close(); }
});

test('被回收调用的旧resolved行保留且不参与本次摘要', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    // 旧行：正文已回收的请求 3，用相同 call_id 指向本次结果。
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1)`, [GROUP, ACTOR]);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,result_req,result_ord,
        result_path,state,derive_version) VALUES
        ('synthetic_call',3,0,'retained_tool',2,2,'request.messages[2].content[0]','resolved',1)`);
    });
    rebuild(f.store);
    // 旧行原样保留，不被本轮重建抹掉。
    expect(f.store.read.query(`SELECT tool_name,state FROM tool_call WHERE req_id=3`).get())
      .toEqual({ tool_name: 'retained_tool', state: 'resolved' });
    // 本次摘要只认本次关联，不取旧行的名字。
    expect(snapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('合成旧排序经维护入口对齐且事实守恒', async () => {
  const direct = fixture(); const historical = fixture();
  try {
    for (const f of [direct, historical]) {
      seedRound(f.store, [1, 2], [1000, 2000]);
      f.store.write(db => {
        db.run(`UPDATE request SET cost=0.25,sort_key=CASE req_id
          WHEN 1 THEN '9:8:7:0|00000000000000000000'
          ELSE '1:2:3:0|00000000000000000100' END`);
        db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
          VALUES (1,'hook','synthetic-owner-1','merged',1),
                 (2,'hook','synthetic-owner-2','merged',1)`);
      });
    }
    rebuild(direct.store);
    historical.store.write(db => db.run(`UPDATE request SET
      prev_req_id=NULL,prev_relation='first',delta_ordinals='[0]',
      chain_role='main',title='synthetic old result',title_source='model_time'`));
    const facts = () => ({
      requests: historical.store.read.query(`SELECT req_id,cost,conv_key,actor
        FROM request ORDER BY req_id`).all(),
      owners: historical.store.read.query(`SELECT req_id,source_kind,ref_key,merge_state
        FROM request_evidence ORDER BY req_id,source_kind,ref_key`).all(),
      refs: historical.store.read.query(`SELECT req_id,ord,block
        FROM request_block ORDER BY req_id,ord`).all(),
    });
    const before = facts();
    const lines: string[] = [];
    expect(await runMaintenance(['rebuild', '--db', join(historical.dir, 'trace.db'),
      '--session', GROUP], { out: line => lines.push(line), err: () => {} })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ queue_remaining: 0,
      recomputed_requests: 2, retained_requests: 0 });
    expect(snapshot(historical.store, [1, 2])).toEqual(snapshot(direct.store, [1, 2]));
    expect(facts()).toEqual(before);
  } finally { direct.close(); historical.close(); }
});

const injectedStages = [
  ['tool', `BEFORE INSERT ON tool_call`],
  ['preview', `BEFORE UPDATE OF input_preview ON request`],
  ['ack', `BEFORE UPDATE OF state ON derive_queue WHEN NEW.state='clean'`],
] as const;

for (const [stage, event] of injectedStages) {
  test(`同步派生${stage}失败保留队列且重开可恢复`, () => {
    const f = fixture();
    let reopened: ReturnType<typeof openStore> | undefined;
    try {
      seedRound(f.store, [1, 2]);
      enqueueDerive(f.store, GROUP, ACTOR, '');
      const before = snapshot(f.store, [1, 2]);
      f.store.write(db => db.exec(`CREATE TRIGGER injected_derive ${event}
        BEGIN SELECT RAISE(ABORT,'injected_derive'); END`));
      expect(() => drainDerive(f.store)).toThrow('injected_derive');
      expect(snapshot(f.store, [1, 2])).toEqual(before);
      // ack 失败：组仍是 dirty，没有写成 clean。
      expect(f.store.read.query("SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'").get())
        .toEqual({ n: 1 });
      f.store.write(db => db.exec('DROP TRIGGER injected_derive'));
      f.store.close();
      reopened = openStore(join(f.dir, 'trace.db'));
      expect(drainDerive(reopened).remaining).toBe(0);
      expect(snapshot(reopened, [1, 2]).tools[0]?.state).toBe('resolved');
      expect(snapshot(reopened, [1, 2]).requests[1]?.input_preview)
        .toBe('工具结果 · read_file');
    } finally { reopened?.close(); f.close(); }
  });
}

test('第二组确认失败时整批回滚且旧结果保留', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    rebuild(f.store);
    const settled = snapshot(f.store, [1, 2]);
    // 第二个组用不同身份与工具 ID，复用同一形状。
    f.store.write(db => {
      for (const [i, id] of [11, 12].entries()) {
        db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
          day,via,body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
          VALUES (?,?,'actor-second','known',?,'2026-10-22','hook','pending',0,1,1,1,
          'ledger',?)`, [id, 'zz-second', 2000 + i,
          `1:2:3:0|${String(i * 100).padStart(20, '0')}`]);
      }
    });
    const user = { role: 'user', content: [{ type: 'text', text: 'second input' }] };
    const call = { type: 'tool_use', id: 'second_call', name: 'second_tool', input: {} };
    persistBody(f.store, 11, { protocol: 'anthropic', request: { messages: [user] },
      reply: { content: [call] }, redact_version: 1 });
    persistBody(f.store, 12, { protocol: 'anthropic', request: { messages: [user,
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'second_call',
        content: 'second output' }] }] }, reply: { content: [] }, redact_version: 1 });
    enqueueDerive(f.store, GROUP, ACTOR, '');
    enqueueDerive(f.store, 'zz-second', 'actor-second', '');
    f.store.write(db => db.exec(`CREATE TRIGGER fail_second_ack
      BEFORE UPDATE OF state ON derive_queue WHEN NEW.state='clean' AND NEW.conv_key='zz-second'
      BEGIN SELECT RAISE(ABORT,'injected_second'); END`));
    expect(() => drainDerive(f.store)).toThrow('injected_second');
    // 本批全部组在同一个事务里，第二组失败连第一组一起回滚。
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'").get())
      .toEqual({ n: 2 });
    expect(snapshot(f.store, [1, 2])).toEqual(settled);
    f.store.write(db => db.exec('DROP TRIGGER fail_second_ack'));
    expect(drainDerive(f.store).remaining).toBe(0);
    expect(snapshot(f.store, [1, 2])).toEqual(settled);
    expect(f.store.read.query(`SELECT state FROM tool_call WHERE call_id='second_call'`).get())
      .toEqual({ state: 'resolved' });
  } finally { f.close(); }
});

test('稳定排序重算得到确定增量与标题', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['a'], ['a', 'b'], ['a', 'b', 'c']]);
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

test('limit按组计数且首组整批处理', () => {
  const f = fixture();
  try {
    // 首组 250 笔，另组 1 笔；组名按字节序保证首组先被选中。
    const chain = Array.from({ length: 250 }, (_, index) =>
      Array.from({ length: index + 1 }, (_, position) => `m${position}`));
    seedChain(f.store, chain);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at)
        VALUES (500,'zz-second','actor-b','known',9999,'2026-10-22','hook','pending',0,1,1,1)`);
    });
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    enqueueDerive(f.store, 'zz-second', 'actor-b', '');
    const first = drainDerive(f.store, 1);
    expect(first.processed).toBe(250);
    expect(first.remaining).toBe(1);
    const second = drainDerive(f.store, 1);
    expect(second.processed).toBe(1);
    expect(second.remaining).toBe(0);
  } finally { f.close(); }
});

test('非法limit与空scope被拒绝', () => {
  const f = fixture();
  try {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => drainDerive(f.store, limit)).toThrow('invalid_derive_limit');
    }
    expect(() => drainDerive(f.store, 10, { convKey: '' })).toThrow('invalid_derive_scope');
  } finally { f.close(); }
});

test('空组任务也被确认且不计重算或保留', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      "INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES ('empty-group','actor-empty','')"));
    const result = drainDerive(f.store);
    expect(result.groups).toEqual([{ conv_key: 'empty-group', actor: 'actor-empty' }]);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.recomputed).toBe(0);
    expect(result.retained).toBe(0);
  } finally { f.close(); }
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
    seedChain(f.store, [['a'], ['a', 'b']]);
    // 抹掉第一笔的正文：第二笔无法确认前驱
    f.store.write(db => db.run("UPDATE request SET body_state='pending', skeleton_z=NULL WHERE req_id=1"));
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{
      req_id: number; prev_relation: string; delta_ordinals: string | null; chain_role: string;
    }, []>('SELECT req_id, prev_relation, delta_ordinals, chain_role FROM request ORDER BY req_id').all();
    expect(rows).toEqual([
      { req_id: 1, prev_relation: 'unknown', delta_ordinals: null, chain_role: 'main' },
      { req_id: 2, prev_relation: 'unknown', delta_ordinals: null, chain_role: 'main' },
    ]);
  } finally {
    f.close();
  }
});

test('未知归属的请求不入队', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (1,'k',NULL,'unknown',1,'2026-10-20','hook','pending',0,1,1,1,'t','model_time')`,
    ));
    enqueueDerive(f.store, 'k', 'unknown-sentinel', '');
    expect(f.store.read.query("SELECT count(*) AS n FROM derive_queue WHERE state<>'clean'").get())
      .toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('未知归属的请求也能完成用途且不建哨兵组', () => {
  const f = fixture();
  try {
    // hook 先到：只知道会话，不知道 actor。它不进组，但它的用途是有效事实。
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (1,'k',NULL,'unknown',1000,'2026-10-20','hook','pending',0,1,1,1)`,
    ));
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic prompt' }] }] },
      reply: { id: 'msg_title', content: [{ type: 'text', text: '<title>合成标题</title>' }] },
      redact_version: 1,
    });
    const result = drainDerive(f.store);
    expect(result.purpose_processed).toBe(1);
    expect(result.purpose_remaining).toBe(0);
    expect(f.store.read.query(`SELECT req_kind,purpose_pending,purpose_version,
      purpose_status,purpose_rule,purpose_chain,model_title FROM request WHERE req_id=1`).get())
      .toEqual({
        req_kind: 'title', purpose_pending: 0, purpose_version: PURPOSE_VERSION,
        purpose_status: 'recognized', purpose_rule: 'title.reply.v1', purpose_chain: 'exclude',
        model_title: '合成标题',
      });
    // 未知归属不产生组：没有哨兵，也没有替它编一个 actor。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT actor FROM request WHERE req_id=1').get())
      .toEqual({ actor: null });
  } finally { f.close(); }
});

test('正文回收后保留原用途版本并消费当前修订', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['synthetic']]);
    drainDerive(f.store);
    const before = f.store.read.query<{ input_revision: number }, []>(
      'SELECT input_revision FROM request WHERE req_id=1').get()!;
    // 正文回收后再来一次输入变化：读不出可比内容，但结论曾经算过，保留原值而不是降级成 missing。
    f.store.write(db => db.run(
      `UPDATE request SET body_state='evicted',skeleton_z=NULL,msg_count=NULL,
         input_revision=input_revision+1,purpose_pending=1,purpose_retry=0 WHERE req_id=1`));
    const result = drainDerive(f.store);
    expect(result.purpose_processed).toBe(1);
    const row = f.store.read.query<{
      purpose_status: string; purpose_version: number; purpose_revision: number;
      input_revision: number; req_kind: string;
    }, []>(`SELECT purpose_status,purpose_version,purpose_revision,input_revision,req_kind
      FROM request WHERE req_id=1`).get()!;
    expect(row.input_revision).toBe(before.input_revision + 1);
    expect(row).toEqual({
      purpose_status: 'retained', purpose_version: PURPOSE_VERSION,
      // 消费的是当前修订，不是"上次判定的那一版"：留着旧修订等于没判。
      purpose_revision: row.input_revision, input_revision: row.input_revision,
      req_kind: 'chat',
    });
  } finally { f.close(); }
});

test('从未判定过又读不出正文的请求标missing', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (1,'k','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1)`,
    ));
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT purpose_status,purpose_version,purpose_rule,
      purpose_pending FROM request WHERE req_id=1`).get()).toEqual({
      purpose_status: 'missing', purpose_version: null, purpose_rule: null, purpose_pending: 0,
    });
  } finally { f.close(); }
});

test('用途分批推进到排空后再发布组', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['synthetic a'], ['synthetic a', 'synthetic b']]);
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    // 模拟"组已 dirty、成员仍 pending"：purposeLimit 只限制每批大小。
    f.store.write(db => db.run('UPDATE request SET purpose_pending=1'));
    const result = drainDeriveTx(f.store.db, { limit: 10, purposeLimit: 1 });
    // 两笔各占一批，同一事务内推进到没有 pending 后组才能算。
    expect(result.purpose_processed).toBe(2);
    expect(result.purpose_remaining).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.groups.length).toBe(1);
  } finally { f.close(); }
});

test('工具调用按同actor配对，跨请求不串', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002')`,
        [JSON.stringify(['session', 'tools']), JSON.stringify(['session', 'tools'])],
      );
    });
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }] },
      reply: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_x', name: 'read', input: { path: 'a' } }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'read it' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'read', input: { path: 'a' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'done' }] },
        ],
      },
      reply: { id: 'msg_2', content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, JSON.stringify(['session', 'tools']), 'actor-a', '');
    const result = drainDerive(f.store);
    expect(result.processed).toBe(2);
    const call = f.store.read.query<{ result_req: number; result_ord: number; result_path: string; state: string }, [number]>(
      'SELECT result_req, result_ord, result_path, state FROM tool_call WHERE req_id=? AND ord=0').get(1);
    expect(call).toEqual({
      result_req: 2, result_ord: 2, result_path: 'request.messages[2].content[0]', state: 'resolved',
    });
  } finally {
    f.close();
  }
});

test('工具结果轮次不重复末轮用户输入，纯工具调用回复有摘要', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'tool-preview']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002')`,
        [key, key],
      );
    });
    const question = { role: 'user', content: [{ type: 'text', text: '最初的问题' }] };
    const callMsg = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_b1', name: 'bash', input: {} },
        { type: 'tool_use', id: 'toolu_b2', name: 'bash', input: {} },
      ],
    };
    const resultMsg = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_b1', content: 'one' },
        { type: 'tool_result', tool_use_id: 'toolu_b2', content: 'two' },
      ],
    };
    // 第一笔：用户提问，回复是纯工具调用。
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [question] },
      reply: { id: 'msg_1', content: callMsg.content },
      redact_version: 1,
    });
    // 第二笔：增量只有回传的工具结果，没有新的用户文本。
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [question, callMsg, resultMsg] },
      reply: { id: 'msg_2', content: [{ type: 'text', text: 'done' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{
      req_id: number; input_preview: string | null; input_preview_kind: string | null; reply_preview: string | null;
    }, []>(
      'SELECT req_id, input_preview, input_preview_kind, reply_preview FROM request ORDER BY req_id').all();

    expect(rows[0]?.reply_preview?.startsWith('工具调用 ·')).toBe(true);
    expect(rows[1]?.input_preview_kind).toBe('tool_result');
    expect(rows[1]?.input_preview?.startsWith('工具结果 ·')).toBe(true);
    // 关键回归：第二笔不能显示第一轮那句用户输入。
    expect(rows[1]?.input_preview).not.toBe('最初的问题');
  } finally {
    f.close();
  }
});

test('标题回复不再在预览里解析，标题由用途列提供', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'title-reply']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002')`,
        [key, key],
      );
    });
    const question = { role: 'user', content: [{ type: 'text', text: '问一句' }] };
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [question] },
      reply: { id: 'msg_1', content: [{ type: 'text', text: '<title nf="nf-md-git" emoji="🗂️">压缩机制选型</title>' }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [question] },
      reply: { id: 'msg_2', content: [{ type: 'text', text: '{"title":"Compaction 工程选型"}' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{ reply_preview: string | null; model_title: string | null }, []>(
      'SELECT reply_preview, model_title FROM request ORDER BY req_id').all();
    // 预览只展示回复原文；正式标题由用途阶段写入 model_title。
    expect(rows[0]?.reply_preview).toBe('<title nf="nf-md-git" emoji="🗂️">压缩机制选型</title>');
    expect(rows[1]?.reply_preview).toBe('{"title":"Compaction 工程选型"}');
    expect(rows[0]?.model_title).toBe('压缩机制选型');
    expect(rows[1]?.model_title).toBe('Compaction 工程选型');
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

test('harness 的 caveat 与插话提示不进入标题', () => {
  const caveat = '<local-command-caveat>CAVEAT: The command below was run directly.</local-command-caveat>';
  expect(deriveTitle(
    [{ role: 'user', content: `${caveat}\n<command-name>/model</command-name>` }],
    [0], 'fallback',
  )).toEqual({ title: 'fallback', source: 'model_time' });
  const inserted = 'The user sent a new message while you were working: 另外我看现在 agent 判定不准\n\n'
    + 'This is how Claude Code surfaces messages the user sends mid-turn.';
  expect(deriveTitle([{ role: 'user', content: inserted }], [0], 'fallback'))
    .toEqual({ title: '另外我看现在 agent 判定不准', source: 'user_delta' });
});

test('重复call_id标ambiguous不挑最近', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002'),
                (3,?,'session','actor-a','known',3000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0003')`,
        Array(3).fill(JSON.stringify(['session', 'dup'])),
      );
    });
    const reply = { id: 'msg_c', content: [{ type: 'tool_use', id: 'toolu_dup', name: 'read', input: {} }] };
    for (const id of [1, 2]) {
      persistBody(f.store, id, {
        protocol: 'anthropic',
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: `q${id}` }] }] },
        reply, redact_version: 1,
      });
    }
    persistBody(f.store, 3, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dup', content: 'r' }] }] },
      reply: { id: 'msg_3', content: [] }, redact_version: 1,
    });
    enqueueDerive(f.store, JSON.stringify(['session', 'dup']), 'actor-a', '');
    drainDerive(f.store);
    const states = f.store.read.query<{ req_id: number; state: string }, []>(
      "SELECT req_id, state FROM tool_call WHERE call_id='toolu_dup' ORDER BY req_id").all();
    expect(states).toEqual([{ req_id: 1, state: 'ambiguous' }, { req_id: 2, state: 'ambiguous' }]);
  } finally {
    f.close();
  }
});

test('后续请求重发同一工具结果不把已确认配对降级', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'resend']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002'),
                (3,?,'session','actor-a','known',3000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0003')`,
        [key, key, key],
      );
    });
    const callMsg = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'read', input: {} }] };
    const resultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: 'done' }] };
    const q1 = { role: 'user', content: [{ type: 'text', text: 'q1' }] };
    const a1 = { role: 'assistant', content: [{ type: 'text', text: 'a1' }] };
    persistBody(f.store, 1, {
      protocol: 'anthropic', request: { messages: [q1] }, reply: { id: 'msg_1', content: [callMsg.content[0]] }, redact_version: 1,
    });
    // 第 2 笔带回了结果：这是确定增量，应该配对成功。
    persistBody(f.store, 2, {
      protocol: 'anthropic', request: { messages: [q1, callMsg, resultMsg] },
      reply: { id: 'msg_2', content: [{ type: 'text', text: 'a2' }] }, redact_version: 1,
    });
    // 第 3 笔再次重发同一段历史，结果消息不在这一笔的新增里。
    persistBody(f.store, 3, {
      protocol: 'anthropic', request: { messages: [q1, callMsg, resultMsg, { role: 'assistant', content: [{ type: 'text', text: 'a2' }] }, a1] },
      reply: { id: 'msg_3', content: [] }, redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const call = f.store.read.query<{ result_req: number; state: string }, []>(
      "SELECT result_req, state FROM tool_call WHERE call_id='toolu_r'").get();
    // 首次出现该结果的请求才是配对目标；后来的重发不能把它改回 pending。
    expect(call).toEqual({ result_req: 2, state: 'resolved' });
  } finally {
    f.close();
  }
});

test('先到的未确认结果不挡后来的确认配对', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'upgrade']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002')`,
        [key, key],
      );
    });
    const callMsg = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_u', name: 'read', input: {} }] };
    const resultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_u', content: 'done' }] };
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'q1' }] }] },
      reply: { id: 'msg_1', content: [callMsg.content[0]] }, redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'q2' }] }, callMsg, resultMsg] },
      reply: { id: 'msg_2', content: [] }, redact_version: 1,
    });
    // 第 2 笔与第 1 笔没有公共前缀：结果出现在确认不了的位置，只能记候选。
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const first = f.store.read.query<{ state: string }, []>("SELECT state FROM tool_call WHERE call_id='toolu_u'").get();
    expect(first?.state).toBe('pending');

    // 第二笔实际输入改成与第一笔前缀一致：同一位置现在确认了，统一重算应升级为 resolved。
    persistBody(f.store, 2, { protocol: 'anthropic',
      request: { messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] }, callMsg, resultMsg,
      ] }, reply: { id: 'msg_2', content: [] }, redact_version: 1 });
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const second = f.store.read.query<{ state: string; result_req: number }, []>(
      "SELECT state, result_req FROM tool_call WHERE call_id='toolu_u'").get();
    expect(second).toEqual({ state: 'resolved', result_req: 2 });
  } finally {
    f.close();
  }
});

function queueState(store: Store, convKey: string): string | null {
  return store.read.query<{ state: string }, [string]>(
    'SELECT state FROM derive_queue WHERE conv_key=?').get(convKey)?.state ?? null;
}

test('派生先结算用途再发布组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'purpose-group',
      system: 'You are a security monitor for autonomous AI coding agents.',
      stop: ['</block>'],
      messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }],
      reply: { content: [{ type: 'text', text: '<block>no' }] },
    });
    enqueueDerive(f.store, 'purpose-group', 'actor', '');
    const result = drainDerive(f.store, 100);
    // 本 Task 只断言用途先结算、组再发布；链角色与工具配对由 Task 4 消费后断言。
    expect(result).toMatchObject({
      purpose_processed: 1, purpose_remaining: 0, processed: 1,
    });
    expect(f.store.read.query<{
      purpose_status: string; purpose_pending: number; req_kind: string;
    }, [number]>(`
      SELECT purpose_status, purpose_pending, req_kind FROM request WHERE req_id=?`)
      .get(id)).toEqual({
      purpose_status: 'recognized', purpose_pending: 0, req_kind: 'auto-mode-classifier',
    });
    expect(queueState(f.store, 'purpose-group')).toBe('clean');
  } finally { f.close(); }
});

test('用途分批结算不延迟同组发布', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, { convKey: 'defer', reply: { content: [{ type: 'text', text: 'one' }] } });
    seedPurposeRequest(f.store, { convKey: 'defer', reply: { content: [{ type: 'text', text: 'two' }] } });
    enqueueDerive(f.store, 'defer', 'actor', '');
    // limit 按组计数：即使每批只判一笔用途，同一调用也要把组内成员判完再发布。
    const result = drainDerive(f.store, 1);
    expect(result.purpose_processed).toBe(2);
    expect(result.purpose_remaining).toBe(0);
    expect(result.processed).toBe(2);
    expect(queueState(f.store, 'defer')).toBe('clean');
  } finally { f.close(); }
});

test('未知 actor 仍完成用途且不产生哨兵组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'solo', actor: null, actorState: 'unknown',
      reply: { content: [{ type: 'text', text: 'plain' }] },
    });
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ purpose_pending: number }, [number]>(
      'SELECT purpose_pending FROM request WHERE req_id=?').get(id))
      .toEqual({ purpose_pending: 0 });
    expect(f.store.read.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=?').get('solo'))
      .toEqual({ n: 0 });
  } finally { f.close(); }
});

test('范围派生只处理目标会话的待定用途', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, { convKey: 'scope-a' });
    const other = seedPurposeRequest(f.store, { convKey: 'scope-b' });
    const result = drainDerive(f.store, 100, { convKey: 'scope-a' });
    expect(result.purpose_processed).toBe(1);
    expect(result.purpose_remaining).toBe(0);
    expect(f.store.read.query<{ purpose_pending: number }, [number]>(
      'SELECT purpose_pending FROM request WHERE req_id=?').get(other))
      .toEqual({ purpose_pending: 1 });
  } finally { f.close(); }
});

test('排除用途不进入主链也不写工具配对', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'excluded-tools', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'auto-mode-classifier',
      purposeChain: 'exclude', purposeRule: 'claude.auto-mode-classifier.v1',
      reply: { content: [
        { type: 'tool_use', id: 'tool-excluded', name: 'Bash', input: { command: 'ls' } },
      ] },
    });
    enqueueDerive(f.store, 'excluded-tools', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ n: number }, [number]>(
      'SELECT COUNT(*) AS n FROM tool_call WHERE req_id=?').get(id)).toEqual({ n: 0 });
    expect(f.store.read.query<{ chain_role: string }, [number]>(
      'SELECT chain_role FROM request WHERE req_id=?').get(id))
      .toEqual({ chain_role: 'aux' });
  } finally { f.close(); }
});

test('非标题的排除用途不从用户增量取标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'aux-delta', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'chat', purposeChain: 'participate',
      messages: [{ role: 'user', content: [{ type: 'text', text: '第一轮' }] }],
    });
    const aux = seedPurposeRequest(f.store, {
      convKey: 'aux-delta', purposePending: 0, purposeVersion: 2, startedMs: 2,
      purposeStatus: 'recognized', reqKind: 'auto-mode-classifier', purposeChain: 'exclude',
      purposeRule: 'claude.auto-mode-classifier.v1', modelTitle: '分类器标题',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
        { role: 'user', content: [{ type: 'text', text: '这段文本不应成为标题' }] },
      ],
    });
    enqueueDerive(f.store, 'aux-delta', 'actor', '');
    drainDerive(f.store, 100);
    // aux 与主链没有可比关系，输入摘要按末轮输入展示；标题只来自用途列。
    expect(f.store.read.query<{ title: string; title_source: string;
      input_preview_kind: string | null }, [number]>(
      'SELECT title,title_source,input_preview_kind FROM request WHERE req_id=?').get(aux))
      .toEqual({ title: '分类器标题', title_source: 'model_title',
        input_preview_kind: 'tail' });
  } finally { f.close(); }
});

test('标题由用途列驱动而不是回复形状', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'title-source', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'title', purposeChain: 'exclude',
      modelTitle: '存储标题',
      reply: { content: [{ type: 'text', text: '<title>回复标题</title>' }] },
    });
    enqueueDerive(f.store, 'title-source', 'actor', '');
    drainDerive(f.store, 100);
    const row = f.store.read.query<{
      model_title: string | null; title: string; reply_preview: string | null;
    }, [number]>(
      'SELECT model_title, title, reply_preview FROM request WHERE req_id=?').get(id)!;
    expect(row.model_title).toBe('存储标题');
    expect(row.title).toBe('存储标题');
    expect(row.reply_preview?.startsWith('标题 · ')).toBe(false);
  } finally { f.close(); }
});

test('来源类别保持原始 req_kind 并参与链', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'neutral', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'source:compaction',
      purposeChain: 'participate', purposeRule: 'source.kind.v1',
    });
    enqueueDerive(f.store, 'neutral', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ req_kind: string; chain_role: string }, [number]>(
      'SELECT req_kind, chain_role FROM request WHERE req_id=?').get(id))
      .toEqual({ req_kind: 'source:compaction', chain_role: 'main' });
  } finally { f.close(); }
});

test('派生不再从回复形状识别标题', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'no-redetect', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'unrecognized', reqKind: 'chat', purposeChain: 'participate',
      reply: { content: [{ type: 'text', text: '<title>不应成为标题</title>' }] },
    });
    enqueueDerive(f.store, 'no-redetect', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{
      req_kind: string; chain_role: string; model_title: string | null;
    }, [number]>(
      'SELECT req_kind, chain_role, model_title FROM request WHERE req_id=?').get(id))
      .toEqual({ req_kind: 'chat', chain_role: 'main', model_title: null });
  } finally { f.close(); }
});
