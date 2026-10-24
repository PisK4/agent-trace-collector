import { expect, test } from 'bun:test';
import { projectSteps, renderTraceRows, toolSummary } from '../web/trace-view.js';

const TOKEN = 'r1-' + 'a'.repeat(64);

function row(overrides: Record<string, unknown> = {}): import('../src/queries').RequestRow {
  return ({
    req_id: 7, conv_key: 'k', actor: 'a', agent: null, actor_state: 'known' as const, started_ms: 7,
    title: 't', title_source: null, status: 200, model_requested: null, model_served: 'm',
    in_tok: null, out_tok: null, cache_read: null, cache_write: null, cost: null,
    cost_state: 'absent' as const, have: 7, ms: null, ttft_ms: null, flow_ms: null,
    body_state: 'available' as const, miss_reason: null,
    input_preview: null, input_preview_kind: null, reply_preview: null,
    req_kind: 'chat', chain_role: 'main', model_title: null,
    purpose_status: 'selected', purpose_version: 1, purpose_rule: null,
    purpose_chain: 'participate', derived_state: 'current' as const,
    ...overrides,
  }) as import('../src/queries').RequestRow;
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    req_id: 7, reading_token: TOKEN, prev_relation: 'confirmed', delta_ordinals: [2, 3],
    derived_state: 'current', tool_calls: [], derivation: { chain_state: 'current' },
    ...overrides,
  };
}

function entry(ord: number, input: unknown, isInput: boolean) {
  return { ord, role: 'user', blocks: [], preview: '', input, isInput };
}

type ProjectableRead = Parameters<typeof projectSteps>[1];
function read(detailJson: unknown, entries: unknown[], reply: unknown): ProjectableRead {
  return {
    detail: detailJson, meta: reply === null ? null : { reply, capabilities: null },
    messages: new Map(), entries,
    structure: { open: false, next: 0, total: null, ords: [], selected: null, loading: false, error: null },
    delta: { next: 0, done: false, loading: false, error: null, unconfirmed: false },
    token: TOKEN,
  } as unknown as ProjectableRead;
}

test('投影顺序与稳定键：旧 ord 不进步骤，新增与回复块按协议顺序', () => {
  const r = row();
  const entries = [
    entry(0, { state: 'text', text: 'old', original: 'old' }, true),
    entry(2, { state: 'text', text: 'new question', original: 'new question' }, true),
    entry(3, { state: 'unrecognized', text: '<queued>', original: '<queued>' }, true),
  ];
  const reply = { stop_reason: 'tool_use', content: [
    { type: 'text', text: '先看文件' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'bun test' } },
    { type: 'text', text: '看完再说' },
  ] };
  const d = detail({ tool_calls: [{ call_id: 'c1', ord: 1, tool_name: 'Bash', result_req: 8, result_ord: 0, result_path: 'p', state: 'resolved' }] });
  const steps = projectSteps(r, read(d, entries, reply));
  expect(steps.map(s => s.kind)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant']);
  expect(steps[1]?.unrecognized).toBe(true);
  expect(steps.map(s => s.key)).toEqual([
    '7:message:2', '7:message:3', '7:reply:text:0', '7:call:1', '7:reply:text:2',
  ]);
  expect(steps[3]?.result).toEqual({ state: 'resolved', reqId: 8 });
  // 渲染：每行只有一个选择入口，类型与内容之外不再附加状态、结果链接或箭头。
  const html = renderTraceRows(r, steps, 4, null);
  expect(html.match(/data-request-ordinal="4"/g)?.length).toBe(5);
  expect(html.match(/<button /g)?.length).toBe(5);
  expect(html).not.toMatch(/compact-metrics|step-status|step-result-link|step-expand/);
  expect(html).not.toContain('<time');
  const selected = renderTraceRows(r, steps, 4, '7:call:1');
  expect(selected).toContain('data-step-key="7:call:1" data-kind="tool" data-call-ord="1" aria-current="true"');
});

test('读取未完成与不可用时不拆 input_preview 为用户步骤', () => {
  const r = row({ input_preview: '折叠摘要' });
  const steps = projectSteps(r, null);
  expect(steps.length).toBe(1);
  expect(steps[0]?.kind).toBe('record');
  expect(steps[0]?.text).not.toContain('折叠摘要');
  const unsupported = projectSteps(row({ body_state: 'unsupported' }), null);
  expect(unsupported[0]?.status).toBe('missing_body');
});

test('注入与空 content 不是用户；tool_result 消息不进轨迹', () => {
  const d = detail({ delta_ordinals: [2, 3] });
  const entries = [
    entry(2, { state: 'text', text: '<img src=x onerror=alert(1)>', original: '<img src=x onerror=alert(1)>' }, true),
    entry(3, null, false),
  ];
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  const steps = projectSteps(row(), read(d, entries, reply));
  expect(steps.map(s => s.kind)).toEqual(['user', 'assistant']);
  const html = renderTraceRows(row(), steps, 1, null);
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;img src=x');
});

test('dirty、branch、unknown 没有确定用户步骤', () => {
  const cases = [
    detail({ derived_state: 'dirty', derivation: { chain_state: 'unavailable' }, delta_ordinals: [2] }),
    detail({ prev_relation: 'unknown', delta_ordinals: [2] }),
    detail({ prev_relation: 'branch', delta_ordinals: [2] }),
    detail({ delta_ordinals: null }),
  ];
  for (const d of cases) {
    const steps = projectSteps(row(), read(d, [], { stop_reason: 'end_turn', content: [{ type: 'text', text: 'r' }] }));
    expect(steps.some(s => s.kind === 'user')).toBe(false);
    expect(steps.some(s => s.kind === 'record')).toBe(true);
  }
  // branch 保留归属标记。
  const branch = projectSteps(row({ chain_role: 'branch' }), read(cases[2]!, [], { stop_reason: 'end_turn', content: [] }));
  expect(branch.some(s => s.text.includes('分支链请求'))).toBe(true);
});

test('辅助请求只有一条辅助记录；同 call_id 不同请求的键不冲突', () => {
  const aux = projectSteps(row({ purpose_chain: 'exclude', req_kind: 'title' }), null);
  expect(aux.length).toBe(1);
  expect(aux[0]?.kind).toBe('aux');
  const tool = { call_id: 'same', ord: 0, tool_name: 'x', result_req: 9, result_ord: 0, result_path: 'p', state: 'resolved' };
  const a = projectSteps(row({ req_id: 7 }), read(detail({ req_id: 7, tool_calls: [tool] }), [], { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'same', name: 'x', input: {} }] }));
  const b = projectSteps(row({ req_id: 9 }), read(detail({ req_id: 9, tool_calls: [tool] }), [], { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'same', name: 'x', input: {} }] }));
  expect(a[0]?.key).toBe('7:call:0');
  expect(b[0]?.key).toBe('9:call:0');
});

test('回复完整性：截断、未知停止、未收到与纯工具回复', () => {
  const chatLength = projectSteps(row(), read(detail(), [], { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'x' } }] }));
  expect(chatLength.some(s => s.status === 'truncated')).toBe(true);
  const anthropicMax = projectSteps(row(), read(detail(), [], { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'x' }] }));
  expect(anthropicMax.some(s => s.status === 'truncated')).toBe(true);
  // 请求行仍成功：HTTP 状态不在截断记录上叠加失败。
  expect(chatLength.some(s => s.status === 'failed')).toBe(false);
  const normal = projectSteps(row(), read(detail(), [], { stop_reason: 'stop', content: [{ type: 'text', text: 'x' }] }));
  expect(normal.some(s => s.status === 'truncated')).toBe(false);
  const unknown = projectSteps(row(), read(detail(), [], { stop_reason: 'weird_stop', content: [{ type: 'text', text: 'x' }] }));
  expect(unknown.some(s => s.status === 'unknown')).toBe(true);
  expect(unknown.find(s => s.status === 'unknown')?.text).toContain('weird_stop');
  const absent = projectSteps(row(), read(detail(), [], null));
  expect(absent.some(s => s.status === 'missing_reply')).toBe(true);
  // 纯工具回复：没有助手文本步骤，工具步骤在。
  const toolOnly = projectSteps(row(), read(detail({ tool_calls: [{ call_id: 'c', ord: 0, tool_name: 'x', result_req: null, result_ord: null, result_path: null, state: 'pending' }] }), [], { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'x', input: {} }] }));
  expect(toolOnly.some(s => s.kind === 'assistant')).toBe(false);
  expect(toolOnly.find(s => s.kind === 'tool')?.result).toEqual({ state: 'pending', reqId: null });
});

test('HTTP 失败、缺正文与已有步骤并存', () => {
  const entries = [entry(2, { state: 'text', text: 'q', original: 'q' }, true)];
  const r = row({ status: 500 });
  const steps = projectSteps(r, read(detail(), entries, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'partial reply kept' }] }));
  expect(steps.some(s => s.kind === 'user')).toBe(true);
  const failed = steps.find(s => s.status === 'failed');
  expect(failed?.text).toContain('HTTP 500');
  const html = renderTraceRows(r, steps, 1, null);
  expect(html.match(/请求失败 · HTTP 500/g)?.length).toBe(1);
  expect(html).not.toContain('step-status');
  const missingBody = projectSteps(row({ body_state: 'evicted' }), read(detail(), entries, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'r' }] }));
  expect(missingBody.some(s => s.status === 'missing_body')).toBe(true);
});

test('工具摘要只给动作对象，不含结果正文', () => {
  expect(toolSummary('Bash', '{"command":"bun test x.ts"}')).toBe('Bash · bun test x.ts');
  expect(toolSummary('read_file', '{"file_path":"src/a.ts"}')).toBe('read_file · src/a.ts');
  expect(toolSummary('x', 'not json')).toBe('x · not json');
  expect(toolSummary('', '{"path":"p"}')).toBe('未命名工具 · p');
  const long = toolSummary('Bash', JSON.stringify({ command: 'a'.repeat(500) }));
  expect(long.length).toBeLessThan(200);
});

test('多 choice 回复保留原始对象并说明限制', () => {
  const reply = { choices: [
    { finish_reason: 'stop', message: { role: 'assistant', content: 'a' } },
    { finish_reason: 'stop', message: { role: 'assistant', content: 'b' } },
  ] };
  const steps = projectSteps(row(), read(detail(), [], reply));
  expect(steps.some(s => s.kind === 'assistant')).toBe(false);
  expect(steps.some(s => s.text.includes('多 choice'))).toBe(true);
});
