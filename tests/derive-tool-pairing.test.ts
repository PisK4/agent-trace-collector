import { expect, test } from 'bun:test';
import { fixture, seedDeriveRound, deriveSnapshot, rebuildDeriveGroup, DERIVE_GROUP, DERIVE_ACTOR } from './fixtures';
import { GROUP_ALGORITHM } from '../src/derive/state';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { persistBody } from '../src/body';

// 工具配对：候选选取、同 actor 配对与 ambiguous/保留行规则。
test('完整派生首次即使用本次工具关联且重建不漂移', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]); rebuildDeriveGroup(f.store);
    const first = deriveSnapshot(f.store, [1, 2]);
    expect(first.tools[0]).toMatchObject({ state: 'resolved', result_req: 'second' });
    expect(first.requests[1]?.input_preview).toBe('工具结果 · read_file');
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2])).toEqual(first);
    f.store.write(db => {
      db.run('DELETE FROM tool_call WHERE req_id IN (1,2)');
      db.run(`UPDATE request SET prev_req_id=NULL,prev_relation=NULL,
        delta_ordinals=NULL,title=NULL,title_source=NULL,input_preview=NULL,
        input_preview_kind=NULL,reply_preview=NULL WHERE req_id IN (1,2)`);
    });
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2])).toEqual(first);
  } finally { f.close(); }
});

test('其它组同call_id不能污染本次摘要', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (99,'other','other','known',0,'2026-10-22','hook','pending',0,1,1,1)`);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('synthetic_call',99,0,'unrelated_tool','resolved',1)`);
    });
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('工具行记算法依据，保留行不改原版本', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1)`, [DERIVE_GROUP, DERIVE_ACTOR]);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('old-retained',3,0,'old','resolved',7)`);
    });
    // 旧 derive_version 不再累加：重算只写算法版本与依据，重复运行结果稳定。
    for (let run = 0; run < 2; run++) {
      rebuildDeriveGroup(f.store);
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
    seedDeriveRound(f.store, [1, 2]);
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
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).tools[0]).toMatchObject({
      state: 'resolved', result_ord: 2,
      result_path: 'request.messages[2].content[1]',
    });
    expect(deriveSnapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('chat协议工具结果位置与名称由本次关联给出', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    const user = { role: 'user', content: 'synthetic input' };
    const call = { id: 'synthetic_call', type: 'function',
      function: { name: 'read_file', arguments: '{}' } };
    const assistant = { role: 'assistant', content: null, tool_calls: [call] };
    persistBody(f.store, 1, { protocol: 'chat', request: { messages: [user] },
      reply: { choices: [{ message: assistant }] }, redact_version: 1 });
    persistBody(f.store, 2, { protocol: 'chat', request: { messages: [user, assistant,
      { role: 'tool', tool_call_id: 'synthetic_call', content: 'synthetic output' }] },
      reply: { choices: [{ message: { role: 'assistant', content: 'done' } }] }, redact_version: 1 });
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2]).tools[0]).toMatchObject({
      state: 'resolved', result_ord: 2, result_path: 'request.messages[2]',
    });
    expect(deriveSnapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});

test('标题请求的回复含工具调用也不产生工具行', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    persistBody(f.store, 1, { protocol: 'anthropic', request: { messages: [
      { role: 'user', content: [{ type: 'text', text: '<session>synthetic</session>' }] },
    ] }, reply: { content: [
      { type: 'text', text: '{"title":"合成标题"}' },
      { type: 'tool_use', id: 'title_side_call', name: 'side_tool', input: {} },
    ] }, redact_version: 1 });
    rebuildDeriveGroup(f.store);
    expect(f.store.read.query(`SELECT req_kind,chain_role FROM request WHERE req_id=1`).get())
      .toEqual({ req_kind: 'title', chain_role: 'aux' });
    expect(f.store.read.query(`SELECT call_id FROM tool_call
      WHERE call_id='title_side_call'`).get()).toBeNull();
  } finally { f.close(); }
});

test('被回收调用的旧resolved行保留且不参与本次摘要', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    // 旧行：正文已回收的请求 3，用相同 call_id 指向本次结果。
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1)`, [DERIVE_GROUP, DERIVE_ACTOR]);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,result_req,result_ord,
        result_path,state,derive_version) VALUES
        ('synthetic_call',3,0,'retained_tool',2,2,'request.messages[2].content[0]','resolved',1)`);
    });
    rebuildDeriveGroup(f.store);
    // 旧行原样保留，不被本轮重建抹掉。
    expect(f.store.read.query(`SELECT tool_name,state FROM tool_call WHERE req_id=3`).get())
      .toEqual({ tool_name: 'retained_tool', state: 'resolved' });
    // 本次摘要只认本次关联，不取旧行的名字。
    expect(deriveSnapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
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
