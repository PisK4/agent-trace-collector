import { expect, test } from 'bun:test';
import { replyCallsOf, replyShapeOf } from '../src/derive/decision';
import { parseProtocol } from '../src/protocols';

test('请求有效而回复缺失仍可阅读请求', () => {
  const parsed = parseProtocol('anthropic', { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, null);
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.reply_state).toBe('absent');
  expect(parsed.message_count).toBe(1);
});

test('未知协议保存能力不被解释成零消息', () => {
  const parsed = parseProtocol('gemini', { input: 'hello' }, { id: 'resp_x', output: [] });
  expect(parsed.parse_state).toBe('unsupported');
  expect(parsed.message_count).toBeNull();
  expect(parsed.reply_state).toBe('unsupported');
  // 已知字段仍可提取，不能发明其他字段：gemini 的响应 id 在 responseId。
  expect(parsed.response_id).toBeNull();
  expect(parseProtocol('gemini', {}, { responseId: 'gem_x' }).response_id).toBe('gem_x');
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
  expect(replyCallsOf('chat', reply)).toEqual([]);
  // 单 choice 路径与序号保持原义。
  const single = { choices: [reply.choices[0]] };
  expect(parseProtocol('chat', { messages: [] }, single).calls.map(call => call.ord)).toEqual([0]);
  expect(replyCallsOf('chat', single)).toEqual([
    { id: 'left', name: 'read', ord: 0, argPath: null, argSkill: null },
  ]);
});

test('回复形状：可识别形状、无有效调用且完整收尾判 final', () => {
  expect(replyShapeOf('anthropic', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] })).toBe('final');
  expect(replyShapeOf('anthropic', { stop_reason: 'stop_sequence', content: [] })).toBe('final');
  expect(replyShapeOf('chat', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })).toBe('final');
  // Responses 只有 status=completed 是正常收尾。
  expect(replyShapeOf('responses', {
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
  })).toBe('final');
});

test('回复形状：识别到有效调用判 tools，停止原因未报告也按调用证据判', () => {
  expect(replyShapeOf('anthropic', {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }],
  })).toBe('tools');
  expect(replyShapeOf('chat', {
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] } }],
  })).toBe('tools');
  // 停止原因缺失：调用本身是工具循环的证据。
  expect(replyShapeOf('anthropic', { content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] })).toBe('tools');
  // Responses 的调用项用 call_id 做身份。
  expect(replyShapeOf('responses', {
    status: 'completed',
    output: [{ type: 'function_call', call_id: 'c9', name: 'read', arguments: '{}' }],
  })).toBe('tools');
});

test('回复形状：缺失、不识别、多 choice、缺 ID 工具块、截断都判 unknown', () => {
  expect(replyShapeOf('anthropic', null)).toBe('unknown');
  expect(replyShapeOf('anthropic', 'text')).toBe('unknown');
  expect(replyShapeOf('anthropic', {})).toBe('unknown');
  // content 不是块数组：形状不识别。
  expect(replyShapeOf('anthropic', { stop_reason: 'end_turn', content: 'str' })).toBe('unknown');
  expect(replyShapeOf('chat', { choices: [] })).toBe('unknown');
  expect(replyShapeOf('chat', { choices: [{}, {}] })).toBe('unknown');
  expect(replyShapeOf('chat', { choices: [{ finish_reason: 'stop' }] })).toBe('unknown');
  // 缺 ID 的 tool_use：其余再完整也不能下结论。
  expect(replyShapeOf('anthropic', {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'read', input: {} }],
  })).toBe('unknown');
  // chat 缺 function 的 tool_calls 同理。
  expect(replyShapeOf('chat', {
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', type: 'function' }] } }],
  })).toBe('unknown');
  // 截断：max_tokens / length，带不带调用都不是收尾。
  expect(replyShapeOf('anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'half' }] })).toBe('unknown');
  expect(replyShapeOf('chat', { choices: [{ finish_reason: 'length', message: { content: 'half' } }] })).toBe('unknown');
  expect(replyShapeOf('anthropic', {
    stop_reason: 'max_tokens',
    content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }],
  })).toBe('unknown');
  // 未知停止原因不冒充收尾；停止原因缺失的无调用回复也不冒充。
  expect(replyShapeOf('anthropic', { stop_reason: 'refusal', content: [{ type: 'text', text: 'x' }] })).toBe('unknown');
  expect(replyShapeOf('anthropic', { content: [{ type: 'text', text: 'x' }] })).toBe('unknown');
});

test('回复形状：Responses 的 status 缺失、未完成与缺 call_id 都不下结论', () => {
  expect(replyShapeOf('responses', { output: [] })).toBe('unknown');
  expect(replyShapeOf('responses', { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'half' }] }] })).toBe('unknown');
  expect(replyShapeOf('responses', { status: 'failed', output: [] })).toBe('unknown');
  expect(replyShapeOf('responses', { status: 'in_progress', output: [{ type: 'function_call', call_id: 'c1', name: 'read' }] })).toBe('unknown');
  // 缺 call_id 的调用项：与 Anthropic 缺 ID 的 tool_use 同一口径。
  expect(replyShapeOf('responses', { status: 'completed', output: [{ type: 'function_call', name: 'read' }] })).toBe('unknown');
});
