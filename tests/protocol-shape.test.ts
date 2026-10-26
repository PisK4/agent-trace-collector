import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest } from './fixtures';
import { messageFingerprint } from '../src/fingerprint';
import { interpretMessage } from '../src/input-interpretation';
import { isIncrementalRequest, messagesKeyOf, requestItemsOf, withItems } from '../src/protocol-shape';
import { getBodyPage } from '../src/protocols';
import { replyTextsOf, systemTextsOf } from '../src/semantics';
import { restoreBody } from '../src/body';

/**
 * 形状表中的协议事实：消息数组键、裸输入形态、角色推断与文本块类型。
 * 全部是合成数据，形状按公开规范构造，不取自真实请求。
 */

test('消息数组键按协议查表，名单外协议沿用 messages', () => {
  expect(messagesKeyOf('anthropic')).toBe('messages');
  expect(messagesKeyOf('chat')).toBe('messages');
  expect(messagesKeyOf('responses')).toBe('input');
  expect(messagesKeyOf('gemini')).toBe('messages');
});

test('裸字符串输入合成一条可逆的用户消息，非数组非字符串不拆', () => {
  const bare = requestItemsOf('responses', { input: 'hello', temperature: 0.2 });
  expect(bare).toEqual({
    key: 'input',
    form: 'string',
    items: [{ role: 'user', type: 'message', content: [{ type: 'input_text', text: 'hello' }] }],
  });
  // 放回原键：合成消息里的文本逐字还原成裸字符串。
  expect(withItems({ temperature: 0.2 }, bare.key, bare.form, bare.items!))
    .toEqual({ temperature: 0.2, input: 'hello' });

  // 形状不认识时保留原对象，不在存储层猜。
  expect(requestItemsOf('responses', { input: 42 }).items).toBeNull();
  expect(requestItemsOf('anthropic', { messages: 'oops' }).items).toBeNull();
  expect(requestItemsOf('responses', {}).items).toBeNull();
});

test('消息数组键不在时 withItems 直接放回原键，不补空数组', () => {
  expect(withItems({}, 'input', 'array', [])).toEqual({ input: [] });
  expect(withItems(null, 'messages', 'array', [])).toBeNull();
});

test('Responses 请求经保存与恢复与已脱敏原对象逐字相等', () => {
  const bodies = [
    {
      protocol: 'responses',
      request: {
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'function_call_output', call_id: 'c1', output: 'done' },
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] },
        ],
        instructions: 'be brief',
        additional_tools: [{ name: 'custom' }],
        temperature: 0.2,
      },
      reply: {
        id: 'resp_1', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      },
    },
    {
      protocol: 'responses',
      request: { input: [] },
      reply: { id: 'resp_2', status: 'completed', output: [] },
    },
    {
      protocol: 'responses',
      request: { input: 'plain string input', metadata: { k: 'v' } },
      reply: null,
    },
  ];
  const f = fixture();
  try {
    for (const [index, body] of bodies.entries()) {
      const id = seedPurposeRequest(f.store, { convKey: 'conv-shape', request: body.request, reply: body.reply, protocol: 'responses' });
      expect(restoreBody(f.store, id)?.request).toEqual(body.request);
      expect(restoreBody(f.store, id)?.reply).toEqual(body.reply);
      expect(restoreBody(f.store, id)?.protocol).toBe('responses');
      expect(index).toBeGreaterThanOrEqual(0);
    }
  } finally {
    f.close();
  }
});

test('Responses 顶层项按 type 推断角色，工具结果不混进 user', () => {
  const developer = interpretMessage({ type: 'message', role: 'developer', content: [] }, null, 0);
  expect(developer.role).toBe('system');
  expect(interpretMessage({ type: 'function_call', call_id: 'c1', name: 'read' }, null, 1).role)
    .toBe('assistant');
  expect(interpretMessage({ type: 'reasoning', summary: [] }, null, 2).role).toBe('assistant');
  expect(interpretMessage({ type: 'function_call_output', call_id: 'c1', output: 'x' }, null, 3).role)
    .toBe('tool');
  expect(interpretMessage({ type: 'unknown_item' }, null, 4).role).toBe('unknown');
});

test('input_text 用户消息能形成输入步骤与可读文本', () => {
  const message = {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '读一下配置' }],
  };
  const view = interpretMessage(message, 'codex', 0);
  expect(view.role).toBe('user');
  expect(view.input).toMatchObject({ state: 'text', kind: 'plain', text: '读一下配置' });
});

test('语义指纹区分 Responses 的调用、结果与未知项', () => {
  const base = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
  ];
  const otherCallId = [
    base[0]!,
    { type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' },
  ];
  const otherArgs = [
    base[0]!,
    { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' },
  ];
  const withResult = [...base, { type: 'function_call_output', call_id: 'c1', output: 'x' }];
  const otherResult = [...base, { type: 'function_call_output', call_id: 'c1', output: 'y' }];
  const unknown = [...base, { type: 'codex_item', value: 1 }];
  const unknownOther = [...base, { type: 'codex_item', value: 2 }];
  const fingerprints = [base, otherCallId, otherArgs, withResult, otherResult, unknown, unknownOther]
    .map(messages => messages.map(messageFingerprint));
  // 每一条改动都换指纹：判成相同会让增量算错。
  expect(new Set(fingerprints.map(items => items.join('|'))).size).toBe(fingerprints.length);
  // 只有工具结果不同的两笔，公共前缀停在调用上，不会被判成完整前缀。
  expect(fingerprints[3]![0]).toBe(fingerprints[4]![0]);
  expect(fingerprints[3]![2]).not.toBe(fingerprints[4]![2]);
});

test('系统提示：instructions 与 developer 消息同源可读', () => {
  const request = {
    instructions: 'be brief',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
  };
  expect(systemTextsOf(request)).toEqual(['be brief', 'rules']);
  // 空白 instructions 不算系统提示。
  expect(systemTextsOf({ instructions: '   ', input: [] })).toEqual([]);
});

test('回复文本：只取 output 里的 output_text，推理与调用项不算正文', () => {
  const reply = {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  };
  expect(replyTextsOf(reply)).toEqual(['answer']);
  expect(replyTextsOf({ output: [] })).toEqual([]);
});

test('只有 Responses 的 previous_response_id 算增量输入', () => {
  expect(isIncrementalRequest('responses', { input: [], previous_response_id: 'resp_1' })).toBe(true);
  // 空串与缺失都不算：没有指向具体前序响应，输入本身就是当时发出的全部历史。
  expect(isIncrementalRequest('responses', { input: [], previous_response_id: '' })).toBe(false);
  expect(isIncrementalRequest('responses', { input: [] })).toBe(false);
  // 其它协议里同名键不具这个含义，不读。
  expect(isIncrementalRequest('anthropic', { messages: [], previous_response_id: 'x' })).toBe(false);
  expect(isIncrementalRequest('responses', null)).toBe(false);
});

test('正文页暴露协议名，系统文本把 instructions 并入其中', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'conv-shape-page', protocol: 'responses',
      request: { instructions: 'be brief', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      reply: { id: 'resp_1', status: 'completed', output: [] },
    });
    const page = getBodyPage(f.store, id, 0, 0)!;
    expect(page.protocol).toBe('responses');
    expect(page.request_fields).toMatchObject({ instructions: 'be brief' });
    expect(page.reply).toMatchObject({ id: 'resp_1' });
  } finally {
    f.close();
  }
});
