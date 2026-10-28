import { expect, test } from 'bun:test';
import { toolTint } from '../web/body-view.js';
import { resolveSelectedSource } from '../web/rail-facts.js';
import { projectSteps, projectTailReply, renderTraceRows, tailEligibleIds, toolSummary } from '../web/trace-view.js';

const TOKEN = 'r1-' + 'a'.repeat(64);

function row(overrides: Record<string, unknown> = {}): import('../src/queries/projection').RequestRow {
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
  }) as import('../src/queries/projection').RequestRow;
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

/** 承载 delta 里的 assistant 消息：块与 body-model 归一化后的形状一致。 */
function assistantEntry(ord: number, blocks: Record<string, unknown>[]) {
  return { ord, role: 'assistant', rawRole: 'assistant', blocks, preview: '', input: null, isInput: false };
}

type ProjectableRead = Parameters<typeof projectSteps>[1];
function read(detailJson: unknown, entries: unknown[], reply: unknown): ProjectableRead {
  return {
    status: 'fresh', detailError: null,
    detail: detailJson, meta: reply === null ? null : { reply, capabilities: null },
    messages: new Map(), entries,
    structure: { open: false, next: 0, total: null, ords: [], selected: null, loading: false, error: null },
    delta: { next: 0, done: true, loading: false, error: null, unconfirmed: false },
    token: TOKEN,
  } as unknown as ProjectableRead;
}

/** 缺口快照：记录存在但没有详情，status 区分作废与失败。 */
function gapRead(status: 'invalidated' | 'failed', detailError: string | null = null): ProjectableRead {
  return {
    status, detailError,
    detail: null, meta: null, messages: new Map(), entries: [],
    structure: { next: 0, total: null, ords: [], loading: false, error: null },
    delta: { next: 0, done: true, loading: false, error: null, unconfirmed: false },
    token: null,
  } as unknown as ProjectableRead;
}

test('投影顺序与稳定键：旧 ord 不进步骤，承载 delta 的消息逐块出行', () => {
  const r = row();
  const entries = [
    entry(0, { state: 'text', text: 'old', original: 'old' }, true),
    entry(2, { state: 'text', text: 'new question', original: 'new question' }, true),
    entry(3, { state: 'unrecognized', text: '<queued>', original: '<queued>' }, true),
    assistantEntry(4, [
      { kind: 'text', text: '先看文件', index: 0, raw: '先看文件', path: 'content[0]' },
      { kind: 'call', text: 'Bash({"command":"bun test"})', index: 1, raw: { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'bun test' } }, path: 'content[1]' },
      { kind: 'text', text: '看完再说', index: 2, raw: '看完再说', path: 'content[2]' },
    ]),
  ];
  const reply = { stop_reason: 'tool_use', content: [
    { type: 'text', text: '先看文件' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'bun test' } },
    { type: 'text', text: '看完再说' },
  ] };
  const d = detail({ delta_ordinals: [2, 3, 4] });
  const steps = projectSteps(r, read(d, entries, reply));
  // 承载组的回复不出内容行；delta 里的 assistant 消息按文本与调用各出一行。
  expect(steps.map(s => s.kind)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant']);
  expect(steps[1]?.unrecognized).toBe(true);
  expect(steps.map(s => s.key)).toEqual([
    '7:message:2', '7:message:3', '7:message:4:text:0', '7:message:4:call:1', '7:message:4:text:2',
  ]);
  expect(steps[4]?.source).toEqual({ side: 'request', path: 'request.messages[4].content[2]', messageOrd: 4, blockIndex: 2 });
  // 渲染：每行只有一个选择入口，类型与内容之外不再附加状态、结果链接或箭头。
  const html = renderTraceRows(r, steps, 4, null);
  expect(html.match(/data-request-ordinal="4"/g)?.length).toBe(5);
  expect(html.match(/<button /g)?.length).toBe(5);
  expect(html).not.toMatch(/compact-metrics|step-status|step-result-link|step-expand/);
  expect(html).not.toContain('<time');
  const selected = renderTraceRows(r, steps, 4, '7:message:4:call:1');
  expect(selected).toContain('data-step-key="7:message:4:call:1" data-kind="tool" aria-current="true"');
  // 末尾回复投影不进入承载组：同一回复由 projectTailReply 单独给出，键沿用 reply:*。
  const tail = projectTailReply(r, read(d, entries, reply));
  expect(tail.eligible).toBe(true);
  expect(tail.steps.map(s => s.key)).toEqual(['7:reply:text:0', '7:call:1', '7:reply:text:2']);
  expect(projectTailReply(r, read(d, entries, null))).toEqual({ steps: [], eligible: false });
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

test('读取作废与读取失败文案如实区分，不冒充读取中', () => {
  const loading = projectSteps(row(), null);
  expect(loading[0]?.text).toBe('读取中');
  const invalidated = projectSteps(row(), gapRead('invalidated'));
  expect(invalidated[0]?.text).toBe('阅读版本已变化 · 自动重读中，点击立即重读');
  const failed = projectSteps(row(), gapRead('failed', 'http_503'));
  expect(failed[0]?.text).toBe('详情读取失败 · http_503');
  // 三种态共用同一条记录步骤身份：点击行仍走普通读取。
  expect(loading[0]?.key).toBe('7:loading');
  expect(invalidated[0]?.key).toBe('7:loading');
  expect(failed[0]?.key).toBe('7:loading');
});

test('注入与空 content 不是用户', () => {
  const d = detail({ delta_ordinals: [2, 3] });
  const entries = [
    entry(2, { state: 'text', text: '<img src=x onerror=alert(1)>', original: '<img src=x onerror=alert(1)>' }, true),
    entry(3, null, false),
  ];
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  const steps = projectSteps(row(), read(d, entries, reply));
  expect(steps.map(s => s.kind)).toEqual(['user']);
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

test('消息来源是实际协议路径：Anthropic content[i]，Chat tool_calls[i]；末尾回复从回复根算', () => {
  const anthropic = projectSteps(row(), read(detail({ delta_ordinals: [4] }), [
    assistantEntry(4, [
      { kind: 'text', text: '先看', index: 0, raw: '先看', path: 'content[0]' },
      { kind: 'call', text: 'Bash({})', index: 1, raw: { type: 'tool_use', id: 'c1', name: 'Bash', input: {} }, path: 'content[1]' },
    ]),
  ], null));
  expect(anthropic.find(s => s.kind === 'assistant')?.source).toEqual({
    side: 'request', path: 'request.messages[4].content[0]', messageOrd: 4, blockIndex: 0,
  });
  expect(anthropic.find(s => s.kind === 'tool')?.source).toEqual({
    side: 'request', path: 'request.messages[4].content[1]', messageOrd: 4, blockIndex: 1,
  });
  const chat = projectSteps(row(), read(detail({ delta_ordinals: [4] }), [
    assistantEntry(4, [
      { kind: 'call', text: 'read({})', index: 0, raw: { id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }, path: 'tool_calls[0]' },
    ]),
  ], null));
  expect(chat.find(s => s.kind === 'tool')?.source).toEqual({
    side: 'request', path: 'request.messages[4].tool_calls[0]', messageOrd: 4, blockIndex: 0,
  });
  // 末尾回复投影的来源从回复根算起：Anthropic content[i]，Chat tool_calls[i]。
  const tail = projectTailReply(row(), read(detail(), [], { stop_reason: 'tool_use', content: [
    { type: 'text', text: '先看' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: {} },
  ] }));
  expect(tail.steps.find(s => s.kind === 'assistant')?.source).toEqual({
    side: 'reply', path: 'reply.content[0]', messageOrd: null, blockIndex: 0,
  });
  expect(tail.steps.find(s => s.kind === 'tool')?.source).toEqual({
    side: 'reply', path: 'reply.content[1]', messageOrd: null, blockIndex: 1,
  });
  const chatTail = projectTailReply(row(), read(detail(), [], { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }],
  } }] }));
  expect(chatTail.steps.find(s => s.kind === 'tool')?.source).toEqual({
    side: 'reply', path: 'reply.choices[0].message.tool_calls[0]', messageOrd: null, blockIndex: 0,
  });
  // 记录与辅助步骤不落在协议对象上，点击打开请求读数。
  const aux = projectSteps(row({ purpose_chain: 'exclude', req_kind: 'title' }), null);
  expect(aux[0]?.source).toBeNull();
  const record = projectSteps(row(), null);
  expect(record[0]?.source).toBeNull();
});

test('工具行上屏：chip 承载工具身份，未配对结果保持中性 Tool result', () => {
  const d = detail({ delta_ordinals: [2, 3] });
  const mixed = {
    ord: 2, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'file body', index: 0, raw: {}, path: 'content[0]' }],
    preview: 'file body', input: null, isInput: false,
  };
  const steps = projectSteps(row(), read(d, [mixed, assistantEntry(3, [
    { kind: 'call', text: 'Bash({"command":"ls","description":"列目录"})', index: 0, raw: { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls', description: '列目录' } }, path: 'content[0]' },
  ])], null));
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
  // 一级：chip 只包工具名，参数摘要以普通文本跟随，muted 箭头后接结果正文。
  expect(cached).toContain('row-tint tint-read">Read</span>');
  expect(cached).toContain('<code>src/q.ts · 1400–1530 行</code><span class="row-arrow" aria-hidden="true">→</span><code>文件正文</code>');
  // 二级：装配层查不到调用方（返回 null）时只显示工具名，箭头后直接接结果正文。
  const outside = renderTraceRows(row(), steps, 1, null,
    () => null);
  expect(outside).toContain('row-tint tint-read">Read</span>');
  expect(outside).not.toContain('<code>src/q.ts');
  expect(outside).toContain('<span class="row-arrow" aria-hidden="true">→</span><code>文件正文</code>');
  // 三级：未配对（pairOwner 为 null）中性 chip，不猜归属，也没有调用侧箭头。
  const unpairedSteps = projectSteps(row(), read(detail({ delta_ordinals: [2] }), [carrier],
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }));
  const unpaired = renderTraceRows(row(), unpairedSteps, 1, null, callOf);
  expect(unpaired).toContain('row-tint tint-other">Tool result</span>');
  expect(unpaired).not.toContain('row-arrow');
  // 结果行悬停给调用摘要与完整结果正文。
  expect(cached).toContain('title="src/q.ts · 1400–1530 行 → 文件正文"');
});

test('调用行悬停放完整参数 JSON，预览只放参数段', () => {
  const steps = projectSteps(row(), read(detail({ delta_ordinals: [4] }), [assistantEntry(4, [
    { kind: 'call', text: 'Read({...})', index: 0, raw: { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/u/very/long/path/queries.ts', offset: 1, limit: 5 } }, path: 'content[0]' },
  ])], null));
  const html = renderTraceRows(row(), steps, 1, null);
  expect(html).toContain('title="{&quot;file_path&quot;:&quot;/u/very/long/path/queries.ts&quot;,&quot;offset&quot;:1,&quot;limit&quot;:5}"');
  expect(html).toContain('<code>path/queries.ts · 1–6 行</code>');
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

test('已确认归属但关系未确认时不把已缓存历史当成新增', () => {
  const cached = [entry(0, { state: 'text', text: 'historical', original: 'historical' }, true)];
  for (const d of [
    detail({ derived_state: 'dirty', derivation: { chain_state: 'unavailable' }, delta_ordinals: null }),
    detail({ prev_relation: 'unknown', delta_ordinals: null }),
    detail({ prev_relation: 'branch', delta_ordinals: null }),
  ]) {
    const steps = projectSteps(row(), read(d, cached, { stop_reason: 'end_turn', content: [] }));
    expect(steps.some(step => step.kind === 'user')).toBe(false);
    expect(steps.some(step => step.text.includes('新增输入未确认'))).toBe(true);
  }
});

test('回调失败与冲突只作来源报告，不推断 HTTP 状态', () => {
  const snapshot = read(detail({ source_facts: { hook: { successes: ['failure'] } } }), [], null)!;
  const failed = projectSteps(row({ status: null }), snapshot);
  expect(failed.some(step => step.text === '回调报告失败 · 未提供失败原因')).toBe(true);
  expect(failed.some(step => step.text === 'HTTP 状态未知')).toBe(true);
  expect(failed.some(step => step.text.includes('HTTP 失败'))).toBe(false);
  snapshot.detail = { ...snapshot.detail!, source_facts: { hook: { successes: ['success', 'failure'] } } } as never;
  expect(projectSteps(row({ status: null }), snapshot).some(step => step.text === '回调的成功与失败报告冲突')).toBe(true);
});

test('账本错误显示来源与原文，正文缺失不影响错误展示', () => {
  const snapshot = read(detail({ actor_state: 'unknown', body_state: 'pending', reply_state: null,
    delta_ordinals: null, prev_relation: 'unknown',
    source_facts: { selected: { error: '<unknown model>' }, hook: null } }), [], null)!;
  const r = row({ status: 404, body_state: 'pending', miss_reason: 'hook_absent' });
  const steps = projectSteps(r, snapshot);
  expect(steps.some(step => step.text === '账本报告错误 · <unknown model>')).toBe(true);
  expect(steps.some(step => step.text.includes('HTTP 404'))).toBe(true);
  expect(steps.some(step => step.text.includes('hook_absent'))).toBe(true);
  expect(steps.some(step => step.text === '回复状态未知')).toBe(true);
  expect(steps.some(step => step.text.includes('正文信息未读到'))).toBe(false);
  snapshot.meta = { state: 'pending', reply: null } as never;
  expect(projectSteps(r, snapshot).some(step => step.text === '回复状态未知')).toBe(true);
  expect(renderTraceRows(r, steps, 1, null)).toContain('&lt;unknown model&gt;');
});

test('消息列表选择未投影的历史时仍定位请求原文', () => {
  const historical = {
    ord: 0, role: 'assistant', rawRole: 'assistant',
    blocks: [{ kind: 'text', text: 'earlier', index: 0, raw: 'earlier', path: 'content' }],
    preview: 'earlier', input: null, isInput: false,
  };
  const snapshot = read(detail({ prev_relation: 'unknown', delta_ordinals: null }), [historical], { output: [] })!;
  snapshot.meta = { ...snapshot.meta!, state: 'available', protocol: 'responses', total: 1 };
  expect(resolveSelectedSource(null, '7:message:0', snapshot)).toEqual({ side: 'request', target: 'message', path: 'request.input[0]', messageOrd: 0 });
  expect(resolveSelectedSource(null, '7:message:1', snapshot)).toEqual({ side: 'none' });
  expect(resolveSelectedSource(null, '9:message:0', snapshot)).toEqual({ side: 'none' });
});

test('孤立请求按详情归属显示携带的历史，其他快照不冒充新增', () => {
  const history = {
    ord: 0, role: 'assistant', rawRole: 'assistant',
    blocks: [{ kind: 'text', text: 'earlier reply', index: 0, raw: 'earlier reply', path: 'content' }],
    preview: 'earlier reply', input: null, isInput: false,
  };
  const injected = {
    ord: 1, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'text', text: '<system-reminder>context</system-reminder>', index: 0, raw: 'context', path: 'content' }],
    preview: '<system-reminder>context</system-reminder>', input: { state: 'injected' }, isInput: false,
  };
  const unknown = detail({ actor_state: 'unknown', derived_state: 'dirty', derivation: { chain_state: 'unavailable' }, delta_ordinals: null });
  const snapshot = read(unknown, [history, injected], { choices: [] })!;
  snapshot.meta = { ...snapshot.meta!, state: 'available', protocol: 'chat', total: 2 };
  snapshot.structure = { next: 2, total: 2, ords: [0, 1], loading: false, error: null };
  const steps = projectSteps(row({ actor_state: 'known' }), snapshot);
  const pastAssistant = steps.find(step => step.key === '7:message:0');
  expect(pastAssistant?.kind).toBe('assistant');
  expect(pastAssistant?.text).toContain('请求中的 Assistant');
  expect(resolveSelectedSource(pastAssistant ?? null)).toEqual({ side: 'request', target: 'message', path: 'request.messages[0]', messageOrd: 0 });
  const pastInjected = steps.find(step => step.key === '7:message:1');
  expect(pastInjected?.kind).toBe('record');
  expect(pastInjected?.text).toContain('system-reminder');
  expect(steps.some(step => step.kind === 'user')).toBe(false);
  const knownSnapshot = { ...snapshot, detail: { ...snapshot.detail!, actor_state: 'known' as const } };
  const knownSteps = projectSteps(row({ actor_state: 'unknown' }), knownSnapshot);
  expect(knownSteps.some(step => step.key === '7:message:0')).toBe(false);
  expect(knownSteps.some(step => step.text.includes('新增输入未确认'))).toBe(true);
});

test('辅助请求只有一条辅助记录；同 call_id 不同请求的键不冲突', () => {
  const aux = projectSteps(row({ purpose_chain: 'exclude', req_kind: 'title' }), null);
  expect(aux.length).toBe(1);
  expect(aux[0]?.kind).toBe('aux');
  const callBlock = { kind: 'call', text: 'x({})', index: 0, raw: { type: 'tool_use', id: 'same', name: 'x', input: {} }, path: 'content[0]' };
  const a = projectSteps(row({ req_id: 7 }), read(detail({ req_id: 7, delta_ordinals: [4] }), [assistantEntry(4, [callBlock])], null));
  const b = projectSteps(row({ req_id: 9 }), read(detail({ req_id: 9, delta_ordinals: [4] }), [assistantEntry(4, [callBlock])], null));
  expect(a[0]?.key).toBe('7:message:4:call:0');
  expect(b[0]?.key).toBe('9:message:4:call:0');
  // 末尾组沿用 reply/call 键，与承载组的 message:* 键不冲突。
  const reply = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'same', name: 'x', input: {} }] };
  expect(projectTailReply(row({ req_id: 7 }), read(detail({ req_id: 7 }), [], reply)).steps[0]?.key).toBe('7:call:0');
  expect(projectTailReply(row({ req_id: 9 }), read(detail({ req_id: 9 }), [], reply)).steps[0]?.key).toBe('9:call:0');
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
  // 纯工具回复：承载组不出内容行；末尾投影没有助手文本步骤，工具步骤在。
  const toolOnlyReply = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'x', input: {} }] };
  const toolOnlyRead = read(detail({ tool_calls: [{ call_id: 'c', ord: 0, tool_name: 'x', result_req: null, result_ord: null, result_path: null, state: 'pending' }] }), [], toolOnlyReply);
  expect(projectSteps(row(), toolOnlyRead).some(s => s.kind === 'assistant')).toBe(false);
  const tail = projectTailReply(row(), toolOnlyRead);
  expect(tail.steps.some(s => s.kind === 'assistant')).toBe(false);
  expect(tail.steps.find(s => s.kind === 'tool')?.result).toEqual({ state: 'pending', reqId: null });
  // 多 choice 与空回复不单独成末尾组。
  expect(projectTailReply(row(), read(detail(), [], { choices: [{}, {}] })).eligible).toBe(false);
  expect(projectTailReply(row(), read(detail(), [], { stop_reason: 'end_turn', content: [] })).eligible).toBe(false);
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
  // 正文状态记录带缺失原因，与 row-summary 的正文未到文案同口径；原因为空保持原文案。
  const absent = projectSteps(row({ body_state: 'pending', miss_reason: 'hook_absent' }), read(detail(), entries, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'r' }] }));
  expect(absent.find(s => s.key === '7:body')?.text).toBe('正文状态：pending（hook_absent）');
  const plain = projectSteps(row({ body_state: 'pending', miss_reason: null }), read(detail(), entries, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'r' }] }));
  expect(plain.find(s => s.key === '7:body')?.text).toBe('正文状态：pending');
});

test('工具摘要按工具分派：Read 行区间四种组合', () => {
  expect(toolSummary('Read', JSON.stringify({ file_path: '/Users/pis/src/queries.ts', offset: 1400, limit: 130 })))
    .toBe('Read · src/queries.ts · 1400–1530 行');
  expect(toolSummary('Read', JSON.stringify({ file_path: '/a/b.ts', limit: 130 })))
    .toBe('Read · a/b.ts · 前 130 行');
  expect(toolSummary('Read', JSON.stringify({ file_path: '/a/b.ts', offset: 1400 })))
    .toBe('Read · a/b.ts · 1400 行起');
  expect(toolSummary('Read', JSON.stringify({ file_path: '/a/b.ts' })))
    .toBe('Read · a/b.ts');
  // 仓库根文件：倒数第二段是仓库名，不是文件名。
  expect(toolSummary('Read', JSON.stringify({ file_path: '/Users/pis/repos/agent-trace-collector/AGENTS.md' })))
    .toBe('Read · agent-trace-collector/AGENTS.md');
  // 只有一段的相对路径原样显示，不补斜杠。
  expect(toolSummary('Read', JSON.stringify({ file_path: 'AGENTS.md' }))).toBe('Read · AGENTS.md');
  // file_path 缺核心键：回退链，不冒充文件摘要。
  expect(toolSummary('Read', '{"pattern":"x"}')).toBe('Read · x');
});

test('工具摘要按工具分派：Edit、Write、Bash', () => {
  expect(toolSummary('Edit', JSON.stringify({ file_path: 'src/derive.ts', old_string: 'a\nb\nc', new_string: 'x' })))
    .toBe('Edit · src/derive.ts · 3→1 行');
  expect(toolSummary('Edit', JSON.stringify({ file_path: 'src/derive.ts', old_string: 'a', new_string: 'b', replace_all: true })))
    .toBe('Edit · src/derive.ts · 1→1 行 · 全部替换');
  expect(toolSummary('Write', JSON.stringify({ file_path: 'docs/memory.md', content: 'x'.repeat(1229) })))
    .toBe('Write · docs/memory.md · 1.2 KB');
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

test('OMP 小写工具：read/write/edit 认 path 键，grep/glob/todo/task/web_search/ask 各显参数要点', () => {
  expect(toolSummary('read', JSON.stringify({ path: 'README.md', i: 'Reading README' })))
    .toBe('read · README.md');
  expect(toolSummary('write', JSON.stringify({ path: 'docs/x.md', content: 'y'.repeat(2048) })))
    .toBe('write · docs/x.md · 2.0 KB');
  expect(toolSummary('edit', JSON.stringify({ path: 'src/a.ts', old_string: 'a\nb', new_string: 'c' })))
    .toBe('edit · src/a.ts · 2→1 行');
  // 大写工具带 path 键也接受：OMP 混用两种客户端时不漏。
  expect(toolSummary('Read', JSON.stringify({ path: 'lib/b.py' }))).toBe('Read · lib/b.py');
  expect(toolSummary('grep', JSON.stringify({ pattern: 'derive_version', path: 'src' })))
    .toBe('grep · derive_version');
  expect(toolSummary('glob', JSON.stringify({ path: 'src/**/*.ts' })))
    .toBe('glob · src/**/*.ts');
  expect(toolSummary('todo', JSON.stringify({ op: 'append', task: '补 bg 配对测试\n第二行' })))
    .toBe('todo · append · 补 bg 配对测试');
  expect(toolSummary('todo', JSON.stringify({ op: 'view' }))).toBe('todo · view');
  expect(toolSummary('task', JSON.stringify({ agent: 'explore', task: '找齐调用点\n细节' })))
    .toBe('task · explore · 找齐调用点');
  expect(toolSummary('web_search', JSON.stringify({ query: 'bun sqlite wal' })))
    .toBe('web_search · bun sqlite wal');
  expect(toolSummary('ask', JSON.stringify({ questions: [{ question: '先做哪个?' }] })))
    .toBe('ask · 先做哪个?');
  // 核心键缺失走回退链，不冒充分派结果。
  expect(toolSummary('grep', '{"path":"src"}')).toBe('grep · src');
  expect(toolSummary('ask', '{"questions":[{"options":["a"]}]}'))
    .toBe('ask · {"questions":[{"options":["a"]}]}');
});

test('工具摘要回退：非 JSON 参数原文、未知工具回退链、超长不做字符截断', () => {
  expect(toolSummary('mcp__srv__do', 'not json')).toBe('mcp__srv__do · not json');
  expect(toolSummary('x', '{"command":"ls","cmd":"fallback-cmd"}')).toBe('x · ls');
  expect(toolSummary('x', '{"file_path":"src/a.ts"}')).toBe('x · src/a.ts');
  expect(toolSummary('x', '{"path":"lib/b.py"}')).toBe('x · lib/b.py');
  expect(toolSummary('', '{"path":"p"}')).toBe('未命名工具 · p');
  // 截断交给中栏列宽的省略号，摘要本身不再按固定字数砍。
  const long = toolSummary('Read', JSON.stringify({ file_path: '/a/'.concat('b'.repeat(300), '.ts') }));
  expect(long.startsWith('Read · ')).toBe(true);
  expect(long).not.toContain('…');
  expect([...long].length).toBeGreaterThan(300);
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
  // OMP 小写同族工具与大写各归同色，不扩新色类。
  expect(toolTint('read')).toBe('tint-read');
  expect(toolTint('edit')).toBe('tint-edit');
  expect(toolTint('write')).toBe('tint-write');
  expect(toolTint('grep')).toBe('tint-other');
});

test('多 choice 回复保留原始对象并说明限制', () => {
  const reply = { choices: [
    { finish_reason: 'stop', message: { role: 'assistant', content: 'a' } },
    { finish_reason: 'stop', message: { role: 'assistant', content: 'b' } },
  ] };
  const steps = projectSteps(row(), read(detail(), [], reply));
  expect(steps.some(s => s.kind === 'assistant')).toBe(false);
  expect(steps.some(s => s.text.includes('多 choice'))).toBe(true);
  // choice 结构损坏时同样先声明多 choice 限制，不把半份 choice0 拆成正文行。
  const malformed = projectSteps(row(), read(detail(), [], { choices: [{}, {}] }));
  expect(malformed.some(s => s.text.includes('多 choice 回复（2 项）'))).toBe(true);
  expect(malformed.some(s => s.kind === 'assistant')).toBe(false);
});

test('选中来源解析：末尾回复四块各自定位，两个文本不再共享整份回复', () => {
  const reply = { stop_reason: 'tool_use', content: [
    { type: 'text', text: 't0' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: {} },
    { type: 'text', text: 't2' },
    { type: 'tool_use', id: 'c3', name: 'Read', input: {} },
  ] };
  const steps = projectTailReply(row(), read(detail(), [], reply)).steps;
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
  const reply = { stop_reason: 'end_turn', content: [{ type: 'mystery', x: 1 }] };
  const steps = projectSteps(row(), read(d, [user], reply));
  expect(resolveSelectedSource(steps.find(s => s.kind === 'user') ?? null)).toEqual({
    side: 'request', target: 'message', path: 'request.messages[2]', messageOrd: 2,
  });
  // 未知回复块只在末尾投影里出现，来源仍指向协议位置；只有未知块的回复不成组。
  const tail = projectTailReply(row(), read(d, [user], reply));
  const unknown = tail.steps.find(s => s.key === '7:reply:block:0');
  expect(resolveSelectedSource(unknown ?? null)).toEqual({
    side: 'reply', target: 'block', path: 'reply.content[0]', blockIndex: 0, raw: unknown?.raw,
  });
  expect(tail.eligible).toBe(false);
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

test('截图形状：调用行归承载它的下一笔请求，结果行不按时间跳下一笔', () => {
  // 请求 A：输入两条，回复含 Skill(ponytail)；调用行不在 A 的组里。
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
  expect(stepsA.some(s => s.kind === 'tool')).toBe(false);
  // 请求 B：承载 A 的回复与结果；调用行带产出请求（A）的配对坐标与执行读数。
  const rowB = row({ req_id: 110 });
  const dB = detail({ req_id: 110, prev_req_id: 108, delta_ordinals: [2, 3, 4, 5] });
  const resultMsg = {
    ord: 4, role: 'user', rawRole: 'user',
    blocks: [{ kind: 'result', text: 'res', index: 0, raw: {}, path: 'content[0]' }],
    preview: 'res', input: null, isInput: false,
  };
  const callEntry = assistantEntry(3, [
    { kind: 'call', text: 'Skill({})', index: 0, raw: { type: 'tool_use', id: 'p', name: 'Skill', input: {} }, path: 'content[0]' },
  ]);
  const prevInfoOf = (prevId: number) => {
    expect(prevId).toBe(108);
    return { reasoningMs: null, calls: dA.tool_calls };
  };
  const stepsB = projectSteps(rowB, read(dB, [userA(2), callEntry, resultMsg, userA(5)],
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'm', name: 'Skill', input: {} }] }), null, [], prevInfoOf);
  expect(stepsB.filter(s => s.kind === 'user')).toHaveLength(2);
  const call = stepsB.find(s => s.kind === 'tool');
  expect(call?.source).toMatchObject({ side: 'request', path: 'request.messages[3].content[0]', messageOrd: 3 });
  expect(call?.callOwner).toEqual({ reqId: 108, callOrd: 0 });
  expect(call?.result).toEqual({ state: 'resolved', reqId: 110 });
  // 工具结果步骤定位在 B 自己的消息块，不跳去下一笔辅助请求。
  const result = stepsB.find(s => s.kind === 'tool_result');
  expect(result?.source).toMatchObject({ side: 'request', path: 'request.messages[4].content[0]', messageOrd: 4 });
  // 产出请求不在窗口或调用 id 不匹配：调用行不挂配对坐标，不猜归属。
  const unmatched = projectSteps(rowB, read(dB, [callEntry], null), null, [], () => ({ reasoningMs: null, calls: [] }));
  expect(unmatched.find(s => s.kind === 'tool')?.callOwner ?? null).toBeNull();
  expect(unmatched.find(s => s.kind === 'tool')?.reading ?? null).toBeNull();
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

test('背景作业配对标注：发起结果行带配对读数，完成通知出 Event 步骤', () => {
  const r = row();
  const resultBlock = { kind: 'result', text: 'Backgrounded as job bg_1 (sleep 2)', index: 0, failed: false, path: 'content[0]', raw: null };
  const noticeBlock = { kind: 'text', text: '<system-notice>Background job bg_1 has completed.</system-notice>', index: 0, raw: null };
  const entries = [
    { ord: 2, role: 'user', rawRole: 'user', blocks: [resultBlock], preview: '', input: null, isInput: false },
    { ord: 3, role: 'user', rawRole: 'user', blocks: [noticeBlock], preview: '', input: null, isInput: false },
  ];
  const jobs = [
    // 跨两笔：发起在 7，通知在 9，时延按两笔 started_ms 差。
    { job_id: 'bg_1', spawn_req: 7, spawn_ord: 2, notice_req: 9, notice_ord: 1,
      state: 'resolved', spawn_ms: 1000, notice_ms: 3310 },
    // 通知缺失与同笔完成各一条，覆盖三种读数。
    { job_id: 'bg_2', spawn_req: 7, spawn_ord: 2, notice_req: null, notice_ord: null,
      state: 'pending', spawn_ms: 1000, notice_ms: null },
    { job_id: 'bg_3', spawn_req: 7, spawn_ord: 2, notice_req: 7, notice_ord: 3,
      state: 'resolved', spawn_ms: 1000, notice_ms: 1000 },
  ];
  const steps = projectSteps(r, read(detail(), entries, { stop_reason: 'end_turn', content: [] }), null, jobs);
  const spawn = steps.find(s => s.kind === 'tool_result');
  expect(spawn?.bgNote).toContain('bg_1 已配对 · 2.31 s');
  expect(spawn?.bgNote).toContain('bg_2 等待完成通知');
  expect(spawn?.bgNote).toContain('bg_3 已配对 · 同一请求内');
  const notice = steps.find(s => s.kind === 'record' && s.key.endsWith(':bg'));
  expect(notice?.text).toBe('后台作业完成 · bg_3');
  expect(notice?.bgNote).toContain('bg_3 已配对 · 同一请求内');
  const html = renderTraceRows(r, steps, 4, null);
  expect(html).toContain('bg-note');
  expect(html).toContain('已配对 · 同一请求内');
  // 没有配对数据时不画标注，行为与此前一致。
  const plain = projectSteps(r, read(detail(), entries, { stop_reason: 'end_turn', content: [] }));
  expect(plain.find(s => s.kind === 'tool_result')?.bgNote).toBeUndefined();
  expect(plain.find(s => s.key === '7:message:3:bg')).toBeUndefined();
});

test('行尾读数：承载消息的文本行挂产出请求的推理段，调用行挂执行段，其余行留空', () => {
  const r = row();
  const entries = [
    entry(2, { state: 'text', text: '问题', original: '问题' }, true),
    assistantEntry(3, [
      { kind: 'text', text: '先看文件', index: 0, raw: '先看文件', path: 'content[0]' },
      { kind: 'call', text: 'Bash({"command":"bun test"})', index: 1, raw: { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'bun test' } }, path: 'content[1]' },
      { kind: 'text', text: '看完再说', index: 2, raw: '看完再说', path: 'content[2]' },
    ]),
  ];
  const d = detail({ prev_req_id: 5, delta_ordinals: [2, 3] });
  const calls = [{ call_id: 'c1', ord: 1, tool_name: 'Bash', result_req: 8, result_ord: 0, result_path: 'p', state: 'resolved', exec_ms: 2400 }];
  const steps = projectSteps(r, read(d, entries, null), null, [], () => ({ reasoningMs: 2100, calls }));
  expect(steps.filter(s => s.kind !== 'record').map(s => s.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  // 推理段只挂到唯一 assistant 消息的第一段文本；同消息的第二段不重复。
  expect(steps.filter(s => s.kind === 'assistant').map(s => s.reading ?? null))
    .toEqual([{ kind: 'reason', ms: 2100 }, null]);
  expect(steps.find(s => s.kind === 'tool')?.reading).toEqual({ kind: 'exec', ms: 2400 });
  expect(steps.find(s => s.kind === 'user')?.reading).toBeUndefined();

  const html = renderTraceRows(r, steps, 1, null);
  expect(html).toContain('<span class="row-reading reason"><span class="k">思考</span><b class="v t-good">2.1s</b></span>');
  expect(html).toContain('<span class="row-reading exec"><span class="k">执行</span><b class="v t-good">2.4s</b></span>');
  // 每行（含请求级记录）都有读数槽，User 行、第二段文本与记录行留空：槽宽不随内容跳。
  expect(html.match(/class="compact-reading"/g)?.length).toBe(5);
  expect(html.match(/class="compact-reading"><\/span>/g)?.length).toBe(3);
});

test('读数按工具类别取档位，等待型工具不上色', () => {
  const r = row();
  const entries = [assistantEntry(3, [
    { kind: 'call', text: 'AskUserQuestion({})', index: 0, raw: { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} }, path: 'content[0]' },
    { kind: 'call', text: 'Read({})', index: 1, raw: { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/x' } }, path: 'content[1]' },
    { kind: 'call', text: 'Agent({})', index: 2, raw: { type: 'tool_use', id: 'a', name: 'Agent', input: {} }, path: 'content[2]' },
  ])];
  const d = detail({ prev_req_id: 5, delta_ordinals: [3] });
  const calls = [
    { call_id: 'q', ord: 0, tool_name: 'AskUserQuestion', result_req: 8, result_ord: 0, result_path: 'p', state: 'resolved', exec_ms: 45_000 },
    { call_id: 'r', ord: 1, tool_name: 'Read', result_req: 8, result_ord: 1, result_path: 'p', state: 'resolved', exec_ms: 12_000 },
    { call_id: 'a', ord: 2, tool_name: 'Agent', result_req: 8, result_ord: 2, result_path: 'p', state: 'resolved', exec_ms: 95_000 },
  ];
  const html = renderTraceRows(r, projectSteps(r, read(d, entries, null), null, [], () => ({ reasoningMs: null, calls })), 1, null);
  // 等人回答的 45s 不上档：数值照常显示，整枚标签退成中性色。
  expect(html).toContain('<span class="row-reading exec wait"><span class="k">执行</span><b class="v">45.0s</b></span>');
  // 读 12s 超过 1s/10s 的第二档。
  expect(html).toContain('<b class="v t-bad">12.0s</b>');
  // 子代理 95s 落在 30s/120s 之间。
  expect(html).toContain('<b class="v t-warn">1m 35s</b>');
});

test('读不出时不写 0：推理段与执行段缺值都留空槽', () => {
  const r = row();
  const entries = [assistantEntry(3, [
    { kind: 'text', text: '只有文本', index: 0, raw: '只有文本', path: 'content[0]' },
    { kind: 'call', text: 'Bash({})', index: 1, raw: { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }, path: 'content[1]' },
  ])];
  const d = detail({ prev_req_id: 5, delta_ordinals: [3] });
  const calls = [{ call_id: 'c1', ord: 1, tool_name: 'Bash', result_req: null, result_ord: null, result_path: null, state: 'pending', exec_ms: null }];
  // 产出请求可读但没有推理段与结算时长：两行读数都留空。
  const steps = projectSteps(r, read(d, entries, null), null, [], () => ({ reasoningMs: null, calls }));
  expect(steps.filter(s => s.kind !== 'record').map(s => s.reading ?? null)).toEqual([null, null]);
  const html = renderTraceRows(r, steps.filter(s => s.kind !== 'record'), 1, null);
  expect(html).not.toContain('class="row-reading');
  expect(html.match(/<span class="compact-reading"><\/span>/g)?.length).toBe(2);
  // 已确认但产出请求不在窗口（prev_req_id 缺失）时同样不留读数。
  const noPrev = projectSteps(r, read(detail({ delta_ordinals: [3] }), entries, null), null, [], () => ({ reasoningMs: 9, calls }));
  expect(noPrev.filter(s => s.kind !== 'record').map(s => s.reading ?? null)).toEqual([null, null]);
});

test('正文未到的请求不补「未收到回复」，只报正文状态', () => {
  const entries = [entry(0, { state: 'text', text: '问', original: '问' }, true)];
  const snapshot = read(detail({ delta_ordinals: [0] }), entries, null);
  // 正文未到：meta 带 state='pending'、没有回复对象，回复视图继承正文状态。
  const pending = {
    ...snapshot, meta: { state: 'pending', reply: null, capabilities: null },
  } as unknown as ProjectableRead;
  const steps = projectSteps(row({ body_state: 'pending', miss_reason: 'hook_absent' }), pending);
  expect(steps.some(s => s.text === '未收到回复')).toBe(false);
  expect(steps.find(s => s.key === '7:body')?.text).toBe('正文状态：pending（hook_absent）');
});

test('末尾组判定：只在完整加载时给出，后继承载与前驱未知各抑制一次', () => {
  const chain = [
    { id: 2, prevId: null, undetermined: true },
    { id: 4, prevId: 2, undetermined: false },
    { id: 5, prevId: 4, undetermined: false },
  ];
  // 未读到会话末尾：任何链末都不成末尾组，避免加载历史时挂在行上的回复消失。
  expect(tailEligibleIds(chain, false).size).toBe(0);
  // 完整加载：只有 5 是链末；2 的回复被 4 承载，4 的回复被 5 承载。
  expect([...tailEligibleIds(chain, true)]).toEqual([5]);
  // 前驱未知的后续行存在时，链末的回复可能由它承载，排除不了就抑制。
  const unknownTail = [...chain, { id: 6, prevId: null, undetermined: true }];
  expect(tailEligibleIds(unknownTail, true).has(5)).toBe(false);
  expect([...tailEligibleIds(unknownTail, true)]).toEqual([6]);
  // 分支各成链末：两条链都不被对方承载，各得一个末尾组。
  const branches = [
    { id: 8, prevId: 7, undetermined: false },
    { id: 9, prevId: 7, undetermined: false },
  ];
  expect([...tailEligibleIds(branches, true)]).toEqual([8, 9]);
  // 空窗口没有候选。
  expect(tailEligibleIds([], true).size).toBe(0);
});
