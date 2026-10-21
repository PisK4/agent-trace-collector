import { expect, test } from 'bun:test';
import {
  bodyNotice, deltaOrdinals, messageEntries, renderMessages, renderRaw, renderReply, renderReplyDetail,
  renderTools, replyView, toolEntries,
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
