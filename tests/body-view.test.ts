import { expect, test } from 'bun:test';
import {
  bodyNotice, deltaOrdinals, messageCopyText, messageEntries, partColor, partLabel, renderAttemptChain, renderCapabilities,
  renderMessageDetail, renderMessages, renderRaw, renderReply, renderReplyDetail, renderTools, replyView, toolEntries,
} from '../web/body-view.js';
import type { BodyPage } from '../src/protocols';
import type { CapabilityView } from '../src/capabilities';
import type { AttemptChain } from '../src/queries';
import type { RequestDetail } from '../src/queries';

const missingCapabilities: CapabilityView = {
  tools: { state: 'missing', items: [], reason: 'body_unavailable' },
  skills: { state: 'missing', items: [], reason: 'body_unavailable' },
  coverage: { complete: false, reason: 'body_unavailable', from: 0, to: 0, total: null },
  agent: null,
};

function page(overrides: Partial<BodyPage> = {}): BodyPage {
  return {
    state: 'available', parse_state: 'ok', reply_state: 'ok', from: 0, to: 0, total: 2,
    messages: [], request_fields: null, reply: null, reason: null,
    interpretations: [],
    coverage: { from: 0, to: 0, total: 2, complete: true, loaded_complete: false, reason: 'available' },
    capabilities: missingCapabilities,
    ...overrides,
  };
}

test('Anthropic 文本、推理与工具块各自归一化', () => {
  const messages = messageEntries(page({
    messages: [{
      ord: 0,
      value: {
        role: 'user',
        content: [
          { type: 'text', text: '读一下配置' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    }],
  }));
  expect(messages.length).toBe(1);
  expect(messages[0]?.role).toBe('user');
  expect(messages[0]?.blocks.map(block => block.kind)).toEqual(['text', 'result']);
  expect(messages[0]?.blocks[1]?.text).toBe('ok');
  expect(messages[0]?.preview).toBe('读一下配置');
});

test('工具结果的 is_error 按需透出为失败标记', () => {
  const entries = messageEntries(page({
    messages: [{
      ord: 0,
      value: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' },
          { type: 'tool_result', tool_use_id: 'toolu_2', is_error: false, content: 'ok' },
          { type: 'tool_result', tool_use_id: 'toolu_3', content: 'unknown' },
        ],
      },
    }],
  }));
  const blocks = entries[0]?.blocks ?? [];
  // 缺失不等于成功：只有明确的 false 才记成 false，缺失保持未报告。
  expect(blocks.map(block => block.failed)).toEqual([true, false, undefined]);
  const html = renderMessageDetail(entries[0]!);
  expect(html.match(/工具结果失败/g)?.length).toBe(1);
  expect(html).toContain('boom');
});

test('Chat 的 tool_calls 提升为调用块且保住位置', () => {
  const entries = messageEntries(page({
    messages: [{
      ord: 3,
      value: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'call_b', type: 'function', function: { name: 'run', arguments: '{}' } },
        ],
      },
    }],
  }));
  const blocks = entries[0]?.blocks ?? [];
  expect(blocks.map(block => block.kind)).toEqual(['call', 'call']);
  expect(blocks.map(block => block.index)).toEqual([0, 1]);
  expect(blocks[0]?.text).toBe('read_file({"path":"a.ts"})');
});

test('回复两种协议都能读出文本、推理与调用', () => {
  const anthropic = replyView(page({
    reply: {
      id: 'msg_1',
      model: 'm',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '先看文件' },
        { type: 'text', text: '我去读一下。' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
      ],
    },
  }));
  expect(anthropic.state).toBe('ok');
  expect(anthropic.text).toBe('我去读一下。');
  expect(anthropic.thinking).toEqual(['先看文件']);
  expect(anthropic.calls.map(call => call.name)).toEqual(['read']);
  expect(anthropic.finish).toBe('tool_use');

  const chat = replyView(page({
    reply: {
      id: 'chatcmpl_1',
      model: 'g',
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '完成了。',
          tool_calls: [{ id: 'call_a', function: { name: 'run', arguments: '{}' } }],
        },
      }],
    },
  }));
  expect(chat.text).toBe('完成了。');
  expect(chat.calls.map(call => call.name)).toEqual(['run']);
  expect(chat.finish).toBe('stop');
});

test('空回复与无法结构化的回复分开报', () => {
  expect(replyView(page({ reply: null })).state).toBe('absent');
  expect(replyView(page({ reply: 'not-an-object' })).state).toBe('invalid');
  const empty = replyView(page({ reply: { id: 'msg_1', content: [] } }));
  expect(empty.state).toBe('ok');
  expect(empty.text).toBe('');
  expect(renderReply(empty)).toContain('没有文本内容');
});

test('只有确定增量才标记新增，未知关系返回空', () => {
  const current = { state: 'clean', chain_state: 'current', summary_state: 'current', reason: null };
  const detail = { prev_relation: 'confirmed', delta_ordinals: [3, 4], derivation: current } as RequestDetail;
  expect([...(deltaOrdinals(detail) ?? [])]).toEqual([3, 4]);
  expect(deltaOrdinals({
    prev_relation: 'unknown', delta_ordinals: [3], derivation: current,
  } as unknown as RequestDetail)).toBeNull();
  expect(deltaOrdinals(null)).toBeNull();

  const entries = messageEntries(page({
    messages: [
      { ord: 0, value: { role: 'user', content: 'old' } },
      { ord: 3, value: { role: 'user', content: 'new' } },
    ],
  }));
  const html = renderMessages(entries, { delta: deltaOrdinals(detail) });
  expect(html.match(/msg-new/g)?.length).toBe(1);
  expect(html).toContain('data-ord="3"');
});

test('回收、未到与不支持都给出原因而不是空列表', () => {
  expect(bodyNotice(page({ state: 'evicted', reason: 'budget' }))).toContain('budget');
  expect(bodyNotice(page({ state: 'pending', reason: 'hook_missing' }))).toContain('hook_missing');
  expect(bodyNotice(page({ state: 'unsupported', reason: null }))).toContain('暂不支持');
  expect(bodyNotice(page({ state: 'available', reply_state: 'absent', reason: null }))).toContain('上游未提供可用回复');
});

test('工具卡遍历全部调用并按 ord 对齐服务端配对', () => {
  const detail = {
    tool_calls: [
      { call_id: 'toolu_1', ord: 0, tool_name: 'read', result_req: 9, result_ord: 2, result_path: 'request.messages[2]', state: 'resolved' },
      { call_id: 'toolu_2', ord: 1, tool_name: 'write', result_req: null, result_ord: null, result_path: null, state: 'pending' },
    ],
  } as unknown as RequestDetail;
  const tools = toolEntries(detail, page({
    reply: {
      id: 'msg_1',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'toolu_2', name: 'write', input: { path: 'b.ts' } },
      ],
    },
  }));
  expect(tools.map(tool => tool.state)).toEqual(['resolved', 'pending']);
  const html = renderTools(tools, '7');
  expect(html).toContain(`data-tool-owner="${detail.req_id}"`);
  expect(html).toContain('data-call-ord="0"');
  expect(html).toContain('data-fold="round:7"');
  // 已配对显示结果跳转；未确认与无结果按「没有就不显示」不出状态。
  expect(html).toContain('→ 结果');
  expect(html).not.toContain('结果位置未确认');
  expect(html).not.toContain('还没有见到结果');
  const twinDetail = { req_id: 42, tool_calls: [
    { call_id: 'a', ord: 0, tool_name: 'read', result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[0]', state: 'resolved' },
    { call_id: 'b', ord: 1, tool_name: 'read', result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[1]', state: 'resolved' },
  ] } as never;
  const twin = toolEntries(twinDetail as never, page({
    reply: { id: 'm', content: [
      { type: 'tool_use', id: 'a', name: 'read', input: { path: 'a' } },
      { type: 'tool_use', id: 'b', name: 'read', input: { path: 'b' } },
    ] },
  }));
  const twinHtml = renderTools(twin, '42');
  expect(twin.filter(t => t.result_path !== null).map(t => t.result_path)).toEqual([
    'request.messages[2].content[0]', 'request.messages[2].content[1]',
  ]);
  expect((twinHtml.match(/data-call-ord="0"/g) ?? []).length).toBe(1);
  expect((twinHtml.match(/data-call-ord="1"/g) ?? []).length).toBe(1);
  // 两个调用都指向同一目标：跳转按钮身份仍是各自的调用序号。
  expect((twinHtml.match(/→ 结果/g) ?? []).length).toBe(2);
  // 没有配对信息的调用不能冒充已配对。
  const orphan = toolEntries(null, page({ reply: { id: 'm', content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] } }));
  expect(orphan[0]?.state).toBe('unpaired');
});

test('消息与回复都先转义，XSS 载荷不会成为标签', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const entries = messageEntries(page({ messages: [{ ord: 0, value: { role: 'user', content: payload } }] }));
  const list = renderMessages(entries, { delta: null });
  expect(list).not.toContain('<img');
  expect(list).toContain('&lt;img');

  const reply = replyView(page({ reply: { id: 'm', content: [{ type: 'text', text: payload }] } }));
  const card = renderReply(reply);
  expect(card).not.toContain('<img');
  expect(card).toContain('&lt;img');

  // 未知块走转义 JSON，也不能逃逸。
  const unknown = renderReplyDetail(replyView(page({ reply: { id: 'm', content: [{ type: 'mystery', text: payload }] } })));
  expect(unknown).not.toContain('<img');
});

test('原始对象只展示这一片取到的字段', () => {
  const html = renderRaw(page({ request_fields: { model: 'm' }, reply: { id: 'msg_1', content: [] } }));
  expect(html).toContain('&quot;model&quot;: &quot;m&quot;');
  expect(html).toContain('回复对象');
  const empty = renderRaw(page({ request_fields: null, reply: null }));
  expect(empty).toContain('没有读到请求的顶层字段');
  expect(empty).toContain('没有保存到回复对象');
});

test('空消息与超长消息都不撑破预览', () => {
  const long = 'x'.repeat(500);
  const entries = messageEntries(page({
    messages: [
      { ord: 0, value: { role: 'user', content: [] } },
      { ord: 1, value: { role: 'assistant', content: [{ type: 'text', text: long }] } },
    ],
  }));
  expect(entries[0]?.preview).toBe('（空消息）');
  const preview = entries[1]?.preview ?? '';
  expect([...preview].length).toBeLessThanOrEqual(141);
  const html = renderMessages(entries, { delta: null, limit: 1 });
  expect(html).toContain('还有 1 条未显示');
});

test('工具结果消息不算用户输入，纯调用回复保留推理块', () => {
  const entries = messageEntries(page({
    messages: [
      { ord: 0, value: { role: 'user', content: [{ type: 'text', text: '读一下文件' }] } },
      { ord: 1, value: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }] } },
      { ord: 2, value: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    ],
    interpretations: [
      {
        ord: 0, role: 'user', role_state: 'known', is_input: true,
        input: { state: 'text', kind: 'plain', text: '读一下文件', original: '读一下文件', removed: [], agent: null, rule: 'generic' },
      },
      { ord: 1, role: 'assistant', role_state: 'known', input: null, is_input: false },
      { ord: 2, role: 'user', role_state: 'known', input: null, is_input: false },
    ],
  }));
  // Anthropic 的 tool_result 挂在 user 角色下，但它不是人在说话。
  expect(entries.map(entry => entry.isInput)).toEqual([true, false, false]);
  expect(entries[2]?.blocks.map(block => block.kind)).toEqual(['result']);
  // 没有服务端解释的消息不按角色猜输入。
  const uninterpreted = messageEntries(page({
    messages: [{ ord: 0, value: { role: 'user', content: '看起来像输入' } }],
  }));
  expect(uninterpreted[0]?.isInput).toBe(false);
  expect(uninterpreted[0]?.input).toBeNull();

  const callOnly = replyView(page({
    reply: {
      id: 'msg_1',
      content: [
        { type: 'thinking', thinking: '先定位文件。' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
      ],
    },
  }));
  expect(callOnly.text).toBe('');
  expect(callOnly.thinking).toEqual(['先定位文件。']);
  const card = renderReply(callOnly, []);
  expect(card).toContain('推理块');
  expect(card).not.toContain('没有文本内容');
});

const presentView: CapabilityView = {
  tools: {
    state: 'present',
    items: [
      { name: 'Bash', description: 'Run a shell command', schema: { type: 'object' }, source: 'tools' },
      { name: 'Read', description: '', schema: null, source: 'tools' },
    ],
    reason: null,
  },
  skills: { state: 'present', items: [{ name: 'anysearch', description: '实时搜索', format: 'tagged' }], reason: null },
  coverage: { complete: true, reason: 'available', from: 0, to: 2, total: 2 },
  agent: 'claude',
};

test('能力区块消费服务端状态，empty 整行不渲染，partial 显示原因', () => {
  const partialView: CapabilityView = {
    tools: { state: 'empty', items: [], reason: 'no_tools_field' },
    skills: { state: 'partial', items: [], reason: 'body_partial' },
    coverage: { complete: false, reason: 'body_partial', from: 0, to: 40, total: 90 },
    agent: 'claude',
  };
  const html = renderCapabilities(page({ capabilities: partialView }));
  expect(html).toContain('技能清单未读完');
  expect(html).not.toContain('0 技能');
  // empty = 请求没带工具定义，按「没有就不显示」整行不渲染。
  expect(html).not.toContain('工具清单');
});

test('能力区块区分 missing 与 empty', () => {
  const missing = renderCapabilities(page({
    capabilities: {
      ...presentView,
      skills: { state: 'missing', items: [], reason: 'body_unavailable' },
      coverage: { complete: false, reason: 'body_unavailable', from: 0, to: 0, total: null },
    },
  }));
  expect(missing).toContain('技能声明缺失');
  const empty = renderCapabilities(page({
    capabilities: {
      ...presentView,
      skills: { state: 'empty', items: [], reason: 'no_skill_declaration' },
      coverage: { complete: true, reason: 'available', from: 0, to: 2, total: 2 },
    },
  }));
  expect(empty).toContain('工具清单');
  expect(empty).not.toContain('技能清单');
});

test('能力区块渲染服务端条目并压平描述', () => {
  const description = `${'x'.repeat(200)}\n第二行`;
  const html = renderCapabilities(page({
    capabilities: {
      ...presentView,
      tools: {
        state: 'present',
        items: [{ name: 'T', description, schema: null, source: 'tools' }],
        reason: null,
      },
    },
  }));
  expect(html).toContain('data-fold="cap:tools"');
  expect(html).toContain('data-fold="cap:skills"');
  expect(html).toContain('<code class="cap-name">T</code>');
  expect(html).toContain(`${'x'.repeat(120)}…`);
  expect(html).not.toContain('\n第二行');
  // schema 为 null 时不输出 pre。
  expect(html).not.toContain('<pre class="raw"');
});

test('能力区块没有视图时返回空，missing 显示原因', () => {
  const html = renderCapabilities(page({ capabilities: missingCapabilities }));
  expect(html).toContain('工具定义缺失');
  expect(html).toContain('技能声明缺失');
  expect(renderCapabilities(null)).toBe('');
  expect(renderCapabilities(undefined)).toBe('');
});

test('能力区块的动态内容只作为文本转义', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const html = renderCapabilities(page({
    capabilities: {
      ...presentView,
      tools: { state: 'present', items: [{ name: payload, description: payload, schema: null, source: 'tools' }], reason: null },
      skills: { state: 'present', items: [{ name: payload, description: payload, format: 'tagged' }], reason: null },
      coverage: { complete: true, reason: 'available', from: 0, to: 2, total: 2 },
    },
  }));
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('尝试链渲染未知 fail 码与已记录时间', () => {
  const chain: AttemptChain = {
    state: 'present',
    items: [
      {
        index: 0, model: 'm1', effort: 'high', status: 500,
        fail: 'synthetic_new_gate', error: null, start_ms: 1761091200000,
        ms: 100, ttft_ms: 1555, flow_ms: 670, first_text_ms: 2603,
        first_reasoning_ms: 1555, served: null, done: true, tier_served: 'default',
        reasoning_hidden: true, queued_ms: null,
      },
      {
        index: 1, model: 'm2', effort: null, status: 200,
        fail: null, error: null, start_ms: 1761091201000,
        ms: 200, ttft_ms: null, flow_ms: null, first_text_ms: null,
        first_reasoning_ms: null, served: 's', done: true, tier_served: null,
        reasoning_hidden: false, queued_ms: null,
      },
    ],
    timing: { state: 'recorded', note: '时间来自各次尝试的开始时间' },
  };
  const html = renderAttemptChain(chain);
  expect(html).toContain('synthetic_new_gate');
  expect(html).toContain('m1');
  expect(html).toContain('m2');
  expect(html).toContain('首个文本 2603 ms');
  expect(html).toContain('首个推理 1555 ms');
  expect(html).toContain('首 token 1555 ms');
  expect(html).toContain('tier default');
  expect(html).toContain('推理隐藏');
});

test('缺时间时只显示说明，不补造间隔', () => {
  const html = renderAttemptChain({
    state: 'present',
    items: [{
      index: 0, model: 'm1', effort: null, status: 500,
      fail: 'rate_limit', error: null, start_ms: null, ms: null,
      ttft_ms: null, flow_ms: null, first_text_ms: null, first_reasoning_ms: null,
      served: null, done: null, tier_served: null, reasoning_hidden: null, queued_ms: null,
    }],
    timing: { state: 'partial', note: '部分尝试没有开始时间，不推算间隔' },
  });
  expect(html).toContain('不推算间隔');
  expect(html).not.toContain('等待');
  expect(html).not.toContain('间隔 ');
});

test('未知 part kind 保留名称并使用有效颜色', () => {
  expect(partLabel('synthetic_part')).toBe('synthetic_part');
  expect(partColor('synthetic_part')).toBe('var(--p-unknown)');
  expect(partColor('chat')).toBe('var(--p6)');
  expect(partLabel('<img src=x>')).toBe('<img src=x>');
});

test('六类已知 part 各有颜色与标签', () => {
  expect(['system', 'tools', 'memory', 'files', 'results', 'chat'].map(partColor))
    .toEqual(['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)', 'var(--p5)', 'var(--p6)']);
  expect(partLabel('memory')).toBe('记忆与技能');
  expect(partLabel('history')).toBe('history');
  expect(partColor('history')).toBe('var(--p-unknown)');
});

test('链结果非 current 时不标记新增与 confirmed', () => {
  const dirty = {
    prev_relation: 'confirmed',
    delta_ordinals: [3],
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
  } as unknown as RequestDetail;
  expect(deltaOrdinals(dirty)).toBeNull();
  const current = {
    ...dirty,
    derivation: { state: 'clean', chain_state: 'current', summary_state: 'current', reason: null },
  } as RequestDetail;
  expect([...(deltaOrdinals(current) ?? [])]).toEqual([3]);
  // 没有派生视图的旧载荷同样不能冒充确定新增。
  expect(deltaOrdinals({ prev_relation: 'confirmed', delta_ordinals: [3] } as RequestDetail)).toBeNull();
});

test('复制文本保留原文，不做 HTML 转义', () => {
  const payload = '<script>alert(1)</script>';
  const entries = messageEntries(page({
    messages: [{ ord: 0, value: { role: 'user', content: payload } }],
    interpretations: [{
      ord: 0,
      role: 'user',
      role_state: 'known',
      input: {
        state: 'text', kind: 'plain', text: payload,
        original: payload, removed: [], agent: null, rule: 'generic',
      },
      is_input: true,
    }],
  }));
  expect(messageCopyText(entries[0]!)).toBe(payload);
  // 详情渲染仍转义；复制路径与 HTML 路径分开。
  const html = renderMessageDetail(entries[0]!);
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('data-copy-msg="0"');
  expect(html).not.toContain('<script>');
});

test('右栏回复详情的推理块默认折叠', () => {
  const view = replyView(page({
    reply: { id: 'm', content: [{ type: 'thinking', thinking: '先查一下' }, { type: 'text', text: '答案' }] },
  }));
  const html = renderReplyDetail(view);
  expect(html).toContain('<details class="rail-fold sub">');
  expect(html).toContain('推理块');
  expect(html).not.toContain('<details class="rail-fold sub" open');
  // 推理块与工具往返默认收起/展开由外层控制；这里锁定推理块默认收起。
});

test('能力折叠区带稳定键，重绘后按名字恢复开合', () => {
  const html = renderCapabilities(page({ capabilities: presentView }));
  expect(html).toContain('data-fold="cap:tools"');
  expect(html).toContain('data-fold="cap:skills"');
  expect(html).toContain('data-fold="cap:tool:Bash"');
  expect(html).not.toContain('<details open');
});
