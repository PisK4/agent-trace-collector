import { expect, test } from 'bun:test';
import { anthropicReplyCalls } from '../src/derive-decision';
import { parseProtocol } from '../src/protocols';

test('请求有效而回复缺失仍可阅读请求', () => {
  const parsed = parseProtocol('anthropic', { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, null);
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.reply_state).toBe('absent');
  expect(parsed.message_count).toBe(1);
});

test('未知协议保存能力不被解释成零消息', () => {
  const parsed = parseProtocol('responses', { input: 'hello' }, { id: 'resp_x', output: [] });
  expect(parsed.parse_state).toBe('unsupported');
  expect(parsed.message_count).toBeNull();
  expect(parsed.reply_state).toBe('unsupported');
  // 已知字段仍可提取，不能发明其他字段。
  expect(parsed.response_id).toBe('resp_x');
});

test('Chat 的工具调用与结果各自带路径', () => {
  const parsed = parseProtocol('chat', {
    messages: [{ role: 'tool', tool_call_id: 'call_x', content: 'done' }],
  }, {
    id: 'chatcmpl_x',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'read', arguments: '{"path":"demo"}' } }],
      },
    }],
  });
  expect(parsed.results[0]?.id).toBe('call_x');
  expect(parsed.results[0]?.path).toBe('request.messages[0]');
  expect(parsed.calls[0]?.id).toBe('call_y');
  expect(parsed.calls[0]?.name).toBe('read');
  expect(parsed.calls[0]?.input).toBe('{"path":"demo"}');
  expect(parsed.calls[0]?.path).toBe('reply.choices[0].message.tool_calls[0]');
});

test('Anthropic 的 thinking、tool_use 与 tool_result 都能定位', () => {
  const parsed = parseProtocol('anthropic', {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok2' },
        ],
      },
    ],
  }, {
    id: 'msg_1',
    content: [
      { type: 'thinking', thinking: 'synthetic' },
      { type: 'tool_use', id: 'toolu_3', name: 'write', input: { path: 'b' } },
    ],
  });
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.message_count).toBe(3);
  expect(parsed.calls.map(call => call.id)).toEqual(['toolu_3']);
  expect(parsed.calls[0]?.ord).toBe(1);
  expect(parsed.calls[0]?.path).toBe('reply.content[1]');
  expect(parsed.results.map(result => result.id)).toEqual(['toolu_1', 'toolu_2']);
  // 同一条消息里两个结果靠 path 区分，不靠 ord。
  expect(parsed.results[1]?.ord).toBe(2);
  expect(parsed.results[1]?.path).toBe('request.messages[2].content[1]');
});

test('字符串 content 与无 content 都按单块处理', () => {
  const parsed = parseProtocol('chat', {
    messages: [{ role: 'user', content: 'plain text' }, { role: 'assistant' }],
  }, { id: 'chatcmpl_y', choices: [] });
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.reply_state).toBe('ok');
  expect(parsed.message_count).toBe(2);
  expect(parsed.calls).toEqual([]);
});

test('请求与回复各自判状态：回复不是对象只影响回复', () => {
  const parsed = parseProtocol('anthropic', { messages: [] }, 'not-an-object');
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.reply_state).toBe('invalid');

  const broken = parseProtocol('anthropic', 'not-an-object', { id: 'msg_z', content: [] });
  expect(broken.parse_state).toBe('invalid');
  expect(broken.reply_state).toBe('ok');
  expect(broken.message_count).toBeNull();
});

test('messages 存在但不是数组时消息数不明', () => {
  const parsed = parseProtocol('chat', { messages: 'oops' }, { id: 'chatcmpl_z', choices: [] });
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.message_count).toBeNull();
});

test('多 choice 不发布只有 ord 的确定调用身份', () => {
  const reply = {
    choices: ['left', 'right'].map(id => ({ message: {
      role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
    } })),
  };
  expect(parseProtocol('chat', { messages: [] }, reply).calls).toEqual([]);
  expect(anthropicReplyCalls(reply)).toEqual([]);
  // 单 choice 路径与序号保持原义。
  const single = { choices: [reply.choices[0]] };
  expect(parseProtocol('chat', { messages: [] }, single).calls.map(call => call.ord)).toEqual([0]);
  expect(anthropicReplyCalls(single)).toEqual([{ id: 'left', name: 'read', ord: 0 }]);
});
