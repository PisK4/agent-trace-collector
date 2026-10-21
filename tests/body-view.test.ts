import { expect, test } from 'bun:test';
import {
  bodyNotice, capabilitySummary, deltaOrdinals, messageEntries, renderCapabilities, renderMessages, renderRaw,
  renderReply, renderReplyDetail, renderTools, replyView, toolEntries,
} from '../web/body-view.js';
import type { BodyPage } from '../src/protocols';
import type { RequestDetail } from '../src/queries';

function page(overrides: Partial<BodyPage> = {}): BodyPage {
  return {
    state: 'available', parse_state: 'ok', reply_state: 'ok', from: 0, to: 0, total: 2,
    messages: [], request_fields: null, reply: null, reason: null, ...overrides,
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
  const detail = { prev_relation: 'confirmed', delta_ordinals: [3, 4] } as RequestDetail;
  expect([...(deltaOrdinals(detail) ?? [])]).toEqual([3, 4]);
  expect(deltaOrdinals({ prev_relation: 'unknown', delta_ordinals: null } as unknown as RequestDetail)).toBeNull();
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
  const html = renderTools(tools);
  expect(html).toContain('data-tool-result="9"');
  expect(html).toContain('data-tool-ord="2"');
  expect(html).toContain('结果位置未确认');
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
  }));
  // Anthropic 的 tool_result 挂在 user 角色下，但它不是人在说话。
  expect(entries.map(entry => entry.isInput)).toEqual([true, false, false]);
  expect(entries[2]?.blocks.map(block => block.kind)).toEqual(['result']);

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

test('Anthropic 形状的工具读出名称、描述与 input_schema', () => {
  const summary = capabilitySummary(page({
    request_fields: {
      tools: [
        { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
        { name: 'Read', input_schema: null },
        { name: '  ' },
        { description: '没有名字' },
      ],
    },
  }), []);
  expect(summary.tools.map(tool => tool.name)).toEqual(['Bash', 'Read']);
  expect(summary.tools[0]?.description).toBe('Run a shell command');
  expect(summary.tools[1]?.description).toBe('');
  expect(summary.tools[1]?.schema).toBeNull();
  expect(summary.skills).toEqual([]);

  const html = renderCapabilities(page({
    request_fields: { tools: [{ name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object' } }] },
  }), []);
  expect(html).toContain('1 工具 · 0 技能');
  expect(html).toContain('工具清单 · 1');
  expect(html).not.toContain('技能清单');
  expect(html).toContain('<code class="cap-name">Bash</code>');
  expect(html).toContain('&quot;type&quot;: &quot;object&quot;');
});

test('Chat 形状的工具从 function 里取名称与 parameters', () => {
  const summary = capabilitySummary(page({
    request_fields: {
      tools: [
        { type: 'function', function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', required: ['path'] } } },
        { type: 'function', function: { name: 'empty', parameters: { type: 'object' } } },
      ],
    },
  }), []);
  expect(summary.tools.map(tool => tool.name)).toEqual(['read_file', 'empty']);
  expect(summary.tools[0]?.description).toBe('读取文件');
  expect(summary.tools[0]?.schema).toEqual({ type: 'object', required: ['path'] });
  expect(summary.tools[1]?.description).toBe('');

  // functions 字段是旧形状，也要兼容。
  const legacy = capabilitySummary(page({
    request_fields: { functions: [{ name: 'old_tool', parameters: { type: 'object' } }] },
  }), []);
  expect(legacy.tools.map(tool => tool.name)).toEqual(['old_tool']);
});

test('OMP 的 <skills> 清单解析出多条技能', () => {
  const system = '<skills>\n- anysearch: 实时搜索与网页抓取\n- archify：画架构图\n- bad line without colon\n</skills>';
  const summary = capabilitySummary(page({ request_fields: { system } }), []);
  expect(summary.skills).toEqual([
    { name: 'anysearch', description: '实时搜索与网页抓取' },
    { name: 'archify', description: '画架构图' },
  ]);
  const html = renderCapabilities(page({ request_fields: { system } }), []);
  expect(html).toContain('0 工具 · 2 技能');
  expect(html).toContain('技能清单 · 2');
  expect(html).not.toContain('工具清单');
  expect(html).toContain('<code class="cap-name">anysearch</code>');
});

test('Claude Code 的技能标题后只吃连续列表行', () => {
  const text = [
    'The following skills are available for use with the Skill tool:',
    '',
    '- anysearch: Real-time search',
    '- archify: Diagrams',
    '',
    '- 空行之后的这一行不应该被算进来',
    '普通段落也不是列表',
  ].join('\n');
  const entries = messageEntries(page({
    messages: [
      { ord: 0, value: { role: 'system', content: [{ type: 'text', text }] } },
      { ord: 1, value: { role: 'user', content: 'hi' } },
    ],
  }));
  const summary = capabilitySummary(page(), entries);
  expect(summary.skills).toEqual([
    { name: 'anysearch', description: 'Real-time search' },
    { name: 'archify', description: 'Diagrams' },
  ]);
});

test('技能按 name 去重，先出现的描述优先', () => {
  const system = '<skills>\n- a: 第一个\n- b: 另一个\n- a: 重复\n</skills><available_skills>- c: 第三</available_skills>';
  const summary = capabilitySummary(page({ request_fields: { system } }), []);
  expect(summary.skills).toEqual([
    { name: 'a', description: '第一个' },
    { name: 'b', description: '另一个' },
    { name: 'c', description: '第三' },
  ]);
});

test('没有工具也没有技能时给出说明而不是空 details', () => {
  const html = renderCapabilities(page({ request_fields: { model: 'm' } }), []);
  expect(html).toContain('0 工具 · 0 技能');
  expect(html).toContain('这一笔请求没有携带工具定义，也没有可解析的技能清单。');
  expect(html).not.toContain('cap-block');
  expect(renderCapabilities(null, [])).toContain('0 工具 · 0 技能');
});

test('能力清单的动态内容只作为文本转义', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const summary = capabilitySummary(page({
    request_fields: {
      tools: [{ name: payload, description: payload, input_schema: { description: payload } }],
      system: `<skills>\n- ${payload}: ${payload}\n</skills>`,
    },
  }), []);
  expect(summary.tools[0]?.name).toBe(payload);
  const html = renderCapabilities(page({
    request_fields: {
      tools: [{ name: payload, description: payload, input_schema: { description: payload } }],
      system: `<skills>\n- ${payload}: ${payload}\n</skills>`,
    },
  }), []);
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
  expect(html).toContain('&quot;description&quot;: &quot;&lt;img');
});

test('描述压成单行并截断', () => {
  const description = `${'x'.repeat(200)}\n第二行`;
  const summary = capabilitySummary(page({
    request_fields: { tools: [{ name: 'T', description, input_schema: null }] },
  }), []);
  expect([...(summary.tools[0]?.description ?? '')].length).toBe(204);
  const html = renderCapabilities(page({
    request_fields: { tools: [{ name: 'T', description, input_schema: null }] },
  }), []);
  expect(html).toContain(`${'x'.repeat(120)}…`);
  expect(html).not.toContain('\n第二行');
  // schema 为 null 时不输出 pre。
  expect(html).not.toContain('<pre class="raw"');
});
