import { expect, test } from 'bun:test';
import {
  bodyNotice, renderCapabilities, renderMessageDetail, renderMessages, renderReply,
  renderReplyDetail, renderTools, roleClass, roleTag, toolTint,
} from '../web/body-view.js';
import {
  deltaOrdinals, displayRoleOf, messageCopyText, messageEntries, replyView, toolEntries,
  topSystemText,
} from '../web/body-model.js';
import { partColor, partLabel, renderAttemptChain } from '../web/rail-facts.js';
import { replyCompleteness } from '../web/row-summary.js';
import { esc, mdToHtml } from '../web/html.js';
import type { BodyPage } from '../src/protocols';
import type { CapabilityView } from '../src/capabilities';
import type { AttemptChain } from '../src/queries/routes';
import type { RequestDetail } from '../src/queries/requests';

const missingCapabilities: CapabilityView = {
  tools: { state: 'missing', items: [], reason: 'body_unavailable' },
  skills: { state: 'missing', items: [], reason: 'body_unavailable' },
  coverage: { complete: false, reason: 'body_unavailable', from: 0, to: 0, total: null },
  agent: null,
};

function page(overrides: Partial<BodyPage> = {}): BodyPage {
  return {
    state: 'available', protocol: 'anthropic', message_location: { key: 'messages', form: 'array' },
    parse_state: 'ok', reply_state: 'ok',
    from: 0, to: 0, total: 2,
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

test('英文角色标签：调用是 Assistant，结果是 Tool，原始 role 保留', () => {
  const entries = messageEntries(page({
    messages: [
      { ord: 0, value: { role: 'assistant', content: null, tool_calls: [
        { id: 't1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
      ] } },
      { ord: 1, value: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'text', text: '继续' },
      ] } },
      { ord: 2, value: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: '第二次结果' },
      ] } },
      { ord: 3, value: { role: 'tool', content: 'chat result body' } },
      { ord: 4, value: { role: 'developer', content: 'policy text' } },
      { ord: 5, value: { role: 'alien', content: '???' } },
    ],
  }));
  // rawRole 保留原始协议值；developer 归 System 显示，未知 role 显示 Unknown。
  expect(entries.map(entry => entry.rawRole)).toEqual(['assistant', 'user', 'user', 'tool', 'developer', 'alien']);
  expect(entries.map(entry => entry.role)).toEqual(['assistant', 'user', 'user', 'tool', 'system', 'unknown']);
  // 混合消息保留 User 与文本，不被整条改成 Tool；纯结果消息显示 Tool。
  expect(displayRoleOf(entries[1]!)).toBe('user');
  expect(displayRoleOf(entries[2]!)).toBe('tool');
  expect(displayRoleOf(entries[4]!)).toBe('system');
  expect(entries[1]?.preview).toBe('ok');
  // 英文标签，无中文回退。
  expect(roleTag('assistant')).toBe('Assistant');
  expect(roleTag('tool')).toBe('Tool');
  expect(roleTag('system')).toBe('System');
  expect(roleTag('user')).toBe('User');
  expect(roleTag('unknown')).toBe('Unknown');
  expect(roleClass('developer' as never)).toBe('unknown');
  // 渲染：主角色加内容类型，工具结果正文不冒充用户输入。
  const list = renderMessages(entries, { delta: null });
  expect(list).toContain('Assistant');
  expect(list).toContain('Tool result · ');
  expect(list).toContain('Tool call · ');
  expect(list).toContain('>Unknown<');
  expect(list).not.toContain('用户');
  expect(list).not.toContain('助手');
  // 详情单列原始协议角色。
  const devDetail = renderMessageDetail(entries[4]!);
  expect(devDetail).toContain('>System<');
  expect(devDetail).toContain('role=developer');
  // 输入序号不变。
  expect(entries.map(entry => entry.ord)).toEqual([0, 1, 2, 3, 4, 5]);
});

test('顶层 system 文本从 request_fields 读取，字符串与块数组都支持', () => {
  expect(topSystemText(page({ request_fields: { system: 'base prompt' } }))).toBe('base prompt');
  expect(topSystemText(page({ request_fields: { system: [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ] } }))).toBe('first\n\nsecond');
  expect(topSystemText(page({ request_fields: null }))).toBeNull();
  expect(topSystemText(page({ request_fields: { system: '' } }))).toBeNull();
  expect(topSystemText(null)).toBeNull();
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
  // 有序块带从回复根算起的路径与协议内序号；anthropic 无 choice 概念。
  expect(anthropic.blocks.map(block => [block.kind, block.path, block.index])).toEqual([
    ['thinking', 'reply.content[0]', 0],
    ['text', 'reply.content[1]', 1],
    ['call', 'reply.content[2]', 2],
  ]);
  expect(anthropic.choiceCount).toBeNull();
  expect(anthropic.calls[0]?.path).toBe('reply.content[2]');

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
  expect(chat.blocks.map(block => [block.kind, block.path])).toEqual([
    ['text', 'reply.choices[0].message.content'],
    ['call', 'reply.choices[0].message.tool_calls[0]'],
  ]);
  expect(chat.choiceCount).toBe(1);
});

test('Responses 回复从 output 出块，调用序号与服务端位置同源', () => {
  const view = replyView(page({
    protocol: 'responses', message_location: { key: 'input', form: 'array' },
    reply: {
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '先看文件' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我去读一下。' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      ],
    },
  }));
  expect(view.state).toBe('ok');
  expect(view.text).toBe('我去读一下。');
  expect(view.thinking).toEqual(['先看文件']);
  expect(view.finish).toBe('completed');
  // 路径按项定位：消息项展开 content，调用项整项即块。
  expect(view.blocks.map(block => [block.kind, block.path, block.index])).toEqual([
    ['thinking', 'reply.output[0]', 0],
    ['text', 'reply.output[1].content[0]', 1],
    ['call', 'reply.output[2]', 2],
  ]);
  // ord 取项在 output 里的位置：服务端的 tool_call.ord 按同一口径落库。
  expect(view.calls).toEqual([{
    id: 'call_1', name: 'read', inputText: '{"path":"a.ts"}', ord: 2, path: 'reply.output[2]',
  }]);
  // 两个消息项各有 content[0]：块序号取项位置，步骤键不撞。
  const twoMessages = replyView(page({
    protocol: 'responses', message_location: { key: 'input', form: 'array' },
    reply: { status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] },
    ] },
  }));
  expect(twoMessages.blocks.map(block => [block.index, block.path])).toEqual([
    [0, 'reply.output[0].content[0]'],
    [1, 'reply.output[1].content[0]'],
  ]);
  // incomplete 的原因抬到 finish：已知截断不显示成未知停止。
  expect(replyView(page({ reply: {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
  } })).finish).toBe('max_output_tokens');
});

test('Responses 请求项按 type 出块，工具结果不混进用户消息', () => {
  const entries = messageEntries(page({
    protocol: 'responses', message_location: { key: 'input', form: 'array' },
    messages: [
      { ord: 0, value: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读配置' }] } },
      { ord: 1, value: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' } },
      { ord: 2, value: { type: 'function_call_output', call_id: 'c1', output: 'done' } },
      { ord: 3, value: { type: 'reasoning', summary: [] } },
      { ord: 4, value: { type: 'codex_item', value: 1 } },
    ],
  }));
  expect(entries.map(entry => [entry.role, entry.blocks.map(block => block.kind)])).toEqual([
    ['user', ['text']],
    ['assistant', ['call']],
    ['tool', ['result']],
    ['assistant', ['thinking']],
    ['unknown', ['other']],
  ]);
  expect(displayRoleOf(entries[2]!)).toBe('tool');
  expect(entries[1]!.blocks[0]!.text).toContain('read(');
  expect(entries[2]!.preview).toBe('done');
});

test('多 choice 由 choiceCount 声明，不结构化隐瞒；无效回复不带块', () => {
  const multi = replyView(page({ reply: { choices: [
    { finish_reason: 'stop', message: { role: 'assistant', content: 'a' } },
    { finish_reason: 'stop', message: { role: 'assistant', content: 'b' } },
  ] } }));
  expect(multi.state).toBe('ok');
  expect(multi.choiceCount).toBe(2);
  // 右栏现状：仍按 choice[0] 提供文本；中栏不拆行的限制由调用方按 choiceCount 判定。
  expect(multi.text).toBe('a');
  const invalid = replyView(page({ reply: { id: 'x', choices: [{}] } }));
  expect(invalid.state).toBe('invalid');
  expect(invalid.blocks).toEqual([]);
  expect(invalid.choiceCount).toBe(1);
  expect(replyView(page({ reply: null })).choiceCount).toBeNull();
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
  // 每次调用都提供右栏内配对入口，不跳转；未确认与无结果按「没有就不显示」不出状态。
  expect(html).toContain('配对两端');
  expect(html).not.toContain('data-result-owner');
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
  // 两个调用都指向同一目标：配对入口身份仍是各自的调用序号。
  expect((twinHtml.match(/配对两端/g) ?? []).length).toBe(2);
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
        reasoning_hidden: true,
      },
      {
        index: 1, model: 'm2', effort: null, status: 200,
        fail: null, error: null, start_ms: 1761091201000,
        ms: 200, ttft_ms: null, flow_ms: null, first_text_ms: null,
        first_reasoning_ms: null, served: 's', done: true, tier_served: null,
        reasoning_hidden: false,
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

test('尝试链只给异常时长上色，首 token 与首个文本保持正文色', () => {
  const base = {
    effort: null, fail: null, error: null, start_ms: null, flow_ms: null,
    first_reasoning_ms: null, served: null, done: null, tier_served: null,
    reasoning_hidden: null,
  };
  const html = renderAttemptChain({
    state: 'present',
    items: [
      { ...base, index: 0, model: 'm1', status: 200, ms: 900, ttft_ms: 1200, first_text_ms: 9000 },
      { ...base, index: 1, model: 'm2', status: 200, ms: 45_000, ttft_ms: null, first_text_ms: null },
      { ...base, index: 2, model: 'm3', status: 500, ms: 90_000, ttft_ms: null, first_text_ms: null },
    ],
    timing: { state: 'recorded', note: '时间来自各次尝试的开始时间' },
  });
  // 正常档不加类也不加色：右栏正常态是正文色。
  expect(html).toContain('900 ms');
  expect(html).not.toContain('t-good');
  expect(html).toContain('<b class="t-warn">45000 ms</b>');
  expect(html).toContain('<b class="t-bad">90000 ms</b>');
  // 首 token 与首个文本随模型与内容长度变化，只报数不上档。
  expect(html).toContain('首 token 1200 ms');
  expect(html).toContain('首个文本 9000 ms');
  expect(html).not.toContain('排队');
});

test('缺时间时只显示说明，不补造间隔', () => {
  const html = renderAttemptChain({
    state: 'present',
    items: [{
      index: 0, model: 'm1', effort: null, status: 500,
      fail: 'rate_limit', error: null, start_ms: null, ms: null,
      ttft_ms: null, flow_ms: null, first_text_ms: null, first_reasoning_ms: null,
      served: null, done: null, tier_served: null, reasoning_hidden: null,
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
  expect(partLabel('<img src=x>')).toBe('<img src=x>');
});

test('已知 part 槽位稳定：六类旧口径照常，skills 得第七槽', () => {
  // 六类旧口径行（skills 未拆出前）各得既有槽位，不受第七槽加入影响。
  expect(['system', 'tools', 'memory', 'files', 'results', 'chat'].map(partColor))
    .toEqual(['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)', 'var(--p5)', 'var(--p6)']);
  // 七类新口径：magpie 10-24 拆出的 skills 落靛色第七槽。
  expect(partColor('skills')).toBe('var(--p7)');
  expect(partLabel('skills')).toBe('技能');
  // memory 标签统一显「记忆」：旧行里含未拆出的 skills，行上无标记可区分，不再显示「记忆与技能」。
  expect(partLabel('memory')).toBe('记忆');
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

test('协议未适配的能力行说明解释边界，不显示零技能', () => {
  const html = renderCapabilities(page({
    state: 'available', parse_state: 'unsupported',
    capabilities: {
      tools: { state: 'missing', items: [], reason: 'protocol_unsupported' },
      skills: { state: 'missing', items: [], reason: 'protocol_unsupported' },
      coverage: { complete: true, reason: 'available', from: 0, to: 0, total: null },
      agent: null,
    },
  }));
  expect(html).toContain('协议未适配');
  expect(html).not.toContain('零');
  // 保存覆盖与协议解释分开：原文完整但未适配时给出明确说明。
  expect(bodyNotice(page({
    state: 'available', parse_state: 'unsupported',
    reply: { id: 'resp_1', output: [] },
  }))).toContain('协议未适配');
  // 支持协议的 missing 保持原有文案。
  const missing = renderCapabilities(page({
    capabilities: {
      tools: { state: 'missing', items: [], reason: 'body_unavailable' },
      skills: { state: 'missing', items: [], reason: 'body_unavailable' },
      coverage: { complete: false, reason: 'body_unavailable', from: 0, to: 0, total: null },
      agent: null,
    },
  }));
  expect(missing).toContain('工具定义缺失');
});

test('空回复继承正文状态：未到、回收、摘要与部分正文分开报', () => {
  expect(replyView(page({ state: 'pending', reply: null })).state).toBe('pending');
  expect(replyView(page({ state: 'evicted', reply: null })).state).toBe('evicted');
  expect(replyView(page({ state: 'summary', reply: null })).state).toBe('summary');
  expect(replyView(page({ state: 'partial', reply: null })).state).toBe('partial');
  expect(replyView(page({ state: 'unsupported', reply: null })).state).toBe('unsupported');
  // 正文可读却确实没有回复对象，才落到 absent。
  expect(replyView(page({ state: 'available', reply_state: 'absent', reply: null })).state).toBe('absent');

  const pending = replyView(page({ state: 'pending', reply: null }));
  expect(renderReply(pending)).toContain('回复还没到');
  expect(renderReply(pending)).not.toContain('上游没有提供可用回复');
  expect(replyCompleteness({ status: 200 }, pending)).toEqual({ key: 'unknown', label: '回复未到' });
  const evicted = replyView(page({ state: 'evicted', reply: null }));
  expect(renderReply(evicted)).toContain('正文已回收');
  expect(replyCompleteness({ status: 200 }, evicted)).toEqual({ key: 'unknown', label: '正文已回收' });
});
