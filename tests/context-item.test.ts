import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest, DERIVE_GROUP, DERIVE_ACTOR } from './fixtures';
import { markRequestInputTx } from '../src/derive/state';
import {
  getContextItemReading, getReadingDetail, ReadingConflictError,
} from '../src/reading';
import { encodeCursor } from '../src/queries/cursor';

type F = ReturnType<typeof fixture>;

const ctxQuery = (f: F, id: number, kind: string, opts: { name?: string | null; tag?: string | null; cursor?: string | null } = {}) => {
  const token = getReadingDetail(f.store, id)!.reading_token;
  return getContextItemReading(f.store, id, {
    kind, name: opts.name ?? null, tag: opts.tag ?? null, cursor: opts.cursor ?? null,
  }, token)!;
};

/**
 * 一组带配对结果的种子：owner 发起 Read×2 与 Bash×2（同名两个），target 承载
 * 四个结果。配对行手工种——derive 链排序依赖 sort 列（seedPurposeRequest 不写），
 * 而目录消费的是配对表列本身，derive 配对行为由专门测试覆盖。
 */
function seedToolGroup(f: F): { owner: number; target: number } {
  const common = { convKey: DERIVE_GROUP, actor: DERIVE_ACTOR, cleanGroup: true, purposePending: 0,
    summaryState: 'recomputed', summaryAlgorithm: 1 } as const;
  const owner = seedPurposeRequest(f.store, {
    ...common, startedMs: 100,
    messages: [{ role: 'user', content: 'synthetic question' }],
    reply: { content: [
      { type: 'tool_use', id: 'call_read_a', name: 'Read', input: { file_path: 'src/a.ts' } },
      { type: 'tool_use', id: 'call_read_b', name: 'Read', input: { file_path: 'src/b.ts' } },
      { type: 'tool_use', id: 'call_bash_1', name: 'Bash', input: { command: 'ls src' } },
      { type: 'tool_use', id: 'call_bash_2', name: 'Bash', input: { command: 'ls tests' } },
    ] },
  });
  const target = seedPurposeRequest(f.store, {
    ...common, startedMs: 200,
    messages: [
      { role: 'user', content: 'next turn' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_read_a', content: 'a body' },
        { type: 'tool_result', tool_use_id: 'call_bash_1', content: 'a.ts' },
        { type: 'tool_result', tool_use_id: 'call_read_b', content: 'b body' },
        { type: 'tool_result', tool_use_id: 'call_bash_2', content: 'a.test.ts' },
      ] },
    ],
  });
  f.store.write(db => {
    const pair = (callId: string, ord: number, toolName: string, argPath: string | null, block: number) =>
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,arg_path,
          result_req,result_ord,result_path,is_error,state,derive_version)
        VALUES (?,?,?,?,?,?,?,?,0,'resolved',1)`,
      [callId, owner, ord, toolName, argPath, target, 1, `request.messages[1].content[${block}]`]);
    pair('call_read_a', 0, 'Read', 'src/a.ts', 0);
    pair('call_bash_1', 2, 'Bash', null, 1);
    pair('call_read_b', 1, 'Read', 'src/b.ts', 2);
    pair('call_bash_2', 3, 'Bash', null, 3);
  });
  return { owner, target };
};

test('results 目录来自反向配对表列：同名工具多行全保留，位置可续读', () => {
  const f = fixture();
  try {
    const { owner, target } = seedToolGroup(f);
    const reading = ctxQuery(f, target, 'results');
    expect(reading.state).toBe('available');
    expect(reading.explain_version).toBe(1);
    // 四次调用各自配对：按结果消息序号升序，同名 Bash 两行都在。
    expect(reading.entries.map(entry => entry.tool_name)).toEqual(
      ['Read', 'Bash', 'Read', 'Bash']);
    expect(reading.entries.every(entry => entry.precision === 'located')).toBe(true);
    expect(reading.entries[0]).toMatchObject({
      req_id: target, ord: 1, call_ord: 0, owner_req: owner, role: 'tool',
    });
    expect(reading.entries[0]!.path).toBe('request.messages[1].content[0]');
    expect(reading.next_cursor).toBeNull();
  } finally { f.close(); }
});

test('results 单项按工具名过滤，全部命中保留；无命中返回空目录', () => {
  const f = fixture();
  try {
    const { target } = seedToolGroup(f);
    const bash = ctxQuery(f, target, 'results', { name: 'Bash', tag: 'result' });
    expect(bash.entries.length).toBe(2);
    expect(bash.entries.every(entry => entry.tool_name === 'Bash')).toBe(true);
    const missing = ctxQuery(f, target, 'results', { name: 'Grep' });
    expect(missing.entries).toEqual([]);
    expect(missing.state).toBe('available');
  } finally { f.close(); }
});

test('files 用调用参数核对：路径对齐才标 located，未命中降级 carrier 并说明', () => {
  const f = fixture();
  try {
    const { target } = seedToolGroup(f);
    const hit = ctxQuery(f, target, 'files', { name: 'src/a.ts', tag: 'read' });
    expect(hit.entries.length).toBe(1);
    expect(hit.entries[0]!.precision).toBe('located');
    expect(hit.entries[0]!.path).toBe('request.messages[1].content[0]');
    const miss = ctxQuery(f, target, 'files', { name: 'src/missing.ts', tag: 'read' });
    expect(miss.entries.length).toBe(4);
    expect(miss.entries.every(entry => entry.precision === 'carrier')).toBe(true);
    expect(miss.notes.some(note => note.includes('未找到调用参数'))).toBe(true);
  } finally { f.close(); }
});

test('system 目录含顶层字段与 role=2 承载块，说明片段未分离', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-sys', messages: [{ role: 'user', content: 'sys block text' }],
      system: 'system prompt text',
    });
    // 顶层 system 不产生消息块；把首条消息标成 role=2 验证承载块分支。
    f.store.write(db => db.run('UPDATE request_block SET role=2 WHERE req_id=? AND ord=0', [id]));
    const reading = ctxQuery(f, id, 'system');
    expect(reading.state).toBe('available');
    expect(reading.entries[0]).toMatchObject({ path: 'request.system', ord: null });
    expect(reading.entries[1]).toMatchObject({ ord: 0, precision: 'carrier', role: 'system' });
    expect(reading.notes.some(note => note.includes('未做片段分离'))).toBe(true);
  } finally { f.close(); }
});

test('tools 目录来自骨架字段，单项按定义名精确匹配', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-tools', messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'mcp__ata', description: 'd1', input_schema: {} },
        { name: 'Bash', description: 'd2', input_schema: {} },
      ],
    });
    const all = ctxQuery(f, id, 'tools');
    expect(all.entries.map(entry => entry.path)).toEqual(
      ['request.tools[0]', 'request.tools[1]']);
    expect(all.entries.every(entry => entry.precision === 'located')).toBe(true);
    const one = ctxQuery(f, id, 'tools', { name: 'Bash', tag: 'mcp' });
    expect(one.entries.map(entry => entry.path)).toEqual(['request.tools[1]']);
    const none = ctxQuery(f, id, 'tools', { name: 'Grep' });
    expect(none.entries).toEqual([]);
  } finally { f.close(); }
});

test('chat 与 memory 目录是承载块：按角色取序号，轮次成员对应未建立', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-chat',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: 'q2' },
      ],
    });
    const chat = ctxQuery(f, id, 'chat', { name: '2', tag: 'turn' });
    expect(chat.entries.map(entry => entry.ord)).toEqual([0, 1, 2]);
    expect(chat.entries.every(entry => entry.precision === 'carrier')).toBe(true);
    expect(chat.entries.map(entry => entry.role)).toEqual(['user', 'assistant', 'user']);
    expect(chat.notes.some(note => note.includes('轮次'))).toBe(true);
    const memory = ctxQuery(f, id, 'memory');
    expect(memory.entries.map(entry => entry.ord)).toEqual([0, 2]);
    expect(memory.notes.some(note => note.includes('片段分离'))).toBe(true);
    const skills = ctxQuery(f, id, 'skills');
    expect(skills.entries.map(entry => entry.ord)).toEqual([0, 2]);
  } finally { f.close(); }
});

test('目录分页有界：超限返回继续位置，游标跨类别复用被拒绝', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-page',
      messages: Array.from({ length: 85 }, (_, i) => ({ role: 'user', content: `m${i}` })),
    });
    const first = ctxQuery(f, id, 'chat');
    expect(first.entries.length).toBe(80);
    expect(first.next_cursor).not.toBeNull();
    const second = ctxQuery(f, id, 'chat', { cursor: first.next_cursor });
    expect(second.entries.length).toBe(5);
    expect(second.next_cursor).toBeNull();
    expect(second.entries[0]!.ord).toBe(80);
    // 同一游标拿到 results 类别：绑定不成立。
    const token = getReadingDetail(f.store, id)!.reading_token;
    expect(() => getContextItemReading(f.store, id, {
      kind: 'results', name: null, tag: null, cursor: first.next_cursor,
    }, token)).toThrow();
    // 伪造请求外游标同样拒绝。
    expect(() => getContextItemReading(f.store, id, {
      kind: 'chat', name: null, tag: null,
      cursor: encodeCursor(['ctxitem', id + 999, 'chat', 10]),
    }, token)).toThrow();
  } finally { f.close(); }
});

test('正文缺失与未知类别按事实呈现，不空数组冒充', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-gap', messages: [{ role: 'user', content: 'hi' }],
      bodyState: 'evicted',
    });
    const evicted = ctxQuery(f, id, 'chat');
    expect(evicted.state).toBe('evicted');
    expect(evicted.entries).toEqual([]);
    expect(evicted.reason).toBe('evicted');
    const unknown = ctxQuery(f, id, 'mystery');
    expect(unknown.state).toBe('unsupported');
    expect(unknown.reason).toBe('unknown_kind');
    expect(unknown.notes.length).toBeGreaterThan(0);
  } finally { f.close(); }
});

test('阅读版本变化拒绝旧目录', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-stale', messages: [{ role: 'user', content: 'hi' }],
    });
    const token = getReadingDetail(f.store, id)!.reading_token;
    f.store.write(db => markRequestInputTx(db, id));
    expect(() => getContextItemReading(f.store, id, {
      kind: 'chat', name: null, tag: null, cursor: null,
    }, token)).toThrow(ReadingConflictError);
  } finally { f.close(); }
});

test('端点参数校验：缺阅读版本与缺类别都 400，正常查询带阅读版本', async () => {
  const { loadConfig } = await import('../src/config');
  const { createHandler } = await import('../src/http');
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-ctx-http', messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Bash', description: 'd', input_schema: {} }],
    });
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const call = (path: string) => handler(new Request(`http://127.0.0.1:8320${path}`, {
      headers: { host: '127.0.0.1:8320', authorization: 'Bearer synthetic-read-token' },
    }));
    expect((await call(`/api/requests/${id}/context-item?kind=tools`)).status).toBe(400);
    const token = getReadingDetail(f.store, id)!.reading_token;
    expect((await call(`/api/requests/${id}/context-item?if_reading=${token}`)).status).toBe(400);
    const ok = await call(`/api/requests/${id}/context-item?kind=tools&if_reading=${token}`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { entries: { path: string }[]; explain_version: number };
    expect(body.explain_version).toBe(1);
    expect(body.entries.map(entry => entry.path)).toEqual(['request.tools[0]']);
    expect((await call(`/api/requests/99999/context-item?kind=tools&if_reading=${token}`)).status).toBe(404);
  } finally { f.close(); }
});
