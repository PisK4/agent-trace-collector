import { expect, test } from 'bun:test';
import { toolTint } from '../web/body-view.js';
import { resolveSelectedSource } from '../web/rail-facts.js';
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
    delta: { next: 0, done: true, loading: false, error: null, unconfirmed: false },
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

test('注入与空 content 不是用户', () => {
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

test('System 步骤：顶层独立来源键，消息级带原路径，输入总数不变', () => {
  const d = detail({ delta_ordinals: [1] });
  const sysEntry = {
    ord: 1, role: 'system', rawRole: 'system',
    blocks: [{ kind: 'text', text: 'be nice', index: 0, raw: 'be nice', path: 'content' }],
    preview: 'be nice', input: null, isInput: false,
  };
  const steps = projectSteps(row(), read(d, [sysEntry], { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'x', input: {} }] }),
    { text: 'base', changed: null });
  const topLevel = steps.find(s => s.key === '7:system');
  expect(topLevel?.kind).toBe('system');
  expect(topLevel?.source).toEqual({ side: 'request', path: 'request.system', messageOrd: null, blockIndex: null });
  const msgSys = steps.find(s => s.kind === 'system' && s.messageOrd === 1);
  expect(msgSys?.key).toBe('7:message:1');
  expect(msgSys?.source).toEqual({ side: 'request', path: 'request.messages[1]', messageOrd: 1, blockIndex: null });
  // ord1 是 System 消息，不是用户输入；输入总数不含它。
  expect(steps.some(s => s.kind === 'user')).toBe(false);
  // 渲染：System 英文标签一行摘要，全文放右栏。
  const html = renderTraceRows(row(), steps, 1, null);
  expect(html).toContain('>System<');
  expect(html).toContain('be nice');
});

test('System 上下文：同值不重复，变化标明，不可比只声明当前', () => {
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  const base = read(detail(), [], reply);
  const same = projectSteps(row(), base, { text: 'base', changed: false });
  expect(same.some(s => s.kind === 'system')).toBe(false);
  const changed = projectSteps(row(), base, { text: 'base v2', changed: true });
  const changedStep = changed.find(s => s.kind === 'system');
  expect(changedStep?.text).toContain('与已确认前驱不同');
  const current = projectSteps(row(), base, { text: 'base', changed: null });
  const currentStep = current.find(s => s.kind === 'system');
  expect(currentStep?.text).toBe('base');
  expect(currentStep?.text).not.toContain('不同');
  // 没有可读 system（request_fields 缺失）时不给步骤，也不伪造。
  expect(projectSteps(row(), base, null).some(s => s.kind === 'system')).toBe(false);
});

test('混合消息按块出步骤：结果带内容块路径，用户文本只出一次', () => {
  const d = detail({ delta_ordinals: [2] });
  const mixed = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [
      { kind: 'result', text: 'file body', index: 0, raw: { type: 'tool_result' }, path: 'content[0]' },
      { kind: 'text', text: '继续', index: 1, raw: '继续', path: 'content[1]' },
    ],
    preview: 'file body',
    input: { state: 'text', text: '继续', original: '继续' },
    isInput: true,
  };
  const steps = projectSteps(row(), read(d, [mixed], { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  const result = steps.find(s => s.kind === 'tool_result');
  expect(result?.key).toBe('7:message:2:result:0');
  expect(result?.source).toEqual({ side: 'request', path: 'request.messages[2].content[0]', messageOrd: 2, blockIndex: 0 });
  const users = steps.filter(s => s.kind === 'user');
  expect(users.length).toBe(1);
  expect(users[0]?.key).toBe('7:message:2');
  expect(users[0]?.source).toEqual({ side: 'request', path: 'request.messages[2]', messageOrd: 2, blockIndex: null });
});

test('结果步骤反向配对：Anthropic 按内容块路径，Chat 按整条消息', () => {
  const indexed = [{ call_id: 'c1', ord: 1, tool_name: 'read', owner_req: 3, result_req: 7,
    result_ord: 2, result_path: 'request.messages[2].content[0]', state: 'resolved' }];
  const anthropicEntry = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'file body', index: 0, raw: { type: 'tool_result' }, path: 'content[0]' }],
    preview: 'file body', input: null, isInput: false,
  };
  const steps = projectSteps(row(), read(detail({ delta_ordinals: [2], tool_results: indexed }), [anthropicEntry],
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  const result = steps.find(s => s.kind === 'tool_result');
  expect(result?.source).toEqual({ side: 'request', path: 'request.messages[2].content[0]', messageOrd: 2, blockIndex: 0 });
  expect(result?.pairOwner).toEqual({ reqId: 3, callOrd: 1 });
  // Chat 的 role=tool 结果配对到整条消息，与后端 result_path 一致。
  const chatEntry = {
    ord: 2, role: 'tool', rawRole: 'tool',
    blocks: [{ kind: 'result', text: 'chat output', index: 0, raw: 'chat output', path: 'content' }],
    preview: 'chat output', input: null, isInput: false,
  };
  const chatIndexed = [{ call_id: 'c2', ord: 0, tool_name: 'bash', owner_req: 4, result_req: 7,
    result_ord: 2, result_path: 'request.messages[2]', state: 'resolved' }];
  const chat = projectSteps(row(), read(detail({ delta_ordinals: [2], tool_results: chatIndexed }), [chatEntry],
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  expect(chat.find(s => s.kind === 'tool_result')?.source).toEqual({
    side: 'request', path: 'request.messages[2]', messageOrd: 2, blockIndex: 0,
  });
  expect(chat.find(s => s.kind === 'tool_result')?.pairOwner).toEqual({ reqId: 4, callOrd: 0 });
  // 路径或状态不匹配（dirty 清空、同消息另一块）：pairOwner 为 null，点击回正文定位。
  const mismatched = projectSteps(row(), read(detail({ delta_ordinals: [2], tool_results: [] }), [anthropicEntry],
    { stop_reason: 'end_turn', content: [] }));
  expect(mismatched.find(s => s.kind === 'tool_result')?.pairOwner).toBeNull();
});

test('选中来源解析：调用与已配对结果都解析成配对目标', () => {
  const callStep = { kind: 'tool', source: { side: 'reply', path: 'reply.content[1]', messageOrd: null, blockIndex: 1 }, callOrd: 1, reqId: 7, pairOwner: null };
  expect(resolveSelectedSource(callStep as never)).toEqual({
    side: 'reply', target: 'call', path: 'reply.content[1]', callOrd: 1, ownerReq: 7,
  });
  const pairedResult = { kind: 'tool_result', source: { side: 'request', path: 'request.messages[2].content[0]', messageOrd: 2, blockIndex: 0 }, pairOwner: { reqId: 3, callOrd: 1 }, reqId: 7 };
  expect(resolveSelectedSource(pairedResult as never)).toEqual({ side: 'pair', ownerReq: 3, callOrd: 1 });
  const plainResult = { kind: 'tool_result', source: { side: 'request', path: 'request.messages[2].content[0]', messageOrd: 2, blockIndex: 0 }, pairOwner: null, reqId: 7 };
  expect(resolveSelectedSource(plainResult as never)).toEqual({
    side: 'request', target: 'message', path: 'request.messages[2].content[0]', messageOrd: 2,
  });
});

test('回复来源是实际协议路径：Anthropic content[i]，Chat tool_calls[i]', () => {
  const anthropic = projectSteps(row(), read(detail(), [], { stop_reason: 'tool_use', content: [
    { type: 'text', text: '先看' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: {} },
  ] }));
  expect(anthropic.find(s => s.kind === 'assistant')?.source).toEqual({
    side: 'reply', path: 'reply.content[0]', messageOrd: null, blockIndex: 0,
  });
  expect(anthropic.find(s => s.kind === 'tool')?.source).toEqual({
    side: 'reply', path: 'reply.content[1]', messageOrd: null, blockIndex: 1,
  });
  const chat = projectSteps(row(), read(detail(), [], { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }],
  } }] }));
  expect(chat.find(s => s.kind === 'tool')?.source).toEqual({
    side: 'reply', path: 'reply.choices[0].message.tool_calls[0]', messageOrd: null, blockIndex: 0,
  });
  // 记录与辅助步骤不落在协议对象上，点击打开请求读数。
  const aux = projectSteps(row({ purpose_chain: 'exclude', req_kind: 'title' }), null);
  expect(aux[0]?.source).toBeNull();
  const record = projectSteps(row(), null);
  expect(record[0]?.source).toBeNull();
});

test('工具行上屏：chip 承载工具身份，未配对结果保持中性 Tool result', () => {
  const d = detail({ delta_ordinals: [2] });
  const mixed = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'file body', index: 0, raw: {}, path: 'content[0]' }],
    preview: 'file body', input: null, isInput: false,
  };
  const steps = projectSteps(row(), read(d, [mixed], { stop_reason: 'tool_use', content: [
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls', description: '列目录' } },
  ] }));
  const html = renderTraceRows(row(), steps, 3, null);
  expect(html).toContain('>Assistant<');
  expect(html).toContain('>Tool<');
  // 调用行：工具名 chip 带色类，参数段不再重复工具名。
  expect(html).toContain('row-tint tint-bash">Bash</span>');
  expect(html).toContain('<code>列目录</code>');
  // 未配对结果行：中性 chip 沿用现状文案。
  expect(html).toContain('row-tint tint-other">Tool result</span>');
  expect(html).not.toContain('row-kind');
  expect(html).not.toContain('Tool call');
  expect(html).not.toContain('用户');
  expect(html).not.toContain('工具<');
});

test('结果行前缀三级：缓存内同款摘要、缓存外只工具名、未配对中性', () => {
  const d = detail({ delta_ordinals: [2], tool_results: [
    { call_id: 'c1', ord: 1, tool_name: 'Read', owner_req: 3, result_req: 7,
      result_ord: 2, result_path: 'request.messages[2].content[0]', state: 'resolved' },
  ] });
  const carrier = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: '文件正文', index: 0, raw: {}, path: 'content[0]' }],
    preview: '文件正文', input: null, isInput: false,
  };
  const steps = projectSteps(row(), read(d, [carrier], { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  const callOf = (ownerReq: number, callOrd: number) => {
    expect(ownerReq).toBe(3);
    expect(callOrd).toBe(1);
    return { name: 'Read', inputText: JSON.stringify({ file_path: '/u/src/q.ts', offset: 1400, limit: 130 }) };
  };
  const cached = renderTraceRows(row(), steps, 1, null, callOf);
  // 一级：chip 与调用行同款摘要（工具名 · 参数段），正文以 muted 箭头跟随。
  expect(cached).toContain('row-tint tint-read">Read · q.ts · 1400–1530 行</span>');
  expect(cached).toContain('row-arrow');
  expect(cached).toContain('文件正文');
  // 二级：装配层查不到调用方（返回 null）时只显示工具名，仍带工具色。
  const outside = renderTraceRows(row(), steps, 1, null,
    () => null);
  expect(outside).toContain('row-tint tint-read">Read</span>');
  expect(outside).not.toContain('row-arrow');
  // 三级：未配对（pairOwner 为 null）中性 chip，不猜归属。
  const unpairedSteps = projectSteps(row(), read(detail({ delta_ordinals: [2] }), [carrier],
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  const unpaired = renderTraceRows(row(), unpairedSteps, 1, null, callOf);
  expect(unpaired).toContain('row-tint tint-other">Tool result</span>');
  // 结果行悬停给完整结果正文。
  expect(cached).toContain('title="文件正文"');
});

test('调用行悬停放完整参数 JSON，预览只放参数段', () => {
  const steps = projectSteps(row(), read(detail(), [], { stop_reason: 'tool_use', content: [
    { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/u/very/long/path/queries.ts', offset: 1, limit: 5 } },
  ] }));
  const html = renderTraceRows(row(), steps, 1, null);
  expect(html).toContain('title="{&quot;file_path&quot;:&quot;/u/very/long/path/queries.ts&quot;,&quot;offset&quot;:1,&quot;limit&quot;:5}"');
  expect(html).toContain('<code>queries.ts · 1–6 行</code>');
});

test('is_error=true 的结果行带异常态，正常行没有', () => {
  const failedBlock = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'boom', index: 0, raw: { is_error: true }, path: 'content[0]', failed: true }],
    preview: 'boom', input: null, isInput: false,
  };
  const okBlock = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'fine', index: 0, raw: { is_error: false }, path: 'content[0]', failed: false }],
    preview: 'fine', input: null, isInput: false,
  };
  const failedSteps = projectSteps(row(), read(detail({ delta_ordinals: [2] }), [failedBlock],
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  expect(failedSteps.find(s => s.kind === 'tool_result')?.isError).toBe(true);
  expect(renderTraceRows(row(), failedSteps, 1, null)).toContain('compact-row step-error');
  const okSteps = projectSteps(row(), read(detail({ delta_ordinals: [2] }), [okBlock],
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  expect(okSteps.find(s => s.kind === 'tool_result')?.isError).toBe(false);
  expect(renderTraceRows(row(), okSteps, 1, null)).not.toContain('step-error');
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

test('工具摘要按工具分派：Read 行区间四种组合', () => {
  expect(toolSummary('Read', JSON.stringify({ file_path: '/Users/pis/src/queries.ts', offset: 1400, limit: 130 })))
    .toBe('Read · queries.ts · 1400–1530 行');
  expect(toolSummary('Read', JSON.stringify({ file_path: '/a/b.ts', limit: 130 })))
    .toBe('Read · b.ts · 前 130 行');
  expect(toolSummary('Read', JSON.stringify({ file_path: '/a/b.ts', offset: 1400 })))
    .toBe('Read · b.ts · 1400 行起');
  expect(toolSummary('Read', JSON.stringify({ file_path: '/a/b.ts' })))
    .toBe('Read · b.ts');
  // file_path 缺核心键：回退链，不冒充文件摘要。
  expect(toolSummary('Read', '{"pattern":"x"}')).toBe('Read · x');
});

test('工具摘要按工具分派：Edit、Write、Bash', () => {
  expect(toolSummary('Edit', JSON.stringify({ file_path: 'src/derive.ts', old_string: 'a\nb\nc', new_string: 'x' })))
    .toBe('Edit · derive.ts · 3→1 行');
  expect(toolSummary('Edit', JSON.stringify({ file_path: 'src/derive.ts', old_string: 'a', new_string: 'b', replace_all: true })))
    .toBe('Edit · derive.ts · 1→1 行 · 全部替换');
  expect(toolSummary('Write', JSON.stringify({ file_path: 'docs/memory.md', content: 'x'.repeat(1229) })))
    .toBe('Write · memory.md · 1.2 KB');
  expect(toolSummary('Write', JSON.stringify({ file_path: 'a.md', content: '小' })))
    .toBe('Write · a.md · 3 B');
  expect(toolSummary('Bash', JSON.stringify({ command: 'bun test', description: '重跑全量测试' })))
    .toBe('Bash · 重跑全量测试');
  // 无 description 回落命令首个非空行；omp 的小写 bash 同一格式。
  expect(toolSummary('bash', JSON.stringify({ command: '\n  bun run maintain \nnext' })))
    .toBe('bash · bun run maintain');
});

test('工具摘要按工具分派：Skill、Agent、协作与查询工具', () => {
  expect(toolSummary('Skill', JSON.stringify({ skill: 'ponytail', args: '打开本地页面截图' })))
    .toBe('Skill · ponytail · 打开本地页面截图');
  expect(toolSummary('Skill', '{"skill":"ponytail"}')).toBe('Skill · ponytail');
  expect(toolSummary('Agent', JSON.stringify({ subagent_type: 'general-purpose', description: '核对派生方案' })))
    .toBe('Agent · general-purpose · 核对派生方案');
  expect(toolSummary('SendMessage', JSON.stringify({ summary: '收束结论', to: 'agent_ab12cd34ef56' })))
    .toBe('SendMessage · 收束结论 → agent_ab');
  expect(toolSummary('SubagentHandback', JSON.stringify({ message: '首行内容\n第二行' })))
    .toBe('SubagentHandback · 首行内容');
  expect(toolSummary('WebFetch', JSON.stringify({ url: 'https://github.com/owner/repo/issues' })))
    .toBe('WebFetch · github.com/owner/repo/issues');
  expect(toolSummary('ToolSearch', JSON.stringify({ query: 'select:SendMessage' })))
    .toBe('ToolSearch · select:SendMessage');
});

test('工具摘要回退：非 JSON 参数原文、未知工具回退链、截断只作用参数段', () => {
  expect(toolSummary('mcp__srv__do', 'not json')).toBe('mcp__srv__do · not json');
  expect(toolSummary('x', '{"command":"ls","cmd":"fallback-cmd"}')).toBe('x · ls');
  expect(toolSummary('x', '{"file_path":"src/a.ts"}')).toBe('x · a.ts');
  expect(toolSummary('x', '{"path":"lib/b.py"}')).toBe('x · b.py');
  expect(toolSummary('', '{"path":"p"}')).toBe('未命名工具 · p');
  const long = toolSummary('Read', JSON.stringify({ file_path: '/a/'.concat('b'.repeat(300), '.ts') }));
  expect(long.startsWith('Read · ')).toBe(true);
  expect([...long].length).toBeLessThan(160);
  expect(long.endsWith('…')).toBe(true);
});

test('工具身份色类：六个核心工具各一色，其余统一中性', () => {
  expect(toolTint('Read')).toBe('tint-read');
  expect(toolTint('Edit')).toBe('tint-edit');
  expect(toolTint('Write')).toBe('tint-write');
  expect(toolTint('Bash')).toBe('tint-bash');
  expect(toolTint('bash')).toBe('tint-bash');
  expect(toolTint('Skill')).toBe('tint-skill');
  expect(toolTint('Agent')).toBe('tint-agent');
  expect(toolTint('SendMessage')).toBe('tint-other');
  expect(toolTint('mcp__server__method')).toBe('tint-other');
  expect(toolTint('')).toBe('tint-other');
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

test('选中来源解析：回复四块各自定位，两个文本不再共享整份回复', () => {
  const reply = { stop_reason: 'tool_use', content: [
    { type: 'text', text: 't0' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: {} },
    { type: 'text', text: 't2' },
    { type: 'tool_use', id: 'c3', name: 'Read', input: {} },
  ] };
  const steps = projectSteps(row(), read(detail(), [], reply));
  expect(steps.map(s => s.key)).toEqual(['7:reply:text:0', '7:call:1', '7:reply:text:2', '7:call:3']);
  expect(resolveSelectedSource(steps[0] ?? null)).toEqual({
    side: 'reply', target: 'text', path: 'reply.content[0]', blockIndex: 0, text: 't0',
  });
  expect(resolveSelectedSource(steps[1] ?? null)).toEqual({
    side: 'reply', target: 'call', path: 'reply.content[1]', callOrd: 1, ownerReq: 7,
  });
  expect(resolveSelectedSource(steps[2] ?? null)).toMatchObject({ path: 'reply.content[2]', blockIndex: 2, text: 't2' });
  expect(resolveSelectedSource(steps[3] ?? null)).toMatchObject({ path: 'reply.content[3]', callOrd: 3 });
  // 无选择回到整份回复；请求级记录不落在协议对象上。
  expect(resolveSelectedSource(null)).toEqual({ side: 'none' });
  const record = projectSteps(row(), null);
  expect(resolveSelectedSource(record[0] ?? null)).toEqual({ side: 'none' });
});

test('选中来源解析：输入消息、顶层 System 与未知块', () => {
  const d = detail({ delta_ordinals: [2] });
  const user = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'text', text: 'q', index: 0, raw: 'q', path: 'content[0]' }],
    preview: 'q', input: { state: 'text', text: 'q', original: 'q' }, isInput: true,
  };
  const steps = projectSteps(row(), read(d, [user], { stop_reason: 'end_turn', content: [{ type: 'mystery', x: 1 }] }));
  expect(resolveSelectedSource(steps.find(s => s.kind === 'user') ?? null)).toEqual({
    side: 'request', target: 'message', path: 'request.messages[2]', messageOrd: 2,
  });
  const unknown = steps.find(s => s.key === '7:reply:block:0');
  expect(resolveSelectedSource(unknown ?? null)).toEqual({
    side: 'reply', target: 'block', path: 'reply.content[0]', blockIndex: 0, raw: unknown?.raw,
  });
  const sysRead = read(d, [], { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  (sysRead as { meta: Record<string, unknown> }).meta = {
    reply: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    request_fields: { system: 'base' }, capabilities: null,
  };
  const sysSteps = projectSteps(row(), sysRead, { text: 'base', changed: null });
  expect(resolveSelectedSource(sysSteps.find(s => s.key === '7:system') ?? null)).toEqual({
    side: 'request', target: 'system', path: 'request.system', text: 'base',
  });
});

test('截图形状：Skill 调用定位本笔回复，结果步骤不按时间跳下一笔', () => {
  // 请求 A：输入两条，回复含 Skill(ponytail)。
  const rowA = row({ req_id: 108 });
  const dA = detail({ req_id: 108, delta_ordinals: [0, 1], tool_calls: [
    { call_id: 'p', ord: 0, tool_name: 'Skill', result_req: 110, result_ord: 0, result_path: 'request.messages[2].content[0]', state: 'resolved' },
  ] });
  const userA = (ord: number) => ({
    ord, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'text', text: `q${ord}`, index: 0, raw: `q${ord}`, path: 'content[0]' }],
    preview: `q${ord}`, input: { state: 'text', text: `q${ord}`, original: `q${ord}` }, isInput: true,
  });
  const stepsA = projectSteps(rowA, read(dA, [userA(0), userA(1)],
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'p', name: 'Skill', input: {} }] }));
  expect(stepsA.filter(s => s.kind === 'user')).toHaveLength(2);
  expect(resolveSelectedSource(stepsA.find(s => s.kind === 'tool') ?? null)).toMatchObject({
    side: 'reply', target: 'call', path: 'reply.content[0]', callOrd: 0,
  });
  // 请求 B：输入四条（两条用户文本、一条工具结果、再一条用户文本），回复含 Skill(memmy)。
  const rowB = row({ req_id: 110 });
  const dB = detail({ req_id: 110, delta_ordinals: [2, 3, 4, 5] });
  const resultMsg = {
    ord: 4, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'res', index: 0, raw: {}, path: 'content[0]' }],
    preview: 'res', input: null, isInput: false,
  };
  const stepsB = projectSteps(rowB, read(dB, [userA(2), userA(3), resultMsg, userA(5)],
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'm', name: 'Skill', input: {} }] }));
  expect(stepsB.filter(s => s.kind === 'user')).toHaveLength(3);
  expect(resolveSelectedSource(stepsB.find(s => s.kind === 'tool') ?? null)).toMatchObject({
    side: 'reply', target: 'call', path: 'reply.content[0]', callOrd: 0,
  });
  // 工具结果步骤定位在 B 自己的消息块，不跳去下一笔辅助请求。
  const result = stepsB.find(s => s.kind === 'tool_result');
  expect(result?.source).toMatchObject({ side: 'request', path: 'request.messages[4].content[0]', messageOrd: 4 });
});

test('增量未完成或失败出现事件记录，完成时不出现', () => {
  const base = read(detail({ delta_ordinals: [0, 1, 2] }), [], { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  const pending = { ...base, delta: { next: 2, done: false, loading: false, error: null, unconfirmed: false } };
  const pendingSteps = projectSteps(row(), pending as ProjectableRead);
  const event = pendingSteps.find(s => s.key === '7:delta');
  expect(event?.kind).toBe('record');
  expect(event?.text).toContain('还有 1 条新增未读取');
  expect(event?.source).toBeNull();
  const failed = { ...base, delta: { next: 0, done: false, loading: false, error: 'delta_gap', unconfirmed: false } };
  expect(projectSteps(row(), failed as ProjectableRead).find(s => s.key === '7:delta')?.text).toContain('新增读取失败');
  expect(projectSteps(row(), failed as ProjectableRead).find(s => s.key === '7:delta')?.status).toBe('unknown');
  const done = { ...base, delta: { next: 3, done: true, loading: false, error: null, unconfirmed: false } };
  expect(projectSteps(row(), done as ProjectableRead).some(s => s.key === '7:delta')).toBe(false);
});
