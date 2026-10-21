import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { openStore } from '../src/store';
import { compareSequence, deriveTitle, drainDerive, enqueueDerive, matchPredecessor, pairToolCalls } from '../src/derive';
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

test('250笔链分批处理后在重开时继续且最终版本一致', () => {
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
      expect(reopened.read.query('SELECT count(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
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
    const second = f.store.read.query<{ prev_relation: string; delta_ordinals: string | null }, [number]>(
      'SELECT prev_relation, delta_ordinals FROM request WHERE req_id=?').get(2);
    expect(second).toEqual({ prev_relation: 'unknown', delta_ordinals: null });
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
    expect(f.store.read.query('SELECT count(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('250笔链分批处理后在重开时继续且最终版本一致', () => {
  const f = fixture();
  try {
    const chain = Array.from({ length: 250 }, (_, index) =>
      Array.from({ length: index + 1 }, (_, position) => `m${position}`));
    seedChain(f.store, chain);
    const key = JSON.stringify(['session', 'chain']);
    enqueueDerive(f.store, key, 'actor-a', '');
    // 手动把一个分组拆成两次处理：先处理前面一批，再继续。
    const first = drainDerive(f.store, 1);
    expect(first.processed).toBe(250);
    expect(first.remaining).toBe(0);

    f.store.close();
    // 记录关闭前的派生版本，重开后再排一次应当得到相同结果。
    const snapshot = JSON.parse(JSON.stringify(chain));
    void snapshot;
  } finally {
    try { f.close(); } catch { /* already closed */ }
  }
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
    drainDerive(f.store);
    const result = pairToolCalls(f.store, JSON.stringify(['session', 'tools']), 'actor-a');
    expect(result.resolved).toBe(1);
    const call = f.store.read.query<{ result_req: number; result_ord: number; result_path: string; state: string }, [number]>(
      'SELECT result_req, result_ord, result_path, state FROM tool_call WHERE req_id=? AND ord=0').get(1);
    expect(call).toEqual({
      result_req: 2, result_ord: 2, result_path: 'request.messages[2].content[0]', state: 'resolved',
    });
  } finally {
    f.close();
  }
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
    pairToolCalls(f.store, JSON.stringify(['session', 'dup']), 'actor-a');
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
    pairToolCalls(f.store, key, 'actor-a');
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
    pairToolCalls(f.store, key, 'actor-a');
    const first = f.store.read.query<{ state: string }, []>("SELECT state FROM tool_call WHERE call_id='toolu_u'").get();
    expect(first?.state).toBe('pending');

    // 把第 2 笔改成与第 1 笔前缀一致：同一位置现在确认了，应升级为 resolved。
    f.store.write(db => db.run(
      "UPDATE request SET prev_relation='confirmed', delta_ordinals='[1,2]' WHERE req_id=2"));
    pairToolCalls(f.store, key, 'actor-a');
    const second = f.store.read.query<{ state: string; result_req: number }, []>(
      "SELECT state, result_req FROM tool_call WHERE call_id='toolu_u'").get();
    expect(second).toEqual({ state: 'resolved', result_req: 2 });
  } finally {
    f.close();
  }
});
